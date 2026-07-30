#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import type {
  ActiveCodexProcess,
  CodexProcessSnapshot,
  CodexThreadRow,
  ForkContextPackage
} from "./codex-session-provider.js";
import {
  createCodexTerminalAgentAdapter,
  detectCodexDurableCompletion
} from "./codex-terminal-agent-adapter.js";
import {
  createClaudeTerminalAgentAdapter,
  type ClaudeAgentRow
} from "./claude-terminal-agent-adapter.js";
import {
  captureClaudeTranscriptAnchor,
  defaultClaudeHome,
  detectClaudeTranscriptCompletion,
  detectClaudeTranscriptPendingApproval,
  type ClaudeTranscriptAnchor
} from "./claude-local-transcript-provider.js";
import { CodexLocalSessionProvider, type CodexLocalSessionAdapter } from "./codex-local-session-provider.js";
import { CodexStoreAdapter } from "./codex-store-adapter.js";
import {
  applyMessageToConversation,
  budgetAction,
  createConversation,
  createMessage,
  executorForConversation,
  extractStructuredMessage,
  parseMessageJson,
  resolveExecutor,
  type Conversation,
  type ConversationStatus
} from "./protocol.js";
import {
  EXECUTOR_KINDS,
  executorDefinitionForKind,
  isExecutorKind,
  type ExecutorKind
} from "./executors.js";
import { redactString, writeRuntimeLog } from "./runtime-log.js";
import { formatTranscript, readNdjsonLog } from "./transcript.js";
import {
  appendEvent,
  defaultStoreDir,
  ensureDir,
  listConversations,
  logPathForStatePath,
  loadConversationById,
  loadState,
  messageEvent,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  statePathForConversationId
} from "./store.js";
import {
  StaticTerminalControlProvider,
  TmuxTerminalControlProvider,
  terminalPaneContainsProcess,
  type TerminalControlProvider
} from "./terminal-control-provider.js";
import {
  parseTerminalConversationId,
  type ActiveTerminalProcess,
  type TerminalCompletionEvidence,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import { createProductionTerminalAgentRegistry } from "./terminal-agent-registry.js";
import {
  parseProcessElapsedSeconds,
  StaticTerminalProcessSource,
  SystemTerminalProcessSource,
  type TerminalProcessSource
} from "./terminal-process-source.js";
import {
  TerminalAgentBridge,
  type ResolvedTerminalConversation
} from "./terminal-agent-bridge.js";
import {
  evaluateApprovalPolicy,
  type ApprovalCandidate
} from "./approval-policy.js";
import {
  evaluateDoctorCapabilities,
  runDoctorCapabilityProbes
} from "./doctor-capabilities.js";
import { runOpenClawChainDiagnostics } from "./openclaw-doctor.js";
import {
  resolveSessionSelector,
  sessionShortRef,
  type SessionSelectorCandidate
} from "./session-selector.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;
const CALLBACK_DELIVERY_TIMEOUT_MS = 30_000;
const CALLBACK_AGENT_WAIT_TIMEOUT_MS = 20_000;
const CALLBACK_AGENT_WAIT_CLI_TIMEOUT_MS = 25_000;
const CALLBACK_AGENT_WAIT_PROCESS_TIMEOUT_MS = 30_000;
const CALLBACK_RETRY_DELAYS_MS = [5000, 15000, 60000, 60000];
const TERMINAL_BRIDGE_SUPERSEDE_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "stalled",
  "cancelling"
]);
const TERMINAL_DISPATCH_RELEASE_STATUSES = new Set<ConversationStatus>([
  "idle",
  "failed",
  "closed",
  "cancelled"
]);
const TERMINAL_BRIDGE_MONITOR_LOCK_VERSION = 1;
const MINIMUM_NODE_VERSION = "22.19.0";
const PRIVATE_LOCK_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const CONVERSATION_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "idle",
  "stalled",
  "callback_pending",
  "callback_failed",
  "failed",
  "closed",
  "cancelled",
  "cancelling"
]);
const SESSION_SELECTOR_COMMANDS = new Set([
  "status",
  "send",
  "approve",
  "cancel",
  "renew",
  "retry-callback",
  "close"
]);

class InlineCodexSessionAdapter implements CodexLocalSessionAdapter {
  private readonly threads: CodexThreadRow[];
  private readonly processes: CodexProcessSnapshot[];
  private readonly processBatches: CodexProcessSnapshot[][];
  private processBatchIndex = 0;
  private readonly rollouts: Map<string, string>;

  constructor({
    threads,
    processes,
    rollouts
  }: {
    threads?: CodexThreadRow[];
    processes?: CodexProcessSnapshot[] | CodexProcessSnapshot[][];
    rollouts?: Record<string, string>;
  }) {
    this.threads = Array.isArray(threads) ? threads : [];
    this.processBatches = Array.isArray(processes?.[0])
      ? processes as CodexProcessSnapshot[][]
      : [];
    this.processes = Array.isArray(processes) && !Array.isArray(processes[0]) ? processes as CodexProcessSnapshot[] : [];
    this.rollouts = new Map(Object.entries(rollouts ?? {}));
  }

  async listThreadRows(): Promise<CodexThreadRow[]> {
    return this.threads;
  }

  async readRollout(rolloutPath: string): Promise<string | undefined> {
    return this.rollouts.get(rolloutPath);
  }

  async listProcessSnapshots(): Promise<CodexProcessSnapshot[]> {
    if (this.processBatches.length > 0) {
      const batch = this.processBatches[Math.min(this.processBatchIndex, this.processBatches.length - 1)];
      this.processBatchIndex += 1;
      return batch;
    }

    return this.processes;
  }
}

const command = process.argv[2];
const rawArgs = process.argv.slice(3);
const args = parseArgs(rawArgs);

runtimeLog("info", "cli_start", {
  command: command ?? "help",
  cwd: process.cwd(),
  option_keys: Object.keys(args).sort()
});

try {
  await runCommand(command, args);
  runtimeLog("info", "cli_finish", {
    command: command ?? "help",
    exit_code: process.exitCode ?? 0
  });
} catch (error) {
  runtimeLog("error", "cli_error", {
    command: command ?? "help",
    message: error.message,
    stack: error.stack
  });
  console.error(error.message);
  process.exit(1);
}

async function runCommand(commandName, options) {
  await resolveConversationSelectorOption(commandName, options);
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    usage();
  } else if (commandName === "version" || commandName === "--version" || commandName === "-v") {
    printVersion();
  } else if (commandName === "delegate") {
    await runDelegate(options);
  } else if (commandName === "list") {
    await runList(options);
  } else if (commandName === "status") {
    await runStatus(options);
  } else if (commandName === "send") {
    await runSend(options);
  } else if (commandName === "approve") {
    await runApprove(options);
  } else if (commandName === "cancel") {
    await runCancel(options);
  } else if (commandName === "renew") {
    await runRenew(options);
  } else if (commandName === "reconcile-monitors") {
    await runReconcileMonitors(options);
  } else if (commandName === "close") {
    await runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "install-openclaw") {
    runInstallOpenClaw(options);
  } else if (commandName === "doctor") {
    runDoctor(options);
  } else if (commandName === "callback") {
    runCallback(options);
  } else if (commandName === "retry-callback") {
    runRetryCallback(options);
  } else if (commandName === "monitor") {
    await runMonitor(options);
  } else {
    usage();
    process.exitCode = commandName ? 1 : 0;
  }
}

function runInstallOpenClaw(options) {
  const root = packageRootDir();
  const skillOnly = options.skillOnly === true;
  if (options.workspace !== undefined) {
    throw new Error(
      "--workspace was removed from install-openclaw; AKK now discovers verified tmux panes across workspaces. Configure autoApprove.rules[].workspaces only for trusted automatic approvals."
    );
  }
  if (options.defaultAgent !== undefined) {
    throw new Error(
      "--default-agent was removed; AKK now selects the only eligible idle tmux pane"
    );
  }
  if (options.mode !== undefined) {
    throw new Error("--mode was removed; Agent Knock Knock now uses tmux only");
  }
  if (skillOnly && options.verify === true) {
    throw new Error(
      "--skill-only cannot be combined with --verify"
    );
  }

  const needsOpenClaw = !skillOnly || options.noRestart !== true || options.verify === true;
  const openclawBin = needsOpenClaw
    ? options.openclawBin ?? resolveExecutable("openclaw")
    : options.openclawBin;
  const skillSource = path.join(root, "templates", "openclaw-skills", "agent-knock-knock", "SKILL.md");
  const skillDest = expandHome(options.skillPath ?? "~/.openclaw/skills/agent-knock-knock/SKILL.md");
  const steps: Array<Record<string, unknown>> = [];

  if (!skillOnly) {
    const pluginInstall = installOpenClawPlugin(openclawBin, root);
    steps.push({
      name: "plugin_installed",
      path: root,
      mode: pluginInstall.mode
    });

    const configOperations: Array<{ path: string; value: unknown }> = [
      {
        path: "plugins.entries.agent-knock-knock.enabled",
        value: true
      },
    ];
    runCheckedCommand(
      openclawBin,
      ["config", "set", "--batch-json", JSON.stringify(configOperations)],
      { label: "openclaw config set" }
    );
    steps.push({
      name: "plugin_configured",
      plugin: "agent-knock-knock",
      updated: configOperations.map((operation) => operation.path)
    });
  }

  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  fs.copyFileSync(skillSource, skillDest);
  steps.push({
    name: "skill_installed",
    path: skillDest
  });

  if (options.noRestart !== true) {
    runCheckedCommand(openclawBin, ["gateway", "restart"], {
      label: "openclaw gateway restart"
    });
    steps.push({
      name: "gateway_restarted"
    });
  }

  const pendingRestart = !skillOnly && options.noRestart === true;
  const verification = options.verify === true
    ? buildDoctorReport({
        ...options,
        openclawBin
      })
    : undefined;
  const ready = verification
    ? verification.ok === true && !pendingRestart
    : false;
  const nextActions = installNextActions({
    pendingRestart,
    verification
  });

  printJson({
    installed: true,
    ready,
    pending_restart: pendingRestart,
    mode: skillOnly ? "skill_only" : "full",
    execution_mode: "tmux",
    package_root: root,
    openclaw_bin: openclawBin ?? null,
    steps,
    ...(verification ? { verification } : {}),
    next_actions: nextActions
  });
}

function canonicalWorkspace(value: unknown): string {
  const requested = path.resolve(String(required(value, "--workspace is required")));
  let canonical: string;
  let stat: fs.Stats;
  try {
    canonical = fs.realpathSync(requested);
    stat = fs.statSync(canonical);
  } catch {
    throw new Error(`--workspace does not exist: ${requested}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`--workspace must be a directory: ${requested}`);
  }
  return canonical;
}

function matchesConfiguredWorkspace(
  configuredWorkspace: unknown,
  candidateWorkspace: unknown
): boolean {
  if (configuredWorkspace === undefined) {
    return true;
  }
  if (candidateWorkspace === undefined || candidateWorkspace === null) {
    return false;
  }
  try {
    return canonicalWorkspace(configuredWorkspace) ===
      canonicalWorkspace(candidateWorkspace);
  } catch {
    return false;
  }
}

function assertConfiguredWorkspace(
  configuredWorkspace: unknown,
  candidateWorkspace: unknown,
  subject: string
): void {
  if (configuredWorkspace === undefined) {
    return;
  }
  const configured = canonicalWorkspace(configuredWorkspace);
  let candidate: string;
  try {
    candidate = canonicalWorkspace(candidateWorkspace);
  } catch {
    throw new Error(
      `refusing ${subject}; its working directory cannot be verified against expected workspace ${configured}`
    );
  }
  if (candidate !== configured) {
    throw new Error(
      `refusing ${subject}; workspace ${candidate} does not match expected workspace ${configured}`
    );
  }
}

function installNextActions({
  pendingRestart,
  verification
}: {
  pendingRestart: boolean;
  verification?: Record<string, any>;
}): Array<{ action: string; command: string }> {
  if (pendingRestart) {
    return [
      {
        action: "apply_plugin_changes",
        command: "openclaw gateway restart"
      },
      {
        action: "verify",
        command: "agent-knock-knock doctor"
      }
    ];
  }

  if (verification && verification.ok !== true) {
    const chain = isRecord(verification.openclaw) ? verification.openclaw : {};
    const checks = Array.isArray(chain.checks) ? chain.checks : [];
    const remediation = checks.flatMap((check) =>
      isRecord(check) && Array.isArray(check.remediation)
        ? check.remediation.filter((command): command is string => typeof command === "string")
        : []
    );
    return [...new Set(remediation)].map((command) => ({
      action: "repair",
      command
    }));
  }

  if (!verification) {
    return [{
      action: "verify",
      command: "agent-knock-knock doctor"
    }];
  }

  return [{
    action: "start_shared_terminal",
    command: "tmux new -s akk-work -c \"$PWD\" codex # use claude instead when preferred"
  }];
}

function installOpenClawPlugin(openclawBin, root) {
  const linked = spawnSync(openclawBin, ["plugins", "install", "--link", root], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
  });
  if (linked.error) {
    throw new Error(`openclaw plugins install failed to start: ${linked.error.message}`);
  }
  if (linked.status === 0) {
    return { mode: "linked" };
  }

  const failure = cleanProcessText(linked.stderr || linked.stdout)
    ?? `openclaw plugins install exited with status ${linked.status}`;
  const canRetryWithForce = /plugin already exists:/i.test(failure) ||
    /install cancelled;\s*rerun with --force\b/i.test(failure);
  if (!canRetryWithForce) {
    throw new Error(failure);
  }

  runCheckedCommand(openclawBin, ["plugins", "install", "--force", root], {
    label: "openclaw plugins replace"
  });
  return { mode: "replaced" };
}

function runDoctor(options) {
  const report = buildDoctorReport(options);
  printJson(report);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

function buildDoctorReport(options): Record<string, any> {
  if (options.mode !== undefined) {
    throw new Error("--mode was removed; Agent Knock Knock now checks tmux only");
  }
  if (options.workspace !== undefined) {
    throw new Error(
      "--workspace was removed from doctor; AKK now discovers verified tmux panes across workspaces"
    );
  }
  const timeoutMs = options.timeoutMs === undefined
    ? undefined
    : positiveMilliseconds(options.timeoutMs, "--timeout-ms");
  const openclawBin = String(options.openclawBin ?? resolveOptionalExecutable("openclaw"));
  const executables = {
    openclaw: openclawBin,
    ...(options.tmuxBin ? { tmux: String(options.tmuxBin) } : {}),
    ...(options.codexBin ? { codex: String(options.codexBin) } : {}),
    ...(options.claudeBin ? { claude: String(options.claudeBin) } : {})
  };
  const checks = [
    {
      command: "node",
      status: "ok" as const,
      available: true,
      executable: process.execPath,
      version: process.versions.node,
      version_supported: versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION),
      minimum_version: MINIMUM_NODE_VERSION
    },
    ...runDoctorCapabilityProbes(
      {
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        executables
      }
    )
  ];
  const root = packageRootDir();
  const packageFiles = [
    "dist/src/cli.js",
    "dist/src/openclaw-plugin.js",
    "templates/openclaw-skills/agent-knock-knock/SKILL.md",
    "openclaw.plugin.json"
  ].map((relativePath) => {
    const filePath = path.join(root, relativePath);
    return {
      path: filePath,
      exists: fs.existsSync(filePath)
    };
  });
  const capabilities = evaluateDoctorCapabilities(checks);
  const filesOk = packageFiles.every((check) => check.exists);
  const openclaw = runOpenClawChainDiagnostics({
    openclawBin,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  const ok =
    capabilities.readiness === "ready" &&
    filesOk &&
    openclaw.ready;
  return {
    ok,
    readiness: ok
      ? "ready"
      : capabilities.readiness === "not_ready"
        ? "not_ready"
        : "partially_ready",
    selected_mode: "tmux",
    live_terminal: {
      checked: false,
      required_for_install_readiness: false,
      detail:
        "Installation readiness checks tmux and at least one supported CLI. " +
        "AKK verifies a live eligible pane when delegation begins."
    },
    package_root: root,
    checks,
    package_files: packageFiles,
    capabilities: {
      tmux: capabilities.tmux
    },
    openclaw,
    notes: [
      `Node.js ${MINIMUM_NODE_VERSION}+ and OpenClaw are required.`,
      "AKK supports Codex and Claude Code through shared tmux terminals.",
      "Doctor does not require a live coding-agent pane; delegation discovers and verifies one at send time.",
      "Claude tmux completion is hook-free and fails closed unless the local transcript schema is verified."
    ]
  };
}

function positiveMilliseconds(value: unknown, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return Math.ceil(parsed);
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parsed = version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const required = minimum.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (
    parsed.length !== 3 ||
    required.length !== 3 ||
    [...parsed, ...required].some((part) => !Number.isInteger(part) || part < 0)
  ) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== required[index]) {
      return parsed[index] > required[index];
    }
  }
  return true;
}

async function listActiveSessionsWithTerminalControl(
  provider,
  options,
  terminalProvider: TerminalControlProvider = createTerminalControlProvider(options)
): Promise<ActiveCodexProcess[]> {
  const activeSessions = await provider.listActiveSessions();
  const activePids = new Set(activeSessions.map((session) => session.pid));
  const processTree = activePids.size > 0
    ? await createTerminalProcessSource(options).listProcessSnapshots(
        (snapshot) => activePids.has(snapshot.pid),
        { includeCwd: false, includeAncestors: true }
      )
    : [];
  return createTerminalAgentBridge(options, terminalProvider).attachProcesses(
    provider.agent,
    activeSessions,
    { processTree }
  );
}

function createTerminalControlProvider(options): TerminalControlProvider {
  if (options.terminalsJson || options.terminalScreensJson || options.processesJson) {
    return new StaticTerminalControlProvider({
      panes: options.terminalsJson ? parseJsonOption(options.terminalsJson, "--terminals-json") : [],
      screens: options.terminalScreensJson ? parseJsonOption(options.terminalScreensJson, "--terminal-screens-json") : {}
    });
  }

  return new TmuxTerminalControlProvider();
}

function createTerminalProcessSource(options): TerminalProcessSource {
  if (options.processesJson) {
    return new StaticTerminalProcessSource(
      parseJsonOption(options.processesJson, "--processes-json")
    );
  }
  return new SystemTerminalProcessSource();
}

function loadClaudeAgentRows(options: Record<string, any> = {}): ClaudeAgentRow[] {
  let value: unknown;
  if (options.claudeAgentsJson !== undefined) {
    value = typeof options.claudeAgentsJson === "string"
      ? parseJsonOption(options.claudeAgentsJson, "--claude-agents-json")
      : options.claudeAgentsJson;
  } else if (options.processesJson || options.terminalsJson || options.terminalScreensJson) {
    return [];
  } else {
    const claudeExecutable = resolveOptionalExecutable("claude");
    if (!claudeExecutable) {
      return [];
    }
    const result = spawnSync(claudeExecutable, ["agents", "--json", "--all"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: 10_000
    });
    if (result.error || result.status !== 0) {
      runtimeLog("warn", "claude_agents_list_failed", {
        status: result.status ?? null,
        error: result.error?.message,
        stderr: textSummary(cleanProcessText(result.stderr))
      });
      return [];
    }
    try {
      value = JSON.parse(result.stdout);
    } catch {
      runtimeLog("warn", "claude_agents_list_invalid_json", {
        stdout: textSummary(result.stdout)
      });
      return [];
    }
  }

  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : [];
  return rows.flatMap((row): ClaudeAgentRow[] => {
    if (!isRecord(row) || !Number.isInteger(Number(row.pid))) {
      return [];
    }
    return [{
      pid: Number(row.pid),
      ...(stringValue(row.cwd) ? { cwd: stringValue(row.cwd) } : {}),
      ...(stringValue(row.kind) ? { kind: stringValue(row.kind) } : {}),
      ...(stringValue(row.sessionId) ? { sessionId: stringValue(row.sessionId) } : {}),
      ...(Number.isSafeInteger(Number(row.startedAt)) && Number(row.startedAt) > 0
        ? { startedAt: Number(row.startedAt) }
        : {}),
      ...(stringValue(row.status) ? { status: stringValue(row.status) } : {})
    }];
  });
}

function createRuntimeTerminalAgentRegistry(options) {
  return createProductionTerminalAgentRegistry({
    overrides: [
      createCodexTerminalAgentAdapter({
        async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
          const runtime = isRecord(request.context) ? request.context : undefined;
          const conversation = runtime?.conversation;
          const nativeTakeover = isRecord(runtime?.nativeTakeover)
            ? runtime?.nativeTakeover
            : undefined;
          if (!isRecord(conversation)) {
            return undefined;
          }
          const contextMatches = await loadCodexTerminalContexts({
            nativeTakeover,
            options
          });
          const matches: TerminalCompletionEvidence[] = [];
          const detectionErrors: string[] = [];
          for (const contextMatch of contextMatches) {
            try {
              const evidence = detectCodexDurableCompletion({
                ...request,
                context: contextMatch.context
              });
              if (evidence) {
                matches.push({
                  ...evidence,
                  confidence: contextMatch.confidence as "high" | "medium" | "low",
                  metadata: {
                    ...evidence.metadata,
                    context_match: contextMatch.match,
                    session: contextMatch.context.source
                  }
                });
              }
            } catch (error) {
              detectionErrors.push(
                error instanceof Error ? error.message : String(error)
              );
            }
          }
          if (detectionErrors.length > 0) {
            throw new Error(
              `could not inspect every plausible Codex completion: ${detectionErrors.join("; ")}`
            );
          }
          if (matches.length > 1) {
            throw new Error(
              "multiple same-cwd Codex sessions match the managed terminal request"
            );
          }
          return matches[0];
        }
      }),
      createClaudeTerminalAgentAdapter({
        agentRows: loadClaudeAgentRows(options),
        detectPendingApproval(request: TerminalDurableCompletionRequest) {
          return detectClaudeTranscriptPendingApproval(request, {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          });
        },
        async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
          return detectClaudeTranscriptCompletion(request, {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          });
        }
      })
    ]
  });
}

function createTerminalAgentBridge(
  options,
  terminalProvider: TerminalControlProvider = createTerminalControlProvider(options),
  registry = createRuntimeTerminalAgentRegistry(options)
): TerminalAgentBridge {
  const processSource = createTerminalProcessSource(options);
  return new TerminalAgentBridge({
    registry,
    terminalProvider,
    async verifyIdentity({ agent, pid, terminalControl }) {
      const adapter = registry.require(agent);
      const expectedWorkspace =
        options.workspace ?? terminalControl.currentPath;
      if (!expectedWorkspace) {
        throw new Error(
          `refusing terminal access to ${terminalControl.target}; its workspace is unavailable`
        );
      }
      const snapshots = await processSource.listProcessSnapshots(
        (candidate) => candidate.pid === pid,
        {
          includeCwd: true,
          includeAncestors: true
        }
      );
      const snapshot = snapshots.find((candidate) => candidate.pid === pid);
      if (!snapshot || !adapter.classifyProcess(snapshot)) {
        throw new Error(
          `terminal conversation agent ${agent} with pid ${pid} is no longer active`
        );
      }
      const panes = await terminalProvider.listPanes();
      const pane = panes.find((candidate) =>
        candidate.kind === terminalControl.kind &&
        candidate.target === terminalControl.target &&
        candidate.panePid === terminalControl.panePid
      );
      if (!pane || !terminalPaneContainsProcess(snapshot, pane, snapshots)) {
        throw new Error(
          `terminal conversation agent ${agent} with pid ${pid} no longer belongs to pane ${terminalControl.target}`
        );
      }
      assertConfiguredWorkspace(
        expectedWorkspace,
        snapshot.cwd,
        `terminal access to ${terminalControl.target} by agent process ${pid}`
      );
      assertConfiguredWorkspace(
        expectedWorkspace,
        pane.currentPath,
        `terminal access to ${terminalControl.target} by tmux pane`
      );
      return {
        terminalControl: {
          ...terminalControl,
          socketPath: pane.socketPath,
          panePid: pane.panePid,
          currentCommand: pane.currentCommand,
          currentPath: pane.currentPath
        }
      };
    }
  });
}

function terminalControlFromTakeover(nativeTakeover): TerminalControlRef | undefined {
  if (!isRecord(nativeTakeover)) {
    return undefined;
  }
  const terminalControl = nativeTakeover["terminal_control"];
  if (!isRecord(terminalControl) || terminalControl.kind !== "tmux") {
    return undefined;
  }
  const target = stringValue(terminalControl.target);
  const session = stringValue(terminalControl.session);
  const window = Number(terminalControl.window);
  const pane = Number(terminalControl.pane);
  const panePid = Number(terminalControl.panePid);
  if (!target || !session || !Number.isInteger(window) || !Number.isInteger(pane) || !Number.isInteger(panePid)) {
    return undefined;
  }
  const storedCapabilities = Array.isArray(terminalControl.capabilities)
    ? terminalControl.capabilities.filter(isTerminalControlCapability)
    : [];
  return {
    kind: "tmux",
    target,
    session,
    window,
    pane,
    panePid,
    currentCommand: stringValue(terminalControl.currentCommand),
    currentPath: stringValue(terminalControl.currentPath),
    socketPath: stringValue(terminalControl.socketPath),
    // State written before adapter capabilities were persisted always represented Codex.
    capabilities: storedCapabilities.length > 0
      ? storedCapabilities
      : [
          "screen_status",
          "send_keys",
          "terminal_approval",
          "screen_completion",
          "durable_completion",
          "terminal_cancel"
        ]
  };
}

function terminalRuntimeIdentityForConversation(
  conversation,
  terminalControl: TerminalControlRef
): TerminalRuntimeIdentity {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const nativeSessionId = stringValue(nativeTakeover?.native_session_id);
  const terminalIdentity = parseTerminalConversationId(nativeSessionId);
  const explicitSessionId = stringValue(nativeTakeover?.terminal_agent_session_id) ??
    (terminalIdentity ? undefined : nativeSessionId);
  return {
    pid: Number.isInteger(Number(nativeTakeover?.terminal_agent_pid))
      ? Number(nativeTakeover?.terminal_agent_pid)
      : terminalIdentity?.pid,
    sessionId: explicitSessionId,
    cwd: stringValue(nativeTakeover?.source_cwd) ?? terminalControl.currentPath,
    conversationId: stringValue(conversation?.conversation_id),
    messageId: stringValue(nativeTakeover?.terminal_bridge_message_id),
    terminalTarget: terminalControl.target
  };
}

function terminalDurableRequestForConversation(
  conversation,
  terminalControl: TerminalControlRef
): TerminalDurableCompletionRequest {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  const requestText = String(
    nativeTakeover?.terminal_bridge_request_text ?? conversation?.user_request ?? ""
  );
  return {
    sessionId: runtime.sessionId,
    cwd: stringValue(nativeTakeover?.source_cwd),
    requestText,
    requestHash: stringValue(nativeTakeover?.terminal_bridge_request_hash),
    startedAt: stringValue(nativeTakeover?.terminal_bridge_started_at),
    context: {
      conversation,
      nativeTakeover,
      ...runtime
    }
  };
}

async function migrateLegacyTerminalAgentIdentity({
  conversation,
  statePath,
  logPath,
  options
}) {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!nativeTakeover || !terminalControl) {
    return conversation;
  }
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  if (Number.isInteger(runtime.pid) && Number(runtime.pid) > 0) {
    return conversation;
  }

  const executor = executorForConversation(conversation);
  const nativeSessionId = stringValue(nativeTakeover.native_session_id);
  if (
    executor.kind !== "codex" ||
    !nativeSessionId ||
    parseTerminalConversationId(nativeSessionId)
  ) {
    return conversation;
  }

  let matchedProcess: ActiveTerminalProcess | undefined;
  try {
    const registry = createRuntimeTerminalAgentRegistry(options);
    const adapter = registry.require("codex");
    const snapshots = await createTerminalProcessSource(options).listProcessSnapshots(
      (snapshot) => adapter.classifyProcess(snapshot) !== undefined,
      { includeAncestors: true }
    );
    const panes = await createTerminalControlProvider(options).listPanes();
    const matchingPanes = panes.filter((pane) =>
      pane.kind === terminalControl.kind &&
      pane.target === terminalControl.target &&
      pane.panePid === terminalControl.panePid
    );
    if (matchingPanes.length !== 1) {
      return conversation;
    }

    const candidates = snapshots.flatMap((snapshot): ActiveTerminalProcess[] => {
      const classified = adapter.classifyProcess(snapshot);
      return classified ? [{ ...classified, agent: "codex" }] : [];
    });
    const matches = candidates.filter((candidate) =>
      candidate.sessionId === nativeSessionId &&
      terminalPaneContainsProcess(candidate, matchingPanes[0], snapshots)
    );
    if (matches.length !== 1) {
      return conversation;
    }
    matchedProcess = matches[0];
  } catch (error) {
    runtimeLog("warn", "legacy_terminal_agent_identity_migration_failed", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      reason: error instanceof Error ? error.message : String(error)
    });
    return conversation;
  }
  if (!matchedProcess) {
    return conversation;
  }

  const releaseLock = acquireFileLock(`${statePath}.lock`);
  let migratedConversation = conversation;
  let migrated = false;
  try {
    const current = loadState(statePath);
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (!currentTakeover || !currentControl) {
      return current;
    }
    const currentRuntime = terminalRuntimeIdentityForConversation(current, currentControl);
    if (Number.isInteger(currentRuntime.pid) && Number(currentRuntime.pid) > 0) {
      return current;
    }
    if (
      currentTakeover.native_session_id !== nativeSessionId ||
      currentControl.target !== terminalControl.target ||
      currentControl.socketPath !== terminalControl.socketPath ||
      currentControl.panePid !== terminalControl.panePid
    ) {
      return current;
    }

    const migratedAt = new Date().toISOString();
    migratedConversation = {
      ...current,
      native_session_takeover: {
        ...currentTakeover,
        terminal_agent_pid: matchedProcess.pid,
        terminal_agent_session_id: matchedProcess.sessionId,
        terminal_agent_identity_migrated_at: migratedAt
      },
      updated_at: migratedAt
    };
    saveState(statePath, migratedConversation);
    migrated = true;
  } finally {
    releaseLock();
  }

  if (migrated) {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: migratedConversation.conversation_id,
      event: "terminal_agent_identity_migrated",
      terminal_target: terminalControl.target,
      terminal_agent_pid: matchedProcess.pid,
      native_session_id: nativeSessionId
    });
    runtimeLog("info", "terminal_agent_identity_migrated", {
      conversation_id: migratedConversation.conversation_id,
      terminal_target: terminalControl.target,
      terminal_agent_pid: matchedProcess.pid
    });
  }
  return migratedConversation;
}

function isTerminalControlCapability(value: unknown): value is TerminalControlCapability {
  return typeof value === "string" && [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ].includes(value);
}

async function runDelegate(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace === undefined
    ? undefined
    : canonicalWorkspace(options.workspace);
  const requestedAgent = options.agent === undefined
    ? undefined
    : resolveExecutor({ kind: options.agent }).kind;
  const scan = await buildTerminalListGroup({
    options: {
      ...options,
      workspace,
      noApprovalScan: false
    },
    agentFilter: requestedAgent,
    statusFilter: undefined
  });
  if (scan.summary.error) {
    throw new Error(`tmux discovery failed: ${scan.summary.error}`);
  }

  const scopedCandidates = workspace === undefined
    ? scan.terminalControlled
    : scan.terminalControlled.filter((candidate) => {
        try {
          return canonicalWorkspace(candidate.workspace) === workspace;
        } catch {
          return false;
        }
      });
  const eligible = scopedCandidates.filter(
    (candidate) => candidate.activity_state === "idle"
  );
  if (eligible.length === 0) {
    const observed = scopedCandidates.length > 0
      ? ` Found ${scopedCandidates.length} matching pane(s), but none is idle.`
      : "";
    const requestedExecutor = requestedAgent
      ? executorDefinitionForKind(requestedAgent)
      : undefined;
    const workspaceDetail = workspace
      ? ` in ${workspace}`
      : "";
    throw new Error(
      `No idle ${requestedExecutor?.displayName ?? "Codex or Claude Code"} pane is available${workspaceDetail}.${observed} ` +
      `Start ${requestedAgent ?? "codex or claude"} inside tmux${workspaceDetail}, wait until it is idle, then retry.`
    );
  }
  if (eligible.length > 1) {
    const candidates = eligible
      .map((candidate) => {
        const identity =
          `${candidate.agent}, ${candidate.terminal_control?.target ?? candidate.id}`;
        return workspace
          ? `${candidate.short_ref} (${identity})`
          : `${candidate.short_ref} (${identity}, ${candidate.workspace ?? "workspace unknown"})`;
      })
      .join(", ");
    const scope = requestedAgent
      ? executorDefinitionForKind(requestedAgent).displayName
      : "coding-agent";
    const ambiguity = workspace
      ? `match ${workspace}`
      : "are available across workspaces";
    throw new Error(
      `Multiple idle ${scope} panes ${ambiguity}: ${candidates}. ` +
      "Use /akk codex: <task>, /akk claude: <task>, or /akk @short-ref: <message> to choose one explicitly."
    );
  }

  const selectedWorkspace = canonicalWorkspace(eligible[0].workspace);
  await runSend({
    ...options,
    conversation: eligible[0].id,
    message: request,
    workspace: selectedWorkspace,
    background: true
  });
}

function startTerminalBridgeMonitor({
  statePath,
  logPath,
  agentTimeoutMinutes,
  agentHardTimeoutMinutes,
  pollIntervalMs,
  codexHome,
  claudeHome
}) {
  const args = [
    new URL(import.meta.url).pathname,
    "monitor",
    "--terminal-bridge",
    "--state",
    statePath,
    "--log",
    logPath,
    "--agent-timeout-minutes",
    String(agentTimeoutMinutes),
    "--agent-hard-timeout-minutes",
    String(agentHardTimeoutMinutes),
    "--poll-interval-ms",
    String(pollIntervalMs)
  ];
  if (codexHome) {
    args.push("--codex-home", codexHome);
  }
  if (claudeHome) {
    args.push("--claude-home", claudeHome);
  }
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: environmentWithoutGatewayTokens()
  });
  child.unref();
  return child;
}

function startTerminalBridgeMonitorForConversation({ conversation, statePath, logPath, options }) {
  if (!terminalBridgeEnabled(conversation) || !conversation.gateway_method || options.disableTerminalBridgeMonitor === true) {
    return undefined;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  return startTerminalBridgeMonitor({
    statePath,
    logPath,
    agentTimeoutMinutes: Number(
      options.agentTimeoutMinutes ??
        nativeTakeover?.["terminal_bridge_inactivity_timeout_minutes"] ??
        DEFAULT_AGENT_TIMEOUT_MINUTES
    ),
    agentHardTimeoutMinutes: Number(
      options.agentHardTimeoutMinutes ??
        nativeTakeover?.["terminal_bridge_hard_timeout_minutes"] ??
        DEFAULT_AGENT_HARD_TIMEOUT_MINUTES
    ),
    pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS),
    codexHome: options.codexHome,
    claudeHome: options.claudeHome ?? nativeTakeover?.["claude_home"]
  });
}

function startTerminalBridgeMonitorHandoffWatchdog({
  conversation,
  statePath,
  logPath,
  options
}) {
  if (
    options.disableTerminalBridgeMonitor === true ||
    !terminalBridgeEnabled(conversation)
  ) {
    return undefined;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalMessageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  if (!terminalMessageId) {
    return undefined;
  }

  const args = [
    new URL(import.meta.url).pathname,
    "monitor",
    "--terminal-bridge-handoff",
    "--state",
    statePath,
    "--log",
    logPath,
    "--expected-terminal-message-id",
    terminalMessageId
  ];
  const monitorPollIntervalMs = Number(options.monitorPollIntervalMs);
  if (Number.isFinite(monitorPollIntervalMs) && monitorPollIntervalMs > 0) {
    args.push(
      "--monitor-poll-interval-ms",
      String(monitorPollIntervalMs)
    );
  }
  const handoffPollIntervalMs = Number(options.monitorHandoffPollIntervalMs);
  if (Number.isFinite(handoffPollIntervalMs) && handoffPollIntervalMs > 0) {
    args.push(
      "--monitor-handoff-poll-interval-ms",
      String(handoffPollIntervalMs)
    );
  }
  const claudeHome =
    options.claudeHome ?? nativeTakeover?.["claude_home"];
  if (options.codexHome) {
    args.push("--codex-home", options.codexHome);
  }
  if (claudeHome) {
    args.push("--claude-home", claudeHome);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: environmentWithoutGatewayTokens()
  });
  child.unref();
  return child;
}

function ensureTerminalBridgeMonitorAfterApproval({
  conversation,
  statePath,
  logPath,
  terminalControl,
  options,
  reason = "approval_resolved"
}) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalMessageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  const activeMonitor = terminalMessageId
    ? activeTerminalBridgeMonitorOwner(statePath, terminalMessageId)
    : undefined;
  const launchedMonitor = activeMonitor
    ? undefined
    : startTerminalBridgeMonitorForConversation({
        conversation,
        statePath,
        logPath,
        options
      });
  const handoffWatchdog = activeMonitor
    ? startTerminalBridgeMonitorHandoffWatchdog({
        conversation,
        statePath,
        logPath,
        options
      })
    : undefined;
  const monitorPid = activeMonitor?.ownerPid ?? launchedMonitor?.pid;
  const agentTimeoutMinutes = Number(
    options.agentTimeoutMinutes ??
      nativeTakeover?.terminal_bridge_inactivity_timeout_minutes ??
      DEFAULT_AGENT_TIMEOUT_MINUTES
  );
  const agentHardTimeoutMinutes = Number(
    options.agentHardTimeoutMinutes ??
      nativeTakeover?.terminal_bridge_hard_timeout_minutes ??
      DEFAULT_AGENT_HARD_TIMEOUT_MINUTES
  );
  if (activeMonitor) {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_monitor_reused",
      pid: activeMonitor.ownerPid ?? null,
      terminal_control: terminalControl,
      reason,
      agent_timeout_minutes: agentTimeoutMinutes,
      agent_hard_timeout_minutes: agentHardTimeoutMinutes
    });
    runtimeLog("info", "terminal_bridge_monitor_reused", {
      conversation_id: conversation.conversation_id,
      monitor_pid: activeMonitor.ownerPid ?? null,
      terminal_target: terminalControl.target,
      reason
    });
    if (handoffWatchdog) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_handoff_watchdog_launch",
        pid: handoffWatchdog.pid ?? null,
        monitor_owner_pid: activeMonitor.ownerPid ?? null,
        terminal_bridge_message_id: terminalMessageId,
        terminal_control: terminalControl,
        reason
      });
      runtimeLog("info", "terminal_bridge_monitor_handoff_watchdog_launch", {
        conversation_id: conversation.conversation_id,
        watchdog_pid: handoffWatchdog.pid ?? null,
        monitor_owner_pid: activeMonitor.ownerPid ?? null,
        terminal_target: terminalControl.target,
        reason
      });
    }
  } else if (launchedMonitor) {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: launchedMonitor.pid ?? null,
      terminal_control: terminalControl,
      reason,
      agent_timeout_minutes: agentTimeoutMinutes,
      agent_hard_timeout_minutes: agentHardTimeoutMinutes
    });
    runtimeLog("info", "terminal_bridge_monitor_launch", {
      conversation_id: conversation.conversation_id,
      monitor_pid: launchedMonitor.pid ?? null,
      terminal_target: terminalControl.target,
      reason
    });
  }
  return {
    activeMonitor,
    launchedMonitor,
    handoffWatchdog,
    monitorPid
  };
}

function terminalBridgeEnabled(conversation): boolean {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  return nativeTakeover?.["terminal_bridge"] === true;
}

function withTerminalBridgeState({
  conversation,
  message,
  requestText,
  startedAt,
  agentTimeoutMinutes,
  agentHardTimeoutMinutes,
  preSendScreenFingerprint,
  claudeTranscriptAnchor,
  claudeHome
}) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  return {
    ...conversation,
    native_session_takeover: {
      ...nativeTakeover,
      terminal_bridge: true,
      terminal_bridge_started_at: startedAt,
      terminal_bridge_message_id: message.id,
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash: terminalBridgeRequestFingerprint(requestText),
      terminal_bridge_pre_send_screen_fingerprint: preSendScreenFingerprint,
      claude_transcript_anchor: claudeTranscriptAnchor,
      claude_home: claudeHome,
      terminal_bridge_completion_claim: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_monitor_lock_version: TERMINAL_BRIDGE_MONITOR_LOCK_VERSION,
      terminal_bridge_monitor_started_at: startedAt,
      terminal_bridge_last_activity_at: startedAt,
      terminal_bridge_inactivity_timeout_minutes: agentTimeoutMinutes,
      terminal_bridge_hard_timeout_minutes: agentHardTimeoutMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(startedAt, agentTimeoutMinutes),
      terminal_bridge_hard_deadline_at: deadlineAt(startedAt, agentHardTimeoutMinutes)
    },
    updated_at: startedAt
  };
}

type TerminalBridgeSubmissionStatus =
  | "prepared"
  | "submitted"
  | "uncertain"
  | "aborted";

function withTerminalBridgeSubmission({
  conversation,
  messageId,
  requestText,
  status,
  preparedAt,
  submittedAt,
  uncertainAt,
  abortedAt,
  error
}: {
  conversation: Conversation;
  messageId: string;
  requestText: string;
  status: TerminalBridgeSubmissionStatus;
  preparedAt: string;
  submittedAt?: string;
  uncertainAt?: string;
  abortedAt?: string;
  error?: string;
}): Conversation {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  const previousSubmission = isRecord(nativeTakeover.terminal_bridge_submission)
    ? nativeTakeover.terminal_bridge_submission
    : undefined;
  const previousDispatcherPid = Number(previousSubmission?.dispatcher_pid);
  const dispatcherPid = status === "prepared" ||
    !Number.isSafeInteger(previousDispatcherPid) ||
    previousDispatcherPid <= 1
    ? process.pid
    : previousDispatcherPid;
  return {
    ...conversation,
    native_session_takeover: {
      ...nativeTakeover,
      terminal_bridge_submission: {
        status,
        message_id: messageId,
        request_hash: terminalBridgeRequestFingerprint(requestText),
        prepared_at: preparedAt,
        dispatcher_pid: dispatcherPid,
        ...(submittedAt ? { submitted_at: submittedAt } : {}),
        ...(uncertainAt ? { uncertain_at: uncertainAt } : {}),
        ...(abortedAt ? { aborted_at: abortedAt } : {}),
        ...(error ? { error: textSummary(error) } : {})
      }
    },
    updated_at: submittedAt ?? uncertainAt ?? abortedAt ?? preparedAt
  };
}

function terminalBridgeSubmission(
  conversation
): Record<string, any> | undefined {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  return isRecord(nativeTakeover?.terminal_bridge_submission)
    ? nativeTakeover.terminal_bridge_submission
    : undefined;
}

function unresolvedTerminalBridgeSubmission(conversation): Record<string, any> | undefined {
  const submission = terminalBridgeSubmission(conversation);
  return submission &&
    (submission.status === "prepared" || submission.status === "uncertain")
    ? submission
    : undefined;
}

function assertNoUnresolvedTerminalBridgeSubmission(
  storeDir: string,
  terminalControl: TerminalControlRef,
  currentConversationId: string,
  requestText: string
): void {
  const targetKey = terminalControlSelectorKey(terminalControl);
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  if (!targetKey) {
    return;
  }
  for (const candidate of listConversations(storeDir)) {
    const submission = terminalBridgeSubmission(candidate);
    if (
      candidate.conversation_id === currentConversationId ||
      !isActiveStatus(candidate.status) ||
      !submission ||
      !["prepared", "submitted", "uncertain"].includes(String(submission.status))
    ) {
      continue;
    }
    if (
      submission.status === "submitted" &&
      stringValue(submission.request_hash) !== requestHash
    ) {
      continue;
    }
    const nativeTakeover = isRecord(candidate.native_session_takeover)
      ? candidate.native_session_takeover
      : undefined;
    if (
      terminalControlSelectorKey(
        terminalControlFromTakeover(nativeTakeover)
      ) === targetKey
    ) {
      throw new Error(
        `terminal ${terminalControl.target} has a conflicting ${String(submission.status)} ` +
        `AKK submission in ${candidate.conversation_id}; inspect that conversation and pane, ` +
        "then close it before retrying"
      );
    }
  }
}

function stallOtherTerminalBridgeConversationsForUncertainDispatch({
  storeDir,
  terminalControl,
  currentConversationId,
  uncertainMessageId
}: {
  storeDir: string;
  terminalControl: TerminalControlRef;
  currentConversationId: string;
  uncertainMessageId: string;
}): string[] {
  const targetKey = terminalControlSelectorKey(terminalControl);
  if (!targetKey) {
    return [];
  }
  const stalledConversationIds: string[] = [];
  for (const listed of listConversations(storeDir)) {
    if (
      listed.conversation_id === currentConversationId ||
      !isActiveStatus(listed.status)
    ) {
      continue;
    }
    const listedTakeover = isRecord(listed.native_session_takeover)
      ? listed.native_session_takeover
      : undefined;
    if (
      listedTakeover?.terminal_bridge !== true ||
      terminalControlSelectorKey(
        terminalControlFromTakeover(listedTakeover)
      ) !== targetKey
    ) {
      continue;
    }
    const listedStatePath = stringValue(listed.state_path);
    if (!listedStatePath) {
      continue;
    }
    const releaseStateLock = acquireFileLock(`${listedStatePath}.lock`);
    try {
      const current = loadState(listedStatePath);
      const currentTakeover = isRecord(current.native_session_takeover)
        ? current.native_session_takeover
        : undefined;
      if (
        !isActiveStatus(current.status) ||
        currentTakeover?.terminal_bridge !== true ||
        terminalControlSelectorKey(
          terminalControlFromTakeover(currentTakeover)
        ) !== targetKey
      ) {
        continue;
      }
      const stalledAt = new Date().toISOString();
      const stalledConversation = {
        ...current,
        status: "stalled" as const,
        stalled_at: stalledAt,
        stalled_reason:
          "a newer terminal submission has an uncertain outcome; inspect the shared tmux pane before continuing",
        native_session_takeover: {
          ...currentTakeover,
          terminal_bridge_uncertain_dispatch_fence: {
            message_id: uncertainMessageId,
            observed_at: stalledAt
          }
        },
        updated_at: stalledAt
      };
      saveState(listedStatePath, stalledConversation);
      try {
        appendEvent(logPathForStatePath(listedStatePath), {
          ts: stalledAt,
          conversation_id: current.conversation_id,
          event: "terminal_bridge_stalled_by_uncertain_dispatch",
          terminal_control: terminalControl,
          uncertain_message_id: uncertainMessageId
        });
      } catch {
        // The stalled state and terminal-level ledger are the authoritative fence.
      }
      stalledConversationIds.push(current.conversation_id);
    } finally {
      releaseStateLock();
    }
  }
  return stalledConversationIds;
}

function environmentWithoutGatewayTokens(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.AKK_GATEWAY_TOKEN;
  delete environment.OPENCLAW_GATEWAY_TOKEN;
  return environment;
}

async function runList(options) {
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(process.cwd()));
  const cleanup = cleanupIdleConversations(storeDir, options);
  const includeAll = Boolean(options.all);
  const agentFilter = options.agent ? resolveExecutor({ kind: options.agent }).kind : undefined;
  const statusFilter = options.status;
  const allStoredConversations = listConversations(storeDir);
  const storedConversations = allStoredConversations
    .filter(isDiscoverableTmuxConversation)
    .filter((conversation) => includeAll || isActiveStatus(conversation.status))
    .filter((conversation) =>
      matchesConfiguredWorkspace(options.workspace, conversation.workspace)
    )
    .filter((conversation) =>
      !agentFilter || executorForConversation(conversation).kind === agentFilter
    )
    .filter((conversation) => !statusFilter || conversation.status === statusFilter);
  const conversations = storedConversations.map((conversation) =>
    summarizeConversation(conversation)
  );
  const delegated = storedConversations.map((conversation) =>
    delegatedListEntry(
      summarizeConversation(conversation),
      {
        terminalBridge: terminalBridgeEnabled(conversation),
        approvalState: managedListApprovalState(conversation),
        conversation
      }
    )
  );
  const terminalScan = await buildTerminalListGroup({ options, agentFilter, statusFilter });
  const managedTerminalKeys = new Set(
    allStoredConversations
      .filter((conversation) => isActiveStatus(conversation.status))
      .filter((conversation) =>
        matchesConfiguredWorkspace(options.workspace, conversation.workspace)
      )
      .map((conversation) =>
        terminalControlSelectorKey(
          terminalControlFromTakeover(
            isRecord(conversation.native_session_takeover)
              ? conversation.native_session_takeover
              : undefined
          )
        )
      )
      .filter((key): key is string => key !== undefined)
  );
  const terminalControlled = terminalScan.terminalControlled.filter((entry) => {
    if (
      !matchesConfiguredWorkspace(
        options.workspace,
        entry.workspace ?? entry.cwd
      )
    ) {
      return false;
    }
    const key = terminalControlSelectorKey(entry.terminal_control);
    return key === undefined || !managedTerminalKeys.has(key);
  });

  printJson({
    store_dir: storeDir,
    cleanup,
    action_contracts: listActionContracts(),
    delegated,
    terminal_controlled: terminalControlled,
    terminal_scan: {
      ...terminalScan.summary,
      terminal_controlled_count: terminalControlled.length
    },
    tasks: conversations
  });
  runtimeLog("info", "tasks_listed", {
    store_dir: storeDir,
    returned_count: conversations.length,
    terminal_controlled_count: terminalControlled.length,
    terminal_scan_error: terminalScan.summary.error,
    include_all: includeAll,
    agent_filter: agentFilter,
    status_filter: statusFilter,
    cleanup
  });
}

async function buildTerminalListGroup({ options, agentFilter, statusFilter }) {
  const empty = {
    terminalControlled: [],
    summary: {
      enabled: false,
      agents: [],
      error: undefined
    }
  };
  if (options.managedOnly) {
    return empty;
  }
  if (statusFilter && statusFilter !== "active") {
    return {
      ...empty,
      summary: {
        enabled: false,
        agents: [],
        skipped: `terminal discovery skipped for status filter ${statusFilter}`
      }
    };
  }
  const registry = createRuntimeTerminalAgentRegistry(options);
  const adapters = agentFilter
    ? [registry.get(agentFilter)].filter((adapter) => adapter !== undefined)
    : registry.list();
  if (agentFilter && adapters.length === 0) {
    return {
      ...empty,
      summary: {
        enabled: true,
        agents: [],
        skipped: `terminal agent adapter is not registered for ${agentFilter}`
      }
    };
  }

  const terminalProvider = createTerminalControlProvider(options);
  const bridge = createTerminalAgentBridge(options, terminalProvider, registry);
  const terminalDiagnostics = options.terminalDebug
    ? await terminalControlDiagnostics(terminalProvider)
    : undefined;
  const terminalControlled: Record<string, any>[] = [];
  let activeCount = 0;
  const errors: string[] = [];
  try {
    const processSource = createTerminalProcessSource(options);
    const snapshots = await processSource.listProcessSnapshots((snapshot) =>
      adapters.some((adapter) =>
        adapter.capabilities.processDiscovery && adapter.classifyProcess(snapshot) !== undefined
      ),
      { includeAncestors: true }
    );
    const activeSessions = await bridge.listProcesses(
      snapshots,
      adapters.map((adapter) => adapter.agent)
    );
    const rootSessions = rootActiveProcesses(activeSessions);
    const controlledSessions = rootSessions.filter(
      (session) => session.terminalControl !== undefined
    );
    activeCount = controlledSessions.length;
    for (const session of controlledSessions) {
      terminalControlled.push(await terminalControlledListEntry(
        session,
        activeSessions,
        options,
        bridge
      ));
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    terminalControlled,
    summary: {
      enabled: true,
      agents: adapters.map((adapter) => adapter.agent),
      active_count: activeCount,
      terminal_controlled_count: terminalControlled.length,
      approval_scan: options.noApprovalScan ? "disabled" : "enabled",
      diagnostics: terminalDiagnostics,
      error: errors.length > 0 ? errors.join("; ") : undefined
    }
  };
}

async function terminalControlDiagnostics(provider: TerminalControlProvider) {
  if (provider instanceof TmuxTerminalControlProvider) {
    return provider.diagnose();
  }
  return {
    provider: "static",
    paneCount: (await provider.listPanes()).length
  };
}

function delegatedListEntry(
  task,
  {
    terminalBridge = false,
    approvalState,
    conversation
  }: {
    terminalBridge?: boolean;
    approvalState?: Record<string, any>;
    conversation?: Record<string, any>;
  } = {}
) {
  const entry = {
    ...task,
    id: task.conversation_id,
    short_ref: sessionShortRef(task.conversation_id),
    source: "akk_delegate",
    ...(approvalState ? { approval_state: approvalState } : {}),
    commands: {
      send: canSendDelegated(task.status),
      cancel: isWaitingForAgent(task.status),
      close: task.status !== "closed",
      status: true,
      approve: terminalBridge && isActiveStatus(task.status)
    }
  };
  return {
    ...entry,
    available_actions: availableListActions(entry, { conversation })
  };
}

async function terminalControlledListEntry(
  session: ActiveTerminalProcess,
  activeSessions: ActiveTerminalProcess[],
  options,
  bridge: TerminalAgentBridge = createTerminalAgentBridge(options)
) {
  const terminalControl = session.terminalControl;
  if (!terminalControl) {
    throw new Error(`process ${session.pid} is not terminal-controlled`);
  }
  const terminalState = await listStateForTerminal(
    session.agent,
    terminalControl,
    options,
    bridge,
    {
      pid: session.pid,
      sessionId: session.sessionId,
      cwd: session.cwd,
      terminalTarget: terminalControl.target
    }
  );
  const orphanedDispatch =
    orphanedTerminalDispatchForRecovery(terminalControl);
  const entry = {
    id: bridge.terminalConversationId(session),
    short_ref: sessionShortRef(bridge.terminalConversationId(session)),
    source: "terminal_control",
    agent: session.agent,
    status: "active",
    pid: session.pid,
    child_pids: childPidsForRoot(session, activeSessions),
    command: session.command,
    cwd: session.cwd,
    workspace: session.cwd,
    elapsed: session.elapsed,
    session_id: session.sessionId,
    confidence: session.confidence,
    reason: session.reason,
    terminal_control: terminalControl,
    approval_state: terminalState.approval_state,
    activity_state: terminalState.activity_state,
    activity_reason: terminalState.activity_reason,
    ...(orphanedDispatch
      ? {
          orphaned_terminal_dispatch: {
            status: orphanedDispatch.status,
            owner_conversation_id:
              stringValue(orphanedDispatch.conversation_id),
            message_id: stringValue(orphanedDispatch.message_id),
            recovery:
              `/akk close ${bridge.terminalConversationId(session)} ` +
              `--expected-message-id ${String(
                orphanedDispatch.message_id
              )}`
          }
        }
      : {}),
    commands: {
      send: true,
      approve: terminalControl.capabilities.includes("terminal_approval") &&
        terminalState.approval_state.approvable === true,
      status: true,
      cancel: terminalControl.capabilities.includes("terminal_cancel"),
      close: orphanedDispatch !== undefined
    }
  };
  return {
    ...entry,
    available_actions: availableListActions(entry)
  };
}

async function listStateForTerminal(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  options,
  bridge: TerminalAgentBridge = createTerminalAgentBridge(options),
  runtime?: TerminalRuntimeIdentity
) {
  if (options.noApprovalScan) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        reason: "approval scan disabled"
      },
      activity_state: "unknown",
      activity_reason: "terminal screen scan disabled"
    };
  }
  try {
    const status = await bridge.status(agent, terminalControl, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime
    });
    return {
      approval_state: {
        ...status.approval_state,
        screen_excerpt: status.approval_state.blocked ? status.screen.excerpt?.slice(-1000) : undefined
      },
      activity_state: status.activity_state,
      activity_reason: status.activity_reason,
      capability_limitation: status.capability_limitation
    };
  } catch (error) {
    return {
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false,
        error: error instanceof Error ? error.message : String(error)
      },
      activity_state: "unknown",
      activity_reason: error instanceof Error ? error.message : String(error)
    };
  }
}

function rootActiveProcesses(processes: ActiveTerminalProcess[]): ActiveTerminalProcess[] {
  const pids = new Set(processes.map((process) => `${process.agent}:${process.pid}`));
  const roots = processes.filter((process) =>
    !process.ppid || !pids.has(`${process.agent}:${process.ppid}`)
  );
  const seenTerminalTargets = new Set<string>();
  return roots.filter((process) => {
    const terminalTarget = process.terminalControl?.target
      ? `${process.agent}:${process.terminalControl.target}:${process.terminalControl.panePid}`
      : undefined;
    if (!terminalTarget) {
      return true;
    }
    if (seenTerminalTargets.has(terminalTarget)) {
      return false;
    }
    seenTerminalTargets.add(terminalTarget);
    return true;
  });
}

function childPidsForRoot(root: ActiveTerminalProcess, processes: ActiveTerminalProcess[]): number[] {
  return processes
    .filter((process) => process.agent === root.agent && process.ppid === root.pid)
    .map((process) => process.pid);
}

function canSendDelegated(status) {
  return !["done", "failed", "closed", "cancelled"].includes(status);
}

function managedListApprovalState(
  conversation
): Record<string, any> | undefined {
  if (
    !terminalBridgeEnabled(conversation) ||
    !["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(conversation.status)
    )
  ) {
    return undefined;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (
    !terminalControlFromTakeover(nativeTakeover) ||
    !stringValue(nativeTakeover?.terminal_bridge_message_id)
  ) {
    return undefined;
  }
  const approval = isRecord(nativeTakeover?.terminal_bridge_approval)
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const approvalState = isRecord(approval?.approval_state)
    ? approval.approval_state
    : undefined;
  const fingerprint = stringValue(approval?.fingerprint);
  const notifiedAt = stringValue(approval?.notified_at);
  const notifiedAtMs = validTimestampMs(notifiedAt);
  if (
    !approvalState ||
    !fingerprint ||
    notifiedAtMs === undefined ||
    Date.now() - notifiedAtMs > CLAUDE_SCREEN_APPROVAL_TTL_MS
  ) {
    return undefined;
  }
  return {
    ...approvalState,
    fingerprint,
    notified_at: notifiedAt
  };
}

function listActionContracts() {
  return {
    version: 2,
    instructions: [
      "Use only actions present in delegated[].available_actions or terminal_controlled[].available_actions.",
      "Never use commands for routing or tool calls. It is a deprecated, non-authoritative compatibility field with mixed legacy semantics.",
      "Start with the action's prefilled arguments, supply every missing_required field, and consult the top-level action's optional fields only when needed.",
      "Authoritative full IDs are prefilled; short_ref is for display and human input.",
      "Availability is a snapshot. AKK revalidates process, tmux pane, workspace, activity, approval, and recovery state before side effects."
    ],
    field_semantics: {
      status: {
        delegated: "task_lifecycle",
        terminal_controlled: "process_liveness",
        authoritative_for_tool_calls: false
      },
      activity_state: {
        terminal_controlled: "screen_activity_classification",
        authoritative_for_tool_calls: false
      },
      commands: {
        meaning: "legacy_compatibility_flags_with_mixed_semantics",
        deprecated: true,
        authoritative_for_tool_calls: false
      },
      available_actions: {
        meaning: "currently_safe_actions",
        authoritative_for_tool_calls: true
      }
    },
    actions: {
      send: {
        tool: "agent_knock_knock_send",
        target_argument: "selector",
        required: ["request"],
        optional: [
          "selector",
          "type",
          "idleTimeoutMinutes",
          "agentTimeoutMinutes",
          "agentHardTimeoutMinutes"
        ],
        unsupported: ["timeoutSeconds"],
        ordinary_use:
          "Add request only. Omit timeout fields unless the user explicitly asks to change monitoring limits."
      },
      status: {
        tool: "agent_knock_knock_status",
        target_argument: "conversation_id",
        required: ["conversation_id"],
        optional: ["idleTimeoutMinutes", "trace"]
      },
      approve: {
        tool: "agent_knock_knock_approve",
        target_argument: "conversation_id",
        required: ["conversation_id", "expected_approval_fingerprint"],
        requires_explicit_user_confirmation: true,
        requires_fresh_status: true
      },
      cancel: {
        tool: "agent_knock_knock_cancel",
        target_argument: "conversation_id",
        required: ["conversation_id"],
        optional: ["idleTimeoutMinutes"],
        requires_user_intent: true
      },
      renew: {
        tool: "agent_knock_knock_renew",
        target_argument: "conversation_id",
        required: ["conversation_id"],
        optional: ["minutes"]
      },
      retry_callback: {
        tool: "agent_knock_knock_retry_callback",
        target_argument: "conversation_id",
        required: ["conversation_id"]
      },
      close: {
        tool: "agent_knock_knock_close",
        target_argument: "conversation_id",
        required: ["conversation_id"],
        optional: ["reason", "expected_message_id"],
        requires_explicit_user_confirmation: true
      }
    }
  };
}

function availableListActions(
  entry,
  { conversation }: { conversation?: Record<string, any> } = {}
): Record<string, any> {
  const id = stringValue(entry.id ?? entry.conversation_id);
  if (!id) {
    return {};
  }
  const commands = isRecord(entry.commands) ? entry.commands : {};
  const actions: Record<string, any> = {
    status: {
      tool: "agent_knock_knock_status",
      arguments: { conversation_id: id }
    }
  };
  const terminalControlled = entry.source === "terminal_control";
  const managed = entry.source === "akk_delegate";
  const approvalState = isRecord(entry.approval_state)
    ? entry.approval_state
    : {};
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const managedApprovalPending = isRecord(
    nativeTakeover?.terminal_bridge_approval
  );
  const terminalBridgeReady =
    managed &&
    terminalBridgeEnabled(conversation) &&
    terminalControlFromTakeover(nativeTakeover) !== undefined;

  if (
    commands.send === true &&
    (
      (
        terminalBridgeReady &&
        ["waiting_for_openclaw", "idle"].includes(String(entry.status)) &&
        !managedApprovalPending &&
        approvalState.blocked !== true
      ) ||
      (
        terminalControlled &&
        entry.activity_state === "idle" &&
        approvalState.blocked !== true
      )
    )
  ) {
    actions.send = {
      tool: "agent_knock_knock_send",
      arguments: { selector: id },
      missing_required: ["request"]
    };
  }

  const approvalFingerprint = stringValue(approvalState.fingerprint);
  const managedApprovalEligible =
    terminalBridgeReady &&
    entry.status === "waiting_for_openclaw" &&
    (
      entry.agent !== "claude" ||
      approvalState.decision_mode === "keys"
    );
  if (
    commands.approve === true &&
    approvalState.approvable === true &&
    approvalFingerprint &&
    (
      (
        terminalControlled &&
        entry.agent === "codex"
      ) ||
      managedApprovalEligible
    )
  ) {
    actions.approve = {
      tool: "agent_knock_knock_approve",
      arguments: { conversation_id: id },
      missing_required: ["expected_approval_fingerprint"],
      before_call: {
        tool: "agent_knock_knock_status",
        arguments: { conversation_id: id },
        use:
          "After explicit user confirmation, copy the latest terminal_status.approval_state.fingerprint into expected_approval_fingerprint."
      },
      requires_explicit_user_confirmation: true,
      requires_fresh_status: true
    };
  }

  const rawCancellable =
    terminalControlled &&
    commands.cancel === true &&
    (
      entry.activity_state === "working" ||
      (
        approvalState.blocked === true &&
        approvalState.approvable === true
      )
    );
  const managedCancellable =
    terminalBridgeReady &&
    ["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(entry.status)
    ) &&
    !(
      managedApprovalPending &&
      approvalState.approvable !== true
    );
  if (rawCancellable || managedCancellable) {
    actions.cancel = {
      tool: "agent_knock_knock_cancel",
      arguments: { conversation_id: id },
      requires_user_intent: true
    };
  }
  if (terminalBridgeReady && entry.status === "stalled") {
    actions.renew = {
      tool: "agent_knock_knock_renew",
      arguments: { conversation_id: id }
    };
  }
  const callbackDelivery = isRecord(conversation?.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  if (
    managed &&
    isRecord(conversation) &&
    isRetryableCallbackDelivery(conversation, callbackDelivery)
  ) {
    actions.retry_callback = {
      tool: "agent_knock_knock_retry_callback",
      arguments: { conversation_id: id }
    };
  }
  if (commands.close === true) {
    const orphanedDispatch = isRecord(entry.orphaned_terminal_dispatch)
      ? entry.orphaned_terminal_dispatch
      : undefined;
    const expectedMessageId = stringValue(orphanedDispatch?.message_id);
    actions.close = {
      tool: "agent_knock_knock_close",
      arguments: {
        conversation_id: id,
        ...(expectedMessageId
          ? { expected_message_id: expectedMessageId }
          : {})
      },
      requires_explicit_user_confirmation: true
    };
  }
  return actions;
}

async function resolveConversationSelectorOption(commandName, options): Promise<void> {
  if (
    !SESSION_SELECTOR_COMMANDS.has(String(commandName ?? "")) ||
    options.state
  ) {
    return;
  }
  const supplied = stringValue(options.conversation ?? options.conversationId)?.trim();
  if (supplied && !isSessionSelectorSyntax(supplied)) {
    // Full authoritative IDs keep their existing command-specific validation
    // path. This avoids a discovery scan before option validation and preserves
    // precise downstream errors for closed or currently non-actionable state.
    return;
  }
  const candidates = await sessionSelectorCandidates(commandName, options);
  const resolution = resolveSessionSelector(supplied, candidates, {
    operation: commandName
  });
  options.conversation = resolution.id;
  delete options.conversationId;
}

function isSessionSelectorSyntax(value: string): boolean {
  return (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(value) ||
    /^@[0-9a-f]+$/iu.test(value)
  );
}

async function sessionSelectorCandidates(
  commandName,
  options
): Promise<SessionSelectorCandidate[]> {
  const storeDir = storeDirFromOptions(options);
  cleanupIdleConversations(storeDir, options);
  const storedConversations = listConversations(storeDir);
  const workspaceConversations = storedConversations
    .filter((conversation) =>
      matchesConfiguredWorkspace(options.workspace, conversation.workspace)
    );
  const discoverableWorkspaceConversations = workspaceConversations
    .filter(isDiscoverableTmuxConversation);
  const managed = discoverableWorkspaceConversations.map((conversation) =>
      delegatedListEntry(
        summarizeConversation(conversation),
        {
          terminalBridge: terminalBridgeEnabled(conversation),
          approvalState: managedListApprovalState(conversation),
          conversation
        }
      )
  );
  const managedTerminalKeys = new Set(
    workspaceConversations
      .filter((conversation) => isActiveStatus(conversation.status))
      .map((conversation) =>
        terminalControlSelectorKey(
          terminalControlFromTakeover(
            isRecord(conversation.native_session_takeover)
              ? conversation.native_session_takeover
              : undefined
          )
        )
      )
      .filter((key): key is string => key !== undefined)
  );
  const terminalScan = await buildTerminalListGroup({
    options: {
      ...options,
      noApprovalScan: commandName === "approve"
        ? options.noApprovalScan
        : true
    },
    agentFilter: undefined,
    statusFilter: undefined
  });
  const observedAtMs = Date.now();
  return [
    ...managed,
    ...terminalScan.terminalControlled.filter((entry) => {
      if (
        !matchesConfiguredWorkspace(
          options.workspace,
          entry.workspace ?? entry.cwd
        )
      ) {
        return false;
      }
      const key = terminalControlSelectorKey(entry.terminal_control);
      return key === undefined || !managedTerminalKeys.has(key);
    })
  ].map((entry) => ({
    id: String(entry.id),
    agent: resolveExecutor({ kind: entry.agent }).kind,
    actionable: sessionEntrySupportsCommand(entry, commandName),
    ...sessionEntryRecency(entry, observedAtMs),
    source: stringValue(entry.source),
    status: stringValue(entry.status),
    workspace: stringValue(entry.workspace ?? entry.cwd),
    label: stringValue(entry.request ?? entry.command)
  }));
}

function terminalControlSelectorKey(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const target = stringValue(value.target);
  const panePid = Number(value.panePid);
  if (!target || !Number.isSafeInteger(panePid) || panePid <= 1) {
    return undefined;
  }
  return JSON.stringify({
    target,
    pane_pid: panePid,
    socket_path: stringValue(value.socketPath) ?? null
  });
}

function sessionEntrySupportsCommand(entry, commandName): boolean {
  const commands = isRecord(entry.commands) ? entry.commands : {};
  if (typeof commands[commandName] === "boolean") {
    return commands[commandName] === true;
  }
  if (entry.source !== "akk_delegate") {
    return false;
  }
  if (commandName === "renew") {
    return entry.status === "stalled";
  }
  if (commandName === "retry-callback") {
    return ["callback_pending", "callback_failed"].includes(entry.status);
  }
  return false;
}

function sessionEntryRecency(entry, observedAtMs: number): { updatedAtMs?: number } {
  const timestamp = Date.parse(String(entry.updated_at ?? entry.created_at ?? ""));
  if (Number.isFinite(timestamp)) {
    return { updatedAtMs: timestamp };
  }
  const elapsedSeconds = parseProcessElapsedSeconds(entry.elapsed);
  if (elapsedSeconds !== undefined) {
    return { updatedAtMs: observedAtMs - elapsedSeconds * 1000 };
  }
  return {};
}

async function resolveTerminalConversationFromOptions(
  options
): Promise<ResolvedTerminalConversation | undefined> {
  return createTerminalAgentBridge(options).resolveConversationId(
    stringValue(options.conversation ?? options.conversationId)
  );
}

async function runStatus(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    const terminalStatus = await terminalStatusForControl(
      terminalConversation.agent,
      terminalConversation.terminalControl,
      options,
      {
        pid: terminalConversation.pid,
        cwd: terminalConversation.terminalControl.currentPath,
        conversationId: terminalConversation.conversationId,
        terminalTarget: terminalConversation.terminalControl.target
      }
    );
    const context = await terminalStatusContext(
      terminalConversation,
      terminalStatus,
      options
    );
    printJson({
      conversation_id: terminalConversation.conversationId,
      source: "terminal_control",
      agent: terminalConversation.agent,
      ...context,
      terminal_control: terminalConversation.terminalControl,
      terminal_status: terminalStatus,
      terminal_screen: terminalStatus.screen
    });
    runtimeLog("info", "terminal_status_read", {
      conversation_id: terminalConversation.conversationId,
      terminal_target: terminalConversation.terminalControl.target,
      reachable: terminalStatus.reachable
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const events = readExistingEvents(logPath);
  const result: Record<string, any> = {
    conversation,
    summary: summarizeConversation(conversation),
    confidence: "high",
    about: managedConversationAbout(conversation, events),
    limitations: [],
    state_path: statePath,
    event_log_path: logPath,
    budget: budgetAction(conversation),
    recent_events: events.slice(-10).map(summarizeEvent)
  };
  if (options.trace) {
    result.trace = buildConversationTrace({ conversation, events, logPath });
  }
  const terminalControl = terminalControlFromTakeover(
    isRecord(conversation.native_session_takeover) ? conversation.native_session_takeover : undefined
  );
  if (terminalControl) {
    const executor = executorForConversation(conversation);
    result.terminal_control = terminalControl;
    result.terminal_status = await terminalStatusForControl(
      executor.kind,
      terminalControl,
      options,
      terminalRuntimeIdentityForConversation(conversation, terminalControl)
    );
    result.terminal_screen = result.terminal_status.screen;
    result.about = managedConversationAbout(
      conversation,
      events,
      result.terminal_status
    );
    result.limitations = result.terminal_status.reachable === false
      ? ["terminal status unavailable"]
      : [];
  } else {
    result.limitations = ["terminal control metadata is unavailable"];
  }
  printJson(result);
  runtimeLog("info", "task_status_read", {
    conversation_id: conversation.conversation_id,
    status: conversation.status,
    state_path: statePath,
    event_log_path: logPath,
    recent_event_count: Math.min(events.length, 10),
    trace: Boolean(options.trace)
  });
}

async function terminalStatusContext(
  terminalConversation: ResolvedTerminalConversation,
  terminalStatus: Record<string, any>,
  options
): Promise<{
  confidence: string;
  about: string;
  limitations: string[];
}> {
  if (terminalConversation.agent === "codex") {
    try {
      const process = await activeCodexProcessForPid(
        options,
        terminalConversation.pid
      );
      const description = await codexTerminalStatusContext({
        id: terminalConversation.conversationId,
        process,
        options,
        terminalControl: terminalConversation.terminalControl,
        terminalStatus
      });
      return {
        confidence: description.confidence,
        about: description.about,
        limitations: description.limitations
      };
    } catch {
      return {
        confidence: "low",
        about: terminalStatus.reachable
          ? `Codex is attached through ${terminalConversation.terminalControl.kind}:${terminalConversation.terminalControl.target}.`
          : "Codex terminal status is unavailable.",
        limitations: [
          "Codex historical session context is unavailable; live terminal status remains authoritative."
        ]
      };
    }
  }
  const adapter =
    createRuntimeTerminalAgentRegistry(options).require(terminalConversation.agent);
  return {
    confidence: terminalStatus.reachable ? "medium" : "low",
    about: terminalStatus.reachable
      ? `${adapter.displayName} is attached through ${terminalConversation.terminalControl.kind}:${terminalConversation.terminalControl.target}.`
      : `${adapter.displayName} terminal status is unavailable.`,
    limitations: [
      "Historical session context is not available for this terminal adapter."
    ]
  };
}

async function terminalStatusForControl(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  options,
  runtime?: TerminalRuntimeIdentity
) {
  return createTerminalAgentBridge(options).status(agent, terminalControl, {
    scrollbackLines: Number(options.scrollbackLines ?? 120),
    runtime
  });
}

function terminalBridgeApprovalFingerprint({ terminalControl, terminalStatus }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  const adapterFingerprint = stringValue(approval.fingerprint);
  if (adapterFingerprint) {
    return adapterFingerprint;
  }
  const screen = isRecord(terminalStatus?.screen) ? terminalStatus.screen : {};
  return createHash("sha256")
    .update(JSON.stringify({
      target: terminalControl.target,
      keys: approval.keys ?? (approval.key ? [approval.key] : undefined),
      label: approval.label,
      prompt_kind: approval.prompt_kind,
      command: approval.command,
      tool_name: approval.tool_name,
      request_detail: approval.request_detail,
      excerpt: screen.excerpt
    }))
    .digest("hex");
}

function claudeTranscriptApprovalIdentity(approvalState): {
  requestId: string;
  evidenceFingerprint: string;
} | undefined {
  const policyEvidence = isRecord(approvalState?.policy_evidence)
    ? approvalState.policy_evidence
    : undefined;
  const requestId = stringValue(policyEvidence?.request_id);
  const evidenceFingerprint = stringValue(
    policyEvidence?.evidence_fingerprint
  );
  if (
    policyEvidence?.source !== "claude_transcript" ||
    policyEvidence?.kind !== "run_command" ||
    !requestId ||
    !evidenceFingerprint ||
    !/^[0-9a-f]{64}$/u.test(evidenceFingerprint)
  ) {
    return undefined;
  }
  return {
    requestId,
    evidenceFingerprint
  };
}

function assertSafeTerminalSend(
  agent: ExecutorKind,
  terminalStatus
): void {
  const displayName = executorDefinitionForKind(agent).displayName;
  const approval = isRecord(terminalStatus?.approval_state)
    ? terminalStatus.approval_state
    : undefined;
  if (terminalStatus?.reachable !== true) {
    throw new Error(`${displayName} terminal status is unavailable`);
  }
  if (approval?.blocked === true) {
    throw new Error(
      stringValue(approval.reason) ?? `${displayName} is waiting at a permission dialog`
    );
  }
  if (terminalStatus.activity_state !== "idle") {
    throw new Error(
      `${displayName} terminal is ${stringValue(terminalStatus.activity_state) ?? "unknown"}, not idle`
    );
  }
}

function terminalBridgeApprovalInstructions({ conversation, terminalControl, terminalStatus }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  const screen = isRecord(terminalStatus?.screen) ? terminalStatus.screen : {};
  const executor = executorForConversation(conversation);
  const agentName = executorDefinitionForKind(executor.kind).displayName;
  const label = stringValue(approval.label) || `the current ${agentName} approval prompt`;
  const keys = Array.isArray(approval.keys)
    ? approval.keys.filter((value): value is string => typeof value === "string")
    : [];
  const decisionMode = stringValue(approval.decision_mode);
  const keyDescription = keys.length > 0
    ? keys.join(" then ")
    : stringValue(approval.key) || "the detected approve key sequence";
  const fingerprint = stringValue(approval.fingerprint);
  const promptKind = stringValue(approval.prompt_kind);
  const command = stringValue(approval.command);
  const toolName = stringValue(approval.tool_name);
  const requestDetail = stringValue(approval.request_detail);
  const requestId = stringValue(approval.request_id);
  const excerpt = stringValue(screen.excerpt) || "(No terminal excerpt was available.)";
  const requiresDirectTerminalReview =
    executor.kind === "claude" &&
    decisionMode === "keys";
  return [
    `${agentName} is waiting for approval in a terminal-controlled AKK session.`,
    "",
    `Conversation: ${conversation.conversation_id}`,
    `Terminal: ${terminalControl.kind}:${terminalControl.target}`,
    `Approval option: ${label} (${keyDescription})`,
    promptKind ? `Request kind: ${promptKind}` : undefined,
    toolName ? `Tool: ${toolName}` : undefined,
    requestDetail ? `Request: ${requestDetail}` : undefined,
    command ? `Command: ${command}` : undefined,
    requestId ? `Request id: ${requestId}` : undefined,
    "",
    "Safe terminal excerpt:",
    "```text",
    excerpt,
    "```",
    "",
    requiresDirectTerminalReview
      ? `Before asking for approval, have the user personally inspect the live ${terminalControl.kind} pane ${terminalControl.target}.`
      : undefined,
    requiresDirectTerminalReview
      ? "This hookless callback intentionally omits raw command details; do not approve from the hash or summary alone."
      : undefined,
    requiresDirectTerminalReview ? "" : undefined,
    `Ask the user whether to approve or deny this ${agentName} request.`,
    "",
    "If the user approves, call `agent_knock_knock_approve` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    `- expected_approval_fingerprint: ${fingerprint ?? "(missing; refresh status before approval)"}`,
    "",
    "Equivalent user command: `AKK approve " + conversation.conversation_id +
      (fingerprint ? ` --expected-approval-fingerprint ${fingerprint}` : "") + "`",
    "",
    "If the user denies or wants to stop this request, call `agent_knock_knock_cancel` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    "",
    "Equivalent user command: `AKK cancel " + conversation.conversation_id + "`",
    "",
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function recordTerminalBridgeApprovalNotification({
  statePath,
  logPath,
  terminalControl,
  terminalStatus,
  fingerprint,
  expectedConversation,
  onRecorded
}) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const currentNativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const currentTerminalControl = terminalControlFromTakeover(currentNativeTakeover);
    if (
      !isWaitingForAgent(conversation.status) ||
      conversation.conversation_id !== expectedConversation.conversationId ||
      conversation.status !== expectedConversation.status ||
      conversation.updated_at !== expectedConversation.updatedAt ||
      currentNativeTakeover?.terminal_bridge !== true ||
      stringValue(currentNativeTakeover.terminal_bridge_message_id) !==
        expectedConversation.messageId ||
      !currentTerminalControl ||
      currentTerminalControl.kind !== terminalControl.kind ||
      currentTerminalControl.target !== terminalControl.target ||
      currentTerminalControl.socketPath !== terminalControl.socketPath ||
      currentTerminalControl.panePid !== terminalControl.panePid
    ) {
      return {
        conversation,
        duplicate: false,
        stale: true,
        recorded: undefined
      };
    }
    const nativeTakeover: Record<string, unknown> = isRecord(conversation.native_session_takeover)
      ? { ...conversation.native_session_takeover }
      : {};
    const approvalScreenDigest = stringValue(
      isRecord(terminalStatus?.screen)
        ? terminalStatus.screen.digest
        : undefined
    );
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    const previousNotifiedAt = validTimestampMs(previousApproval?.notified_at);
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const previousCallbackMessageId =
      stringValue(previousApproval?.callback_message_id);
    const matchingApprovalOutbox =
      callbackDelivery?.kind === "approval_notification" &&
      previousCallbackMessageId !== undefined &&
      callbackMessage?.id === previousCallbackMessageId;
    const callbackDeliveryStatus = stringValue(callbackDelivery?.status);
    const callbackDeliveryAttempts = Number(callbackDelivery?.attempts ?? 0);
    const conflictingActiveOutbox =
      !matchingApprovalOutbox &&
      (
        callbackDeliveryStatus === "pending" ||
        (
          callbackDeliveryStatus === "failed" &&
          Number.isFinite(callbackDeliveryAttempts) &&
          callbackDeliveryAttempts <= CALLBACK_RETRY_DELAYS_MS.length
        )
      );
    if (
      previousApproval?.fingerprint === fingerprint &&
      previousNotifiedAt !== undefined &&
      Date.now() - previousNotifiedAt <= CLAUDE_SCREEN_APPROVAL_TTL_MS
    ) {
      if (conflictingActiveOutbox) {
        return {
          conversation,
          duplicate: false,
          stale: true,
          deferred: true,
          previousApproval,
          recorded: undefined
        };
      }
      if (!matchingApprovalOutbox && !conflictingActiveOutbox) {
        const recoveryMessageId =
          previousCallbackMessageId ?? `msg-${randomUUID()}`;
        const recoveryMessageTs =
          stringValue(previousApproval?.callback_message_ts) ??
          stringValue(previousApproval?.notified_at) ??
          new Date().toISOString();
        const recoveryConversation = previousCallbackMessageId
          ? conversation
          : {
              ...conversation,
              native_session_takeover: {
                ...nativeTakeover,
                terminal_bridge_approval: {
                  ...previousApproval,
                  callback_message_id: recoveryMessageId,
                  callback_message_ts: recoveryMessageTs
                }
              }
            };
        if (!previousCallbackMessageId) {
          saveState(statePath, recoveryConversation);
        }
        const recorded = onRecorded?.(recoveryConversation, {
          recoverMissingOutbox: true
        });
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: recoveryConversation.conversation_id,
          event: "terminal_bridge_approval_notification_outbox_recovered",
          terminal_control: terminalControl,
          fingerprint,
          callback_message_id: recoveryMessageId
        });
        return {
          conversation: isRecord(recorded) && isRecord(recorded.prepared)
            ? recorded.prepared.conversation
            : recoveryConversation,
          duplicate: false,
          recovered: true,
          stale: false,
          previousApproval,
          recorded
        };
      }
      return {
        conversation,
        duplicate: true,
        stale: false,
        previousApproval,
        recorded: undefined
      };
    }

    const now = new Date().toISOString();
    const callbackMessageId = `msg-${randomUUID()}`;
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_approval: {
          fingerprint,
          screen_digest: approvalScreenDigest,
          notified_at: now,
          terminal_control: terminalControl,
          approval_state: terminalStatus.approval_state,
          callback_message_id: callbackMessageId,
          callback_message_ts: now
        }
      },
      updated_at: now
    };
    // Persist the stable callback identity before any message/outbox event. If
    // the process exits during callback preparation, recovery can recreate the
    // exact same message and safely finish the outbox transaction.
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_notification_recorded",
      terminal_control: terminalControl,
      fingerprint,
      screen_digest: approvalScreenDigest
    });
    const recorded = onRecorded?.(nextConversation);
    return {
      conversation: isRecord(recorded) && isRecord(recorded.prepared)
        ? recorded.prepared.conversation
        : nextConversation,
      duplicate: false,
      stale: false,
      recorded
    };
  } finally {
    releaseLock();
  }
}

function markTerminalBridgeApprovalPromptCleared({
  statePath,
  logPath,
  expectedConversationId,
  expectedMessageId
}) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    if (
      conversation.conversation_id !== expectedConversationId ||
      conversation.status !== "waiting_for_agent" ||
      nativeTakeover?.terminal_bridge !== true ||
      stringValue(nativeTakeover.terminal_bridge_message_id) !==
        expectedMessageId ||
      stringValue(nativeTakeover.terminal_bridge_last_approval_message_id) !==
        expectedMessageId ||
      validTimestampMs(
        nativeTakeover.terminal_bridge_approval_resolved_at
      ) === undefined ||
      validTimestampMs(
        nativeTakeover.terminal_bridge_last_approval_prompt_cleared_at
      ) !== undefined
    ) {
      return {
        conversation,
        marked: false
      };
    }

    const clearedAt = new Date().toISOString();
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_last_approval_prompt_cleared_at: clearedAt
      },
      updated_at: clearedAt
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: clearedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_prompt_cleared",
      terminal_bridge_message_id: expectedMessageId
    });
    return {
      conversation: nextConversation,
      marked: true
    };
  } finally {
    releaseLock();
  }
}

function terminalBridgeApprovalCallbackIdentity(conversation): {
  id: string;
  now: Date;
} {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const approval = isRecord(nativeTakeover?.terminal_bridge_approval)
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const id = stringValue(approval?.callback_message_id);
  const timestamp = stringValue(approval?.callback_message_ts);
  const timestampMs = validTimestampMs(timestamp);
  if (!id || timestampMs === undefined) {
    throw new Error("terminal approval notification has no stable callback identity");
  }
  return {
    id,
    now: new Date(timestampMs)
  };
}

function prepareManagedSend({
  options,
  statePath,
  logPath,
  messageBody,
  stateLockHeld = false,
  persist = true,
  rejectTerminalControl = false
}) {
  if (!stateLockHeld) {
    const releaseLock = acquireFileLock(`${statePath}.lock`);
    try {
      return prepareManagedSend({
        options,
        statePath,
        logPath,
        messageBody,
        stateLockHeld: true,
        persist,
        rejectTerminalControl
      });
    } finally {
      releaseLock();
    }
  }

  const conversation = loadState(statePath);
  if (!["waiting_for_agent", "waiting_for_openclaw", "idle"].includes(conversation.status)) {
    throw new Error(`cannot send to ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const executor = executorForConversation(conversation);
  const type = options.type ??
    (conversation.status === "waiting_for_openclaw" ? "answer" : "task");
  const nativeTakeoverForSend = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const unresolvedSubmission = unresolvedTerminalBridgeSubmission(conversation);
  if (unresolvedSubmission) {
    throw new Error(
      `cannot send to ${conversation.conversation_id}; its previous terminal submission is ` +
      `${unresolvedSubmission.status}. Inspect the conversation and tmux pane, then close ` +
      "the AKK conversation before creating a replacement task."
    );
  }
  if (
    rejectTerminalControl &&
    terminalControlFromTakeover(nativeTakeoverForSend)
  ) {
    throw new Error(
      "terminal control changed while waiting to send; refresh status and retry"
    );
  }
  const message = createMessage({
    conversation,
    from: "openclaw",
    to: executor.actor,
    type,
    body: messageBody,
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session
    }
  });
  const nextConversation = {
    ...applyMessageToConversation(conversation, message),
    executor,
    claude_session: executor.kind === "claude"
      ? executor.session
      : conversation.claude_session
  };
  if (persist) {
    saveState(statePath, nextConversation);
    appendEvent(logPath, messageEvent(message));
    runtimeLog("info", "message_created", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      message_type: type,
      state_path: statePath,
      event_log_path: logPath,
      message: textSummary(messageBody)
    });
  }
  return {
    conversation,
    executor,
    nativeTakeoverForSend,
    message,
    nextConversation
  };
}

async function runSend(options) {
  const messageBody = required(options.message ?? options.request, "--message is required");
  if (options.agentHardTimeoutMinutes !== undefined) {
    positiveMinutes(options.agentHardTimeoutMinutes, "--agent-hard-timeout-minutes");
  }
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    if (!options.background) {
      throw new Error(
        "raw tmux terminal sends require --background so AKK can persist and monitor the submission safely"
      );
    }
    const releaseTerminalLock = acquireFileLock(
      terminalBridgeSendLockPath(
        storeDirFromOptions(options),
        terminalConversation.terminalControl
      ),
      { timeoutMs: 30000 }
    );
    let releaseStateLock: (() => void) | undefined;
    try {
      const managed = createManagedTerminalConversationFromRawId({
        options,
        conversationId: terminalConversation.conversationId,
        agent: terminalConversation.agent,
        pid: terminalConversation.pid,
        messageBody,
        terminalControl: terminalConversation.terminalControl
      });
      ensureDir(path.dirname(managed.statePath));
      releaseStateLock = acquireFileLock(`${managed.statePath}.lock`);
      await runTerminalControlSend({
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        statePath: managed.statePath,
        logPath: managed.logPath,
        executor: managed.executor,
        message: managed.message,
        terminalControl: terminalConversation.terminalControl,
        terminalSendLockHeld: true,
        terminalStateLockHeld: true,
        recordMessageAfterSend: true,
        recordRawAttachmentAfterSend: true
      });
    } finally {
      try {
        releaseStateLock?.();
      } finally {
        releaseTerminalLock();
      }
    }
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const migratedConversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const migratedTakeover = isRecord(migratedConversation.native_session_takeover)
    ? migratedConversation.native_session_takeover
    : undefined;
  const migratedTerminalControl = terminalControlFromTakeover(migratedTakeover);
  if (migratedTerminalControl) {
    const releaseTerminalLock = acquireFileLock(
      terminalBridgeSendLockPath(storeDirFromOptions(options), migratedTerminalControl),
      { timeoutMs: 30000 }
    );
    let releaseStateLock: (() => void) | undefined;
    try {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
      const prepared = prepareManagedSend({
        options,
        statePath,
        logPath,
        messageBody,
        stateLockHeld: true,
        persist: false
      });
      const currentTerminalControl = terminalControlFromTakeover(
        prepared.nativeTakeoverForSend
      );
      if (
        !currentTerminalControl ||
        currentTerminalControl.kind !== migratedTerminalControl.kind ||
        currentTerminalControl.target !== migratedTerminalControl.target ||
        currentTerminalControl.socketPath !== migratedTerminalControl.socketPath ||
        currentTerminalControl.panePid !== migratedTerminalControl.panePid
      ) {
        throw new Error(
          "terminal control changed while waiting to send; refresh status and retry"
        );
      }
      await runTerminalControlSend({
        options,
        conversation: prepared.conversation,
        nextConversation: prepared.nextConversation,
        statePath,
        logPath,
        executor: prepared.executor,
        message: prepared.message,
        terminalControl: currentTerminalControl,
        terminalSendLockHeld: true,
        terminalStateLockHeld: true,
        recordMessageAfterSend: true
      });
    } finally {
      try {
        releaseStateLock?.();
      } finally {
        releaseTerminalLock();
      }
    }
    return;
  }
  throw new Error(
    `conversation ${migratedConversation.conversation_id} is not attached to a live tmux terminal`
  );
}

async function runApprove(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    await runTerminalConversationApprove({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      terminalControl: terminalConversation.terminalControl,
      pid: terminalConversation.pid
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl) {
    throw new Error(`conversation ${conversation.conversation_id} is not controlled through a terminal`);
  }
  if (!["waiting_for_agent", "waiting_for_openclaw"].includes(conversation.status)) {
    throw new Error(
      `cannot approve ${conversation.conversation_id}; conversation is ${conversation.status}`
    );
  }

  const executor = executorForConversation(conversation);
  const monitoredApproval = isRecord(nativeTakeover?.["terminal_bridge_approval"])
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const suppliedExpectedFingerprint = stringValue(options.expectedApprovalFingerprint);
  const expectedFingerprint = suppliedExpectedFingerprint ??
    stringValue(monitoredApproval?.fingerprint);
  const autoApproved = options.autoApproved === true;
  const claudeScreenApproval = executor.kind === "claude";
  if (claudeScreenApproval) {
    const monitoredState = isRecord(monitoredApproval?.approval_state)
      ? monitoredApproval.approval_state
      : undefined;
    const pendingDispatch = isRecord(
      nativeTakeover?.terminal_bridge_approval_dispatch
    )
      ? nativeTakeover.terminal_bridge_approval_dispatch
      : undefined;
    const lastApprovalFingerprint = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_fingerprint
    );
    const lastApprovalMessageId = stringValue(
      nativeTakeover?.terminal_bridge_last_approval_message_id
    );
    const currentMessageId = stringValue(
      nativeTakeover?.terminal_bridge_message_id
    );
    const approvalResolvedAt = validTimestampMs(
      nativeTakeover?.terminal_bridge_approval_resolved_at
    );
    if (
      autoApproved &&
      monitoredApproval === undefined &&
      pendingDispatch === undefined &&
      conversation.status === "waiting_for_agent" &&
      suppliedExpectedFingerprint !== undefined &&
      suppliedExpectedFingerprint === lastApprovalFingerprint &&
      lastApprovalMessageId !== undefined &&
      lastApprovalMessageId === currentMessageId &&
      approvalResolvedAt !== undefined
    ) {
      const monitor = ensureTerminalBridgeMonitorAfterApproval({
        conversation,
        statePath,
        logPath,
        terminalControl,
        options,
        reason: "approval_already_resolved"
      });
      printJson({
        conversation,
        approved: false,
        already_approved: true,
        blocked: false,
        reason: "Claude screen approval fingerprint was already consumed",
        terminal_control: terminalControl,
        monitor_pid: monitor.monitorPid ?? null,
        monitor_handoff_pid: monitor.handoffWatchdog?.pid ?? null
      });
      return;
    }
    const notifiedAt = validTimestampMs(monitoredApproval?.notified_at);
    if (
      conversation.status !== "waiting_for_openclaw" ||
      monitoredState?.decision_mode !== "keys" ||
      !stringValue(monitoredApproval?.fingerprint)
    ) {
      printJson({
        conversation,
        approved: false,
        blocked: true,
        reason: "Claude screen approval requires a current managed-turn approval notification",
        terminal_control: terminalControl
      });
      return;
    }
    if (
      notifiedAt === undefined ||
      Date.now() - notifiedAt > CLAUDE_SCREEN_APPROVAL_TTL_MS
    ) {
      printJson({
        conversation,
        approved: false,
        blocked: true,
        reason: "Claude screen approval expired; inspect and resolve the terminal manually",
        terminal_control: terminalControl
      });
      return;
    }
    if (
      !suppliedExpectedFingerprint ||
      expectedFingerprint !== monitoredApproval?.fingerprint
    ) {
      printJson({
        conversation,
        approved: false,
        blocked: true,
        reason: "Claude screen approval requires the latest notified fingerprint",
        terminal_control: terminalControl
      });
      return;
    }
    if (
      pendingDispatch?.state === "reserved" &&
      pendingDispatch.terminal_bridge_message_id ===
        nativeTakeover?.terminal_bridge_message_id
    ) {
      printJson({
        conversation,
        approved: false,
        blocked: true,
        reason: "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually",
        terminal_control: terminalControl
      });
      return;
    }
    if (
      expectedFingerprint ===
      stringValue(nativeTakeover?.terminal_bridge_last_approval_fingerprint)
    ) {
      printJson({
        conversation,
        approved: false,
        blocked: true,
        reason: "Claude screen approval fingerprint was already consumed",
        terminal_control: terminalControl
      });
      return;
    }
  }
  const policyRuleId = stringValue(options.policyRuleId);
  const policyFingerprint = stringValue(options.policyFingerprint);
  const autoApprovalPolicy = autoApproved
    ? parseJsonOption(options.autoApprovalPolicyJson, "--auto-approval-policy-json")
    : undefined;
  const runtimeIdentity = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  let executorPolicyDecision;
  const policyCandidateForInspection = ({
    agent,
    currentTerminalControl,
    inspection,
    fingerprint
  }): ApprovalCandidate => {
    const evidence = inspection.approval.approvable
      ? inspection.approval.policyEvidence
      : undefined;
    return {
      agent,
      kind: evidence?.kind ?? inspection.approval.promptKind ?? "unknown",
      decisionMode: inspection.approval.approvable
        ? inspection.approval.action.mode ?? "keys"
        : undefined,
      command: evidence?.command ?? inspection.approval.command,
      cwd: evidence?.cwd ?? inspection.approval.cwd ?? currentTerminalControl.currentPath,
      fingerprint: fingerprint ?? "",
      terminalTarget: currentTerminalControl.target,
      ...(evidence?.source === "claude_transcript"
        ? {
            evidenceSource: "claude_transcript" as const,
            evidenceFingerprint: evidence.evidenceFingerprint
          }
        : {})
    };
  };
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  let terminalLockReleased = false;
  const releaseApprovalTerminalLock = () => {
    if (!terminalLockReleased) {
      terminalLockReleased = true;
      releaseTerminalLock();
    }
  };
  let releaseStateLock: (() => void) | undefined;
  const releaseApprovalStateLock = () => {
    if (releaseStateLock) {
      const release = releaseStateLock;
      releaseStateLock = undefined;
      release();
    }
  };
  try {
    let approval;
    let lockedConversation = conversation;
    const currentConversation = loadState(statePath);
    const currentTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    const currentApproval = isRecord(currentTakeover?.terminal_bridge_approval)
      ? currentTakeover.terminal_bridge_approval
      : undefined;
    if (
      currentConversation.status !== conversation.status ||
      currentTakeover?.terminal_bridge_message_id !== nativeTakeover?.terminal_bridge_message_id ||
      currentControl?.target !== terminalControl.target ||
      currentControl?.socketPath !== terminalControl.socketPath ||
      (
        claudeScreenApproval &&
        currentApproval?.fingerprint !== monitoredApproval?.fingerprint
      )
    ) {
      throw new Error("approval state changed while waiting for terminal control; refresh status and retry");
    }
    assertManagedTerminalDispatchOwner({
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "approve"
    });
    lockedConversation = currentConversation;
    approval = await createTerminalAgentBridge(options).approve(
      executor.kind,
      terminalControl,
      {
        expectedFingerprint,
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: runtimeIdentity,
        managedRequest: terminalDurableRequestForConversation(
          currentConversation,
          terminalControl
        ),
        requiredDecisionMode:
          autoApproved && executor.kind === "claude" ? "keys" : undefined,
        authorize: autoApproved
          ? ({ agent, terminalControl: currentTerminalControl, inspection, fingerprint }) => {
              if (!autoApprovalPolicy) {
                return {
                  approved: false,
                  reason: "automatic approval requires an executor-side policy"
                };
              }
              const candidate = policyCandidateForInspection({
                agent,
                currentTerminalControl,
                inspection,
                fingerprint
              });
              executorPolicyDecision = evaluateApprovalPolicy({
                policy: autoApprovalPolicy,
                candidate
              });
              if (executorPolicyDecision.action !== "approve") {
                return {
                  approved: false,
                  reason: `executor-side auto-approval policy rejected the current request: ${executorPolicyDecision.reason}`
                };
              }
              if (policyRuleId && executorPolicyDecision.ruleId !== policyRuleId) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval rule changed before execution"
                };
              }
              if (
                policyFingerprint &&
                executorPolicyDecision.policyFingerprint !== policyFingerprint
              ) {
                return {
                  approved: false,
                  reason: "executor-side auto-approval policy changed before execution"
                };
              }
              return { approved: true };
            }
          : undefined,
        beforeKeyDispatch: claudeScreenApproval
          ? ({ fingerprint, terminalControl: dispatchControl, inspection, keys }) => {
              if (autoApproved) {
                if (!autoApprovalPolicy) {
                  throw new Error(
                    "automatic approval requires an executor-side policy before dispatch"
                  );
                }
                const freshPolicyDecision = evaluateApprovalPolicy({
                  policy: autoApprovalPolicy,
                  candidate: policyCandidateForInspection({
                    agent: executor.kind,
                    currentTerminalControl: dispatchControl,
                    inspection,
                    fingerprint
                  })
                });
                if (freshPolicyDecision.action !== "approve") {
                  throw new Error(
                    `executor-side auto-approval policy rejected the recaptured request: ${freshPolicyDecision.reason}`
                  );
                }
                if (
                  executorPolicyDecision?.ruleId &&
                  freshPolicyDecision.ruleId !== executorPolicyDecision.ruleId
                ) {
                  throw new Error(
                    "executor-side auto-approval rule changed after recapture"
                  );
                }
                if (policyRuleId && freshPolicyDecision.ruleId !== policyRuleId) {
                  throw new Error(
                    "executor-side auto-approval rule changed before dispatch"
                  );
                }
                if (
                  policyFingerprint &&
                  freshPolicyDecision.policyFingerprint !== policyFingerprint
                ) {
                  throw new Error(
                    "executor-side auto-approval policy changed before dispatch"
                  );
                }
                executorPolicyDecision = freshPolicyDecision;
              }
              if (releaseStateLock) {
                throw new Error("Claude approval dispatch was already reserved");
              }
              releaseStateLock = acquireFileLock(`${statePath}.lock`);
              const latestConversation = loadState(statePath);
              const latestTakeover = isRecord(latestConversation.native_session_takeover)
                ? latestConversation.native_session_takeover
                : undefined;
              const latestControl = terminalControlFromTakeover(latestTakeover);
              const latestApproval = isRecord(latestTakeover?.terminal_bridge_approval)
                ? latestTakeover.terminal_bridge_approval
                : undefined;
              const latestNotifiedAt = validTimestampMs(latestApproval?.notified_at);
              const latestApprovalState = isRecord(latestApproval?.approval_state)
                ? latestApproval.approval_state
                : undefined;
              const latestPolicyEvidence = isRecord(latestApprovalState?.policy_evidence)
                ? latestApprovalState.policy_evidence
                : undefined;
              const recapturedPolicyEvidence = inspection.approval.approvable
                ? inspection.approval.policyEvidence
                : undefined;
              const latestDispatch = isRecord(
                latestTakeover?.terminal_bridge_approval_dispatch
              )
                ? latestTakeover.terminal_bridge_approval_dispatch
                : undefined;
              if (
                !latestTakeover ||
                latestConversation.status !== "waiting_for_openclaw" ||
                latestTakeover.terminal_bridge_message_id !==
                  nativeTakeover?.terminal_bridge_message_id ||
                latestApproval?.fingerprint !== fingerprint ||
                latestNotifiedAt === undefined ||
                Date.now() - latestNotifiedAt > CLAUDE_SCREEN_APPROVAL_TTL_MS ||
                expectedFingerprint !== fingerprint ||
                latestControl?.target !== dispatchControl.target ||
                latestControl?.socketPath !== dispatchControl.socketPath ||
                (
                  autoApproved &&
                  (
                    latestPolicyEvidence?.source !== "claude_transcript" ||
                    latestPolicyEvidence.evidence_fingerprint !==
                      recapturedPolicyEvidence?.evidenceFingerprint
                  )
                )
              ) {
                throw new Error(
                  "approval state changed before terminal dispatch; refresh status and retry"
                );
              }
              if (
                latestDispatch?.state === "reserved" &&
                latestDispatch.terminal_bridge_message_id ===
                  latestTakeover.terminal_bridge_message_id
              ) {
                throw new Error(
                  "a previous Claude approval dispatch has an uncertain outcome; inspect and resolve the terminal manually"
                );
              }
              const reservedAt = new Date().toISOString();
              const reservedConversation = {
                ...latestConversation,
                native_session_takeover: {
                  ...latestTakeover,
                  terminal_bridge_approval_dispatch: {
                    state: "reserved",
                    attempt_id: randomUUID(),
                    fingerprint,
                    keys,
                    terminal_target: dispatchControl.target,
                    terminal_bridge_message_id:
                      latestTakeover.terminal_bridge_message_id,
                    reserved_at: reservedAt
                  }
                },
                updated_at: reservedAt
              };
              saveState(statePath, reservedConversation);
              lockedConversation = reservedConversation;
            }
          : undefined
      }
    );
    const actualFingerprint = approval.fingerprint;
    const effectivePolicyRuleId = executorPolicyDecision?.ruleId ?? policyRuleId;
    const effectivePolicyFingerprint =
      executorPolicyDecision?.policyFingerprint ?? policyFingerprint;
    if (!approval.approved) {
      releaseApprovalStateLock();
      releaseApprovalTerminalLock();
      if (autoApproved) {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_auto_approval_decision",
          action: "rejected",
          reason: approval.reason,
          terminal_control: terminalControl,
          expected_fingerprint: expectedFingerprint,
          actual_fingerprint: actualFingerprint,
          policy_rule_id: effectivePolicyRuleId,
          policy_fingerprint: effectivePolicyFingerprint
        });
      }
      printJson({
        conversation,
        approved: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        expected_approval_fingerprint: expectedFingerprint,
        actual_approval_fingerprint: actualFingerprint,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_approval_send",
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    if (autoApproved) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_auto_approval_decision",
        action: "approved",
        terminal_control: terminalControl,
        approval_fingerprint: actualFingerprint,
        policy_rule_id: effectivePolicyRuleId,
        policy_fingerprint: effectivePolicyFingerprint
      });
    }
    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint
    });
    const nativeTakeoverForUpdate: Record<string, unknown> = isRecord(lockedConversation.native_session_takeover)
      ? { ...lockedConversation.native_session_takeover }
      : {};
    const resolvedApproval = isRecord(
      nativeTakeoverForUpdate.terminal_bridge_approval
    )
      ? nativeTakeoverForUpdate.terminal_bridge_approval
      : undefined;
    const resolvedApprovalScreenDigest = stringValue(
      resolvedApproval?.screen_digest
    );
    const resolvedApprovalState = isRecord(resolvedApproval?.approval_state)
      ? resolvedApproval.approval_state
      : undefined;
    const resolvedTranscriptIdentity =
      claudeTranscriptApprovalIdentity(resolvedApprovalState);
    const approvalResolvedAt = new Date().toISOString();
    const agentTimeoutMinutes = Number(
      options.agentTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_inactivity_timeout_minutes ??
        DEFAULT_AGENT_TIMEOUT_MINUTES
    );
    const agentHardTimeoutMinutes = positiveMinutes(
      options.agentHardTimeoutMinutes ??
        nativeTakeoverForUpdate.terminal_bridge_hard_timeout_minutes ??
        DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      "--agent-hard-timeout-minutes"
    );
    const nextNativeTakeover: Record<string, unknown> = {
      ...nativeTakeoverForUpdate,
      terminal_bridge_approval: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_approval_resolved_at: approvalResolvedAt,
      terminal_bridge_last_approval_fingerprint: actualFingerprint,
      terminal_bridge_last_approval_screen_digest:
        resolvedApprovalScreenDigest,
      terminal_bridge_last_approval_request_id:
        resolvedTranscriptIdentity?.requestId,
      terminal_bridge_last_approval_evidence_fingerprint:
        resolvedTranscriptIdentity?.evidenceFingerprint,
      terminal_bridge_last_approval_prompt_cleared_at: undefined,
      terminal_bridge_last_approval_at: approvalResolvedAt,
      terminal_bridge_last_approval_message_id:
        nativeTakeoverForUpdate.terminal_bridge_message_id,
      terminal_bridge_monitor_lock_version: TERMINAL_BRIDGE_MONITOR_LOCK_VERSION,
      terminal_bridge_monitor_started_at: approvalResolvedAt,
      terminal_bridge_last_activity_at: approvalResolvedAt,
      terminal_bridge_last_activity_reason: "approval resolved",
      terminal_bridge_inactivity_timeout_minutes: agentTimeoutMinutes,
      terminal_bridge_hard_timeout_minutes: agentHardTimeoutMinutes,
      terminal_bridge_inactivity_deadline_at: deadlineAt(approvalResolvedAt, agentTimeoutMinutes),
      terminal_bridge_hard_deadline_at: deadlineAt(
        stringValue(nativeTakeoverForUpdate.terminal_bridge_started_at) ?? approvalResolvedAt,
        agentHardTimeoutMinutes
      )
    };
    delete nextNativeTakeover.terminal_bridge_approval;
    delete nextNativeTakeover.terminal_bridge_approval_dispatch;
    delete nextNativeTakeover.terminal_bridge_last_approval_prompt_cleared_at;
    const nextConversation = {
      ...lockedConversation,
      status: terminalBridgeEnabled(lockedConversation)
        ? "waiting_for_agent" as const
        : lockedConversation.status,
      native_session_takeover: nextNativeTakeover,
      updated_at: approvalResolvedAt
    };
    saveState(statePath, nextConversation);
    releaseApprovalStateLock();
    releaseApprovalTerminalLock();

    const bridgeMonitor = ensureTerminalBridgeMonitorAfterApproval({
      conversation: nextConversation,
      statePath,
      logPath,
      terminalControl,
      options
    });

    printJson({
      conversation: nextConversation,
      approved: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId,
      approval_fingerprint: actualFingerprint,
      auto_approved: autoApproved,
      policy_rule_id: effectivePolicyRuleId,
      policy_fingerprint: effectivePolicyFingerprint,
      monitor_pid: bridgeMonitor.monitorPid ?? null,
      monitor_handoff_pid: bridgeMonitor.handoffWatchdog?.pid ?? null
    });
  } finally {
    try {
      releaseApprovalStateLock();
    } finally {
      releaseApprovalTerminalLock();
    }
  }
}

async function runTerminalConversationApprove({ options, conversationId, agent, terminalControl, pid }) {
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  try {
    if (agent === "claude") {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: true,
        reason: "Claude screen approval requires `send --background` so AKK can bind it to an active managed turn",
        terminal_control: terminalControl
      });
      return;
    }
    const approval = await createTerminalAgentBridge(options).approve(agent, terminalControl, {
      expectedFingerprint: stringValue(options.expectedApprovalFingerprint),
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime: {
        pid,
        cwd: terminalControl.currentPath,
        conversationId,
        terminalTarget: terminalControl.target
      }
    });
    if (!approval.approved) {
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        approved: false,
        blocked: approval.blocked,
        reason: approval.reason,
        terminal_control: terminalControl,
        screen_excerpt: approval.screenExcerpt
      });
      return;
    }

    runtimeLog("info", "terminal_approval_send", {
      conversation_id: conversationId,
      agent,
      terminal_target: terminalControl.target,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId
    });

    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      approved: true,
      terminal_control: terminalControl,
      key: approval.key,
      keys: approval.keys,
      label: approval.label,
      approval_fingerprint: approval.fingerprint,
      decision_mode: approval.decisionMode,
      request_id: approval.requestId
    });
  } finally {
    releaseTerminalLock();
  }
}

async function runTerminalControlSend({
  options,
  conversation,
  nextConversation,
  statePath,
  logPath,
  executor,
  message,
  terminalControl,
  terminalSendLockHeld = false,
  terminalStateLockHeld = false,
  recordMessageAfterSend = false,
  recordRawAttachmentAfterSend = false
}) {
  const bridge = terminalBridgeEnabled(conversation);
  if (!terminalSendLockHeld) {
    const releaseTerminalLock = acquireFileLock(
      terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
      { timeoutMs: 30000 }
    );
    try {
      return await runTerminalControlSend({
        options,
        conversation,
        nextConversation,
        statePath,
        logPath,
        executor,
        message,
        terminalControl,
        terminalSendLockHeld: true,
        terminalStateLockHeld,
        recordMessageAfterSend,
        recordRawAttachmentAfterSend
      });
    } finally {
      releaseTerminalLock();
    }
  }
  if (bridge && !terminalStateLockHeld) {
    const releaseStateLock = acquireFileLock(`${statePath}.lock`);
    try {
      const currentConversation = loadState(statePath);
      const currentTakeover = isRecord(currentConversation.native_session_takeover)
        ? currentConversation.native_session_takeover
        : undefined;
      const currentControl = terminalControlFromTakeover(currentTakeover);
      if (
        currentConversation.conversation_id !== nextConversation.conversation_id ||
        currentConversation.updated_at !== nextConversation.updated_at ||
        currentConversation.status !== nextConversation.status ||
        currentConversation.response_rounds_used !== nextConversation.response_rounds_used ||
        currentControl?.target !== terminalControl.target ||
        currentControl?.socketPath !== terminalControl.socketPath
      ) {
        throw new Error(
          "conversation changed while waiting to send to the terminal; refresh status and retry"
        );
      }
      return await runTerminalControlSend({
        options,
        conversation: currentConversation,
        nextConversation: currentConversation,
        statePath,
        logPath,
        executor,
        message,
        terminalControl,
        terminalSendLockHeld: true,
        terminalStateLockHeld: true,
        recordMessageAfterSend,
        recordRawAttachmentAfterSend
      });
    } finally {
      releaseStateLock();
    }
  }

  const terminalBridge = createTerminalAgentBridge(options);
  const bridgeStartedAt = new Date().toISOString();
  const agentTimeoutMinutes = Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES);
  const agentHardTimeoutMinutes = positiveMinutes(
    options.agentHardTimeoutMinutes ?? DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
    "--agent-hard-timeout-minutes"
  );
  const terminalPayload = terminalSubmissionPayload(String(message.body ?? ""));
  const terminalRequestHash =
    terminalBridgeRequestFingerprint(terminalPayload);
  let previousDispatchLedger =
    resolveTerminalDispatchLedgerPaneIncarnation(
      terminalControl,
      loadTerminalBridgeDispatchLedger(terminalControl)
    );
  previousDispatchLedger =
    reconcilePreparedTerminalDispatchLedger(
      terminalControl,
      previousDispatchLedger
    );
  if (
    previousDispatchLedger?.status === "prepared" ||
    previousDispatchLedger?.status === "uncertain"
  ) {
    throw new Error(
      `terminal ${terminalControl.target} has a terminal-level ` +
      `${String(previousDispatchLedger.status)} dispatch owned by ` +
      `${stringValue(previousDispatchLedger.conversation_id) ?? "an unknown conversation"}; ` +
      "inspect the shared tmux pane and explicitly close that AKK conversation before retrying"
    );
  }
  if (previousDispatchLedger?.status === "submitted") {
    const owner = loadTerminalDispatchLedgerOwner(
      previousDispatchLedger
    );
    if (!owner) {
      throw new Error(
        `terminal ${terminalControl.target} has a submitted dispatch whose ` +
        "owner state is unavailable; inspect the shared tmux pane and repair " +
        "or explicitly resolve that conversation before sending another task"
      );
    }
    if (!TERMINAL_DISPATCH_RELEASE_STATUSES.has(owner.status)) {
      if (
        stringValue(previousDispatchLedger.request_hash) ===
        terminalRequestHash
      ) {
        const receiptConversationId =
          stringValue(previousDispatchLedger.conversation_id) ??
          owner.conversation_id;
        const receiptMessageId =
          stringValue(previousDispatchLedger.message_id) ??
          message.id;
        printJson({
          conversation: owner,
          message: {
            ...message,
            id: receiptMessageId,
            conversation_id: receiptConversationId
          },
          delivered: true,
          status: "async_pending",
          background: true,
          callback_expected: Boolean(
            owner.gateway_method ??
              previousDispatchLedger.callback_expected
          ),
          terminal_control: terminalControl,
          executor,
          replayed: true,
          delivery_receipt: "submitted",
          reason:
            "AKK replayed the durable receipt for an identical active terminal request and did not send tmux input again.",
          openclaw_next_action: openClawYieldNextAction({
            conversationId: receiptConversationId,
            source: "terminal_control",
            callbackExpected: Boolean(
              owner.gateway_method ??
                previousDispatchLedger.callback_expected
            )
          })
        });
        return;
      }
      throw new Error(
        `terminal ${terminalControl.target} is still owned by active AKK ` +
        `conversation ${owner.conversation_id} (${owner.status}); wait for ` +
        "its callback, cancel it, or explicitly close it before sending a " +
        "different task"
      );
    }
  }
  if (bridge) {
    assertNoUnresolvedTerminalBridgeSubmission(
      storeDirFromOptions(options),
      terminalControl,
      conversation.conversation_id,
      terminalPayload
    );
  }
  const preSendRuntime: TerminalRuntimeIdentity = {
    ...terminalRuntimeIdentityForConversation(nextConversation, terminalControl),
    messageId: message.id
  };
  let preSendScreenFingerprint: string | undefined;
  let claudeTranscriptAnchor: ClaudeTranscriptAnchor | undefined;
  const claudeHome = executor.kind === "claude"
    ? path.resolve(expandHome(options.claudeHome) ?? defaultClaudeHome())
    : undefined;
  try {
    const status = await terminalBridge.status(executor.kind, terminalControl, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      runtime: preSendRuntime
    });
    assertSafeTerminalSend(executor.kind, status);
    if (bridge) {
      preSendScreenFingerprint = stringValue(status.screen.digest) ??
        terminalBridgeScreenFingerprint(status.screen.excerpt);
      if (executor.kind === "claude") {
        claudeTranscriptAnchor = captureClaudeTranscriptAnchor({
          sessionId: preSendRuntime.sessionId,
          cwd: preSendRuntime.cwd,
          pid: preSendRuntime.pid,
          claudeHome,
          agentRows: loadClaudeAgentRows(options)
        });
        if (!claudeTranscriptAnchor) {
          throw new Error(
            "the completion monitor could not bind an owner-private Claude transcript boundary"
          );
        }
      }
    }
  } catch (error) {
    throw new Error(
      `refusing to send to ${executor.display_name} without a verified idle terminal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const bridgeConversation = bridge
    ? withTerminalBridgeState({
        conversation: nextConversation,
        message,
        requestText: terminalPayload,
        startedAt: bridgeStartedAt,
        agentTimeoutMinutes,
        agentHardTimeoutMinutes,
        preSendScreenFingerprint,
        claudeTranscriptAnchor,
        claudeHome
      })
    : nextConversation;
  const preparedConversation = withTerminalBridgeSubmission({
    conversation: bridgeConversation,
    messageId: message.id,
    requestText: terminalPayload,
    status: "prepared",
    preparedAt: bridgeStartedAt
  });

  saveTerminalBridgeDispatchLedger(terminalControl, {
    status: "prepared",
    generation_id: message.id,
    conversation_id: preparedConversation.conversation_id,
    message_id: message.id,
    request_hash: terminalRequestHash,
    prepared_at: bridgeStartedAt,
    dispatcher_pid: process.pid,
    state_path: statePath,
    event_log_path: logPath,
    callback_expected: Boolean(preparedConversation.gateway_method),
    previous_generation_id:
      stringValue(previousDispatchLedger?.generation_id) ??
      stringValue(previousDispatchLedger?.message_id)
  });
  try {
    saveState(statePath, preparedConversation);
  } catch (error) {
    restoreTerminalBridgeDispatchLedger({
      terminalControl,
      previousLedger: previousDispatchLedger,
      reason: "prepared state persistence failed before tmux input"
    });
    throw error;
  }
  let bridgeMonitor:
    | ReturnType<typeof startTerminalBridgeMonitorForConversation>
    | undefined;
  try {
    if (
      process.env.AKK_TEST_TERMINAL_SETUP_FAILURE === "1"
    ) {
      throw new Error(
        "injected terminal setup failure before tmux input"
      );
    }
    if (recordRawAttachmentAfterSend) {
      const sourceConversationId = stringValue(
        isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover.native_session_id
          : undefined
      );
      appendEvent(logPath, {
        ts: bridgeStartedAt,
        conversation_id: conversation.conversation_id,
        event: "raw_terminal_session_attached",
        source_conversation_id: sourceConversationId,
        agent: executor.kind,
        terminal_control: terminalControl,
        executor
      });
      runtimeLog("info", "raw_terminal_session_attached", {
        conversation_id: conversation.conversation_id,
        source_conversation_id: sourceConversationId,
        terminal_target: terminalControl.target,
        state_path: statePath,
        event_log_path: logPath
      });
    }
    if (recordMessageAfterSend) {
      appendEvent(logPath, messageEvent(message));
      runtimeLog("info", "message_created", {
        conversation_id: conversation.conversation_id,
        agent: executor.kind,
        executor_session: executor.session,
        message_type: message.type,
        state_path: statePath,
        event_log_path: logPath,
        message: textSummary(message.body)
      });
    }
    appendEvent(logPath, {
      ts: bridgeStartedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_message_submit_prepared",
      message_id: message.id,
      executor,
      terminal_control: terminalControl,
      request_hash: terminalBridgeRequestFingerprint(terminalPayload),
      dispatcher_pid: process.pid
    });

    bridgeMonitor = bridge
      ? startTerminalBridgeMonitorForConversation({
          conversation: preparedConversation,
          statePath,
          logPath,
          options
        })
      : undefined;
    if (bridgeMonitor) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: preparedConversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: bridgeMonitor.pid ?? null,
        terminal_control: terminalControl,
        phase: "before_terminal_submit",
        agent_timeout_minutes: agentTimeoutMinutes,
        agent_hard_timeout_minutes: agentHardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_launch", {
        conversation_id: preparedConversation.conversation_id,
        monitor_pid: bridgeMonitor.pid ?? null,
        terminal_target: terminalControl.target,
        phase: "before_terminal_submit"
      });
    }
  } catch (error) {
    const abortedAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    let dispatchLedgerRestored = true;
    try {
      restoreTerminalBridgeDispatchLedger({
        terminalControl,
        previousLedger: previousDispatchLedger,
        reason: "terminal submission aborted before tmux input"
      });
    } catch (ledgerError) {
      dispatchLedgerRestored = false;
      runtimeLog("error", "terminal_dispatch_ledger_restore_failed", {
        conversation_id: conversation.conversation_id,
        terminal_target: terminalControl.target,
        error: ledgerError instanceof Error
          ? ledgerError.message
          : String(ledgerError)
      });
    }
    const failureBase = recordRawAttachmentAfterSend
      ? {
          ...preparedConversation,
          status: "failed" as const,
          failed_at: abortedAt,
          failure_reason:
            "terminal submission setup failed before tmux input"
        }
      : conversation;
    const abortedConversation = withTerminalBridgeSubmission({
      conversation: failureBase,
      messageId: message.id,
      requestText: terminalPayload,
      status: "aborted",
      preparedAt: bridgeStartedAt,
      abortedAt,
      error: errorMessage
    });
    try {
      saveState(statePath, abortedConversation);
      appendEvent(logPath, {
        ts: abortedAt,
        conversation_id: abortedConversation.conversation_id,
        event: "terminal_message_submit_aborted",
        message_id: message.id,
        executor,
        terminal_control: terminalControl,
        error: textSummary(errorMessage),
        safe_to_retry: dispatchLedgerRestored
      });
    } catch (persistenceError) {
      runtimeLog("error", "terminal_message_submit_aborted_persist_failed", {
        conversation_id: abortedConversation.conversation_id,
        terminal_target: terminalControl.target,
        error: persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError)
      });
    }
    runtimeLog("error", "terminal_message_submit_aborted", {
      conversation_id: abortedConversation.conversation_id,
      terminal_target: terminalControl.target,
      error: errorMessage,
      safe_to_retry: dispatchLedgerRestored
    });
    printJson({
      conversation: abortedConversation,
      message,
      delivered: false,
      status: "submission_aborted",
      submission_outcome: "aborted",
      background: true,
      callback_expected: false,
      terminal_control: terminalControl,
      monitor_pid: bridgeMonitor?.pid ?? null,
      executor,
      safe_to_retry: dispatchLedgerRestored,
      do_not_retry: !dispatchLedgerRestored,
      reason: dispatchLedgerRestored
        ? "AKK failed before touching tmux; this terminal submission was not sent and may be retried."
        : "AKK failed before tmux input but could not restore the terminal dispatch ledger; inspect and close the conversation before retrying.",
      openclaw_next_action: {
        action: dispatchLedgerRestored ? "retry" : "inspect",
        conversation_id: abortedConversation.conversation_id,
        safe_to_retry: dispatchLedgerRestored,
        do_not_retry: !dispatchLedgerRestored,
        reason: dispatchLedgerRestored
          ? "The failure occurred before any tmux input."
          : "The terminal ledger could not be restored automatically."
      }
    });
    return;
  }

  let deliveredConversation;
  try {
    await terminalBridge.send(executor.kind, terminalControl, terminalPayload, {
      runtime: preSendRuntime
    });
    const submittedAt = new Date().toISOString();
    deliveredConversation = withTerminalBridgeSubmission({
      conversation: preparedConversation,
      messageId: message.id,
      requestText: terminalPayload,
      status: "submitted",
      preparedAt: bridgeStartedAt,
      submittedAt
    });
    saveState(statePath, deliveredConversation);
    saveTerminalBridgeDispatchLedger(terminalControl, {
      status: "submitted",
      generation_id: message.id,
      conversation_id: deliveredConversation.conversation_id,
      message_id: message.id,
      request_hash: terminalRequestHash,
      prepared_at: bridgeStartedAt,
      submitted_at: submittedAt,
      dispatcher_pid: process.pid,
      state_path: statePath,
      event_log_path: logPath,
      callback_expected: Boolean(deliveredConversation.gateway_method),
      previous_generation_id:
        stringValue(previousDispatchLedger?.generation_id) ??
        stringValue(previousDispatchLedger?.message_id)
    });
  } catch (error) {
    const uncertainAt = new Date().toISOString();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const failureBase =
      !recordRawAttachmentAfterSend && terminalBridgeEnabled(conversation)
        ? conversation
        : preparedConversation;
    const stalledFailureBase = {
      ...failureBase,
      status: "stalled" as const,
      stalled_at: uncertainAt,
      stalled_reason:
        "terminal submission outcome is uncertain; inspect the shared tmux pane before continuing",
      updated_at: uncertainAt
    };
    const uncertainConversation = withTerminalBridgeSubmission({
      conversation: stalledFailureBase,
      messageId: message.id,
      requestText: terminalPayload,
      status: "uncertain",
      preparedAt: bridgeStartedAt,
      uncertainAt,
      error: errorMessage
    });
    try {
      saveTerminalBridgeDispatchLedger(terminalControl, {
        status: "uncertain",
        generation_id: message.id,
        conversation_id: uncertainConversation.conversation_id,
        message_id: message.id,
        request_hash: terminalRequestHash,
        prepared_at: bridgeStartedAt,
        uncertain_at: uncertainAt,
        dispatcher_pid: process.pid,
        state_path: statePath,
        event_log_path: logPath,
        callback_expected: Boolean(uncertainConversation.gateway_method),
        error: textSummary(errorMessage),
        previous_generation_id:
          stringValue(previousDispatchLedger?.generation_id) ??
          stringValue(previousDispatchLedger?.message_id)
      });
      saveState(statePath, uncertainConversation);
      appendEvent(logPath, {
        ts: uncertainAt,
        conversation_id: uncertainConversation.conversation_id,
        event: "terminal_message_submit_uncertain",
        message_id: message.id,
        executor,
        terminal_control: terminalControl,
        error: textSummary(errorMessage),
        do_not_retry: true
      });
    } catch (persistenceError) {
      runtimeLog("error", "terminal_message_submit_uncertain_persist_failed", {
        conversation_id: uncertainConversation.conversation_id,
        terminal_target: terminalControl.target,
        error: persistenceError instanceof Error
          ? persistenceError.message
          : String(persistenceError)
      });
    }
    const stalledConversationIds =
      stallOtherTerminalBridgeConversationsForUncertainDispatch({
        storeDir: storeDirFromOptions(options),
        terminalControl,
        currentConversationId: uncertainConversation.conversation_id,
        uncertainMessageId: message.id
      });
    runtimeLog("error", "terminal_message_submit_uncertain", {
      conversation_id: uncertainConversation.conversation_id,
      agent: executor.kind,
      terminal_target: terminalControl.target,
      error: errorMessage,
      do_not_retry: true,
      stalled_conversation_ids: stalledConversationIds
    });
    printJson({
      conversation: uncertainConversation,
      message,
      delivered: false,
      status: "submission_uncertain",
      submission_outcome: "uncertain",
      background: true,
      callback_expected: Boolean(uncertainConversation.gateway_method),
      terminal_control: terminalControl,
      monitor_pid: bridgeMonitor?.pid ?? null,
      executor,
      do_not_retry: true,
      stalled_conversation_ids: stalledConversationIds,
      reason:
        "AKK durably recorded the terminal submission, but could not prove whether tmux accepted Enter. Do not retry automatically; inspect this conversation and pane.",
      openclaw_next_action: {
        action: "inspect",
        conversation_id: uncertainConversation.conversation_id,
        do_not_retry: true,
        reason:
          "The terminal submission outcome is uncertain. Inspect AKK status and the shared tmux pane before deciding whether to close or continue."
      }
    });
    return;
  }

  let bookkeepingWarning: string | undefined;
  try {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_message_send",
      executor,
      terminal_control: terminalControl,
      message: textSummary(message.body),
      payload: textSummary(terminalPayload)
    });
    runtimeLog("info", "terminal_message_send", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      terminal_target: terminalControl.target,
      message: textSummary(message.body),
      payload: textSummary(terminalPayload)
    });
  } catch (error) {
    bookkeepingWarning =
      error instanceof Error ? error.message : String(error);
    runtimeLog("warn", "terminal_message_post_submit_bookkeeping_failed", {
      conversation_id: deliveredConversation.conversation_id,
      terminal_target: terminalControl.target,
      error: bookkeepingWarning,
      delivered: true
    });
    try {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: deliveredConversation.conversation_id,
        event: "terminal_message_post_submit_bookkeeping_failed",
        terminal_control: terminalControl,
        error: textSummary(bookkeepingWarning),
        delivered: true
      });
    } catch {
      // The durable submitted receipt remains authoritative even if the event log is unavailable.
    }
  }
  printJson({
    conversation: deliveredConversation,
    message,
    delivered: true,
    status: "async_pending",
    background: true,
    callback_expected: Boolean(deliveredConversation.gateway_method),
    terminal_control: terminalControl,
    monitor_pid: bridgeMonitor?.pid ?? null,
    executor,
    budget: budgetAction(deliveredConversation),
    delivery_receipt: "submitted",
    ...(bookkeepingWarning
      ? {
          bookkeeping_warning: textSummary(bookkeepingWarning)
        }
      : {}),
    openclaw_next_action: openClawYieldNextAction({
      conversationId: deliveredConversation.conversation_id,
      source: "terminal_control",
      callbackExpected: Boolean(deliveredConversation.gateway_method)
    })
  });
}

function terminalSubmissionPayload(payload: string): string {
  return payload.trimEnd();
}

function createManagedTerminalConversationFromRawId({
  options,
  conversationId,
  agent,
  pid,
  messageBody,
  terminalControl
}) {
  const workspace = terminalControl.currentPath ?? process.cwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const executor = resolveExecutor({
    kind: agent,
    session: conversationId
  });
  const now = new Date();
  const conversation = createConversation({
    userRequest: String(messageBody),
    workspace,
    openclawSession: options.openclawSession ?? "agent:main:main",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100),
    now
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const claudeAgent = agent === "claude"
    ? loadClaudeAgentRows(options).find((row) => row.pid === pid)
    : undefined;
  const attachedConversation = withStoragePaths({
    ...conversation,
    executor,
    status: "idle" as const,
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    gateway_url: options.gatewayUrl ?? "ws://127.0.0.1:18789",
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? options.openclawSession ?? "agent:main:main",
    openclaw_bin: options.openclawBin ?? resolveOptionalExecutable("openclaw"),
    native_session_takeover: {
      agent,
      native_session_id: conversationId,
      terminal_agent_pid: pid,
      terminal_agent_session_id: claudeAgent?.sessionId,
      source_cwd: workspace,
      source_title: `Terminal-controlled ${executor.display_name} ${terminalControl.target}`,
      strategy: "terminal_control",
      attached_at: now.toISOString(),
      takeover_match_kind: "raw_terminal_send",
      terminal_control: terminalControl,
      needs_bootstrap: false,
      terminal_bridge: true
    }
  }, paths);
  const message = createMessage({
    conversation: attachedConversation,
    from: "openclaw",
    to: executor.actor,
    type: options.type ?? "task",
    body: String(messageBody),
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session,
      source_conversation_id: conversationId
    }
  });
  const nextConversation = applyMessageToConversation(attachedConversation, message);
  return {
    conversation: attachedConversation,
    nextConversation,
    statePath: paths.statePath,
    logPath: paths.logPath,
    executor,
    message
  };
}

function openClawYieldNextAction({ conversationId, source, callbackExpected }) {
  const callbackText = callbackExpected
    ? "The coding agent should report completion, questions, or errors through the existing Agent Knock Knock callback for this conversation."
    : "No AKK-managed callback is registered for this raw terminal-controlled id; do not wait synchronously. Use AKK status/list later or attach/create an AKK conversation when callback delivery is required.";
  return {
    action: "yield",
    reason:
      "The follow-up was handed off asynchronously. End this OpenClaw turn now instead of waiting, polling, or treating the send as a synchronous agent result.",
    source,
    conversation_id: conversationId,
    callback_expected: callbackExpected,
    do_not:
      "Do not inspect event logs, process lists, terminal screens, files, stdout, or stderr while waiting unless the user explicitly asks for status.",
    expected_callback: callbackText
  };
}

async function runRenew(options) {
  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  if (conversation.status === "closed") {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is closed`);
  }
  if (conversation.status !== "stalled") {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is ${conversation.status}, not stalled`);
  }

  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl || nativeTakeover?.["terminal_bridge"] !== true) {
    throw new Error(`cannot renew ${conversation.conversation_id}; conversation is not a terminal bridge task`);
  }

  const panes = await createTerminalControlProvider(options).listPanes();
  const terminalExists = panes.some((pane) =>
    pane.target === terminalControl.target &&
    (terminalControl.socketPath === undefined || pane.socketPath === terminalControl.socketPath)
  );
  if (!terminalExists) {
    throw new Error(`cannot renew ${conversation.conversation_id}; terminal ${terminalControl.target} is no longer available`);
  }

  const expectedMessageId = stringValue(nativeTakeover?.terminal_bridge_message_id);
  const expectedStartedAt = stringValue(nativeTakeover?.terminal_bridge_started_at);
  let renewed = conversation;
  let renewedTerminalControl = terminalControl;
  let inactivityTimeoutMinutes = 0;
  let hardTimeoutMinutes = 0;
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const current = loadState(statePath);
    if (current.status !== "stalled") {
      throw new Error(
        `cannot renew ${current.conversation_id}; conversation is ${current.status}, not stalled`
      );
    }
    const currentTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (!currentControl || currentTakeover?.terminal_bridge !== true) {
      throw new Error(
        `cannot renew ${current.conversation_id}; conversation is not a terminal bridge task`
      );
    }
    if (
      current.conversation_id !== conversation.conversation_id ||
      currentControl.target !== terminalControl.target ||
      currentControl.socketPath !== terminalControl.socketPath ||
      currentControl.panePid !== terminalControl.panePid ||
      stringValue(currentTakeover.terminal_bridge_message_id) !== expectedMessageId ||
      stringValue(currentTakeover.terminal_bridge_started_at) !== expectedStartedAt
    ) {
      throw new Error(
        "conversation changed while waiting to renew; refresh status and retry"
      );
    }

    renewedTerminalControl = currentControl;
    inactivityTimeoutMinutes = positiveMinutes(
      options.minutes ??
        options.agentTimeoutMinutes ??
        currentTakeover.terminal_bridge_inactivity_timeout_minutes ??
        DEFAULT_AGENT_TIMEOUT_MINUTES,
      "--minutes"
    );
    hardTimeoutMinutes = positiveMinutes(
      currentTakeover.terminal_bridge_hard_timeout_minutes ??
        DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
      "--agent-hard-timeout-minutes"
    );
    const startedAt = stringValue(currentTakeover.terminal_bridge_started_at);
    const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
    if (
      Number.isFinite(startedAtMs) &&
      Date.now() - startedAtMs >= hardTimeoutMinutes * 60 * 1000
    ) {
      throw new Error(
        `cannot renew ${current.conversation_id}; terminal bridge hard lifetime of ${hardTimeoutMinutes} minutes has elapsed`
      );
    }

    const now = new Date().toISOString();
    const hardDeadline = deadlineAt(startedAt ?? now, hardTimeoutMinutes) ??
      new Date(Date.now() + hardTimeoutMinutes * 60 * 1000).toISOString();
    const inactivityDeadline = deadlineAt(now, inactivityTimeoutMinutes) ??
      new Date(Date.now() + inactivityTimeoutMinutes * 60 * 1000).toISOString();
    renewed = {
      ...current,
      status: "waiting_for_agent" as const,
      native_session_takeover: {
        ...currentTakeover,
        terminal_bridge_monitor_lock_version: TERMINAL_BRIDGE_MONITOR_LOCK_VERSION,
        terminal_bridge_monitor_started_at: now,
        terminal_bridge_last_activity_at: now,
        terminal_bridge_inactivity_timeout_minutes: inactivityTimeoutMinutes,
        terminal_bridge_hard_timeout_minutes: hardTimeoutMinutes,
        terminal_bridge_inactivity_deadline_at: inactivityDeadline,
        terminal_bridge_hard_deadline_at: hardDeadline,
        terminal_bridge_renewed_at: now
      },
      updated_at: now
    };
    Reflect.deleteProperty(renewed, "stalled_at");
    Reflect.deleteProperty(renewed, "stalled_reason");
    Reflect.deleteProperty(renewed, "stalled_notification_sent_at");
    Reflect.deleteProperty(renewed, "stalled_notification_message_id");
    saveState(statePath, renewed);
    appendEvent(logPath, {
      ts: now,
      conversation_id: current.conversation_id,
      event: "terminal_bridge_renewed",
      previous_status: current.status,
      terminal_control: currentControl,
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes,
      last_activity_at: now
    });
    runtimeLog("info", "terminal_bridge_renewed", {
      conversation_id: current.conversation_id,
      terminal_target: currentControl.target,
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes
    });
  } finally {
    releaseStateLock();
  }

  const monitor = startTerminalBridgeMonitorForConversation({
    conversation: renewed,
    statePath,
    logPath,
    options: {
      ...options,
      agentTimeoutMinutes: inactivityTimeoutMinutes,
      agentHardTimeoutMinutes: hardTimeoutMinutes
    }
  });
  if (monitor) {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: renewed.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: monitor.pid ?? null,
      terminal_control: renewedTerminalControl,
      reason: "renewal",
      agent_timeout_minutes: inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: hardTimeoutMinutes
    });
  }

  printJson({
    conversation: renewed,
    renewed: true,
    terminal_control: renewedTerminalControl,
    agent_timeout_minutes: inactivityTimeoutMinutes,
    agent_hard_timeout_minutes: hardTimeoutMinutes,
    monitor_pid: monitor?.pid ?? null
  });
}

async function runReconcileMonitors(options) {
  const storeDir = storeDirFromOptions(options);
  const conversations = listConversations(storeDir);
  const items: Record<string, unknown>[] = [];
  let ignored = 0;
  let launched = 0;
  let alreadyRunning = 0;
  let skipped = 0;
  let errors = 0;

  for (const listedConversation of conversations) {
    if (
      !matchesConfiguredWorkspace(
        options.workspace,
        listedConversation.workspace
      )
    ) {
      ignored += 1;
      continue;
    }
    const statePath = expandHome(
      stringValue(listedConversation.state_path) ??
        statePathForConversationId(listedConversation.conversation_id, storeDir)
    );
    const logPath = expandHome(
      stringValue(listedConversation.event_log_path) ??
        logPathForStatePath(statePath)
    );

    try {
      const callbackRecovery = prepareCallbackDeliveryReconciliation({
        statePath,
        logPath,
        delayMs: options.callbackRetryDelayMs
      });
      if (callbackRecovery.handled) {
        if (callbackRecovery.status === "launched") {
          launched += 1;
        } else if (callbackRecovery.status === "already_running") {
          alreadyRunning += 1;
        } else {
          skipped += 1;
        }
        items.push({
          conversation_id: callbackRecovery.conversationId,
          status: callbackRecovery.status,
          reason: callbackRecovery.reason,
          ...(callbackRecovery.monitorPid === undefined
            ? {}
            : { monitor_pid: callbackRecovery.monitorPid })
        });
        continue;
      }

      const listedNativeTakeover = isRecord(listedConversation.native_session_takeover)
        ? listedConversation.native_session_takeover
        : undefined;
      if (listedNativeTakeover?.terminal_bridge !== true) {
        ignored += 1;
        continue;
      }

      const initialConversation = await migrateLegacyTerminalAgentIdentity({
        conversation: loadState(statePath),
        statePath,
        logPath,
        options
      });
      const initialEligibility = terminalBridgeReconciliationEligibility(initialConversation);
      if (!initialEligibility.eligible) {
        skipped += 1;
        items.push({
          conversation_id: initialConversation.conversation_id,
          status: "skipped",
          reason: initialEligibility.reason
        });
        continue;
      }

      const activeOwner = activeTerminalBridgeMonitorOwner(
        statePath,
        initialEligibility.terminalMessageId
      );
      if (activeOwner) {
        alreadyRunning += 1;
        items.push({
          conversation_id: initialConversation.conversation_id,
          status: "already_running",
          reason: "monitor_lock_owner_alive",
          monitor_owner_pid: activeOwner.ownerPid ?? null
        });
        continue;
      }

      const monitorLockVersion = Number(
        initialEligibility.nativeTakeover.terminal_bridge_monitor_lock_version
      );
      if (monitorLockVersion !== TERMINAL_BRIDGE_MONITOR_LOCK_VERSION) {
        if (Number.isFinite(monitorLockVersion)) {
          skipped += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "skipped",
            reason: "monitor_lock_version_unsupported",
            monitor_lock_version: monitorLockVersion
          });
          continue;
        }

        const legacyLaunchPid = latestTerminalBridgeMonitorLaunchPid(logPath);
        if (legacyLaunchPid === undefined) {
          skipped += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "skipped",
            reason: "legacy_monitor_ownership_unknown"
          });
          continue;
        }
        if (isProcessAlive(legacyLaunchPid)) {
          alreadyRunning += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "already_running",
            reason: "legacy_monitor_launch_pid_alive",
            monitor_owner_pid: legacyLaunchPid
          });
          continue;
        }
      }

      const prepared = prepareTerminalBridgeMonitorReconciliation({
        statePath,
        expectedMessageId: initialEligibility.terminalMessageId
      });
      if (!prepared.prepared) {
        if (prepared.alreadyRunning) {
          alreadyRunning += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "already_running",
            reason: prepared.reason,
            monitor_owner_pid: prepared.ownerPid ?? null
          });
        } else {
          skipped += 1;
          items.push({
            conversation_id: initialConversation.conversation_id,
            status: "skipped",
            reason: prepared.reason
          });
        }
        continue;
      }

      const monitor = startTerminalBridgeMonitorForConversation({
        conversation: prepared.conversation,
        statePath,
        logPath,
        options
      });
      if (!monitor) {
        skipped += 1;
        items.push({
          conversation_id: prepared.conversation.conversation_id,
          status: "skipped",
          reason: "terminal_bridge_monitor_launch_disabled"
        });
        continue;
      }

      const launchedAt = new Date().toISOString();
      appendEvent(logPath, {
        ts: launchedAt,
        conversation_id: prepared.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: prepared.terminalControl,
        reason: "startup_reconciliation",
        agent_timeout_minutes: prepared.inactivityTimeoutMinutes,
        agent_hard_timeout_minutes: prepared.hardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_reconciled", {
        conversation_id: prepared.conversation.conversation_id,
        monitor_pid: monitor.pid ?? null,
        terminal_target: prepared.terminalControl.target
      });
      launched += 1;
      items.push({
        conversation_id: prepared.conversation.conversation_id,
        status: "launched",
        reason: "startup_reconciliation",
        monitor_pid: monitor.pid ?? null
      });
    } catch (error) {
      errors += 1;
      items.push({
        conversation_id: listedConversation.conversation_id,
        status: "error",
        reason: error instanceof Error ? error.message : String(error)
      });
    }
  }

  printJson({
    reconciled: true,
    store_dir: storeDir,
    checked: conversations.length,
    ignored,
    launched,
    already_running: alreadyRunning,
    skipped,
    errors,
    items
  });
}

function prepareCallbackDeliveryReconciliation({
  statePath,
  logPath,
  delayMs
}: {
  statePath: string;
  logPath: string;
  delayMs?: unknown;
}) {
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const preservesConversationStatus =
      callbackDelivery?.preserve_conversation_status === true;
    if (
      !preservesConversationStatus &&
      !["callback_pending", "callback_failed"].includes(conversation.status)
    ) {
      return {
        handled: false as const
      };
    }

    const conversationId = stringValue(conversation.conversation_id) ?? "unknown";
    const attempts = Number(callbackDelivery?.attempts ?? 0);
    if (
      !["pending", "failed"].includes(String(callbackDelivery?.status ?? "")) ||
      !isRecord(callbackDelivery?.message)
    ) {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: "callback_delivery_metadata_missing"
      };
    }
    if (!isRetryableCallbackDelivery(conversation, callbackDelivery)) {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: "callback_delivery_in_flight"
      };
    }
    if (!Number.isSafeInteger(attempts) || attempts < 1 ||
        attempts > CALLBACK_RETRY_DELAYS_MS.length) {
      return {
        handled: true as const,
        conversationId,
        status: "skipped",
        reason: "callback_delivery_retries_exhausted"
      };
    }

    const configuredDelayMs = Number(delayMs);
    const retryDelayMs = Number.isFinite(configuredDelayMs) &&
      configuredDelayMs >= 0
      ? configuredDelayMs
      : CALLBACK_RETRY_DELAYS_MS[Math.max(0, attempts - 1)];
    const retryMonitor = startCallbackRetryMonitor({
      statePath,
      delayMs: retryDelayMs
    });
    const launchedAt = new Date().toISOString();
    const nextAttemptAt = new Date(Date.now() + retryDelayMs).toISOString();
    const nextConversation = {
      ...conversation,
      callback_delivery: {
        ...callbackDelivery,
        retry_monitor_pid: retryMonitor.pid ?? null,
        next_attempt_at: nextAttemptAt
      },
      updated_at: launchedAt
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: launchedAt,
      conversation_id: conversationId,
      event: "callback_retry_monitor_launched",
      message_id: callbackDelivery.message.id,
      pid: retryMonitor.pid ?? null,
      next_attempt_at: nextAttemptAt,
      reason: "startup_reconciliation"
    });
    return {
      handled: true as const,
      conversationId,
      status: "launched",
      reason: "callback_delivery_reconciliation",
      monitorPid: retryMonitor.pid
    };
  } finally {
    releaseStateLock();
  }
}

function terminalBridgeReconciliationEligibility(conversation) {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (nativeTakeover?.terminal_bridge !== true) {
    return { eligible: false as const, reason: "not_terminal_bridge" };
  }
  if (!conversation.gateway_method) {
    return { eligible: false as const, reason: "gateway_method_missing" };
  }
  if (!stringValue(conversation.gateway_session) && !stringValue(conversation.openclaw_session)) {
    return { eligible: false as const, reason: "gateway_session_missing" };
  }
  if (!isWaitingForAgent(conversation.status)) {
    return {
      eligible: false as const,
      reason: `conversation_status_${String(conversation.status ?? "missing")}`
    };
  }

  const terminalMessageId = stringValue(nativeTakeover.terminal_bridge_message_id);
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalMessageId || !terminalControl) {
    return { eligible: false as const, reason: "terminal_bridge_identity_missing" };
  }
  const dispatchLedger =
    loadTerminalBridgeDispatchLedger(terminalControl);
  if (
    dispatchLedger &&
    (
      stringValue(dispatchLedger.message_id) !== terminalMessageId ||
      !["prepared", "submitted"].includes(
        String(dispatchLedger.status)
      )
    )
  ) {
    return {
      eligible: false as const,
      reason: `terminal_dispatch_${String(
        dispatchLedger.status ?? "generation_replaced"
      )}`
    };
  }
  const submission = terminalBridgeSubmission(conversation);
  if (
    stringValue(submission?.message_id) === terminalMessageId &&
    (submission?.status === "uncertain" || submission?.status === "aborted")
  ) {
    return {
      eligible: false as const,
      reason: `terminal_submission_${submission.status}`
    };
  }
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  if (!Number.isInteger(runtime.pid) || Number(runtime.pid) <= 0 || !stringValue(runtime.cwd)) {
    return { eligible: false as const, reason: "terminal_agent_identity_missing" };
  }

  const inactivityTimeoutMinutes = Number(
    nativeTakeover.terminal_bridge_inactivity_timeout_minutes
  );
  const hardTimeoutMinutes = Number(nativeTakeover.terminal_bridge_hard_timeout_minutes);
  const startedAtMs = validTimestampMs(nativeTakeover.terminal_bridge_started_at);
  const lastActivityAtMs = validTimestampMs(nativeTakeover.terminal_bridge_last_activity_at);
  const inactivityDeadlineAtMs = validTimestampMs(
    nativeTakeover.terminal_bridge_inactivity_deadline_at
  );
  const hardDeadlineAtMs = validTimestampMs(nativeTakeover.terminal_bridge_hard_deadline_at);
  if (
    !Number.isFinite(inactivityTimeoutMinutes) ||
    inactivityTimeoutMinutes <= 0 ||
    !Number.isFinite(hardTimeoutMinutes) ||
    hardTimeoutMinutes <= 0 ||
    startedAtMs === undefined ||
    lastActivityAtMs === undefined ||
    inactivityDeadlineAtMs === undefined ||
    hardDeadlineAtMs === undefined
  ) {
    return { eligible: false as const, reason: "terminal_bridge_deadline_metadata_missing" };
  }

  return {
    eligible: true as const,
    nativeTakeover,
    terminalMessageId,
    terminalControl,
    runtime,
    inactivityTimeoutMinutes,
    hardTimeoutMinutes,
    inactivityDeadlineAtMs,
    hardDeadlineAtMs
  };
}

function latestTerminalBridgeMonitorLaunchPid(logPath: string): number | undefined {
  let events;
  try {
    events = readExistingEvents(logPath);
  } catch {
    return undefined;
  }
  const launch = [...events].reverse().find((event) =>
    event.event === "terminal_bridge_monitor_launch"
  );
  const pid = Number(launch?.pid);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

function prepareTerminalBridgeMonitorReconciliation({
  statePath,
  expectedMessageId,
  requireWaitingForAgentStatus = false
}: {
  statePath: string;
  expectedMessageId: string;
  requireWaitingForAgentStatus?: boolean;
}) {
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    if (
      requireWaitingForAgentStatus &&
      conversation.status !== "waiting_for_agent"
    ) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: `conversation_status_${String(
          conversation.status ?? "missing"
        )}`
      };
    }
    const eligibility = terminalBridgeReconciliationEligibility(conversation);
    if (!eligibility.eligible) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: eligibility.reason
      };
    }
    if (eligibility.terminalMessageId !== expectedMessageId) {
      return {
        prepared: false as const,
        alreadyRunning: false,
        reason: "terminal_bridge_task_replaced"
      };
    }

    const activeOwner = activeTerminalBridgeMonitorOwner(
      statePath,
      eligibility.terminalMessageId
    );
    if (activeOwner) {
      return {
        prepared: false as const,
        alreadyRunning: true,
        reason: "monitor_lock_owner_alive",
        ownerPid: activeOwner.ownerPid
      };
    }

    const nextNativeTakeover = {
      ...eligibility.nativeTakeover,
      terminal_bridge_monitor_lock_version: TERMINAL_BRIDGE_MONITOR_LOCK_VERSION
    };
    const needsSave =
      eligibility.nativeTakeover.terminal_bridge_monitor_lock_version !==
        TERMINAL_BRIDGE_MONITOR_LOCK_VERSION;
    const preparedConversation = needsSave
      ? {
          ...conversation,
          native_session_takeover: nextNativeTakeover,
          updated_at: new Date().toISOString()
        }
      : conversation;
    if (needsSave) {
      saveState(statePath, preparedConversation);
    }
    return {
      prepared: true as const,
      conversation: preparedConversation,
      terminalControl: eligibility.terminalControl,
      inactivityTimeoutMinutes: eligibility.inactivityTimeoutMinutes,
      hardTimeoutMinutes: eligibility.hardTimeoutMinutes
    };
  } finally {
    releaseStateLock();
  }
}

function positiveMinutes(value, optionName: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${optionName} must be a positive number`);
  }
  return parsed;
}

async function runCancel(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    await runTerminalConversationCancel({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      terminalControl: terminalConversation.terminalControl,
      pid: terminalConversation.pid
    });
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  if (!["waiting_for_agent", "waiting_for_openclaw"].includes(conversation.status)) {
    throw new Error(`cannot cancel ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (terminalControl) {
    await runTerminalControlCancel({
      options,
      statePath,
      logPath,
      agent: executorForConversation(conversation).kind,
      terminalControl
    });
    return;
  }

  throw new Error(
    `conversation ${conversation.conversation_id} is not attached to a live tmux terminal`
  );
}

async function runTerminalConversationCancel({ options, conversationId, agent, terminalControl, pid }) {
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  try {
    const cancellation = await createTerminalAgentBridge(options).cancel(agent, terminalControl, {
      runtime: {
        pid,
        cwd: terminalControl.currentPath,
        terminalTarget: terminalControl.target
      },
      scrollbackLines: Number(options.scrollbackLines ?? 120)
    });
    runtimeLog("info", "terminal_cancel_requested", {
      conversation_id: conversationId,
      agent,
      terminal_target: terminalControl.target,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId,
      cancel_requested: cancellation.cancelRequested,
      reason: cancellation.reason
    });

    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      cancel_requested: cancellation.cancelRequested,
      reason: cancellation.reason,
      terminal_control: terminalControl,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId
    });
  } finally {
    releaseTerminalLock();
  }
}

async function runTerminalControlCancel({ options, statePath, logPath, agent, terminalControl }) {
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  let releaseStateLock: (() => void) | undefined;
  try {
    releaseStateLock = acquireFileLock(`${statePath}.lock`);
    const currentConversation = loadState(statePath);
    if (!["waiting_for_agent", "waiting_for_openclaw"].includes(currentConversation.status)) {
      throw new Error(
        `cannot cancel ${currentConversation.conversation_id}; conversation is ${currentConversation.status}`
      );
    }
    const currentTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : undefined;
    const currentControl = terminalControlFromTakeover(currentTakeover);
    if (
      !currentControl ||
      currentControl.target !== terminalControl.target ||
      currentControl.socketPath !== terminalControl.socketPath
    ) {
      throw new Error(
        "terminal control changed while waiting to cancel; refresh status and retry"
      );
    }
    assertManagedTerminalDispatchOwner({
      conversation: currentConversation,
      terminalControl: currentControl,
      action: "cancel"
    });

    const cancellation = await createTerminalAgentBridge(options).cancel(agent, currentControl, {
      runtime: terminalRuntimeIdentityForConversation(currentConversation, currentControl),
      scrollbackLines: Number(options.scrollbackLines ?? 120)
    });
    if (!cancellation.cancelRequested) {
      printJson({
        conversation: currentConversation,
        cancel_requested: false,
        reason: cancellation.reason,
        terminal_control: currentControl,
        budget: budgetAction(currentConversation)
      });
      return;
    }

    const now = new Date().toISOString();
    appendEvent(logPath, {
      ts: now,
      conversation_id: currentConversation.conversation_id,
      event: "terminal_cancel_requested",
      terminal_control: currentControl,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId
    });
    runtimeLog("info", "terminal_cancel_requested", {
      conversation_id: currentConversation.conversation_id,
      agent,
      terminal_target: currentControl.target,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId
    });

    const nextConversation = {
      ...currentConversation,
      status: "cancelled" as const,
      cancelled_at: now,
      terminal_cancel_requested_at: now,
      updated_at: now
    };
    saveState(statePath, nextConversation);

    printJson({
      conversation: nextConversation,
      cancel_requested: true,
      terminal_control: currentControl,
      key: cancellation.key,
      keys: cancellation.keys,
      denied_approval: cancellation.deniedApproval,
      request_id: cancellation.requestId,
      budget: budgetAction(nextConversation)
    });
  } finally {
    try {
      releaseStateLock?.();
    } finally {
      releaseTerminalLock();
    }
  }
}

async function runClose(options) {
  const terminalConversation =
    await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    runTerminalDispatchClose({
      options,
      terminalConversation
    });
    return;
  }
  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const nativeTakeover = isRecord(loaded.conversation.native_session_takeover)
    ? loaded.conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  const releaseTerminalLock = terminalControl
    ? acquireFileLock(
        terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
        { timeoutMs: 30000 }
      )
    : () => {};
  let releaseStateLock: (() => void) | undefined;
  try {
    releaseStateLock = acquireFileLock(`${statePath}.lock`);
    const conversation = loadState(statePath);
    const now = new Date().toISOString();
    const closed = {
      ...conversation,
      status: "closed" as const,
      closed_at: now,
      close_reason: options.reason ?? "closed by request",
      updated_at: now
    };
    saveState(statePath, closed);
    let dispatchLedgerResolved = false;
    let dispatchLedgerWarning: string | undefined;
    if (terminalControl) {
      try {
        dispatchLedgerResolved = resolveTerminalBridgeDispatchLedger({
          terminalControl,
          conversation: closed,
          expectedMessageId: stringValue(
            nativeTakeover?.terminal_bridge_message_id
          ),
          reason: "conversation explicitly closed by request"
        });
      } catch (error) {
        dispatchLedgerWarning =
          error instanceof Error ? error.message : String(error);
        runtimeLog("error", "terminal_dispatch_ledger_resolve_failed", {
          conversation_id: closed.conversation_id,
          terminal_target: terminalControl.target,
          error: dispatchLedgerWarning
        });
      }
    }
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: closed.close_reason
    });
    runtimeLog("info", "conversation_closed", {
      conversation_id: conversation.conversation_id,
      status: "closed",
      reason: closed.close_reason,
      state_path: statePath,
      event_log_path: logPath
    });
    printJson({
      conversation: closed,
      closed: true,
      terminal_dispatch_resolved: dispatchLedgerResolved,
      ...(dispatchLedgerWarning
        ? {
            terminal_dispatch_warning:
              textSummary(dispatchLedgerWarning),
            do_not_retry: true
          }
        : {})
    });
  } finally {
    try {
      releaseStateLock?.();
    } finally {
      releaseTerminalLock();
    }
  }
}

function runTerminalDispatchClose({
  options,
  terminalConversation
}: {
  options: Record<string, any>;
  terminalConversation: ResolvedTerminalConversation;
}): void {
  const terminalControl = terminalConversation.terminalControl;
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(
      storeDirFromOptions(options),
      terminalControl
    ),
    { timeoutMs: 30000 }
  );
  try {
    const ledger = resolveTerminalDispatchLedgerPaneIncarnation(
      terminalControl,
      loadTerminalBridgeDispatchLedger(terminalControl)
    );
    if (!ledger || ledger.status === "resolved") {
      throw new Error(
        `terminal ${terminalControl.target} has no unresolved AKK dispatch fence`
      );
    }
    if (!["prepared", "submitted", "uncertain"].includes(ledger.status)) {
      throw new Error(
        `terminal ${terminalControl.target} has an invalid dispatch status: ` +
        String(ledger.status)
      );
    }
    const owner = loadTerminalDispatchLedgerOwner(ledger);
    if (owner) {
      throw new Error(
        `terminal ${terminalControl.target} dispatch is owned by AKK ` +
        `conversation ${owner.conversation_id} (${owner.status}); close that ` +
        "managed conversation instead"
      );
    }
    const expectedMessageId = required(
      stringValue(options.expectedMessageId),
      "--expected-message-id is required to resolve an orphaned terminal dispatch"
    );
    const ownerMessageId = stringValue(ledger.message_id);
    if (!ownerMessageId || expectedMessageId !== ownerMessageId) {
      throw new Error(
        "terminal dispatch identity changed; run AKK list again and use the " +
        "current orphaned dispatch message id"
      );
    }
    const resolvedAt = new Date().toISOString();
    const reason =
      stringValue(options.reason) ??
      "terminal dispatch explicitly resolved after operator inspection";
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: resolvedAt,
      reason,
      resolved_by_terminal_conversation_id:
        terminalConversation.conversationId
    });
    runtimeLog("info", "terminal_dispatch_explicitly_resolved", {
      terminal_target: terminalControl.target,
      terminal_conversation_id: terminalConversation.conversationId,
      owner_conversation_id:
        stringValue(ledger.conversation_id),
      owner_message_id: stringValue(ledger.message_id),
      previous_status: ledger.status,
      reason
    });
    printJson({
      source: "terminal_control",
      conversation_id: terminalConversation.conversationId,
      terminal_control: terminalControl,
      closed: false,
      terminal_dispatch_resolved: true,
      previous_dispatch_status: ledger.status,
      owner_conversation_id:
        stringValue(ledger.conversation_id),
      owner_message_id: stringValue(ledger.message_id),
      reason,
      coding_agent_stopped: false,
      tmux_pane_closed: false
    });
  } finally {
    releaseTerminalLock();
  }
}

async function runMonitor(options) {
  if (options.callbackRetry) {
    return runCallbackRetryMonitor(options);
  }
  if (options.terminalBridgeHandoff) {
    return runTerminalBridgeMonitorHandoff(options);
  }
  if (options.terminalBridge) {
    return await runTerminalBridgeMonitor(options);
  }
  throw new Error(
    "monitor requires --terminal-bridge, --terminal-bridge-handoff, or --callback-retry"
  );
}

function startCallbackRetryMonitor({
  statePath,
  delayMs = CALLBACK_RETRY_DELAYS_MS[0]
}) {
  const normalizedDelayMs = Math.max(
    0,
    Number.isFinite(Number(delayMs)) ? Number(delayMs) : CALLBACK_RETRY_DELAYS_MS[0]
  );
  const child = spawn(process.execPath, [
    new URL(import.meta.url).pathname,
    "monitor",
    "--callback-retry",
    "--state",
    statePath,
    "--callback-retry-delay-ms",
    String(normalizedDelayMs)
  ], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: environmentWithoutGatewayTokens()
  });
  child.unref();
  return child;
}

function runCallbackRetryMonitor(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const initialDelayMs = Math.max(
    0,
    Number.isFinite(Number(options.callbackRetryDelayMs))
      ? Number(options.callbackRetryDelayMs)
      : CALLBACK_RETRY_DELAYS_MS[0]
  );
  sleepSync(initialDelayMs);

  while (true) {
    const conversation = loadState(statePath);
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const attempts = Number(callbackDelivery?.attempts ?? 0);
    if (
      !callbackDelivery ||
      !isRecord(callbackDelivery.message) ||
      !["pending", "failed"].includes(String(callbackDelivery.status ?? ""))
    ) {
      return;
    }
    if (attempts > CALLBACK_RETRY_DELAYS_MS.length) {
      return;
    }
    if (!isRetryableCallbackDelivery(conversation, callbackDelivery)) {
      const attemptPidValue = Number(callbackDelivery.attempt_pid);
      const attemptPid = Number.isSafeInteger(attemptPidValue) && attemptPidValue > 0
        ? attemptPidValue
        : undefined;
      if (callbackDelivery.status === "pending" &&
          attemptPid !== undefined &&
          isProcessAlive(attemptPid)) {
        sleepSync(1000);
        continue;
      }
      return;
    }

    try {
      runCallbackTransaction({
        statePath,
        messageJson: JSON.stringify(callbackDelivery.message),
        gatewayMethod: stringValue(callbackDelivery.gateway_method) ?? conversation.gateway_method,
        gatewaySession: stringValue(callbackDelivery.gateway_session) ?? conversation.gateway_session,
        openclawSession: conversation.openclaw_session,
        openclawBin: stringValue(callbackDelivery.openclaw_bin) ?? conversation.openclaw_bin,
        gatewayUrl: stringValue(callbackDelivery.gateway_url) ?? conversation.gateway_url,
        token: conversation.gateway_token,
        closeTerminalBridgeOnDone: callbackDelivery.close_terminal_bridge_on_done === true,
        retryPending: true,
        disableCallbackRetry: true
      });
      return;
    } catch {
      // The failed attempt is persisted before the next bounded retry.
    }

    const latest = loadState(statePath);
    const latestDelivery = isRecord(latest.callback_delivery)
      ? latest.callback_delivery
      : undefined;
    const latestAttempts = Number(latestDelivery?.attempts ?? 0);
    if (
      !latestDelivery ||
      !isRecord(latestDelivery.message) ||
      !isRetryableCallbackDelivery(latest, latestDelivery) ||
      latestAttempts > CALLBACK_RETRY_DELAYS_MS.length
    ) {
      return;
    }
    const delayMs = CALLBACK_RETRY_DELAYS_MS[Math.max(0, latestAttempts - 1)];
    sleepSync(delayMs);
  }
}

function runTerminalBridgeMonitorHandoff(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const expectedMessageId = required(
    options.expectedTerminalMessageId,
    "--expected-terminal-message-id is required"
  );
  const configuredPollIntervalMs = Number(
    options.monitorHandoffPollIntervalMs
  );
  const pollIntervalMs = Math.max(
    50,
    Number.isFinite(configuredPollIntervalMs)
      ? configuredPollIntervalMs
      : 100
  );
  const handoffLockPath = terminalBridgeMonitorHandoffLockPath(
    statePath,
    expectedMessageId
  );
  let releaseHandoffLock: (() => void) | undefined;
  try {
    releaseHandoffLock = acquireFileLock(handoffLockPath, { timeoutMs: 0 });
  } catch (error) {
    if (!isRecord(error) || error.code !== "LOCK_TIMEOUT") {
      throw error;
    }
    printJson({
      monitored: false,
      terminal_bridge: true,
      handoff_watchdog: false,
      already_running: true,
      reason: "terminal_bridge_monitor_handoff_watchdog_already_running"
    });
    return;
  }

  try {
    const startedConversation = loadState(statePath);
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: startedConversation.conversation_id,
      event: "terminal_bridge_monitor_handoff_watchdog_started",
      terminal_bridge_message_id: expectedMessageId
    });
    while (true) {
      const conversation = loadState(statePath);
      const nativeTakeover = isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover
        : undefined;
      const currentMessageId = stringValue(
        nativeTakeover?.terminal_bridge_message_id
      );
      if (currentMessageId !== expectedMessageId) {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          current_terminal_bridge_message_id: currentMessageId,
          reason: "terminal_bridge_task_replaced"
        });
        return;
      }
      if (conversation.status === "waiting_for_openclaw") {
        sleepSync(pollIntervalMs);
        continue;
      }
      if (conversation.status !== "waiting_for_agent") {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          status: conversation.status,
          reason: "conversation_no_longer_waiting_for_agent"
        });
        return;
      }

      const eligibility = terminalBridgeReconciliationEligibility(conversation);
      if (!eligibility.eligible) {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: eligibility.reason
        });
        return;
      }
      const activeOwner = activeTerminalBridgeMonitorOwner(
        statePath,
        expectedMessageId
      );
      if (activeOwner) {
        sleepSync(pollIntervalMs);
        continue;
      }

      const prepared = prepareTerminalBridgeMonitorReconciliation({
        statePath,
        expectedMessageId,
        requireWaitingForAgentStatus: true
      });
      if (!prepared.prepared) {
        if (prepared.alreadyRunning) {
          sleepSync(pollIntervalMs);
          continue;
        }
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: prepared.reason
        });
        return;
      }

      const monitor = startTerminalBridgeMonitorForConversation({
        conversation: prepared.conversation,
        statePath,
        logPath,
        options
      });
      if (!monitor) {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: prepared.conversation.conversation_id,
          event: "terminal_bridge_monitor_handoff_watchdog_finished",
          terminal_bridge_message_id: expectedMessageId,
          reason: "terminal_bridge_monitor_launch_disabled"
        });
        return;
      }
      const launchedAt = new Date().toISOString();
      appendEvent(logPath, {
        ts: launchedAt,
        conversation_id: prepared.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: monitor.pid ?? null,
        terminal_control: prepared.terminalControl,
        terminal_bridge_message_id: expectedMessageId,
        reason: "approval_handoff_reconciliation",
        agent_timeout_minutes: prepared.inactivityTimeoutMinutes,
        agent_hard_timeout_minutes: prepared.hardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_handoff_reconciled", {
        conversation_id: prepared.conversation.conversation_id,
        monitor_pid: monitor.pid ?? null,
        terminal_target: prepared.terminalControl.target,
        terminal_bridge_message_id: expectedMessageId
      });
      printJson({
        conversation: prepared.conversation,
        monitored: true,
        terminal_bridge: true,
        handoff_watchdog: true,
        launched: true,
        monitor_pid: monitor.pid ?? null,
        reason: "approval_handoff_reconciliation"
      });
      return;
    }
  } finally {
    releaseHandoffLock();
  }
}

async function runTerminalBridgeMonitor(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const conversation = loadState(statePath);
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalMessageId = stringValue(nativeTakeover?.terminal_bridge_message_id) ?? "missing-message-id";
  const monitorLock = tryAcquireTerminalBridgeMonitorLock(statePath, terminalMessageId);
  if (!monitorLock.acquired) {
    runtimeLog("info", "terminal_bridge_monitor_already_running", {
      conversation_id: conversation.conversation_id,
      terminal_bridge_message_id: terminalMessageId,
      monitor_owner_pid: monitorLock.ownerPid
    });
    printJson({
      conversation,
      monitored: false,
      terminal_bridge: true,
      already_running: true,
      reason: "terminal_bridge_monitor_already_running",
      monitor_owner_pid: monitorLock.ownerPid ?? null
    });
    return;
  }

  try {
    await runTerminalBridgeMonitorWithLock(options);
  } finally {
    monitorLock.release();
  }
}

async function runTerminalBridgeMonitorWithLock(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS));

  let conversation = await migrateLegacyTerminalAgentIdentity({
    conversation: loadState(statePath),
    statePath,
    logPath,
    options
  });
  const initialNativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const timeoutMinutes = Number(
    options.agentTimeoutMinutes ??
      initialNativeTakeover?.["terminal_bridge_inactivity_timeout_minutes"] ??
      DEFAULT_AGENT_TIMEOUT_MINUTES
  );
  const hardTimeoutMinutes = positiveMinutes(
    options.agentHardTimeoutMinutes ??
      initialNativeTakeover?.["terminal_bridge_hard_timeout_minutes"] ??
      DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
    "--agent-hard-timeout-minutes"
  );
  const monitorStartedAtMs = Date.now();
  const monitorMessageId = stringValue(initialNativeTakeover?.["terminal_bridge_message_id"]);
  const taskStartedAtMs = validTimestampMs(initialNativeTakeover?.["terminal_bridge_started_at"]) ?? monitorStartedAtMs;
  let lastActivityAtMs = validTimestampMs(initialNativeTakeover?.["terminal_bridge_last_activity_at"]) ?? taskStartedAtMs;
  let lastPersistedActivityAtMs = lastActivityAtMs;
  const activityPersistIntervalMs = terminalBridgeActivityPersistIntervalMs(timeoutMinutes, pollIntervalMs);
  const preSendScreenFingerprint = stringValue(
    initialNativeTakeover?.["terminal_bridge_pre_send_screen_fingerprint"]
  );
  let previousScreenFingerprint: string | undefined = preSendScreenFingerprint;
  let previousDurableFingerprint: string | undefined;
  let persistedActivityReason = stringValue(initialNativeTakeover?.["terminal_bridge_last_activity_reason"]);
  const executor = executorForConversation(conversation);
  const terminalBridge = createTerminalAgentBridge(options);
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "terminal_bridge_monitor_started",
    executor,
    agent_timeout_minutes: timeoutMinutes,
    agent_hard_timeout_minutes: hardTimeoutMinutes,
    poll_interval_ms: pollIntervalMs,
    task_started_at: new Date(taskStartedAtMs).toISOString(),
    last_activity_at: new Date(lastActivityAtMs).toISOString(),
    inactivity_deadline_at: timeoutMinutes > 0
      ? new Date(lastActivityAtMs + timeoutMinutes * 60 * 1000).toISOString()
      : null,
    hard_deadline_at: hardTimeoutMinutes > 0
      ? new Date(taskStartedAtMs + hardTimeoutMinutes * 60 * 1000).toISOString()
      : null
  });
  runtimeLog("info", "terminal_bridge_monitor_started", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    agent_timeout_minutes: timeoutMinutes,
    agent_hard_timeout_minutes: hardTimeoutMinutes
  });

  let idleCompletionFingerprint: string | undefined;
  while (true) {
    conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "terminal_bridge_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_no_longer_waiting"
      });
      printJson({
        conversation,
        monitored: true,
        terminal_bridge: true,
        completed: false,
        reason: "conversation_no_longer_waiting"
      });
      return;
    }

    let nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const currentMessageId = stringValue(nativeTakeover?.["terminal_bridge_message_id"]);
    if (monitorMessageId && currentMessageId !== monitorMessageId) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_superseded",
        monitor_message_id: monitorMessageId,
        current_message_id: currentMessageId
      });
      printJson({
        conversation,
        monitored: true,
        terminal_bridge: true,
        completed: false,
        reason: "terminal_bridge_task_replaced"
      });
      return;
    }
    const terminalControl = terminalControlFromTakeover(nativeTakeover);
    if (!terminalControl || nativeTakeover?.["terminal_bridge"] !== true) {
      const stalledConversation = markConversationStalled({
        statePath,
        logPath,
        reason: "terminal bridge monitor could not find terminal bridge metadata",
        detail: {
          terminal_bridge: true
        }
      });
      printJson({
        conversation: stalledConversation,
        monitored: true,
        terminal_bridge: true,
        stalled: true,
        reason: stalledConversation?.stalled_reason
      });
      return;
    }
    const submission = terminalBridgeSubmission(conversation);
    if (
      currentMessageId &&
      submission &&
      stringValue(submission.message_id) === currentMessageId
    ) {
      const submissionStatus = stringValue(submission.status);
      if (submissionStatus === "prepared") {
        const dispatcherPid = Number(submission.dispatcher_pid);
        if (
          Number.isSafeInteger(dispatcherPid) &&
          dispatcherPid > 1 &&
          isProcessAlive(dispatcherPid)
        ) {
          sleepSync(pollIntervalMs);
          continue;
        }

        const releaseTerminalLock = acquireFileLock(
          terminalBridgeSendLockPath(
            storeDirFromOptions(options),
            terminalControl
          ),
          { timeoutMs: 30000 }
        );
        try {
          const dispatchLedger =
            loadTerminalBridgeDispatchLedger(terminalControl);
          const releaseStateLock = acquireFileLock(`${statePath}.lock`);
          try {
            const current = loadState(statePath);
            const currentSubmission = terminalBridgeSubmission(current);
            const currentTakeover = isRecord(current.native_session_takeover)
              ? current.native_session_takeover
              : undefined;
            const expectedMessageId = stringValue(
              currentTakeover?.terminal_bridge_message_id
            );
            if (
              expectedMessageId === currentMessageId &&
              stringValue(currentSubmission?.message_id) === currentMessageId &&
              currentSubmission?.status === "prepared"
            ) {
              const requestText = String(
                currentTakeover?.terminal_bridge_request_text ??
                  current.user_request ??
                  ""
              );
              if (
                dispatchLedger?.status === "submitted" &&
                stringValue(dispatchLedger.message_id) === currentMessageId
              ) {
                const submittedAt =
                  stringValue(dispatchLedger.submitted_at) ??
                  new Date().toISOString();
                const submittedConversation = withTerminalBridgeSubmission({
                  conversation: current,
                  messageId: currentMessageId,
                  requestText,
                  status: "submitted",
                  preparedAt:
                    stringValue(currentSubmission.prepared_at) ??
                    submittedAt,
                  submittedAt
                });
                saveState(statePath, submittedConversation);
                conversation = submittedConversation;
              } else {
                const uncertainAt = new Date().toISOString();
                const uncertainConversation = withTerminalBridgeSubmission({
                  conversation: {
                    ...current,
                    status: "stalled" as const,
                    stalled_at: uncertainAt,
                    stalled_reason:
                      "terminal dispatcher exited before AKK could prove the tmux submission",
                    updated_at: uncertainAt
                  },
                  messageId: currentMessageId,
                  requestText,
                  status: "uncertain",
                  preparedAt:
                    stringValue(currentSubmission.prepared_at) ??
                    uncertainAt,
                  uncertainAt,
                  error:
                    "the terminal dispatcher exited before AKK could persist a submitted receipt"
                });
                if (
                  !dispatchLedger ||
                  stringValue(dispatchLedger.message_id) === currentMessageId
                ) {
                  saveTerminalBridgeDispatchLedger(terminalControl, {
                    ...(dispatchLedger ?? {}),
                    status: "uncertain",
                    generation_id: currentMessageId,
                    conversation_id:
                      uncertainConversation.conversation_id,
                    message_id: currentMessageId,
                    request_hash:
                      terminalBridgeRequestFingerprint(requestText),
                    prepared_at:
                      stringValue(currentSubmission.prepared_at) ??
                      uncertainAt,
                    uncertain_at: uncertainAt,
                    dispatcher_pid:
                      Number.isSafeInteger(dispatcherPid) &&
                      dispatcherPid > 1
                        ? dispatcherPid
                        : null,
                    state_path: statePath,
                    event_log_path: logPath,
                    callback_expected: Boolean(
                      uncertainConversation.gateway_method
                    ),
                    reason:
                      "dispatcher_exited_before_submitted_receipt"
                  });
                }
                saveState(statePath, uncertainConversation);
                appendEvent(logPath, {
                  ts: uncertainAt,
                  conversation_id:
                    uncertainConversation.conversation_id,
                  event: "terminal_message_submit_uncertain",
                  message_id: currentMessageId,
                  reason:
                    "dispatcher_exited_before_submitted_receipt",
                  dispatcher_pid:
                    Number.isSafeInteger(dispatcherPid) &&
                    dispatcherPid > 1
                      ? dispatcherPid
                      : null,
                  do_not_retry: true
                });
                conversation = uncertainConversation;
              }
            } else {
              conversation = current;
            }
          } finally {
            releaseStateLock();
          }
          if (
            terminalBridgeSubmission(conversation)?.status === "uncertain"
          ) {
            stallOtherTerminalBridgeConversationsForUncertainDispatch({
              storeDir: storeDirFromOptions(options),
              terminalControl,
              currentConversationId: conversation.conversation_id,
              uncertainMessageId: currentMessageId
            });
          }
        } finally {
          releaseTerminalLock();
        }

        const afterSubmission = terminalBridgeSubmission(conversation);
        if (
          stringValue(afterSubmission?.message_id) === currentMessageId &&
          afterSubmission?.status === "submitted"
        ) {
          continue;
        }
        printJson({
          conversation,
          monitored: true,
          terminal_bridge: true,
          completed: false,
          submission_outcome:
            stringValue(afterSubmission?.status) ?? "uncertain",
          do_not_retry: true,
          reason:
            "terminal submission outcome is not proven; inspect the shared tmux pane before deciding how to continue"
        });
        return;
      }
      if (submissionStatus === "uncertain" || submissionStatus === "aborted") {
        printJson({
          conversation,
          monitored: true,
          terminal_bridge: true,
          completed: false,
          submission_outcome: submissionStatus,
          do_not_retry: submissionStatus === "uncertain",
          safe_to_retry: submissionStatus === "aborted",
          reason:
            submissionStatus === "uncertain"
              ? "terminal submission outcome is uncertain; automatic completion and approval attribution are disabled"
              : "terminal submission was aborted before tmux input"
        });
        return;
      }
      if (submissionStatus !== "submitted") {
        printJson({
          conversation,
          monitored: true,
          terminal_bridge: true,
          completed: false,
          reason: "terminal_submission_status_invalid"
        });
        return;
      }
    }
    const screenChangedSinceSend = preSendScreenFingerprint !== undefined &&
      previousScreenFingerprint !== undefined &&
      previousScreenFingerprint !== preSendScreenFingerprint;
    let poll;
    const expectedUpdatedAt = conversation.updated_at;
    const expectedStatus = conversation.status;
    const releaseTerminalPollLock = acquireFileLock(
      terminalBridgeSendLockPath(
        storeDirFromOptions(options),
        terminalControl
      ),
      { timeoutMs: 30000 }
    );
    try {
      let dispatchLedger =
        loadTerminalBridgeDispatchLedger(terminalControl);
      const durableSubmission = terminalBridgeSubmission(conversation);
      if (
        dispatchLedger?.status === "prepared" &&
        stringValue(dispatchLedger.message_id) === currentMessageId &&
        durableSubmission?.status === "submitted" &&
        stringValue(durableSubmission.message_id) === currentMessageId
      ) {
        const submittedAt =
          stringValue(durableSubmission.submitted_at) ??
          new Date().toISOString();
        saveTerminalBridgeDispatchLedger(terminalControl, {
          ...dispatchLedger,
          status: "submitted",
          submitted_at: submittedAt,
          reason:
            "recovered from the durable conversation submission receipt"
        });
        dispatchLedger =
          loadTerminalBridgeDispatchLedger(terminalControl);
      }
      if (dispatchLedger) {
        const ledgerStatus = stringValue(dispatchLedger.status);
        const ledgerMessageId = stringValue(dispatchLedger.message_id);
        if (
          ledgerStatus !== "submitted" ||
          ledgerMessageId !== currentMessageId
        ) {
          appendEvent(logPath, {
            ts: new Date().toISOString(),
            conversation_id: conversation.conversation_id,
            event: "terminal_bridge_monitor_dispatch_fenced",
            monitor_message_id: currentMessageId,
            dispatch_message_id: ledgerMessageId,
            dispatch_status: ledgerStatus
          });
          printJson({
            conversation,
            monitored: true,
            terminal_bridge: true,
            completed: false,
            submission_outcome:
              ledgerStatus === "uncertain"
                ? "uncertain"
                : undefined,
            do_not_retry: ledgerStatus === "uncertain",
            reason:
              ledgerStatus === "prepared" ||
              ledgerStatus === "uncertain"
                ? "terminal_dispatch_not_proven"
                : "terminal_bridge_generation_replaced"
          });
          return;
        }
      }

      const lockedConversation = loadState(statePath);
      const lockedTakeover = isRecord(
        lockedConversation.native_session_takeover
      )
        ? lockedConversation.native_session_takeover
        : undefined;
      const lockedControl =
        terminalControlFromTakeover(lockedTakeover);
      if (
        lockedConversation.status !== expectedStatus ||
        lockedConversation.updated_at !== expectedUpdatedAt ||
        stringValue(lockedTakeover?.terminal_bridge_message_id) !==
          currentMessageId ||
        !lockedControl ||
        terminalControlSelectorKey(lockedControl) !==
          terminalControlSelectorKey(terminalControl)
      ) {
        conversation = lockedConversation;
        continue;
      }

      const requestText = String(
        lockedTakeover?.terminal_bridge_request_text ??
          lockedConversation.user_request ??
          ""
      );
      const terminalRuntime = terminalRuntimeIdentityForConversation(
        lockedConversation,
        terminalControl
      );
      poll = await terminalBridge.monitorPoll({
        agent: executor.kind,
        terminalControl,
        screenOptions: {
          scrollbackLines: Number(options.scrollbackLines ?? 120),
          requestText,
          screenChangedSinceSend,
          runtime: terminalRuntime
        },
        durableRequest: terminalDurableRequestForConversation(
          lockedConversation,
          terminalControl
        )
      });
    } finally {
      releaseTerminalPollLock();
    }
    const terminalStatus = poll.status;
    const approval = terminalStatus.approval_state;
    const currentScreenFingerprint = stringValue(terminalStatus?.screen?.digest) ??
      terminalBridgeScreenFingerprint(terminalStatus?.screen?.excerpt);
    const currentScreenChangedSinceSend = preSendScreenFingerprint !== undefined &&
      currentScreenFingerprint !== undefined &&
      currentScreenFingerprint !== preSendScreenFingerprint;
    const currentClaudePermissionVisible =
      executor.kind === "claude" &&
      isRecord(approval) &&
      approval.blocked === true &&
      approval.prompt_kind === "claude_permission";
    const lastApprovalMessageMatches =
      currentMessageId !== undefined &&
      currentMessageId ===
      stringValue(nativeTakeover?.terminal_bridge_last_approval_message_id);
    const lastApprovalPromptCleared =
      validTimestampMs(
        nativeTakeover?.terminal_bridge_last_approval_prompt_cleared_at
      ) !== undefined;
    if (
      executor.kind === "claude" &&
      terminalStatus.reachable === true &&
      approval.scanned === true &&
      !currentClaudePermissionVisible &&
      lastApprovalMessageMatches &&
      !lastApprovalPromptCleared &&
      validTimestampMs(
        nativeTakeover?.terminal_bridge_approval_resolved_at
      ) !== undefined
    ) {
      const cleared = markTerminalBridgeApprovalPromptCleared({
        statePath,
        logPath,
        expectedConversationId: conversation.conversation_id,
        expectedMessageId: currentMessageId
      });
      if (cleared.marked) {
        conversation = cleared.conversation;
        nativeTakeover = isRecord(conversation.native_session_takeover)
          ? conversation.native_session_takeover
          : undefined;
      }
    }
    let suppressApprovalNotification = false;
    if (
      executor.kind === "claude" &&
      isRecord(approval) &&
      approval.approvable === true &&
      approval.decision_mode === "keys" &&
      !currentScreenChangedSinceSend
    ) {
      previousScreenFingerprint = currentScreenFingerprint;
      suppressApprovalNotification = true;
      runtimeLog("warn", "claude_screen_approval_not_new", {
        conversation_id: conversation.conversation_id,
        terminal_target: terminalControl.target,
        reason: "permission screen is not proven to have changed since the managed send"
      });
    }
    if (currentClaudePermissionVisible) {
      const observedFingerprint = terminalBridgeApprovalFingerprint({
        terminalControl,
        terminalStatus
      });
      const currentTranscriptIdentity =
        claudeTranscriptApprovalIdentity(approval);
      const lastApprovalRequestId = stringValue(
        nativeTakeover?.terminal_bridge_last_approval_request_id
      );
      const lastApprovalEvidenceFingerprint = stringValue(
        nativeTakeover
          ?.terminal_bridge_last_approval_evidence_fingerprint
      );
      const lastApprovalScreenDigest = stringValue(
        nativeTakeover?.terminal_bridge_last_approval_screen_digest
      );
      const sameConsumedTranscriptRequest =
        lastApprovalMessageMatches &&
        currentTranscriptIdentity !== undefined &&
        (
          (
            lastApprovalRequestId !== undefined &&
            currentTranscriptIdentity.requestId === lastApprovalRequestId
          ) ||
          (
            lastApprovalEvidenceFingerprint !== undefined &&
            currentTranscriptIdentity.evidenceFingerprint ===
              lastApprovalEvidenceFingerprint
          )
        );
      const promptClearWasObserved =
        validTimestampMs(
          nativeTakeover?.terminal_bridge_last_approval_prompt_cleared_at
        ) !== undefined;
      const sameUnrepaintedConsumedScreen =
        lastApprovalMessageMatches &&
        currentTranscriptIdentity === undefined &&
        !promptClearWasObserved &&
        lastApprovalScreenDigest !== undefined &&
        currentScreenFingerprint === lastApprovalScreenDigest;
      const consumedPromptWithoutEvidenceBeforeClear =
        lastApprovalMessageMatches &&
        currentTranscriptIdentity === undefined &&
        !promptClearWasObserved &&
        stringValue(
          nativeTakeover?.terminal_bridge_last_approval_fingerprint
        ) !== undefined;
      const legacySameConsumedApproval =
        lastApprovalMessageMatches &&
        !lastApprovalRequestId &&
        !lastApprovalEvidenceFingerprint &&
        !promptClearWasObserved &&
        (
          sameUnrepaintedConsumedScreen ||
          observedFingerprint ===
            stringValue(
              nativeTakeover?.terminal_bridge_last_approval_fingerprint
            )
        );
      if (
        sameConsumedTranscriptRequest ||
        sameUnrepaintedConsumedScreen ||
        consumedPromptWithoutEvidenceBeforeClear ||
        legacySameConsumedApproval
      ) {
        previousScreenFingerprint = currentScreenFingerprint;
        suppressApprovalNotification = true;
        runtimeLog("info", "claude_consumed_approval_screen_still_visible", {
          conversation_id: conversation.conversation_id,
          terminal_target: terminalControl.target,
          fingerprint: observedFingerprint,
          screen_digest: currentScreenFingerprint,
          reason: sameConsumedTranscriptRequest
            ? "same_transcript_request"
            : sameUnrepaintedConsumedScreen
              ? "same_unrepainted_screen"
              : legacySameConsumedApproval
                ? "legacy_consumed_approval"
                : "prompt_not_observed_cleared"
        });
      }
    }
    if (
      !suppressApprovalNotification &&
      isRecord(approval) &&
      approval.blocked === true &&
      approval.approvable !== true
    ) {
      const approvalReason = stringValue(approval.reason) ??
        "Claude Code permission state cannot be safely resolved through AKK";
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_approval_not_approvable",
        terminal_control: terminalControl,
        activity_state: terminalStatus.activity_state,
        reason: approvalReason
      });
      const fingerprint = terminalBridgeApprovalFingerprint({ terminalControl, terminalStatus });
      const notification = recordTerminalBridgeApprovalNotification({
        statePath,
        logPath,
        terminalControl,
        terminalStatus,
        fingerprint,
        expectedConversation: {
          conversationId: conversation.conversation_id,
          status: conversation.status,
          updatedAt: conversation.updated_at,
          messageId: currentMessageId
        },
        onRecorded: (notificationConversation, notificationContext) => {
          const callbackIdentity =
            terminalBridgeApprovalCallbackIdentity(notificationConversation);
          const callbackMessage = createMessage({
            conversation: notificationConversation,
            id: callbackIdentity.id,
            from: executor.actor,
            to: "openclaw",
            type: "blocked",
            requiresResponse: true,
            body: [
              `${executor.display_name} is waiting at a permission state that AKK cannot safely approve.`,
              approvalReason,
              "",
              `Conversation: ${notificationConversation.conversation_id}`,
              `Terminal: ${terminalControl.target}`,
              "Review and resolve this dialog in the terminal manually. AKK intentionally sends no key when the request identity cannot be revalidated."
            ].join("\n"),
            metadata: {
              source: "terminal_bridge",
              reason: "approval_not_approvable",
              terminal_control: terminalControl,
              terminal_status: terminalStatus,
              approval_fingerprint: fingerprint
            },
            now: callbackIdentity.now
          });
          if (notificationConversation.gateway_method) {
            return {
              callbackMessage,
              prepared: prepareLockedCallback({
                ...options,
                statePath,
                log: logPath,
                messageJson: JSON.stringify(callbackMessage),
                gatewayMethod: notificationConversation.gateway_method,
                gatewaySession: notificationConversation.gateway_session,
                openclawSession: notificationConversation.openclaw_session,
                openclawBin: notificationConversation.openclaw_bin,
                gatewayUrl: stringValue(notificationConversation.gateway_token)
                  ? notificationConversation.gateway_url
                  : undefined,
                token: stringValue(notificationConversation.gateway_token),
                preserveMessageId: true,
                trackCallbackDelivery: true,
                preserveCallbackStatus: true,
                callbackDeliveryKind: "approval_notification",
                recoverMissingOutbox:
                  notificationContext?.recoverMissingOutbox === true,
                conversationOverride: notificationConversation
              })
            };
          }
          return {
            callbackMessage,
            delivered: false
          };
        }
      });
      if (notification.stale) {
        previousScreenFingerprint = currentScreenFingerprint;
        sleepSync(pollIntervalMs);
        continue;
      }
      if (notification.duplicate) {
        printJson({
          conversation: notification.conversation,
          monitored: true,
          terminal_bridge: true,
          awaiting_approval: true,
          approvable: false,
          duplicate: true,
          reason: approvalReason,
          terminal_control: terminalControl,
          terminal_status: terminalStatus
        });
        return;
      }
      if (notification.recorded?.prepared) {
        runPreparedCallback(notification.recorded.prepared);
        return;
      }
      printJson({
        conversation: notification.conversation,
        monitored: true,
        terminal_bridge: true,
        awaiting_approval: true,
        approvable: false,
        delivered: false,
        message: notification.recorded?.callbackMessage,
        reason: "gateway_method_missing",
        terminal_control: terminalControl,
        terminal_status: terminalStatus
      });
      return;
    }
    if (
      !suppressApprovalNotification &&
      isRecord(approval) &&
      approval.blocked === true
    ) {
      const fingerprint = terminalBridgeApprovalFingerprint({ terminalControl, terminalStatus });
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_approval_detected",
        terminal_control: terminalControl,
        activity_state: terminalStatus.activity_state,
        activity_reason: terminalStatus.activity_reason,
        fingerprint
      });
      const notification = recordTerminalBridgeApprovalNotification({
        statePath,
        logPath,
        terminalControl,
        terminalStatus,
        fingerprint,
        expectedConversation: {
          conversationId: conversation.conversation_id,
          status: conversation.status,
          updatedAt: conversation.updated_at,
          messageId: currentMessageId
        },
        onRecorded: (notificationConversation, notificationContext) => {
          const callbackIdentity =
            terminalBridgeApprovalCallbackIdentity(notificationConversation);
          const callbackMessage = createMessage({
            conversation: notificationConversation,
            id: callbackIdentity.id,
            from: executor.actor,
            to: "openclaw",
            type: "question",
            requiresResponse: true,
            body: terminalBridgeApprovalInstructions({
              conversation: notificationConversation,
              terminalControl,
              terminalStatus
            }),
            metadata: {
              source: "terminal_bridge",
              reason: "approval_required",
              terminal_control: terminalControl,
              terminal_status: terminalStatus,
              approval_fingerprint: fingerprint,
              approval_candidate: terminalBridgeApprovalCandidate({
                executor,
                terminalControl,
                terminalStatus,
                fingerprint
              }),
              approve_command: `AKK approve ${notificationConversation.conversation_id} --expected-approval-fingerprint ${fingerprint}`,
              deny_command: `AKK cancel ${notificationConversation.conversation_id}`,
              approve_tool: "agent_knock_knock_approve",
              deny_tool: "agent_knock_knock_cancel"
            },
            now: callbackIdentity.now
          });
          if (notificationConversation.gateway_method) {
            return {
              callbackMessage,
              prepared: prepareLockedCallback({
                ...options,
                statePath,
                log: logPath,
                messageJson: JSON.stringify(callbackMessage),
                gatewayMethod: notificationConversation.gateway_method,
                gatewaySession: notificationConversation.gateway_session,
                openclawSession: notificationConversation.openclaw_session,
                openclawBin: notificationConversation.openclaw_bin,
                gatewayUrl: stringValue(notificationConversation.gateway_token)
                  ? notificationConversation.gateway_url
                  : undefined,
                token: stringValue(notificationConversation.gateway_token),
                preserveMessageId: true,
                trackCallbackDelivery: true,
                preserveCallbackStatus: true,
                callbackDeliveryKind: "approval_notification",
                recoverMissingOutbox:
                  notificationContext?.recoverMissingOutbox === true,
                conversationOverride: notificationConversation
              })
            };
          }
          return {
            callbackMessage,
            delivered: false
          };
        }
      });
      if (notification.stale) {
        previousScreenFingerprint = currentScreenFingerprint;
        sleepSync(pollIntervalMs);
        continue;
      }
      if (notification.duplicate) {
        printJson({
          conversation: notification.conversation,
          monitored: true,
          terminal_bridge: true,
          awaiting_approval: true,
          duplicate: true,
          terminal_control: terminalControl,
          terminal_status: terminalStatus
        });
        return;
      }
      if (notification.recorded?.prepared) {
        const callbackResult = runPreparedCallback(
          notification.recorded.prepared,
          { emit: false }
        );
        if (
          callbackResult.delivered === true &&
          process.env
            .AKK_TEST_EXIT_AFTER_APPROVAL_CALLBACK_DELIVERED === "1"
        ) {
          appendEvent(logPath, {
            ts: new Date().toISOString(),
            conversation_id: conversation.conversation_id,
            event:
              "terminal_bridge_test_exit_after_approval_callback_delivered",
            terminal_control: terminalControl,
            fingerprint
          });
          process.exit(86);
        }
        const afterCallback = loadState(statePath);
        const afterTakeover = isRecord(afterCallback.native_session_takeover)
          ? afterCallback.native_session_takeover
          : undefined;
        const approvalWasConsumed =
          isWaitingForAgent(afterCallback.status) &&
          afterTakeover?.terminal_bridge_approval === undefined &&
          stringValue(afterTakeover?.terminal_bridge_message_id) ===
            currentMessageId &&
          stringValue(
            afterTakeover?.terminal_bridge_last_approval_message_id
          ) === currentMessageId &&
          stringValue(
            afterTakeover?.terminal_bridge_last_approval_fingerprint
          ) === fingerprint;
        if (approvalWasConsumed) {
          conversation = afterCallback;
          previousScreenFingerprint = currentScreenFingerprint;
          previousDurableFingerprint = undefined;
          idleCompletionFingerprint = undefined;
          lastActivityAtMs =
            validTimestampMs(
              afterTakeover?.terminal_bridge_last_activity_at
            ) ?? Date.now();
          lastPersistedActivityAtMs = lastActivityAtMs;
          persistedActivityReason = stringValue(
            afterTakeover?.terminal_bridge_last_activity_reason
          );
          appendEvent(logPath, {
            ts: new Date().toISOString(),
            conversation_id: conversation.conversation_id,
            event: "terminal_bridge_monitor_continued_after_approval",
            terminal_control: terminalControl,
            fingerprint
          });
          sleepSync(pollIntervalMs);
          continue;
        }
        emitPreparedCallbackResult(callbackResult);
        return;
      }
      printJson({
        conversation: notification.conversation,
        monitored: true,
        terminal_bridge: true,
        awaiting_approval: true,
        delivered: false,
        message: notification.recorded?.callbackMessage,
        reason: "gateway_method_missing",
        terminal_control: terminalControl,
        terminal_status: terminalStatus
      });
      return;
    }

    const screenFingerprint = currentScreenFingerprint;
    const screenChanged = previousScreenFingerprint !== undefined &&
      screenFingerprint !== undefined &&
      screenFingerprint !== previousScreenFingerprint;
    previousScreenFingerprint = screenFingerprint;

    const durableCompletion = poll.durableCompletion;
    const durableFingerprint = durableCompletion
      ? terminalBridgeActivityFingerprint(JSON.stringify({
          text: durableCompletion.text,
          timestamp: durableCompletion.timestamp,
          id: durableCompletion.id,
          metadata: durableCompletion.metadata
        }))
      : undefined;
    const durableChanged = durableFingerprint !== undefined && durableFingerprint !== previousDurableFingerprint;
    previousDurableFingerprint = durableFingerprint;

    const activityReasons = [
      terminalStatus.activity_state === "working" ? terminalStatus.activity_reason : undefined,
      screenChanged ? "terminal screen changed" : undefined,
      durableChanged ? "durable completion evidence changed" : undefined
    ].filter((value): value is string => Boolean(value));
    if (activityReasons.length > 0) {
      const observedAtMs = Date.now();
      lastActivityAtMs = observedAtMs;
      const activityReason = activityReasons.join("; ");
      if (
        persistedActivityReason === undefined ||
        observedAtMs - lastPersistedActivityAtMs >= activityPersistIntervalMs
      ) {
        conversation = persistTerminalBridgeActivity({
          conversation,
          statePath,
          logPath,
          observedAtMs,
          reason: activityReason,
          activityState: terminalStatus.activity_state,
          timeoutMinutes,
          hardTimeoutMinutes
        });
        lastPersistedActivityAtMs = observedAtMs;
        persistedActivityReason = activityReason;
        if (!isWaitingForAgent(conversation.status)) {
          continue;
        }
      }
    }

    const completion = poll.completion;
    const completionMetadata = isRecord(completion?.metadata) ? completion.metadata : {};
    const completionMatch = completion
      ? stringValue(completionMetadata.match) ??
        (completion.source === "screen" ? "terminal_screen" : "durable_completion")
      : undefined;
    const completionFingerprint = completion
      ? createHash("sha256")
        .update(JSON.stringify({
          text: completion.text,
          timestamp: completion.timestamp,
          match: completionMatch,
          source: completion.source,
          id: completion.id,
          message_id: currentMessageId
        }))
        .digest("hex")
      : undefined;
    const completionStable = completionFingerprint !== undefined && completionFingerprint === idleCompletionFingerprint;
    idleCompletionFingerprint = completionFingerprint;
    if (completion && completionStable && completionFingerprint) {
      const preparedCompletion = prepareTerminalBridgeCompletionCallback({
        options,
        statePath,
        logPath,
        conversation,
        executor,
        terminalControl,
        terminalMessageId: currentMessageId,
        completion,
        completionFingerprint
      });
      if (!preparedCompletion.claimed) {
        printJson({
          conversation: preparedCompletion.conversation,
          monitored: true,
          terminal_bridge: true,
          completed: false,
          duplicate: true,
          reason: preparedCompletion.reason
        });
        return;
      }
      runPreparedCallback(preparedCompletion.prepared);
      return;
    }

    // A concrete approval or completion observed on this poll wins over a timeout boundary.
    const nowMs = Date.now();
    if (
      Number.isFinite(hardTimeoutMinutes) &&
      hardTimeoutMinutes > 0 &&
      nowMs - taskStartedAtMs >= hardTimeoutMinutes * 60 * 1000
    ) {
      appendEvent(logPath, {
        ts: new Date(nowMs).toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_hard_timeout_reached",
        terminal_control: terminalControl,
        task_started_at: new Date(taskStartedAtMs).toISOString(),
        hard_deadline_at: new Date(taskStartedAtMs + hardTimeoutMinutes * 60 * 1000).toISOString(),
        agent_hard_timeout_minutes: hardTimeoutMinutes,
        last_activity_at: new Date(lastActivityAtMs).toISOString(),
        terminal_activity_state: terminalStatus.activity_state
      });
      const stalledConversation = markConversationStalled({
        statePath,
        logPath,
        reason: `terminal bridge reached its hard lifetime of ${hardTimeoutMinutes} minutes`,
        detail: {
          terminal_bridge: true,
          terminal_control: terminalControl,
          task_started_at: new Date(taskStartedAtMs).toISOString(),
          last_activity_at: new Date(lastActivityAtMs).toISOString(),
          agent_hard_timeout_minutes: hardTimeoutMinutes,
          terminal_activity_state: terminalStatus.activity_state
        }
      });
      printJson({
        conversation: stalledConversation,
        monitored: true,
        terminal_bridge: true,
        stalled: true,
        hard_timeout: true,
        reason: stalledConversation?.stalled_reason
      });
      return;
    }

    if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
      if (nowMs - lastActivityAtMs >= timeoutMinutes * 60 * 1000) {
        const stalledConversation = markConversationStalled({
          statePath,
          logPath,
          reason: `terminal bridge observed no activity for ${timeoutMinutes} minutes`,
          detail: {
            terminal_bridge: true,
            terminal_control: terminalControl,
            match: completionMetadata.context_match,
            terminal_activity_state: terminalStatus.activity_state,
            last_activity_at: new Date(lastActivityAtMs).toISOString(),
            inactivity_deadline_at: new Date(lastActivityAtMs + timeoutMinutes * 60 * 1000).toISOString(),
            agent_timeout_minutes: timeoutMinutes
          }
        });
        printJson({
          conversation: stalledConversation,
          monitored: true,
          terminal_bridge: true,
          stalled: true,
          reason: stalledConversation?.stalled_reason
        });
        return;
      }
    }

    sleepSync(pollIntervalMs);
  }
}

function validTimestampMs(value): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function deadlineAt(startedAt, timeoutMinutes: number): string | undefined {
  const startedAtMs = validTimestampMs(startedAt);
  return startedAtMs !== undefined && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
    ? new Date(startedAtMs + timeoutMinutes * 60 * 1000).toISOString()
    : undefined;
}

function terminalBridgeActivityFingerprint(value): string | undefined {
  const text = stringValue(value);
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function terminalBridgeScreenFingerprint(value): string | undefined {
  return typeof value === "string"
    ? createHash("sha256").update(value).digest("hex")
    : undefined;
}

function terminalBridgeMonitorLockPath(statePath: string, terminalMessageId: string): string {
  const messageKey = createHash("sha256")
    .update(terminalMessageId)
    .digest("hex")
    .slice(0, 20);
  return `${statePath}.terminal-bridge-monitor-${messageKey}.lock`;
}

function terminalBridgeMonitorHandoffLockPath(
  statePath: string,
  terminalMessageId: string
): string {
  const messageKey = createHash("sha256")
    .update(terminalMessageId)
    .digest("hex")
    .slice(0, 20);
  return `${statePath}.terminal-bridge-monitor-handoff-${messageKey}.lock`;
}

function fileLockOwnerPid(lockPath: string): number | undefined {
  return readFileLockOwner(lockPath).pid;
}

function activeTerminalBridgeMonitorOwner(
  statePath: string,
  terminalMessageId: string
): { lockPath: string; ownerPid?: number } | undefined {
  const lockPath = terminalBridgeMonitorLockPath(statePath, terminalMessageId);
  if (!fs.existsSync(lockPath) || staleFileLock(lockPath)) {
    return undefined;
  }
  return {
    lockPath,
    ownerPid: fileLockOwnerPid(lockPath)
  };
}

function tryAcquireTerminalBridgeMonitorLock(statePath: string, terminalMessageId: string) {
  const lockPath = terminalBridgeMonitorLockPath(statePath, terminalMessageId);
  try {
    return {
      acquired: true as const,
      lockPath,
      release: acquireFileLock(lockPath, { timeoutMs: 0 })
    };
  } catch (error) {
    if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
      return {
        acquired: false as const,
        lockPath,
        ownerPid: fileLockOwnerPid(lockPath)
      };
    }
    throw error;
  }
}

function terminalBridgeSendLockPath(_storeDir: string, terminalControl): string {
  const lockDir = terminalBridgeRuntimeLockDir();
  ensureDir(lockDir);
  const terminalKey = terminalBridgeRuntimeKey(terminalControl);
  return path.join(lockDir, `terminal-bridge-send-${terminalKey}.lock`);
}

function terminalBridgeRuntimeLockDir(): string {
  return path.join(
    terminalBridgeRuntimeDir(),
    "terminal-locks"
  );
}

function terminalBridgeRuntimeDir(): string {
  const configured = stringValue(process.env.AKK_RUNTIME_DIR);
  return configured
    ? path.resolve(expandHome(configured))
    : path.join(path.dirname(defaultStoreDir()), "runtime");
}

function terminalBridgeRuntimeKey(terminalControl): string {
  return createHash("sha256")
    .update(JSON.stringify({
      target: terminalControl.target,
      socket_path: terminalControl.socketPath ?? null
    }))
    .digest("hex")
    .slice(0, 20);
}

function terminalBridgeDispatchLedgerPath(terminalControl): string {
  const ledgerDir = path.join(
    terminalBridgeRuntimeDir(),
    "terminal-dispatch"
  );
  ensureDir(ledgerDir);
  return path.join(
    ledgerDir,
    `terminal-dispatch-${terminalBridgeRuntimeKey(terminalControl)}.json`
  );
}

function loadTerminalBridgeDispatchLedger(
  terminalControl
): Record<string, any> | undefined {
  const ledgerPath = terminalBridgeDispatchLedgerPath(terminalControl);
  if (!fs.existsSync(ledgerPath)) {
    return undefined;
  }
  const stat = fs.lstatSync(ledgerPath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`terminal dispatch ledger is not a regular file: ${ledgerPath}`);
  }
  const parsed = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    stringValue(parsed.terminal_key) !== terminalBridgeRuntimeKey(terminalControl)
  ) {
    throw new Error(`terminal dispatch ledger is invalid: ${ledgerPath}`);
  }
  return parsed;
}

function orphanedTerminalDispatchForRecovery(
  terminalControl: TerminalControlRef
): Record<string, any> | undefined {
  try {
    const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
    const ledgerControl = isRecord(ledger?.terminal_control)
      ? ledger.terminal_control
      : undefined;
    const ledgerPanePid = Number(ledgerControl?.pane_pid);
    const currentPanePid = Number(terminalControl.panePid);
    if (
      !ledger ||
      !["prepared", "submitted", "uncertain"].includes(ledger.status) ||
      !stringValue(ledger.message_id) ||
      (
        Number.isSafeInteger(ledgerPanePid) &&
        ledgerPanePid > 0 &&
        Number.isSafeInteger(currentPanePid) &&
        currentPanePid > 0 &&
        ledgerPanePid !== currentPanePid
      ) ||
      loadTerminalDispatchLedgerOwner(ledger)
    ) {
      return undefined;
    }
    return ledger;
  } catch {
    return undefined;
  }
}

function saveTerminalBridgeDispatchLedger(
  terminalControl,
  ledger: Record<string, unknown>
): void {
  const ledgerPath = terminalBridgeDispatchLedgerPath(terminalControl);
  if (fs.existsSync(ledgerPath) && fs.lstatSync(ledgerPath).isSymbolicLink()) {
    throw new Error(`terminal dispatch ledger is a symlink: ${ledgerPath}`);
  }
  const nextLedger = {
    ...ledger,
    version: 1,
    terminal_key: terminalBridgeRuntimeKey(terminalControl),
    terminal_control: {
      kind: "tmux",
      target: terminalControl.target,
      socket_path: terminalControl.socketPath ?? null,
      pane_pid: terminalControl.panePid ?? null,
      current_path: terminalControl.currentPath ?? null
    }
  };
  const tempPath = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
  let tempFd: number | undefined;
  try {
    tempFd = fs.openSync(
      tempPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      0o600
    );
    fs.fchmodSync(tempFd, 0o600);
    fs.writeFileSync(
      tempFd,
      `${JSON.stringify(nextLedger, null, 2)}\n`,
      "utf8"
    );
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd);
    tempFd = undefined;
    fs.renameSync(tempPath, ledgerPath);
    fs.chmodSync(ledgerPath, 0o600);
    fsyncTerminalBridgeDirectory(path.dirname(ledgerPath));
  } finally {
    if (tempFd !== undefined) {
      fs.closeSync(tempFd);
    }
    fs.rmSync(tempPath, { force: true });
  }
}

function fsyncTerminalBridgeDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      directory,
      fs.constants.O_RDONLY | NO_FOLLOW_FLAG
    );
    fs.fsyncSync(fd);
  } catch (error) {
    const code = error instanceof Error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (
      !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(
        String(code)
      )
    ) {
      throw error;
    }
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

function resolveTerminalDispatchLedgerPaneIncarnation(
  terminalControl: TerminalControlRef,
  ledger?: Record<string, any>
): Record<string, any> | undefined {
  if (!ledger || ledger.status === "resolved") {
    return ledger;
  }
  const ledgerControl = isRecord(ledger.terminal_control)
    ? ledger.terminal_control
    : undefined;
  const ledgerPanePid = Number(ledgerControl?.pane_pid);
  const currentPanePid = Number(terminalControl.panePid);
  if (
    !Number.isSafeInteger(ledgerPanePid) ||
    ledgerPanePid <= 0 ||
    !Number.isSafeInteger(currentPanePid) ||
    currentPanePid <= 0 ||
    ledgerPanePid === currentPanePid
  ) {
    return ledger;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    ...ledger,
    status: "resolved",
    resolved_at: new Date().toISOString(),
    reason:
      `tmux pane incarnation changed from pid ${ledgerPanePid} to ${currentPanePid}`
  });
  return loadTerminalBridgeDispatchLedger(terminalControl);
}

function loadTerminalDispatchLedgerOwner(
  ledger: Record<string, any>
): Conversation | undefined {
  const statePath = stringValue(ledger.state_path);
  if (!statePath) {
    return undefined;
  }
  try {
    const conversation = loadState(statePath);
    if (
      conversation.conversation_id !==
        stringValue(ledger.conversation_id)
    ) {
      return undefined;
    }
    return conversation;
  } catch {
    return undefined;
  }
}

function assertManagedTerminalDispatchOwner({
  conversation,
  terminalControl,
  action
}: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  action: "approve" | "cancel";
}): void {
  const nativeTakeover = isRecord(
    conversation.native_session_takeover
  )
    ? conversation.native_session_takeover
    : undefined;
  const messageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  if (
    !messageId ||
    ledger?.status !== "submitted" ||
    stringValue(ledger.conversation_id) !==
      conversation.conversation_id ||
    stringValue(ledger.message_id) !== messageId
  ) {
    throw new Error(
      `refusing to ${action}: this AKK conversation does not own the ` +
      "current terminal dispatch generation; refresh status and operate on " +
      "the current task"
    );
  }
}

function reconcilePreparedTerminalDispatchLedger(
  terminalControl: TerminalControlRef,
  ledger?: Record<string, any>
): Record<string, any> | undefined {
  if (ledger?.status !== "prepared") {
    return ledger;
  }
  const statePath = stringValue(ledger.state_path);
  const messageId = stringValue(ledger.message_id);
  if (!statePath || !messageId) {
    return ledger;
  }
  const dispatcherPid = Number(ledger.dispatcher_pid);
  if (
    Number.isSafeInteger(dispatcherPid) &&
    dispatcherPid > 1 &&
    isProcessAlive(dispatcherPid)
  ) {
    return ledger;
  }
  let conversation: Conversation | undefined;
  try {
    conversation = loadState(statePath);
  } catch (error) {
    const code = error instanceof Error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== "ENOENT") {
      return ledger;
    }
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: new Date().toISOString(),
      reason:
        "dispatcher exited before the prepared owner state existed; no tmux input was possible"
    });
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }
  const nativeTakeover = isRecord(
    conversation.native_session_takeover
  )
    ? conversation.native_session_takeover
    : undefined;
  const storedControl = terminalControlFromTakeover(nativeTakeover);
  const submission = terminalBridgeSubmission(conversation);
  const storedMessageId = stringValue(
    nativeTakeover?.terminal_bridge_message_id
  );
  if (
    conversation.conversation_id !==
      stringValue(ledger.conversation_id) ||
    !storedControl ||
    terminalBridgeRuntimeKey(storedControl) !==
      terminalBridgeRuntimeKey(terminalControl)
  ) {
    return ledger;
  }
  if (
    storedMessageId === messageId &&
    stringValue(submission?.message_id) === messageId
  ) {
    if (submission?.status === "submitted") {
      const submittedAt =
        stringValue(submission.submitted_at) ??
        stringValue(conversation.updated_at) ??
        new Date().toISOString();
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        status: "submitted",
        submitted_at: submittedAt,
        reason:
          "recovered from the durable conversation submission receipt"
      });
    } else {
      saveTerminalBridgeDispatchLedger(terminalControl, {
        ...ledger,
        status: "uncertain",
        uncertain_at: new Date().toISOString(),
        reason:
          "dispatcher exited after the prepared state became durable; tmux submission cannot be proven"
      });
    }
    return loadTerminalBridgeDispatchLedger(terminalControl);
  }

  if (
    storedMessageId &&
    submission?.status === "submitted" &&
    stringValue(submission.message_id) === storedMessageId
  ) {
    const requestText = String(
      nativeTakeover?.terminal_bridge_request_text ??
        conversation.user_request ??
        ""
    );
    saveTerminalBridgeDispatchLedger(terminalControl, {
      status: "submitted",
      generation_id: storedMessageId,
      conversation_id: conversation.conversation_id,
      message_id: storedMessageId,
      request_hash:
        terminalBridgeRequestFingerprint(requestText),
      prepared_at:
        stringValue(submission.prepared_at) ??
        stringValue(conversation.updated_at),
      submitted_at:
        stringValue(submission.submitted_at) ??
        stringValue(conversation.updated_at),
      dispatcher_pid: null,
      state_path: statePath,
      event_log_path:
        stringValue(ledger.event_log_path) ??
        logPathForStatePath(statePath),
      callback_expected: Boolean(conversation.gateway_method),
      reason:
        "restored the prior durable generation after a pre-submit dispatcher exit"
    });
  } else {
    saveTerminalBridgeDispatchLedger(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: new Date().toISOString(),
      reason:
        "dispatcher exited before the prepared generation reached durable state; no tmux input was possible"
    });
  }
  return loadTerminalBridgeDispatchLedger(terminalControl);
}

function restoreTerminalBridgeDispatchLedger({
  terminalControl,
  previousLedger,
  reason
}: {
  terminalControl: TerminalControlRef;
  previousLedger?: Record<string, any>;
  reason: string;
}): void {
  if (previousLedger) {
    saveTerminalBridgeDispatchLedger(terminalControl, previousLedger);
    return;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    status: "resolved",
    resolved_at: new Date().toISOString(),
    reason
  });
}

function resolveTerminalBridgeDispatchLedger({
  terminalControl,
  conversation,
  expectedMessageId,
  reason
}: {
  terminalControl: TerminalControlRef;
  conversation: Conversation;
  expectedMessageId?: string;
  reason: string;
}): boolean {
  const ledger = loadTerminalBridgeDispatchLedger(terminalControl);
  if (
    !ledger ||
    stringValue(ledger.conversation_id) !== conversation.conversation_id ||
    (
      expectedMessageId !== undefined &&
      stringValue(ledger.message_id) !== expectedMessageId
    )
  ) {
    return false;
  }
  saveTerminalBridgeDispatchLedger(terminalControl, {
    ...ledger,
    status: "resolved",
    resolved_at: new Date().toISOString(),
    reason
  });
  return true;
}

function terminalBridgeRequestFingerprint(value): string | undefined {
  const text = String(value ?? "");
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function deterministicTerminalCallbackMessageId({
  conversationId,
  terminalMessageId,
  completionFingerprint,
  outcome
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify({
      conversation_id: conversationId,
      terminal_message_id: terminalMessageId,
      completion_fingerprint: completionFingerprint,
      outcome
    }))
    .digest("hex")
    .slice(0, 32);
  return `msg-terminal-${digest}`;
}

function terminalBridgeCompletionFingerprint({
  completion,
  terminalMessageId
}: {
  completion: TerminalCompletionEvidence;
  terminalMessageId?: string;
}): string {
  const metadata = isRecord(completion.metadata) ? completion.metadata : {};
  const match = stringValue(metadata.match) ??
    (completion.source === "screen" ? "terminal_screen" : "durable_completion");
  return createHash("sha256")
    .update(JSON.stringify({
      text: completion.text,
      timestamp: completion.timestamp,
      match,
      source: completion.source,
      id: completion.id,
      message_id: terminalMessageId
    }))
    .digest("hex");
}

function prepareTerminalBridgeCompletionCallback({
  options,
  statePath,
  logPath,
  conversation,
  executor,
  terminalControl,
  terminalMessageId,
  completion,
  allowSupersedeRecovery = false,
  completionFingerprint = terminalBridgeCompletionFingerprint({
    completion,
    terminalMessageId
  })
}) {
  const completionMetadata = isRecord(completion.metadata) ? completion.metadata : {};
  const completionMatch = stringValue(completionMetadata.match) ??
    (completion.source === "screen" ? "terminal_screen" : "durable_completion");
  const completionOutcome = completion.outcome === "failure" ? "failure" : "success";
  const callbackMessageId = deterministicTerminalCallbackMessageId({
    conversationId: conversation.conversation_id,
    terminalMessageId,
    completionFingerprint,
    outcome: completionOutcome
  });
  const claim = claimTerminalBridgeCompletion({
    statePath,
    logPath,
    terminalMessageId,
    completionFingerprint,
    completionId: completion.id,
    callbackMessageId,
    outcome: completionOutcome,
    allowSupersedeRecovery
  });
  if (!claim.claimed) {
    return claim;
  }

  let claimedConversation = claim.conversation;
  let claimReleased = false;
  try {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: claimedConversation.conversation_id,
      event: "terminal_bridge_completion_detected",
      terminal_control: terminalControl,
      match: completionMatch,
      completion_source: completion.source,
      completion_outcome: completionOutcome,
      completion_id: completion.id,
      terminal_session: completionMetadata.session,
      context_match: completionMetadata.context_match,
      assistant_timestamp: completion.timestamp,
      rollout_turn_id: completion.source === "durable" ? completion.id : undefined,
      terminal_bridge_message_id: terminalMessageId,
      callback_message_id: callbackMessageId
    });
    const callbackMessage = {
      ...createMessage({
        conversation: claimedConversation,
        from: executor.actor,
        to: "openclaw",
        type: completionOutcome === "failure" ? "error" : "done",
        requiresResponse: false,
        body: completion.text,
        metadata: {
          source: "terminal_bridge",
          terminal_control: terminalControl,
          ...completionMetadata,
          completion_source: completion.source,
          completion_outcome: completionOutcome,
          completion_id: completion.id,
          terminal_session: completionMetadata.session,
          confidence: completion.confidence,
          match: completionMatch,
          assistant_timestamp: completion.timestamp,
          rollout_turn_id: completion.source === "durable" ? completion.id : undefined,
          terminal_bridge_message_id: terminalMessageId
        }
      }),
      id: callbackMessageId
    };
    const prepared = prepareLockedCallback({
      ...options,
      statePath,
      log: logPath,
      closeTerminalBridgeOnDone: false,
      trackCallbackDelivery: true,
      recoverTerminalCompletion: claim.resumed === true,
      allowTerminalCompletionRecoveryStatus: allowSupersedeRecovery,
      preserveMessageId: true,
      messageJson: JSON.stringify(callbackMessage),
      gatewayMethod: claimedConversation.gateway_method,
      gatewaySession: claimedConversation.gateway_session,
      openclawSession: claimedConversation.openclaw_session,
      openclawBin: claimedConversation.openclaw_bin,
      gatewayUrl: stringValue(claimedConversation.gateway_token)
        ? claimedConversation.gateway_url
        : undefined,
      token: stringValue(claimedConversation.gateway_token)
    });
    claim.release();
    claimReleased = true;
    const releaseTerminalLock = acquireFileLock(
      terminalBridgeSendLockPath(
        storeDirFromOptions(options),
        terminalControl
      ),
      { timeoutMs: 30000 }
    );
    try {
      resolveTerminalBridgeDispatchLedger({
        terminalControl,
        conversation: claimedConversation,
        expectedMessageId: terminalMessageId,
        reason: "terminal bridge task reached durable completion"
      });
    } finally {
      releaseTerminalLock();
    }
    return {
      claimed: true as const,
      conversation: claimedConversation,
      prepared,
      callbackMessageId
    };
  } finally {
    if (!claimReleased) {
      claim.release();
    }
  }
}

function claimTerminalBridgeCompletion({
  statePath,
  logPath,
  terminalMessageId,
  completionFingerprint,
  completionId,
  callbackMessageId,
  outcome,
  allowSupersedeRecovery = false
}) {
  const release = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    if (
      !isWaitingForAgent(conversation.status) &&
      !(
        allowSupersedeRecovery &&
        TERMINAL_BRIDGE_SUPERSEDE_STATUSES.has(conversation.status)
      )
    ) {
      release();
      return {
        claimed: false as const,
        conversation,
        reason: "conversation_no_longer_waiting"
      };
    }
    if (stringValue(nativeTakeover.terminal_bridge_message_id) !== terminalMessageId) {
      release();
      return {
        claimed: false as const,
        conversation,
        reason: "terminal_bridge_task_replaced"
      };
    }
    const existing = isRecord(nativeTakeover.terminal_bridge_completion_claim)
      ? nativeTakeover.terminal_bridge_completion_claim
      : undefined;
    if (existing) {
      if (
        existing.callback_message_id === callbackMessageId &&
        existing.terminal_bridge_message_id === terminalMessageId &&
        existing.completion_fingerprint === completionFingerprint &&
        existing.outcome === outcome
      ) {
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_completion_claim_resumed",
          terminal_bridge_message_id: terminalMessageId,
          completion_fingerprint: completionFingerprint,
          callback_message_id: callbackMessageId,
          outcome
        });
        return {
          claimed: true as const,
          resumed: true as const,
          conversation,
          release
        };
      }
      release();
      return {
        claimed: false as const,
        conversation,
        reason: "terminal_bridge_completion_claim_conflict"
      };
    }

    const claimedAt = new Date().toISOString();
    const claimedConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_completion_claim: {
          terminal_bridge_message_id: terminalMessageId,
          completion_fingerprint: completionFingerprint,
          completion_id: completionId,
          callback_message_id: callbackMessageId,
          outcome,
          claimed_at: claimedAt
        }
      },
      updated_at: claimedAt
    };
    saveState(statePath, claimedConversation);
    appendEvent(logPath, {
      ts: claimedAt,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_completion_claimed",
      terminal_bridge_message_id: terminalMessageId,
      completion_fingerprint: completionFingerprint,
      completion_id: completionId,
      callback_message_id: callbackMessageId,
      outcome
    });
    return {
      claimed: true as const,
      resumed: false as const,
      conversation: claimedConversation,
      release
    };
  } catch (error) {
    release();
    throw error;
  }
}

function terminalBridgeActivityPersistIntervalMs(timeoutMinutes: number, pollIntervalMs: number): number {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return 5 * 60 * 1000;
  }
  return Math.max(pollIntervalMs, Math.min(timeoutMinutes * 30 * 1000, 5 * 60 * 1000));
}

function persistTerminalBridgeActivity({
  conversation,
  statePath,
  logPath,
  observedAtMs,
  reason,
  activityState,
  timeoutMinutes,
  hardTimeoutMinutes
}) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    const currentConversation = loadState(statePath);
    if (!isWaitingForAgent(currentConversation.status)) {
      return currentConversation;
    }
    const expectedNativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    const nativeTakeover = isRecord(currentConversation.native_session_takeover)
      ? currentConversation.native_session_takeover
      : {};
    if (
      nativeTakeover["terminal_bridge_message_id"] !==
      expectedNativeTakeover["terminal_bridge_message_id"]
    ) {
      return currentConversation;
    }

    const previousActivityAtMs = validTimestampMs(nativeTakeover["terminal_bridge_last_activity_at"]);
    const observedAt = new Date(observedAtMs).toISOString();
    const inactivityDeadlineAt = Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
      ? new Date(observedAtMs + timeoutMinutes * 60 * 1000).toISOString()
      : undefined;
    const nextConversation = {
      ...currentConversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_last_activity_at: observedAt,
        terminal_bridge_last_activity_reason: reason,
        terminal_bridge_inactivity_deadline_at: inactivityDeadlineAt,
        terminal_bridge_inactivity_timeout_minutes: timeoutMinutes,
        terminal_bridge_hard_timeout_minutes: hardTimeoutMinutes
      },
      updated_at: observedAt
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: observedAt,
      conversation_id: currentConversation.conversation_id,
      event: "terminal_bridge_activity_observed",
      reason,
      last_activity_at: observedAt,
      terminal_activity_state: activityState
    });
    if (inactivityDeadlineAt) {
      appendEvent(logPath, {
        ts: observedAt,
        conversation_id: currentConversation.conversation_id,
        event: "terminal_bridge_inactivity_deadline_extended",
        reason,
        previous_last_activity_at: previousActivityAtMs === undefined
          ? null
          : new Date(previousActivityAtMs).toISOString(),
        last_activity_at: observedAt,
        inactivity_deadline_at: inactivityDeadlineAt,
        agent_timeout_minutes: timeoutMinutes
      });
    }
    return nextConversation;
  } finally {
    releaseLock();
  }
}

function terminalBridgeApprovalCandidate({ executor, terminalControl, terminalStatus, fingerprint }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  if (approval.approvable !== true) {
    return undefined;
  }
  const policyEvidence = isRecord(approval.policy_evidence)
    ? approval.policy_evidence
    : undefined;
  const localClaudeEvidence =
    executor.kind === "claude" &&
    policyEvidence?.source === "claude_transcript" &&
    policyEvidence?.kind === "run_command";
  return {
    agent: executor.kind,
    kind: localClaudeEvidence
      ? "run_command"
      : stringValue(approval.prompt_kind) ?? "unknown",
    command: localClaudeEvidence ? undefined : stringValue(approval.command),
    tool_name: stringValue(approval.tool_name),
    request_detail: stringValue(approval.request_detail),
    cwd: stringValue(approval.cwd) ?? terminalControl.currentPath,
    fingerprint,
    terminal_target: terminalControl.target,
    decision_mode: stringValue(approval.decision_mode),
    ...(localClaudeEvidence
      ? {
          command_source: "executor_local",
          policy_evidence: {
            source: "claude_transcript",
            kind: "run_command",
            command_sha256: stringValue(policyEvidence.command_sha256),
            evidence_fingerprint:
              stringValue(policyEvidence.evidence_fingerprint),
            request_id: stringValue(policyEvidence.request_id)
          }
        }
      : {})
  };
}

async function loadCodexTerminalContexts({ nativeTakeover, options }) {
  const provider = createAgentSessionProvider("codex", options);
  const nativeSessionId = stringValue(nativeTakeover?.["native_session_id"]);
  const startedAtMs = Date.parse(String(nativeTakeover?.["terminal_bridge_started_at"] ?? ""));
  const terminalConversation = parseTerminalConversationId(nativeSessionId);
  const activeProcess = await activeCodexProcessForPid(options, terminalConversation?.pid);
  const directSessionId = activeProcess?.sessionId ?? (terminalConversation ? undefined : nativeSessionId);
  if (directSessionId) {
    const context = await provider.getForkContext({
      sessionId: directSessionId,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 4000)
    });
    if (context) {
      return [{
        context,
        process: activeProcess,
        match: activeProcess?.sessionId ? "process_session_id" : "native_session_id",
        confidence: "high"
      }];
    }
  }

  const cwd = activeProcess?.cwd ?? stringValue(nativeTakeover?.["source_cwd"]);
  if (!cwd) {
    return [];
  }

  const sessions = (await provider.listHistoricalSessions())
    .filter((session) => session.cwd === cwd)
    .filter((session) => {
      if (!Number.isFinite(startedAtMs)) {
        return true;
      }
      if (session.updatedAtMs === undefined || session.updatedAtMs === null) {
        return true;
      }
      const updatedAtMs = Number(session.updatedAtMs);
      return !Number.isFinite(updatedAtMs) || updatedAtMs >= startedAtMs;
    })
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  const matches: Array<{
    context: ForkContextPackage;
    process: ActiveCodexProcess | undefined;
    match: string;
    confidence: string;
  }> = [];
  const candidateErrors: string[] = [];
  for (const session of sessions) {
    try {
      const context = await provider.getForkContext({
        sessionId: session.id,
        maxMessages: Number(options.maxMessages ?? 16),
        maxCommands: Number(options.maxCommands ?? 10),
        maxTextLength: Number(options.maxTextLength ?? 4000)
      });
      if (context) {
        matches.push({
          context,
          process: activeProcess,
          match: sessions.length === 1 ? "cwd" : "cwd_request_hash",
          confidence: sessions.length === 1 ? "medium" : "low"
        });
      }
    } catch (error) {
      candidateErrors.push(
        `${session.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  if (candidateErrors.length > 0) {
    throw new Error(
      `could not inspect every plausible same-cwd Codex session: ${candidateErrors.join("; ")}`
    );
  }
  return matches;
}

function resolveExecutable(command) {
  if (command.includes(path.sep)) {
    return command;
  }

  const paths = executableSearchPaths();
  for (const dir of paths) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }

  throw new Error(`executable not found on PATH: ${command}`);
}

function executableSearchPaths() {
  const home = process.env.HOME;
  return [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean),
    ...(home ? [
      path.join(home, ".npm-global", "bin"),
      path.join(home, ".local", "bin")
    ] : []),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ];
}

function resolveOptionalExecutable(command) {
  try {
    return resolveExecutable(command);
  } catch {
    return command;
  }
}

function packageRootDir() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function printVersion() {
  const packageJsonPath = path.join(packageRootDir(), "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  process.stdout.write(`${packageJson.version}\n`);
}

function runCheckedCommand(command, args, { label }) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(cleanProcessText(result.stderr || result.stdout || `${label} exited with status ${result.status}`));
  }

  return result;
}

function runTranscript(options) {
  const conversationDir = options.conversation ? expandHome(options.conversation) : null;
  const logPath = conversationDir
    ? pathsForConversationDir(conversationDir).logPath
    : required(options.log ?? options.path, "--log or --conversation is required");
  const events = readNdjsonLog(expandHome(logPath));
  process.stdout.write(formatTranscript(events, {
    includeRaw: Boolean(options.includeRaw)
  }));
}

function runCallback(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  runCallbackTransaction({ ...options, statePath });
}

function runRetryCallback(options) {
  const { conversation, statePath } = loadConversationFromOptions(options);
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  if (!isRetryableCallbackDelivery(conversation, callbackDelivery)) {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; no retryable callback delivery is available`
    );
  }
  if (!callbackDelivery || !isRecord(callbackDelivery.message)) {
    throw new Error(`cannot retry callback for ${conversation.conversation_id}; pending callback is missing`);
  }

  runCallbackTransaction({
    ...options,
    statePath,
    messageJson: JSON.stringify(callbackDelivery.message),
    gatewayMethod: stringValue(callbackDelivery.gateway_method) ?? conversation.gateway_method,
    gatewaySession: stringValue(callbackDelivery.gateway_session) ?? conversation.gateway_session,
    openclawSession: conversation.openclaw_session,
    openclawBin: stringValue(callbackDelivery.openclaw_bin) ?? conversation.openclaw_bin,
    gatewayUrl: stringValue(callbackDelivery.gateway_url) ?? conversation.gateway_url,
    token: stringValue(callbackDelivery.gateway_token) ?? conversation.gateway_token,
    closeTerminalBridgeOnDone: callbackDelivery.close_terminal_bridge_on_done === true,
    retryPending: true
  });
}

function runCallbackTransaction(options) {
  const releaseLock = acquireFileLock(`${options.statePath}.lock`);
  let prepared;
  try {
    prepared = prepareLockedCallback(options);
  } finally {
    releaseLock();
  }
  return runPreparedCallback(prepared);
}

function prepareLockedCallback(options) {
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = expandHome(options.log ?? logPathForStatePath(options.statePath));
  const conversation = isRecord(options.conversationOverride)
    ? options.conversationOverride
    : loadState(options.statePath);
  const executor = executorForConversation(conversation);
  const message = options.retryPending === true || options.preserveMessageId === true
    ? parseMessageJson(messageInput)
    : extractStructuredMessage({
        conversation,
        input: messageInput,
        defaultFrom: executor.actor,
        defaultTo: "openclaw"
      });
  if (message.conversation_id !== conversation.conversation_id) {
    throw new Error(
      `message.conversation_id ${message.conversation_id} does not match conversation ${conversation.conversation_id}`
    );
  }

  const existingEvents = readExistingEvents(logPath);
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const sameDeliveryMessage =
    isRecord(callbackDelivery?.message) &&
    callbackDelivery.message.id === message.id;
  const inheritedDelivery = sameDeliveryMessage
    ? callbackDelivery
    : undefined;
  const retryingPending = options.retryPending === true &&
    sameDeliveryMessage &&
    isRetryableCallbackDelivery(conversation, inheritedDelivery);
  const duplicateMessage = isDuplicateMessage(existingEvents, message);
  const recoveryMessageAlreadyLogged = options.recoverMissingOutbox === true
    ? exactLoggedMessageForRecovery(existingEvents, message)
    : false;
  const recoveringMissingOutbox =
    options.recoverMissingOutbox === true &&
    (
      !isRecord(callbackDelivery?.message) ||
      callbackDelivery.message.id !== message.id
    );
  const recoveringTerminalCompletion = options.recoverTerminalCompletion === true &&
    duplicateMessage &&
    (
      isWaitingForAgent(conversation.status) ||
      (
        options.allowTerminalCompletionRecoveryStatus === true &&
        TERMINAL_BRIDGE_SUPERSEDE_STATUSES.has(conversation.status)
      )
    );
  if (
    duplicateMessage &&
    !retryingPending &&
    !recoveringTerminalCompletion &&
    !recoveringMissingOutbox
  ) {
    runtimeLog("info", "callback_duplicate", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      from: message.from,
      type: message.type,
      round: message.round,
      state_path: options.statePath,
      event_log_path: logPath
    });
    return {
      outcome: "duplicate" as const,
      conversation,
      message,
      logPath
    };
  }

  const closeTerminalBridgeOnDone = message.type === "done" &&
    options.closeTerminalBridgeOnDone === true;
  const preserveConversationStatus =
    options.preserveCallbackStatus === true ||
    inheritedDelivery?.preserve_conversation_status === true;
  const trackCallbackDelivery = closeTerminalBridgeOnDone ||
    options.trackCallbackDelivery === true ||
    inheritedDelivery?.track_delivery === true ||
    preserveConversationStatus;
  const requiresDelivery = Boolean(options.gatewayMethod) || options.recordOnly !== true;
  const deliveryAttempt = Number(inheritedDelivery?.attempts ?? 0) + 1;
  const deliveryAttemptId = randomUUID();
  let nextConversation = retryingPending
    ? conversation
    : applyMessageToConversation(conversation, message);
  const storedFinalStatus = stringValue(inheritedDelivery?.final_status);
  const finalStatus: ConversationStatus = storedFinalStatus &&
    CONVERSATION_STATUSES.has(storedFinalStatus as ConversationStatus)
    ? storedFinalStatus as ConversationStatus
    : nextConversation.status;
  const callbackRetryDelayMs = CALLBACK_RETRY_DELAYS_MS[
    Math.min(CALLBACK_RETRY_DELAYS_MS.length - 1, Math.max(0, deliveryAttempt - 1))
  ];
  const callbackWatchdog = trackCallbackDelivery &&
    requiresDelivery &&
    options.recordOnly !== true &&
    !retryingPending &&
    options.disableCallbackRetry !== true &&
    deliveryAttempt <= CALLBACK_RETRY_DELAYS_MS.length
    ? startCallbackRetryMonitor({
        statePath: options.statePath,
        delayMs: callbackRetryDelayMs
      })
    : undefined;
  if (
    !retryingPending &&
    !recoveringTerminalCompletion &&
    !(recoveringMissingOutbox && recoveryMessageAlreadyLogged)
  ) {
    appendEvent(logPath, messageEvent(message));
  }
  if (trackCallbackDelivery && requiresDelivery) {
    const now = new Date().toISOString();
    nextConversation = {
      ...nextConversation,
      status: preserveConversationStatus
        ? nextConversation.status
        : "callback_pending" as const,
      callback_delivery: {
        status: "pending",
        message,
        attempts: deliveryAttempt,
        attempt_id: deliveryAttemptId,
        attempt_pid: process.pid,
        created_at: stringValue(inheritedDelivery?.created_at) ?? now,
        last_attempt_at: now,
        gateway_method: options.gatewayMethod,
        gateway_session: options.gatewaySession ?? options.openclawSession ?? conversation.openclaw_session,
        gateway_url: options.gatewayUrl ?? conversation.gateway_url,
        openclaw_bin: options.openclawBin ?? conversation.openclaw_bin,
        close_terminal_bridge_on_done: closeTerminalBridgeOnDone,
        track_delivery: true,
        final_status: finalStatus,
        preserve_conversation_status: preserveConversationStatus,
        kind: stringValue(options.callbackDeliveryKind) ??
          stringValue(inheritedDelivery?.kind),
        ...(callbackWatchdog
          ? {
              retry_monitor_pid: callbackWatchdog.pid ?? null,
              next_attempt_at: new Date(Date.now() + callbackRetryDelayMs).toISOString()
            }
          : {})
      },
      updated_at: now
    };
    delete nextConversation.idle_since;
    delete nextConversation.closed_at;
    delete nextConversation.close_reason;
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: retryingPending ? "callback_delivery_retry_started" : "callback_delivery_pending",
      message_id: message.id,
      attempt: deliveryAttempt
    });
    if (callbackWatchdog) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "callback_retry_monitor_launched",
        message_id: message.id,
        pid: callbackWatchdog.pid ?? null,
        next_attempt_at: isRecord(nextConversation.callback_delivery)
          ? nextConversation.callback_delivery.next_attempt_at
          : undefined
      });
    }
  }
  saveState(options.statePath, nextConversation);
  runtimeLog("info", "callback_received", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    from: message.from,
    type: message.type,
    round: message.round,
    status: nextConversation.status,
    requires_response: message.requires_response,
    state_path: options.statePath,
      event_log_path: logPath,
      message: textSummary(message.body)
  });

  if (options.recordOnly) {
    runtimeLog("info", "callback_recorded_only", {
      conversation_id: conversation.conversation_id,
      status: nextConversation.status
    });
    return {
      outcome: "record_only" as const,
      conversation: nextConversation,
      message,
      logPath
    };
  }

  return {
    outcome: "deliver" as const,
    options,
    statePath: options.statePath,
    logPath,
    conversation: nextConversation,
    message,
    trackCallbackDelivery,
    preserveConversationStatus,
    closeTerminalBridgeOnDone,
    finalStatus,
    deliveryAttempt,
    deliveryAttemptId
  };
}

function emitPreparedCallbackResult(result): void {
  printJson({
    conversation: result.conversation,
    message: result.message,
    budget: budgetAction(result.conversation),
    delivered: result.delivered,
    duplicate: result.duplicate,
    ...(result.delivery === undefined ? {} : { delivery: result.delivery })
  });
}

function runPreparedCallback(prepared, { emit = true } = {}) {
  if (prepared.outcome === "duplicate") {
    const result = {
      delivered: false,
      duplicate: true,
      conversation: prepared.conversation,
      message: prepared.message
    };
    if (emit) {
      emitPreparedCallbackResult(result);
    }
    return result;
  }
  if (prepared.outcome === "record_only") {
    const result = {
      delivered: false,
      duplicate: false,
      conversation: prepared.conversation,
      message: prepared.message
    };
    if (emit) {
      emitPreparedCallbackResult(result);
    }
    return result;
  }

  try {
    const deliveryKind = deliverCallbackToOpenClaw({
      options: prepared.options,
      statePath: prepared.statePath,
      logPath: prepared.logPath,
      conversation: prepared.conversation,
      message: prepared.message
    });
    const deliveredConversation = prepared.trackCallbackDelivery
      ? settlePreparedCallbackDelivery(prepared, { delivered: true })
      : loadState(prepared.statePath);
    const result = {
      delivered: true,
      duplicate: false,
      conversation: deliveredConversation,
      message: prepared.message,
      delivery: deliveryKind
    };
    if (emit) {
      emitPreparedCallbackResult(result);
    }
    return result;
  } catch (error) {
    if (prepared.trackCallbackDelivery) {
      settlePreparedCallbackDelivery(prepared, { delivered: false, error });
    }
    throw error;
  }
}

function settlePreparedCallbackDelivery(
  prepared,
  result: { delivered: boolean; error?: unknown }
) {
  const releaseLock = acquireFileLock(`${prepared.statePath}.lock`);
  try {
    const current = loadState(prepared.statePath);
    const currentDelivery = isRecord(current.callback_delivery)
      ? current.callback_delivery
      : undefined;
    if (
      !currentDelivery ||
      !isRecord(currentDelivery.message) ||
      currentDelivery.message.id !== prepared.message.id ||
      currentDelivery.attempt_id !== prepared.deliveryAttemptId ||
      Number(currentDelivery.attempts) !== prepared.deliveryAttempt ||
      currentDelivery.status !== "pending"
    ) {
      appendEvent(prepared.logPath, {
        ts: new Date().toISOString(),
        conversation_id: current.conversation_id,
        event: "callback_delivery_settle_skipped",
        message_id: prepared.message.id,
        attempt: prepared.deliveryAttempt,
        result: result.delivered ? "delivered" : "failed",
        reason: "callback delivery claim changed before settlement",
        current_status: current.status
      });
      return current;
    }

    if (result.delivered) {
      const deliveredAt = new Date().toISOString();
      const ownsConversationStatus =
        currentDelivery.preserve_conversation_status !== true &&
        ["callback_pending", "callback_failed"].includes(current.status);
      const deliveredStatus: ConversationStatus = prepared.closeTerminalBridgeOnDone
        ? "closed"
        : prepared.finalStatus;
      const nextConversation = {
        ...current,
        status: ownsConversationStatus ? deliveredStatus : current.status,
        ...(ownsConversationStatus && prepared.closeTerminalBridgeOnDone
          ? {
              closed_at: deliveredAt,
              close_reason: "terminal bridge task completed"
            }
          : {}),
        callback_delivery: {
          ...currentDelivery,
          status: "delivered",
          delivered_at: deliveredAt,
          last_error: undefined
        },
        updated_at: ownsConversationStatus ? deliveredAt : current.updated_at
      };
      if (ownsConversationStatus && deliveredStatus === "idle") {
        nextConversation.idle_since = deliveredAt;
        delete nextConversation.closed_at;
        delete nextConversation.close_reason;
      } else if (ownsConversationStatus) {
        delete nextConversation.idle_since;
      }
      saveState(prepared.statePath, nextConversation);
      appendEvent(prepared.logPath, {
        ts: deliveredAt,
        conversation_id: current.conversation_id,
        event: "callback_delivery_succeeded",
        message_id: prepared.message.id,
        attempt: prepared.deliveryAttempt,
        status: nextConversation.status,
        state_preserved: !ownsConversationStatus
      });
      return nextConversation;
    }

    const failedAt = new Date().toISOString();
    const lastError = result.error instanceof Error
      ? result.error.message
      : String(result.error);
    const ownsConversationStatus =
      currentDelivery.preserve_conversation_status !== true &&
      current.status === "callback_pending";
    const shouldLaunchRetry =
      prepared.options.retryPending !== true &&
      prepared.options.disableCallbackRetry !== true &&
      prepared.deliveryAttempt <= CALLBACK_RETRY_DELAYS_MS.length;
    const retryDelayMs = CALLBACK_RETRY_DELAYS_MS[
      Math.max(0, prepared.deliveryAttempt - 1)
    ];
    const retryMonitor = shouldLaunchRetry
      ? startCallbackRetryMonitor({ statePath: prepared.statePath })
      : undefined;
    const nextAttemptAt = retryMonitor
      ? new Date(Date.now() + retryDelayMs).toISOString()
      : undefined;
    const failedConversation = {
      ...current,
      status: ownsConversationStatus ? "callback_failed" as const : current.status,
      callback_delivery: {
        ...currentDelivery,
        status: "failed",
        failed_at: failedAt,
        last_error: lastError,
        ...(retryMonitor
          ? {
              retry_monitor_pid: retryMonitor.pid ?? null,
              next_attempt_at: nextAttemptAt
            }
          : {})
      },
      updated_at: ownsConversationStatus ? failedAt : current.updated_at
    };
    saveState(prepared.statePath, failedConversation);
    appendEvent(prepared.logPath, {
      ts: failedAt,
      conversation_id: current.conversation_id,
      event: "callback_delivery_failed",
      message_id: prepared.message.id,
      attempt: prepared.deliveryAttempt,
      error: lastError,
      state_preserved: !ownsConversationStatus
    });
    if (retryMonitor) {
      appendEvent(prepared.logPath, {
        ts: new Date().toISOString(),
        conversation_id: current.conversation_id,
        event: "callback_retry_monitor_launched",
        message_id: prepared.message.id,
        pid: retryMonitor.pid ?? null,
        next_attempt_at: nextAttemptAt
      });
    }
    return failedConversation;
  } finally {
    releaseLock();
  }
}

function isRetryableCallbackDelivery(conversation, callbackDelivery): boolean {
  if (
    !isRecord(callbackDelivery) ||
    !isRecord(callbackDelivery.message) ||
    !["pending", "failed"].includes(String(callbackDelivery.status ?? ""))
  ) {
    return false;
  }
  if (
    callbackDelivery.preserve_conversation_status !== true &&
    !["callback_pending", "callback_failed"].includes(conversation.status)
  ) {
    return false;
  }
  const attemptPidValue = Number(callbackDelivery.attempt_pid);
  const attemptPid = Number.isSafeInteger(attemptPidValue) && attemptPidValue > 0
    ? attemptPidValue
    : undefined;
  return callbackDelivery.status === "failed" ||
    attemptPid === undefined ||
    !isProcessAlive(attemptPid);
}

function deliverCallbackToOpenClaw({ options, statePath, logPath, conversation, message }): string {
  if (options.gatewayMethod) {
    const delivery = deliverToGatewayMethod({
      method: options.gatewayMethod,
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      sessionKey: options.gatewaySession ?? options.openclawSession ?? conversation.openclaw_session,
      statePath,
      logPath,
      conversation,
      message
    });
    recordCallbackProcessDelivery({
      logPath,
      conversation,
      message,
      event: "callback_gateway_method_delivery",
      runtimeEvent: "callback_gateway_method_delivery",
      delivery,
      detail: { method: options.gatewayMethod }
    });
    if (delivery.status !== 0) {
      throw new Error(delivery.stderr || delivery.stdout || `gateway method delivery failed with status ${delivery.status}`);
    }

    const gatewayPayload = parseRequiredGatewayDeliveryPayload(delivery.stdout);
    const { chatSendParams, sessionSendParams } =
      parseGatewayCallbackDeliveryPlan(gatewayPayload);
    if (chatSendParams) {
      const chatSendDelivery = deliverToChatSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: chatSendParams
      });
      if (chatSendDelivery.status !== 0) {
        recordCallbackProcessDelivery({
          logPath,
          conversation,
          message,
          event: "callback_chat_send_delivery",
          runtimeEvent: "callback_chat_send_delivery",
          delivery: chatSendDelivery
        });
        throw new Error(chatSendDelivery.stderr || chatSendDelivery.stdout || `chat callback delivery failed with status ${chatSendDelivery.status}`);
      }
      const chatSendAck = parseChatSendAcknowledgement(
        chatSendDelivery.stdout,
        String(chatSendParams.idempotencyKey)
      );
      recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_chat_send_delivery",
        runtimeEvent: "callback_chat_send_delivery",
        delivery: chatSendDelivery,
        detail: {
          run_id: chatSendAck.runId,
          run_status: chatSendAck.status
        }
      });
      if (chatSendAck.status === "ok") {
        return "gateway_method+chat_send";
      }
      const agentWaitDelivery = deliverToAgentWait({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        runId: chatSendAck.runId
      });
      if (agentWaitDelivery.status !== 0) {
        recordCallbackProcessDelivery({
          logPath,
          conversation,
          message,
          event: "callback_agent_wait_delivery",
          runtimeEvent: "callback_agent_wait_delivery",
          delivery: agentWaitDelivery,
          detail: { run_id: chatSendAck.runId }
        });
        throw new Error(
          agentWaitDelivery.stderr ||
          agentWaitDelivery.stdout ||
          `callback agent wait failed with status ${agentWaitDelivery.status}`
        );
      }
      const waitResult = parseAgentWaitResult(agentWaitDelivery.stdout, chatSendAck.runId);
      recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_agent_wait_delivery",
        runtimeEvent: "callback_agent_wait_delivery",
        delivery: agentWaitDelivery,
        detail: {
          run_id: chatSendAck.runId,
          run_status: waitResult.status
        }
      });
      if (waitResult.status !== "ok") {
        const detail = stringValue(waitResult.error) ??
          stringValue(waitResult.stopReason) ??
          `agent.wait returned ${String(waitResult.status)}`;
        throw new Error(`callback Gateway run did not complete successfully: ${detail}`);
      }
      return "gateway_method+chat_send";
    }
    if (sessionSendParams) {
      const sessionSendDelivery = deliverToSessionSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: sessionSendParams
      });
      if (sessionSendDelivery.status !== 0) {
        recordCallbackProcessDelivery({
          logPath,
          conversation,
          message,
          event: "callback_session_send_delivery",
          runtimeEvent: "callback_session_send_delivery",
          delivery: sessionSendDelivery
        });
        throw new Error(sessionSendDelivery.stderr || sessionSendDelivery.stdout || `session callback delivery failed with status ${sessionSendDelivery.status}`);
      }
      const sessionSendAck = parseChatSendAcknowledgement(
        sessionSendDelivery.stdout,
        String(sessionSendParams.idempotencyKey)
      );
      recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_session_send_delivery",
        runtimeEvent: "callback_session_send_delivery",
        delivery: sessionSendDelivery,
        detail: {
          run_id: sessionSendAck.runId,
          run_status: sessionSendAck.status
        }
      });
      if (sessionSendAck.status !== "ok") {
        const agentWaitDelivery = deliverToAgentWait({
          openclawBin: options.openclawBin,
          gatewayUrl: options.gatewayUrl,
          token: options.token,
          runId: sessionSendAck.runId
        });
        if (agentWaitDelivery.status !== 0) {
          recordCallbackProcessDelivery({
            logPath,
            conversation,
            message,
            event: "callback_agent_wait_delivery",
            runtimeEvent: "callback_agent_wait_delivery",
            delivery: agentWaitDelivery,
            detail: { run_id: sessionSendAck.runId }
          });
          throw new Error(
            agentWaitDelivery.stderr ||
            agentWaitDelivery.stdout ||
            `callback agent wait failed with status ${agentWaitDelivery.status}`
          );
        }
        const waitResult = parseAgentWaitResult(
          agentWaitDelivery.stdout,
          sessionSendAck.runId
        );
        recordCallbackProcessDelivery({
          logPath,
          conversation,
          message,
          event: "callback_agent_wait_delivery",
          runtimeEvent: "callback_agent_wait_delivery",
          delivery: agentWaitDelivery,
          detail: {
            run_id: sessionSendAck.runId,
            run_status: waitResult.status
          }
        });
        if (waitResult.status !== "ok") {
          const detail = stringValue(waitResult.error) ??
            stringValue(waitResult.stopReason) ??
            `agent.wait returned ${String(waitResult.status)}`;
          throw new Error(
            `callback Gateway run did not complete successfully: ${detail}`
          );
        }
      }
      return "gateway_method+sessions_send";
    }
    return "gateway_method";
  }

  throw new Error(
    "callback delivery requires a configured OpenClaw gateway method"
  );
}

function recordCallbackProcessDelivery({ logPath, conversation, message, event, runtimeEvent, delivery, detail = {} }) {
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event,
    from: message.from,
    to: "openclaw",
    round: message.round,
    ...detail,
    status: delivery.status,
    stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  runtimeLog("info", runtimeEvent, {
    conversation_id: conversation.conversation_id,
    ...detail,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });
}

function acquireFileLock(lockPath, { timeoutMs = 5000, retryMs = 50 } = {}) {
  const started = Date.now();
  const token = randomUUID();

  while (true) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_WRONLY |
          NO_FOLLOW_FLAG,
        PRIVATE_LOCK_FILE_MODE
      );
      fs.fchmodSync(fd, PRIVATE_LOCK_FILE_MODE);
      fs.writeFileSync(
        fd,
        `${JSON.stringify({
          pid: process.pid,
          token,
          created_at: new Date().toISOString()
        })}\n`,
        "utf8"
      );
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      return () => releaseFileLock(lockPath, token);
    } catch (error) {
      if (fd !== undefined) {
        fs.closeSync(fd);
      }
      if (!isRecord(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (reclaimStaleFileLock(lockPath)) {
        continue;
      }
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(
          new Error(`timed out waiting for file lock: ${lockPath}`),
          { code: "LOCK_TIMEOUT" }
        );
      }
      sleepSync(retryMs);
    }
  }
}

function staleFileLock(lockPath: string): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`file lock must be a regular file, not a symlink: ${lockPath}`);
    }
    const owner = readFileLockOwner(lockPath);
    if (owner.pid !== undefined) {
      try {
        process.kill(owner.pid, 0);
        return false;
      } catch (error) {
        return isRecord(error) && error.code === "ESRCH";
      }
    }
    return Date.now() - stat.mtimeMs > 30_000;
  } catch (error) {
    return isRecord(error) && error.code === "ENOENT";
  }
}

function reclaimStaleFileLock(lockPath: string): boolean {
  const reclaimPath = `${lockPath}.reclaim`;
  let reclaimFd: number | undefined;
  try {
    reclaimFd = fs.openSync(
      reclaimPath,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        NO_FOLLOW_FLAG,
      PRIVATE_LOCK_FILE_MODE
    );
    fs.fchmodSync(reclaimFd, PRIVATE_LOCK_FILE_MODE);
    fs.writeFileSync(reclaimFd, `${process.pid}\n`, "utf8");
    fs.fsyncSync(reclaimFd);
  } catch (error) {
    if (reclaimFd !== undefined) {
      fs.closeSync(reclaimFd);
    }
    if (isRecord(error) && error.code === "EEXIST") {
      return false;
    }
    throw error;
  }

  try {
    if (!staleFileLock(lockPath)) {
      return false;
    }
    try {
      fs.unlinkSync(lockPath);
      return true;
    } catch (error) {
      return isRecord(error) && error.code === "ENOENT";
    }
  } finally {
    fs.closeSync(reclaimFd);
    try {
      fs.unlinkSync(reclaimPath);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function releaseFileLock(lockPath: string, token: string): void {
  try {
    if (readFileLockOwner(lockPath).token !== token) {
      return;
    }
    fs.unlinkSync(lockPath);
  } catch (error) {
    if (!isRecord(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

function readFileLockOwner(lockPath: string): { pid?: number; token?: string } {
  try {
    const text = fs.readFileSync(lockPath, "utf8").trim();
    try {
      const owner = JSON.parse(text);
      if (isRecord(owner)) {
        const pid = Number(owner.pid);
        return {
          pid: Number.isSafeInteger(pid) && pid > 1 ? pid : undefined,
          token: stringValue(owner.token)
        };
      }
    } catch {
      // Legacy locks contained only the owner PID.
    }
    const legacyPid = Number(text);
    return {
      pid: Number.isSafeInteger(legacyPid) && legacyPid > 1
        ? legacyPid
        : undefined
    };
  } catch {
    return {};
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readExistingEvents(logPath) {
  try {
    return readNdjsonLog(logPath);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function loadConversationFromOptions(options) {
  const storeDir = storeDirFromOptions(options);
  const conversationId = options.conversation ?? options.conversationId;
  const statePath = expandHome(options.state ?? (conversationId ? statePathForConversationId(conversationId, storeDir) : undefined));
  if (!statePath) {
    throw new Error("--conversation or --state is required");
  }

  const conversation = options.state
    ? loadState(statePath)
    : loadConversationById(conversationId, storeDir);
  assertConfiguredWorkspace(
    options.workspace,
    conversation.workspace,
    `access to AKK conversation ${conversation.conversation_id}`
  );
  return {
    conversation,
    statePath,
    logPath: logPathForStatePath(statePath)
  };
}

function storeDirFromOptions(options) {
  return expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(process.cwd()));
}

function summarizeConversation(conversation) {
  const executor = executorForConversation(conversation);
  return {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor,
    session: executor.session,
    status: conversation.status,
    request: conversation.user_request,
    workspace: conversation.workspace,
    openclaw_session: conversation.openclaw_session,
    response_rounds_used: conversation.response_rounds_used,
    soft_limit: conversation.soft_limit,
    hard_limit: conversation.hard_limit,
    created_at: conversation.created_at,
    updated_at: conversation.updated_at,
    idle_since: conversation.idle_since,
    closed_at: conversation.closed_at,
    state_path: conversation.state_path,
    event_log_path: conversation.event_log_path
  };
}

function isDiscoverableTmuxConversation(conversation): boolean {
  if (!isRecord(conversation)) {
    return false;
  }
  if (!isRecord(conversation.executor)) {
    return false;
  }
  const kind = stringValue(conversation.executor.kind)?.toLowerCase();
  return (
    kind !== undefined &&
    isExecutorKind(kind) &&
    conversation.executor.transport === "tmux"
  );
}

function persistedExecutorLogFields(conversation): {
  agent: string;
  executor_session?: string;
} {
  if (isDiscoverableTmuxConversation(conversation)) {
    const executor = executorForConversation(conversation);
    return {
      agent: executor.kind,
      executor_session: executor.session
    };
  }
  const rawExecutor = isRecord(conversation?.executor)
    ? conversation.executor
    : {};
  return {
    agent: stringValue(rawExecutor.kind) ?? "unsupported",
    executor_session: stringValue(rawExecutor.session)
  };
}

function summarizeEvent(event) {
  return {
    ts: event.ts,
    event: event.event,
    from: event.from,
    to: event.to,
    type: event.type,
    status: event.status,
    round: event.round,
    body: typeof event.body === "string" ? event.body.slice(0, 500) : undefined
  };
}

async function activeCodexProcessForPid(options, pid: number | undefined): Promise<ActiveCodexProcess | undefined> {
  if (!Number.isInteger(pid)) {
    return undefined;
  }
  const provider = createAgentSessionProvider("codex", options);
  const activeSessions = await listActiveSessionsWithTerminalControl(provider, options);
  return activeSessions.find((process) => process.pid === pid);
}

async function codexTerminalStatusContext({
  id,
  process,
  options,
  terminalControl,
  terminalStatus
}: {
  id: string;
  process?: ActiveCodexProcess;
  options: Record<string, any>;
  terminalControl?: TerminalControlRef;
  terminalStatus?: Record<string, any>;
}) {
  const provider = createAgentSessionProvider("codex", options);
  const directSessionId = process?.sessionId;
  if (directSessionId) {
    const context = await provider.getForkContext({
      sessionId: directSessionId,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (context) {
      return codexTerminalContextFromHistory({
        id,
        confidence: "high",
        match: "session_id",
        process,
        context,
        terminalControl,
        terminalStatus,
        limitations: []
      });
    }
  }

  const cwd = process?.cwd ?? terminalControl?.currentPath;
  const sessions = (await provider.listHistoricalSessions())
    .filter((session) => session.cwd === cwd)
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  if (sessions.length > 0) {
    const selected = sessions[0];
    const context = await provider.getForkContext({
      sessionId: selected.id,
      maxMessages: Number(options.maxMessages ?? 16),
      maxCommands: Number(options.maxCommands ?? 10),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (context) {
      return codexTerminalContextFromHistory({
        id,
        confidence: sessions.length === 1 ? "medium" : "low",
        match: sessions.length === 1 ? "cwd" : "cwd_latest",
        process,
        context,
        terminalControl,
        terminalStatus,
        limitations: sessions.length === 1
          ? ["Codex session inferred from matching cwd because the active process did not expose a session id."]
          : [`Codex session inferred from the most recent of ${sessions.length} sessions with the same cwd.`],
        candidates: sessions.slice(0, 5).map((session) => ({
          session_id: session.id,
          cwd: session.cwd,
          title: session.title ?? session.preview ?? session.firstUserMessage,
          updated_at_ms: session.updatedAtMs,
          capability: session.capability
        }))
      });
    }
  }

  return {
    conversation_id: id,
    source: "terminal_control",
    confidence: "screen_only",
    match: "terminal_screen",
    about: screenOnlyAbout({ process, terminalStatus }),
    evidence: {
      process,
      terminal_control: terminalControl,
      terminal_status: terminalStatus
    },
    limitations: [
      "No exact Codex session id was available.",
      cwd ? "No matching Codex rollout history was found for this cwd." : "No process cwd was available for Codex history matching.",
      "Summary is limited to active process metadata and the visible terminal screen."
    ]
  };
}

function codexTerminalContextFromHistory({
  id,
  confidence,
  match,
  process,
  context,
  terminalControl,
  terminalStatus,
  limitations,
  candidates
}: {
  id: string;
  confidence: "high" | "medium" | "low";
  match: string;
  process?: ActiveCodexProcess;
  context: ForkContextPackage;
  terminalControl?: TerminalControlRef;
  terminalStatus?: Record<string, any>;
  limitations: string[];
  candidates?: Record<string, any>[];
}) {
  return {
    conversation_id: id,
    source: "terminal_control",
    confidence,
    match,
    about: rolloutAbout(context, terminalStatus),
    codex_session: context.source,
    evidence: {
      process,
      terminal_control: terminalControl,
      terminal_status: terminalStatus,
      initial_request: bestSessionIntent(context),
      title: context.source.title,
      recent_messages: visibleRolloutMessages(context).slice(-8),
      recent_commands: context.commands.slice(-8),
      candidates
    },
    limitations
  };
}

function managedConversationAbout(conversation, events, terminalStatus?: Record<string, any>): string {
  const request = truncateText(String(conversation.user_request ?? "").trim(), 220);
  const recent = recentMessageEvidence(events).at(-1)?.body;
  const parts = [
    request ? `Initial request: ${request}` : undefined,
    recent ? `Latest visible message: ${truncateText(recent, 180)}` : undefined,
    terminalStatus?.activity_state ? `Current terminal state: ${terminalStatus.activity_state}.` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "No durable task content is available for this AKK-managed session.";
}

function rolloutAbout(context: ForkContextPackage, terminalStatus?: Record<string, any>): string {
  const title = truncateText(String(context.source.title ?? "").trim(), 180);
  const intent = bestSessionIntent(context);
  const latestAssistant = [...visibleRolloutMessages(context)].reverse().find((message) => message.role === "assistant")?.text;
  const latestCommand = context.commands.at(-1)?.command;
  const parts = [
    intent ? `Initial request: ${truncateText(intent, 220)}` : title ? `Codex title: ${title}` : undefined,
    latestAssistant ? `Latest visible progress: ${truncateText(latestAssistant, 180)}` : undefined,
    latestCommand ? `Recent command: ${truncateText(latestCommand, 140)}` : undefined,
    terminalStatus?.activity_state ? `Current terminal state: ${terminalStatus.activity_state}.` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Codex history was found, but it did not include enough visible message content to summarize the session.";
}

function screenOnlyAbout({ process, terminalStatus }: { process?: ActiveCodexProcess; terminalStatus?: Record<string, any> }): string {
  const activity = terminalStatus?.activity_reason ?? terminalStatus?.activity_state;
  const excerpt = terminalStatus?.screen?.excerpt;
  const parts = [
    process?.cwd ? `This Codex process is running in ${process.cwd}.` : undefined,
    activity ? `Terminal activity: ${truncateText(String(activity), 180)}` : undefined,
    excerpt ? `Visible screen: ${truncateText(String(excerpt), 220)}` : undefined
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "Only active process metadata is available; no Codex conversation history or terminal screen content could be read.";
}

function bestSessionIntent(context: ForkContextPackage): string | undefined {
  const firstUser = visibleRolloutMessages(context).find((message) => message.role === "user")?.text;
  if (firstUser) {
    return firstUser;
  }
  const title = cleanIntentText(context.source.title);
  if (title) {
    return title;
  }
  return undefined;
}

function visibleRolloutMessages(context: ForkContextPackage) {
  return context.messages.filter((message) => !isEnvironmentContextMessage(message.text));
}

function cleanIntentText(value: string | undefined): string | undefined {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text && !isEnvironmentContextMessage(text) ? text : undefined;
}

function isEnvironmentContextMessage(value: string | undefined): boolean {
  return /^\s*<environment_context[\s>]/u.test(String(value ?? ""));
}

function recentMessageEvidence(events) {
  return events
    .filter((event) => event.event === "message" && typeof event.body === "string")
    .slice(-8)
    .map((event) => ({
      ts: event.ts,
      from: event.from,
      to: event.to,
      type: event.type,
      round: event.round,
      body: truncateText(event.body, 800)
    }));
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function buildConversationTrace({ conversation, events, logPath }) {
  const outputPath = traceOutputPath({ conversation, events, logPath });
  const output = outputPath && fs.existsSync(outputPath)
    ? fs.readFileSync(outputPath, "utf8").slice(-256 * 1024)
    : "";
  const parsed = parseExecutorTraceOutput(output);
  const monitorEvents = events
    .filter((event) => [
      "executor_launch",
      "executor_message_launch",
      "executor_monitor_launch",
      "executor_monitor_started",
      "conversation_stalled",
      "callback_delivery",
      "callback_gateway_method_delivery",
      "callback_chat_send_delivery",
      "callback_session_send_delivery"
    ].includes(event.event))
    .slice(-20)
    .map((event) => ({
      ts: event.ts,
      event: event.event,
      status: event.status,
      pid: event.pid,
      executor_pid: event.executor_pid,
      reason: event.reason,
      output_path: event.output_path
    }));

  return {
    source: output ? "executor_output_log" : "events_only",
    output_path: outputPath,
    thinking_redacted_count: parsed.thinkingRedactedCount,
    client_events: parsed.clientEvents.slice(-20),
    permission_requests: parsed.permissionRequests.slice(-10),
    tool_calls: parsed.toolCalls.slice(-20),
    agent_messages: parsed.agentMessages.slice(-8),
    done_events: parsed.doneEvents.slice(-5),
    monitor_events: monitorEvents,
    safety: {
      thinking: "redacted",
      tool_output: "summarized",
      callback_payloads: "redacted"
    }
  };
}

function traceOutputPath({ conversation, events, logPath }) {
  const launch = [...events].reverse().find((event) =>
    ["executor_message_launch", "executor_launch"].includes(event.event) &&
    typeof event.output_path === "string"
  );
  if (launch?.output_path) {
    return launch.output_path;
  }

  const executor = executorForConversation(conversation);
  const conversationDir = conversation.conversation_dir ?? path.dirname(logPath);
  const candidates = [
    path.join(conversationDir, `${executor.kind}-followup-output.log`),
    path.join(conversationDir, `${executor.kind}-output.log`)
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates.at(-1);
}

function parseExecutorTraceOutput(output) {
  const toolCalls: Record<string, any>[] = [];
  const clientEvents: Record<string, any>[] = [];
  const permissionRequests: Record<string, any>[] = [];
  const agentMessages: Record<string, any>[] = [];
  const doneEvents: Record<string, any>[] = [];
  let thinkingRedactedCount = 0;
  let currentTool: Record<string, any> | null = null;
  let captureOutputFor: Record<string, any> | null = null;
  let capturedOutputLines: string[] = [];

  const flushToolOutput = () => {
    if (captureOutputFor && capturedOutputLines.length > 0) {
      captureOutputFor.output_preview = sanitizeTraceText(capturedOutputLines.join("\n"), 500);
    }
    captureOutputFor = null;
    capturedOutputLines = [];
  };

  for (const rawLine of String(output ?? "").split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const text = line.trim();
    if (!text) {
      continue;
    }

    if (text.startsWith("[") && captureOutputFor) {
      flushToolOutput();
    }

    const client = text.match(/^\[client\]\s+(.+?)(?:\s+\(([^)]+)\))?$/);
    if (client) {
      if (isPermissionTraceLine(text)) {
        permissionRequests.push({
          body: sanitizeTraceText(text, 240)
        });
      }
      clientEvents.push({
        name: sanitizeTraceText(client[1], 160),
        status: client[2] ? sanitizeTraceText(client[2], 80) : undefined
      });
      continue;
    }

    if (text.startsWith("[thinking]")) {
      thinkingRedactedCount += 1;
      agentMessages.push({
        kind: "thinking",
        body: "[redacted]"
      });
      continue;
    }

    const done = text.match(/^\[done\]\s*(.*)$/);
    if (done) {
      doneEvents.push({
        status: sanitizeTraceText(done[1] || "done", 120)
      });
      continue;
    }

    const tool = text.match(/^\[tool\]\s+(.+?)\s+\(([^)]+)\)$/);
    if (tool) {
      const toolCall = {
        name: sanitizeToolName(tool[1]),
        status: sanitizeTraceText(tool[2], 80)
      };
      toolCalls.push(toolCall);
      currentTool = toolCall;
      continue;
    }

    if (currentTool && text.startsWith("input:")) {
      currentTool.input_preview = sanitizeTraceText(text.slice("input:".length).trim(), 360);
      continue;
    }

    if (currentTool && text.startsWith("output:")) {
      captureOutputFor = currentTool;
      capturedOutputLines = [];
      continue;
    }

    if (captureOutputFor && !text.startsWith("[")) {
      if (capturedOutputLines.length < 8) {
        capturedOutputLines.push(text);
      }
      continue;
    }

    if (isPermissionTraceLine(text)) {
      permissionRequests.push({
        body: sanitizeTraceText(text, 240)
      });
      continue;
    }

    if (isAgentMessageTraceLine(text)) {
      agentMessages.push({
        kind: "message",
        body: sanitizeTraceText(text, 360)
      });
    }
  }

  flushToolOutput();

  return {
    toolCalls,
    clientEvents,
    permissionRequests,
    agentMessages,
    doneEvents,
    thinkingRedactedCount
  };
}

function sanitizeToolName(value) {
  return sanitizeTraceText(
    String(value ?? "")
      .replace(/--message-json\s+(['"]).*?\1/g, "--message-json <redacted>")
      .replace(/--message-json\s+.*/g, "--message-json <redacted>")
      .replace(/--token\s+\S+/g, "--token <redacted>"),
    220
  );
}

function sanitizeTraceText(value, maxLength = 240) {
  return String(value ?? "")
    .replace(/--message-json\s+(['"]).*?\1/g, "--message-json <redacted>")
    .replace(/--message-json\s+.*/g, "--message-json <redacted>")
    .replace(/--token\s+\S+/g, "--token <redacted>")
    .replace(/(gateway[_-]?token|api[_-]?key|token|password|secret)=\S+/gi, "$1=<redacted>")
    .slice(0, maxLength);
}

function isPermissionTraceLine(text) {
  const lower = text.toLowerCase();
  return lower.includes("session/request_permission") ||
    (lower.includes("permission") && (lower.includes("request") || lower.includes("approve") || lower.includes("allow")));
}

function isAgentMessageTraceLine(text) {
  if (text.startsWith("[") || text.startsWith("{") || text.startsWith("}") || text.startsWith("```")) {
    return false;
  }
  if (text.startsWith("input:") || text.startsWith("output:") || text.startsWith("kind:")) {
    return false;
  }
  if (/^(call_id|process_id|turn_id|command|cwd):/i.test(text)) {
    return false;
  }
  return text.length >= 12;
}

function isActiveStatus(status) {
  return !["done", "failed", "closed", "cancelled"].includes(status);
}

function isWaitingForAgent(status) {
  return ["created", "running", "waiting_for_agent", "cancelling"].includes(status);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return !isZombieProcess(pid);
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isZombieProcess(pid) {
  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8"
  });
  if (result.status !== 0) {
    return false;
  }

  return result.stdout.trim().toUpperCase().startsWith("Z");
}

function markConversationStalled({ statePath, logPath, reason, detail = {} }) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  let stalledConversation;
  let stalledMessage;
  try {
    const conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "executor_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_changed_before_stall"
      });
      return conversation;
    }

    const now = new Date().toISOString();
    const executor = executorForConversation(conversation);
    const terminalBridge = terminalBridgeEnabled(conversation);
    const shouldNotify = Boolean(conversation.gateway_method && !conversation.stalled_notification_sent_at);
    stalledMessage = shouldNotify
      ? createMessage({
          conversation,
          from: executor.actor,
          to: "openclaw",
          type: "error",
          requiresResponse: false,
          body: [
            `AKK marked this ${executor.display_name} task as stalled: ${reason}.`,
            "",
            `Conversation: ${conversation.conversation_id}`,
            `Session: ${executor.session}`,
            terminalBridge
              ? `Use \`AKK status ${conversation.conversation_id}\` for details, \`AKK renew ${conversation.conversation_id}\` to resume monitoring without sending another task, or \`AKK close ${conversation.conversation_id}\` to close it.`
              : "Use `AKK status` for details, `AKK send` to retry/follow up, or `AKK close` to close it."
          ].join("\n")
        })
      : undefined;
    stalledConversation = {
      ...conversation,
      status: "stalled" as const,
      stalled_at: now,
      stalled_reason: reason,
      stalled_notification_sent_at: shouldNotify ? now : conversation.stalled_notification_sent_at,
      stalled_notification_message_id: stalledMessage?.id ?? conversation.stalled_notification_message_id,
      updated_at: now
    };
    saveState(statePath, stalledConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "conversation_stalled",
      status: "stalled",
      reason,
      ...detail
    });
    runtimeLog("warn", "conversation_stalled", {
      conversation_id: conversation.conversation_id,
      agent: executorForConversation(conversation).kind,
      executor_session: executorForConversation(conversation).session,
      state_path: statePath,
      event_log_path: logPath,
      reason,
      ...detail
    });
  } finally {
    releaseLock();
  }

  if (stalledConversation && stalledMessage) {
    deliverStalledNotification({
      statePath,
      logPath,
      conversation: stalledConversation,
      message: stalledMessage
    });
  }
  return stalledConversation;
}

function deliverStalledNotification({ statePath, logPath, conversation, message, eventPrefix = "stalled" }) {
  if (!conversation.gateway_method) {
    return;
  }

  const gatewayToken = conversation.gateway_token;
  const gatewayUrl = gatewayToken ? conversation.gateway_url : undefined;
  const delivery = deliverToGatewayMethod({
    method: conversation.gateway_method,
    openclawBin: conversation.openclaw_bin,
    gatewayUrl,
    token: gatewayToken,
    sessionKey: conversation.gateway_session ?? conversation.openclaw_session,
    statePath,
    logPath,
    conversation,
    message
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: `${eventPrefix}_gateway_method_delivery`,
    method: conversation.gateway_method,
    message_id: message.id,
    status: delivery.status,
    stdout: redactString(delivery.stdout),
    stderr: redactString(delivery.stderr)
  });
  runtimeLog("info", `${eventPrefix}_gateway_method_delivery`, {
    conversation_id: conversation.conversation_id,
    method: conversation.gateway_method,
    message_id: message.id,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });
  if (delivery.status !== 0) {
    return;
  }

  const gatewayPayload = parseOptionalJson(delivery.stdout);
  const chatSendParams = isRecord(gatewayPayload?.chat_send) ? gatewayPayload.chat_send : undefined;
  if (!chatSendParams) {
    return;
  }

  const chatSendDelivery = deliverToChatSend({
    openclawBin: conversation.openclaw_bin,
    gatewayUrl,
    token: gatewayToken,
    params: chatSendParams
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: `${eventPrefix}_chat_send_delivery`,
    message_id: message.id,
    status: chatSendDelivery.status,
    stdout: redactString(chatSendDelivery.stdout),
    stderr: redactString(chatSendDelivery.stderr)
  });
  runtimeLog("info", `${eventPrefix}_chat_send_delivery`, {
    conversation_id: conversation.conversation_id,
    message_id: message.id,
    status: chatSendDelivery.status,
    failure_kind: classifyProcessFailure(chatSendDelivery),
    stdout: textSummary(chatSendDelivery.stdout),
    stderr: textSummary(chatSendDelivery.stderr)
  });
}

function cleanupIdleConversations(storeDir, options: Record<string, any> = {}, now = new Date()) {
  const timeoutMinutes = Number(options.idleTimeoutMinutes ?? DEFAULT_IDLE_TIMEOUT_MINUTES);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    return { checked: 0, closed: 0, idle_timeout_minutes: timeoutMinutes };
  }

  const conversations = listConversations(storeDir);
  let closed = 0;
  for (const listedConversation of conversations) {
    if (listedConversation.status !== "idle" || !listedConversation.idle_since) {
      continue;
    }

    const listedIdleSinceMs = Date.parse(listedConversation.idle_since);
    if (!Number.isFinite(listedIdleSinceMs)) {
      continue;
    }
    if (now.getTime() - listedIdleSinceMs < timeoutMinutes * 60 * 1000) {
      continue;
    }

    const statePath = listedConversation.state_path ??
      statePathForConversationId(listedConversation.conversation_id, storeDir);
    let releaseStateLock: (() => void) | undefined;
    try {
      releaseStateLock = acquireFileLock(`${statePath}.lock`);
    } catch (error) {
      if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
        continue;
      }
      throw error;
    }
    try {
      const conversation = loadState(statePath);
      if (conversation.status !== "idle" || !conversation.idle_since) {
        continue;
      }

      const idleSinceMs = Date.parse(conversation.idle_since);
      if (!Number.isFinite(idleSinceMs)) {
        continue;
      }

      const terminalBridge = terminalBridgeEnabled(conversation) &&
        isRecord(conversation.native_session_takeover) &&
        typeof conversation.native_session_takeover.terminal_bridge_message_id === "string";
      if (now.getTime() - idleSinceMs < timeoutMinutes * 60 * 1000) {
        continue;
      }

      const logPath = conversation.event_log_path ?? logPathForStatePath(statePath);
      const closeReason = `idle timeout after ${timeoutMinutes} minutes`;
      const closedConversation = {
        ...conversation,
        status: "closed" as const,
        closed_at: now.toISOString(),
        close_reason: closeReason,
        updated_at: now.toISOString()
      };
      delete closedConversation.idle_since;
      saveState(statePath, closedConversation);
      appendEvent(logPath, {
        ts: now.toISOString(),
        conversation_id: conversation.conversation_id,
        event: "conversation_closed",
        status: "closed",
        reason: closedConversation.close_reason,
        idle_timeout_minutes: timeoutMinutes,
        terminal_bridge: terminalBridge
      });
      const executorLogFields = persistedExecutorLogFields(conversation);
      runtimeLog("info", "idle_conversation_closed", {
        conversation_id: conversation.conversation_id,
        ...executorLogFields,
        state_path: statePath,
        event_log_path: logPath,
        idle_since: conversation.idle_since,
        idle_timeout_minutes: timeoutMinutes,
        reason: closedConversation.close_reason
      });
      closed += 1;
    } finally {
      releaseStateLock();
    }
  }

  return {
    checked: conversations.length,
    closed,
    idle_timeout_minutes: timeoutMinutes
  };
}

function isDuplicateMessage(events, message) {
  return events.some((event) => {
    if (event.event !== "message") {
      return false;
    }

    const existing = event.message ?? event;
    if (existing.id && existing.id === message.id) {
      return true;
    }

    return messageFingerprint(existing) === messageFingerprint(message);
  });
}

function exactLoggedMessageForRecovery(events, message): boolean {
  const matchingId = events
    .filter((event) => event.event === "message")
    .map((event) => event.message ?? event)
    .filter((existing) => existing.id === message.id);
  if (matchingId.length === 0) {
    return false;
  }
  if (
    matchingId.length !== 1 ||
    canonicalJson(matchingId[0]) !== canonicalJson(message)
  ) {
    throw new Error(
      `callback recovery message ${message.id} conflicts with its logged payload`
    );
  }
  return true;
}

function canonicalJson(value): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function messageFingerprint(message) {
  return JSON.stringify({
    conversation_id: message.conversation_id,
    from: message.from,
    to: message.to,
    type: message.type,
    requires_response: message.requires_response,
    body: message.body
  });
}

function deliverToGatewayMethod({ method, openclawBin, gatewayUrl, token, sessionKey, statePath, logPath, conversation, message }) {
  const args = [
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify({
      sessionKey,
      statePath,
      logPath,
      conversation: redactCliOutput(conversation),
      message
    }),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: openClawGatewayEnvironment(token)
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function deliverToSessionSend({ openclawBin, gatewayUrl, token, params }) {
  const args = [
    "gateway",
    "call",
    "sessions.send",
    "--params",
    JSON.stringify(params),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: openClawGatewayEnvironment(token)
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function deliverToChatSend({ openclawBin, gatewayUrl, token, params }) {
  const args = [
    "gateway",
    "call",
    "chat.send",
    "--params",
    JSON.stringify(params),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    timeout: CALLBACK_DELIVERY_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: openClawGatewayEnvironment(token)
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function deliverToAgentWait({ openclawBin, gatewayUrl, token, runId }) {
  const args = [
    "gateway",
    "call",
    "agent.wait",
    "--params",
    JSON.stringify({
      runId,
      timeoutMs: CALLBACK_AGENT_WAIT_TIMEOUT_MS
    }),
    "--json",
    "--timeout",
    String(CALLBACK_AGENT_WAIT_CLI_TIMEOUT_MS)
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    timeout: CALLBACK_AGENT_WAIT_PROCESS_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: openClawGatewayEnvironment(token)
  });

  if (result.error) {
    return {
      status: 1,
      stdout: result.stdout ?? "",
      stderr: result.error.message
    };
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function openClawGatewayEnvironment(token): NodeJS.ProcessEnv {
  if (!token || token === "<token>") {
    return process.env;
  }
  return {
    ...process.env,
    OPENCLAW_GATEWAY_TOKEN: token
  };
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      throw new Error(`unexpected argument: ${arg}`);
    }

    const key = toCamelCase(arg.slice(2));
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

function required(value, message) {
  if (value === undefined || value === "") {
    throw new Error(message);
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function parseOptionalJson(text) {
  try {
    return JSON.parse(String(text));
  } catch {
    return undefined;
  }
}

function parseRequiredGatewayDeliveryPayload(text): Record<string, unknown> {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("gateway callback returned malformed JSON");
  }
  if (payload.ok !== true) {
    throw new Error(
      `gateway callback was not accepted: ${
        stringValue(payload.error) ?? stringValue(payload.message) ?? "ok was not true"
      }`
    );
  }
  if (
    payload.delivery_required !== undefined &&
    typeof payload.delivery_required !== "boolean"
  ) {
    throw new Error("gateway callback returned an invalid delivery_required value");
  }
  return payload;
}

function parseGatewayCallbackDeliveryPlan(payload: Record<string, unknown>): {
  chatSendParams?: Record<string, unknown>;
  sessionSendParams?: Record<string, unknown>;
} {
  const chatSendParams = isRecord(payload.chat_send) ? payload.chat_send : undefined;
  const sessionSendParams = isRecord(payload.session_send) ? payload.session_send : undefined;
  if (chatSendParams && sessionSendParams) {
    throw new Error("gateway callback returned multiple delivery plans");
  }

  const deliveryRequired = payload.delivery_required === true;
  const deliveryExplicitlyNotRequired = payload.delivery_required === false;
  const deliveryMode = stringValue(payload.delivery_mode);
  if (deliveryRequired && !chatSendParams && !sessionSendParams) {
    throw new Error(
      "gateway callback requires delivery but returned no supported chat_send or session_send plan"
    );
  }
  if (deliveryExplicitlyNotRequired && (chatSendParams || sessionSendParams)) {
    throw new Error("gateway callback returned a delivery plan without delivery_required");
  }
  if (deliveryMode && deliveryMode !== "none") {
    const expectedMode = chatSendParams ? "chat.send" : sessionSendParams ? "sessions.send" : undefined;
    if (deliveryMode !== expectedMode) {
      throw new Error("gateway callback delivery_mode does not match its delivery plan");
    }
  }
  if (deliveryMode === "none" && deliveryRequired) {
    throw new Error("gateway callback delivery_mode none cannot require delivery");
  }

  if (chatSendParams) {
    if (
      !stringValue(chatSendParams.sessionKey) ||
      !stringValue(chatSendParams.message) ||
      !stringValue(chatSendParams.idempotencyKey) ||
      chatSendParams.deliver !== true
    ) {
      throw new Error("gateway callback returned an invalid chat_send delivery plan");
    }
  }
  if (sessionSendParams) {
    if (
      !stringValue(sessionSendParams.key) ||
      !stringValue(sessionSendParams.message) ||
      !stringValue(sessionSendParams.idempotencyKey)
    ) {
      throw new Error("gateway callback returned an invalid session_send delivery plan");
    }
  }
  return { chatSendParams, sessionSendParams };
}

function parseChatSendAcknowledgement(
  text,
  expectedRunId: string
): { runId: string; status: "started" | "in_flight" | "ok" } {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("chat.send returned malformed JSON");
  }
  const runId = stringValue(payload.runId);
  const status = stringValue(payload.status);
  if (!runId) {
    throw new Error("chat.send acknowledgement is missing runId");
  }
  if (runId !== expectedRunId) {
    throw new Error("chat.send acknowledgement runId does not match its idempotencyKey");
  }
  if (!status || !["started", "in_flight", "ok"].includes(status)) {
    throw new Error(`chat.send returned unexpected status ${JSON.stringify(status ?? null)}`);
  }
  return {
    runId,
    status: status as "started" | "in_flight" | "ok"
  };
}

function parseAgentWaitResult(text, expectedRunId: string): Record<string, unknown> {
  const payload = parseOptionalJson(text);
  if (!isRecord(payload)) {
    throw new Error("agent.wait returned malformed JSON");
  }
  if (stringValue(payload.runId) !== expectedRunId) {
    throw new Error("agent.wait returned a result for a different runId");
  }
  const status = stringValue(payload.status);
  if (!status || !["ok", "error", "timeout", "pending"].includes(status)) {
    throw new Error(`agent.wait returned unexpected status ${JSON.stringify(status ?? null)}`);
  }
  return payload;
}

function createAgentSessionProvider(agent, options) {
  if (agent !== "codex") {
    throw new Error(`unsupported agent session provider: ${agent}`);
  }

  if (options.threadsJson || options.processesJson || options.rolloutsJson) {
    return new CodexLocalSessionProvider(new InlineCodexSessionAdapter({
      threads: parseJsonOption(options.threadsJson, "--threads-json"),
      processes: parseJsonOption(options.processesJson, "--processes-json"),
      rollouts: parseJsonOption(options.rolloutsJson, "--rollouts-json")
    }));
  }

  return new CodexLocalSessionProvider(new CodexStoreAdapter({
    codexHome: expandHome(options.codexHome)
  }));
}

function parseJsonOption(value, optionName) {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`${optionName} must be valid JSON: ${error.message}`);
  }
}

function expandHome(filePath) {
  if (filePath === "~") {
    return process.env.HOME;
  }

  if (filePath?.startsWith("~/")) {
    return `${process.env.HOME}${filePath.slice(1)}`;
  }

  return filePath;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(redactCliOutput(value), null, 2)}\n`);
}

function redactCliOutput(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCliOutput(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (key === "gateway_token" || key === "gatewayToken") {
          return [];
        }
        if (
          key === "claude_transcript_anchor" ||
          key === "claudeTranscriptAnchor" ||
          key === "claude_home" ||
          key === "claudeHome"
        ) {
          return [];
        }
        if ((key === "callback_command" || key === "callbackCommand") && typeof item === "string") {
          return [[key, redactString(item)]];
        }
        return [[key, redactCliOutput(item)]];
      })
    );
  }
  return value;
}

function cleanProcessText(text) {
  const value = String(text ?? "").trim();
  return value ? value.slice(0, 2000) : undefined;
}

function textSummary(text, maxLength = 240) {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function classifyProcessFailure(result) {
  const status = result?.status ?? 0;
  const combined = [
    result?.error?.message,
    result?.stderr,
    result?.stdout
  ].filter(Boolean).join("\n").toLowerCase();

  if (!combined && status === 0) {
    return undefined;
  }
  if (isRemoteCompactStreamDisconnect(combined)) {
    return "transient_remote_compact_failure";
  }
  if (combined.includes("agent needs reconnect") || combined.includes("internal error")) {
    return "agent_reconnect_required";
  }
  if (combined.includes("permission denied") || combined.includes("operation not permitted")) {
    return "permission_denied";
  }
  if (combined.includes("sandbox") || combined.includes("outside workspace")) {
    return "sandbox_denied";
  }
  if (combined.includes("timed out") || combined.includes("timeout")) {
    return "timeout";
  }
  if (status !== 0) {
    return "nonzero_exit";
  }
  return undefined;
}

function isRemoteCompactStreamDisconnect(text) {
  const value = String(text ?? "").toLowerCase();
  return (
    value.includes("error running remote compact task") &&
    value.includes("stream disconnected") &&
    value.includes("/codex/responses/compact")
  );
}

function runtimeLog(level, event, fields = {}) {
  try {
    writeRuntimeLog({
      level,
      event,
      ...fields
    });
  } catch {
    // Runtime logging must never break the user-facing CLI command.
  }
}

function withStoragePaths(conversation, paths) {
  return {
    ...conversation,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
}

function usage() {
  const agentList = EXECUTOR_KINDS.join("|");
  process.stdout.write(`Usage:
  agent-knock-knock --help
  agent-knock-knock --version
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--all] [--managed-only] [--no-approval-scan] [--terminal-debug]
  agent-knock-knock status [--conversation <id|selector>] [--store-dir <dir>] [--trace]
  agent-knock-knock send [--conversation <id|selector>] --message <text> [--type answer|task|control] [--agent-timeout-minutes <minutes>] [--agent-hard-timeout-minutes <minutes>]
  agent-knock-knock approve [--conversation <id|selector>] --expected-approval-fingerprint <fingerprint>
  agent-knock-knock cancel [--conversation <id|selector>]
  agent-knock-knock install-openclaw [--verify] [--openclaw-bin <path>] [--skill-path <path>] [--skill-only] [--no-restart]
  agent-knock-knock doctor [--openclaw-bin <path>]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}

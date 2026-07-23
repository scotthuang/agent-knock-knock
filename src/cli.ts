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
  type ClaudeTranscriptAnchor
} from "./claude-local-transcript-provider.js";
import {
  ClaudeHookStore,
  ClaudeHookStoreError,
  defaultClaudeHookStoreDir,
  type ClaudeManagedLease
} from "./claude-hook-store.js";
import { claudePermissionHookOutput } from "./claude-hook-protocol.js";
import {
  defaultClaudeSettingsPath,
  loadTrustedClaudeTokenjuiceLaunchers
} from "./claude-hook-installer.js";
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
  type ConversationStatus
} from "./protocol.js";
import {
  EXECUTOR_KINDS,
  acpxCommandForExecutor,
  executorDefinitionForKind,
  modelEnvForExecutor,
  normalizeModelForExecutor,
  proxyEnvForExecutor,
  type ExecutorKind
} from "./executors.js";
import { executorBootstrapPrompt } from "./bootstrap.js";
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
import { planFork, planTakeover } from "./session-takeover-planner.js";
import {
  StaticTerminalControlProvider,
  TmuxTerminalControlProvider,
  terminalPaneContainsProcess,
  type TerminalControlProvider
} from "./terminal-control-provider.js";
import {
  parseTerminalConversationId,
  terminalControlCapabilitiesForAdapter,
  type ActiveTerminalProcess,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalDurableCompletionRequest,
  type TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import { createProductionTerminalAgentRegistry } from "./terminal-agent-registry.js";
import {
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
import { evaluateDoctorCapabilities } from "./doctor-capabilities.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const CLAUDE_SCREEN_APPROVAL_TTL_MS = 10 * 60 * 1000;
const CALLBACK_DELIVERY_TIMEOUT_MS = 30_000;
const CALLBACK_RETRY_DELAYS_MS = [5000, 15000, 60000, 60000];
const TERMINAL_BRIDGE_MONITOR_LOCK_VERSION = 1;
const MINIMUM_NODE_VERSION = "22.14.0";
const PRIVATE_LOCK_FILE_MODE = 0o600;
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;
const DEFAULT_CODEX_ACPX_AGENT_COMMAND = "npx -y @agentclientprotocol/codex-acp@1.1.7";
const CONVERSATION_STATUSES = new Set<ConversationStatus>([
  "created",
  "running",
  "waiting_for_agent",
  "waiting_for_openclaw",
  "idle",
  "stalled",
  "needs_recovery",
  "needs_model_selection",
  "callback_pending",
  "callback_failed",
  "failed",
  "closed",
  "cancelled",
  "cancelling"
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
const args = command === "agent"
  ? { agentCommand: rawArgs[0], ...parseArgs(rawArgs.slice(1)) }
  : parseArgs(rawArgs);

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
  if (commandName === "help" || commandName === "--help" || commandName === "-h") {
    usage();
  } else if (commandName === "version" || commandName === "--version" || commandName === "-v") {
    printVersion();
  } else if (commandName === "new") {
    runNew(options);
  } else if (commandName === "record") {
    runRecord(options);
  } else if (commandName === "bootstrap-prompt") {
    runBootstrapPrompt(options);
  } else if (commandName === "delegate") {
    runDelegate(options);
  } else if (commandName === "list") {
    await runList(options);
  } else if (commandName === "status") {
    await runStatus(options);
  } else if (commandName === "describe" || commandName === "summary") {
    await runDescribe(options);
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
  } else if (commandName === "recover") {
    runRecover(options);
  } else if (commandName === "close") {
    await runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "install-openclaw") {
    runInstallOpenClaw(options);
  } else if (commandName === "install-claude-hooks") {
    throw new Error(
      "install-claude-hooks is no longer supported; Claude tmux control now works without modifying Claude Code settings"
    );
  } else if (commandName === "claude-hook") {
    await runClaudeHook(options);
  } else if (commandName === "doctor") {
    runDoctor(options);
  } else if (commandName === "callback") {
    runCallback(options);
  } else if (commandName === "retry-callback") {
    runRetryCallback(options);
  } else if (commandName === "monitor") {
    await runMonitor(options);
  } else if (commandName === "agent") {
    await runAgent(options);
  } else {
    usage();
    process.exitCode = commandName ? 1 : 0;
  }
}

function runInstallOpenClaw(options) {
  const root = packageRootDir();
  const skillOnly = options.skillOnly === true;
  const needsOpenClaw = !skillOnly || options.noRestart !== true;
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

    runCheckedCommand(openclawBin, ["plugins", "enable", "agent-knock-knock"], {
      label: "openclaw plugins enable"
    });
    steps.push({
      name: "plugin_enabled",
      plugin: "agent-knock-knock"
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

  printJson({
    installed: true,
    mode: skillOnly ? "skill_only" : "full",
    package_root: root,
    openclaw_bin: openclawBin ?? null,
    steps,
    next: options.noRestart === true
      ? "Restart the OpenClaw Gateway before using Agent Knock Knock."
      : "Agent Knock Knock is installed. Try: AKK list"
  });
}

async function runClaudeHook(options) {
  const rawInput = fs.readFileSync(0, "utf8");
  let input: unknown;
  try {
    input = JSON.parse(rawInput);
  } catch {
    throw new Error("Claude hook input must be valid JSON");
  }

  const agentRows = loadClaudeAgentRows(options);
  const claudePid = inferClaudeAncestorPid(agentRows);
  const store = createClaudeHookStore(options);
  const record = store.record(input, {
    ...(claudePid === undefined ? {} : { claudePid })
  });
  if (record.event.input.hook_event_name !== "PermissionRequest" || !record.permission) {
    return;
  }

  const permission = record.permission;
  const requestedTimeout = options.permissionWaitTimeoutMs ?? options.timeoutMs;
  const timeoutMs = requestedTimeout === undefined
    ? undefined
    : Math.max(0, Number(requestedTimeout));
  try {
    const decision = await store.waitForPermissionDecision({
      sessionId: permission.sessionId,
      requestId: permission.requestId,
      fingerprint: permission.fingerprint,
      conversationId: permission.conversationId,
      messageId: permission.messageId,
      ...(timeoutMs === undefined ? {} : { timeoutMs })
    });
    process.stdout.write(`${JSON.stringify(
      decision?.hookOutput ?? claudePermissionHookOutput({
        behavior: "deny",
        interrupt: false,
        message: "Agent Knock Knock approval timed out. Review the request and retry the task."
      })
    )}\n`);
  } catch (error) {
    if (error instanceof ClaudeHookStoreError && [
      "PERMISSION_EXPIRED",
      "PERMISSION_CONSUMED",
      "PERMISSION_ALREADY_DECIDED"
    ].includes(error.code)) {
      process.stdout.write(`${JSON.stringify(
        claudePermissionHookOutput({
          behavior: "deny",
          interrupt: false,
          message: "Agent Knock Knock approval expired before a safe decision was received."
        })
      )}\n`);
      return;
    }
    throw error;
  }
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
  const commands = ["node", "openclaw", "tmux", "acpx", "codex", "claude", "cursor"];
  const checks = commands.map((commandName) => {
    const check = executableCheck(commandName);
    return commandName === "node"
      ? {
          ...check,
          version: process.versions.node,
          version_supported: versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION),
          minimum_version: MINIMUM_NODE_VERSION
        }
      : check;
  });
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

  const ok = capabilities.coreOk && filesOk && capabilities.transportOk;
  printJson({
    ok,
    package_root: root,
    checks,
    package_files: packageFiles,
    capabilities: {
      tmux: capabilities.tmux,
      acp: capabilities.acp
    },
    notes: [
      `Node.js ${MINIMUM_NODE_VERSION}+ and OpenClaw are required.`,
      "Choose tmux (recommended), ACPX/ACP, or install both.",
      "tmux supports Codex and Claude Code; ACPX supports Codex, Claude Code, and Cursor.",
      "Claude tmux completion is hook-free and fails closed unless the local transcript schema is verified."
    ],
    options
  });
  if (!ok) {
    process.exitCode = 1;
  }
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

async function runAgent(options) {
  const agentCommand = required(options.agentCommand, "agent subcommand is required: takeover");
  if (agentCommand === "takeover") {
    printJson(await runAgentTakeover(options));
    return;
  }
  throw new Error(`unsupported agent subcommand: ${agentCommand}`);
}

async function runAgentTakeover(options) {
  const agent = required(options.agent, "--agent is required");
  const sessionId = required(options.sessionId, "--session-id is required");
  const strategy = options.strategy ?? "terminate_then_resume";
  const provider = createAgentSessionProvider(agent, options);
  const session = await provider.getSession(sessionId);
  if (!session) {
    return {
      agent,
      sessionId,
      strategy,
      status: "blocked",
      sideEffectsExecuted: false,
      error: {
        code: "session_not_found",
        message: `No ${agent} session found for ${sessionId}`
      }
    };
  }

  if (strategy === "terminate_then_resume") {
    const activeSessions = await listActiveSessionsWithTerminalControl(provider, options);
    const plan = planTakeover(session, activeSessions);
    if (options.confirmTerminate === true) {
      const expectedPid = Number(required(options.expectedPid, "--expected-pid is required with --confirm-terminate"));
      if (!Number.isInteger(expectedPid) || expectedPid <= 0) {
        throw new Error("--expected-pid must be a positive integer");
      }
      if (!options.createConversation) {
        throw new Error("--create-conversation is required with --confirm-terminate");
      }
      const targetSelection = selectTerminateTarget({
        plan,
        session,
        activeSessions,
        expectedPid,
        allowCwdOnly: options.allowCwdOnly === true
      });
      if (!targetSelection.allowed) {
        return {
          agent,
          sessionId,
          strategy,
          status: "blocked",
          sideEffectsExecuted: false,
          plan,
          error: {
            code: targetSelection.code,
            message: targetSelection.message
          }
        };
      }

      const { target, matchKind } = targetSelection;

      const termination = terminateProcessTarget(target, {
        timeoutMs: Number(options.terminateTimeoutMs ?? 3000)
      });
      const activeAfterTermination = await listActiveSessionsWithTerminalControl(provider, options);
      const afterTerminationPlan = planTakeover(session, activeAfterTermination);
      if (afterTerminationPlan.targets.some((candidate) => candidate.sessionId === session.id || candidate.pid === expectedPid)) {
        return {
          agent,
          sessionId,
          strategy,
          status: "blocked",
          sideEffectsExecuted: true,
          plan: afterTerminationPlan,
          termination,
          error: {
            code: "target_still_active",
            message: `Codex process ${expectedPid} still appears active after termination.`
          }
        };
      }

      const modelInfo = await provider.getSessionModel(session.id);
      const attached = createNativeSessionConversation({
        agent,
        strategy,
        session,
        modelInfo,
        options,
        takeoverMatchKind: matchKind
      });
      return {
        agent,
        sessionId,
        strategy,
        status: "attached",
        sideEffectsExecuted: true,
        plan,
        termination,
        matchKind,
        ...attached
      };
    }

    return {
      agent,
      sessionId,
      strategy,
      status: plan.requiresConfirmation ? "requires_confirmation" : "blocked",
      sideEffectsExecuted: false,
      plan
    };
  }

  if (strategy === "terminal_control") {
    const activeSessions = await listActiveSessionsWithTerminalControl(provider, options);
    const plan = planTerminalControlTakeover(session, activeSessions);
    if (options.confirmTerminal === true) {
      const terminalTarget = String(required(options.terminalTarget, "--terminal-target is required with --confirm-terminal"));
      if (!options.createConversation) {
        throw new Error("--create-conversation is required with --confirm-terminal");
      }
      const target = plan.targets.find((candidate) => candidate.terminalControl?.target === terminalTarget);
      if (!plan.allowed || !target?.terminalControl) {
        return {
          agent,
          sessionId,
          strategy,
          status: "blocked",
          sideEffectsExecuted: false,
          plan,
          error: {
            code: "terminal_target_unavailable",
            message: `No matching terminal-controlled Codex process was found for ${terminalTarget}`
          }
        };
      }
      const modelInfo = await provider.getSessionModel(session.id);
      const attached = createNativeSessionConversation({
        agent,
        strategy,
        session,
        modelInfo,
        options,
        takeoverMatchKind: "terminal_control",
        terminalControl: target.terminalControl,
        terminalAgentPid: target.pid,
        needsBootstrap: false
      });
      return {
        agent,
        sessionId,
        strategy,
        status: "attached",
        sideEffectsExecuted: true,
        plan,
        terminalControl: target.terminalControl,
        ...attached
      };
    }

    return {
      agent,
      sessionId,
      strategy,
      status: plan.allowed ? "requires_confirmation" : "blocked",
      sideEffectsExecuted: false,
      plan
    };
  }

  if (strategy === "fork") {
    const contextPackage = await provider.getForkContext({
      sessionId,
      maxMessages: Number(options.maxMessages ?? 12),
      maxCommands: Number(options.maxCommands ?? 8),
      maxTextLength: Number(options.maxTextLength ?? 1200)
    });
    if (!contextPackage) {
      return {
        agent,
        sessionId,
        strategy,
        status: "blocked",
        sideEffectsExecuted: false,
        error: {
          code: "fork_context_unavailable",
          message: `No fork context could be built for ${sessionId}`
        }
      };
    }

    if (options.createConversation) {
      const forkSummary = String(required(options.forkSummary ?? options.summary, "--fork-summary is required when creating a fork conversation"));
      const modelInfo = await provider.getSessionModel(session.id);
      const attached = createForkConversation({
        agent,
        strategy,
        session,
        contextPackage,
        forkSummary,
        modelInfo,
        options
      });
      return {
        agent,
        sessionId,
        strategy,
        status: "forked",
        sideEffectsExecuted: true,
        plan: planFork(session, contextPackage),
        ...attached
      };
    }

    return {
      agent,
      sessionId,
      strategy,
      status: "awaiting_openclaw_summary",
      sideEffectsExecuted: false,
      plan: planFork(session, contextPackage),
      summaryPrompt: buildForkSummaryPrompt({ agent, session, contextPackage }),
      nextAction: {
        actor: "openclaw",
        action: "summarize_and_confirm_fork",
        instructions: [
          "Summarize plan.contextPackage for the user before creating a forked AKK-managed session.",
          "Do not inject the raw rollout or full contextPackage into the new coding agent.",
          "Ask the user to confirm the summary.",
          "After confirmation, call this tool again with strategy=fork, createConversation=true, and forkSummary set to the confirmed summary."
        ],
        followUpTool: "agent_knock_knock_agent_takeover",
        followUpParams: {
          agent,
          sessionId,
          strategy: "fork",
          createConversation: true,
          forkSummary: "<confirmed OpenClaw summary>"
        }
      },
      next: "Use summaryPrompt to summarize the bounded context package for the user, ask for confirmation, then create the forked AKK-managed session with forkSummary."
    };
  }

  throw new Error(`unsupported takeover strategy: ${strategy}`);
}

function buildForkSummaryPrompt({ agent, session, contextPackage }) {
  return [
    "You are OpenClaw summarizing a bounded native coding-agent session context before Agent Knock Knock forks it into a new managed session.",
    "",
    "Goal:",
    "- Produce a concise, user-reviewable summary that can be safely injected into a new AKK-managed coding-agent session after the user confirms it.",
    "- The new session must use the summary only; do not pass raw rollout history or the full context package to the coding agent.",
    "",
    "Source:",
    `- Agent: ${agent}`,
    `- Session id: ${session.id}`,
    `- Workspace: ${session.cwd}`,
    `- Title: ${session.title ?? session.preview ?? session.firstUserMessage ?? "(unknown)"}`,
    `- Context messages included: ${contextPackage.messages.length}`,
    `- Commands included: ${contextPackage.commands.length}`,
    `- Context truncated: ${contextPackage.truncated ? "yes" : "no"}`,
    "",
    "Summary format:",
    "1. Original user goal",
    "2. Work already completed",
    "3. Current state and important findings",
    "4. Constraints, risks, or files/workspace details the forked agent must preserve",
    "5. Recommended next step for the forked agent",
    "",
    "After writing the summary, ask the user to confirm. If confirmed, call agent_knock_knock_agent_takeover with strategy=\"fork\", createConversation=true, and forkSummary equal to the confirmed summary."
  ].join("\n");
}

function selectTerminateTarget({ plan, session, activeSessions, expectedPid, allowCwdOnly }) {
  const exactTarget = plan.targets.find((candidate) => candidate.pid === expectedPid && candidate.sessionId === session.id);
  if (exactTarget) {
    return {
      allowed: true,
      target: exactTarget,
      matchKind: "exact_session"
    };
  }

  if (!allowCwdOnly) {
    return {
      allowed: false,
      code: plan.allowed && plan.requiresConfirmation ? "expected_pid_mismatch" : "takeover_not_confirmable",
      message: plan.allowed && plan.requiresConfirmation
        ? `Expected pid ${expectedPid} is no longer the exact active Codex process for session ${session.id}.`
        : "The current active Codex process no longer has an exact session match that can be safely terminated."
    };
  }

  const cwdOnlyTarget = plan.targets.find((candidate) =>
    candidate.pid === expectedPid &&
    candidate.cwd === session.cwd &&
    candidate.sessionId === undefined
  );
  const stillActive = activeSessions.some((candidate) =>
    candidate.pid === expectedPid &&
    candidate.cwd === session.cwd &&
    candidate.sessionId === undefined
  );
  if (!cwdOnlyTarget || !stillActive) {
    return {
      allowed: false,
      code: "expected_pid_mismatch",
      message: `Expected pid ${expectedPid} is no longer an active Codex process in ${session.cwd}.`
    };
  }

  return {
    allowed: true,
    target: cwdOnlyTarget,
    matchKind: "cwd_only_confirmed"
  };
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

function createClaudeHookStore(options: Record<string, any> = {}): ClaudeHookStore {
  const configuredRoot = stringValue(options.claudeHookStoreDir);
  return new ClaudeHookStore({
    rootDir: expandHome(configuredRoot ?? defaultClaudeHookStoreDir())
  });
}

function createConfiguredClaudeHookStore(
  options: Record<string, any> = {}
): ClaudeHookStore | undefined {
  return stringValue(options.claudeHookStoreDir)
    ? createClaudeHookStore(options)
    : undefined;
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

function inferClaudeAncestorPid(
  agentRows: readonly ClaudeAgentRow[],
  startingPid = process.ppid
): number | undefined {
  const interactivePids = new Set(agentRows
    .filter((row) => row.kind === undefined || row.kind === "interactive")
    .map((row) => row.pid)
    .filter((pid): pid is number => Number.isInteger(pid)));
  let pid = startingPid;
  const visited = new Set<number>();
  for (let depth = 0; depth < 16 && Number.isInteger(pid) && pid > 1 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const processRow = spawnSync("ps", ["-p", String(pid), "-o", "pid=,ppid=,command="], {
      encoding: "utf8",
      timeout: 2_000
    });
    if (processRow.error || processRow.status !== 0) {
      return undefined;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(String(processRow.stdout).trim());
    if (!match) {
      return undefined;
    }
    const currentPid = Number(match[1]);
    const parentPid = Number(match[2]);
    const commandText = match[3];
    if (interactivePids.has(currentPid) || isClaudeProcessCommand(commandText)) {
      return currentPid;
    }
    pid = parentPid;
  }
  return undefined;
}

function isClaudeProcessCommand(commandText: string): boolean {
  const executable = commandText.trim().split(/\s+/u, 1)[0];
  return path.basename(executable) === "claude" ||
    /[\\/]\.local[\\/]share[\\/]claude[\\/]versions[\\/][^\\/\s]+$/u.test(executable);
}

function createRuntimeTerminalAgentRegistry(options) {
  const claudeHookStore = createConfiguredClaudeHookStore(options);
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
          const contextMatch = await loadCodexTerminalContext({
            conversation,
            nativeTakeover,
            options
          });
          if (!contextMatch?.context) {
            return undefined;
          }
          const evidence = detectCodexDurableCompletion({
            ...request,
            context: contextMatch.context
          });
          return evidence
            ? {
                ...evidence,
                confidence: contextMatch.confidence as "high" | "medium" | "low",
                metadata: {
                  ...evidence.metadata,
                  context_match: contextMatch.match,
                  session: contextMatch.context.source
                }
              }
            : undefined;
        }
      }),
      createClaudeTerminalAgentAdapter({
        agentRows: loadClaudeAgentRows(options),
        async detectDurableCompletion(request: TerminalDurableCompletionRequest) {
          return detectClaudeTranscriptCompletion(request, {
            claudeHome: expandHome(options.claudeHome),
            agentRows: loadClaudeAgentRows(options)
          });
        },
        ...(claudeHookStore
          ? {
              hookStore: claudeHookStore,
              trustedTokenjuiceLaunchers: loadTrustedClaudeTokenjuiceLaunchers(
                expandHome(options.claudeSettingsPath ?? defaultClaudeSettingsPath())
              )
            }
          : {})
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
      const snapshots = await processSource.listProcessSnapshots(undefined, { includeCwd: false });
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

function planTerminalControlTakeover(session, activeSessions: ActiveCodexProcess[]) {
  const matched = activeSessions
    .filter((process) =>
      process.kind === "codex_cli" &&
      process.terminalControl &&
      (
        process.sessionId === session.id ||
        (!process.sessionId && process.cwd === session.cwd)
      )
    );
  const matchedPidSet = new Set(matched.map((process) => process.pid));
  const targets = matched
    .filter((process) => !process.ppid || !matchedPidSet.has(process.ppid))
    .map((process) => ({
      pid: process.pid,
      childPids: matched
        .filter((child) => child.ppid === process.pid)
        .map((child) => child.pid),
      cwd: process.cwd,
      command: process.command,
      sessionId: process.sessionId,
      terminalControl: process.terminalControl
    }));

  const exactTargets = targets.filter((target) => target.sessionId === session.id);
  const selectableTargets = exactTargets.length > 0 ? exactTargets : targets;

  return {
    mode: "terminal_control",
    allowed: selectableTargets.length === 1,
    requiresConfirmation: selectableTargets.length === 1,
    reason: selectableTargets.length === 0
      ? "no_terminal_control_target"
      : selectableTargets.length === 1
        ? "terminal_control_available"
        : "ambiguous_terminal_control_target",
    targets: selectableTargets
  };
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

function createForkConversation({ agent, strategy, session, contextPackage, forkSummary, modelInfo, options }) {
  const workspace = session.cwd;
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const executor = resolveExecutor({
    kind: agent,
    session: options.session ?? options.executorSession ?? uniqueDelegateSessionName(agent)
  });
  const now = new Date();
  const conversation = createConversation({
    userRequest: options.request ?? `Fork native ${agent} session ${session.id}`,
    workspace,
    openclawSession: options.openclawSession ?? "agent:main:main",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100),
    now
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: paths.statePath })
    : buildCallbackCommand({
        statePath: paths.statePath,
        gatewayUrl: options.gatewayUrl ?? "ws://127.0.0.1:18789",
        token: options.token,
        openclawSession: options.openclawSession ?? "agent:main:main",
        gatewayMethod: options.gatewayMethod,
        gatewaySession: options.gatewaySession,
        openclawBin: options.openclawBin ?? resolveOptionalExecutable("openclaw")
      });
  const explicitModel = options.model ?? options.codexModel;
  const executorModel = explicitModel ?? modelInfo?.acpxModel ?? modelEnvForExecutor(executor, process.env);
  const forkedConversation = withStoragePaths({
    ...conversation,
    executor,
    status: "idle" as const,
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    callback_command: callbackCommand,
    gateway_url: options.gatewayUrl ?? "ws://127.0.0.1:18789",
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? options.openclawSession ?? "agent:main:main",
    openclaw_bin: options.openclawBin ?? resolveOptionalExecutable("openclaw"),
    executor_all_proxy: proxyForExecutor(executor, options),
    executor_model: executorModel,
    fork_context_takeover: {
      agent,
      source_session_id: session.id,
      source_cwd: session.cwd,
      source_title: session.title,
      source_updated_at_ms: session.updatedAtMs,
      strategy,
      forked_at: now.toISOString(),
      summary: forkSummary,
      context_message_count: contextPackage.messages.length,
      context_command_count: contextPackage.commands.length,
      context_truncated: contextPackage.truncated,
      native_model: modelInfo?.model,
      acpx_model: modelInfo?.acpxModel,
      model_source: modelInfo?.source,
      needs_bootstrap: true
    }
  }, paths);

  saveState(paths.statePath, forkedConversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: forkedConversation.conversation_id,
    event: "native_session_forked",
    agent,
    strategy,
    source_session_id: session.id,
    source_cwd: session.cwd,
    executor,
    context_message_count: contextPackage.messages.length,
    context_command_count: contextPackage.commands.length,
    context_truncated: contextPackage.truncated
  });
  runtimeLog("info", "native_session_forked", {
    conversation_id: forkedConversation.conversation_id,
    agent,
    strategy,
    source_session_id: session.id,
    executor_session: executor.session,
    state_path: paths.statePath,
    event_log_path: paths.logPath
  });

  return {
    conversation: forkedConversation,
    paths,
    next: `Use AKK send ${forkedConversation.conversation_id}: <message> to start the forked ${agent} session with the approved summary.`
  };
}

function createNativeSessionConversation({
  agent,
  strategy,
  session,
  modelInfo,
  options,
  takeoverMatchKind = strategy,
  terminalControl = undefined as TerminalControlRef | undefined,
  terminalAgentPid = undefined as number | undefined,
  needsBootstrap = true
}) {
  const workspace = session.cwd;
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const executor = resolveExecutor({
    kind: agent,
    session: session.id
  });
  const now = new Date();
  const conversation = createConversation({
    userRequest: options.request ?? `Attach native ${agent} session ${session.id}`,
    workspace,
    openclawSession: options.openclawSession ?? "agent:main:main",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100),
    now
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: paths.statePath })
    : buildCallbackCommand({
        statePath: paths.statePath,
        gatewayUrl: options.gatewayUrl ?? "ws://127.0.0.1:18789",
        token: options.token,
        openclawSession: options.openclawSession ?? "agent:main:main",
        gatewayMethod: options.gatewayMethod,
        gatewaySession: options.gatewaySession,
        openclawBin: options.openclawBin ?? resolveOptionalExecutable("openclaw")
      });
  const explicitModel = options.model ?? options.codexModel;
  const executorModel = explicitModel ?? modelInfo?.acpxModel ?? modelEnvForExecutor(executor, process.env);
  const attachedConversation = withStoragePaths({
    ...conversation,
    executor,
    status: "idle" as const,
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    callback_command: callbackCommand,
    gateway_url: options.gatewayUrl ?? "ws://127.0.0.1:18789",
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? options.openclawSession ?? "agent:main:main",
    openclaw_bin: options.openclawBin ?? resolveOptionalExecutable("openclaw"),
    executor_all_proxy: proxyForExecutor(executor, options),
    executor_model: executorModel,
    native_session_takeover: {
      agent,
      native_session_id: session.id,
      terminal_agent_pid: terminalAgentPid,
      source_cwd: session.cwd,
      source_title: session.title,
      strategy,
      attached_at: now.toISOString(),
      native_model: modelInfo?.model,
	      acpx_model: modelInfo?.acpxModel,
	      model_source: modelInfo?.source,
	      takeover_match_kind: takeoverMatchKind,
	      terminal_control: terminalControl,
	      needs_bootstrap: needsBootstrap,
	      terminal_bridge: strategy === "terminal_control"
	    }
  }, paths);

  saveState(paths.statePath, attachedConversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: attachedConversation.conversation_id,
    event: "native_session_attached",
    agent,
    strategy,
    native_session_id: session.id,
    source_cwd: session.cwd,
    executor
  });
  runtimeLog("info", "native_session_attached", {
    conversation_id: attachedConversation.conversation_id,
    agent,
    strategy,
    native_session_id: session.id,
    state_path: paths.statePath,
    event_log_path: paths.logPath
  });

  return {
    conversation: attachedConversation,
    paths,
    next: `Use AKK send ${attachedConversation.conversation_id}: <message> to continue this native ${agent} session through AKK.`
  };
}

function runNew(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace ?? process.cwd();
  cleanupIdleConversations(expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace)), options);
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: options.session ?? options.executorSession ?? options.claudeSession
  });
  const conversation = createConversation({
    userRequest: request,
    workspace,
    openclawSession: options.openclawSession ?? "agent:main:main",
    claudeSession: options.claudeSession ?? "bidirectional",
    executorKind: executor.kind,
    executorSession: executor.session,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });

  const taskMessage = createMessage({
    conversation,
    from: "openclaw",
    to: executor.actor,
    type: "task",
    body: request,
    metadata: {
      executor_kind: executor.kind,
      executor_session: executor.session
    }
  });

  const nextConversation = applyMessageToConversation(conversation, taskMessage);
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const storedConversation = withStoragePaths(nextConversation, paths);

  saveState(paths.statePath, storedConversation);
  appendEvent(paths.logPath, {
    ts: conversation.created_at,
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation: storedConversation
  });
  appendEvent(paths.logPath, messageEvent(taskMessage));
  runtimeLog("info", "conversation_created", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    workspace,
    store_dir: storeDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    request: textSummary(request)
  });

  printJson({
    conversation: storedConversation,
    paths,
    task_message: taskMessage,
    budget: budgetAction(storedConversation)
  });
}

function runRecord(options) {
  const statePath = required(options.state, "--state is required");
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = options.log ?? logPathForStatePath(statePath);

  const conversation = loadState(expandHome(statePath));
  const message = parseMessageJson(messageInput);
  const nextConversation = applyMessageToConversation(conversation, message);

  appendEvent(expandHome(logPath), messageEvent(message));
  saveState(expandHome(statePath), nextConversation);

  printJson({
    conversation: nextConversation,
    budget: budgetAction(nextConversation)
  });
}

function runBootstrapPrompt(options) {
  const callbackCommand = required(options.callbackCommand, "--callback-command is required");
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: options.session ?? options.claudeSession
  });
  process.stdout.write(
    executorBootstrapPrompt({
      callbackCommand,
      executorName: executor.display_name,
      softLimit: Number(options.softLimit ?? 50),
      hardLimit: Number(options.hardLimit ?? 100)
    })
  );
}

function runDelegate(options) {
  const request = required(options.request, "--request is required");
  const workspace = options.workspace ?? process.cwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const explicitExecutorSession = options.session ?? options.executorSession ?? options.claudeSession;
  const executor = resolveExecutor({
    kind: options.agent ?? "claude",
    session: explicitExecutorSession ?? uniqueDelegateSessionName(options.agent ?? "claude")
  });
  const newResult = captureJson([
    "new",
    "--request",
    request,
    "--workspace",
    workspace,
    "--openclaw-session",
    options.openclawSession ?? "agent:main:main",
    "--agent",
    executor.kind,
    "--session",
    executor.session,
    "--soft-limit",
    String(options.softLimit ?? 50),
    "--hard-limit",
    String(options.hardLimit ?? 100),
    "--store-dir",
    storeDir
  ]);

  const gatewayUrl = options.gatewayUrl ?? "ws://127.0.0.1:18789";
  if (options.send && !options.token) {
    throw new Error("--token is required when using --send");
  }

  const openclawSession = options.openclawSession ?? "agent:main:main";
  const openclawBin = options.openclawBin ?? resolveOptionalExecutable("openclaw");
  const executorEnv = environmentForExecutor(executor, options);
  const executorAllProxy = proxyForExecutor(executor, options);
  const executorModel = modelForExecutor(executor, options);
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: newResult.paths.statePath })
    : buildCallbackCommand({
        statePath: newResult.paths.statePath,
        gatewayUrl,
        token: options.token,
        openclawSession,
        gatewayMethod: options.gatewayMethod,
        gatewaySession: options.gatewaySession,
        openclawBin
      });
  const conversationWithCallback = {
    ...newResult.conversation,
    gateway_url: gatewayUrl,
    callback_command: callbackCommand,
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? openclawSession,
    openclaw_bin: openclawBin,
    executor_all_proxy: executorAllProxy,
    executor_model: executorModel
  };
  saveState(newResult.paths.statePath, conversationWithCallback);
  newResult.conversation = conversationWithCallback;
  runtimeLog("info", "delegate_created", {
    conversation_id: newResult.conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    workspace,
    store_dir: storeDir,
    state_path: newResult.paths.statePath,
    gateway_method: options.gatewayMethod,
    background: Boolean(options.background),
    request: textSummary(request)
  });

  const bootstrap = executorBootstrapPrompt({
    callbackCommand,
    executorName: executor.display_name,
    softLimit: Number(options.softLimit ?? 50),
    hardLimit: Number(options.hardLimit ?? 100)
  });
  const payload = `${bootstrap}\n\nInitial task message:\n${JSON.stringify(newResult.task_message)}`;

  const acpxArgs = buildAcpxPromptArgs({ executor, payload, model: executorModel });

  if (options.background) {
    const acpxPath = resolveExecutable("acpx");
    const ensureSession = ensureExecutorSession({
      acpxPath,
      executor,
      cwd: workspace,
      env: executorEnv
    });
    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "executor_session_ensure",
      status: ensureSession.status ?? null,
      executor,
      stdout: cleanProcessText(ensureSession.stdout),
      stderr: cleanProcessText(ensureSession.stderr)
    });
    runtimeLog("info", "executor_session_ensure", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      status: ensureSession.status ?? null,
      failure_kind: classifyProcessFailure(ensureSession),
      stdout: textSummary(cleanProcessText(ensureSession.stdout)),
      stderr: textSummary(cleanProcessText(ensureSession.stderr))
    });
    if (executor.kind === "claude") {
      appendEvent(newResult.paths.logPath, {
        ts: new Date().toISOString(),
        conversation_id: newResult.conversation.conversation_id,
        event: "claude_session_ensure",
        status: ensureSession.status ?? null,
        claude_session: executor.session,
        stdout: cleanProcessText(ensureSession.stdout),
        stderr: cleanProcessText(ensureSession.stderr)
      });
    }
    if (ensureSession.error) {
      throw new Error(`acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`);
    }
    if (ensureSession.status !== 0) {
      throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`));
    }

    const outputPath = path.join(newResult.paths.conversationDir, `${executor.kind}-output.log`);
    const outputFd = openPrivateAppendFile(outputPath);
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      env: executorEnv,
      cwd: workspace
    });
    child.unref();
    fs.closeSync(outputFd);

    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "executor_launch",
      mode: "background",
      pid: child.pid ?? null,
      executor,
      output_path: outputPath
    });
    runtimeLog("info", "executor_launch", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      mode: "background",
      pid: child.pid ?? null,
      output_path: outputPath
    });
    if (executor.kind === "claude") {
      appendEvent(newResult.paths.logPath, {
        ts: new Date().toISOString(),
        conversation_id: newResult.conversation.conversation_id,
        event: "claude_launch",
        mode: "background",
        pid: child.pid ?? null,
        claude_session: executor.session,
        output_path: outputPath
      });
    }
    const monitor = startExecutorMonitor({
      statePath: newResult.paths.statePath,
      logPath: newResult.paths.logPath,
      pid: child.pid,
      outputPath,
      agentTimeoutMinutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES),
      pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
    });
    appendEvent(newResult.paths.logPath, {
      ts: new Date().toISOString(),
      conversation_id: newResult.conversation.conversation_id,
      event: "executor_monitor_launch",
      pid: monitor.pid ?? null,
      executor_pid: child.pid ?? null,
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
    });
    runtimeLog("info", "executor_monitor_launch", {
      conversation_id: newResult.conversation.conversation_id,
      monitor_pid: monitor.pid ?? null,
      executor_pid: child.pid ?? null,
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
    });

    printJson({
      ...newResult,
      launched: true,
      background: true,
      pid: child.pid ?? null,
      monitor_pid: monitor.pid ?? null,
      output_path: outputPath
    });
    return;
  }

  if (options.send) {
    const acpxPath = resolveExecutable("acpx");
    const ensureSession = ensureExecutorSession({
      acpxPath,
      executor,
      cwd: workspace,
      env: executorEnv
    });
    if (ensureSession.error) {
      throw new Error(`acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`);
    }
    if (ensureSession.status !== 0) {
      throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`));
    }
    const result = spawnSync(acpxPath, acpxArgs, {
      stdio: "inherit",
      cwd: workspace,
      env: executorEnv
    });
    runtimeLog("info", "executor_send", {
      conversation_id: newResult.conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      status: result.status ?? null,
      failure_kind: classifyProcessFailure(result)
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  runtimeLog("info", "delegate_dry_run", {
    conversation_id: newResult.conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session
  });
  printJson({
    ...newResult,
    dry_run: true,
    acpx_command: ["acpx", ...acpxArgs],
    note: "Run again with --send to send this task through acpx."
  });
}

function ensureExecutorSession({
  acpxPath,
  executor,
  cwd,
  env,
  resumeSessionId
}: {
  acpxPath: string;
  executor: any;
  cwd: string;
  env: NodeJS.ProcessEnv;
  resumeSessionId?: string;
}) {
  const args = [...acpxAgentSelectorArgs(executor), "sessions", "ensure"];
  if (resumeSessionId) {
    args.push("--resume-session", resumeSessionId);
  } else {
    args.push("--name", executor.session);
  }
  return spawnSync(acpxPath, args, {
    encoding: "utf8",
    cwd,
    env
  });
}

function startExecutorMonitor({ statePath, logPath, pid, outputPath, agentTimeoutMinutes, pollIntervalMs }) {
  const args = [
    new URL(import.meta.url).pathname,
    "monitor",
    "--state",
    statePath,
    "--log",
    logPath,
    "--agent-timeout-minutes",
    String(agentTimeoutMinutes),
    "--poll-interval-ms",
    String(pollIntervalMs)
  ];
  if (pid) {
    args.push("--pid", String(pid));
  }
  if (outputPath) {
    args.push("--output-path", outputPath);
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

function startTerminalBridgeMonitor({
  statePath,
  logPath,
  agentTimeoutMinutes,
  agentHardTimeoutMinutes,
  pollIntervalMs,
  codexHome,
  claudeHome,
  claudeHookStoreDir
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
  if (claudeHookStoreDir) {
    args.push("--claude-hook-store-dir", claudeHookStoreDir);
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
    claudeHome: options.claudeHome ?? nativeTakeover?.["claude_home"],
    claudeHookStoreDir: options.claudeHookStoreDir ?? nativeTakeover?.["claude_hook_store_dir"]
  });
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

interface ClaudeHookLeaseState {
  lease: ClaudeManagedLease;
  storeDir: string;
  pid?: number;
  sessionId?: string;
}

function activateClaudeHookLease({
  options,
  conversation,
  message,
  terminalControl,
  expiresAt
}): ClaudeHookLeaseState | undefined {
  if (!stringValue(options.claudeHookStoreDir)) {
    return undefined;
  }
  const runtime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  const pid = runtime.pid;
  const agentRow = pid === undefined
    ? undefined
    : loadClaudeAgentRows(options).find((row) => row.pid === pid && (row.kind === undefined || row.kind === "interactive"));
  const sessionId = agentRow?.sessionId ?? runtime.sessionId;
  const cwd = agentRow?.cwd ?? runtime.cwd ?? terminalControl.currentPath;
  if (!cwd || (pid === undefined && !sessionId)) {
    runtimeLog("warn", "claude_hook_lease_unavailable", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      reason: "exact Claude pid/session identity is unavailable"
    });
    return undefined;
  }

  const store = createClaudeHookStore(options);
  try {
    const previous = store.resolveLease({
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(pid === undefined ? {} : { pid }),
      cwd,
      requireUnique: true
    });
    if (previous && (
      previous.lease.conversationId !== conversation.conversation_id ||
      previous.lease.messageId !== message.id
    )) {
      store.releaseLease({ leaseId: previous.lease.id });
    }
    const lease = store.activateLease({
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(pid === undefined ? {} : { pid }),
      cwd,
      conversationId: conversation.conversation_id,
      messageId: message.id,
      terminalTarget: terminalControl.target,
      expiresAt
    });
    runtimeLog("info", "claude_hook_lease_activated", {
      conversation_id: conversation.conversation_id,
      message_id: message.id,
      terminal_target: terminalControl.target,
      lease_id: lease.id,
      pid,
      session_id: sessionId,
      expires_at: lease.expiresAt
    });
    return {
      lease,
      storeDir: store.rootDir,
      ...(pid === undefined ? {} : { pid }),
      ...(sessionId === undefined ? {} : { sessionId })
    };
  } catch (error) {
    runtimeLog("warn", "claude_hook_lease_unavailable", {
      conversation_id: conversation.conversation_id,
      terminal_target: terminalControl.target,
      reason: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function withClaudeHookLeaseState(conversation, state: ClaudeHookLeaseState) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  return {
    ...conversation,
    native_session_takeover: {
      ...nativeTakeover,
      claude_hook_mode: "enabled",
      claude_hook_store_dir: state.storeDir,
      claude_hook_lease_id: state.lease.id,
      terminal_agent_pid: state.pid,
      terminal_agent_session_id: state.sessionId
    }
  };
}

function releaseClaudeHookLease(conversation): void {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const leaseId = stringValue(nativeTakeover?.claude_hook_lease_id);
  if (!leaseId || nativeTakeover?.agent !== "claude") {
    return;
  }
  const storeDir = stringValue(nativeTakeover.claude_hook_store_dir) ?? defaultClaudeHookStoreDir();
  try {
    const released = new ClaudeHookStore({ rootDir: storeDir }).releaseLease({ leaseId });
    runtimeLog("info", "claude_hook_lease_released", {
      conversation_id: conversation.conversation_id,
      message_id: released?.messageId,
      lease_id: leaseId
    });
  } catch (error) {
    runtimeLog("warn", "claude_hook_lease_release_failed", {
      conversation_id: conversation.conversation_id,
      lease_id: leaseId,
      reason: error instanceof Error ? error.message : String(error)
    });
  }
}

function renewClaudeHookLease(conversation, expiresAt: string): ClaudeManagedLease | undefined {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (
    nativeTakeover?.agent !== "claude" ||
    nativeTakeover.claude_hook_mode !== "enabled" ||
    !stringValue(nativeTakeover.claude_hook_store_dir)
  ) {
    return undefined;
  }
  const conversationId = stringValue(conversation.conversation_id);
  const messageId = stringValue(nativeTakeover.terminal_bridge_message_id);
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  const cwd = stringValue(nativeTakeover.source_cwd) ?? terminalControl?.currentPath;
  const pid = Number.isInteger(Number(nativeTakeover.terminal_agent_pid))
    ? Number(nativeTakeover.terminal_agent_pid)
    : undefined;
  const sessionId = stringValue(nativeTakeover.terminal_agent_session_id);
  if (!conversationId || !messageId || !terminalControl || !cwd || (pid === undefined && !sessionId)) {
    return undefined;
  }
  const storeDir = stringValue(nativeTakeover.claude_hook_store_dir) ?? defaultClaudeHookStoreDir();
  try {
    return new ClaudeHookStore({ rootDir: storeDir }).activateLease({
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(pid === undefined ? {} : { pid }),
      cwd,
      conversationId,
      messageId,
      terminalTarget: terminalControl.target,
      expiresAt
    });
  } catch (error) {
    runtimeLog("warn", "claude_hook_lease_renew_failed", {
      conversation_id: conversationId,
      message_id: messageId,
      reason: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

function releaseClaudeHookLeasesForTerminal({
  storeDir,
  terminalControl,
  replacementConversationId
}): void {
  for (const candidate of listConversations(storeDir)) {
    if (candidate.conversation_id === replacementConversationId) {
      continue;
    }
    const nativeTakeover = isRecord(candidate.native_session_takeover)
      ? candidate.native_session_takeover
      : undefined;
    const candidateControl = terminalControlFromTakeover(nativeTakeover);
    if (
      nativeTakeover?.agent === "claude" &&
      nativeTakeover?.terminal_bridge === true &&
      candidateControl?.target === terminalControl.target &&
      candidateControl?.socketPath === terminalControl.socketPath
    ) {
      releaseClaudeHookLease(candidate);
    }
  }
}

function uniqueDelegateSessionName(kind) {
  const { sessionPrefix } = executorDefinitionForKind(kind || "claude");
  const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `${sessionPrefix}-${timestamp}-${randomUUID().slice(0, 8)}`;
}

function buildAcpxPromptArgs({ executor, payload, model }) {
  const args = ["--approve-all"];
  if (model) {
    args.push("--model", model);
  }
  args.push(...acpxPromptArgs({ executor, payload }));
  return args;
}

function acpxCancelArgs({ executor }: { executor: any }) {
  return [...acpxAgentSelectorArgs(executor), "cancel", "-s", executor.session];
}

function acpxPromptArgs({ executor, payload }: { executor: any; payload: string }) {
  if (executor.kind === "codex") {
    return [...acpxAgentSelectorArgs(executor), "prompt", "-s", executor.session, payload];
  }
  return [...acpxAgentSelectorArgs(executor), "-s", executor.session, payload];
}

function acpxAgentSelectorArgs(executor: any): string[] {
  if (executor.kind !== "codex") {
    return [acpxCommandForExecutor(executor)];
  }

  const command = codexAcpxAgentCommand();
  if (/@zed-industries\/codex-acp\b/u.test(command)) {
    throw new Error([
      "Refusing to start Codex through deprecated @zed-industries/codex-acp.",
      "Use @agentclientprotocol/codex-acp for AKK Codex ACPX delegation.",
      "Set AKK_CODEX_ACPX_AGENT_COMMAND to a supported ACP adapter command if you need an override."
    ].join(" "));
  }

  return ["--agent", command];
}

function codexAcpxAgentCommand(): string {
  return process.env.AKK_CODEX_ACPX_AGENT_COMMAND?.trim() || DEFAULT_CODEX_ACPX_AGENT_COMMAND;
}

function proxyForExecutor(executor, options: Record<string, any> = {}) {
  const explicit = options.allProxy ?? options.proxy;
  if (explicit) {
    return explicit;
  }
  return proxyEnvForExecutor(executor, process.env);
}

function modelForExecutor(executor, options: Record<string, any> = {}) {
  const explicit = options.model ?? options.codexModel;
  if (explicit) {
    return normalizeModelForExecutor(executor, explicit);
  }
  return normalizeModelForExecutor(executor, modelEnvForExecutor(executor, process.env));
}

function environmentForExecutor(executor, options = {}) {
  const environment = environmentWithoutGatewayTokens();
  const proxy = proxyForExecutor(executor, options);
  if (!proxy) {
    return environment;
  }

  return {
    ...environment,
    ALL_PROXY: proxy,
    all_proxy: proxy
  };
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
  const conversations = listConversations(storeDir)
    .map((conversation) => summarizeConversation(conversation))
    .filter((conversation) => includeAll || isActiveStatus(conversation.status))
    .filter((conversation) => !agentFilter || conversation.agent === agentFilter)
    .filter((conversation) => !statusFilter || conversation.status === statusFilter);
  const delegated = conversations.map(delegatedListEntry);
  const nativeScan = await buildNativeListGroups({ options, agentFilter, statusFilter });

  printJson({
    store_dir: storeDir,
    cleanup,
    delegated,
    native: nativeScan.native,
    terminal_controlled: nativeScan.terminalControlled,
    native_scan: nativeScan.summary,
    tasks: conversations
  });
  runtimeLog("info", "tasks_listed", {
    store_dir: storeDir,
    returned_count: conversations.length,
    native_count: nativeScan.native.length,
    terminal_controlled_count: nativeScan.terminalControlled.length,
    native_scan_error: nativeScan.summary.error,
    include_all: includeAll,
    agent_filter: agentFilter,
    status_filter: statusFilter,
    cleanup
  });
}

async function buildNativeListGroups({ options, agentFilter, statusFilter }) {
  const empty = {
    native: [],
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
        skipped: `native active discovery skipped for status filter ${statusFilter}`
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
  const terminalScan = options.terminalDebug ? await terminalControlDiagnostics(terminalProvider) : undefined;
  const terminalControlled: Record<string, any>[] = [];
  const native: Record<string, any>[] = [];
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
    activeCount = activeSessions.length;
    const rootSessions = rootActiveProcesses(activeSessions);
    for (const session of rootSessions) {
      if (session.terminalControl) {
        terminalControlled.push(await terminalControlledListEntry(
          session,
          activeSessions,
          options,
          bridge
        ));
      } else {
        native.push(nativeListEntry(session, activeSessions));
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  return {
    native,
    terminalControlled,
    summary: {
      enabled: true,
      agents: adapters.map((adapter) => adapter.agent),
      active_count: activeCount,
      native_count: native.length,
      terminal_controlled_count: terminalControlled.length,
      approval_scan: options.noApprovalScan ? "disabled" : "enabled",
      terminal_scan: terminalScan,
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

function delegatedListEntry(task) {
  return {
    ...task,
    id: task.conversation_id,
    source: "akk_delegate",
    commands: {
      send: canSendDelegated(task.status),
      cancel: isWaitingForAgent(task.status),
      close: task.status !== "closed",
      status: true,
      approve: false
    }
  };
}

function nativeListEntry(session: ActiveTerminalProcess, activeSessions: ActiveTerminalProcess[]) {
  return {
    id: `native:${session.agent}:${session.pid}`,
    source: "native_active",
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
    commands: {
      terminate_then_resume: true,
      fork: Boolean(session.sessionId),
      terminal_control_attach: false,
      send: false,
      cancel: false,
      approve: false,
      close: false,
      status: false
    }
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
  return {
    id: bridge.terminalConversationId(session),
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
    commands: {
      send: true,
      approve: terminalControl.capabilities.includes("terminal_approval") &&
        terminalState.approval_state.approvable === true,
      status: true,
      cancel: terminalControl.capabilities.includes("terminal_cancel"),
      close: false
    }
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
  return !["failed", "closed", "cancelled"].includes(status);
}

async function resolveTerminalConversationFromOptions(
  options
): Promise<ResolvedTerminalConversation | undefined> {
  return createTerminalAgentBridge(options).resolveConversationId(
    stringValue(options.conversation ?? options.conversationId)
  );
}

function parseNativeConversationId(conversationId: string | undefined): { conversationId: string; agent: "codex"; pid: number } | undefined {
  const prefix = "native:codex:";
  if (!conversationId?.startsWith(prefix)) {
    return undefined;
  }
  const pid = Number(conversationId.slice(prefix.length));
  if (!Number.isInteger(pid)) {
    throw new Error(`invalid native conversation id: ${conversationId}`);
  }
  return {
    conversationId,
    agent: "codex",
    pid
  };
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
    printJson({
      conversation_id: terminalConversation.conversationId,
      source: "terminal_control",
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

async function runDescribe(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const conversationId = required(options.conversation ?? options.conversationId, "--conversation is required");
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
    if (terminalConversation.agent !== "codex") {
      const adapter = createRuntimeTerminalAgentRegistry(options).require(terminalConversation.agent);
      printJson({
        conversation_id: conversationId,
        source: "terminal_control",
        agent: terminalConversation.agent,
        confidence: terminalStatus.reachable ? "medium" : "low",
        about: terminalStatus.reachable
          ? `${adapter.displayName} is attached through ${terminalConversation.terminalControl.kind}:${terminalConversation.terminalControl.target}.`
          : `${adapter.displayName} terminal status is unavailable.`,
        evidence: {
          terminal_status: terminalStatus,
          terminal_screen: terminalStatus.screen
        },
        limitations: ["Historical session context is not available for this terminal adapter."],
        terminal_control: terminalConversation.terminalControl
      });
      return;
    }
    const process = await activeCodexProcessForPid(options, terminalConversation.pid);
    printJson(await describeNativeCodexSession({
      id: conversationId,
      source: "terminal_control",
      process,
      options,
      terminalControl: terminalConversation.terminalControl,
      terminalStatus
    }));
    return;
  }

  const nativeConversation = parseNativeConversationId(conversationId);
  if (nativeConversation) {
    const process = await activeCodexProcessForPid(options, nativeConversation.pid);
    printJson(await describeNativeCodexSession({
      id: conversationId,
      source: "native_active",
      process,
      options
    }));
    return;
  }

  const loaded = loadConversationFromOptions(options);
  const { statePath, logPath } = loaded;
  const conversation = await migrateLegacyTerminalAgentIdentity({
    ...loaded,
    options
  });
  const events = readExistingEvents(logPath);
  const terminalControl = terminalControlFromTakeover(
    isRecord(conversation.native_session_takeover) ? conversation.native_session_takeover : undefined
  );
  const terminalStatus = terminalControl
    ? await terminalStatusForControl(
        executorForConversation(conversation).kind,
        terminalControl,
        options,
        terminalRuntimeIdentityForConversation(conversation, terminalControl)
      )
    : undefined;
  printJson({
    conversation_id: conversation.conversation_id,
    source: "akk_managed",
    confidence: "high",
    about: managedConversationAbout(conversation, events, terminalStatus),
    summary: summarizeConversation(conversation),
    evidence: {
      initial_request: conversation.user_request,
      recent_messages: recentMessageEvidence(events),
      trace: buildConversationTrace({ conversation, events, logPath }),
      terminal_screen: terminalStatus?.screen
    },
    limitations: terminalStatus?.reachable === false ? ["terminal status unavailable"] : [],
    state_path: statePath,
    event_log_path: logPath
  });
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

function assertSafeClaudeTerminalSend(terminalStatus): void {
  const approval = isRecord(terminalStatus?.approval_state)
    ? terminalStatus.approval_state
    : undefined;
  if (terminalStatus?.reachable !== true) {
    throw new Error("Claude Code terminal status is unavailable");
  }
  if (approval?.blocked === true) {
    throw new Error(
      stringValue(approval.reason) ?? "Claude Code is waiting at a permission dialog"
    );
  }
  if (terminalStatus.activity_state !== "idle") {
    throw new Error(
      `Claude Code terminal is ${stringValue(terminalStatus.activity_state) ?? "unknown"}, not idle`
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
  const keyDescription = decisionMode === "structured"
    ? "structured one-time Hook decision"
    : keys.length > 0
      ? keys.join(" then ")
      : stringValue(approval.key) || "the detected approve key sequence";
  const fingerprint = stringValue(approval.fingerprint);
  const promptKind = stringValue(approval.prompt_kind);
  const command = stringValue(approval.command);
  const toolName = stringValue(approval.tool_name);
  const requestDetail = stringValue(approval.request_detail);
  const requestId = stringValue(approval.request_id);
  const excerpt = stringValue(screen.excerpt) || "(No terminal excerpt was available.)";
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
    requestId ? `Structured request id: ${requestId}` : undefined,
    "",
    "Safe terminal excerpt:",
    "```text",
    excerpt,
    "```",
    "",
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
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    const previousNotifiedAt = validTimestampMs(previousApproval?.notified_at);
    if (
      previousApproval?.fingerprint === fingerprint &&
      previousNotifiedAt !== undefined &&
      Date.now() - previousNotifiedAt <= CLAUDE_SCREEN_APPROVAL_TTL_MS
    ) {
      return {
        conversation,
        duplicate: true,
        stale: false,
        previousApproval,
        recorded: undefined
      };
    }

    const now = new Date().toISOString();
    const nextConversation = {
      ...conversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_approval: {
          fingerprint,
          notified_at: now,
          terminal_control: terminalControl,
          approval_state: terminalStatus.approval_state
        }
      },
      updated_at: now
    };
    saveState(statePath, nextConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_notification_recorded",
      terminal_control: terminalControl,
      fingerprint
    });
    return {
      conversation: nextConversation,
      duplicate: false,
      stale: false,
      recorded: onRecorded?.(nextConversation)
    };
  } finally {
    releaseLock();
  }
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
  if (["done", "failed", "closed", "cancelled"].includes(conversation.status)) {
    throw new Error(`cannot send to ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }
  if (conversation.status === "needs_recovery") {
    throw new Error(`cannot send to ${conversation.conversation_id}; choose recover, close, or delegate a new task first`);
  }
  if (conversation.status === "needs_model_selection" && !options.model) {
    throw new Error(`cannot send to ${conversation.conversation_id}; choose a supported model with --model first`);
  }

  const executor = executorForConversation(conversation);
  const type = options.type ??
    (conversation.status === "waiting_for_openclaw" ? "answer" : "task");
  const nativeTakeoverForSend = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (
    rejectTerminalControl &&
    terminalControlFromTakeover(nativeTakeoverForSend)
  ) {
    throw new Error(
      "terminal control changed while waiting to send; refresh status and retry"
    );
  }
  const forkTakeoverForSend = isRecord(conversation.fork_context_takeover)
    ? conversation.fork_context_takeover
    : undefined;
  const needsNativeTakeoverBootstrap =
    nativeTakeoverForSend?.["needs_bootstrap"] === true;
  const needsForkTakeoverBootstrap =
    forkTakeoverForSend?.["needs_bootstrap"] === true;
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
  const previousModelSelection = isRecord(conversation.model_selection)
    ? conversation.model_selection as Record<string, unknown>
    : {};
  const nextConversation = {
    ...applyMessageToConversation(conversation, message),
    executor,
    claude_session: executor.kind === "claude"
      ? executor.session
      : conversation.claude_session,
    executor_model: options.model ?? conversation.executor_model,
    model_selection: conversation.status === "needs_model_selection"
      ? {
          ...previousModelSelection,
          resolved_at: new Date().toISOString(),
          selected_model: options.model
        }
      : conversation.model_selection
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
    forkTakeoverForSend,
    needsNativeTakeoverBootstrap,
    needsForkTakeoverBootstrap,
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
    if (options.background) {
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
          needsNativeTakeoverBootstrap: true,
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
    await runTerminalConversationSend({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      pid: terminalConversation.pid,
      messageBody,
      terminalControl: terminalConversation.terminalControl
    });
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
        needsNativeTakeoverBootstrap: prepared.needsNativeTakeoverBootstrap,
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
  const prepared = prepareManagedSend({
    options,
    statePath,
    logPath,
    messageBody,
    rejectTerminalControl: true
  });
  const {
    conversation,
    executor,
    nativeTakeoverForSend,
    forkTakeoverForSend,
    needsNativeTakeoverBootstrap,
    needsForkTakeoverBootstrap,
    message,
    nextConversation
  } = prepared;

  const executorEnv = environmentForExecutor(executor, {
    allProxy: options.allProxy ?? conversation.executor_all_proxy
  });
  const payload = buildAgentSendPayload({
    conversation,
    executor,
    message,
    includeNativeTakeoverBootstrap: needsNativeTakeoverBootstrap,
    includeForkTakeoverBootstrap: needsForkTakeoverBootstrap,
    forkTakeover: forkTakeoverForSend
  });
  const terminalControlForSend = terminalControlFromTakeover(nativeTakeoverForSend);
  if (terminalControlForSend) {
    await runTerminalControlSend({
      options,
      conversation,
      nextConversation,
      statePath,
      logPath,
      executor,
      message,
      terminalControl: terminalControlForSend,
      needsNativeTakeoverBootstrap
    });
    return;
  }
  if (nativeTakeoverForSend?.["native_session_id"] && executor.kind === "codex") {
    runNativeCodexResumeSend({
      options,
      conversation,
      nextConversation,
      statePath,
      logPath,
      executor,
      executorEnv,
      message,
      payload,
      nativeTakeover: nativeTakeoverForSend,
      needsNativeTakeoverBootstrap
    });
    return;
  }

  const acpxPath = resolveExecutable("acpx");
  const executorModel = modelForExecutor(executor, {
    model: options.model ?? conversation.executor_model
  });
  const ensureSession = ensureExecutorSession({
    acpxPath,
    executor,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv,
    resumeSessionId: stringValue(nativeTakeoverForSend?.["native_session_id"])
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_session_ensure",
    status: ensureSession.status ?? null,
    executor,
    stdout: cleanProcessText(ensureSession.stdout),
    stderr: cleanProcessText(ensureSession.stderr)
  });
  runtimeLog("info", "executor_session_ensure", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: ensureSession.status ?? null,
    failure_kind: classifyProcessFailure(ensureSession),
    stdout: textSummary(cleanProcessText(ensureSession.stdout)),
    stderr: textSummary(cleanProcessText(ensureSession.stderr))
  });
  if (ensureSession.error) {
    if (requiresExplicitRecoveryDecision(options)) {
      printJson(markConversationNeedsRecovery({
        conversation: nextConversation,
        statePath,
        logPath,
        executor,
        message,
        failedStage: "session_ensure",
        result: ensureSession,
        reason: `acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`
      }));
      return;
    }
    autoRecoverSendFailure({
      options,
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      message,
      failedStage: "session_ensure",
      result: ensureSession,
      reason: `acpx ${executor.kind} session ensure failed to start: ${ensureSession.error.message}`
    });
    return;
  }
  if (ensureSession.status !== 0) {
    const reason = cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} sessions ensure exited with status ${ensureSession.status}`);
    if (requiresExplicitRecoveryDecision(options)) {
      printJson(markConversationNeedsRecovery({
        conversation: nextConversation,
        statePath,
        logPath,
        executor,
        message,
        failedStage: "session_ensure",
        result: ensureSession,
        reason
      }));
      return;
    }
    autoRecoverSendFailure({
      options,
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      message,
      failedStage: "session_ensure",
      result: ensureSession,
      reason
    });
    return;
  }

  const acpxArgs = buildAcpxPromptArgs({ executor, payload, model: executorModel });

  if (options.background) {
    const outputPath = path.join(path.dirname(logPath), `${executor.kind}-followup-output.log`);
    const outputFd = openPrivateAppendFile(outputPath);
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      cwd: conversation.workspace ?? process.cwd(),
      env: executorEnv
    });
    child.unref();
    fs.closeSync(outputFd);

    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "executor_message_launch",
      mode: "background",
      pid: child.pid ?? null,
      executor,
      output_path: outputPath
    });
    runtimeLog("info", "executor_message_launch", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      mode: "background",
      pid: child.pid ?? null,
      output_path: outputPath
    });
    const monitor = startExecutorMonitor({
      statePath,
      logPath,
      pid: child.pid,
      outputPath,
      agentTimeoutMinutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES),
      pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
    });
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "executor_monitor_launch",
      pid: monitor.pid ?? null,
      executor_pid: child.pid ?? null,
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
    });

    const deliveredConversation = markTakeoverBootstrapped({
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      native: needsNativeTakeoverBootstrap,
      fork: needsForkTakeoverBootstrap
    });

    printJson({
      conversation: deliveredConversation,
      message,
      delivered: true,
      background: true,
      status: "async_pending",
      pid: child.pid ?? null,
      monitor_pid: monitor.pid ?? null,
      output_path: outputPath,
      executor,
      budget: budgetAction(nextConversation),
      openclaw_next_action: openClawYieldNextAction({
        conversationId: deliveredConversation.conversation_id,
        source: "executor_background",
        callbackExpected: Boolean(deliveredConversation.callback_command || deliveredConversation.gateway_method)
      })
    });
    return;
  }

  const sendResult = spawnSync(acpxPath, acpxArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_message_send",
    status: sendResult.status ?? null,
    executor,
    stdout: cleanProcessText(sendResult.stdout),
    stderr: cleanProcessText(sendResult.stderr)
  });
  runtimeLog("info", "executor_message_send", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: sendResult.status ?? null,
    failure_kind: classifyProcessFailure(sendResult),
    stdout: textSummary(cleanProcessText(sendResult.stdout)),
    stderr: textSummary(cleanProcessText(sendResult.stderr))
  });
  if (sendResult.error) {
    if (requiresExplicitRecoveryDecision(options)) {
      printJson(markConversationNeedsRecovery({
        conversation: nextConversation,
        statePath,
        logPath,
        executor,
        message,
        failedStage: "message_send",
        result: sendResult,
        reason: `acpx ${executor.kind} send failed to start: ${sendResult.error.message}`
      }));
      return;
    }
    autoRecoverSendFailure({
      options,
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      message,
      failedStage: "message_send",
      result: sendResult,
      reason: `acpx ${executor.kind} send failed to start: ${sendResult.error.message}`
    });
    return;
  }
  if (sendResult.status !== 0) {
    const reason = cleanProcessText(sendResult.stderr || sendResult.stdout || `acpx ${executor.kind} send exited with status ${sendResult.status}`);
    if (requiresExplicitRecoveryDecision(options)) {
      printJson(markConversationNeedsRecovery({
        conversation: nextConversation,
        statePath,
        logPath,
        executor,
        message,
        failedStage: "message_send",
        result: sendResult,
        reason
      }));
      return;
    }
    autoRecoverSendFailure({
      options,
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      message,
      failedStage: "message_send",
      result: sendResult,
      reason
    });
    return;
  }

  const deliveredConversation = markTakeoverBootstrapped({
    conversation: nextConversation,
    statePath,
    logPath,
    executor,
    native: needsNativeTakeoverBootstrap,
    fork: needsForkTakeoverBootstrap
  });

  printJson({
    conversation: deliveredConversation,
    message,
    delivered: true,
    executor,
    budget: budgetAction(deliveredConversation)
  });
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
  if (["done", "failed", "closed", "cancelled"].includes(conversation.status)) {
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
  const hooklessClaudeScreenApproval =
    executor.kind === "claude" &&
    nativeTakeover?.claude_hook_mode !== "enabled";
  if (hooklessClaudeScreenApproval) {
    const monitoredState = isRecord(monitoredApproval?.approval_state)
      ? monitoredApproval.approval_state
      : undefined;
    const pendingDispatch = isRecord(
      nativeTakeover?.terminal_bridge_approval_dispatch
    )
      ? nativeTakeover.terminal_bridge_approval_dispatch
      : undefined;
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
  const autoApproved = options.autoApproved === true;
  const policyRuleId = stringValue(options.policyRuleId);
  const policyFingerprint = stringValue(options.policyFingerprint);
  const autoApprovalPolicy = autoApproved
    ? parseJsonOption(options.autoApprovalPolicyJson, "--auto-approval-policy-json")
    : undefined;
  const runtimeIdentity = terminalRuntimeIdentityForConversation(conversation, terminalControl);
  let executorPolicyDecision;
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
        hooklessClaudeScreenApproval &&
        currentApproval?.fingerprint !== monitoredApproval?.fingerprint
      )
    ) {
      throw new Error("approval state changed while waiting for terminal control; refresh status and retry");
    }
    lockedConversation = currentConversation;
    approval = await createTerminalAgentBridge(options).approve(
      executor.kind,
      terminalControl,
      {
        expectedFingerprint,
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: runtimeIdentity,
        requiredDecisionMode: autoApproved && executor.kind === "claude"
          ? "structured"
          : undefined,
        authorize: autoApproved
          ? ({ agent, terminalControl: currentTerminalControl, inspection, fingerprint }) => {
              if (!autoApprovalPolicy) {
                return {
                  approved: false,
                  reason: "automatic approval requires an executor-side policy"
                };
              }
              const candidate: ApprovalCandidate = {
                agent,
                kind: inspection.approval.promptKind ?? "unknown",
                decisionMode: inspection.approval.approvable
                  ? inspection.approval.action.mode ?? "keys"
                  : undefined,
                command: inspection.approval.command,
                cwd: inspection.approval.cwd ?? currentTerminalControl.currentPath,
                fingerprint: fingerprint ?? "",
                terminalTarget: currentTerminalControl.target
              };
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
        beforeKeyDispatch: hooklessClaudeScreenApproval
          ? ({ fingerprint, terminalControl: dispatchControl, keys }) => {
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
                latestControl?.socketPath !== dispatchControl.socketPath
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
      terminal_bridge_last_approval_at: approvalResolvedAt,
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
    let nextConversation = {
      ...lockedConversation,
      status: terminalBridgeEnabled(lockedConversation)
        ? "waiting_for_agent" as const
        : lockedConversation.status,
      native_session_takeover: nextNativeTakeover,
      updated_at: approvalResolvedAt
    };
    const approvalLeaseDeadlines = [
      stringValue(nextNativeTakeover.terminal_bridge_inactivity_deadline_at),
      stringValue(nextNativeTakeover.terminal_bridge_hard_deadline_at)
    ].filter((value): value is string => Boolean(value));
    if (approvalLeaseDeadlines.length > 0) {
      const renewedLease = renewClaudeHookLease(
        nextConversation,
        new Date(Math.min(...approvalLeaseDeadlines.map((value) => Date.parse(value)))).toISOString()
      );
      if (renewedLease) {
        nextConversation = {
          ...nextConversation,
          native_session_takeover: {
            ...nextNativeTakeover,
            claude_hook_lease_id: renewedLease.id
          }
        };
      }
    }
    saveState(statePath, nextConversation);
    releaseApprovalStateLock();
    releaseApprovalTerminalLock();

    const bridgeMonitor = startTerminalBridgeMonitorForConversation({
      conversation: nextConversation,
      statePath,
      logPath,
      options
    });
    if (bridgeMonitor) {
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: bridgeMonitor.pid ?? null,
        terminal_control: terminalControl,
        reason: "approval_resolved",
        agent_timeout_minutes: agentTimeoutMinutes,
        agent_hard_timeout_minutes: agentHardTimeoutMinutes
      });
      runtimeLog("info", "terminal_bridge_monitor_launch", {
        conversation_id: conversation.conversation_id,
        monitor_pid: bridgeMonitor.pid ?? null,
        terminal_target: terminalControl.target,
        reason: "approval_resolved"
      });
    }

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
      monitor_pid: bridgeMonitor?.pid ?? null
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

async function runTerminalConversationSend({ options, conversationId, agent, pid, messageBody, terminalControl }) {
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  try {
    const terminalPayload = terminalSubmissionPayload(String(messageBody));
    const terminalBridge = createTerminalAgentBridge(options);
    if (agent === "claude") {
      const status = await terminalBridge.status(agent, terminalControl, {
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: {
          pid,
          cwd: terminalControl.currentPath,
          terminalTarget: terminalControl.target
        }
      });
      assertSafeClaudeTerminalSend(status);
    }
    await terminalBridge.send(agent, terminalControl, terminalPayload, {
      runtime: {
        pid,
        cwd: terminalControl.currentPath,
        terminalTarget: terminalControl.target
      }
    });
    runtimeLog("info", "terminal_message_send", {
      conversation_id: conversationId,
      agent,
      terminal_target: terminalControl.target,
      message: textSummary(messageBody)
    });

    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      delivered: true,
      status: "async_pending",
      background: true,
      callback_expected: false,
      terminal_control: terminalControl,
      message: {
        body: messageBody
      },
      openclaw_next_action: openClawYieldNextAction({
        conversationId,
        source: "terminal_control",
        callbackExpected: false
      })
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
  needsNativeTakeoverBootstrap,
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
        needsNativeTakeoverBootstrap,
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
        needsNativeTakeoverBootstrap,
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
  const terminalPayload = needsNativeTakeoverBootstrap && !bridge
    ? terminalSubmissionPayload(buildAgentSendPayload({
        conversation,
        executor,
        message,
        includeNativeTakeoverBootstrap: true,
        includeForkTakeoverBootstrap: false,
        forkTakeover: undefined
    }))
    : terminalSubmissionPayload(String(message.body ?? ""));
  const preSendRuntime: TerminalRuntimeIdentity = {
    ...terminalRuntimeIdentityForConversation(nextConversation, terminalControl),
    messageId: message.id
  };
  let preSendScreenFingerprint: string | undefined;
  let claudeTranscriptAnchor: ClaudeTranscriptAnchor | undefined;
  const claudeHome = executor.kind === "claude"
    ? path.resolve(expandHome(options.claudeHome) ?? defaultClaudeHome())
    : undefined;
  if (bridge) {
    try {
      const status = await terminalBridge.status(executor.kind, terminalControl, {
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        runtime: preSendRuntime
      });
      if (executor.kind === "claude") {
        assertSafeClaudeTerminalSend(status);
      }
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
        if (
          !claudeTranscriptAnchor &&
          !stringValue(options.claudeHookStoreDir)
        ) {
          throw new Error(
            "the hook-free completion monitor could not bind an owner-private Claude transcript boundary"
          );
        }
      }
    } catch (error) {
      if (executor.kind === "claude") {
        throw new Error(
          `refusing to send to Claude Code without a verified idle terminal: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      // Codex delivery can still use its established fallback when capture is unavailable.
    }
  }
  if (bridge && executor.kind === "claude") {
    releaseClaudeHookLeasesForTerminal({
      storeDir: storeDirFromOptions(options),
      terminalControl,
      replacementConversationId: conversation.conversation_id
    });
    releaseClaudeHookLease(nextConversation);
  }
  const claudeHookLeaseState = bridge && executor.kind === "claude"
    ? activateClaudeHookLease({
        options,
        conversation: nextConversation,
        message,
        terminalControl,
        expiresAt: deadlineAt(
          bridgeStartedAt,
          agentTimeoutMinutes > 0
            ? Math.min(agentTimeoutMinutes, agentHardTimeoutMinutes)
            : agentHardTimeoutMinutes
        )
      })
    : undefined;
  const conversationWithHookLease = claudeHookLeaseState
    ? withClaudeHookLeaseState(nextConversation, claudeHookLeaseState)
    : nextConversation;
  try {
    await terminalBridge.send(executor.kind, terminalControl, terminalPayload, {
      runtime: preSendRuntime
    });
  } catch (error) {
    if (claudeHookLeaseState) {
      releaseClaudeHookLease(conversationWithHookLease);
    }
    throw error;
  }
  const bridgeConversation = bridge
    ? withTerminalBridgeState({
        conversation: conversationWithHookLease,
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
  const deliveredConversation = markTakeoverBootstrapped({
    conversation: bridgeConversation,
    statePath,
    logPath,
    executor,
    native: needsNativeTakeoverBootstrap && !bridge,
    fork: false,
    stateLockHeld: terminalStateLockHeld
  });
  saveState(statePath, deliveredConversation);
  const supersededConversationIds = bridge
    ? supersedeTerminalBridgeConversations({
        storeDir: storeDirFromOptions(options),
        terminalControl,
        replacementConversationId: conversation.conversation_id
      })
    : [];
  if (recordRawAttachmentAfterSend) {
    const sourceConversationId = stringValue(
      isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover.native_session_id
        : undefined
    );
    appendEvent(logPath, {
      ts: new Date().toISOString(),
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
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "terminal_message_send",
    executor,
    terminal_control: terminalControl,
    message: textSummary(message.body),
    payload: textSummary(terminalPayload),
    superseded_conversation_ids: supersededConversationIds
  });
  runtimeLog("info", "terminal_message_send", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    terminal_target: terminalControl.target,
    message: textSummary(message.body),
    payload: textSummary(terminalPayload),
    superseded_conversation_ids: supersededConversationIds
  });
  const bridgeMonitor = bridge
    ? startTerminalBridgeMonitorForConversation({
        conversation: deliveredConversation,
        statePath,
        logPath,
        options
      })
    : undefined;
  if (bridgeMonitor) {
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: deliveredConversation.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: bridgeMonitor.pid ?? null,
      terminal_control: terminalControl,
      agent_timeout_minutes: agentTimeoutMinutes,
      agent_hard_timeout_minutes: agentHardTimeoutMinutes
    });
    runtimeLog("info", "terminal_bridge_monitor_launch", {
      conversation_id: deliveredConversation.conversation_id,
      monitor_pid: bridgeMonitor.pid ?? null,
      terminal_target: terminalControl.target
    });
  }
  printJson({
    conversation: deliveredConversation,
    message,
    delivered: true,
    status: "async_pending",
    background: true,
    callback_expected: Boolean(deliveredConversation.callback_command || deliveredConversation.gateway_method),
    terminal_control: terminalControl,
    monitor_pid: bridgeMonitor?.pid ?? null,
    executor,
    budget: budgetAction(deliveredConversation),
    openclaw_next_action: openClawYieldNextAction({
      conversationId: deliveredConversation.conversation_id,
      source: "terminal_control",
      callbackExpected: Boolean(deliveredConversation.callback_command || deliveredConversation.gateway_method)
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
  const callbackCommand = options.callbackCommand
    ? expandCallbackCommandTemplate(options.callbackCommand, { statePath: paths.statePath })
    : buildCallbackCommand({
        statePath: paths.statePath,
        gatewayUrl: options.gatewayUrl ?? "ws://127.0.0.1:18789",
        token: options.token,
        openclawSession: options.openclawSession ?? "agent:main:main",
        gatewayMethod: options.gatewayMethod,
        gatewaySession: options.gatewaySession,
        openclawBin: options.openclawBin ?? resolveOptionalExecutable("openclaw")
      });
  const claudeAgent = agent === "claude"
    ? loadClaudeAgentRows(options).find((row) => row.pid === pid)
    : undefined;
  const attachedConversation = withStoragePaths({
    ...conversation,
    executor,
    status: "idle" as const,
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    callback_command: callbackCommand,
    gateway_url: options.gatewayUrl ?? "ws://127.0.0.1:18789",
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? options.openclawSession ?? "agent:main:main",
    openclaw_bin: options.openclawBin ?? resolveOptionalExecutable("openclaw"),
    executor_all_proxy: proxyForExecutor(executor, options),
    executor_model: options.model ?? (agent === "codex" ? options.codexModel : undefined),
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

function supersedeTerminalBridgeConversations({
  storeDir,
  terminalControl,
  replacementConversationId
}): string[] {
  const activeStatuses = new Set([
    "created",
    "running",
    "waiting_for_agent",
    "waiting_for_openclaw",
    "stalled",
    "cancelling"
  ]);
  const superseded: string[] = [];
  for (const candidate of listConversations(storeDir)) {
    if (candidate.conversation_id === replacementConversationId || !activeStatuses.has(candidate.status)) {
      continue;
    }
    const candidateTakeover = isRecord(candidate.native_session_takeover)
      ? candidate.native_session_takeover
      : undefined;
    const candidateControl = terminalControlFromTakeover(candidateTakeover);
    if (
      candidateTakeover?.["terminal_bridge"] !== true ||
      candidateControl?.target !== terminalControl.target ||
      candidateControl?.socketPath !== terminalControl.socketPath
    ) {
      continue;
    }

    const candidateStatePath = stringValue(candidate.state_path);
    if (!candidateStatePath) {
      continue;
    }
    const releaseLock = acquireFileLock(`${candidateStatePath}.lock`);
    try {
      const current = loadState(candidateStatePath);
      if (!activeStatuses.has(current.status)) {
        continue;
      }
      const currentTakeover = isRecord(current.native_session_takeover)
        ? current.native_session_takeover
        : undefined;
      const currentControl = terminalControlFromTakeover(currentTakeover);
      if (
        currentTakeover?.["terminal_bridge"] !== true ||
        currentControl?.target !== terminalControl.target ||
        currentControl?.socketPath !== terminalControl.socketPath
      ) {
        continue;
      }

      const now = new Date().toISOString();
      const closedConversation = {
        ...current,
        status: "closed" as const,
        closed_at: now,
        close_reason: "terminal bridge superseded by a newer task on the same terminal",
        superseded_by_conversation_id: replacementConversationId,
        updated_at: now
      };
      saveState(candidateStatePath, closedConversation);
      releaseClaudeHookLease(closedConversation);
      appendEvent(logPathForStatePath(candidateStatePath), {
        ts: now,
        conversation_id: current.conversation_id,
        event: "terminal_bridge_superseded",
        terminal_control: terminalControl,
        replacement_conversation_id: replacementConversationId
      });
      superseded.push(current.conversation_id);
    } finally {
      releaseLock();
    }
  }
  return superseded;
}

function runNativeCodexResumeSend({
  options,
  conversation,
  nextConversation,
  statePath,
  logPath,
  executor,
  executorEnv,
  message,
  payload,
  nativeTakeover,
  needsNativeTakeoverBootstrap
}) {
  const codexPath = resolveExecutable("codex");
  const nativeSessionId = String(nativeTakeover["native_session_id"]);
  const nativeModel = nativeCodexModelForSend({ options, conversation, nativeTakeover });
  const codexArgs = buildCodexExecResumeArgs({
    nativeSessionId,
    payload,
    model: nativeModel
  });

  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "native_executor_resume_prepare",
    executor,
    native_session_id: nativeSessionId,
    model: nativeModel ?? null
  });
  runtimeLog("info", "native_executor_resume_prepare", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    native_session_id: nativeSessionId,
    model: nativeModel
  });

  if (options.background) {
    const outputPath = path.join(path.dirname(logPath), `${executor.kind}-native-resume-output.log`);
    const outputFd = openPrivateAppendFile(outputPath);
    const child = spawn(codexPath, codexArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      cwd: conversation.workspace ?? process.cwd(),
      env: executorEnv
    });
    child.unref();
    fs.closeSync(outputFd);

    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "native_executor_resume_launch",
      mode: "background",
      pid: child.pid ?? null,
      executor,
      native_session_id: nativeSessionId,
      output_path: outputPath
    });
    runtimeLog("info", "native_executor_resume_launch", {
      conversation_id: conversation.conversation_id,
      agent: executor.kind,
      executor_session: executor.session,
      native_session_id: nativeSessionId,
      mode: "background",
      pid: child.pid ?? null,
      output_path: outputPath
    });
    const monitor = startExecutorMonitor({
      statePath,
      logPath,
      pid: child.pid,
      outputPath,
      agentTimeoutMinutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES),
      pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
    });
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "executor_monitor_launch",
      pid: monitor.pid ?? null,
      executor_pid: child.pid ?? null,
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
    });

    const deliveredConversation = markTakeoverBootstrapped({
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      native: needsNativeTakeoverBootstrap,
      fork: false
    });

    printJson({
      conversation: deliveredConversation,
      message,
      delivered: true,
      background: true,
      status: "async_pending",
      native_resume: true,
      pid: child.pid ?? null,
      monitor_pid: monitor.pid ?? null,
      output_path: outputPath,
      executor,
      budget: budgetAction(deliveredConversation),
      openclaw_next_action: openClawYieldNextAction({
        conversationId: deliveredConversation.conversation_id,
        source: "native_resume_background",
        callbackExpected: Boolean(deliveredConversation.callback_command || deliveredConversation.gateway_method)
      })
    });
    return;
  }

  const sendResult = spawnSync(codexPath, codexArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "native_executor_resume_send",
    status: sendResult.status ?? null,
    executor,
    native_session_id: nativeSessionId,
    stdout: cleanProcessText(sendResult.stdout),
    stderr: cleanProcessText(sendResult.stderr)
  });
  runtimeLog("info", "native_executor_resume_send", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    native_session_id: nativeSessionId,
    status: sendResult.status ?? null,
    failure_kind: classifyProcessFailure(sendResult),
    stdout: textSummary(cleanProcessText(sendResult.stdout)),
    stderr: textSummary(cleanProcessText(sendResult.stderr))
  });
  if (sendResult.error) {
    throw new Error(`codex exec resume failed to start: ${sendResult.error.message}`);
  }
  if (sendResult.status !== 0) {
    throw new Error(cleanProcessText(sendResult.stderr || sendResult.stdout || `codex exec resume exited with status ${sendResult.status}`));
  }

  const deliveredConversation = markTakeoverBootstrapped({
    conversation: nextConversation,
    statePath,
    logPath,
    executor,
    native: needsNativeTakeoverBootstrap,
    fork: false
  });

  printJson({
    conversation: deliveredConversation,
    message,
    delivered: true,
    native_resume: true,
    executor,
    budget: budgetAction(deliveredConversation)
  });
}

function buildCodexExecResumeArgs({ nativeSessionId, payload, model }) {
  const args = ["exec", "resume"];
  if (model) {
    args.push("--model", model);
  }
  args.push("--skip-git-repo-check", nativeSessionId, payload);
  return args;
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

function nativeCodexModelForSend({ options, conversation, nativeTakeover }) {
  const explicit = options.model ?? options.codexModel;
  if (explicit) {
    return normalizeNativeCodexModel(explicit);
  }

  const nativeModel = isRecord(nativeTakeover) ? nativeTakeover["native_model"] : undefined;
  if (typeof nativeModel === "string" && nativeModel.trim()) {
    return normalizeNativeCodexModel(nativeModel);
  }

  return normalizeNativeCodexModel(conversation.executor_model);
}

function normalizeNativeCodexModel(model) {
  const value = typeof model === "string" ? model.trim() : "";
  if (!value) {
    return undefined;
  }

  return value.replace(/\[[^\]]+\]$/u, "").replace(/\/(?:low|medium|high|xhigh)$/u, "");
}

function buildAgentSendPayload({ conversation, executor, message, includeNativeTakeoverBootstrap, includeForkTakeoverBootstrap, forkTakeover }) {
  const messageJson = JSON.stringify(message);
  if (!includeNativeTakeoverBootstrap && !includeForkTakeoverBootstrap) {
    return [
      "Continue the existing Agent Knock Knock delegation using this structured OpenClaw message.",
      "If this message answers a question or blocker, follow it as the product decision.",
      "Continue to report back only through the callback command already provided for this conversation.",
      "",
      messageJson
    ].join("\n");
  }

  if (includeForkTakeoverBootstrap) {
    const summary = forkTakeoverSummaryText(forkTakeover);
    return [
      executorBootstrapPrompt({
        callbackCommand: conversation.callback_command,
        executorName: executor.display_name,
        softLimit: Number(conversation.soft_limit ?? 50),
        hardLimit: Number(conversation.hard_limit ?? 100)
      }),
      "",
      "This AKK conversation is a fork of an existing native coding-agent session. Do not resume the original native session. Treat the approved summary below as the only imported context from the source session, then continue as a new AKK-managed session in this workspace.",
      "",
      "Approved source-session summary:",
      summary || "(No approved summary was provided.)",
      "",
      "Initial AKK fork message:",
      messageJson
    ].join("\n");
  }

  return [
    executorBootstrapPrompt({
      callbackCommand: conversation.callback_command,
      executorName: executor.display_name,
      softLimit: Number(conversation.soft_limit ?? 50),
      hardLimit: Number(conversation.hard_limit ?? 100)
    }),
    "",
    "This AKK conversation is attaching to an existing native coding-agent session. Continue from the native session context if it is available, and use the callback command above for all replies to OpenClaw.",
    "",
    "Initial AKK takeover message:",
    messageJson
  ].join("\n");
}

function forkTakeoverSummaryText(forkTakeover) {
  return String(isRecord(forkTakeover) ? forkTakeover.summary ?? "" : "").trim();
}

function markTakeoverBootstrapped({
  conversation,
  statePath,
  logPath,
  executor,
  native,
  fork,
  stateLockHeld = false
}) {
  let nextConversation = conversation;
  if (native) {
    nextConversation = markNativeSessionBootstrapped({
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      stateLockHeld
    });
  }
  if (fork) {
    nextConversation = markForkSessionBootstrapped({
      conversation: nextConversation,
      statePath,
      logPath,
      executor,
      stateLockHeld
    });
  }
  return nextConversation;
}

function markNativeSessionBootstrapped({
  conversation,
  statePath,
  logPath,
  executor,
  stateLockHeld = false
}) {
  const now = new Date().toISOString();
  const releaseLock = stateLockHeld
    ? undefined
    : acquireFileLock(`${statePath}.lock`);
  let nextConversation = conversation;
  try {
    const current = stateLockHeld ? conversation : loadState(statePath);
    const nativeTakeover = isRecord(current.native_session_takeover)
      ? current.native_session_takeover
      : {};
    nextConversation = {
      ...current,
      native_session_takeover: {
        ...nativeTakeover,
        needs_bootstrap: false,
        bootstrapped_at: now
      },
      updated_at: now
    };
    saveState(statePath, nextConversation);
  } finally {
    releaseLock?.();
  }
  appendEvent(logPath, {
    ts: now,
    conversation_id: nextConversation.conversation_id,
    event: "native_session_bootstrapped",
    executor
  });
  runtimeLog("info", "native_session_bootstrapped", {
    conversation_id: nextConversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    state_path: statePath
  });
  return nextConversation;
}

function markForkSessionBootstrapped({
  conversation,
  statePath,
  logPath,
  executor,
  stateLockHeld = false
}) {
  const now = new Date().toISOString();
  const releaseLock = stateLockHeld
    ? undefined
    : acquireFileLock(`${statePath}.lock`);
  let nextConversation = conversation;
  try {
    const current = stateLockHeld ? conversation : loadState(statePath);
    const forkTakeover = isRecord(current.fork_context_takeover)
      ? current.fork_context_takeover
      : {};
    nextConversation = {
      ...current,
      fork_context_takeover: {
        ...forkTakeover,
        needs_bootstrap: false,
        bootstrapped_at: now
      },
      updated_at: now
    };
    saveState(statePath, nextConversation);
  } finally {
    releaseLock?.();
  }
  appendEvent(logPath, {
    ts: now,
    conversation_id: nextConversation.conversation_id,
    event: "fork_session_bootstrapped",
    executor
  });
  runtimeLog("info", "fork_session_bootstrapped", {
    conversation_id: nextConversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    state_path: statePath
  });
  return nextConversation;
}

function requiresExplicitRecoveryDecision(options: Record<string, any> = {}) {
  if (options.recoveryPolicy === "explicit" || options.recoveryPolicy === "explicit-decision") {
    return true;
  }
  return false;
}

function autoRecoverSendFailure({ options, conversation, statePath, logPath, executor, message, failedStage, result, reason }) {
  markConversationNeedsRecovery({
    conversation,
    statePath,
    logPath,
    executor,
    message,
    failedStage,
    result,
    reason
  });
  runtimeLog("info", "conversation_auto_recovery_start", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    failed_stage: failedStage,
    reason: textSummary(reason)
  });
  runRecoveryDecision({
    ...options,
    mode: "recover",
    autoRecovered: true
  });
}

function markConversationNeedsRecovery({ conversation, statePath, logPath, executor, message, failedStage, result, reason }) {
  const now = new Date().toISOString();
  const failureKind = classifyProcessFailure(result);
  const recovery = {
    reason: "executor_session_unavailable",
    detail: reason,
    failed_at: now,
    failed_stage: failedStage,
    failure_kind: failureKind,
    failed_message_id: message.id,
    pending_message: message,
    previous_executor: executor,
    options: ["recover", "close", "delegate"]
  };
  const nextConversation = {
    ...conversation,
    status: "needs_recovery" as const,
    recovery,
    updated_at: now
  };
  saveState(statePath, nextConversation);
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "conversation_needs_recovery",
    status: "needs_recovery",
    executor,
    failed_stage: failedStage,
    failure_kind: failureKind,
    reason
  });
  runtimeLog("warn", "conversation_needs_recovery", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    failed_stage: failedStage,
    failure_kind: failureKind,
    reason: textSummary(reason)
  });
  return {
    conversation: nextConversation,
    message,
    delivered: false,
    requires_recovery_decision: true,
    recovery,
    executor,
    budget: budgetAction(nextConversation)
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
    const currentMessageId = stringValue(currentTakeover.terminal_bridge_message_id);
    const hardDeadline = deadlineAt(startedAt ?? now, hardTimeoutMinutes) ??
      new Date(Date.now() + hardTimeoutMinutes * 60 * 1000).toISOString();
    const inactivityDeadline = deadlineAt(now, inactivityTimeoutMinutes) ??
      new Date(Date.now() + inactivityTimeoutMinutes * 60 * 1000).toISOString();
    const renewedLease = executorForConversation(current).kind === "claude" && currentMessageId
      ? activateClaudeHookLease({
          options,
          conversation: current,
          message: { id: currentMessageId },
          terminalControl: currentControl,
          expiresAt: new Date(Math.min(
            Date.parse(hardDeadline),
            Date.parse(inactivityDeadline)
          )).toISOString()
        })
      : undefined;
    const renewedBase = renewedLease
      ? withClaudeHookLeaseState(current, renewedLease)
      : current;
    const renewedNativeTakeover = isRecord(renewedBase.native_session_takeover)
      ? renewedBase.native_session_takeover
      : currentTakeover;
    renewed = {
      ...renewedBase,
      status: "waiting_for_agent" as const,
      native_session_takeover: {
        ...renewedNativeTakeover,
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
    if (
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
  expectedMessageId
}: {
  statePath: string;
  expectedMessageId: string;
}) {
  const releaseStateLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
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

    let renewedLease: ClaudeManagedLease | undefined;
    const usesClaudeHookLease =
      executorForConversation(conversation).kind === "claude" &&
      eligibility.nativeTakeover.claude_hook_mode === "enabled";
    if (usesClaudeHookLease) {
      const leaseDeadlineAtMs = Math.min(
        eligibility.inactivityDeadlineAtMs,
        eligibility.hardDeadlineAtMs
      );
      if (leaseDeadlineAtMs <= Date.now()) {
        return {
          prepared: false as const,
          alreadyRunning: false,
          reason: "claude_hook_lease_deadline_elapsed"
        };
      }
      renewedLease = renewClaudeHookLease(
        conversation,
        new Date(leaseDeadlineAtMs).toISOString()
      );
      if (!renewedLease) {
        return {
          prepared: false as const,
          alreadyRunning: false,
          reason: "claude_hook_lease_refresh_failed"
        };
      }
    }

    const nextNativeTakeover = {
      ...eligibility.nativeTakeover,
      terminal_bridge_monitor_lock_version: TERMINAL_BRIDGE_MONITOR_LOCK_VERSION,
      ...(renewedLease ? { claude_hook_lease_id: renewedLease.id } : {})
    };
    const needsSave =
      eligibility.nativeTakeover.terminal_bridge_monitor_lock_version !==
        TERMINAL_BRIDGE_MONITOR_LOCK_VERSION ||
      (renewedLease !== undefined &&
        eligibility.nativeTakeover.claude_hook_lease_id !== renewedLease.id);
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
  if (["closed", "cancelled"].includes(conversation.status)) {
    throw new Error(`cannot cancel ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }

  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (terminalControl) {
    await runTerminalControlCancel({
      options,
      conversation,
      statePath,
      logPath,
      agent: executorForConversation(conversation).kind,
      terminalControl
    });
    return;
  }

  const executor = executorForConversation(conversation);
  const acpxPath = resolveExecutable("acpx");
  const executorEnv = environmentForExecutor(executor, {
    allProxy: options.allProxy ?? conversation.executor_all_proxy
  });
  const cancelArgs = acpxCancelArgs({ executor });
  const cancelResult = spawnSync(acpxPath, cancelArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  const now = new Date().toISOString();
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "executor_cancel_requested",
    status: cancelResult.status ?? null,
    executor,
    stdout: cleanProcessText(cancelResult.stdout),
    stderr: cleanProcessText(cancelResult.stderr)
  });
  runtimeLog("info", "executor_cancel_requested", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    status: cancelResult.status ?? null,
    failure_kind: classifyProcessFailure(cancelResult),
    stdout: textSummary(cleanProcessText(cancelResult.stdout)),
    stderr: textSummary(cleanProcessText(cancelResult.stderr))
  });
  if (cancelResult.error) {
    throw new Error(`acpx ${executor.kind} cancel failed to start: ${cancelResult.error.message}`);
  }
  if (cancelResult.status !== 0) {
    throw new Error(cleanProcessText(cancelResult.stderr || cancelResult.stdout || `acpx ${executor.kind} cancel exited with status ${cancelResult.status}`));
  }

  const nextConversation = {
    ...conversation,
    status: "cancelling" as const,
    cancel_requested_at: now,
    updated_at: now
  };
  saveState(statePath, nextConversation);
  runtimeLog("info", "conversation_cancelling", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    state_path: statePath
  });

  printJson({
    conversation: nextConversation,
    cancel_requested: true,
    executor,
    acpx_command: ["acpx", ...cancelArgs],
    budget: budgetAction(nextConversation)
  });
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

async function runTerminalControlCancel({ options, conversation, statePath, logPath, agent, terminalControl }) {
  const releaseTerminalLock = acquireFileLock(
    terminalBridgeSendLockPath(storeDirFromOptions(options), terminalControl),
    { timeoutMs: 30000 }
  );
  let releaseStateLock: (() => void) | undefined;
  try {
    releaseStateLock = acquireFileLock(`${statePath}.lock`);
    const currentConversation = loadState(statePath);
    if (["closed", "cancelled"].includes(currentConversation.status)) {
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
    releaseClaudeHookLease(nextConversation);

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

function runRecover(options) {
  runRecoveryDecision({ ...options, mode: "recover" });
}

function runRecoveryDecision(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  if (conversation.status !== "needs_recovery") {
    throw new Error(`cannot ${options.mode} ${conversation.conversation_id}; conversation is ${conversation.status}`);
  }
  const pendingMessage = conversation.recovery?.pending_message;
  if (!isRecord(pendingMessage)) {
    throw new Error(`cannot ${options.mode} ${conversation.conversation_id}; recovery pending message is missing`);
  }

  const previousExecutor = executorForConversation(conversation);
  const executor = resolveExecutor({
    kind: previousExecutor.kind,
    session: options.session ?? uniqueDelegateSessionName(previousExecutor.kind)
  });
  const now = new Date().toISOString();
  const recoveredConversation = {
    ...conversation,
    executor,
    claude_session: executor.kind === "claude" ? executor.session : conversation.claude_session,
    status: "waiting_for_agent" as const,
    recovery: {
      ...conversation.recovery,
      resolved_at: now,
      resolution: options.mode,
      previous_session: previousExecutor.session,
      new_session: executor.session
    },
    updated_at: now
  };
  saveState(statePath, recoveredConversation);

  const payload = buildRecoverPayload({ conversation, pendingMessage, logPath });
  const acpxPath = resolveExecutable("acpx");
  const executorEnv = environmentForExecutor(executor, {
    allProxy: options.allProxy ?? conversation.executor_all_proxy
  });
  const executorModel = modelForExecutor(executor, {
    model: options.model ?? conversation.executor_model
  });
  const ensureSession = ensureExecutorSession({
    acpxPath,
    executor,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_recovery_session_ensure",
    mode: options.mode,
    status: ensureSession.status ?? null,
    executor,
    stdout: cleanProcessText(ensureSession.stdout),
    stderr: cleanProcessText(ensureSession.stderr)
  });
  if (ensureSession.error) {
    throw new Error(`acpx ${executor.kind} recovery session ensure failed to start: ${ensureSession.error.message}`);
  }
  if (ensureSession.status !== 0) {
    throw new Error(cleanProcessText(ensureSession.stderr || ensureSession.stdout || `acpx ${executor.kind} recovery sessions ensure exited with status ${ensureSession.status}`));
  }

  const acpxArgs = buildAcpxPromptArgs({ executor, payload, model: executorModel });
  if (options.background) {
    const outputPath = path.join(path.dirname(logPath), `${executor.kind}-${options.mode}-output.log`);
    const outputFd = openPrivateAppendFile(outputPath);
    const child = spawn(acpxPath, acpxArgs, {
      detached: true,
      stdio: ["ignore", outputFd, outputFd],
      cwd: conversation.workspace ?? process.cwd(),
      env: executorEnv
    });
    child.unref();
    fs.closeSync(outputFd);
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "executor_recovery_launch",
      mode: options.mode,
      run_mode: "background",
      pid: child.pid ?? null,
      executor,
      output_path: outputPath
    });
    const monitor = startExecutorMonitor({
      statePath,
      logPath,
      pid: child.pid,
      outputPath,
      agentTimeoutMinutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES),
      pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
    });
    printJson({
      conversation: recoveredConversation,
      recovered: true,
      auto_recovered: Boolean(options.autoRecovered),
      background: true,
      pid: child.pid ?? null,
      monitor_pid: monitor.pid ?? null,
      output_path: outputPath,
      executor,
      budget: budgetAction(recoveredConversation)
    });
    return;
  }

  const sendResult = spawnSync(acpxPath, acpxArgs, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd: conversation.workspace ?? process.cwd(),
    env: executorEnv
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_recovery_send",
    mode: options.mode,
    status: sendResult.status ?? null,
    executor,
    stdout: cleanProcessText(sendResult.stdout),
    stderr: cleanProcessText(sendResult.stderr)
  });
  if (sendResult.error) {
    throw new Error(`acpx ${executor.kind} recovery send failed to start: ${sendResult.error.message}`);
  }
  if (sendResult.status !== 0) {
    throw new Error(cleanProcessText(sendResult.stderr || sendResult.stdout || `acpx ${executor.kind} recovery send exited with status ${sendResult.status}`));
  }

  printJson({
    conversation: recoveredConversation,
    recovered: true,
    auto_recovered: Boolean(options.autoRecovered),
    delivered: true,
    executor,
    budget: budgetAction(recoveredConversation)
  });
}

function buildRecoverPayload({ conversation, pendingMessage, logPath }) {
  return [
    "Recover this Agent Knock Knock task in a new ACPX session.",
    "The previous coding-agent session was unavailable. This is AKK replay recovery, not native agent session resume.",
    "Use the saved protocol history summary below as context, then continue with the pending OpenClaw message.",
    "Continue to report back only through the callback command already provided for this conversation.",
    "",
    "Task:",
    conversation.user_request,
    "",
    "Saved protocol history:",
    formatProtocolHistoryForRecovery(readExistingEvents(logPath)),
    "",
    "Pending OpenClaw message:",
    JSON.stringify(pendingMessage)
  ].join("\n");
}

function formatProtocolHistoryForRecovery(events) {
  const lines = events
    .filter((event) => event.event === "message")
    .map((event) => event.message ?? event)
    .filter((message) => message?.from && message?.to && message?.type)
    .slice(-40)
    .map((message) => {
      const body = String(message.body ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
      return `- round ${message.round ?? "?"}: ${message.from} -> ${message.to} ${message.type}: ${body}`;
    });
  return lines.length ? lines.join("\n") : "- No prior protocol messages were recorded.";
}

async function runClose(options) {
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
    releaseClaudeHookLease(closed);
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
      closed: true
    });
  } finally {
    try {
      releaseStateLock?.();
    } finally {
      releaseTerminalLock();
    }
  }
}

async function runMonitor(options) {
  if (options.callbackRetry) {
    return runCallbackRetryMonitor(options);
  }
  if (options.terminalBridge) {
    return await runTerminalBridgeMonitor(options);
  }

  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const pid = options.pid ? Number(options.pid) : undefined;
  const timeoutMinutes = Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES);
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS));

  let conversation = loadState(statePath);
  const executor = executorForConversation(conversation);
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "executor_monitor_started",
    executor,
    executor_pid: Number.isFinite(pid) ? pid : null,
    agent_timeout_minutes: timeoutMinutes,
    poll_interval_ms: pollIntervalMs,
    output_path: options.outputPath
  });
  runtimeLog("info", "executor_monitor_started", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    executor_pid: Number.isFinite(pid) ? pid : null,
    agent_timeout_minutes: timeoutMinutes
  });

  while (true) {
    conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "executor_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_no_longer_waiting"
      });
      printJson({
        conversation,
        monitored: true,
        stalled: false,
        reason: "conversation_no_longer_waiting"
      });
      return;
    }

    if (Number.isFinite(pid) && !isProcessAlive(pid)) {
      const outputTail = readOutputTail(options.outputPath);
      const modelSelection = detectModelSelectionError(outputTail);
      if (modelSelection) {
        const modelSelectionConversation = markConversationNeedsModelSelection({
          statePath,
          logPath,
          reason: modelSelection.message,
          detail: {
            executor_pid: pid,
            output_path: options.outputPath,
            model_selection: modelSelection
          }
        });
        printJson({
          conversation: modelSelectionConversation,
          monitored: true,
          stalled: false,
          needs_model_selection: true,
          reason: modelSelectionConversation?.model_selection?.message ?? modelSelection.message
        });
        return;
      }
      const transientFailure = detectTransientExecutorFailure(outputTail);
      if (transientFailure) {
        const recoveryResult = markMonitorFailureNeedsRecovery({
          statePath,
          logPath,
          reason: transientFailure.message,
          detail: {
            executor_pid: pid,
            output_path: options.outputPath,
            transient_failure: transientFailure
          },
          outputTail
        });
        if (recoveryResult) {
          printJson({
            conversation: recoveryResult.conversation,
            monitored: true,
            stalled: false,
            needs_recovery: true,
            reason: transientFailure.message
          });
          return;
        }
      }
      const stalledConversation = markConversationStalled({
        statePath,
        logPath,
        reason: `executor process ${pid} exited before callback`,
        detail: {
          executor_pid: pid,
          output_path: options.outputPath
        }
      });
      printJson({
        conversation: stalledConversation,
        monitored: true,
        stalled: true,
        reason: stalledConversation?.stalled_reason
      });
      return;
    }

    if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
      const updatedAtMs = Date.parse(String(conversation.updated_at ?? conversation.created_at));
      if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= timeoutMinutes * 60 * 1000) {
        const stalledConversation = markConversationStalled({
          statePath,
          logPath,
          reason: `no callback after ${timeoutMinutes} minutes`,
          detail: {
            agent_timeout_minutes: timeoutMinutes,
            output_path: options.outputPath
          }
        });
        printJson({
          conversation: stalledConversation,
          monitored: true,
          stalled: true,
          reason: stalledConversation?.stalled_reason
        });
        return;
      }
    }

    sleepSync(pollIntervalMs);
  }
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
      !["callback_pending", "callback_failed"].includes(conversation.status) ||
      !["pending", "failed"].includes(String(callbackDelivery?.status ?? "")) ||
      !isRecord(callbackDelivery?.message)
    ) {
      return;
    }
    if (attempts > CALLBACK_RETRY_DELAYS_MS.length) {
      return;
    }

    let releaseLock: (() => void) | undefined;
    try {
      releaseLock = acquireFileLock(`${statePath}.lock`);
    } catch (error) {
      if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
        sleepSync(1000);
        continue;
      }
      throw error;
    }
    try {
      const current = loadState(statePath);
      const currentDelivery = isRecord(current.callback_delivery)
        ? current.callback_delivery
        : undefined;
      const currentAttempts = Number(currentDelivery?.attempts ?? 0);
      if (
        !["callback_pending", "callback_failed"].includes(current.status) ||
        !["pending", "failed"].includes(String(currentDelivery?.status ?? "")) ||
        !isRecord(currentDelivery?.message) ||
        currentAttempts > CALLBACK_RETRY_DELAYS_MS.length
      ) {
        return;
      }
      try {
        runLockedCallback({
          statePath,
          messageJson: JSON.stringify(currentDelivery.message),
          gatewayMethod: stringValue(currentDelivery.gateway_method) ?? current.gateway_method,
          gatewaySession: stringValue(currentDelivery.gateway_session) ?? current.gateway_session,
          openclawSession: current.openclaw_session,
          openclawBin: stringValue(currentDelivery.openclaw_bin) ?? current.openclaw_bin,
          gatewayUrl: stringValue(currentDelivery.gateway_url) ?? current.gateway_url,
          token: current.gateway_token,
          closeTerminalBridgeOnDone: currentDelivery.close_terminal_bridge_on_done === true,
          retryPending: true,
          disableCallbackRetry: true
        });
        return;
      } catch {
        // The failed attempt is persisted by runLockedCallback; continue with bounded backoff.
      }
    } finally {
      releaseLock();
    }

    const latest = loadState(statePath);
    const latestDelivery = isRecord(latest.callback_delivery)
      ? latest.callback_delivery
      : undefined;
    const latestAttempts = Number(latestDelivery?.attempts ?? 0);
    if (
      !["callback_pending", "callback_failed"].includes(latest.status) ||
      !["pending", "failed"].includes(String(latestDelivery?.status ?? "")) ||
      !isRecord(latestDelivery?.message) ||
      latestAttempts > CALLBACK_RETRY_DELAYS_MS.length
    ) {
      return;
    }
    const delayMs = CALLBACK_RETRY_DELAYS_MS[Math.max(0, latestAttempts - 1)];
    sleepSync(delayMs);
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

    const nativeTakeover = isRecord(conversation.native_session_takeover)
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

    const requestText = String(
      nativeTakeover?.["terminal_bridge_request_text"] ?? conversation.user_request ?? ""
    );
    const startedAt = stringValue(nativeTakeover?.["terminal_bridge_started_at"]);
    const terminalRuntime = terminalRuntimeIdentityForConversation(conversation, terminalControl);
    const screenChangedSinceSend = preSendScreenFingerprint !== undefined &&
      previousScreenFingerprint !== undefined &&
      previousScreenFingerprint !== preSendScreenFingerprint;
    const poll = await terminalBridge.monitorPoll({
      agent: executor.kind,
      terminalControl,
      screenOptions: {
        scrollbackLines: Number(options.scrollbackLines ?? 120),
        requestText,
        screenChangedSinceSend,
        runtime: terminalRuntime
      },
      durableRequest: {
        sessionId: terminalRuntime.sessionId,
        cwd: stringValue(nativeTakeover?.["source_cwd"]),
        requestText,
        requestHash: stringValue(nativeTakeover?.["terminal_bridge_request_hash"]),
        startedAt,
        context: {
          conversation,
          nativeTakeover,
          ...terminalRuntime
        }
      }
    });
    const terminalStatus = poll.status;
    const approval = terminalStatus.approval_state;
    const currentScreenFingerprint = stringValue(terminalStatus?.screen?.digest) ??
      terminalBridgeScreenFingerprint(terminalStatus?.screen?.excerpt);
    const currentScreenChangedSinceSend = preSendScreenFingerprint !== undefined &&
      currentScreenFingerprint !== undefined &&
      currentScreenFingerprint !== preSendScreenFingerprint;
    if (
      executor.kind === "claude" &&
      isRecord(approval) &&
      approval.approvable === true &&
      approval.decision_mode === "keys" &&
      !currentScreenChangedSinceSend
    ) {
      previousScreenFingerprint = currentScreenFingerprint;
      runtimeLog("warn", "claude_screen_approval_not_new", {
        conversation_id: conversation.conversation_id,
        terminal_target: terminalControl.target,
        reason: "permission screen is not proven to have changed since the managed send"
      });
      sleepSync(pollIntervalMs);
      continue;
    }
    if (isRecord(approval) && approval.blocked === true && approval.approvable !== true) {
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
      if (/waiting for hook consumption/iu.test(approvalReason)) {
        sleepSync(pollIntervalMs);
        continue;
      }

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
        onRecorded: (notificationConversation) => {
          const callbackMessage = createMessage({
            conversation: notificationConversation,
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
            }
          });
          if (notificationConversation.gateway_method) {
            runLockedCallback({
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
              token: stringValue(notificationConversation.gateway_token)
            });
            return {
              callbackMessage,
              delivered: true
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
      if (notification.recorded?.delivered) {
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
    if (isRecord(approval) && approval.blocked === true) {
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
        onRecorded: (notificationConversation) => {
          const callbackMessage = createMessage({
            conversation: notificationConversation,
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
            }
          });
          if (notificationConversation.gateway_method) {
            runLockedCallback({
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
              token: stringValue(notificationConversation.gateway_token)
            });
            return {
              callbackMessage,
              delivered: true
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
      if (notification.recorded?.delivered) {
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
      const completionOutcome = completion.outcome === "failure" ? "failure" : "success";
      const callbackMessageId = deterministicTerminalCallbackMessageId({
        conversationId: conversation.conversation_id,
        terminalMessageId: currentMessageId,
        completionFingerprint,
        outcome: completionOutcome
      });
      const claim = claimTerminalBridgeCompletion({
        statePath,
        logPath,
        terminalMessageId: currentMessageId,
        completionFingerprint,
        completionId: completion.id,
        callbackMessageId,
        outcome: completionOutcome
      });
      if (!claim.claimed) {
        printJson({
          conversation: claim.conversation,
          monitored: true,
          terminal_bridge: true,
          completed: false,
          duplicate: true,
          reason: claim.reason
        });
        return;
      }
      try {
        conversation = claim.conversation;
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "terminal_bridge_completion_detected",
          terminal_control: terminalControl,
          match: completionMatch,
          completion_source: completion.source,
          completion_outcome: completionOutcome,
          completion_id: completion.id,
          terminal_session: completionMetadata.session,
          context_match: completionMetadata.context_match,
          assistant_timestamp: completion?.timestamp,
          rollout_turn_id: completion.source === "durable" ? completion.id : undefined,
          terminal_bridge_message_id: currentMessageId,
          callback_message_id: callbackMessageId
        });
        const callbackMessage = {
          ...createMessage({
            conversation,
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
              assistant_timestamp: completion?.timestamp,
              rollout_turn_id: completion.source === "durable" ? completion.id : undefined,
              terminal_bridge_message_id: currentMessageId
            }
          }),
          id: callbackMessageId
        };
        runLockedCallback({
          ...options,
          statePath,
          log: logPath,
          closeTerminalBridgeOnDone: completionOutcome === "success",
          trackCallbackDelivery: true,
          recoverTerminalCompletion: claim.resumed === true,
          preserveMessageId: true,
          messageJson: JSON.stringify(callbackMessage),
          gatewayMethod: conversation.gateway_method,
          gatewaySession: conversation.gateway_session,
          openclawSession: conversation.openclaw_session,
          openclawBin: conversation.openclaw_bin,
          gatewayUrl: stringValue(conversation.gateway_token) ? conversation.gateway_url : undefined,
          token: stringValue(conversation.gateway_token)
        });
      } finally {
        releaseClaudeHookLease(conversation);
        claim.release();
      }
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

function terminalBridgeSendLockPath(storeDir: string, terminalControl): string {
  ensureDir(storeDir);
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: terminalControl.target,
      socket_path: terminalControl.socketPath
    }))
    .digest("hex")
    .slice(0, 20);
  return path.join(storeDir, `.terminal-bridge-send-${terminalKey}.lock`);
}

function terminalBridgeRequestFingerprint(value): string | undefined {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
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

function claimTerminalBridgeCompletion({
  statePath,
  logPath,
  terminalMessageId,
  completionFingerprint,
  completionId,
  callbackMessageId,
  outcome
}) {
  const release = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const nativeTakeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : {};
    if (!isWaitingForAgent(conversation.status)) {
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
    const hardDeadlineAt = stringValue(nativeTakeover.terminal_bridge_hard_deadline_at);
    const leaseDeadlineAt = inactivityDeadlineAt && hardDeadlineAt
      ? new Date(Math.min(Date.parse(inactivityDeadlineAt), Date.parse(hardDeadlineAt))).toISOString()
      : inactivityDeadlineAt ?? hardDeadlineAt;
    const renewedLease = leaseDeadlineAt
      ? renewClaudeHookLease(currentConversation, leaseDeadlineAt)
      : undefined;
    const nextConversation = {
      ...currentConversation,
      native_session_takeover: {
        ...nativeTakeover,
        terminal_bridge_last_activity_at: observedAt,
        terminal_bridge_last_activity_reason: reason,
        terminal_bridge_inactivity_deadline_at: inactivityDeadlineAt,
        terminal_bridge_inactivity_timeout_minutes: timeoutMinutes,
        terminal_bridge_hard_timeout_minutes: hardTimeoutMinutes,
        claude_hook_lease_id: renewedLease?.id ?? nativeTakeover.claude_hook_lease_id
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
  return {
    agent: executor.kind,
    kind: stringValue(approval.prompt_kind) ?? "unknown",
    command: stringValue(approval.command),
    tool_name: stringValue(approval.tool_name),
    request_detail: stringValue(approval.request_detail),
    cwd: stringValue(approval.cwd) ?? terminalControl.currentPath,
    fingerprint,
    terminal_target: terminalControl.target,
    decision_mode: stringValue(approval.decision_mode)
  };
}

async function loadCodexTerminalContext({ conversation, nativeTakeover, options }) {
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
      return {
        context,
        process: activeProcess,
        match: activeProcess?.sessionId ? "process_session_id" : "native_session_id",
        confidence: "high"
      };
    }
  }

  const cwd = activeProcess?.cwd ?? stringValue(nativeTakeover?.["source_cwd"]);
  if (!cwd) {
    return undefined;
  }

  const sessions = (await provider.listHistoricalSessions())
    .filter((session) => session.cwd === cwd)
    .filter((session) => {
      if (!Number.isFinite(startedAtMs)) {
        return true;
      }
      return Number(session.updatedAtMs ?? 0) >= startedAtMs;
    })
    .sort((left, right) => Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0));
  const selected = sessions[0];
  if (!selected) {
    return undefined;
  }

  const context = await provider.getForkContext({
    sessionId: selected.id,
    maxMessages: Number(options.maxMessages ?? 16),
    maxCommands: Number(options.maxCommands ?? 10),
    maxTextLength: Number(options.maxTextLength ?? 4000)
  });
  if (!context) {
    return undefined;
  }

  return {
    context,
    process: activeProcess,
    match: sessions.length === 1 ? "cwd" : "cwd_latest",
    confidence: sessions.length === 1 ? "medium" : "low"
  };
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

function executableCheck(commandName) {
  try {
    const executable = resolveExecutable(commandName);
    return {
      command: commandName,
      available: true,
      path: executable
    };
  } catch (error) {
    return {
      command: commandName,
      available: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildCallbackCommand({
  statePath,
  gatewayUrl,
  token,
  openclawSession,
  gatewayMethod,
  gatewaySession,
  openclawBin
}) {
  const parts = [
    shellQuote(process.execPath),
    shellQuote(new URL(import.meta.url).pathname),
    "callback",
    "--state",
    shellQuote(statePath)
  ];

  if (gatewayMethod) {
    parts.push(
      "--gateway-method",
      shellQuote(gatewayMethod),
      "--gateway-session",
      shellQuote(gatewaySession ?? openclawSession)
    );
    if (openclawBin) {
      parts.push("--openclaw-bin", shellQuote(openclawBin));
    }
  } else if (token) {
    parts.push(
      "--gateway-url",
      shellQuote(gatewayUrl),
      "--token",
      shellQuote(token),
      "--openclaw-session",
      shellQuote(openclawSession)
    );
  } else {
    parts.push("--record-only");
  }

  parts.push("--message-json", "'<structured-message-json>'");
  return parts.join(" ");
}

function expandCallbackCommandTemplate(template, { statePath }) {
  return template
    .replaceAll("{statePath}", shellQuote(statePath))
    .replaceAll("{state_path}", shellQuote(statePath));
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
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    runLockedCallback({ ...options, statePath });
  } finally {
    releaseLock();
  }
}

function runRetryCallback(options) {
  const { conversation, statePath } = loadConversationFromOptions(options);
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  if (!["callback_pending", "callback_failed"].includes(conversation.status)) {
    throw new Error(
      `cannot retry callback for ${conversation.conversation_id}; conversation is ${conversation.status}`
    );
  }
  if (!callbackDelivery || !isRecord(callbackDelivery.message)) {
    throw new Error(`cannot retry callback for ${conversation.conversation_id}; pending callback is missing`);
  }

  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    runLockedCallback({
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
  } finally {
    releaseLock();
  }
}

function runLockedCallback(options) {
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = expandHome(options.log ?? logPathForStatePath(options.statePath));
  const conversation = loadState(options.statePath);
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
  const retryingPending = options.retryPending === true &&
    isRecord(callbackDelivery?.message) &&
    callbackDelivery.message.id === message.id &&
    ["pending", "failed"].includes(String(callbackDelivery.status ?? ""));
  const duplicateMessage = isDuplicateMessage(existingEvents, message);
  const recoveringTerminalCompletion = options.recoverTerminalCompletion === true &&
    duplicateMessage &&
    isWaitingForAgent(conversation.status);
  if (duplicateMessage && !retryingPending && !recoveringTerminalCompletion) {
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
    printJson({
      conversation,
      message,
      budget: budgetAction(conversation),
      delivered: false,
      duplicate: true
    });
    return;
  }

  const closeTerminalBridgeOnDone = message.type === "done" &&
    options.closeTerminalBridgeOnDone === true;
  const trackCallbackDelivery = closeTerminalBridgeOnDone ||
    options.trackCallbackDelivery === true ||
    callbackDelivery?.track_delivery === true;
  const requiresDelivery = Boolean(options.gatewayMethod) || options.recordOnly !== true;
  const deliveryAttempt = Number(callbackDelivery?.attempts ?? 0) + 1;
  let nextConversation = retryingPending
    ? conversation
    : applyMessageToConversation(conversation, message);
  const storedFinalStatus = stringValue(callbackDelivery?.final_status);
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
  if (!retryingPending && !recoveringTerminalCompletion) {
    appendEvent(logPath, messageEvent(message));
  }
  if (trackCallbackDelivery && requiresDelivery) {
    const now = new Date().toISOString();
    nextConversation = {
      ...nextConversation,
      status: "callback_pending" as const,
      callback_delivery: {
        status: "pending",
        message,
        attempts: deliveryAttempt,
        created_at: stringValue(callbackDelivery?.created_at) ?? now,
        last_attempt_at: now,
        gateway_method: options.gatewayMethod,
        gateway_session: options.gatewaySession ?? options.openclawSession ?? conversation.openclaw_session,
        gateway_url: options.gatewayUrl ?? conversation.gateway_url,
        openclaw_bin: options.openclawBin ?? conversation.openclaw_bin,
        close_terminal_bridge_on_done: closeTerminalBridgeOnDone,
        track_delivery: true,
        final_status: finalStatus,
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
    printJson({
      conversation: nextConversation,
      message,
      budget: budgetAction(nextConversation),
      delivered: false,
      duplicate: false
    });
    return;
  }
  try {
    const deliveryKind = deliverCallbackToOpenClaw({
      options,
      statePath: options.statePath,
      logPath,
      conversation: nextConversation,
      message
    });
    const deliveredAt = new Date().toISOString();
    let deliveredConversation = nextConversation;
    if (trackCallbackDelivery) {
      const deliveredStatus: ConversationStatus = closeTerminalBridgeOnDone ? "closed" : finalStatus;
      deliveredConversation = {
        ...nextConversation,
        status: deliveredStatus,
        ...(closeTerminalBridgeOnDone
          ? {
              closed_at: deliveredAt,
              close_reason: "terminal bridge task completed"
            }
          : {}),
        callback_delivery: {
          ...(isRecord(nextConversation.callback_delivery) ? nextConversation.callback_delivery : {}),
          status: "delivered",
          delivered_at: deliveredAt,
          last_error: undefined
        },
        updated_at: deliveredAt
      };
      delete deliveredConversation.idle_since;
      saveState(options.statePath, deliveredConversation);
      appendEvent(logPath, {
        ts: deliveredAt,
        conversation_id: conversation.conversation_id,
        event: "callback_delivery_succeeded",
        message_id: message.id,
        attempt: deliveryAttempt,
        status: deliveredStatus
      });
    }
    printJson({
      conversation: deliveredConversation,
      message,
      budget: budgetAction(deliveredConversation),
      delivered: true,
      duplicate: false,
      delivery: deliveryKind
    });
  } catch (error) {
    if (trackCallbackDelivery) {
      const failedAt = new Date().toISOString();
      const failedConversation = {
        ...nextConversation,
        status: "callback_failed" as const,
        callback_delivery: {
          ...(isRecord(nextConversation.callback_delivery) ? nextConversation.callback_delivery : {}),
          status: "failed",
          failed_at: failedAt,
          last_error: error instanceof Error ? error.message : String(error)
        },
        updated_at: failedAt
      };
      saveState(options.statePath, failedConversation);
      appendEvent(logPath, {
        ts: failedAt,
        conversation_id: conversation.conversation_id,
        event: "callback_delivery_failed",
        message_id: message.id,
        attempt: deliveryAttempt,
        error: failedConversation.callback_delivery.last_error
      });
      if (
        options.retryPending !== true &&
        options.disableCallbackRetry !== true &&
        deliveryAttempt <= CALLBACK_RETRY_DELAYS_MS.length
      ) {
        const retryMonitor = startCallbackRetryMonitor({ statePath: options.statePath });
        const retryDelayMs = CALLBACK_RETRY_DELAYS_MS[Math.max(0, deliveryAttempt - 1)];
        const retryState = {
          ...failedConversation,
          callback_delivery: {
            ...failedConversation.callback_delivery,
            retry_monitor_pid: retryMonitor.pid ?? null,
            next_attempt_at: new Date(Date.now() + retryDelayMs).toISOString()
          }
        };
        saveState(options.statePath, retryState);
        appendEvent(logPath, {
          ts: new Date().toISOString(),
          conversation_id: conversation.conversation_id,
          event: "callback_retry_monitor_launched",
          message_id: message.id,
          pid: retryMonitor.pid ?? null,
          next_attempt_at: retryState.callback_delivery.next_attempt_at
        });
      }
    }
    throw error;
  }
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

    const gatewayPayload = parseOptionalJson(delivery.stdout);
    const chatSendParams = isRecord(gatewayPayload?.chat_send) ? gatewayPayload.chat_send : undefined;
    const sessionSendParams = isRecord(gatewayPayload?.session_send) ? gatewayPayload.session_send : undefined;
    if (chatSendParams) {
      const chatSendDelivery = deliverToChatSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: chatSendParams
      });
      recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_chat_send_delivery",
        runtimeEvent: "callback_chat_send_delivery",
        delivery: chatSendDelivery
      });
      if (chatSendDelivery.status !== 0) {
        throw new Error(chatSendDelivery.stderr || chatSendDelivery.stdout || `chat callback delivery failed with status ${chatSendDelivery.status}`);
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
      recordCallbackProcessDelivery({
        logPath,
        conversation,
        message,
        event: "callback_session_send_delivery",
        runtimeEvent: "callback_session_send_delivery",
        delivery: sessionSendDelivery
      });
      if (sessionSendDelivery.status !== 0) {
        throw new Error(sessionSendDelivery.stderr || sessionSendDelivery.stdout || `session callback delivery failed with status ${sessionSendDelivery.status}`);
      }
      return "gateway_method+sessions_send";
    }
    return "gateway_method";
  }

  const gatewayUrl = options.gatewayUrl ?? conversation.gateway_url;
  const token = options.token ?? conversation.gateway_token;
  const openclawSession = options.openclawSession ?? conversation.openclaw_session;
  if (!gatewayUrl) {
    throw new Error("--gateway-url is required unless state has gateway_url");
  }
  if (!token || token === "<token>") {
    throw new Error("--token is required for callback delivery");
  }
  if (!openclawSession) {
    throw new Error("--openclaw-session is required unless state has openclaw_session");
  }
  const delivery = deliverToOpenClaw({ gatewayUrl, token, openclawSession, message });
  recordCallbackProcessDelivery({
    logPath,
    conversation,
    message,
    event: "callback_delivery",
    runtimeEvent: "callback_delivery",
    delivery
  });
  if (delivery.status !== 0) {
    throw new Error(delivery.stderr || delivery.stdout || `callback delivery failed with status ${delivery.status}`);
  }
  return "acpx";
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
    recovery: conversation.recovery,
    state_path: conversation.state_path,
    event_log_path: conversation.event_log_path
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

async function describeNativeCodexSession({
  id,
  source,
  process,
  options,
  terminalControl,
  terminalStatus
}: {
  id: string;
  source: "native_active" | "terminal_control";
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
      return nativeDescriptionFromContext({
        id,
        source,
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
      return nativeDescriptionFromContext({
        id,
        source,
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
    source,
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

function nativeDescriptionFromContext({
  id,
  source,
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
  source: "native_active" | "terminal_control";
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
    source,
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

    const acpx = text.match(/^\[acpx\]\s+(.+)$/);
    if (acpx) {
      clientEvents.push({
        name: "acpx",
        status: sanitizeTraceText(acpx[1], 220)
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

function terminateProcessTarget(target, { timeoutMs = 3000 } = {}) {
  const pids = [...target.childPids, target.pid]
    .filter((pid, index, all) => Number.isInteger(pid) && pid > 0 && all.indexOf(pid) === index);
  const signals: Array<Record<string, unknown>> = [];
  for (const pid of pids) {
    signals.push(sendSignalToPid(pid, "SIGTERM"));
  }

  const exited = waitForPidsToExit(pids, timeoutMs);
  return {
    target,
    signal: "SIGTERM",
    signals,
    exited,
    remainingPids: pids.filter((pid) => isProcessAlive(pid))
  };
}

function sendSignalToPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return {
      pid,
      signal,
      status: "sent"
    };
  } catch (error) {
    return {
      pid,
      signal,
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function waitForPidsToExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  return pids.every((pid) => !isProcessAlive(pid));
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
    releaseClaudeHookLease(stalledConversation);
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

function markMonitorFailureNeedsRecovery({ statePath, logPath, reason, detail = {}, outputTail = "" }) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  let recoveryResult;
  let recoveryMessage;
  try {
    const conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "executor_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_changed_before_recovery"
      });
      return undefined;
    }

    const executor = executorForConversation(conversation);
    const pendingMessage = latestPendingExecutorMessage({
      events: readExistingEvents(logPath),
      executor
    });
    if (!pendingMessage) {
      runtimeLog("warn", "monitor_recovery_skipped", {
        conversation_id: conversation.conversation_id,
        agent: executor.kind,
        executor_session: executor.session,
        reason: "pending_message_missing"
      });
      return undefined;
    }

    recoveryResult = markConversationNeedsRecovery({
      conversation,
      statePath,
      logPath,
      executor,
      message: pendingMessage,
      failedStage: "executor_monitor",
      result: {
        status: 1,
        stderr: outputTail
      },
      reason
    });
    const recoveredConversation = recoveryResult.conversation;
    const shouldNotify = Boolean(recoveredConversation.gateway_method && !recoveredConversation.recovery_notification_sent_at);
    if (shouldNotify) {
      recoveryMessage = createMessage({
        conversation: recoveredConversation,
        from: executor.actor,
        to: "openclaw",
        type: "error",
        requiresResponse: false,
        body: [
          `AKK marked this ${executor.display_name} task as needing recovery: ${reason}.`,
          "",
          `Conversation: ${recoveredConversation.conversation_id}`,
          `Session: ${executor.session}`,
          "Use `AKK recover` to replay saved AKK history in a new session, or `AKK close` to close it."
        ].join("\n")
      });
      const now = new Date().toISOString();
      recoveryResult.conversation = {
        ...recoveredConversation,
        recovery_notification_sent_at: now,
        recovery_notification_message_id: recoveryMessage.id,
        updated_at: now
      };
      saveState(statePath, recoveryResult.conversation);
    }
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "monitor_recovery_classified",
      status: "needs_recovery",
      reason,
      ...detail
    });
  } finally {
    releaseLock();
  }

  if (recoveryResult?.conversation && recoveryMessage) {
    deliverMonitorFailureNotification({
      statePath,
      logPath,
      conversation: recoveryResult.conversation,
      message: recoveryMessage,
      eventPrefix: "recovery"
    });
  }
  return recoveryResult;
}

function latestPendingExecutorMessage({ events, executor }) {
  for (const event of [...events].reverse()) {
    if (event.event !== "message") {
      continue;
    }

    const message = event.message ?? event;
    if (
      message?.from === "openclaw" &&
      message?.to === executor.actor &&
      message?.requires_response !== false
    ) {
      return message;
    }
  }
  return undefined;
}

function markConversationNeedsModelSelection({ statePath, logPath, reason, detail = {} }) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  let modelSelectionConversation;
  try {
    const conversation = loadState(statePath);
    if (!isWaitingForAgent(conversation.status)) {
      runtimeLog("info", "executor_monitor_finished", {
        conversation_id: conversation.conversation_id,
        status: conversation.status,
        reason: "conversation_changed_before_model_selection"
      });
      return conversation;
    }

    const now = new Date().toISOString();
    const detailRecord = detail as Record<string, unknown>;
    const modelSelection = isRecord(detailRecord.model_selection)
      ? detailRecord.model_selection as Record<string, unknown>
      : {};
    modelSelectionConversation = {
      ...conversation,
      status: "needs_model_selection" as const,
      model_selection: {
        detected_at: now,
        message: reason,
        ...modelSelection
      },
      updated_at: now
    };
    saveState(statePath, modelSelectionConversation);
    appendEvent(logPath, {
      ts: now,
      conversation_id: conversation.conversation_id,
      event: "conversation_needs_model_selection",
      status: "needs_model_selection",
      reason,
      ...detailRecord
    });
    runtimeLog("warn", "conversation_needs_model_selection", {
      conversation_id: conversation.conversation_id,
      agent: executorForConversation(conversation).kind,
      executor_session: executorForConversation(conversation).session,
      state_path: statePath,
      event_log_path: logPath,
      reason,
      ...detailRecord
    });
  } finally {
    releaseLock();
  }

  return modelSelectionConversation;
}

function deliverMonitorFailureNotification({ statePath, logPath, conversation, message, eventPrefix }) {
  deliverStalledNotification({ statePath, logPath, conversation, message, eventPrefix });
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

function safeReadEvents(logPath) {
  try {
    return readNdjsonLog(logPath);
  } catch {
    return [];
  }
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
    const listedTerminalBridge = terminalBridgeEnabled(listedConversation) &&
      isRecord(listedConversation.native_session_takeover) &&
      typeof listedConversation.native_session_takeover.terminal_bridge_message_id === "string";
    if (!listedTerminalBridge && now.getTime() - listedIdleSinceMs < timeoutMinutes * 60 * 1000) {
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
      if (!terminalBridge && now.getTime() - idleSinceMs < timeoutMinutes * 60 * 1000) {
        continue;
      }

      const logPath = conversation.event_log_path ?? logPathForStatePath(statePath);
      const closeReason = terminalBridge
        ? "terminal bridge task completed"
        : `idle timeout after ${timeoutMinutes} minutes`;
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
      runtimeLog("info", "idle_conversation_closed", {
        conversation_id: conversation.conversation_id,
        agent: executorForConversation(conversation).kind,
        executor_session: executorForConversation(conversation).session,
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

function deliverToOpenClaw({ gatewayUrl, token, openclawSession, message }) {
  const agent = `openclaw acp --url ${gatewayUrl} --session ${openclawSession}`;
  const result = spawnSync("acpx", ["--agent", agent, JSON.stringify(message)], {
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

function openClawGatewayEnvironment(token): NodeJS.ProcessEnv {
  if (!token || token === "<token>") {
    return process.env;
  }
  return {
    ...process.env,
    OPENCLAW_GATEWAY_TOKEN: token
  };
}

function captureJson(argv) {
  const result = spawnSync(process.execPath, [new URL(import.meta.url).pathname, ...argv], {
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `subcommand failed: ${argv[0]}`);
  }

  return JSON.parse(result.stdout);
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

function readOutputTail(outputPath, maxBytes = 65536) {
  if (!outputPath) {
    return "";
  }

  try {
    const resolvedPath = expandHome(outputPath);
    const stat = fs.statSync(resolvedPath);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const fd = fs.openSync(resolvedPath, "r");
    try {
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, start);
      return buffer.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function openPrivateAppendFile(filePath: string): number {
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    throw new Error(`refusing agent output symlink: ${filePath}`);
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number"
    ? fs.constants.O_NOFOLLOW
    : 0;
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      fs.constants.O_WRONLY |
      noFollow,
    0o600
  );
  if (!fs.fstatSync(descriptor).isFile()) {
    fs.closeSync(descriptor);
    throw new Error(`agent output must be a regular file: ${filePath}`);
  }
  fs.fchmodSync(descriptor, 0o600);
  return descriptor;
}

function detectModelSelectionError(text) {
  const cleaned = cleanProcessText(text);
  if (!cleaned) {
    return undefined;
  }

  const unsupportedAccount = /The '([^']+)' model is not supported when using Codex with a ChatGPT account/i.exec(cleaned);
  if (unsupportedAccount) {
    return {
      kind: "unsupported_chatgpt_account_model",
      attempted_model: unsupportedAccount[1],
      message: unsupportedAccount[0]
    };
  }

  const unadvertised = /Cannot apply --model "([^"]+)": the ACP agent did not advertise that model\. Available models:\s*([^\n\r]+)/i.exec(cleaned);
  if (unadvertised) {
    return {
      kind: "unadvertised_acpx_model",
      attempted_model: unadvertised[1],
      available_models: unadvertised[2]
        .split(",")
        .map((model) => model.trim())
        .filter(Boolean),
      message: unadvertised[0]
    };
  }

  return undefined;
}

function detectTransientExecutorFailure(text) {
  const cleaned = cleanProcessText(text);
  if (!cleaned) {
    return undefined;
  }

  if (isRemoteCompactStreamDisconnect(cleaned.toLowerCase())) {
    return {
      kind: "remote_compact_stream_disconnect",
      message: "Codex remote compact stream disconnected before completion"
    };
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
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
  agent-knock-knock new --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock record --state <file> --message-json <json>
  agent-knock-knock bootstrap-prompt --callback-command <command> [--agent ${agentList}]
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--store-dir <dir>] [--all-proxy <url>] [--agent-timeout-minutes <minutes>] [--token <gateway-token>] [--send|--background]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--all] [--managed-only] [--no-approval-scan] [--terminal-debug]
  agent-knock-knock status --conversation <id> [--store-dir <dir>] [--trace]
  agent-knock-knock describe --conversation <id> [--store-dir <dir>]
  agent-knock-knock send --conversation <id> --message <text> [--type answer|task|control] [--all-proxy <url>] [--agent-timeout-minutes <minutes>] [--agent-hard-timeout-minutes <minutes>]
  agent-knock-knock approve --conversation <id>
  agent-knock-knock cancel --conversation <id> [--all-proxy <url>]
  agent-knock-knock renew --conversation <id> [--minutes <inactivity-minutes>]
  agent-knock-knock reconcile-monitors [--store-dir <dir>]
  agent-knock-knock retry-callback --conversation <id> [--store-dir <dir>]
  agent-knock-knock recover --conversation <id> [--session <name>] [--all-proxy <url>]
  agent-knock-knock close --conversation <id> [--reason <text>]
  agent-knock-knock install-openclaw [--openclaw-bin <path>] [--skill-path <path>] [--skill-only] [--no-restart]
  agent-knock-knock doctor
  agent-knock-knock agent takeover --agent codex --session-id <id> --strategy terminate_then_resume|terminal_control|fork [--create-conversation]
  agent-knock-knock callback --state <file> --message-json <json> [--record-only]
  agent-knock-knock transcript --log <file> [--include-raw]
  agent-knock-knock transcript --conversation <dir> [--include-raw]
`);
}

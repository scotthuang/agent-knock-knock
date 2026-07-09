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
  ForkContextPackage,
  TerminalControlRef
} from "./codex-session-provider.js";
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
  resolveExecutor
} from "./protocol.js";
import {
  EXECUTOR_KINDS,
  acpxCommandForExecutor,
  executorDefinitionForKind,
  modelEnvForExecutor,
  normalizeModelForExecutor,
  proxyEnvForExecutor
} from "./executors.js";
import { executorBootstrapPrompt } from "./bootstrap.js";
import { writeRuntimeLog } from "./runtime-log.js";
import { formatTranscript, readNdjsonLog } from "./transcript.js";
import {
  appendEvent,
  defaultStoreDir,
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
  enrichActiveProcessesWithTerminalControl,
  terminalRefFromPane,
  type TerminalControlProvider
} from "./terminal-control-provider.js";

const DEFAULT_IDLE_TIMEOUT_MINUTES = 10080;
const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const DEFAULT_CODEX_ACPX_AGENT_COMMAND = "npx -y @agentclientprotocol/codex-acp@^1.1.0";

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
  if (commandName === "new") {
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
  } else if (commandName === "recover") {
    runRecover(options);
  } else if (commandName === "close") {
    runClose(options);
  } else if (commandName === "transcript") {
    runTranscript(options);
  } else if (commandName === "install-openclaw") {
    runInstallOpenClaw(options);
  } else if (commandName === "doctor") {
    runDoctor(options);
  } else if (commandName === "callback") {
    runCallback(options);
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
    runCheckedCommand(openclawBin, ["plugins", "install", "--link", "--force", root], {
      label: "openclaw plugins install"
    });
    steps.push({
      name: "plugin_installed",
      path: root
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

function runDoctor(options) {
  const commands = ["node", "openclaw", "acpx", "codex", "claude", "cursor"];
  const checks = commands.map((commandName) => executableCheck(commandName));
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
  const requiredOk = checks
    .filter((check) => ["node", "openclaw", "acpx"].includes(check.command))
    .every((check) => check.available);
  const agentOk = checks
    .filter((check) => ["codex", "claude", "cursor"].includes(check.command))
    .some((check) => check.available);
  const filesOk = packageFiles.every((check) => check.exists);

  printJson({
    ok: requiredOk && agentOk && filesOk,
    package_root: root,
    checks,
    package_files: packageFiles,
    notes: [
      "node, openclaw, and acpx are required.",
      "At least one local coding agent command should be available: codex, claude, or cursor."
    ],
    options
  });
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
  return enrichActiveProcessesWithTerminalControl(activeSessions, terminalProvider);
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
    capabilities: ["screen_status", "send_keys", "terminal_approval"]
  };
}

function detectCodexApprovalPrompt(screen: string): { approvable: true; key: string; label: string } | { approvable: false; reason: string } {
  const prompt = codexApprovalPromptRegion(screen);
  if (!prompt.visible) {
    return {
      approvable: false,
      reason: prompt.reason
    };
  }

  for (const line of prompt.region.split(/\r?\n/)) {
    const match = /^[\s›]*1\.\s+(Yes,[^(]+)\(([^)]+)\)/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const key = match[2].trim();
    if (key !== "y") {
      return {
        approvable: false,
        reason: `primary approval shortcut is ${key}, not y`
      };
    }
    return {
      approvable: true,
      key,
      label: match[1].trim()
    };
  }

  return {
    approvable: false,
    reason: "no primary approve option with a shortcut was detected"
  };
}

function isCodexApprovalPromptVisible(screen: string): boolean {
  return codexApprovalPromptRegion(screen).visible;
}

function codexApprovalPromptRegion(screen: string): { visible: true; region: string } | { visible: false; reason: string } {
  const approvalMarkers = [
    "Would you like to run the following command?",
    "Would you like to make the following edits?",
    "Would you like to grant these permissions?",
    "needs your approval."
  ];
  const lines = screen.split(/\r?\n/);
  let markerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (approvalMarkers.some((marker) => lines[index].includes(marker))) {
      markerIndex = index;
      break;
    }
  }

  if (markerIndex < 0) {
    return {
      visible: false,
      reason: "no Codex approval prompt was detected in the terminal screen"
    };
  }

  const regionLines = lines.slice(markerIndex);
  const staleLine = regionLines.slice(1).find((line) => isPostApprovalActivityLine(line));
  if (staleLine) {
    return {
      visible: false,
      reason: `Codex approval prompt appears stale after later terminal activity: ${staleLine.trim()}`
    };
  }

  return {
    visible: true,
    region: regionLines.join("\n")
  };
}

function isPostApprovalActivityLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^✔\s+You approved\b/u.test(trimmed)) {
    return true;
  }
  if (/^›\s+(?!1\.)\S/u.test(trimmed)) {
    return true;
  }
  if (/^•\s+(Working|Ran|Explored|Edited|Read|Called|Searching|Planning|Updated|Added|Deleted|Modified|Running|Thinking)\b/u.test(trimmed)) {
    return true;
  }
  return /^─\s*Worked for\b/u.test(trimmed);
}

function detectCodexActivityState(
  screen: string,
  approval = detectCodexApprovalPrompt(screen)
): { state: "awaiting_approval" | "working" | "idle" | "unknown"; reason: string } {
  if (approval.approvable || isCodexApprovalPromptVisible(screen)) {
    return {
      state: "awaiting_approval",
      reason: "current Codex approval prompt is visible"
    };
  }

  const tailLines = screen.trimEnd().split(/\r?\n/).slice(-30);
  const workingLine = tailLines.find((line) => isCodexWorkingLine(line));
  if (workingLine) {
    return {
      state: "working",
      reason: `Codex working marker detected: ${workingLine.trim()}`
    };
  }

  const lastLine = tailLines
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (lastLine && isCodexIdlePromptLine(lastLine)) {
    return {
      state: "idle",
      reason: `Codex input prompt detected: ${lastLine}`
    };
  }

  return {
    state: "unknown",
    reason: "no current Codex working, idle, or approval marker was detected in the terminal screen"
  };
}

function isCodexWorkingLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  if (/^•\s+Working\b/u.test(trimmed)) {
    return true;
  }
  if (/\besc to interrupt\b/u.test(trimmed) && (/\bWorking\b/u.test(trimmed) || /\b\/stop to close\b/u.test(trimmed))) {
    return true;
  }
  return /\bbackground terminal running\b/u.test(trimmed);
}

function isCodexIdlePromptLine(line: string): boolean {
  const trimmed = line.trim();
  return /^›(?:\s|$)/u.test(trimmed) && !/^›\s*1\./u.test(trimmed);
}

function screenExcerpt(screen: string, maxLength = 4000): string {
  const lines = screen.trimEnd().split(/\r?\n/);
  return lines.slice(Math.max(0, lines.length - 80)).join("\n").slice(-maxLength);
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
    const outputFd = fs.openSync(outputPath, "a");
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
    env: process.env
  });
  child.unref();
  return child;
}

function startTerminalBridgeMonitor({ statePath, logPath, agentTimeoutMinutes, pollIntervalMs, codexHome }) {
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
    "--poll-interval-ms",
    String(pollIntervalMs)
  ];
  if (codexHome) {
    args.push("--codex-home", codexHome);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env: process.env
  });
  child.unref();
  return child;
}

function startTerminalBridgeMonitorForConversation({ conversation, statePath, logPath, options }) {
  if (!terminalBridgeEnabled(conversation) || !conversation.gateway_method || options.disableTerminalBridgeMonitor === true) {
    return undefined;
  }
  return startTerminalBridgeMonitor({
    statePath,
    logPath,
    agentTimeoutMinutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES),
    pollIntervalMs: Number(options.monitorPollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS),
    codexHome: options.codexHome
  });
}

function terminalBridgeEnabled(conversation): boolean {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  return nativeTakeover?.["terminal_bridge"] === true;
}

function withTerminalBridgeState({ conversation, message, startedAt }) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  return {
    ...conversation,
    native_session_takeover: {
      ...nativeTakeover,
      terminal_bridge: true,
      terminal_bridge_started_at: startedAt,
      terminal_bridge_message_id: message.id
    },
    updated_at: startedAt
  };
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
  const proxy = proxyForExecutor(executor, options);
  if (!proxy) {
    return process.env;
  }

  return {
    ...process.env,
    ALL_PROXY: proxy,
    all_proxy: proxy
  };
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
  if (agentFilter && agentFilter !== "codex") {
    return {
      ...empty,
      summary: {
        enabled: true,
        agents: [],
        skipped: `native active discovery is not implemented for ${agentFilter}`
      }
    };
  }

  try {
    const provider = createAgentSessionProvider("codex", options);
    const terminalProvider = createTerminalControlProvider(options);
    const terminalScan = options.terminalDebug ? await terminalControlDiagnostics(terminalProvider) : undefined;
    const activeSessions = await listActiveSessionsWithTerminalControl(provider, options, terminalProvider);
    const rootSessions = rootActiveProcesses(activeSessions);
    const terminalControlled: Record<string, any>[] = [];
    const native: Record<string, any>[] = [];
    for (const session of rootSessions) {
      if (session.terminalControl) {
        terminalControlled.push(await terminalControlledListEntry(session, activeSessions, options));
      } else {
        native.push(nativeListEntry(session, activeSessions));
      }
    }

    return {
      native,
      terminalControlled,
      summary: {
        enabled: true,
        agents: ["codex"],
        active_count: activeSessions.length,
        native_count: native.length,
        terminal_controlled_count: terminalControlled.length,
        approval_scan: options.noApprovalScan ? "disabled" : "enabled",
        terminal_scan: terminalScan
      }
    };
  } catch (error) {
    return {
      native: [],
      terminalControlled: [],
      summary: {
        enabled: true,
        agents: ["codex"],
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
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

function nativeListEntry(session: ActiveCodexProcess, activeSessions: ActiveCodexProcess[]) {
  return {
    id: `native:codex:${session.pid}`,
    source: "native_active",
    agent: "codex",
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

async function terminalControlledListEntry(session: ActiveCodexProcess, activeSessions: ActiveCodexProcess[], options) {
  const terminalControl = session.terminalControl;
  if (!terminalControl) {
    throw new Error(`process ${session.pid} is not terminal-controlled`);
  }
  const terminalState = await listStateForTerminal(terminalControl, options);
  return {
    id: `terminal:${terminalControl.kind}:${terminalControl.target}:${session.pid}`,
    source: "terminal_control",
    agent: "codex",
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
      approve: terminalState.approval_state.approvable === true,
      status: true,
      cancel: true,
      close: false
    }
  };
}

async function listStateForTerminal(terminalControl: TerminalControlRef, options) {
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
    const screen = await createTerminalControlProvider(options).capture(terminalControl.target, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      socketPath: terminalControl.socketPath
    });
    const approval = detectCodexApprovalPrompt(screen);
    const blocked = isCodexApprovalPromptVisible(screen);
    const activity = detectCodexActivityState(screen, approval);
    return {
      approval_state: {
        scanned: true,
        blocked,
        approvable: approval.approvable,
        key: approval.approvable ? approval.key : undefined,
        label: approval.approvable ? approval.label : undefined,
        reason: approval.approvable ? undefined : approval.reason,
        screen_excerpt: blocked ? screenExcerpt(screen, 1000) : undefined
      },
      activity_state: activity.state,
      activity_reason: activity.reason
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

function rootActiveProcesses(processes: ActiveCodexProcess[]): ActiveCodexProcess[] {
  const pids = new Set(processes.map((process) => process.pid));
  const roots = processes.filter((process) => !process.ppid || !pids.has(process.ppid));
  const seenTerminalTargets = new Set<string>();
  return roots.filter((process) => {
    const terminalTarget = process.terminalControl?.target;
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

function childPidsForRoot(root: ActiveCodexProcess, processes: ActiveCodexProcess[]): number[] {
  return processes
    .filter((process) => process.ppid === root.pid)
    .map((process) => process.pid);
}

function canSendDelegated(status) {
  return !["failed", "closed", "cancelled"].includes(status);
}

async function resolveTerminalConversationFromOptions(options): Promise<{ conversationId: string; terminalControl: TerminalControlRef } | undefined> {
  const parsed = parseTerminalConversationId(stringValue(options.conversation));
  if (!parsed) {
    return undefined;
  }

  const provider = createTerminalControlProvider(options);
  const panes = await provider.listPanes();
  const pane = panes.find((candidate) =>
    candidate.kind === parsed.kind &&
    candidate.target === parsed.target
  );
  if (!pane) {
    throw new Error(`terminal-controlled session ${parsed.conversationId} is no longer available`);
  }

  return {
    conversationId: parsed.conversationId,
    terminalControl: terminalRefFromPane(pane)
  };
}

function parseTerminalConversationId(conversationId: string | undefined): { conversationId: string; kind: "tmux"; target: string; pid: number } | undefined {
  const prefix = "terminal:tmux:";
  if (!conversationId?.startsWith(prefix)) {
    return undefined;
  }
  const rest = conversationId.slice(prefix.length);
  const pidSeparator = rest.lastIndexOf(":");
  if (pidSeparator <= 0 || pidSeparator === rest.length - 1) {
    throw new Error(`invalid terminal-controlled conversation id: ${conversationId}`);
  }
  const target = rest.slice(0, pidSeparator);
  const pid = Number(rest.slice(pidSeparator + 1));
  if (!target || !Number.isInteger(pid)) {
    throw new Error(`invalid terminal-controlled conversation id: ${conversationId}`);
  }
  return {
    conversationId,
    kind: "tmux",
    target,
    pid
  };
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
    const terminalStatus = await terminalStatusForControl(terminalConversation.terminalControl, options);
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

  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
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
    result.terminal_control = terminalControl;
    result.terminal_status = await terminalStatusForControl(terminalControl, options);
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
    const terminalStatus = await terminalStatusForControl(terminalConversation.terminalControl, options);
    const process = await activeCodexProcessForPid(options, parseTerminalConversationId(conversationId)?.pid);
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

  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  const events = readExistingEvents(logPath);
  const terminalControl = terminalControlFromTakeover(
    isRecord(conversation.native_session_takeover) ? conversation.native_session_takeover : undefined
  );
  const terminalStatus = terminalControl ? await terminalStatusForControl(terminalControl, options) : undefined;
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

async function terminalStatusForControl(terminalControl, options) {
  try {
    const screen = await createTerminalControlProvider(options).capture(terminalControl.target, {
      scrollbackLines: Number(options.scrollbackLines ?? 120),
      socketPath: terminalControl.socketPath
    });
    const approval = detectCodexApprovalPrompt(screen);
    const blocked = isCodexApprovalPromptVisible(screen);
    const activity = detectCodexActivityState(screen, approval);
    return {
      provider: terminalControl.kind,
      target: terminalControl.target,
      reachable: true,
      activity_state: activity.state,
      activity_reason: activity.reason,
      approval_state: {
        scanned: true,
        blocked,
        approvable: approval.approvable,
        key: approval.approvable ? approval.key : undefined,
        label: approval.approvable ? approval.label : undefined,
        reason: approval.approvable ? undefined : approval.reason
      },
      screen: {
        excerpt: screenExcerpt(screen),
        approval
      }
    };
  } catch (error) {
    return {
      provider: terminalControl.kind,
      target: terminalControl.target,
      reachable: false,
      activity_state: "unknown",
      activity_reason: error instanceof Error ? error.message : String(error),
      approval_state: {
        scanned: false,
        blocked: false,
        approvable: false
      },
      screen: {
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

function terminalBridgeApprovalFingerprint({ terminalControl, terminalStatus }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  const screen = isRecord(terminalStatus?.screen) ? terminalStatus.screen : {};
  return createHash("sha256")
    .update(JSON.stringify({
      target: terminalControl.target,
      key: approval.key,
      label: approval.label,
      excerpt: screen.excerpt
    }))
    .digest("hex")
    .slice(0, 16);
}

function terminalBridgeApprovalInstructions({ conversation, terminalControl, terminalStatus }) {
  const approval = isRecord(terminalStatus?.approval_state) ? terminalStatus.approval_state : {};
  const screen = isRecord(terminalStatus?.screen) ? terminalStatus.screen : {};
  const label = stringValue(approval.label) || "the current Codex approval prompt";
  const key = stringValue(approval.key) || "the detected approve key";
  const excerpt = stringValue(screen.excerpt) || "(No terminal excerpt was available.)";
  return [
    "Codex is waiting for approval in a terminal-controlled AKK session.",
    "",
    `Conversation: ${conversation.conversation_id}`,
    `Terminal: ${terminalControl.kind}:${terminalControl.target}`,
    `Approval option: ${label} (${key})`,
    "",
    "Safe terminal excerpt:",
    "```text",
    excerpt,
    "```",
    "",
    "Ask the user whether to approve or deny this Codex request.",
    "",
    "If the user approves, call `agent_knock_knock_approve` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    "",
    "Equivalent user command: `AKK approve " + conversation.conversation_id + "`",
    "",
    "If the user denies or wants to stop this request, call `agent_knock_knock_cancel` with:",
    `- conversation_id: ${conversation.conversation_id}`,
    "",
    "Equivalent user command: `AKK cancel " + conversation.conversation_id + "`",
    "",
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ].join("\n");
}

function recordTerminalBridgeApprovalNotification({ statePath, logPath, terminalControl, terminalStatus, fingerprint }) {
  const releaseLock = acquireFileLock(`${statePath}.lock`);
  try {
    const conversation = loadState(statePath);
    const nativeTakeover: Record<string, unknown> = isRecord(conversation.native_session_takeover)
      ? { ...conversation.native_session_takeover }
      : {};
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    if (previousApproval?.fingerprint === fingerprint && previousApproval?.notified_at) {
      return {
        conversation,
        duplicate: true,
        previousApproval
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
      duplicate: false
    };
  } finally {
    releaseLock();
  }
}

async function runSend(options) {
  const messageBody = required(options.message ?? options.request, "--message is required");
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    if (options.background) {
      const managed = createManagedTerminalConversationFromRawId({
        options,
        conversationId: terminalConversation.conversationId,
        messageBody,
        terminalControl: terminalConversation.terminalControl
      });
      await runTerminalControlSend({
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        statePath: managed.statePath,
        logPath: managed.logPath,
        executor: managed.executor,
        message: managed.message,
        terminalControl: terminalConversation.terminalControl,
        needsNativeTakeoverBootstrap: true
      });
      return;
    }
    await runTerminalConversationSend({
      options,
      conversationId: terminalConversation.conversationId,
      messageBody,
      terminalControl: terminalConversation.terminalControl
    });
    return;
  }

  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
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
  const type = options.type ?? (conversation.status === "waiting_for_openclaw" ? "answer" : "task");
  const nativeTakeoverForSend = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const forkTakeoverForSend = isRecord(conversation.fork_context_takeover)
    ? conversation.fork_context_takeover
    : undefined;
  const needsNativeTakeoverBootstrap = nativeTakeoverForSend?.["needs_bootstrap"] === true;
  const needsForkTakeoverBootstrap = forkTakeoverForSend?.["needs_bootstrap"] === true;
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
    claude_session: executor.kind === "claude" ? executor.session : conversation.claude_session,
    executor_model: options.model ?? conversation.executor_model,
    model_selection: conversation.status === "needs_model_selection"
      ? {
          ...previousModelSelection,
          resolved_at: new Date().toISOString(),
          selected_model: options.model
        }
      : conversation.model_selection
  };
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
    const outputFd = fs.openSync(outputPath, "a");
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
      terminalControl: terminalConversation.terminalControl
    });
    return;
  }

  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(nativeTakeover);
  if (!terminalControl) {
    throw new Error(`conversation ${conversation.conversation_id} is not controlled through a terminal`);
  }

  const provider = createTerminalControlProvider(options);
  const screen = await provider.capture(terminalControl.target, {
    scrollbackLines: Number(options.scrollbackLines ?? 120),
    socketPath: terminalControl.socketPath
  });
  const approval = detectCodexApprovalPrompt(screen);
  if (!approval.approvable) {
    printJson({
      conversation,
      approved: false,
      blocked: true,
      reason: approval.reason,
      terminal_control: terminalControl,
      screen_excerpt: screenExcerpt(screen)
    });
    return;
  }

  await provider.sendKeys(terminalControl.target, [approval.key], {
    socketPath: terminalControl.socketPath
  });
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "terminal_approval_send",
    terminal_control: terminalControl,
    key: approval.key,
    label: approval.label
  });
  runtimeLog("info", "terminal_approval_send", {
    conversation_id: conversation.conversation_id,
    terminal_target: terminalControl.target,
    key: approval.key,
    label: approval.label
  });
  const nativeTakeoverForUpdate: Record<string, unknown> = isRecord(conversation.native_session_takeover)
    ? { ...conversation.native_session_takeover }
    : {};
  const nextNativeTakeover = {
    ...nativeTakeoverForUpdate,
    terminal_bridge_approval: undefined,
    terminal_bridge_approval_resolved_at: new Date().toISOString()
  };
  delete nextNativeTakeover.terminal_bridge_approval;
  const nextConversation = {
    ...conversation,
    status: terminalBridgeEnabled(conversation) ? "waiting_for_agent" as const : conversation.status,
    native_session_takeover: nextNativeTakeover,
    updated_at: new Date().toISOString()
  };
  saveState(statePath, nextConversation);

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
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
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
    label: approval.label,
    monitor_pid: bridgeMonitor?.pid ?? null
  });
}

async function runTerminalConversationApprove({ options, conversationId, terminalControl }) {
  const provider = createTerminalControlProvider(options);
  const screen = await provider.capture(terminalControl.target, {
    scrollbackLines: Number(options.scrollbackLines ?? 120),
    socketPath: terminalControl.socketPath
  });
  const approval = detectCodexApprovalPrompt(screen);
  if (!approval.approvable) {
    printJson({
      conversation_id: conversationId,
      source: "terminal_control",
      approved: false,
      blocked: true,
      reason: approval.reason,
      terminal_control: terminalControl,
      screen_excerpt: screenExcerpt(screen)
    });
    return;
  }

  await provider.sendKeys(terminalControl.target, [approval.key], {
    socketPath: terminalControl.socketPath
  });
  runtimeLog("info", "terminal_approval_send", {
    conversation_id: conversationId,
    terminal_target: terminalControl.target,
    key: approval.key,
    label: approval.label
  });

  printJson({
    conversation_id: conversationId,
    source: "terminal_control",
    approved: true,
    terminal_control: terminalControl,
    key: approval.key,
    label: approval.label
  });
}

async function runTerminalConversationSend({ options, conversationId, messageBody, terminalControl }) {
  const provider = createTerminalControlProvider(options);
  const terminalPayload = terminalSubmissionPayload(String(messageBody));
  await provider.sendText(terminalControl.target, terminalPayload, {
    socketPath: terminalControl.socketPath
  });
  await provider.sendKeys(terminalControl.target, ["C-m"], {
    socketPath: terminalControl.socketPath
  });
  runtimeLog("info", "terminal_message_send", {
    conversation_id: conversationId,
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
  needsNativeTakeoverBootstrap
}) {
  const provider = createTerminalControlProvider(options);
  const bridge = terminalBridgeEnabled(conversation);
  const bridgeStartedAt = new Date().toISOString();
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
  await provider.sendText(terminalControl.target, terminalPayload, {
    socketPath: terminalControl.socketPath
  });
  await provider.sendKeys(terminalControl.target, ["C-m"], {
    socketPath: terminalControl.socketPath
  });
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
  const bridgeConversation = bridge
    ? withTerminalBridgeState({
        conversation: nextConversation,
        message,
        startedAt: bridgeStartedAt
      })
    : nextConversation;
  const deliveredConversation = markTakeoverBootstrapped({
    conversation: bridgeConversation,
    statePath,
    logPath,
    executor,
    native: needsNativeTakeoverBootstrap && !bridge,
    fork: false
  });
  saveState(statePath, deliveredConversation);
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
      agent_timeout_minutes: Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES)
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
  return payload.replace(/[\r\n]+$/u, "");
}

function createManagedTerminalConversationFromRawId({ options, conversationId, messageBody, terminalControl }) {
  const workspace = terminalControl.currentPath ?? process.cwd();
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(workspace));
  cleanupIdleConversations(storeDir, options);
  const executor = resolveExecutor({
    kind: "codex",
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
    executor_model: options.model ?? options.codexModel,
    native_session_takeover: {
      agent: "codex",
      native_session_id: conversationId,
      source_cwd: workspace,
      source_title: `Terminal-controlled Codex ${terminalControl.target}`,
      strategy: "terminal_control",
      attached_at: now.toISOString(),
      takeover_match_kind: "raw_terminal_send",
      terminal_control: terminalControl,
      needs_bootstrap: false,
      terminal_bridge: true
    }
  }, paths);
  saveState(paths.statePath, attachedConversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: attachedConversation.conversation_id,
    event: "raw_terminal_session_attached",
    source_conversation_id: conversationId,
    agent: "codex",
    terminal_control: terminalControl,
    executor
  });
  runtimeLog("info", "raw_terminal_session_attached", {
    conversation_id: attachedConversation.conversation_id,
    source_conversation_id: conversationId,
    terminal_target: terminalControl.target,
    state_path: paths.statePath,
    event_log_path: paths.logPath
  });
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
  saveState(paths.statePath, nextConversation);
  appendEvent(paths.logPath, messageEvent(message));
  runtimeLog("info", "message_created", {
    conversation_id: nextConversation.conversation_id,
    source_conversation_id: conversationId,
    agent: executor.kind,
    executor_session: executor.session,
    message_type: message.type,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    message: textSummary(messageBody)
  });
  return {
    conversation: attachedConversation,
    nextConversation,
    statePath: paths.statePath,
    logPath: paths.logPath,
    executor,
    message
  };
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
    const outputFd = fs.openSync(outputPath, "a");
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

function markTakeoverBootstrapped({ conversation, statePath, logPath, executor, native, fork }) {
  let nextConversation = conversation;
  if (native) {
    nextConversation = markNativeSessionBootstrapped({ conversation: nextConversation, statePath, logPath, executor });
  }
  if (fork) {
    nextConversation = markForkSessionBootstrapped({ conversation: nextConversation, statePath, logPath, executor });
  }
  return nextConversation;
}

function markNativeSessionBootstrapped({ conversation, statePath, logPath, executor }) {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
  const now = new Date().toISOString();
  const nextConversation = {
    ...conversation,
    native_session_takeover: {
      ...nativeTakeover,
      needs_bootstrap: false,
      bootstrapped_at: now
    },
    updated_at: now
  };
  saveState(statePath, nextConversation);
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "native_session_bootstrapped",
    executor
  });
  runtimeLog("info", "native_session_bootstrapped", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    state_path: statePath
  });
  return nextConversation;
}

function markForkSessionBootstrapped({ conversation, statePath, logPath, executor }) {
  const forkTakeover = isRecord(conversation.fork_context_takeover)
    ? conversation.fork_context_takeover
    : {};
  const now = new Date().toISOString();
  const nextConversation = {
    ...conversation,
    fork_context_takeover: {
      ...forkTakeover,
      needs_bootstrap: false,
      bootstrapped_at: now
    },
    updated_at: now
  };
  saveState(statePath, nextConversation);
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "fork_session_bootstrapped",
    executor
  });
  runtimeLog("info", "fork_session_bootstrapped", {
    conversation_id: conversation.conversation_id,
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

async function runCancel(options) {
  cleanupIdleConversations(storeDirFromOptions(options), options);
  const terminalConversation = await resolveTerminalConversationFromOptions(options);
  if (terminalConversation) {
    await runTerminalConversationCancel({
      options,
      conversationId: terminalConversation.conversationId,
      terminalControl: terminalConversation.terminalControl
    });
    return;
  }

  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
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

async function runTerminalConversationCancel({ options, conversationId, terminalControl }) {
  const provider = createTerminalControlProvider(options);
  await provider.sendKeys(terminalControl.target, ["C-c"], {
    socketPath: terminalControl.socketPath
  });
  runtimeLog("info", "terminal_cancel_requested", {
    conversation_id: conversationId,
    terminal_target: terminalControl.target,
    key: "C-c"
  });

  printJson({
    conversation_id: conversationId,
    source: "terminal_control",
    cancel_requested: true,
    terminal_control: terminalControl,
    key: "C-c"
  });
}

async function runTerminalControlCancel({ options, conversation, statePath, logPath, terminalControl }) {
  const provider = createTerminalControlProvider(options);
  await provider.sendKeys(terminalControl.target, ["C-c"], {
    socketPath: terminalControl.socketPath
  });

  const now = new Date().toISOString();
  appendEvent(logPath, {
    ts: now,
    conversation_id: conversation.conversation_id,
    event: "terminal_cancel_requested",
    terminal_control: terminalControl,
    key: "C-c"
  });
  runtimeLog("info", "terminal_cancel_requested", {
    conversation_id: conversation.conversation_id,
    terminal_target: terminalControl.target,
    key: "C-c"
  });

  const nextConversation = {
    ...conversation,
    terminal_cancel_requested_at: now,
    updated_at: now
  };
  saveState(statePath, nextConversation);

  printJson({
    conversation: nextConversation,
    cancel_requested: true,
    terminal_control: terminalControl,
    key: "C-c",
    budget: budgetAction(nextConversation)
  });
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
    const outputFd = fs.openSync(outputPath, "a");
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

function runClose(options) {
  const { conversation, statePath, logPath } = loadConversationFromOptions(options);
  const now = new Date().toISOString();
  const closed = {
    ...conversation,
    status: "closed" as const,
    closed_at: now,
    close_reason: options.reason ?? "closed by request",
    updated_at: now
  };
  saveState(statePath, closed);
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
}

async function runMonitor(options) {
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

async function runTerminalBridgeMonitor(options) {
  const statePath = expandHome(required(options.state, "--state is required"));
  const logPath = expandHome(options.log ?? logPathForStatePath(statePath));
  const timeoutMinutes = Number(options.agentTimeoutMinutes ?? DEFAULT_AGENT_TIMEOUT_MINUTES);
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS));

  let conversation = loadState(statePath);
  const executor = executorForConversation(conversation);
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "terminal_bridge_monitor_started",
    executor,
    agent_timeout_minutes: timeoutMinutes,
    poll_interval_ms: pollIntervalMs
  });
  runtimeLog("info", "terminal_bridge_monitor_started", {
    conversation_id: conversation.conversation_id,
    agent: executor.kind,
    executor_session: executor.session,
    agent_timeout_minutes: timeoutMinutes
  });

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

    const terminalStatus = await terminalStatusForControl(terminalControl, options);
    const approval = terminalStatus.approval_state;
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
        fingerprint
      });
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
      const callbackMessage = createMessage({
        conversation: notification.conversation,
        from: executor.actor,
        to: "openclaw",
        type: "question",
        requiresResponse: true,
        body: terminalBridgeApprovalInstructions({
          conversation: notification.conversation,
          terminalControl,
          terminalStatus
        }),
        metadata: {
          source: "terminal_bridge",
          reason: "approval_required",
          terminal_control: terminalControl,
          terminal_status: terminalStatus,
          approval_fingerprint: fingerprint,
          approve_command: `AKK approve ${notification.conversation.conversation_id}`,
          deny_command: `AKK cancel ${notification.conversation.conversation_id}`,
          approve_tool: "agent_knock_knock_approve",
          deny_tool: "agent_knock_knock_cancel"
        }
      });
      if (notification.conversation.gateway_method) {
        runLockedCallback({
          ...options,
          statePath,
          log: logPath,
          messageJson: JSON.stringify(callbackMessage),
          gatewayMethod: notification.conversation.gateway_method,
          gatewaySession: notification.conversation.gateway_session,
          openclawSession: notification.conversation.openclaw_session,
          openclawBin: notification.conversation.openclaw_bin,
          gatewayUrl: stringValue(notification.conversation.gateway_token) ? notification.conversation.gateway_url : undefined,
          token: stringValue(notification.conversation.gateway_token)
        });
        return;
      }
      printJson({
        conversation: notification.conversation,
        monitored: true,
        terminal_bridge: true,
        awaiting_approval: true,
        delivered: false,
        message: callbackMessage,
        reason: "gateway_method_missing",
        terminal_control: terminalControl,
        terminal_status: terminalStatus
      });
      return;
    }

    const contextMatch = await terminalBridgeCodexContext({
      conversation,
      nativeTakeover,
      options
    });
    const startedAt = stringValue(nativeTakeover?.["terminal_bridge_started_at"]);
    const assistantMessage = contextMatch?.context
      ? latestAssistantAfter(contextMatch.context, startedAt)
      : undefined;
    const terminalStillWorking = terminalStatus.activity_state === "working";
    const screenMessage = !assistantMessage && !terminalStillWorking
      ? terminalBridgeScreenMessage({ conversation, terminalStatus })
      : undefined;
    if ((assistantMessage || screenMessage) && !terminalStillWorking) {
      const completion = assistantMessage ?? screenMessage;
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "terminal_bridge_completion_detected",
        terminal_control: terminalControl,
        match: assistantMessage ? contextMatch?.match : "terminal_screen",
        codex_session: contextMatch?.context.source,
        assistant_timestamp: completion?.timestamp
      });
      const callbackMessage = createMessage({
        conversation,
        from: executor.actor,
        to: "openclaw",
        type: "done",
        requiresResponse: false,
        body: completion?.text ?? "",
        metadata: {
          source: "terminal_bridge",
          terminal_control: terminalControl,
          codex_session: contextMatch?.context.source,
          confidence: assistantMessage ? contextMatch?.confidence : "screen_only",
          match: assistantMessage ? contextMatch?.match : "terminal_screen",
          assistant_timestamp: completion?.timestamp
        }
      });
      runLockedCallback({
        ...options,
        statePath,
        log: logPath,
        closeTerminalBridgeOnDone: true,
        messageJson: JSON.stringify(callbackMessage),
        gatewayMethod: conversation.gateway_method,
        gatewaySession: conversation.gateway_session,
        openclawSession: conversation.openclaw_session,
        openclawBin: conversation.openclaw_bin,
        gatewayUrl: stringValue(conversation.gateway_token) ? conversation.gateway_url : undefined,
        token: stringValue(conversation.gateway_token)
      });
      return;
    }

    if (Number.isFinite(timeoutMinutes) && timeoutMinutes > 0) {
      const updatedAtMs = Date.parse(String(conversation.updated_at ?? conversation.created_at));
      if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs >= timeoutMinutes * 60 * 1000) {
        const stalledConversation = markConversationStalled({
          statePath,
          logPath,
          reason: `terminal bridge did not observe completion after ${timeoutMinutes} minutes`,
          detail: {
            terminal_bridge: true,
            terminal_control: terminalControl,
            match: contextMatch?.match,
            terminal_activity_state: terminalStatus.activity_state
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

async function terminalBridgeCodexContext({ conversation, nativeTakeover, options }) {
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

function latestAssistantAfter(context: ForkContextPackage, startedAt: string | undefined) {
  const threshold = startedAt ? Date.parse(startedAt) : undefined;
  return [...visibleRolloutMessages(context)]
    .reverse()
    .find((message) => {
      if (message.role !== "assistant") {
        return false;
      }
      if (!Number.isFinite(threshold)) {
        return true;
      }
      const messageTime = message.timestamp ? Date.parse(message.timestamp) : NaN;
      return Number.isFinite(messageTime) && messageTime >= Number(threshold);
    });
}

function terminalBridgeScreenMessage({ conversation, terminalStatus }) {
  const excerpt = stringValue(terminalStatus?.screen?.excerpt);
  if (!excerpt) {
    return undefined;
  }

  const request = String(conversation.user_request ?? "").trim();
  const promptIndex = request ? excerpt.lastIndexOf(request) : -1;
  const afterPrompt = promptIndex >= 0
    ? excerpt.slice(promptIndex + request.length)
    : excerpt;
  const cleaned = cleanTerminalBridgeScreenText(afterPrompt);
  if (!cleaned || cleaned.length < 40 || !/[•└]/u.test(cleaned)) {
    return undefined;
  }

  return {
    role: "assistant" as const,
    text: truncateText(cleaned, 4000),
    timestamp: undefined
  };
}

function cleanTerminalBridgeScreenText(text: string): string | undefined {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => {
      const trimmed = line.trim();
      return trimmed &&
        !trimmed.startsWith("› Use /skills") &&
        !/^gpt-[\w.-]+/u.test(trimmed) &&
        !/^[-\w.]+ default ·/u.test(trimmed);
    });
  const cleaned = lines.join("\n").trim();
  return cleaned || undefined;
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

  if (token) {
    parts.push(
      "--gateway-url",
      shellQuote(gatewayUrl),
      "--token",
      shellQuote(token),
      "--openclaw-session",
      shellQuote(openclawSession)
    );
  } else if (!gatewayMethod) {
    parts.push("--record-only");
  }

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

function runLockedCallback(options) {
  const messageInput = required(options.messageJson, "--message-json is required");
  const logPath = expandHome(options.log ?? logPathForStatePath(options.statePath));
  const conversation = loadState(options.statePath);
  const executor = executorForConversation(conversation);
  const message = extractStructuredMessage({
    conversation,
    input: messageInput,
    defaultFrom: executor.actor,
    defaultTo: "openclaw"
  });

  const existingEvents = readExistingEvents(logPath);
  if (isDuplicateMessage(existingEvents, message)) {
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

  let nextConversation = applyMessageToConversation(conversation, message);
  if (message.type === "done" && options.closeTerminalBridgeOnDone === true) {
    const now = new Date().toISOString();
    nextConversation = {
      ...nextConversation,
      status: "closed" as const,
      closed_at: now,
      close_reason: "terminal bridge task completed",
      updated_at: now
    };
    delete nextConversation.idle_since;
  }

  appendEvent(logPath, messageEvent(message));
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

  const result = {
    conversation: nextConversation,
    message,
    budget: budgetAction(nextConversation),
    delivered: false,
    duplicate: false
  };

  if (options.gatewayMethod) {
    const delivery = deliverToGatewayMethod({
      method: options.gatewayMethod,
      openclawBin: options.openclawBin,
      gatewayUrl: options.gatewayUrl,
      token: options.token,
      sessionKey: options.gatewaySession ?? options.openclawSession ?? conversation.openclaw_session,
      statePath: options.statePath,
      logPath,
      conversation: nextConversation,
      message
    });
    appendEvent(logPath, {
      ts: new Date().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "callback_gateway_method_delivery",
      from: message.from,
      to: "openclaw",
      round: message.round,
      method: options.gatewayMethod,
      status: delivery.status,
      stdout: delivery.stdout,
      stderr: delivery.stderr
    });
    runtimeLog("info", "callback_gateway_method_delivery", {
      conversation_id: conversation.conversation_id,
      method: options.gatewayMethod,
      status: delivery.status,
      failure_kind: classifyProcessFailure(delivery),
      stdout: textSummary(delivery.stdout),
      stderr: textSummary(delivery.stderr)
    });

    if (delivery.status !== 0) {
      throw new Error(delivery.stderr || delivery.stdout || `gateway method delivery failed with status ${delivery.status}`);
    }

    const gatewayPayload = parseOptionalJson(delivery.stdout);
    const chatSendParams = isRecord(gatewayPayload?.chat_send) ? gatewayPayload.chat_send : undefined;
    const sessionSendParams = isRecord(gatewayPayload?.session_send) ? gatewayPayload.session_send : undefined;
    let chatSendDelivery;
    let sessionSendDelivery;
    if (chatSendParams) {
      chatSendDelivery = deliverToChatSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: chatSendParams
      });
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "callback_chat_send_delivery",
        from: message.from,
        to: "openclaw",
        round: message.round,
        status: chatSendDelivery.status,
        stdout: chatSendDelivery.stdout,
        stderr: chatSendDelivery.stderr
      });
      runtimeLog("info", "callback_chat_send_delivery", {
        conversation_id: conversation.conversation_id,
        status: chatSendDelivery.status,
        failure_kind: classifyProcessFailure(chatSendDelivery),
        stdout: textSummary(chatSendDelivery.stdout),
        stderr: textSummary(chatSendDelivery.stderr)
      });

      if (chatSendDelivery.status !== 0) {
        throw new Error(chatSendDelivery.stderr || chatSendDelivery.stdout || `chat callback delivery failed with status ${chatSendDelivery.status}`);
      }
    } else if (sessionSendParams) {
      sessionSendDelivery = deliverToSessionSend({
        openclawBin: options.openclawBin,
        gatewayUrl: options.gatewayUrl,
        token: options.token,
        params: sessionSendParams
      });
      appendEvent(logPath, {
        ts: new Date().toISOString(),
        conversation_id: conversation.conversation_id,
        event: "callback_session_send_delivery",
        from: message.from,
        to: "openclaw",
        round: message.round,
        status: sessionSendDelivery.status,
        stdout: sessionSendDelivery.stdout,
        stderr: sessionSendDelivery.stderr
      });
      runtimeLog("info", "callback_session_send_delivery", {
        conversation_id: conversation.conversation_id,
        status: sessionSendDelivery.status,
        failure_kind: classifyProcessFailure(sessionSendDelivery),
        stdout: textSummary(sessionSendDelivery.stdout),
        stderr: textSummary(sessionSendDelivery.stderr)
      });

      if (sessionSendDelivery.status !== 0) {
        throw new Error(sessionSendDelivery.stderr || sessionSendDelivery.stdout || `session callback delivery failed with status ${sessionSendDelivery.status}`);
      }
    }

    printJson({
      ...result,
      delivered: true,
      delivery: chatSendDelivery
        ? "gateway_method+chat_send"
        : sessionSendDelivery
          ? "gateway_method+sessions_send"
          : "gateway_method"
    });
    return;
  }

  if (options.recordOnly) {
    runtimeLog("info", "callback_recorded_only", {
      conversation_id: conversation.conversation_id,
      status: nextConversation.status
    });
    printJson(result);
    return;
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
  appendEvent(logPath, {
    ts: new Date().toISOString(),
    conversation_id: conversation.conversation_id,
    event: "callback_delivery",
    from: message.from,
    to: "openclaw",
    round: message.round,
    status: delivery.status,
    stdout: delivery.stdout,
    stderr: delivery.stderr
  });
  runtimeLog("info", "callback_delivery", {
    conversation_id: conversation.conversation_id,
    status: delivery.status,
    failure_kind: classifyProcessFailure(delivery),
    stdout: textSummary(delivery.stdout),
    stderr: textSummary(delivery.stderr)
  });

  if (delivery.status !== 0) {
    throw new Error(delivery.stderr || delivery.stdout || `callback delivery failed with status ${delivery.status}`);
  }

  printJson({
    ...result,
    delivered: true
  });
}

function acquireFileLock(lockPath, { timeoutMs = 5000, retryMs = 50 } = {}) {
  const started = Date.now();

  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.closeSync(fd);
      return () => {
        fs.rmSync(lockPath, { force: true });
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`timed out waiting for callback lock: ${lockPath}`);
      }
      sleepSync(retryMs);
    }
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
            "Use `AKK status` for details, `AKK send` to retry/follow up, or `AKK close` to close it."
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
    stdout: delivery.stdout,
    stderr: delivery.stderr
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
    stdout: chatSendDelivery.stdout,
    stderr: chatSendDelivery.stderr
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
  for (const conversation of conversations) {
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

    const statePath = conversation.state_path ?? statePathForConversationId(conversation.conversation_id, storeDir);
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
  const agent = `openclaw acp --url ${gatewayUrl} --token ${token} --session ${openclawSession}`;
  const result = spawnSync("acpx", ["--agent", agent, JSON.stringify(message)], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
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
      conversation,
      message
    }),
    "--json"
  ];

  if (gatewayUrl) {
    args.push("--url", gatewayUrl);
  }
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
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
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
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
  if (token && token !== "<token>") {
    args.push("--token", token);
  }

  const result = spawnSync(openclawBin ?? "openclaw", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10
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
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
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
  agent-knock-knock new --request <text> [--agent ${agentList}] [--workspace <path>] [--store-dir <dir>]
  agent-knock-knock record --state <file> --message-json <json>
  agent-knock-knock bootstrap-prompt --callback-command <command> [--agent ${agentList}]
  agent-knock-knock delegate --request <text> [--agent ${agentList}] [--store-dir <dir>] [--all-proxy <url>] [--agent-timeout-minutes <minutes>] [--token <gateway-token>] [--send|--background]
  agent-knock-knock list [--store-dir <dir>] [--agent ${agentList}] [--status <status>] [--all] [--managed-only] [--no-approval-scan] [--terminal-debug]
  agent-knock-knock status --conversation <id> [--store-dir <dir>] [--trace]
  agent-knock-knock describe --conversation <id> [--store-dir <dir>]
  agent-knock-knock send --conversation <id> --message <text> [--type answer|task|control] [--all-proxy <url>] [--agent-timeout-minutes <minutes>]
  agent-knock-knock approve --conversation <id>
  agent-knock-knock cancel --conversation <id> [--all-proxy <url>]
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

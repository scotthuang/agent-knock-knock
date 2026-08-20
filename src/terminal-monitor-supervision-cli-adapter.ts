import type { CallbackCliFacade } from "./callback-cli-adapter.js";
import { expandHome, positiveMinutes } from "./cli-command-runtime.js";
import type { Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import {
  runTerminalMonitorWithStoreDeferral
} from "./terminal-monitor-application-service.js";
import * as monitorLaunch from "./terminal-monitor-launch-plan.js";
import * as monitorOwner from "./terminal-monitor-ownership-policy.js";
import type {
  TerminalMonitorStateCliAdapter,
  TerminalMonitorLaunchPreparation
} from "./terminal-monitor-state-cli-adapter.js";
import type { TranscriptEvent } from "./transcript.js";
import { isRecord, nonBlankString } from "./value-guards.js";

type MonitorCliOptions = Record<string, unknown>;
type LogLevel = "info" | "warn" | "error";
type Release = () => void;

const DEFAULT_AGENT_TIMEOUT_MINUTES = 60;
const DEFAULT_AGENT_HARD_TIMEOUT_MINUTES = 720;
const DEFAULT_MONITOR_POLL_INTERVAL_MS = 5000;
const DEFAULT_CALLBACK_RETRY_DELAY_MS = 5000;

export interface DetachedMonitorProcess {
  readonly pid?: number;
  unref(): void;
}

export interface TerminalMonitorReconciliationResult {
  [field: string]: unknown;
  reconciled: true;
  store_dir: string;
  checked: number;
  repaired: number;
  collateral_stalls_checked: number;
  collateral_stalls_skipped: number;
  ignored: number;
  launched: number;
  already_running: number;
  skipped: number;
  errors: number;
  items: Array<{ status?: string; [field: string]: unknown }>;
}

export interface TerminalMonitorSupervisionCliDependencies {
  state: Pick<TerminalMonitorStateCliAdapter,
    "runService" | "deferralPorts" | "reconcileCollateral" | "statePaths" |
      "reconcileState" | "eligibility" | "prepareLaunch">;
  callbacks: Pick<CallbackCliFacade, "runRetryMonitor">;
  authority: {
    migrateIdentity(input: {
      conversation: Conversation;
      statePath: string;
      logPath: string;
      options: MonitorCliOptions;
    }): Promise<Conversation>;
    createBridge(options: MonitorCliOptions): TerminalAgentBridge;
  };
  io: {
    spawn(
      executable: string,
      args: string[],
      options: {
        detached: true;
        stdio: "ignore";
        cwd: string;
        env: NodeJS.ProcessEnv;
      }
    ): DetachedMonitorProcess;
    locks: {
      acquire(lockPath: string, options?: { timeoutMs?: number }): Release;
      stale(lockPath: string): boolean;
      owner(lockPath: string): { pid?: number };
    };
    exists(filePath: string): boolean;
    loadState(statePath: string): Conversation;
    listConversations(storeDir: string): Conversation[];
    readEvents(logPath: string): TranscriptEvent[];
    appendEvent(logPath: string, event: TranscriptEvent): void;
    logPathForStatePath(statePath: string): string;
  };
  runtime: {
    executablePath(): string;
    entryPath(): string;
    cwd(): string;
    environment(): NodeJS.ProcessEnv;
    now(): Date;
    sleepSync(milliseconds: number): void;
    isProcessAlive(pid: number): boolean;
    storeDir(options: MonitorCliOptions): string;
    workspaceMatches(configured: unknown, candidate: unknown): boolean;
    bindingSuperseded(error: unknown): boolean;
    print(value: Record<string, unknown>): void;
    log(level: LogLevel, event: string, fields: Record<string, unknown>): void;
  };
}

export interface TerminalMonitorSupervisionCliFacade {
  runMonitor(options: MonitorCliOptions): Promise<void>;
  runReconcileMonitors(options: MonitorCliOptions): Promise<void>;
  reconcileMonitors(
    options: MonitorCliOptions,
    request: TerminalMonitorReconciliationRequest
  ): Promise<TerminalMonitorReconciliationResult>;
  startCallbackRetryMonitor(input: {
    statePath: string;
    delayMs?: unknown;
  }): DetachedMonitorProcess;
  startTerminalBridgeMonitorForConversation(
    input: TerminalMonitorStartRequest
  ): DetachedMonitorProcess | undefined;
  ensureTerminalBridgeMonitorAfterApproval(
    input: TerminalMonitorApprovalLaunchRequest
  ): TerminalMonitorApprovalLaunchResult;
  activeTerminalBridgeMonitorOwner(
    statePath: string,
    terminalMessageId: string
  ): TerminalMonitorOwner | undefined;
  readonly monitorLockVersion: number;
}

export interface TerminalMonitorReconciliationRequest {
  includeCallbackRecovery: boolean;
  reason: string;
  conversationId?: string;
}

export interface TerminalMonitorStartRequest {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  options: MonitorCliOptions;
}

export interface TerminalMonitorApprovalLaunchRequest
  extends TerminalMonitorStartRequest {
  terminalControl: TerminalControlRef;
  reason?: string;
}

export interface TerminalMonitorOwner {
  lockPath: string;
  ownerPid?: number;
}

export interface TerminalMonitorApprovalLaunchResult {
  activeMonitor?: TerminalMonitorOwner;
  launchedMonitor?: DetachedMonitorProcess;
  handoffWatchdog?: DetachedMonitorProcess;
  monitorPid?: number;
}

interface ReconciliationAccumulator {
  ignored: number;
  launched: number;
  alreadyRunning: number;
  skipped: number;
  errors: number;
  items: Array<{ status?: string; [field: string]: unknown }>;
}

type HandoffDisposition = "retry" | "finished";

/** Bind process and lock supervision to invocation-local CLI facades. */
export function createTerminalMonitorSupervisionCliAdapter(
  dependencies: TerminalMonitorSupervisionCliDependencies
): TerminalMonitorSupervisionCliFacade {
  const application = new TerminalMonitorSupervisionCliApplication(
    dependencies
  );
  return Object.freeze({
    runMonitor: (options) => application.runMonitor(options),
    runReconcileMonitors: (options) =>
      application.runReconcileMonitors(options),
    reconcileMonitors: (options, request) =>
      application.reconcileMonitors(options, request),
    startCallbackRetryMonitor: (input) =>
      application.startCallbackRetryMonitor(input),
    startTerminalBridgeMonitorForConversation: (input) =>
      application.startTerminalBridgeMonitorForConversation(input),
    ensureTerminalBridgeMonitorAfterApproval: (input) =>
      application.ensureTerminalBridgeMonitorAfterApproval(input),
    activeTerminalBridgeMonitorOwner: (statePath, terminalMessageId) =>
      application.activeTerminalBridgeMonitorOwner(
        statePath,
        terminalMessageId
      ),
    monitorLockVersion: monitorOwner.LOCK_VERSION
  });
}

class TerminalMonitorSupervisionCliApplication {
  readonly #dependencies: TerminalMonitorSupervisionCliDependencies;

  constructor(dependencies: TerminalMonitorSupervisionCliDependencies) {
    this.#dependencies = dependencies;
  }

  async runMonitor(options: MonitorCliOptions): Promise<void> {
    if (options.callbackRetry) {
      this.#runCallbackRetryMonitor(options);
      return;
    }
    if (options.terminalBridgeHandoff) {
      this.#runTerminalBridgeMonitorHandoff(options);
      return;
    }
    if (options.terminalBridge) {
      await this.#runTerminalBridgeMonitor(options);
      return;
    }
    throw new Error(
      "monitor requires --terminal-bridge, --terminal-bridge-handoff, or --callback-retry"
    );
  }

  async runReconcileMonitors(options: MonitorCliOptions): Promise<void> {
    const reason = nonBlankString(options.reason) ?? "startup_reconciliation";
    this.#dependencies.runtime.print(await this.reconcileMonitors(options, {
      includeCallbackRecovery:
        options.terminalMonitorsOnly !== true && reason !== "monitor_supervision",
      reason,
      conversationId: undefined
    }));
  }

  async reconcileMonitors(
    options: MonitorCliOptions,
    request: TerminalMonitorReconciliationRequest
  ): Promise<TerminalMonitorReconciliationResult> {
    const storeDir = this.#dependencies.runtime.storeDir(options);
    const collateral = await this.#dependencies.state.reconcileCollateral(
      storeDir,
      request.conversationId
    );
    const conversations = this.#dependencies.io
      .listConversations(storeDir)
      .filter((conversation) =>
        request.conversationId === undefined ||
        conversation.conversation_id === request.conversationId
      );
    const accumulator: ReconciliationAccumulator = {
      ignored: 0,
      launched: 0,
      alreadyRunning: 0,
      skipped: 0,
      errors: collateral.errors.length,
      items: [...collateral.items]
    };
    const repaired = new Set(
      collateral.items
        .filter((item) => item.status === "repaired")
        .map((item) => nonBlankString(item.conversation_id))
        .filter((id): id is string => id !== undefined)
    );
    for (const listed of conversations) {
      await this.#reconcileListedConversation({
        options,
        request,
        storeDir,
        listed,
        repaired,
        accumulator
      });
    }
    return this.#reconciliationResult(
      storeDir,
      conversations.length,
      collateral,
      accumulator
    );
  }

  startCallbackRetryMonitor({
    statePath,
    delayMs = DEFAULT_CALLBACK_RETRY_DELAY_MS
  }: {
    statePath: string;
    delayMs?: unknown;
  }): DetachedMonitorProcess {
    const numericDelayMs = Number(delayMs);
    const normalizedDelayMs = Math.max(
      0,
      Number.isFinite(numericDelayMs)
        ? numericDelayMs
        : DEFAULT_CALLBACK_RETRY_DELAY_MS
    );
    return this.#spawnDetached({
      args: [
        this.#dependencies.runtime.entryPath(),
        "monitor",
        "--callback-retry",
        "--state",
        statePath,
        "--callback-retry-delay-ms",
        String(normalizedDelayMs)
      ],
      environment: monitorLaunch.withoutGatewayTokens(
        this.#dependencies.runtime.environment()
      )
    })!;
  }

  startTerminalBridgeMonitorForConversation(
    input: TerminalMonitorStartRequest
  ): DetachedMonitorProcess | undefined {
    return this.#spawnDetached(monitorLaunch.planLaunch({
      ...input,
      entryPath: this.#dependencies.runtime.entryPath(),
      environment: this.#dependencies.runtime.environment()
    }));
  }

  ensureTerminalBridgeMonitorAfterApproval(
    input: TerminalMonitorApprovalLaunchRequest
  ): TerminalMonitorApprovalLaunchResult {
    const reason = input.reason ?? "approval_resolved";
    const takeover = takeoverFor(input.conversation);
    const terminalMessageId = nonBlankString(
      takeover?.terminal_bridge_message_id
    );
    const activeMonitor = terminalMessageId
      ? this.activeTerminalBridgeMonitorOwner(
          input.statePath,
          terminalMessageId
        )
      : undefined;
    const launchPlan = monitorLaunch.planAfterApproval({
      ...input,
      entryPath: this.#dependencies.runtime.entryPath(),
      environment: this.#dependencies.runtime.environment(),
      activeMonitorPresent: activeMonitor !== undefined
    });
    const launchedMonitor = this.#spawnDetached(launchPlan.monitor);
    const handoffWatchdog = this.#spawnDetached(launchPlan.handoff);
    const monitorPid = activeMonitor?.ownerPid ?? launchedMonitor?.pid;
    this.#recordApprovalLaunch({
      ...input,
      reason,
      terminalMessageId,
      activeMonitor,
      launchedMonitor,
      handoffWatchdog
    });
    return { activeMonitor, launchedMonitor, handoffWatchdog, monitorPid };
  }

  activeTerminalBridgeMonitorOwner(
    statePath: string,
    terminalMessageId: string
  ): TerminalMonitorOwner | undefined {
    const lockPath = monitorOwner.lockPath(statePath, terminalMessageId);
    if (
      !this.#dependencies.io.exists(lockPath) ||
      this.#dependencies.io.locks.stale(lockPath)
    ) {
      return undefined;
    }
    return this.#monitorLockOwner(lockPath);
  }

  async #reconcileListedConversation(input: {
    options: MonitorCliOptions;
    request: TerminalMonitorReconciliationRequest;
    storeDir: string;
    listed: Conversation;
    repaired: ReadonlySet<string>;
    accumulator: ReconciliationAccumulator;
  }): Promise<void> {
    const { listed, accumulator } = input;
    if (
      input.repaired.has(listed.conversation_id) ||
      !this.#dependencies.runtime.workspaceMatches(
        input.options.workspace,
        listed.workspace
      )
    ) {
      accumulator.ignored += 1;
      return;
    }
    const paths = this.#dependencies.state.statePaths(
      listed,
      input.storeDir
    );
    try {
      const state = await this.#dependencies.state.reconcileState({
        options: input.options,
        storeDir: input.storeDir,
        listed,
        paths,
        includeCallbackRecovery: input.request.includeCallbackRecovery
      });
      if (state.kind !== "candidate") {
        this.#recordStateDisposition(state, accumulator);
        return;
      }
      await this.#reconcileLaunchCandidate({
        options: input.options,
        reason: input.request.reason,
        statePath: paths.statePath,
        logPath: paths.logPath,
        conversation: state.conversation,
        eligibility: state.eligibility,
        accumulator
      });
    } catch (error) {
      this.#recordReconciliationError(error, listed, accumulator);
    }
  }

  #recordStateDisposition(
    state: Exclude<
      Awaited<ReturnType<TerminalMonitorStateCliAdapter["reconcileState"]>>,
      { kind: "candidate" }
    >,
    accumulator: ReconciliationAccumulator
  ): void {
    if (state.kind === "ignored") {
      accumulator.ignored += 1;
      return;
    }
    if (state.counter === "launched") accumulator.launched += 1;
    else if (state.counter === "alreadyRunning") {
      accumulator.alreadyRunning += 1;
    } else accumulator.skipped += 1;
    accumulator.items.push({ ...state.item });
  }

  async #reconcileLaunchCandidate(input: {
    options: MonitorCliOptions;
    reason: string;
    statePath: string;
    logPath: string;
    conversation: Conversation;
    eligibility: Extract<
      Awaited<ReturnType<TerminalMonitorStateCliAdapter["reconcileState"]>>,
      { kind: "candidate" }
    >["eligibility"];
    accumulator: ReconciliationAccumulator;
  }): Promise<void> {
    const previousPid = this.#latestLaunchPid(input.logPath);
    const unexpectedExit = previousPid !== undefined &&
      !this.#dependencies.runtime.isProcessAlive(previousPid);
    const ownership = this.#reconciliationOwnership(
      input.statePath,
      input.logPath,
      input.eligibility
    );
    if (ownership.action === "stop") {
      this.#recordOwnershipStop(
        input.conversation,
        ownership.item,
        input.accumulator
      );
      return;
    }
    const prepared = this.#prepareLaunch({
      statePath: input.statePath,
      expectedMessageId: input.eligibility.terminalMessageId
    });
    if (!prepared.prepared) {
      this.#recordUnprepared(input.conversation, prepared, input.accumulator);
      return;
    }
    const monitor = this.startTerminalBridgeMonitorForConversation({
      conversation: prepared.conversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    if (!monitor) {
      input.accumulator.skipped += 1;
      input.accumulator.items.push({
        conversation_id: prepared.conversation.conversation_id,
        status: "skipped",
        reason: "terminal_bridge_monitor_launch_disabled"
      });
      return;
    }
    this.#recordReconciledLaunch({
      ...input,
      prepared,
      monitor,
      previousPid,
      unexpectedExit
    });
  }

  #reconciliationOwnership(
    statePath: string,
    logPath: string,
    eligibility: Extract<
      Awaited<ReturnType<TerminalMonitorStateCliAdapter["reconcileState"]>>,
      { kind: "candidate" }
    >["eligibility"]
  ): monitorOwner.TerminalMonitorOwnershipDecision {
    const activeOwner = this.activeTerminalBridgeMonitorOwner(
      statePath,
      eligibility.terminalMessageId
    );
    const current = monitorOwner.decideCurrent({
      currentOwnerPresent: activeOwner !== undefined,
      currentOwnerPid: activeOwner?.ownerPid,
      monitorLockVersion:
        eligibility.nativeTakeover.terminal_bridge_monitor_lock_version
    });
    if (current.action !== "inspect_legacy") return current;
    const legacyPid = this.#latestLaunchPid(logPath);
    return monitorOwner.decideLegacy({
      latestLaunchPid: legacyPid,
      launchProcessAlive: legacyPid !== undefined &&
        this.#dependencies.runtime.isProcessAlive(legacyPid)
    });
  }

  #recordOwnershipStop(
    conversation: Conversation,
    item: monitorOwner.TerminalMonitorOwnershipItem,
    accumulator: ReconciliationAccumulator
  ): void {
    if (item.status === "already_running") accumulator.alreadyRunning += 1;
    else accumulator.skipped += 1;
    accumulator.items.push({
      conversation_id: conversation.conversation_id,
      ...item
    });
  }

  #recordUnprepared(
    conversation: Conversation,
    prepared: Exclude<TerminalMonitorLaunchPreparation, { prepared: true }>,
    accumulator: ReconciliationAccumulator
  ): void {
    if (prepared.alreadyRunning) accumulator.alreadyRunning += 1;
    else accumulator.skipped += 1;
    accumulator.items.push({
      conversation_id: conversation.conversation_id,
      status: prepared.alreadyRunning ? "already_running" : "skipped",
      reason: prepared.reason,
      ...(prepared.alreadyRunning
        ? { monitor_owner_pid: prepared.ownerPid ?? null }
        : {})
    });
  }

  #recordReconciledLaunch(input: {
    reason: string;
    logPath: string;
    prepared: Extract<TerminalMonitorLaunchPreparation, { prepared: true }>;
    monitor: DetachedMonitorProcess;
    previousPid?: number;
    unexpectedExit: boolean;
    accumulator: ReconciliationAccumulator;
  }): void {
    const launchedAt = this.#dependencies.runtime.now().toISOString();
    const launchReason = input.unexpectedExit
      ? "unexpected_exit_recovery"
      : input.reason;
    if (input.unexpectedExit) this.#recordUnexpectedExit(input, launchedAt);
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: launchedAt,
      conversation_id: input.prepared.conversation.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: input.monitor.pid ?? null,
      terminal_control: input.prepared.terminalControl,
      reason: launchReason,
      agent_timeout_minutes: input.prepared.inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: input.prepared.hardTimeoutMinutes
    });
    this.#dependencies.runtime.log(
      "info",
      "terminal_bridge_monitor_reconciled",
      {
        conversation_id: input.prepared.conversation.conversation_id,
        monitor_pid: input.monitor.pid ?? null,
        terminal_target: input.prepared.terminalControl.target
      }
    );
    input.accumulator.launched += 1;
    input.accumulator.items.push({
      conversation_id: input.prepared.conversation.conversation_id,
      status: "launched",
      reason: launchReason,
      monitor_pid: input.monitor.pid ?? null,
      ...(input.unexpectedExit
        ? { previous_monitor_pid: input.previousPid }
        : {})
    });
  }

  #recordUnexpectedExit(
    input: {
      reason: string;
      logPath: string;
      prepared: Extract<TerminalMonitorLaunchPreparation, { prepared: true }>;
      previousPid?: number;
    },
    launchedAt: string
  ): void {
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: launchedAt,
      conversation_id: input.prepared.conversation.conversation_id,
      event: "terminal_bridge_monitor_exit_observed",
      previous_monitor_pid: input.previousPid,
      terminal_control: input.prepared.terminalControl,
      reason: "monitor_owner_process_missing",
      observed_by: input.reason
    });
    this.#dependencies.runtime.log(
      "warn",
      "terminal_bridge_monitor_exit_observed",
      {
        conversation_id: input.prepared.conversation.conversation_id,
        previous_monitor_pid: input.previousPid,
        terminal_target: input.prepared.terminalControl.target,
        observed_by: input.reason
      }
    );
  }

  #recordReconciliationError(
    error: unknown,
    listed: Conversation,
    accumulator: ReconciliationAccumulator
  ): void {
    if (this.#dependencies.runtime.bindingSuperseded(error)) {
      accumulator.skipped += 1;
      accumulator.items.push({
        conversation_id: listed.conversation_id,
        status: "skipped",
        reason: "session_binding_superseded"
      });
      return;
    }
    accumulator.errors += 1;
    accumulator.items.push({
      conversation_id: listed.conversation_id,
      status: "error",
      reason: error instanceof Error ? error.message : String(error)
    });
  }

  #reconciliationResult(
    storeDir: string,
    checked: number,
    collateral: Awaited<ReturnType<
      TerminalMonitorStateCliAdapter["reconcileCollateral"]
    >>,
    accumulator: ReconciliationAccumulator
  ): TerminalMonitorReconciliationResult {
    return {
      reconciled: true,
      store_dir: storeDir,
      checked,
      repaired: collateral.repaired,
      collateral_stalls_checked: collateral.checked,
      collateral_stalls_skipped: collateral.skipped,
      ignored: accumulator.ignored,
      launched: accumulator.launched,
      already_running: accumulator.alreadyRunning,
      skipped: accumulator.skipped,
      errors: accumulator.errors,
      items: accumulator.items
    };
  }

  #runCallbackRetryMonitor(options: MonitorCliOptions): void {
    const statePath = expandHome(required(options.state, "--state is required"));
    this.#dependencies.callbacks.runRetryMonitor({
      statePath,
      initialDelayMs: options.callbackRetryDelayMs
    });
  }

  #runTerminalBridgeMonitorHandoff(options: MonitorCliOptions): void {
    const statePath = expandHome(required(options.state, "--state is required"));
    const logPath = expandHome(
      (options.log ?? this.#dependencies.io.logPathForStatePath(statePath)) as string
    );
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
    const handoffLockPath = monitorOwner.handoffLockPath(
      statePath,
      expectedMessageId
    );
    const release = this.#acquireHandoffLock(handoffLockPath);
    if (!release) return;
    try {
      const started = this.#dependencies.io.loadState(statePath);
      this.#dependencies.io.appendEvent(logPath, {
        ts: this.#dependencies.runtime.now().toISOString(),
        conversation_id: started.conversation_id,
        event: "terminal_bridge_monitor_handoff_watchdog_started",
        terminal_bridge_message_id: expectedMessageId
      });
      while (
        this.#runHandoffCycle({
          options,
          statePath,
          logPath,
          expectedMessageId,
          pollIntervalMs
        }) === "retry"
      ) {
        this.#dependencies.runtime.sleepSync(pollIntervalMs);
      }
    } finally {
      release();
    }
  }

  #acquireHandoffLock(lockPath: string): Release | undefined {
    try {
      return this.#dependencies.io.locks.acquire(lockPath, { timeoutMs: 0 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "LOCK_TIMEOUT") throw error;
      this.#dependencies.runtime.print({
        monitored: false,
        terminal_bridge: true,
        handoff_watchdog: false,
        already_running: true,
        reason: "terminal_bridge_monitor_handoff_watchdog_already_running"
      });
      return undefined;
    }
  }

  #runHandoffCycle(input: {
    options: MonitorCliOptions;
    statePath: string;
    logPath: string;
    expectedMessageId: string;
    pollIntervalMs: number;
  }): HandoffDisposition {
    const conversation = this.#dependencies.io.loadState(input.statePath);
    const currentMessageId = nonBlankString(
      takeoverFor(conversation)?.terminal_bridge_message_id
    );
    if (currentMessageId !== input.expectedMessageId) {
      return this.#finishHandoff(input, conversation, "terminal_bridge_task_replaced", {
        current_terminal_bridge_message_id: currentMessageId
      });
    }
    if (conversation.status === "waiting_for_openclaw") return "retry";
    if (conversation.status !== "waiting_for_agent") {
      return this.#finishHandoff(
        input,
        conversation,
        "conversation_no_longer_waiting_for_agent",
        { status: conversation.status }
      );
    }
    const eligibility = this.#dependencies.state.eligibility(conversation);
    if (!eligibility.eligible) {
      return this.#finishHandoff(input, conversation, eligibility.reason);
    }
    if (
      this.activeTerminalBridgeMonitorOwner(
        input.statePath,
        input.expectedMessageId
      )
    ) return "retry";
    const prepared = this.#prepareLaunch({
      statePath: input.statePath,
      expectedMessageId: input.expectedMessageId,
      requireWaitingForAgentStatus: true
    });
    if (!prepared.prepared) {
      return prepared.alreadyRunning
        ? "retry"
        : this.#finishHandoff(input, conversation, prepared.reason);
    }
    return this.#launchHandoffMonitor(input, prepared);
  }

  #launchHandoffMonitor(
    input: {
      options: MonitorCliOptions;
      statePath: string;
      logPath: string;
      expectedMessageId: string;
    },
    prepared: Extract<TerminalMonitorLaunchPreparation, { prepared: true }>
  ): HandoffDisposition {
    const monitor = this.startTerminalBridgeMonitorForConversation({
      conversation: prepared.conversation,
      statePath: input.statePath,
      logPath: input.logPath,
      options: input.options
    });
    if (!monitor) {
      return this.#finishHandoff(
        input,
        prepared.conversation,
        "terminal_bridge_monitor_launch_disabled"
      );
    }
    const launchedAt = this.#dependencies.runtime.now().toISOString();
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: launchedAt,
      conversation_id: prepared.conversation.conversation_id,
      event: "terminal_bridge_monitor_launch",
      pid: monitor.pid ?? null,
      terminal_control: prepared.terminalControl,
      terminal_bridge_message_id: input.expectedMessageId,
      reason: "approval_handoff_reconciliation",
      agent_timeout_minutes: prepared.inactivityTimeoutMinutes,
      agent_hard_timeout_minutes: prepared.hardTimeoutMinutes
    });
    this.#dependencies.runtime.log(
      "info",
      "terminal_bridge_monitor_handoff_reconciled",
      {
        conversation_id: prepared.conversation.conversation_id,
        monitor_pid: monitor.pid ?? null,
        terminal_target: prepared.terminalControl.target,
        terminal_bridge_message_id: input.expectedMessageId
      }
    );
    this.#dependencies.runtime.print({
      conversation: prepared.conversation,
      monitored: true,
      terminal_bridge: true,
      handoff_watchdog: true,
      launched: true,
      monitor_pid: monitor.pid ?? null,
      reason: "approval_handoff_reconciliation"
    });
    return "finished";
  }

  #finishHandoff(
    input: { logPath: string; expectedMessageId: string },
    conversation: Conversation,
    reason: string,
    detail: Record<string, unknown> = {}
  ): HandoffDisposition {
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: this.#dependencies.runtime.now().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_monitor_handoff_watchdog_finished",
      terminal_bridge_message_id: input.expectedMessageId,
      ...detail,
      reason
    });
    return "finished";
  }

  async #runTerminalBridgeMonitor(options: MonitorCliOptions): Promise<void> {
    const statePath = expandHome(required(options.state, "--state is required"));
    const logPath = expandHome(
      (options.log ?? this.#dependencies.io.logPathForStatePath(statePath)) as string
    );
    const conversation = this.#dependencies.io.loadState(statePath);
    const terminalMessageId = nonBlankString(
      takeoverFor(conversation)?.terminal_bridge_message_id
    ) ?? "missing-message-id";
    const monitorLock = this.#tryAcquireMonitorLock(
      statePath,
      terminalMessageId
    );
    if (!monitorLock.acquired) {
      this.#recordAlreadyRunningMonitor(
        conversation,
        terminalMessageId,
        monitorLock.ownerPid
      );
      return;
    }
    const lifecycle = { startedRecorded: false };
    try {
      await runTerminalMonitorWithStoreDeferral({
        initialConversation: conversation,
        terminalMessageId,
        run: () => this.#runTerminalBridgeMonitorWithLock(
          options,
          lifecycle,
          terminalMessageId
        ),
        ports: this.#dependencies.state.deferralPorts({ statePath, logPath })
      });
    } finally {
      monitorLock.release();
    }
  }

  async #runTerminalBridgeMonitorWithLock(
    options: MonitorCliOptions,
    lifecycle: { startedRecorded: boolean },
    expectedTerminalMessageId: string
  ): Promise<void> {
    const statePath = expandHome(required(options.state, "--state is required"));
    const logPath = expandHome(
      (options.log ?? this.#dependencies.io.logPathForStatePath(statePath)) as string
    );
    const pollIntervalMs = Math.max(
      50,
      Number(options.pollIntervalMs ?? DEFAULT_MONITOR_POLL_INTERVAL_MS)
    );
    const initialConversation = await this.#dependencies.authority
      .migrateIdentity({
        conversation: this.#dependencies.io.loadState(statePath),
        statePath,
        logPath,
        options
      });
    const initialTakeover = takeoverFor(initialConversation);
    let terminalBridge: TerminalAgentBridge | undefined;
    await this.#dependencies.state.runService({
      options,
      statePath,
      logPath,
      initialConversation,
      expectedTerminalMessageId,
      lifecycle,
      configuration: () => ({
        pollIntervalMs,
        timeoutMinutes: Number(
          options.agentTimeoutMinutes ??
            initialTakeover?.terminal_bridge_inactivity_timeout_minutes ??
            DEFAULT_AGENT_TIMEOUT_MINUTES
        ),
        hardTimeoutMinutes: positiveMinutes(
          options.agentHardTimeoutMinutes ??
            initialTakeover?.terminal_bridge_hard_timeout_minutes ??
            DEFAULT_AGENT_HARD_TIMEOUT_MINUTES,
          "--agent-hard-timeout-minutes"
        )
      }),
      terminalBridge: () => terminalBridge ??=
        this.#dependencies.authority.createBridge(options)
    });
  }

  #recordAlreadyRunningMonitor(
    conversation: Conversation,
    terminalMessageId: string,
    ownerPid?: number
  ): void {
    this.#dependencies.runtime.log(
      "info",
      "terminal_bridge_monitor_already_running",
      {
        conversation_id: conversation.conversation_id,
        terminal_bridge_message_id: terminalMessageId,
        monitor_owner_pid: ownerPid
      }
    );
    this.#dependencies.runtime.print({
      conversation,
      monitored: false,
      terminal_bridge: true,
      already_running: true,
      reason: "terminal_bridge_monitor_already_running",
      monitor_owner_pid: ownerPid ?? null
    });
  }

  #tryAcquireMonitorLock(
    statePath: string,
    terminalMessageId: string
  ):
    | { acquired: true; lockPath: string; release: Release }
    | { acquired: false; lockPath: string; ownerPid?: number } {
    const lockPath = monitorOwner.lockPath(statePath, terminalMessageId);
    try {
      return {
        acquired: true,
        lockPath,
        release: this.#dependencies.io.locks.acquire(
          lockPath,
          { timeoutMs: 0 }
        )
      };
    } catch (error) {
      if (isRecord(error) && error.code === "LOCK_TIMEOUT") {
        return { acquired: false, ...this.#monitorLockOwner(lockPath) };
      }
      throw error;
    }
  }

  #prepareLaunch(input: {
    statePath: string;
    expectedMessageId: string;
    requireWaitingForAgentStatus?: boolean;
  }): TerminalMonitorLaunchPreparation {
    return this.#dependencies.state.prepareLaunch({
      ...input,
      activeOwner: (statePath, terminalMessageId) =>
        this.activeTerminalBridgeMonitorOwner(
          statePath,
          terminalMessageId
        ),
      monitorLockVersion: monitorOwner.LOCK_VERSION
    });
  }

  #latestLaunchPid(logPath: string): number | undefined {
    try {
      return monitorOwner.latestLaunchPid(
        this.#dependencies.io.readEvents(logPath)
      );
    } catch {
      return undefined;
    }
  }

  #monitorLockOwner(lockPath: string): TerminalMonitorOwner {
    return {
      lockPath,
      ownerPid: this.#dependencies.io.locks.owner(lockPath).pid
    };
  }

  #spawnDetached(
    plan?: monitorLaunch.DetachedTerminalMonitorPlan
  ): DetachedMonitorProcess | undefined {
    if (!plan) return undefined;
    const child = this.#dependencies.io.spawn(
      this.#dependencies.runtime.executablePath(),
      plan.args,
      {
        detached: true,
        stdio: "ignore",
        cwd: this.#dependencies.runtime.cwd(),
        env: plan.environment
      }
    );
    child.unref();
    return child;
  }

  #recordApprovalLaunch(input: TerminalMonitorApprovalLaunchRequest & {
    reason: string;
    terminalMessageId?: string;
    activeMonitor?: TerminalMonitorOwner;
    launchedMonitor?: DetachedMonitorProcess;
    handoffWatchdog?: DetachedMonitorProcess;
  }): void {
    const timeouts = monitorLaunch.terminalMonitorTimeoutPlan(input);
    const activeMonitor = input.activeMonitor;
    if (activeMonitor) {
      this.#recordReusedApprovalMonitor(
        { ...input, activeMonitor },
        timeouts
      );
    } else if (input.launchedMonitor) {
      this.#dependencies.io.appendEvent(input.logPath, {
        ts: this.#dependencies.runtime.now().toISOString(),
        conversation_id: input.conversation.conversation_id,
        event: "terminal_bridge_monitor_launch",
        pid: input.launchedMonitor.pid ?? null,
        terminal_control: input.terminalControl,
        reason: input.reason,
        agent_timeout_minutes: timeouts.agentTimeoutMinutes,
        agent_hard_timeout_minutes: timeouts.agentHardTimeoutMinutes
      });
      this.#dependencies.runtime.log("info", "terminal_bridge_monitor_launch", {
        conversation_id: input.conversation.conversation_id,
        monitor_pid: input.launchedMonitor.pid ?? null,
        terminal_target: input.terminalControl.target,
        reason: input.reason
      });
    }
  }

  #recordReusedApprovalMonitor(
    input: TerminalMonitorApprovalLaunchRequest & {
      reason: string;
      terminalMessageId?: string;
      activeMonitor: TerminalMonitorOwner;
      handoffWatchdog?: DetachedMonitorProcess;
    },
    timeouts: monitorLaunch.TerminalMonitorTimeoutPlan
  ): void {
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: this.#dependencies.runtime.now().toISOString(),
      conversation_id: input.conversation.conversation_id,
      event: "terminal_bridge_monitor_reused",
      pid: input.activeMonitor.ownerPid ?? null,
      terminal_control: input.terminalControl,
      reason: input.reason,
      agent_timeout_minutes: timeouts.agentTimeoutMinutes,
      agent_hard_timeout_minutes: timeouts.agentHardTimeoutMinutes
    });
    this.#dependencies.runtime.log("info", "terminal_bridge_monitor_reused", {
      conversation_id: input.conversation.conversation_id,
      monitor_pid: input.activeMonitor.ownerPid ?? null,
      terminal_target: input.terminalControl.target,
      reason: input.reason
    });
    if (!input.handoffWatchdog) return;
    this.#dependencies.io.appendEvent(input.logPath, {
      ts: this.#dependencies.runtime.now().toISOString(),
      conversation_id: input.conversation.conversation_id,
      event: "terminal_bridge_monitor_handoff_watchdog_launch",
      pid: input.handoffWatchdog.pid ?? null,
      monitor_owner_pid: input.activeMonitor.ownerPid ?? null,
      terminal_bridge_message_id: input.terminalMessageId,
      terminal_control: input.terminalControl,
      reason: input.reason
    });
    this.#dependencies.runtime.log(
      "info",
      "terminal_bridge_monitor_handoff_watchdog_launch",
      {
        conversation_id: input.conversation.conversation_id,
        watchdog_pid: input.handoffWatchdog.pid ?? null,
        monitor_owner_pid: input.activeMonitor.ownerPid ?? null,
        terminal_target: input.terminalControl.target,
        reason: input.reason
      }
    );
  }
}

function takeoverFor(
  conversation: Conversation
): Record<string, unknown> | undefined {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

function required(
  value: unknown,
  message: string
): string {
  if (value === undefined || value === "") throw new Error(message);
  return value as string;
}

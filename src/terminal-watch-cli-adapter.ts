import { createHash } from "node:crypto";
import path from "node:path";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  captureClaudeHumanStartedActiveTaskAnchor,
  observeClaudeHumanStartedActiveTask,
  type ClaudeHumanStartedActiveTaskAnchor
} from "./claude-local-transcript-provider.js";
import type { ExecutorKind } from "./executors.js";
import {
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  decideTerminalWatchExternalTaskAuthority,
  type TerminalDispatchOwnership
} from "./terminal-action-projection.js";
import { exactTerminalWatchAction } from "./terminal-list-renderer.js";
import {
  captureCodexHumanStartedActiveTaskAnchor,
  observeCodexHumanStartedActiveTask,
  type CodexHumanStartedActiveTaskAnchor,
  type CodexRolloutAcceptanceIdentity
} from "./terminal-submission-acceptance.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  sameTerminalControlEvidenceIncarnation,
  terminalControlEvidence
} from "./terminal-control-ref.js";
import {
  createTerminalWatchCallbackCliAdapter,
  type TerminalWatchCallbackCliAdapter,
  type TerminalWatchCallbackEvent
} from "./terminal-watch-callback-cli-adapter.js";
import {
  createTerminalWatchService,
  terminalWatchObservationFence,
  type TerminalWatchObservation,
  type TerminalWatchService
} from "./terminal-watch-service.js";
import {
  activeTaskAnchorForTerminalWatch,
  createTerminalWatchStore,
  terminalWatchIdentityFingerprint,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchNotification,
  type TerminalWatchTerminalIdentity
} from "./terminal-watch-store.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

const DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES = 720;

export interface TerminalWatchCliOptions {
  claudeHome?: string;
  expectedBindingToken?: string;
  hardTimeoutMinutes?: number | string;
  logDir?: string;
  openclawBin?: string;
  openclawSession?: string;
  storeDir?: string;
  terminal?: string;
  watch?: string;
  [option: string]: unknown;
}

interface TerminalWatchScan {
  terminalControlled: Array<Record<string, unknown>>;
}

export interface TerminalWatchCliDependencies {
  acquireFileLock(lockPath: string): () => void;
  acquireTerminalLock(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): () => void;
  buildTerminalListGroup(request: {
    options: TerminalWatchCliOptions;
    agentFilter?: ExecutorKind;
    statusFilter?: string;
  }): Promise<TerminalWatchScan>;
  loadClaudeAgentRows(
    options: TerminalWatchCliOptions,
    observation?: { required?: boolean }
  ): readonly ClaudeAgentRow[];
  now(): Date;
  randomUUID(): string;
  storeDirFromOptions(options: TerminalWatchCliOptions): string;
  terminalDispatchOwnership(
    terminalControl: TerminalControlRef
  ): TerminalDispatchOwnership<Conversation, Record<string, unknown>>;
  terminalIncarnationBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): Conversation[];
  printJson(value: unknown): void;
  callback?: TerminalWatchCallbackCliAdapter;
}

export interface TerminalWatchCliFacade {
  runWatch(options: TerminalWatchCliOptions): Promise<void>;
  runUnwatch(options: TerminalWatchCliOptions): Promise<void>;
  runWatchStatus(options: TerminalWatchCliOptions): void;
  runReconcileWatches(options: TerminalWatchCliOptions): Promise<void>;
  listPublicWatches(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): Array<Record<string, unknown>>;
}

export function createTerminalWatchCliAdapter(
  dependencies: TerminalWatchCliDependencies
): TerminalWatchCliFacade {
  const callback = dependencies.callback ??
    createTerminalWatchCallbackCliAdapter();

  function serviceFor(
    options: TerminalWatchCliOptions
  ): TerminalWatchService {
    const repository = createTerminalWatchStore(
      dependencies.storeDirFromOptions(options),
      { acquire: dependencies.acquireFileLock }
    );
    return createTerminalWatchService({
      repository,
      now: dependencies.now,
      randomUUID: dependencies.randomUUID,
      observe: (watch) => observeTerminalWatch(watch, options, dependencies),
      deliver: async ({ watch, notification, idempotencyKey }) => {
        callback.deliver({
          watchId: watch.watch_id,
          notificationId: notification.notification_id,
          idempotencyKey,
          event: callbackEvent(notification),
          agent: watch.agent,
          terminalId: watch.terminal.terminal_id,
          openclawSession: watch.openclaw_session,
          openclawBin: watch.openclaw_bin,
          detail: notification.reason_code ?? watch.settlement?.reason_code,
          completionText:
            notification.kind === "completed" || notification.kind === "failed"
              ? watch.settlement?.completion_text
              : undefined
        });
      }
    });
  }

  async function runWatch(options: TerminalWatchCliOptions): Promise<void> {
    const terminalId = requiredString(options.terminal, "--terminal");
    const expectedBindingToken = requiredSha256(
      options.expectedBindingToken,
      "--expected-binding-token"
    );
    const openclawSession = requiredString(
      options.openclawSession,
      "--openclaw-session"
    );
    const storeDir = dependencies.storeDirFromOptions(options);
    const initiallyObservedTerminal = await exactTerminalForWatch(
      terminalId,
      expectedBindingToken,
      options,
      dependencies
    );
    const initialTerminalControl = terminalControlForWatch(
      initiallyObservedTerminal
    );
    const releaseTerminal = dependencies.acquireTerminalLock(
      storeDir,
      initialTerminalControl
    );
    let watch: TerminalWatch;
    try {
      const terminal = await exactTerminalForWatch(
        terminalId,
        expectedBindingToken,
        options,
        dependencies
      );
      const terminalControl = terminalControlForWatch(terminal);
      if (!sameTerminalControlEvidenceIncarnation(
        initialTerminalControl,
        terminalControl
      )) {
        throw new Error(
          "terminal binding changed while AKK acquired authority; refresh " +
          "AKK list and retry"
        );
      }
      assertExternalTerminalWatchAuthority(
        storeDir,
        terminalControl,
        dependencies
      );
      const watchService = serviceFor(options);
      const existing = watchService.list().find((candidate) =>
        candidate.status === "active" &&
        candidate.terminal.terminal_id === terminalId
      );
      if (existing) {
        throw new Error(
          `terminal ${terminalId} is already monitored by Terminal Watch ` +
          `${existing.watch_id}; use watch-status instead of creating another`
        );
      }
      assertExactPublicWatchAction(
        terminal,
        terminalId,
        expectedBindingToken
      );
      const agent = terminalAgent(terminal);
      const anchor = captureTerminalWatchAnchor(
        agent,
        terminal,
        options,
        dependencies
      );
      if (!anchor) {
        throw new Error(
          "the exact terminal has no unique supported human-started active task"
        );
      }
      watch = watchService.create({
        agent,
        terminal: terminalWatchIdentity(
          terminal,
          agent,
          expectedBindingToken,
          dependencies.loadClaudeAgentRows(options)
        ),
        anchor,
        openclaw_session: openclawSession,
        openclaw_bin: stringValue(options.openclawBin) ?? "openclaw",
        timeout_ms: positiveMinutes(
          options.hardTimeoutMinutes,
          DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES
        ) * 60_000,
        approval_fingerprint: approvalFingerprint(terminal),
        approval_reason_code: approvalFingerprint(terminal)
          ? "terminal_waiting_for_approval"
          : undefined
      });
    } finally {
      releaseTerminal();
    }
    dependencies.printJson({ watch: publicTerminalWatch(watch) });
  }

  async function runUnwatch(options: TerminalWatchCliOptions): Promise<void> {
    const service = serviceFor(options);
    const watch = service.cancel(requiredWatchId(options.watch));
    dependencies.printJson({ watch: publicTerminalWatch(watch) });
  }

  function runWatchStatus(options: TerminalWatchCliOptions): void {
    const watch = serviceFor(options).get(requiredWatchId(options.watch));
    dependencies.printJson({ watch: publicTerminalWatch(watch) });
  }

  async function runReconcileWatches(
    options: TerminalWatchCliOptions
  ): Promise<void> {
    dependencies.printJson(await serviceFor(options).reconcileAll());
  }

  function listPublicWatches(
    storeDir: string,
    options: { includeAll?: boolean } = {}
  ): Array<Record<string, unknown>> {
    const service = serviceFor({ storeDir });
    return service.list()
      .filter((watch) => options.includeAll || watch.status === "active")
      .map(publicTerminalWatch);
  }

  return Object.freeze({
    runWatch,
    runUnwatch,
    runWatchStatus,
    runReconcileWatches,
    listPublicWatches
  });
}

async function exactTerminalForWatch(
  terminalId: string,
  expectedBindingToken: string,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<Record<string, unknown>> {
  const scan = await dependencies.buildTerminalListGroup({ options });
  const matches = scan.terminalControlled.filter(
    (terminal) => stringValue(terminal.id) === terminalId
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected one exact terminal ${terminalId}; observed ${matches.length}`
    );
  }
  const terminal = matches[0];
  if (stringValue(terminal.lifecycle_binding_token) !== expectedBindingToken) {
    throw new Error(
      "terminal binding changed after it was listed; refresh AKK list and retry"
    );
  }
  return terminal;
}

function assertExactPublicWatchAction(
  terminal: Record<string, unknown>,
  terminalId: string,
  expectedBindingToken: string
): void {
  if (!exactTerminalWatchAction(
    terminal,
    terminalId,
    expectedBindingToken
  )) {
    throw new Error(
      "the exact terminal is not currently watchable; refresh AKK list and " +
      "use only its current available_actions.watch"
    );
  }
}

function terminalControlForWatch(
  terminal: Record<string, unknown>
): TerminalControlRef {
  if (!isRecord(terminal.terminal_control)) {
    throw new Error("the exact terminal has no terminal control authority");
  }
  return terminal.terminal_control as unknown as TerminalControlRef;
}

function assertExternalTerminalWatchAuthority(
  storeDir: string,
  terminalControl: TerminalControlRef,
  dependencies: TerminalWatchCliDependencies
): void {
  const blockingTurn = dependencies.terminalIncarnationBlockingTurns(
    storeDir,
    terminalControl
  )[0];
  const authority = decideTerminalWatchExternalTaskAuthority({
    blockingTurn,
    dispatchOwnership: blockingTurn
      ? { state: "none" }
      : dependencies.terminalDispatchOwnership(terminalControl)
  });
  if (authority.state === "external_task") {
    return;
  }
  if (authority.state === "managed_turn") {
    const turn = authority.conversation;
    throw new Error(
      `Terminal Watch is unavailable: this task already belongs to AKK Turn ` +
      `${turnIdForConversation(turn)} (${turn.status}) and is covered by the ` +
      "managed Turn monitor/callback path. Use AKK status for that Turn."
    );
  }
  const reason = stringValue(authority.conflict.reason) ??
    "terminal dispatch ownership is conflicted";
  throw new Error(
    `Terminal Watch is unavailable because AKK cannot prove this is external ` +
    `work: ${reason}. Refresh AKK list and resolve the ownership conflict.`
  );
}

function captureTerminalWatchAnchor(
  agent: ExecutorKind,
  terminal: Record<string, unknown>,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): TerminalWatchAnchor | undefined {
  if (agent === "codex") {
    const captured = captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity: codexIdentity(terminal),
      now: dependencies.now()
    });
    return captured && {
      kind: "codex_rollout",
      native_task_id: captured.turn_id,
      captured_at: captured.captured_at,
      request_hash: captured.request_hash,
      codex_version: captured.codex_version,
      rollout: captured.rollout,
      task_started_offset_bytes: captured.task_started_offset_bytes,
      user_message_offset_bytes: captured.user_message_offset_bytes,
      observed_end_offset_bytes: captured.observed_end_offset_bytes,
      evidence_fingerprint: captured.anchor_fingerprint
    };
  }
  const captured = captureClaudeHumanStartedActiveTaskAnchor({
    sessionId: requiredString(
      terminal.native_agent_session_id,
      "Claude native session id"
    ),
    cwd: terminalWorkspace(terminal),
    pid: positiveInteger(terminal.pid, "Claude PID"),
    claudeHome: stringValue(options.claudeHome),
    agentRows: dependencies.loadClaudeAgentRows(options, { required: true }),
    now: dependencies.now()
  });
  return captured && {
    kind: "claude_transcript",
    root_prompt_uuid: captured.prompt_uuid,
    captured_at: captured.captured_at,
    request_hash: captured.request_hash,
    claude_version: captured.claude_version,
    transcript_file_id: captured.transcript_file_id,
    turn_start_offset_bytes: captured.turn_start_offset_bytes,
    transcript: {
      relative_path: captured.relative_path,
      device: captured.device,
      inode: captured.inode
    },
    observed_end_offset_bytes: captured.observed_end_offset_bytes,
    evidence_fingerprint: captured.anchor_fingerprint
  };
}

async function observeTerminalWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<TerminalWatchObservation> {
  const observedAt = dependencies.now().toISOString();
  const fence = terminalWatchObservationFence(watch);
  const terminal = await currentTerminalForWatch(watch, options, dependencies);
  const terminalMatches = terminal
    ? terminalMatchesWatch(terminal, watch, dependencies, options)
    : false;
  const anchor = activeTaskAnchorForTerminalWatch(watch);
  const observation = watch.agent === "codex"
    ? observeCodexHumanStartedActiveTask({
        anchor: anchor as CodexHumanStartedActiveTaskAnchor,
        currentIdentity: terminal
          ? codexIdentity(terminal)
          : codexIdentityForWatch(watch)
      })
    : observeClaudeHumanStartedActiveTask({
        anchor: anchor as ClaudeHumanStartedActiveTaskAnchor,
        claudeHome: stringValue(options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(options)
      });
  if (observation.status === "invalidated") {
    return invalidatedObservation(watch, observedAt, "task_anchor_invalidated");
  }
  if (observation.status === "completed") {
    const completion = observation.completion;
    const kind = completion.outcome === "failure" ? "failed" : "completed";
    return {
      ...fence,
      kind,
      observed_at: observedAt,
      evidence_fingerprint: sha256({
        kind,
        watch_id: watch.watch_id,
        completion_id: completion.id ?? null,
        completion_timestamp: completion.timestamp ?? null,
        anchor_fingerprint: watch.anchor.evidence_fingerprint
      }),
      reason_code: completion.outcome === "failure"
        ? "anchored_task_failed"
        : "anchored_task_completed",
      completion_text: completion.text.slice(0, 4000),
      completion_id: completion.id,
      completion_timestamp: completion.timestamp
    };
  }
  if (terminal && !terminalMatches) {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_identity_changed"
    );
  }
  if (!terminal) {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_process_unavailable"
    );
  }
  const approval = approvalFingerprint(terminal);
  if (approval) {
    return {
      ...fence,
      kind: "approval",
      observed_at: observedAt,
      last_activity_at: observedAt,
      evidence_fingerprint: approval,
      reason_code: "terminal_waiting_for_approval"
    };
  }
  return { ...fence, kind: "pending", observed_at: observedAt };
}

async function currentTerminalForWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<Record<string, unknown> | undefined> {
  const scan = await dependencies.buildTerminalListGroup({
    options,
    agentFilter: watch.agent
  });
  const matches = scan.terminalControlled.filter(
    (terminal) => stringValue(terminal.id) === watch.terminal.terminal_id
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function terminalMatchesWatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch,
  dependencies: TerminalWatchCliDependencies,
  options: TerminalWatchCliOptions
): boolean {
  try {
    const agent = terminalAgent(terminal);
    const current = terminalWatchIdentity(
      terminal,
      agent,
      requiredSha256(
        terminal.lifecycle_binding_token,
        "current terminal binding token"
      ),
      dependencies.loadClaudeAgentRows(options)
    );
    return agent === watch.agent &&
      terminalWatchIdentityFingerprint({
        agent,
        terminal: current,
        anchor: watch.anchor
      }) === terminalWatchIdentityFingerprint(watch) &&
      sameTerminalControlEvidenceIncarnation(
        current.terminal_endpoint,
        watch.terminal.terminal_endpoint
      );
  } catch {
    return false;
  }
}

function terminalWatchIdentity(
  terminal: Record<string, unknown>,
  agent: ExecutorKind,
  bindingToken: string,
  claudeRows: readonly ClaudeAgentRow[]
): TerminalWatchTerminalIdentity {
  const terminalControl = terminal.terminal_control as TerminalControlRef;
  const pid = positiveInteger(terminal.pid, "terminal agent PID");
  const nativeThreadId = requiredString(
    terminal.native_agent_session_id,
    "terminal native thread id"
  );
  const lifecycle = isRecord(terminal.native_thread_lifecycle)
    ? terminal.native_thread_lifecycle
    : {};
  const processStartedAt = agent === "claude"
    ? uniqueClaudeProcessStart(claudeRows, pid, nativeThreadId)
    : undefined;
  return {
    terminal_id: requiredString(terminal.id, "terminal id"),
    terminal_endpoint: terminalControlEvidence(terminalControl),
    agent_pid: pid,
    process_uuid: requiredString(
      terminal.native_agent_process_uuid,
      "terminal process UUID"
    ),
    process_birth: requiredString(
      terminal.native_agent_process_birth,
      "terminal process birth"
    ),
    process_started_at_ms: processStartedAt,
    native_thread_id: nativeThreadId,
    workspace: terminalWorkspace(terminal),
    binding_token: bindingToken,
    agent_version: requiredString(terminal.agent_version, "terminal agent version"),
    behavior_profile: requiredString(
      lifecycle.behaviorProfile,
      "terminal behavior profile"
    )
  };
}

function codexIdentity(
  terminal: Record<string, unknown>
): CodexRolloutAcceptanceIdentity {
  if (!isRecord(terminal.native_agent_rollout)) {
    throw new Error("Codex terminal has no exact rollout identity");
  }
  return {
    sessionId: requiredString(
      terminal.native_agent_session_id,
      "Codex native thread id"
    ),
    processUuid: requiredString(
      terminal.native_agent_process_uuid,
      "Codex process UUID"
    ),
    processBirth: requiredString(
      terminal.native_agent_process_birth,
      "Codex process birth"
    ),
    rollout: {
      fd: requiredString(terminal.native_agent_rollout.fd, "Codex rollout fd"),
      device: requiredString(
        terminal.native_agent_rollout.device,
        "Codex rollout device"
      ),
      inode: requiredString(
        terminal.native_agent_rollout.inode,
        "Codex rollout inode"
      ),
      path: requiredString(
        terminal.native_agent_rollout.path,
        "Codex rollout path"
      )
    }
  };
}

function codexIdentityForWatch(
  watch: TerminalWatch
): CodexRolloutAcceptanceIdentity {
  if (watch.agent !== "codex" || watch.anchor.kind !== "codex_rollout") {
    throw new Error("terminal Watch has no Codex identity");
  }
  return {
    sessionId: watch.terminal.native_thread_id,
    processUuid: watch.terminal.process_uuid,
    processBirth: watch.terminal.process_birth,
    rollout: watch.anchor.rollout
  };
}

function uniqueClaudeProcessStart(
  rows: readonly ClaudeAgentRow[],
  pid: number,
  nativeThreadId: string
): number {
  const matches = rows.filter((row) =>
    row.pid === pid && row.sessionId === nativeThreadId
  );
  if (matches.length !== 1) {
    throw new Error("Claude terminal has no unique exact process row");
  }
  return positiveInteger(matches[0].startedAt, "Claude process start time");
}

function publicTerminalWatch(watch: TerminalWatch): Record<string, unknown> {
  const pending = watch.notification_outbox.filter(({ status }) =>
    status === "pending" || status === "delivering" || status === "failed"
  ).length;
  return {
    watch_id: watch.watch_id,
    source: "human_started_terminal_watch",
    agent: watch.agent,
    terminal_id: watch.terminal.terminal_id,
    native_thread_id: watch.terminal.native_thread_id,
    workspace: watch.terminal.workspace,
    status: watch.status,
    activity_state: watch.status === "active" ? "watching" : "settled",
    created_at: watch.created_at,
    deadline_at: watch.deadline_at,
    updated_at: watch.updated_at,
    last_activity_at: watch.last_activity_at,
    callback: {
      pending,
      delivered: watch.notification_outbox.filter(
        ({ status }) => status === "delivered"
      ).length,
      failed: watch.notification_outbox.filter(
        ({ status }) => status === "failed"
      ).length,
      superseded: watch.notification_outbox.filter(
        ({ status }) => status === "superseded"
      ).length
    },
    ...(watch.settlement
      ? {
          settlement: {
            kind: watch.settlement.kind,
            observed_at: watch.settlement.observed_at,
            reason_code: watch.settlement.reason_code,
            completion_text: watch.settlement.completion_text,
            completion_id: watch.settlement.completion_id,
            completion_timestamp: watch.settlement.completion_timestamp
          }
        }
      : {}),
    available_actions: {
      status: {
        tool: "agent_knock_knock_status",
        arguments: { watch_id: watch.watch_id }
      },
      ...(watch.status === "active"
        ? {
            unwatch: {
              tool: "agent_knock_knock_unwatch",
              arguments: { watch_id: watch.watch_id },
              requires_user_intent: true
            }
          }
        : {})
    }
  };
}

function callbackEvent(
  notification: TerminalWatchNotification
): TerminalWatchCallbackEvent {
  return notification.kind === "approval"
    ? "approval_required"
    : notification.kind;
}

function approvalFingerprint(
  terminal: Record<string, unknown>
): string | undefined {
  if (terminal.activity_state !== "awaiting_approval") return undefined;
  const approval = isRecord(terminal.approval_state)
    ? terminal.approval_state
    : undefined;
  const fingerprint = stringValue(approval?.fingerprint);
  return fingerprint && /^[a-f0-9]{64}$/u.test(fingerprint)
    ? fingerprint
    : undefined;
}

function invalidatedObservation(
  watch: TerminalWatch,
  observedAt: string,
  reasonCode: string
): TerminalWatchObservation {
  return {
    ...terminalWatchObservationFence(watch),
    kind: "invalidated",
    observed_at: observedAt,
    evidence_fingerprint: sha256({
      watch_id: watch.watch_id,
      reason_code: reasonCode,
      anchor_fingerprint: watch.anchor.evidence_fingerprint
    }),
    reason_code: reasonCode
  };
}

function terminalAgent(terminal: Record<string, unknown>): ExecutorKind {
  const agent = stringValue(terminal.agent);
  if (agent !== "codex" && agent !== "claude") {
    throw new Error("terminal Watch supports only Codex or Claude Code");
  }
  return agent;
}

function terminalWorkspace(terminal: Record<string, unknown>): string {
  const workspace = requiredString(
    terminal.workspace ?? terminal.cwd,
    "terminal workspace"
  );
  if (!path.isAbsolute(workspace)) {
    throw new Error("terminal workspace must be absolute");
  }
  return path.resolve(workspace);
}

function requiredWatchId(value: unknown): string {
  const watchId = requiredString(value, "--watch");
  if (!/^terminal-watch-[A-Za-z0-9._:-]+$/u.test(watchId)) {
    throw new Error("--watch must be an exact Terminal Watch id");
  }
  return watchId;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result || result.includes("\0")) {
    throw new Error(`${label} is required`);
  }
  return result;
}

function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    const characters = Array.from(result);
    const invalidCharacterCount = characters.filter(
      (character) => !/^[a-f0-9]$/u.test(character)
    ).length;
    throw new Error(
      `${label} is invalid: received ${characters.length} characters; ` +
      "invalid-character count outside lowercase ASCII hexadecimal " +
      `[a-f0-9]: ${invalidCharacterCount}. It must be exactly 64 lowercase ` +
      "ASCII " +
      "hexadecimal characters. Do not retry this Watch command with the " +
      "same arguments. Refresh AKK list and copy the current terminal's " +
      "entire available_actions.watch.arguments object verbatim; do not " +
      "retype, shorten, summarize, or use ... or …."
    );
  }
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

function positiveMinutes(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error("--hard-timeout-minutes must be a positive number");
  }
  return result;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

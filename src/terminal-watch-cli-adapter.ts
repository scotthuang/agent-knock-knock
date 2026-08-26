import { createHash } from "node:crypto";
import path from "node:path";
import {
  parseCallbackRoute,
  type CallbackRouteV1
} from "./callback-transport.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  captureClaudeHumanStartedActiveTaskAnchor,
  observeClaudeHumanStartedActiveTask
} from "./claude-local-transcript-provider.js";
import { claudeRuntimeCompatibilityWarning } from
  "./claude-lifecycle-compatibility.js";
import { codexRuntimeCompatibilityProfile } from
  "./codex-lifecycle-compatibility.js";
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
  type CodexRolloutAcceptanceIdentity
} from "./terminal-submission-acceptance.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  sameTerminalControlEvidenceIncarnation,
  terminalControlEvidence
} from "./terminal-control-ref.js";
import {
  createTerminalWatchCallbackCliAdapter,
  resolveTerminalWatchOpenClawCallback,
  resolveTerminalWatchOpenClawCallbackContext,
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
  createTerminalWatchStore,
  terminalWatchIdentityFingerprint,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchObservationCheckpoint,
  type TerminalWatchTerminalIdentity
} from "./terminal-watch-store.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

const DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES = 720;

export interface TerminalWatchCliOptions {
  callbackRoute?: CallbackRouteV1;
  /** Private Host-adapter authority describing how a route template is bound. */
  callbackRouteControllerScope?: "startup_v1" | "route_bound_v1";
  claudeHome?: string;
  hardTimeoutMinutes?: number | string;
  openclawBin?: string;
  openclawSession?: string;
  storeDir?: string;
  terminal?: string;
  watch?: string;
  [option: string]: unknown;
}

type ExactTerminalWatchObservation =
  | {
      state: "available";
      rawTerminal: Record<string, unknown>;
      terminal: Record<string, unknown>;
      summary: Record<string, unknown>;
    }
  | {
      state: "absent";
      reason?: string;
      summary: Record<string, unknown>;
    }
  | {
      state: "unavailable";
      reason?: string;
      summary: Record<string, unknown>;
    };

export interface TerminalWatchCliDependencies {
  acquireFileLock(lockPath: string): () => void;
  acquireTerminalLock(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): () => void;
  observeExactTerminal(request: {
    options: TerminalWatchCliOptions;
    terminalId: string;
  }): Promise<ExactTerminalWatchObservation>;
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
  scanPublicWatchesForExactObservation(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): {
    watches: Array<Record<string, unknown>>;
    activeOverlayTrusted: boolean;
  };
}

export function createTerminalWatchCliAdapter(
  dependencies: TerminalWatchCliDependencies
): TerminalWatchCliFacade {
  const callback = dependencies.callback ??
    createTerminalWatchCallbackCliAdapter();

  function serviceFor(
    options: TerminalWatchCliOptions
  ): TerminalWatchService {
    const explicitRoute = Object.hasOwn(options, "callbackRoute")
      ? parseCallbackRoute(options.callbackRoute)
      : undefined;
    const repository = createTerminalWatchStore(
      dependencies.storeDirFromOptions(options),
      { acquire: dependencies.acquireFileLock }
    );
    return createTerminalWatchService({
      repository,
      now: dependencies.now,
      randomUUID: dependencies.randomUUID,
      observe: (watch) => observeTerminalWatch(watch, options, dependencies),
      resolveCallback: explicitRoute
        ? (watch) => ({
            route: options.callbackRouteControllerScope === "route_bound_v1"
              ? routeBoundWatchCallbackRoute(explicitRoute, watch)
              : explicitRoute
          })
        : resolveTerminalWatchOpenClawCallback,
      resolveCallbackContext: explicitRoute
        ? () => undefined
        : resolveTerminalWatchOpenClawCallbackContext,
      deliver: (input) => {
        if (callback.deliverTransport) {
          return callback.deliverTransport(input);
        }
        const metadata = isRecord(input.envelope.event.metadata)
          ? input.envelope.event.metadata
          : {};
        const agent = metadata.agent;
        if (agent !== "codex" && agent !== "claude") {
          return {
            disposition: "permanent_failure",
            error_code: "terminal_watch_callback_agent_invalid"
          };
        }
        callback.deliver({
          watchId: input.envelope.source.kind === "terminal_watch"
            ? input.envelope.source.watch_id
            : "",
          idempotencyKey: input.envelope.idempotency_key,
          event: input.envelope.event.type as TerminalWatchCallbackEvent,
          agent,
          terminalId: input.envelope.source.kind === "terminal_watch"
            ? input.envelope.source.terminal_id
            : "",
          openclawSession: input.route.controller_session_id,
          openclawBin: typeof input.context?.legacyOptions?.openclawBin ===
              "string"
            ? input.context.legacyOptions.openclawBin
            : undefined,
          detail: typeof metadata.reason_code === "string"
            ? metadata.reason_code
            : undefined,
          completionText: typeof metadata.completion_text === "string"
            ? metadata.completion_text
            : undefined
        });
        return {
          disposition: "accepted",
          accepted_at: dependencies.now().toISOString(),
          acceptance_id: input.envelope.delivery_id
        };
      }
    });
  }

  async function runWatch(options: TerminalWatchCliOptions): Promise<void> {
    const terminalId = requiredString(options.terminal, "--terminal");
    const callbackRoute = Object.hasOwn(options, "callbackRoute")
      ? parseCallbackRoute(options.callbackRoute)
      : undefined;
    const openclawSession = callbackRoute?.controller_session_id ??
      requiredString(options.openclawSession, "--openclaw-session");
    const storeDir = dependencies.storeDirFromOptions(options);
    const initiallyObserved = await exactTerminalForWatch(
      terminalId,
      options,
      dependencies
    );
    const initiallyObservedBindingToken = bindingTokenForWatch(
      initiallyObserved.rawTerminal
    );
    const initialTerminalControl = terminalControlForWatch(
      initiallyObserved.rawTerminal
    );
    const releaseTerminal = dependencies.acquireTerminalLock(
      storeDir,
      initialTerminalControl
    );
    let watch: TerminalWatch;
    try {
      const observed = await exactTerminalForWatch(
        terminalId,
        options,
        dependencies
      );
      const rawTerminal = observed.rawTerminal;
      const projectedTerminal = observed.terminal;
      const expectedBindingToken = bindingTokenForWatch(rawTerminal);
      const terminalControl = terminalControlForWatch(rawTerminal);
      if (!sameTerminalControlEvidenceIncarnation(
        initialTerminalControl,
        terminalControl
      ) || expectedBindingToken !== initiallyObservedBindingToken) {
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
        projectedTerminal,
        terminalId
      );
      const agent = terminalAgent(rawTerminal);
      const anchor = captureTerminalWatchAnchor(
        agent,
        rawTerminal,
        options,
        dependencies
      );
      if (!anchor) {
        throw new Error(
          "the exact terminal has no unique supported human-started active task"
        );
      }
      assertWatchAnchorVersion(anchor, rawTerminal);
      watch = watchService.create({
        agent,
        terminal: terminalWatchIdentity(
          rawTerminal,
          expectedBindingToken
        ),
        anchor,
        ...(callbackRoute === undefined
          ? {}
          : { callback_route: callbackRoute }),
        openclaw_session: openclawSession,
        openclaw_bin: stringValue(options.openclawBin) ?? "openclaw",
        timeout_ms: positiveMinutes(
          options.hardTimeoutMinutes,
          DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES
        ) * 60_000,
        approval_fingerprint: approvalFingerprint(projectedTerminal),
        approval_reason_code: approvalFingerprint(projectedTerminal)
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
    return publicTerminalWatches(service.list(), options);
  }

  function scanPublicWatchesForExactObservation(
    storeDir: string,
    options: { includeAll?: boolean } = {}
  ): {
    watches: Array<Record<string, unknown>>;
    activeOverlayTrusted: boolean;
  } {
    const repository = createTerminalWatchStore(storeDir, {
      acquire: dependencies.acquireFileLock
    });
    const scan = repository.scanForReconciliation();
    return {
      watches: publicTerminalWatches(scan.watches, options),
      activeOverlayTrusted: scan.errors.length === 0
    };
  }

  function publicTerminalWatches(
    watches: readonly TerminalWatch[],
    options: { includeAll?: boolean }
  ): Array<Record<string, unknown>> {
    return watches
      .filter((watch) => options.includeAll || watch.status === "active")
      .map(publicTerminalWatch);
  }

  return Object.freeze({
    runWatch,
    runUnwatch,
    runWatchStatus,
    runReconcileWatches,
    listPublicWatches,
    scanPublicWatchesForExactObservation
  });
}

function assertWatchAnchorVersion(
  anchor: TerminalWatchAnchor,
  terminal: Record<string, unknown>
): void {
  const runningVersion = requiredString(
    terminal.agent_version,
    "running coding-agent version"
  );
  const artifactVersion = anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
    ? anchor.codex_version
    : anchor.claude_version;
  if (artifactVersion !== runningVersion) {
    throw new Error(
      `the active task artifact reports ${artifactVersion}, not the running ` +
      `coding-agent version ${runningVersion}; no Terminal Watch was created`
    );
  }
}

/**
 * A shared native-Host lifecycle owns no single controller session. Bind its
 * trusted Profile template to the exact session captured when this Watch was
 * created; the callback router will still verify Profile identity/revision.
 */
function routeBoundWatchCallbackRoute(
  template: CallbackRouteV1,
  watch: Pick<TerminalWatch, "openclaw_session">
): CallbackRouteV1 {
  return Object.freeze({
    ...template,
    controller_session_id: watch.openclaw_session
  });
}

async function exactTerminalForWatch(
  terminalId: string,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<Extract<ExactTerminalWatchObservation, { state: "available" }>> {
  const observation = await dependencies.observeExactTerminal({
    options,
    terminalId
  });
  if (observation.state === "unavailable") {
    throw new Error(
      "authoritative observation of the exact terminal is temporarily " +
      "unavailable; retry after refreshing AKK list"
    );
  }
  if (observation.state === "absent") {
    throw new Error(`expected exact terminal ${terminalId}; observed none`);
  }
  return observation;
}

function bindingTokenForWatch(
  terminal: Record<string, unknown>
): string {
  return requiredSha256(
    terminal.lifecycle_binding_token,
    "current terminal binding token"
  );
}

function assertExactPublicWatchAction(
  terminal: Record<string, unknown>,
  terminalId: string
): void {
  if (!exactTerminalWatchAction(
    terminal,
    terminalId
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
    return captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity: codexIdentity(terminal),
      now: dependencies.now()
    });
  }
  return captureClaudeHumanStartedActiveTaskAnchor({
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
}

async function observeTerminalWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<TerminalWatchObservation> {
  const observedAt = dependencies.now().toISOString();
  const fence = terminalWatchObservationFence(watch);
  const exactTerminal = await currentTerminalForWatch(
    watch,
    options,
    dependencies
  );
  const rawTerminal = exactTerminal.state === "available"
    ? exactTerminal.rawTerminal
    : undefined;
  const projectedTerminal = exactTerminal.state === "available"
    ? exactTerminal.terminal
    : undefined;
  const terminalMatches = rawTerminal
    ? terminalMatchesWatch(rawTerminal, watch)
    : false;
  const observation =
    watch.anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
    ? observeCodexHumanStartedActiveTask({
        anchor: watch.anchor,
        currentIdentity: rawTerminal
          ? codexIdentity(rawTerminal)
          : codexIdentityForWatch(watch),
        resumeOffsetBytes:
          watch.observation_checkpoint.safe_resume_offset_bytes
      })
    : observeClaudeHumanStartedActiveTask({
        anchor: watch.anchor,
        claudeHome: stringValue(options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(options, { required: true }),
        resumeOffsetBytes:
          watch.observation_checkpoint.safe_resume_offset_bytes,
        checkpoint: claudeObservationCheckpoint(watch)
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
        anchor_fingerprint: watch.anchor.anchor_fingerprint
      }),
      reason_code: completion.outcome === "failure"
        ? "anchored_task_failed"
        : "anchored_task_completed",
      completion_text: completion.text.slice(0, 4000),
      completion_id: completion.id,
      completion_timestamp: completion.timestamp
    };
  }
  if (observation.status === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "provider_observation_unavailable"
    };
  }
  const safeResumeOffsetBytes = observation.safeResumeOffsetBytes;
  const observationCheckpoint = "checkpoint" in observation
    ? observation.checkpoint as TerminalWatchObservationCheckpoint
    : undefined;
  if (exactTerminal.state === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      safe_resume_offset_bytes: safeResumeOffsetBytes,
      observation_checkpoint: observationCheckpoint,
      reason_code: "terminal_observation_unavailable"
    };
  }
  if (rawTerminal && !terminalMatches) {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_identity_changed"
    );
  }
  if (exactTerminal.state === "absent") {
    return invalidatedObservation(
      watch,
      observedAt,
      "terminal_process_unavailable"
    );
  }
  if (!projectedTerminal) {
    throw new Error("exact terminal observation is inconsistent");
  }
  const approval = approvalFingerprint(projectedTerminal);
  if (approval) {
    return {
      ...fence,
      kind: "approval",
      observed_at: observedAt,
      last_activity_at: observedAt,
      safe_resume_offset_bytes: safeResumeOffsetBytes,
      observation_checkpoint: observationCheckpoint,
      evidence_fingerprint: approval,
      reason_code: "terminal_waiting_for_approval"
    };
  }
  return {
    ...fence,
    kind: "pending",
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    observation_checkpoint: observationCheckpoint
  };
}

function claudeObservationCheckpoint(
  watch: TerminalWatch
) {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/claude-human-started-active-task-checkpoint"
  ) {
    throw new Error("Claude terminal Watch has no continuation checkpoint");
  }
  return checkpoint;
}

async function currentTerminalForWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<ExactTerminalWatchObservation> {
  return dependencies.observeExactTerminal({
    options,
    terminalId: watch.terminal.terminal_id
  });
}

function terminalMatchesWatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch
): boolean {
  try {
    const agent = terminalAgent(terminal);
    const current = terminalWatchIdentity(
      terminal,
      bindingTokenForWatch(terminal)
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
  bindingToken: string
): TerminalWatchTerminalIdentity {
  const terminalControl = terminal.terminal_control as TerminalControlRef;
  return {
    terminal_id: requiredString(terminal.id, "terminal id"),
    terminal_endpoint: terminalControlEvidence(terminalControl),
    workspace: terminalWorkspace(terminal),
    binding_token: bindingToken
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
  if (
    watch.agent !== "codex" ||
    watch.anchor.schema !==
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    throw new Error("terminal Watch has no Codex identity");
  }
  return {
    sessionId: watch.anchor.native_thread_id,
    processUuid: watch.anchor.process_uuid,
    processBirth: watch.anchor.process_birth,
    rollout: watch.anchor.rollout
  };
}

function publicTerminalWatch(watch: TerminalWatch): Record<string, unknown> {
  const pending = watch.notification_outbox.filter(({ status }) =>
    status === "pending" || status === "delivering" || status === "failed"
  ).length;
  const compatibilityWarning = watch.agent === "codex" &&
      watch.anchor.schema ===
        "agent-knock-knock/codex-human-started-active-task-anchor"
    ? codexRuntimeCompatibilityProfile(watch.anchor.codex_version)
      ?.compatibilityWarning
    : watch.agent === "claude" &&
        watch.anchor.schema ===
          "agent-knock-knock/claude-human-started-active-task-anchor"
      ? claudeRuntimeCompatibilityWarning(watch.anchor.claude_version)
      : undefined;
  return {
    watch_id: watch.watch_id,
    source: "human_started_terminal_watch",
    agent: watch.agent,
    terminal_id: watch.terminal.terminal_id,
    native_thread_id:
      watch.anchor.schema ===
        "agent-knock-knock/codex-human-started-active-task-anchor"
        ? watch.anchor.native_thread_id
        : watch.anchor.session_id,
    workspace: watch.terminal.workspace,
    status: watch.status,
    activity_state: watch.status === "active" ? "watching" : "settled",
    created_at: watch.created_at,
    deadline_at: watch.deadline_at,
    updated_at: watch.updated_at,
    last_activity_at: watch.last_activity_at,
    ...(compatibilityWarning
      ? { compatibility_warning: compatibilityWarning }
      : {}),
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
      anchor_fingerprint: watch.anchor.anchor_fingerprint
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
    throw new Error(
      `${label} must be exactly 64 lowercase ASCII hexadecimal characters`
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

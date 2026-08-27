import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import {
  callbackRouteForConversation
} from "./callback-route-authority.js";
import {
  parseCallbackRoute,
  type CallbackRouteV1
} from "./callback-transport.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  captureClaudeTranscriptAnchor,
  captureClaudeHumanStartedActiveTaskAnchor,
  observeClaudeUserExplicitFallbackTranscript,
  observeClaudeHumanStartedActiveTask
} from "./claude-local-transcript-provider.js";
import { claudeRuntimeCompatibilityWarning } from
  "./claude-lifecycle-compatibility.js";
import { codexRuntimeCompatibilityProfile } from
  "./codex-lifecycle-compatibility.js";
import type { ExecutorKind } from "./executors.js";
import type {
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest
} from "./terminal-agent-adapter.js";
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
  captureCodexCandidateSetRolloutAcceptanceAnchor,
  captureCodexRolloutAcceptanceAnchor,
  detectCodexBoundRolloutCompletion,
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  captureCodexHumanStartedActiveTaskAnchor,
  observeCodexHumanStartedActiveTask,
  type CodexRolloutAcceptanceIdentity,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import type {
  TerminalControlEvidence,
  TerminalControlRef
} from "./terminal-control-ref.js";
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
  createClaudeUserExplicitFallbackWatchAnchor,
  createCodexUserExplicitFallbackWatchAnchor,
  createTerminalWatchStore,
  isUserExplicitFallbackWatch,
  terminalUserExplicitFallbackWatchId,
  terminalWatchIdentityFingerprint,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type ClaudeUserExplicitFallbackWatchObservationCheckpoint,
  type CodexUserExplicitFallbackWatchObservationCheckpoint,
  type TerminalWatchObservationCheckpoint,
  type TerminalWatchTerminalIdentity,
  type UserExplicitFallbackWatchAnchor
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

export interface UserExplicitFallbackWatchTarget {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
}

export interface PreparedUserExplicitFallbackWatch {
  watchId: string;
  terminalId: string;
  agent: ExecutorKind;
  pid: number;
  terminalEndpoint: TerminalControlEvidence;
  terminalIdentity: TerminalWatchTerminalIdentity;
  physicalToken: string;
  requestHash: string;
  callbackRoute: CallbackRouteV1;
  openclawSession: string;
  openclawBin: string;
  timeoutMs: number;
  anchor: UserExplicitFallbackWatchAnchor;
}

export interface UserExplicitFallbackWatchReceipt {
  callback_expected: true;
  callback_mode: "terminal_watch";
  watch_id: string;
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
  prepareUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    terminal: UserExplicitFallbackWatchTarget;
    requestHash: string;
    messageId: string;
    physicalToken: string;
  }): Promise<PreparedUserExplicitFallbackWatch | undefined>;
  attachUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    prepared: PreparedUserExplicitFallbackWatch;
  }): Promise<UserExplicitFallbackWatchReceipt>;
  userExplicitFallbackWatchReceipt(input: {
    options: TerminalWatchCliOptions;
    watchId: string;
  }): UserExplicitFallbackWatchReceipt | undefined;
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

  async function prepareUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    terminal: UserExplicitFallbackWatchTarget;
    requestHash: string;
    messageId: string;
    physicalToken: string;
  }): Promise<PreparedUserExplicitFallbackWatch | undefined> {
    const callbackRoute = callbackRouteForUserExplicitFallback(input.options);
    if (!callbackRoute) return undefined;
    await bestEffortStabilizePriorFallbackWatch(
      input.options,
      input.terminal.conversationId,
      input.requestHash
    );
    const observed = await exactTerminalForWatch(
      input.terminal.conversationId,
      input.options,
      dependencies
    );
    const rawTerminal = observed.rawTerminal;
    assertSameUserExplicitFallbackTerminal(input.terminal, rawTerminal);
    const agentVersion = requiredString(
      rawTerminal.agent_version,
      "running coding-agent version"
    );
    let anchor: UserExplicitFallbackWatchAnchor;
    if (input.terminal.agent === "codex") {
      const inventory = rawTerminal._codex_open_root_rollout_inventory;
      const acceptanceAnchor = isRecord(inventory)
        ? captureCodexCandidateSetRolloutAcceptanceAnchor({
            inventory: inventory as unknown as CodexOpenRootRolloutInventory,
            now: dependencies.now()
          })
        : captureCodexRolloutAcceptanceAnchor({
            nativeThreadId: requiredString(
              rawTerminal.native_agent_session_id,
              "Codex native thread id"
            ),
            processUuid: requiredString(
              rawTerminal.native_agent_process_uuid,
              "Codex process UUID"
            ),
            processBirth: requiredString(
              rawTerminal.native_agent_process_birth,
              "Codex process birth"
            ),
            mode: "existing",
            rollout: codexIdentity(rawTerminal).rollout!,
            now: dependencies.now()
          });
      anchor = createCodexUserExplicitFallbackWatchAnchor({
        acceptanceAnchor,
        requestHash: input.requestHash,
        codexVersion: agentVersion
      });
    } else {
      const transcriptAnchor = captureClaudeTranscriptAnchor({
        sessionId: requiredString(
          rawTerminal.native_agent_session_id,
          "Claude native session id"
        ),
        cwd: terminalWorkspace(rawTerminal),
        pid: positiveInteger(rawTerminal.pid, "Claude PID"),
        claudeHome: stringValue(input.options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(
          input.options,
          { required: true }
        ),
        now: dependencies.now()
      });
      if (!transcriptAnchor) {
        throw new Error(
          "Claude transcript anchor is unavailable before terminal input"
        );
      }
      anchor = createClaudeUserExplicitFallbackWatchAnchor({
        transcriptAnchor,
        requestHash: input.requestHash,
        claudeVersion: agentVersion
      });
    }
    return {
      watchId: terminalUserExplicitFallbackWatchId({
        messageId: input.messageId,
        physicalToken: input.physicalToken,
        requestHash: input.requestHash
      }),
      terminalId: input.terminal.conversationId,
      agent: input.terminal.agent,
      pid: input.terminal.pid,
      terminalEndpoint: terminalControlEvidence(
        input.terminal.terminalControl
      ),
      terminalIdentity: terminalWatchIdentity(
        rawTerminal,
        input.physicalToken
      ),
      physicalToken: input.physicalToken,
      requestHash: input.requestHash,
      callbackRoute,
      openclawSession: callbackRoute.controller_session_id,
      openclawBin: stringValue(input.options.openclawBin) ?? "openclaw",
      timeoutMs: positiveMinutes(
        input.options.hardTimeoutMinutes ??
          input.options.agentHardTimeoutMinutes,
        DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES
      ) * 60_000,
      anchor
    };
  }

  async function attachUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    prepared: PreparedUserExplicitFallbackWatch;
  }): Promise<UserExplicitFallbackWatchReceipt> {
    let observed: ExactTerminalWatchObservation | undefined;
    try {
      observed = await dependencies.observeExactTerminal({
        options: input.options,
        terminalId: input.prepared.terminalId
      });
    } catch {
      // Observation itself is best effort after the user's physical Send.
      // Persist the exact pre-Send identity and let the durable provider
      // artifact settle or invalidate the Watch.
    }
    if (observed?.state === "available") {
      assertPreparedFallbackTerminal(input.prepared, observed.rawTerminal);
    }
    // An absent or temporarily unavailable terminal after Enter is not a
    // callback veto. The immutable pre-Send provider anchor and terminal
    // identity remain sufficient to recover a completion already on disk.
    const service = serviceFor(input.options);
    let watch: TerminalWatch;
    try {
      watch = service.create({
        watch_id: input.prepared.watchId,
        agent: input.prepared.agent,
        terminal: input.prepared.terminalIdentity,
        anchor: input.prepared.anchor,
        callback_route: input.prepared.callbackRoute,
        openclaw_session: input.prepared.openclawSession,
        openclaw_bin: input.prepared.openclawBin,
        timeout_ms: input.prepared.timeoutMs
      });
    } catch (error) {
      const existing = service.list().find((candidate) =>
        candidate.watch_id === input.prepared.watchId
      );
      if (
        !existing ||
        !isUserExplicitFallbackWatch(existing) ||
        existing.anchor.anchor_fingerprint !==
          input.prepared.anchor.anchor_fingerprint
      ) {
        throw error;
      }
      watch = existing;
    }
    return {
      callback_expected: true,
      callback_mode: "terminal_watch",
      watch_id: watch.watch_id
    };
  }

  async function bestEffortStabilizePriorFallbackWatch(
    options: TerminalWatchCliOptions,
    terminalId: string,
    requestHash: string
  ): Promise<void> {
    try {
      const service = serviceFor(options);
      const prior = service.list().filter((watch) =>
        watch.status === "active" &&
        isUserExplicitFallbackWatch(watch) &&
        watch.terminal.terminal_id === terminalId &&
        watch.anchor.request_hash === requestHash
      );
      for (const watch of prior) {
        try {
          await service.reconcile(watch.watch_id);
        } catch {
          // A prior callback must never delay or veto the new user Send.
        }
      }
    } catch {
      // Store or observer failure is callback-only degradation. The caller
      // still captures the new pre-Send anchor and physical Send proceeds.
    }
  }

  function userExplicitFallbackWatchReceipt(input: {
    options: TerminalWatchCliOptions;
    watchId: string;
  }): UserExplicitFallbackWatchReceipt | undefined {
    try {
      const watch = serviceFor(input.options).get(input.watchId);
      if (!isUserExplicitFallbackWatch(watch) || !watch.callback_route) {
        return undefined;
      }
      return {
        callback_expected: true,
        callback_mode: "terminal_watch",
        watch_id: watch.watch_id
      };
    } catch {
      return undefined;
    }
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
    prepareUserExplicitFallbackWatch,
    attachUserExplicitFallbackWatch,
    userExplicitFallbackWatchReceipt,
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
    : anchor.schema ===
        "agent-knock-knock/claude-human-started-active-task-anchor"
      ? anchor.claude_version
      : undefined;
  if (!artifactVersion) {
    throw new Error("manual Terminal Watch requires a human-started task anchor");
  }
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

function callbackRouteForUserExplicitFallback(
  options: TerminalWatchCliOptions
): CallbackRouteV1 | undefined {
  if (Object.hasOwn(options, "callbackRoute")) {
    return parseCallbackRoute(options.callbackRoute);
  }
  const openclawSession = stringValue(options.openclawSession);
  return callbackRouteForConversation({
    gateway_method: options.gatewayMethod,
    gateway_session: options.gatewaySession ?? openclawSession,
    openclaw_session: openclawSession,
    openclaw_bin: options.openclawBin,
    gateway_url: options.gatewayUrl
  });
}

function assertSameUserExplicitFallbackTerminal(
  expected: UserExplicitFallbackWatchTarget,
  observed: Record<string, unknown>
): void {
  if (
    requiredString(observed.id, "terminal id") !== expected.conversationId ||
    terminalAgent(observed) !== expected.agent ||
    positiveInteger(observed.pid, "terminal PID") !== expected.pid ||
    !isRecord(observed.terminal_control) ||
    !sameTerminalControlEvidenceIncarnation(
      expected.terminalControl,
      observed.terminal_control as unknown as TerminalControlRef
    )
  ) {
    throw new Error(
      "terminal changed before the user-explicit fallback Watch anchor was captured"
    );
  }
}

function assertPreparedFallbackTerminal(
  prepared: PreparedUserExplicitFallbackWatch,
  observed: Record<string, unknown>
): void {
  if (
    requiredString(observed.id, "terminal id") !== prepared.terminalId ||
    terminalAgent(observed) !== prepared.agent ||
    positiveInteger(observed.pid, "terminal PID") !== prepared.pid ||
    !isRecord(observed.terminal_control) ||
    !sameTerminalControlEvidenceIncarnation(
      prepared.terminalEndpoint,
      observed.terminal_control as unknown as TerminalControlRef
    )
  ) {
    throw new Error(
      "terminal changed before the user-explicit fallback Watch was attached"
    );
  }
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
    ? isUserExplicitFallbackWatch(watch)
      ? terminalMatchesUserExplicitFallbackWatch(rawTerminal, watch)
      : terminalMatchesWatch(rawTerminal, watch)
    : false;
  if (isUserExplicitFallbackWatch(watch)) {
    return observeUserExplicitFallbackTerminalWatch({
      watch,
      exactTerminal,
      rawTerminal,
      projectedTerminal,
      terminalMatches,
      observedAt,
      options,
      dependencies
    });
  }
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
    : watch.anchor.schema ===
        "agent-knock-knock/claude-human-started-active-task-anchor"
      ? observeClaudeHumanStartedActiveTask({
        anchor: watch.anchor,
        claudeHome: stringValue(options.claudeHome),
        agentRows: dependencies.loadClaudeAgentRows(options, { required: true }),
        resumeOffsetBytes:
          watch.observation_checkpoint.safe_resume_offset_bytes,
        checkpoint: claudeObservationCheckpoint(watch)
      })
      : (() => {
          throw new Error("terminal Watch anchor is unsupported");
        })();
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

async function observeUserExplicitFallbackTerminalWatch(input: {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  projectedTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  options: TerminalWatchCliOptions;
  dependencies: TerminalWatchCliDependencies;
}): Promise<TerminalWatchObservation> {
  const {
    watch,
    exactTerminal,
    rawTerminal,
    terminalMatches,
    observedAt,
    options,
    dependencies
  } = input;
  const fence = terminalWatchObservationFence(watch);

  if (
    watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    const anchor = watch.anchor.acceptance_anchor;
    const persistedCheckpoint = codexFallbackObservationCheckpoint(watch);
    let acceptance: TerminalSubmissionAcceptanceEvidence | undefined;
    let currentIdentity: CodexRolloutAcceptanceIdentity;
    let acceptedCheckpoint:
      CodexUserExplicitFallbackWatchObservationCheckpoint | undefined;
    if (
      persistedCheckpoint.acceptance_evidence &&
      persistedCheckpoint.accepted_identity
    ) {
      acceptance = persistedCheckpoint.acceptance_evidence;
      currentIdentity = {
        sessionId: persistedCheckpoint.accepted_identity.native_thread_id,
        processUuid: persistedCheckpoint.accepted_identity.process_uuid,
        processBirth: persistedCheckpoint.accepted_identity.process_birth,
        rollout: persistedCheckpoint.accepted_identity.rollout
      };
      acceptedCheckpoint = persistedCheckpoint;
    } else if (anchor.version === 3) {
      const inventory = rawTerminal?._codex_open_root_rollout_inventory;
      if (!isRecord(inventory)) {
        return fallbackPendingOrTerminalObservation({
          watch,
          exactTerminal,
          rawTerminal,
          terminalMatches,
          observedAt,
          reasonCode: "codex_rollout_inventory_unavailable"
        });
      }
      const result = detectCodexCandidateSetRolloutAcceptance({
        anchor,
        currentInventory:
          inventory as unknown as CodexOpenRootRolloutInventory,
        requestHash: watch.anchor.request_hash
      });
      if (result.status === "uncertain") {
        if (result.code === "candidate_scan_invalid") {
          return {
            ...fence,
            kind: "unavailable",
            observed_at: observedAt,
            reason_code: "native_acceptance_scan_unavailable"
          };
        }
        return invalidatedObservation(
          watch,
          observedAt,
          `native_acceptance_${result.code}`
        );
      }
      if (result.status === "pending") {
        return fallbackPendingOrTerminalObservation({
          watch,
          exactTerminal,
          rawTerminal,
          terminalMatches,
          observedAt
        });
      }
      acceptance = result.evidence;
      currentIdentity = result.identity;
      acceptedCheckpoint = codexFallbackAcceptedCheckpoint(
        watch,
        acceptance,
        currentIdentity
      );
    } else {
      try {
        currentIdentity = anchor.version === 1
          ? {
              sessionId: anchor.native_thread_id,
              processUuid: anchor.process_uuid,
              processBirth: anchor.process_birth,
              rollout: anchor.rollout
            }
          : rawTerminal
            ? codexIdentity(rawTerminal)
            : (() => {
                throw new Error(
                  "Codex pre-materialization identity is unavailable"
                );
              })();
        acceptance = detectCodexRolloutAcceptance({
          anchor,
          currentIdentity,
          requestHash: watch.anchor.request_hash
        });
      } catch (error) {
        if (retryableProviderError(error)) {
          return {
            ...fence,
            kind: "unavailable",
            observed_at: observedAt,
            reason_code: "native_acceptance_scan_unavailable"
          };
        }
        return invalidatedObservation(
          watch,
          observedAt,
          "native_acceptance_identity_changed"
        );
      }
      if (!acceptance) {
        return fallbackPendingOrTerminalObservation({
          watch,
          exactTerminal,
          rawTerminal,
          terminalMatches,
          observedAt
        });
      }
      acceptedCheckpoint = codexFallbackAcceptedCheckpoint(
        watch,
        acceptance,
        currentIdentity
      );
    }
    if (!acceptance || !acceptedCheckpoint) {
      throw new Error("Codex fallback Watch acceptance checkpoint is incomplete");
    }

    const completion = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence: acceptance,
      currentIdentity,
      requestHash: watch.anchor.request_hash
    });
    if (completion.status === "completed") {
      return fallbackCompletionObservation(
        watch,
        observedAt,
        completion.completion,
        completion.diagnostics.observed_end_offset_bytes,
        codexFallbackAcceptedCheckpoint(
          watch,
          acceptance,
          currentIdentity
        )
      );
    }
    if (completion.status === "failure") {
      if (completion.diagnostics.code === "rollout_unreadable") {
        return {
          ...fence,
          kind: "unavailable",
          observed_at: observedAt,
          safe_resume_offset_bytes:
            acceptedCheckpoint.safe_resume_offset_bytes,
          observation_checkpoint: acceptedCheckpoint,
          reason_code: "accepted_rollout_unavailable"
        };
      }
      return invalidatedObservation(
        watch,
        observedAt,
        `native_completion_${completion.diagnostics.code}`
      );
    }
    return fallbackPendingOrTerminalObservation({
      watch,
      exactTerminal,
      rawTerminal,
      terminalMatches,
      observedAt,
      observedEndOffsetBytes:
        completion.diagnostics.observed_end_offset_bytes,
      observationCheckpoint: codexFallbackAcceptedCheckpoint(
        watch,
        acceptance,
        currentIdentity
      )
    });
  }

  if (
    watch.anchor.schema !==
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    throw new Error("user-explicit fallback Watch anchor is unsupported");
  }
  const request: TerminalDurableCompletionRequest = {
    sessionId: watch.anchor.transcript_anchor.session_id,
    cwd: watch.anchor.transcript_anchor.cwd,
    requestHash: watch.anchor.request_hash,
    startedAt: watch.anchor.captured_at,
    context: {
      claudeTranscriptAnchor: watch.anchor.transcript_anchor,
      pid: watch.anchor.transcript_anchor.pid
    }
  };
  const persistedCheckpoint = claudeFallbackObservationCheckpoint(watch);
  const observation = observeClaudeUserExplicitFallbackTranscript(
    request,
    {
      claudeHome: stringValue(options.claudeHome),
      // This observer is transcript-authoritative by design. Completion must
      // remain recoverable after the exact pane/process leaves discovery.
      acceptanceEvidence: persistedCheckpoint.acceptance_evidence
    }
  );
  if (observation.status === "unavailable") {
    return {
      ...fence,
      kind: "unavailable",
      observed_at: observedAt,
      reason_code: "native_acceptance_scan_unavailable"
    };
  }
  const acceptance = observation.acceptance;
  if (!acceptance) {
    return fallbackPendingOrTerminalObservation({
      watch,
      exactTerminal,
      rawTerminal,
      terminalMatches,
      observedAt
    });
  }
  const acceptedCheckpoint = claudeFallbackAcceptedCheckpoint(
    watch,
    acceptance
  );
  if (observation.status === "completed") {
    return fallbackCompletionObservation(
      watch,
      observedAt,
      observation.completion,
      observation.observedEndOffsetBytes,
      acceptedCheckpoint
    );
  }
  return fallbackPendingOrTerminalObservation({
    watch,
    exactTerminal,
    rawTerminal,
    terminalMatches,
    observedAt,
    observedEndOffsetBytes: observation.observedEndOffsetBytes,
    observationCheckpoint: acceptedCheckpoint
  });
}

function fallbackPendingOrTerminalObservation(input: {
  watch: TerminalWatch;
  exactTerminal: ExactTerminalWatchObservation;
  rawTerminal?: Record<string, unknown>;
  terminalMatches: boolean;
  observedAt: string;
  observedEndOffsetBytes?: number;
  observationCheckpoint?: TerminalWatchObservationCheckpoint;
  reasonCode?: string;
}): TerminalWatchObservation {
  if (input.exactTerminal.state === "unavailable") {
    return {
      ...terminalWatchObservationFence(input.watch),
      kind: "unavailable",
      observed_at: input.observedAt,
      reason_code: input.reasonCode ?? "terminal_observation_unavailable"
    };
  }
  if (input.exactTerminal.state === "absent" || !input.rawTerminal) {
    return invalidatedObservation(
      input.watch,
      input.observedAt,
      "terminal_process_unavailable"
    );
  }
  if (!input.terminalMatches) {
    return invalidatedObservation(
      input.watch,
      input.observedAt,
      "terminal_identity_changed"
    );
  }
  if (input.reasonCode) {
    return {
      ...terminalWatchObservationFence(input.watch),
      kind: "unavailable",
      observed_at: input.observedAt,
      reason_code: input.reasonCode
    };
  }
  return fallbackPendingObservation(
    input.watch,
    input.observedAt,
    input.observedEndOffsetBytes,
    input.observationCheckpoint
  );
}

function fallbackPendingObservation(
  watch: TerminalWatch,
  observedAt: string,
  observedEndOffsetBytes?: number,
  observationCheckpoint?: TerminalWatchObservationCheckpoint
): TerminalWatchObservation {
  const effectiveCheckpoint = observationCheckpoint ?? (
    watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
      ? watch.observation_checkpoint
      : undefined
  );
  const safeResumeOffsetBytes = effectiveCheckpoint
    ?.safe_resume_offset_bytes ?? fallbackResumeOffset(
      watch,
      observedEndOffsetBytes
    );
  return {
    ...terminalWatchObservationFence(watch),
    kind: "pending",
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    ...(effectiveCheckpoint
      ? { observation_checkpoint: effectiveCheckpoint }
      : {})
  };
}

function codexFallbackObservationCheckpoint(
  watch: TerminalWatch
): CodexUserExplicitFallbackWatchObservationCheckpoint {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
  ) {
    throw new Error("Codex fallback Watch has no exact acceptance checkpoint");
  }
  return checkpoint;
}

function claudeFallbackObservationCheckpoint(
  watch: TerminalWatch
): ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  const checkpoint = watch.observation_checkpoint;
  if (
    !("schema" in checkpoint) ||
    checkpoint.schema !==
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint"
  ) {
    throw new Error("Claude fallback Watch has no exact acceptance checkpoint");
  }
  return checkpoint;
}

function codexFallbackAcceptedCheckpoint(
  watch: TerminalWatch,
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence,
  currentIdentity: CodexRolloutAcceptanceIdentity
): CodexUserExplicitFallbackWatchObservationCheckpoint {
  const nativeThreadId = requiredString(
    currentIdentity.sessionId,
    "accepted Codex native thread id"
  );
  const processUuid = requiredString(
    currentIdentity.processUuid,
    "accepted Codex process UUID"
  );
  const processBirth = requiredString(
    currentIdentity.processBirth,
    "accepted Codex process birth"
  );
  const rollout = currentIdentity.rollout;
  if (!rollout) {
    throw new Error("accepted Codex rollout identity is unavailable");
  }
  const acceptanceOffset = numericMetadata(
    acceptanceEvidence.metadata,
    "observed_end_offset_bytes"
  );
  if (acceptanceOffset === undefined) {
    throw new Error("accepted Codex rollout boundary is unavailable");
  }
  return {
    schema:
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint",
    version: 1,
    safe_resume_offset_bytes: fallbackResumeOffset(
      watch,
      acceptanceOffset
    ),
    acceptance_evidence: acceptanceEvidence,
    accepted_identity: {
      native_thread_id: nativeThreadId,
      process_uuid: processUuid,
      process_birth: processBirth,
      rollout
    }
  };
}

function claudeFallbackAcceptedCheckpoint(
  watch: TerminalWatch,
  acceptanceEvidence: TerminalSubmissionAcceptanceEvidence
): ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  const acceptanceOffset = numericMetadata(
    acceptanceEvidence.metadata,
    "observed_end_offset_bytes"
  );
  if (acceptanceOffset === undefined) {
    throw new Error("accepted Claude transcript boundary is unavailable");
  }
  const promptUuid = requiredString(
    acceptanceEvidence.acceptanceId,
    "accepted Claude prompt UUID"
  );
  return {
    schema:
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint",
    version: 1,
    safe_resume_offset_bytes: fallbackResumeOffset(
      watch,
      acceptanceOffset
    ),
    acceptance_evidence: acceptanceEvidence,
    accepted_prompt_uuid: promptUuid
  };
}

function fallbackCompletionObservation(
  watch: TerminalWatch,
  observedAt: string,
  completion: TerminalCompletionEvidence,
  observedEndOffsetBytes?: number,
  observationCheckpoint?: TerminalWatchObservationCheckpoint
): TerminalWatchObservation {
  const safeResumeOffsetBytes = observationCheckpoint
    ?.safe_resume_offset_bytes ?? fallbackResumeOffset(
      watch,
      observedEndOffsetBytes
    );
  const kind = completion.outcome === "failure" ? "failed" : "completed";
  return {
    ...terminalWatchObservationFence(watch),
    kind,
    observed_at: observedAt,
    safe_resume_offset_bytes: safeResumeOffsetBytes,
    ...(observationCheckpoint
      ? { observation_checkpoint: observationCheckpoint }
      : {}),
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

function fallbackResumeOffset(
  watch: TerminalWatch,
  observedEndOffsetBytes?: number
): number {
  return Math.max(
    watch.observation_checkpoint.safe_resume_offset_bytes,
    Number.isSafeInteger(observedEndOffsetBytes) &&
        Number(observedEndOffsetBytes) >= 0
      ? Number(observedEndOffsetBytes)
      : 0
  );
}

function numericMetadata(
  metadata: Record<string, unknown> | undefined,
  field: string
): number | undefined {
  const value = metadata?.[field];
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function retryableProviderError(error: unknown): boolean {
  return isRecord(error) && typeof error.code === "string" && new Set([
    "EACCES", "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT",
    "EPERM", "ESTALE", "ETIMEDOUT"
  ]).has(error.code);
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

function terminalMatchesUserExplicitFallbackWatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch
): boolean {
  try {
    if (
      !isUserExplicitFallbackWatch(watch) ||
      terminalAgent(terminal) !== watch.agent ||
      requiredString(terminal.id, "terminal id") !==
        watch.terminal.terminal_id ||
      terminalWorkspace(terminal) !== watch.terminal.workspace ||
      !isRecord(terminal.terminal_control) ||
      !sameTerminalControlEvidenceIncarnation(
        terminal.terminal_control as unknown as TerminalControlRef,
        watch.terminal.terminal_endpoint
      )
    ) {
      return false;
    }
    if (
      watch.anchor.schema ===
        "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
    ) {
      return requiredString(
        terminal.native_agent_process_uuid,
        "Codex process UUID"
      ) === watch.anchor.acceptance_anchor.process_uuid &&
        requiredString(
          terminal.native_agent_process_birth,
          "Codex process birth"
        ) === watch.anchor.acceptance_anchor.process_birth;
    }
    return watch.anchor.schema ===
        "agent-knock-knock/claude-user-explicit-fallback-watch-anchor" &&
      positiveInteger(terminal.pid, "Claude PID") ===
        watch.anchor.transcript_anchor.pid;
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
      (watch.anchor.schema ===
        "agent-knock-knock/codex-human-started-active-task-anchor" ||
        watch.anchor.schema ===
          "agent-knock-knock/codex-user-explicit-fallback-watch-anchor")
    ? codexRuntimeCompatibilityProfile(watch.anchor.codex_version)
      ?.compatibilityWarning
    : watch.agent === "claude" &&
        (watch.anchor.schema ===
          "agent-knock-knock/claude-human-started-active-task-anchor" ||
          watch.anchor.schema ===
            "agent-knock-knock/claude-user-explicit-fallback-watch-anchor")
      ? claudeRuntimeCompatibilityWarning(watch.anchor.claude_version)
      : undefined;
  const userExplicitFallback = isUserExplicitFallbackWatch(watch);
  return {
    watch_id: watch.watch_id,
    source: userExplicitFallback
      ? "terminal_user_explicit_fallback_watch"
      : "human_started_terminal_watch",
    agent: watch.agent,
    terminal_id: watch.terminal.terminal_id,
    native_thread_id: terminalWatchNativeThreadId(watch),
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

function terminalWatchNativeThreadId(
  watch: TerminalWatch
): string | undefined {
  switch (watch.anchor.schema) {
    case "agent-knock-knock/codex-human-started-active-task-anchor":
      return watch.anchor.native_thread_id;
    case "agent-knock-knock/claude-human-started-active-task-anchor":
      return watch.anchor.session_id;
    case "agent-knock-knock/codex-user-explicit-fallback-watch-anchor":
      return watch.anchor.acceptance_anchor.version === 1
        ? watch.anchor.acceptance_anchor.native_thread_id
        : undefined;
    case "agent-knock-knock/claude-user-explicit-fallback-watch-anchor":
      return watch.anchor.transcript_anchor.session_id;
  }
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

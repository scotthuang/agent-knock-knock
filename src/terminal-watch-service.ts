import { createHash } from "node:crypto";
import {
  parseCallbackAttemptOutcome,
  parseCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackEnvelopeV1,
  type CallbackRouteV1,
  type CallbackTransportContextV1,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";
import {
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  assertTerminalWatch,
  initialTerminalWatchObservationCheckpoint,
  terminalWatchIdentityFingerprint,
  terminalWatchCallbackEnvelope,
  terminalWatchNotificationCallbackSnapshot,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchRevision,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchCallbackEvent,
  type TerminalWatchCallbackMessageInput,
  type TerminalWatchNotification,
  type TerminalWatchNotificationKind,
  type TerminalWatchObservationCheckpoint,
  type TerminalWatchStatus,
  type TerminalWatchStore,
  type TerminalWatchTerminalIdentity,
  type TerminalWatchTerminalStatus
} from "./terminal-watch-store.js";
import type { ExecutorKind } from "./executors.js";

export {
  terminalWatchCallbackEnvelope,
  terminalWatchCallbackMessage
} from "./terminal-watch-store.js";
export type {
  TerminalWatchCallbackEvent,
  TerminalWatchCallbackMessageInput
} from "./terminal-watch-store.js";

const DEFAULT_NOTIFICATION_LEASE_MS = 30_000;
const DEFAULT_NOTIFICATION_RETRY_DELAY_MS = 5_000;
const DEFAULT_NOTIFICATION_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_RECONCILIATION_DELIVERY_LIMIT = 1;

export interface CreateTerminalWatchInput {
  watch_id?: string;
  agent: ExecutorKind;
  terminal: TerminalWatchTerminalIdentity;
  anchor: TerminalWatchAnchor;
  /**
   * Immutable Host callback authority captured when the Watch is created.
   * Legacy OpenClaw Watches omit this and retain their existing lazy resolver.
   */
  callback_route?: CallbackRouteV1;
  openclaw_session: string;
  openclaw_bin: string;
  timeout_ms: number;
  last_activity_at?: string;
  approval_fingerprint?: string;
  approval_reason_code?: string;
}

export interface TerminalWatchObservationFence {
  watch_id: string;
  terminal_identity_fingerprint: string;
  anchor_fingerprint: string;
}

interface TerminalWatchObservationBase extends TerminalWatchObservationFence {
  observed_at: string;
  last_activity_at?: string;
  safe_resume_offset_bytes?: number;
  observation_checkpoint?: TerminalWatchObservationCheckpoint;
}

export type TerminalWatchObservation =
  | (TerminalWatchObservationBase & { kind: "pending" })
  | (TerminalWatchObservationBase & {
      kind: "unavailable";
      reason_code?: string;
    })
  | (TerminalWatchObservationBase & {
      kind: "approval";
      evidence_fingerprint: string;
      reason_code?: string;
    })
  | (TerminalWatchObservationBase & {
      kind: "completed" | "failed";
      evidence_fingerprint: string;
      reason_code?: string;
      completion_text?: string;
      completion_id?: string;
      completion_timestamp?: string;
    })
  | (TerminalWatchObservationBase & {
      kind: "invalidated";
      evidence_fingerprint: string;
      reason_code?: string;
    });

export interface TerminalWatchCallbackResolution {
  route: CallbackRouteV1;
  context?: CallbackTransportContextV1;
}

export type TerminalWatchDeliveryInput = CallbackTransportDeliverInput;

export interface TerminalWatchServiceDependencies {
  repository: TerminalWatchStore;
  now(): Date;
  randomUUID(): string;
  observe(watch: TerminalWatch): Promise<TerminalWatchObservation>;
  resolveCallback(watch: TerminalWatch): TerminalWatchCallbackResolution;
  resolveCallbackContext?(
    watch: TerminalWatch,
    route: CallbackRouteV1
  ): CallbackTransportContextV1 | undefined;
  deliver(
    input: TerminalWatchDeliveryInput
  ): Promise<CallbackAttemptOutcome> | CallbackAttemptOutcome;
  notificationLeaseMs?: number;
  notificationRetryDelayMs?: number | ((attempt: number) => number);
  notificationMaxRetryDelayMs?: number;
  reconciliationDeliveryLimit?: number;
  classifyDeliveryError?(error: unknown): string;
}

export interface TerminalWatchReconciliationItem {
  watch_id: string;
  status: TerminalWatchStatus | "error";
  changed: boolean;
  callbacks_delivered: number;
  error_code?: string;
}

export interface TerminalWatchReconciliationSummary {
  checked: number;
  changed: number;
  callbacks_delivered: number;
  errors: number;
  items: TerminalWatchReconciliationItem[];
}

export interface TerminalWatchService {
  create(input: CreateTerminalWatchInput): TerminalWatch;
  cancel(watchId: string): TerminalWatch;
  get(watchId: string): TerminalWatch;
  list(): TerminalWatch[];
  reconcile(watchId: string): Promise<TerminalWatch>;
  reconcileAll(): Promise<TerminalWatchReconciliationSummary>;
}

export class ActiveTerminalWatchConflictError extends Error {
  readonly code = "AKK_ACTIVE_TERMINAL_WATCH_CONFLICT";
  readonly existingWatchId: string;

  constructor(existingWatchId: string) {
    super(
      `exact terminal/native task already has active Watch ${existingWatchId}`
    );
    this.name = "ActiveTerminalWatchConflictError";
    this.existingWatchId = existingWatchId;
  }
}

/**
 * Create the durable Watch application service. Terminal observation and
 * callback transport are the only effects; the API intentionally has no port
 * capable of writing to, approving, cancelling, or taking ownership of a TUI.
 */
export function createTerminalWatchService(
  dependencies: TerminalWatchServiceDependencies
): TerminalWatchService {
  const {
    notificationLeaseMs,
    reconciliationDeliveryLimit,
    retryDelay
  } =
    terminalWatchNotificationDeliveryPolicy(dependencies);
  const deliverNextNotification = createTerminalWatchNotificationDelivery({
    dependencies,
    notificationLeaseMs,
    retryDelay
  });

  function create(input: CreateTerminalWatchInput): TerminalWatch {
    const createdAt = canonicalNow(dependencies.now());
    const watchId = input.watch_id ??
      `terminal-watch-${dependencies.randomUUID()}`;
    const timeoutMs = positiveMilliseconds(
      input.timeout_ms,
      undefined,
      "terminal Watch timeout"
    );
    let candidate: TerminalWatch = {
      schema: TERMINAL_WATCH_SCHEMA,
      version: TERMINAL_WATCH_VERSION,
      watch_id: watchId,
      agent: input.agent,
      terminal: input.terminal,
      anchor: input.anchor,
      observation_checkpoint:
        initialTerminalWatchObservationCheckpoint(input.anchor),
      ...(input.callback_route === undefined
        ? {}
        : { callback_route: parseCallbackRoute(input.callback_route) }),
      openclaw_session: input.openclaw_session,
      openclaw_bin: input.openclaw_bin,
      created_at: createdAt,
      deadline_at: new Date(Date.parse(createdAt) + timeoutMs).toISOString(),
      updated_at: createdAt,
      status: "active",
      last_activity_at: input.last_activity_at ?? createdAt,
      notification_outbox: []
    };
    if (input.approval_fingerprint !== undefined) {
      candidate = withApprovalNotification(candidate, {
        evidenceFingerprint: input.approval_fingerprint,
        reasonCode: input.approval_reason_code,
        createdAt
      });
    }
    assertTerminalWatch(candidate, watchId, { allowMissingRevision: true });
    return dependencies.repository.withWatchLock(watchId, () => {
      const identity = terminalWatchIdentityFingerprint(candidate);
      const existing = dependencies.repository.list().find((watch) =>
        watch.status === "active" &&
        terminalWatchIdentityFingerprint(watch) === identity
      );
      if (existing) {
        throw new ActiveTerminalWatchConflictError(existing.watch_id);
      }
      return dependencies.repository.save(candidate, { expectedRevision: null });
    });
  }

  function cancel(watchId: string): TerminalWatch {
    return dependencies.repository.withWatchLock(watchId, () => {
      const current = dependencies.repository.load(watchId);
      if (current.status !== "active") {
        return current;
      }
      const now = canonicalNow(dependencies.now());
      const fingerprint = deterministicEvidenceFingerprint({
        version: 1,
        watch_id: current.watch_id,
        kind: "cancelled",
        anchor_fingerprint: current.anchor.anchor_fingerprint
      });
      return saveSettlement(current, {
        kind: "cancelled",
        evidenceFingerprint: fingerprint,
        observedAt: now,
        reasonCode: "manual_cancel",
        updatedAt: now
      });
    });
  }

  async function reconcile(watchId: string): Promise<TerminalWatch> {
    const listed = dependencies.repository.load(watchId);
    if (listed.status !== "active") {
      return listed;
    }
    if (isDeadlineElapsed(listed, dependencies.now())) {
      return settleTimeout(watchId);
    }
    const observation = await dependencies.observe(listed);
    return dependencies.repository.withWatchLock(watchId, () => {
      const current = dependencies.repository.load(watchId);
      if (current.status !== "active") {
        return current;
      }
      const now = canonicalNow(dependencies.now());
      if (Date.parse(now) >= Date.parse(current.deadline_at)) {
        return saveTimeout(current, now);
      }
      assertObservationForWatch(observation, current, now);
      return applyObservation(current, observation, now);
    });
  }

  function settleTimeout(watchId: string): TerminalWatch {
    return dependencies.repository.withWatchLock(watchId, () => {
      const current = dependencies.repository.load(watchId);
      if (current.status !== "active") {
        return current;
      }
      const now = canonicalNow(dependencies.now());
      if (Date.parse(now) < Date.parse(current.deadline_at)) {
        return current;
      }
      return saveTimeout(current, now);
    });
  }

  function saveTimeout(current: TerminalWatch, now: string): TerminalWatch {
    const fingerprint = deterministicEvidenceFingerprint({
      version: 1,
      watch_id: current.watch_id,
      kind: "timed_out",
      deadline_at: current.deadline_at,
      anchor_fingerprint: current.anchor.anchor_fingerprint
    });
    return saveSettlement(current, {
      kind: "timed_out",
      evidenceFingerprint: fingerprint,
      observedAt: now,
      reasonCode: "deadline_elapsed",
      updatedAt: now
    });
  }

  function applyObservation(
    current: TerminalWatch,
    observation: TerminalWatchObservation,
    now: string
  ): TerminalWatch {
    const checkpoint = nextObservationCheckpoint(current, observation);
    const checkpointAdvanced = checkpoint.safe_resume_offset_bytes >
      current.observation_checkpoint.safe_resume_offset_bytes;
    const activityAt = latestActivityAt(
      current.last_activity_at,
      checkpointAdvanced
        ? observation.last_activity_at ?? observation.observed_at
        : observation.last_activity_at
    );
    if (observation.kind === "unavailable") {
      if (!checkpointAdvanced) return current;
      return dependencies.repository.save({
        ...current,
        observation_checkpoint: checkpoint,
        last_activity_at: activityAt,
        updated_at: now
      }, { expectedRevision: terminalWatchRevision(current) });
    }
    if (observation.kind === "pending") {
      if (
        activityAt === current.last_activity_at &&
        !checkpointAdvanced
      ) {
        return current;
      }
      return dependencies.repository.save({
        ...current,
        observation_checkpoint: checkpoint,
        last_activity_at: activityAt,
        updated_at: now
      }, { expectedRevision: terminalWatchRevision(current) });
    }
    if (observation.kind === "approval") {
      const duplicate = current.notification_outbox.some((notification) =>
        notification.kind === "approval" &&
        notification.evidence_fingerprint === observation.evidence_fingerprint
      );
      if (duplicate) {
        if (
          activityAt === current.last_activity_at &&
          !checkpointAdvanced
        ) {
          return current;
        }
        return dependencies.repository.save({
          ...current,
          observation_checkpoint: checkpoint,
          last_activity_at: activityAt,
          updated_at: now
        }, { expectedRevision: terminalWatchRevision(current) });
      }
      const next = withApprovalNotification({
        ...current,
        observation_checkpoint: checkpoint,
        last_activity_at: activityAt,
        updated_at: now
      }, {
        evidenceFingerprint: observation.evidence_fingerprint,
        reasonCode: observation.reason_code,
        createdAt: now
      });
      return dependencies.repository.save(
        next,
        { expectedRevision: terminalWatchRevision(current) }
      );
    }
    return saveSettlement(current, {
      kind: observation.kind,
      evidenceFingerprint: observation.evidence_fingerprint,
      observedAt: observation.observed_at,
      reasonCode: observation.reason_code,
      updatedAt: now,
      observationCheckpoint: checkpoint,
      lastActivityAt: activityAt,
      completionText: observation.kind === "completed" ||
          observation.kind === "failed"
        ? observation.completion_text
        : undefined,
      completionId: observation.kind === "completed" ||
          observation.kind === "failed"
        ? observation.completion_id
        : undefined,
      completionTimestamp: observation.kind === "completed" ||
          observation.kind === "failed"
        ? observation.completion_timestamp
        : undefined
    });
  }

  function saveSettlement(
    current: TerminalWatch,
    input: {
      kind: TerminalWatchTerminalStatus;
      evidenceFingerprint: string;
      observedAt: string;
      reasonCode?: string;
      updatedAt: string;
      observationCheckpoint?: TerminalWatchObservationCheckpoint;
      lastActivityAt?: string;
      completionText?: string;
      completionId?: string;
      completionTimestamp?: string;
    }
  ): TerminalWatch {
    const notification = pendingNotification(
      current.watch_id,
      input.kind,
      input.evidenceFingerprint,
      input.updatedAt,
      input.reasonCode
    );
    const candidate: TerminalWatch = {
      ...current,
      status: input.kind,
      updated_at: input.updatedAt,
      observation_checkpoint:
        input.observationCheckpoint ?? current.observation_checkpoint,
      last_activity_at: input.lastActivityAt ?? current.last_activity_at,
      settlement: {
        kind: input.kind,
        evidence_fingerprint: input.evidenceFingerprint,
        observed_at: input.observedAt,
        reason_code: input.reasonCode,
        completion_text: input.completionText,
        completion_id: input.completionId,
        completion_timestamp: input.completionTimestamp
      },
      notification_outbox: [
        ...supersedeUndeliveredApprovals(current.notification_outbox, input.updatedAt),
        notification
      ]
    };
    return dependencies.repository.save(
      candidate,
      { expectedRevision: terminalWatchRevision(current) }
    );
  }

  async function reconcileAll(): Promise<TerminalWatchReconciliationSummary> {
    return reconcileAllTerminalWatches({
      dependencies,
      reconciliationDeliveryLimit,
      reconcile,
      deliverNextNotification
    });
  }

  return Object.freeze({
    create,
    cancel,
    get: (watchId: string) => dependencies.repository.load(watchId),
    list: () => dependencies.repository.list(),
    reconcile,
    reconcileAll
  });
}

function createTerminalWatchNotificationDelivery(input: {
  dependencies: TerminalWatchServiceDependencies;
  notificationLeaseMs: number;
  retryDelay(attempt: number): number;
}) {
  const { dependencies, notificationLeaseMs, retryDelay } = input;

  function claimNextNotification(
    watchId: string
  ) {
    return dependencies.repository.withWatchLock(watchId, () => {
      let current = dependencies.repository.load(watchId);
      const now = canonicalNow(dependencies.now());
      let index = firstUnresolvedNotificationIndex(current);
      const first = current.notification_outbox[index];
      if (
        current.status !== "active" &&
        first?.kind === "approval" &&
        notificationIsClaimable(first, now)
      ) {
        current = dependencies.repository.save({
          ...current,
          updated_at: now,
          notification_outbox: replaceAt(
            current.notification_outbox,
            index,
            supersededApprovalNotification(first, now)
          )
        }, { expectedRevision: terminalWatchRevision(current) });
        index = firstUnresolvedNotificationIndex(current);
      }
      if (
        index < 0 ||
        !notificationIsClaimable(current.notification_outbox[index], now)
      ) {
        return { watch: current };
      }
      const selected = current.notification_outbox[index];
      let snapshotted = selected;
      let snapshotErrorCode: string | undefined;
      if (!terminalWatchNotificationCallbackSnapshot(current, selected)) {
        let callback: TerminalWatchCallbackResolution | undefined;
        try {
          callback = current.callback_route
            ? { route: current.callback_route }
            : dependencies.resolveCallback(current);
        } catch {
          snapshotErrorCode = "callback_route_resolution_failed";
        }
        if (callback) {
          try {
            const route = parseCallbackRoute(callback.route);
            snapshotted = {
              ...selected,
              callback_route: route,
              callback_envelope: terminalWatchCallbackEnvelope(
                current,
                selected,
                route
              )
            };
          } catch {
            snapshotErrorCode = "callback_request_construction_failed";
          }
        }
      }
      const attemptId = dependencies.randomUUID();
      const claimed = withNotificationReceipt(snapshotted, {
        status: "delivering",
        attempts: selected.attempts + 1,
        last_attempt_at: now,
        attempt_id: attemptId,
        attempt_lease_expires_at: new Date(
          Date.parse(now) + notificationLeaseMs
        ).toISOString()
      });
      const saved = dependencies.repository.save({
        ...current,
        updated_at: now,
        notification_outbox: replaceAt(
          current.notification_outbox,
          index,
          claimed
        )
      }, { expectedRevision: terminalWatchRevision(current) });
      return {
        watch: saved,
        notification: saved.notification_outbox[index],
        attempt_id: attemptId,
        snapshot_error_code: snapshotErrorCode
      };
    });
  }

  function finishNotification(
    watchId: string,
    notificationId: string,
    attemptId: string,
    outcome:
      | { disposition: "accepted" }
      | {
          disposition:
            | "retryable_failure"
            | "permanent_failure"
            | "uncertain";
          error_code: string;
        }
  ) {
    return dependencies.repository.withWatchLock(watchId, () => {
      const current = dependencies.repository.load(watchId);
      const index = current.notification_outbox.findIndex(
        (notification) => notification.notification_id === notificationId
      );
      if (index < 0) {
        return { settled: false, watch: current };
      }
      const selected = current.notification_outbox[index];
      if (
        selected.status !== "delivering" ||
        selected.attempt_id !== attemptId
      ) {
        return { settled: false, watch: current };
      }
      const now = canonicalNow(dependencies.now());
      const settled: TerminalWatchNotification =
        outcome.disposition === "accepted"
        ? withNotificationReceipt(selected, {
            status: "delivered",
            attempts: selected.attempts,
            last_attempt_at: selected.last_attempt_at,
            delivered_at: now
          })
        : selected.kind === "approval" && current.status !== "active"
          ? supersededApprovalNotification(selected, now)
          : withNotificationReceipt(selected, {
            status: "failed",
            attempts: selected.attempts,
            last_attempt_at: selected.last_attempt_at,
            failed_at: now,
            next_attempt_at: new Date(
              Date.parse(now) + retryDelay(selected.attempts)
            ).toISOString(),
            last_error_code: callbackOutcomeErrorCode(outcome)
          });
      const saved = dependencies.repository.save({
        ...current,
        updated_at: now,
        notification_outbox: replaceAt(
          current.notification_outbox,
          index,
          settled
        )
      }, { expectedRevision: terminalWatchRevision(current) });
      return { settled: true, watch: saved };
    });
  }

  async function deliverNextNotification(
    watchId: string
  ): Promise<TerminalWatchNotificationDeliveryResult> {
    const claim = claimNextNotification(watchId);
    if (!claim.notification || !claim.attempt_id) {
      return { status: "none", watch: claim.watch };
    }
    const notificationId = claim.notification.notification_id;
    let outcome: CallbackAttemptOutcome = {
      disposition: "permanent_failure",
      error_code: claim.snapshot_error_code ??
        "callback_request_construction_failed"
    };
    const callbackSnapshot = terminalWatchNotificationCallbackSnapshot(
      claim.watch,
      claim.notification
    );
    if (callbackSnapshot) {
      let acceptedCheckpoint: Extract<
        CallbackAttemptOutcome,
        { disposition: "accepted" }
      > | undefined;
      let acceptedSettlement:
        | ReturnType<typeof finishNotification>
        | undefined;
      let invalidCheckpoint = false;
      const reportCheckpoint = (value: CallbackAttemptOutcome): void => {
        try {
          const checkpoint = parseCallbackAttemptOutcome(value);
          if (checkpoint.disposition === "accepted") {
            acceptedCheckpoint = checkpoint;
            acceptedSettlement ??= finishNotification(
              watchId,
              notificationId,
              claim.attempt_id,
              { disposition: "accepted" }
            );
          }
        } catch {
          invalidCheckpoint = true;
        }
      };
      let prepared:
        | ReturnType<typeof prepareTerminalWatchCallbackDelivery>
        | undefined;
      try {
        prepared = prepareTerminalWatchCallbackDelivery({
          ...callbackSnapshot,
          context: dependencies.resolveCallbackContext?.(
            claim.watch,
            callbackSnapshot.route
          ),
          notification: claim.notification,
          attemptId: claim.attempt_id,
          reportCheckpoint
        });
      } catch {
        outcome = {
          disposition: "permanent_failure",
          error_code: "callback_request_construction_failed"
        };
      }
      let delivered: unknown;
      let deliveryReturned = false;
      if (prepared) {
        try {
          delivered = await dependencies.deliver(prepared);
          deliveryReturned = true;
        } catch {
          outcome = acceptedCheckpoint ?? terminalWatchUncertainOutcome(
            dependencies,
            "callback_transport_threw"
          );
        }
      }
      if (deliveryReturned) {
        try {
          outcome = parseCallbackAttemptOutcome(delivered);
        } catch {
          outcome = acceptedCheckpoint ?? terminalWatchUncertainOutcome(
            dependencies,
            "callback_transport_contract_violation"
          );
        }
        if (acceptedCheckpoint && outcome.disposition !== "accepted") {
          outcome = acceptedCheckpoint;
        } else if (
          invalidCheckpoint &&
          outcome.disposition !== "accepted"
        ) {
          outcome = terminalWatchUncertainOutcome(
            dependencies,
            "callback_transport_contract_violation"
          );
        }
      }
      if (acceptedSettlement?.settled) {
        return {
          status: "delivered",
          watch: acceptedSettlement.watch,
          notification_id: notificationId
        };
      }
    }
    const finished = finishNotification(
      watchId,
      notificationId,
      claim.attempt_id,
      outcome.disposition === "accepted"
        ? { disposition: "accepted" }
        : {
            disposition: outcome.disposition,
            error_code: outcome.error_code
          }
    );
    if (!finished.settled) {
      return {
        status: "claim_changed",
        watch: finished.watch,
        notification_id: notificationId
      };
    }
    if (outcome.disposition === "accepted") {
      return {
        status: "delivered",
        watch: finished.watch,
        notification_id: notificationId
      };
    }
    return {
      status: "failed",
      watch: finished.watch,
      notification_id: notificationId,
      error_code: callbackOutcomeErrorCode(outcome)
    };
  }

  return deliverNextNotification;
}

function prepareTerminalWatchCallbackDelivery(input: {
  route: CallbackRouteV1;
  envelope: CallbackEnvelopeV1;
  context?: CallbackTransportContextV1;
  notification: TerminalWatchNotification;
  attemptId: string;
  reportCheckpoint(outcome: CallbackAttemptOutcome): void;
}): TerminalWatchDeliveryInput {
  const route = parseCallbackRoute(input.route);
  const context = snapshotTerminalWatchCallbackContext(input.context);
  const attemptNumber = input.notification.attempts;
  const attemptId = input.attemptId;
  if (
    !Number.isSafeInteger(attemptNumber) ||
    attemptNumber < 1 ||
    attemptId.trim().length === 0
  ) {
    throw new Error("Terminal Watch callback attempt identity is invalid");
  }
  return {
    route,
    envelope: input.envelope,
    attempt: { number: attemptNumber, id: attemptId },
    context,
    reportCheckpoint: input.reportCheckpoint
  };
}

function snapshotTerminalWatchCallbackContext(
  value: CallbackTransportContextV1 | undefined
): CallbackTransportContextV1 | undefined {
  if (!value) return undefined;
  const { legacyOptions, ...context } = value;
  return {
    ...context,
    ...(legacyOptions
      ? { legacyOptions: { ...legacyOptions } }
      : {})
  };
}

function terminalWatchUncertainOutcome(
  dependencies: Pick<TerminalWatchServiceDependencies, "now">,
  errorCode: string
): Extract<CallbackAttemptOutcome, { disposition: "uncertain" }> {
  return {
    disposition: "uncertain",
    error_code: errorCode,
    observed_at: canonicalNow(dependencies.now())
  };
}

type TerminalWatchNotificationDeliveryResult =
  | { status: "none"; watch: TerminalWatch }
  | {
      status: "claim_changed" | "delivered";
      watch: TerminalWatch;
      notification_id: string;
    }
  | {
      status: "failed";
      watch: TerminalWatch;
      notification_id: string;
      error_code: string;
    };

async function reconcileAllTerminalWatches(input: {
  dependencies: TerminalWatchServiceDependencies;
  reconciliationDeliveryLimit: number;
  reconcile(watchId: string): Promise<TerminalWatch>;
  deliverNextNotification(
    watchId: string
  ): Promise<TerminalWatchNotificationDeliveryResult>;
}): Promise<TerminalWatchReconciliationSummary> {
  const {
    dependencies,
    reconciliationDeliveryLimit,
    reconcile,
    deliverNextNotification
  } = input;
  const scan = dependencies.repository.scanForReconciliation();
  const work = scan.watches
    .filter((watch) => watch.status === "active" || hasUnresolvedNotification(watch))
    .map((watch) => ({
      beforeRevision: terminalWatchRevision(watch),
      callbacksDelivered: 0,
      current: watch,
      errorCode: undefined as string | undefined
    }));

  // Observation has priority over callback transport. A slow or permanently
  // failing callback transport must never prevent another active Watch from
  // learning that its exact task completed or became invalid.
  for (const item of work) {
    if (item.current.status !== "active") continue;
    try {
      item.current = await reconcile(item.current.watch_id);
    } catch (error) {
      item.errorCode = safeReasonCode(
        dependencies.classifyDeliveryError?.(error),
        "terminal_watch_observation_failed"
      );
      item.current = safeLoadWatch(
        dependencies.repository,
        item.current.watch_id,
        item.current
      );
    }
  }

  // Delivery is a separate, bounded and fair phase. At most one notification
  // per Watch can be attempted in this reconciliation, and oldest attempts
  // win so a recently failed callback cannot remain permanently at the head.
  const deliveryNow = canonicalNow(dependencies.now());
  const deliveryCandidates = work
    .flatMap((item) => {
      const notification = firstClaimableNotification(item.current, deliveryNow);
      return notification ? [{ item, notification }] : [];
    })
    .sort((left, right) =>
      notificationFairnessTime(left.notification).localeCompare(
        notificationFairnessTime(right.notification)
      ) || left.item.current.watch_id.localeCompare(right.item.current.watch_id)
    )
    .slice(0, reconciliationDeliveryLimit);

  for (const candidate of deliveryCandidates) {
    const item = candidate.item;
    try {
      const delivery = await deliverNextNotification(item.current.watch_id);
      item.current = delivery.watch;
      if (delivery.status === "delivered") {
        item.callbacksDelivered += 1;
      } else if (delivery.status === "failed") {
        item.errorCode = item.errorCode ?? delivery.error_code;
      } else if (delivery.status === "claim_changed") {
        item.errorCode = item.errorCode ?? "callback_claim_changed";
      }
    } catch (error) {
      item.errorCode = item.errorCode ?? safeReasonCode(
        dependencies.classifyDeliveryError?.(error),
        "terminal_watch_callback_recovery_failed"
      );
      item.current = safeLoadWatch(
        dependencies.repository,
        item.current.watch_id,
        item.current
      );
    }
  }

  const summary: TerminalWatchReconciliationSummary = {
    checked: work.length + scan.errors.length,
    changed: 0,
    callbacks_delivered: 0,
    errors: 0,
    items: []
  };
  for (const item of work) {
    const changed = terminalWatchRevision(item.current) !== item.beforeRevision;
    if (changed) summary.changed += 1;
    summary.callbacks_delivered += item.callbacksDelivered;
    if (item.errorCode) summary.errors += 1;
    summary.items.push({
      watch_id: item.current.watch_id,
      status: item.current.status,
      changed,
      callbacks_delivered: item.callbacksDelivered,
      error_code: item.errorCode
    });
  }
  for (const error of scan.errors) {
    summary.errors += 1;
    summary.items.push({
      watch_id: error.watch_id,
      status: "error",
      changed: false,
      callbacks_delivered: 0,
      error_code: error.error_code
    });
  }
  return summary;
}

function firstUnresolvedNotificationIndex(watch: TerminalWatch): number {
  return watch.notification_outbox.findIndex((notification) =>
    notification.status !== "delivered" &&
    notification.status !== "superseded" &&
    // Permanent and uncertain receipts are terminal for this exact
    // notification. Keep their evidence, but do not let them become a queue
    // head that starves a later, distinct approval observation.
    !(
      notification.status === "failed" &&
      isNonRetryableCallbackError(notification.last_error_code)
    )
  );
}

function hasUnresolvedNotification(watch: TerminalWatch): boolean {
  return firstUnresolvedNotificationIndex(watch) >= 0;
}

function firstClaimableNotification(
  watch: TerminalWatch,
  now: string
): TerminalWatchNotification | undefined {
  const index = firstUnresolvedNotificationIndex(watch);
  const notification = watch.notification_outbox[index];
  return notification && notificationIsClaimable(notification, now)
    ? notification
    : undefined;
}

function notificationFairnessTime(
  notification: TerminalWatchNotification
): string {
  return notification.last_attempt_at ?? notification.created_at;
}

function safeLoadWatch(
  repository: TerminalWatchStore,
  watchId: string,
  fallback: TerminalWatch
): TerminalWatch {
  try {
    return repository.load(watchId);
  } catch {
    return fallback;
  }
}

function terminalWatchNotificationDeliveryPolicy(
  dependencies: TerminalWatchServiceDependencies
): {
  notificationLeaseMs: number;
  reconciliationDeliveryLimit: number;
  retryDelay(attempt: number): number;
} {
  const maximumRetryDelay = positiveMilliseconds(
    dependencies.notificationMaxRetryDelayMs,
    DEFAULT_NOTIFICATION_MAX_RETRY_DELAY_MS,
    "terminal Watch maximum notification retry delay"
  );
  const configuredRetryDelay = dependencies.notificationRetryDelayMs;
  return {
    notificationLeaseMs: positiveMilliseconds(
      dependencies.notificationLeaseMs,
      DEFAULT_NOTIFICATION_LEASE_MS,
      "terminal Watch notification lease"
    ),
    reconciliationDeliveryLimit: positiveMilliseconds(
      dependencies.reconciliationDeliveryLimit,
      DEFAULT_RECONCILIATION_DELIVERY_LIMIT,
      "terminal Watch reconciliation delivery limit"
    ),
    retryDelay: (attempt) => nonNegativeMilliseconds(
      Math.min(
        maximumRetryDelay,
        typeof configuredRetryDelay === "function"
          ? configuredRetryDelay(attempt)
          : (configuredRetryDelay ?? DEFAULT_NOTIFICATION_RETRY_DELAY_MS) *
            2 ** Math.max(0, attempt - 1)
      ),
      DEFAULT_NOTIFICATION_RETRY_DELAY_MS,
      "terminal Watch notification retry delay"
    )
  };
}

function nextObservationCheckpoint(
  watch: TerminalWatch,
  observation: TerminalWatchObservation
): TerminalWatch["observation_checkpoint"] {
  const suppliedCheckpoint = observation.observation_checkpoint;
  const suppliedOffset = observation.safe_resume_offset_bytes;
  if (
    suppliedCheckpoint !== undefined &&
    suppliedOffset !== undefined &&
    suppliedCheckpoint.safe_resume_offset_bytes !== suppliedOffset
  ) {
    throw new Error("terminal Watch observation checkpoints disagree");
  }
  if (suppliedCheckpoint === undefined && suppliedOffset === undefined) {
    return watch.observation_checkpoint;
  }
  const candidate = suppliedCheckpoint ?? {
    safe_resume_offset_bytes: suppliedOffset as number
  };
  if (
    !Number.isSafeInteger(candidate.safe_resume_offset_bytes) ||
    candidate.safe_resume_offset_bytes <
      watch.observation_checkpoint.safe_resume_offset_bytes
  ) {
    throw new Error("terminal Watch observation checkpoint is invalid");
  }
  const candidateWatch = { ...watch, observation_checkpoint: candidate };
  assertTerminalWatch(candidateWatch, watch.watch_id);
  return candidate;
}

export function terminalWatchObservationFence(
  watch: TerminalWatch
): TerminalWatchObservationFence {
  return {
    watch_id: watch.watch_id,
    terminal_identity_fingerprint: terminalWatchIdentityFingerprint(watch),
    anchor_fingerprint: watch.anchor.anchor_fingerprint
  };
}

function assertObservationForWatch(
  observation: TerminalWatchObservation,
  watch: TerminalWatch,
  now: string
): void {
  const expected = terminalWatchObservationFence(watch);
  if (
    observation.watch_id !== expected.watch_id ||
    observation.terminal_identity_fingerprint !==
      expected.terminal_identity_fingerprint ||
    observation.anchor_fingerprint !== expected.anchor_fingerprint
  ) {
    throw new Error("terminal Watch observation does not match its exact anchor");
  }
  assertTimestamp(observation.observed_at, "terminal Watch observation time");
  if (Date.parse(observation.observed_at) > Date.parse(now)) {
    throw new Error("terminal Watch observation cannot come from the future");
  }
  if (observation.last_activity_at !== undefined) {
    assertTimestamp(
      observation.last_activity_at,
      "terminal Watch observation activity"
    );
    if (Date.parse(observation.last_activity_at) > Date.parse(now)) {
      throw new Error("terminal Watch activity cannot come from the future");
    }
  }
  if (observation.safe_resume_offset_bytes !== undefined) {
    if (
      !Number.isSafeInteger(observation.safe_resume_offset_bytes) ||
      observation.safe_resume_offset_bytes <
        watch.observation_checkpoint.safe_resume_offset_bytes
    ) {
      throw new Error("terminal Watch observation checkpoint is invalid");
    }
  }
  if (
    observation.observation_checkpoint !== undefined &&
    (
      observation.observation_checkpoint.safe_resume_offset_bytes <
        watch.observation_checkpoint.safe_resume_offset_bytes ||
      (
        observation.safe_resume_offset_bytes !== undefined &&
        observation.safe_resume_offset_bytes !==
          observation.observation_checkpoint.safe_resume_offset_bytes
      )
    )
  ) {
    throw new Error("terminal Watch observation checkpoint is invalid");
  }
  if (observation.kind === "unavailable") {
    if (observation.reason_code !== undefined) {
      safeReasonCode(observation.reason_code, undefined);
    }
    return;
  }
  if (observation.kind !== "pending") {
    assertSha256(
      observation.evidence_fingerprint,
      "terminal Watch observation fingerprint"
    );
    if (observation.reason_code !== undefined) {
      safeReasonCode(observation.reason_code, undefined);
    }
  }
  if (observation.kind === "completed" || observation.kind === "failed") {
    if (
      observation.completion_text !== undefined &&
      (
        typeof observation.completion_text !== "string" ||
        observation.completion_text.length > 4000 ||
        observation.completion_text.includes("\0")
      )
    ) {
      throw new Error("terminal Watch completion text exceeds its safe bound");
    }
    if (
      observation.completion_id !== undefined &&
      (
        typeof observation.completion_id !== "string" ||
        observation.completion_id.trim().length === 0 ||
        observation.completion_id.includes("\0")
      )
    ) {
      throw new Error("terminal Watch completion id is invalid");
    }
    if (observation.completion_timestamp !== undefined) {
      assertTimestamp(
        observation.completion_timestamp,
        "terminal Watch completion timestamp"
      );
    }
  }
}

function withApprovalNotification(
  watch: TerminalWatch,
  input: {
    evidenceFingerprint: string;
    reasonCode?: string;
    createdAt: string;
  }
): TerminalWatch {
  const notification = pendingNotification(
    watch.watch_id,
    "approval",
    input.evidenceFingerprint,
    input.createdAt,
    input.reasonCode
  );
  return {
    ...watch,
    notification_outbox: [...watch.notification_outbox, notification]
  };
}

function pendingNotification(
  watchId: string,
  kind: TerminalWatchNotificationKind,
  evidenceFingerprint: string,
  createdAt: string,
  reasonCode?: string
): TerminalWatchNotification {
  assertSha256(evidenceFingerprint, "terminal Watch notification fingerprint");
  const notificationId = terminalWatchNotificationId(
    watchId,
    kind,
    evidenceFingerprint
  );
  return {
    notification_id: notificationId,
    idempotency_key: terminalWatchNotificationIdempotencyKey(
      watchId,
      notificationId
    ),
    kind,
    evidence_fingerprint: evidenceFingerprint,
    reason_code: reasonCode === undefined
      ? undefined
      : safeReasonCode(reasonCode, undefined),
    status: "pending",
    attempts: 0,
    created_at: createdAt
  };
}

function supersedeUndeliveredApprovals(
  notifications: readonly TerminalWatchNotification[],
  supersededAt: string
): TerminalWatchNotification[] {
  return notifications.map((notification) => {
    if (
      notification.kind !== "approval" ||
      notification.status === "delivered" ||
      notification.status === "delivering" ||
      notification.status === "superseded"
    ) {
      return notification;
    }
    return supersededApprovalNotification(notification, supersededAt);
  });
}

function supersededApprovalNotification(
  notification: TerminalWatchNotification,
  supersededAt: string
): TerminalWatchNotification {
  return withNotificationReceipt(notification, {
    status: "superseded",
    attempts: notification.attempts,
    superseded_at: supersededAt
  });
}

type TerminalWatchNotificationReceipt = Omit<
  TerminalWatchNotification,
  | "notification_id"
  | "idempotency_key"
  | "kind"
  | "evidence_fingerprint"
  | "reason_code"
  | "callback_route"
  | "callback_envelope"
  | "created_at"
>;

/** Replace the mutable delivery receipt without leaking stale lease/error data. */
function withNotificationReceipt(
  notification: TerminalWatchNotification,
  receipt: TerminalWatchNotificationReceipt
): TerminalWatchNotification {
  return {
    notification_id: notification.notification_id,
    idempotency_key: notification.idempotency_key,
    kind: notification.kind,
    evidence_fingerprint: notification.evidence_fingerprint,
    reason_code: notification.reason_code,
    ...(Object.hasOwn(notification, "callback_route")
      ? { callback_route: notification.callback_route }
      : {}),
    ...(Object.hasOwn(notification, "callback_envelope")
      ? { callback_envelope: notification.callback_envelope }
      : {}),
    created_at: notification.created_at,
    ...receipt
  };
}

function notificationIsClaimable(
  notification: TerminalWatchNotification,
  now: string
): boolean {
  if (notification.status === "pending") {
    return true;
  }
  if (notification.status === "failed") {
    if (isNonRetryableCallbackError(notification.last_error_code)) {
      return false;
    }
    return Date.parse(notification.next_attempt_at ?? "") <= Date.parse(now);
  }
  if (notification.status === "delivering") {
    return Date.parse(notification.attempt_lease_expires_at ?? "") <=
      Date.parse(now);
  }
  return false;
}

function callbackOutcomeErrorCode(
  outcome: {
    disposition: "retryable_failure" | "permanent_failure" | "uncertain";
    error_code: string;
  }
): string {
  const errorCode = safeReasonCode(
    outcome.error_code,
    "callback_delivery_failed"
  );
  const prefix = outcome.disposition === "permanent_failure"
    ? "callback_permanent_"
    : outcome.disposition === "uncertain"
      ? "callback_uncertain_"
      : "";
  return safeReasonCode(
    `${prefix}${errorCode}`,
    `${prefix}callback_delivery_failed`
  );
}

function isNonRetryableCallbackError(errorCode: string | undefined): boolean {
  return errorCode?.startsWith("callback_permanent_") === true ||
    errorCode?.startsWith("callback_uncertain_") === true;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
  return values.map((candidate, candidateIndex) =>
    candidateIndex === index ? value : candidate
  );
}

function latestActivityAt(current: string, candidate?: string): string {
  return candidate !== undefined && Date.parse(candidate) > Date.parse(current)
    ? candidate
    : current;
}

function isDeadlineElapsed(watch: TerminalWatch, now: Date): boolean {
  return now.getTime() >= Date.parse(watch.deadline_at);
}

function deterministicEvidenceFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function canonicalNow(value: Date): string {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error("terminal Watch clock returned an invalid Date");
  }
  return value.toISOString();
}

function positiveMilliseconds(
  value: unknown,
  fallback: number | undefined,
  label: string
): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (
    candidate === undefined ||
    !Number.isSafeInteger(candidate) ||
    candidate <= 0
  ) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return candidate;
}

function nonNegativeMilliseconds(
  value: unknown,
  fallback: number,
  label: string
): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return candidate;
}

function safeReasonCode(
  value: unknown,
  fallback: string | undefined
): string {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    /^[a-z0-9][a-z0-9_.:-]*$/u.test(value)
  ) {
    return value;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error("terminal Watch reason must be a privacy-safe reason code");
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
}

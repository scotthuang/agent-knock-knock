import { createHash } from "node:crypto";
import {
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  assertTerminalWatch,
  terminalWatchIdentityFingerprint,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchRevision,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchNotification,
  type TerminalWatchNotificationKind,
  type TerminalWatchStatus,
  type TerminalWatchStore,
  type TerminalWatchTerminalIdentity,
  type TerminalWatchTerminalStatus
} from "./terminal-watch-store.js";
import type { ExecutorKind } from "./executors.js";

const DEFAULT_NOTIFICATION_LEASE_MS = 30_000;
const DEFAULT_NOTIFICATION_RETRY_DELAY_MS = 5_000;

export interface CreateTerminalWatchInput {
  watch_id?: string;
  agent: ExecutorKind;
  terminal: TerminalWatchTerminalIdentity;
  anchor: TerminalWatchAnchor;
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
}

export type TerminalWatchObservation =
  | (TerminalWatchObservationBase & { kind: "pending" })
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

export interface TerminalWatchDeliveryInput {
  watch: TerminalWatch;
  notification: TerminalWatchNotification;
  idempotencyKey: string;
}

export interface TerminalWatchServiceDependencies {
  repository: TerminalWatchStore;
  now(): Date;
  randomUUID(): string;
  observe(watch: TerminalWatch): Promise<TerminalWatchObservation>;
  deliver(input: TerminalWatchDeliveryInput): Promise<void>;
  notificationLeaseMs?: number;
  notificationRetryDelayMs?: number | ((attempt: number) => number);
  classifyDeliveryError?(error: unknown): string;
}

export interface ClaimedTerminalWatchNotification {
  watch: TerminalWatch;
  notification: TerminalWatchNotification;
  attempt_id: string;
}

export interface TerminalWatchNotificationFinishResult {
  settled: boolean;
  watch: TerminalWatch;
  reason?: "notification_missing" | "claim_changed";
}

export type TerminalWatchDeliveryResult =
  | { status: "none"; watch: TerminalWatch }
  | {
      status: "delivered";
      watch: TerminalWatch;
      notification_id: string;
    }
  | {
      status: "failed";
      watch: TerminalWatch;
      notification_id: string;
      error_code: string;
    }
  | {
      status: "claim_changed";
      watch: TerminalWatch;
      notification_id: string;
    };

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
  claimNextNotification(
    watchId: string
  ): ClaimedTerminalWatchNotification | undefined;
  finishNotification(
    watchId: string,
    notificationId: string,
    attemptId: string,
    outcome:
      | { delivered: true }
      | { delivered: false; error_code: string }
  ): TerminalWatchNotificationFinishResult;
  deliverNextNotification(watchId: string): Promise<TerminalWatchDeliveryResult>;
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
  const { notificationLeaseMs, retryDelay } =
    terminalWatchNotificationDeliveryPolicy(dependencies);

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
        anchor_fingerprint: current.anchor.evidence_fingerprint
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
      anchor_fingerprint: current.anchor.evidence_fingerprint
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
    const activityAt = latestActivityAt(
      current.last_activity_at,
      observation.kind === "approval"
        ? observation.last_activity_at ?? observation.observed_at
        : observation.last_activity_at
    );
    if (observation.kind === "pending") {
      if (activityAt === current.last_activity_at) {
        return current;
      }
      return dependencies.repository.save({
        ...current,
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
        if (activityAt === current.last_activity_at) {
          return current;
        }
        return dependencies.repository.save({
          ...current,
          last_activity_at: activityAt,
          updated_at: now
        }, { expectedRevision: terminalWatchRevision(current) });
      }
      const next = withApprovalNotification({
        ...current,
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

  function claimNextNotification(
    watchId: string
  ): ClaimedTerminalWatchNotification | undefined {
    return claimNextTerminalWatchNotification(
      dependencies,
      notificationLeaseMs,
      watchId
    );
  }

  function finishNotification(
    watchId: string,
    notificationId: string,
    attemptId: string,
    outcome:
      | { delivered: true }
      | { delivered: false; error_code: string }
  ): TerminalWatchNotificationFinishResult {
    return dependencies.repository.withWatchLock(watchId, () => {
      const current = dependencies.repository.load(watchId);
      const index = current.notification_outbox.findIndex(
        (notification) => notification.notification_id === notificationId
      );
      if (index < 0) {
        return { settled: false, watch: current, reason: "notification_missing" };
      }
      const selected = current.notification_outbox[index];
      if (
        selected.status !== "delivering" ||
        selected.attempt_id !== attemptId
      ) {
        return { settled: false, watch: current, reason: "claim_changed" };
      }
      const now = canonicalNow(dependencies.now());
      const settled: TerminalWatchNotification = outcome.delivered
        ? {
            notification_id: selected.notification_id,
            idempotency_key: selected.idempotency_key,
            kind: selected.kind,
            evidence_fingerprint: selected.evidence_fingerprint,
            reason_code: selected.reason_code,
            status: "delivered",
            attempts: selected.attempts,
            created_at: selected.created_at,
            last_attempt_at: selected.last_attempt_at,
            delivered_at: now
          }
        : selected.kind === "approval" && current.status !== "active"
          ? supersededApprovalNotification(selected, now)
          : {
            notification_id: selected.notification_id,
            idempotency_key: selected.idempotency_key,
            kind: selected.kind,
            evidence_fingerprint: selected.evidence_fingerprint,
            reason_code: selected.reason_code,
            status: "failed",
            attempts: selected.attempts,
            created_at: selected.created_at,
            last_attempt_at: selected.last_attempt_at,
            failed_at: now,
            next_attempt_at: new Date(
              Date.parse(now) + retryDelay(selected.attempts)
            ).toISOString(),
            last_error_code: safeReasonCode(
              outcome.error_code,
              "callback_delivery_failed"
            )
          };
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
  ): Promise<TerminalWatchDeliveryResult> {
    const claim = claimNextNotification(watchId);
    if (!claim) {
      return { status: "none", watch: dependencies.repository.load(watchId) };
    }
    try {
      await dependencies.deliver({
        watch: claim.watch,
        notification: claim.notification,
        idempotencyKey: claim.notification.idempotency_key
      });
      const finished = finishNotification(
        watchId,
        claim.notification.notification_id,
        claim.attempt_id,
        { delivered: true }
      );
      return finished.settled
        ? {
            status: "delivered",
            watch: finished.watch,
            notification_id: claim.notification.notification_id
          }
        : {
            status: "claim_changed",
            watch: finished.watch,
            notification_id: claim.notification.notification_id
          };
    } catch (error) {
      const errorCode = safeReasonCode(
        dependencies.classifyDeliveryError?.(error),
        "callback_delivery_failed"
      );
      const finished = finishNotification(
        watchId,
        claim.notification.notification_id,
        claim.attempt_id,
        { delivered: false, error_code: errorCode }
      );
      return finished.settled
        ? {
            status: "failed",
            watch: finished.watch,
            notification_id: claim.notification.notification_id,
            error_code: errorCode
          }
        : {
            status: "claim_changed",
            watch: finished.watch,
            notification_id: claim.notification.notification_id
          };
    }
  }

  async function reconcileAll(): Promise<TerminalWatchReconciliationSummary> {
    const listed = dependencies.repository.list();
    const summary: TerminalWatchReconciliationSummary = {
      checked: listed.length,
      changed: 0,
      callbacks_delivered: 0,
      errors: 0,
      items: []
    };
    for (const item of listed) {
      const beforeRevision = terminalWatchRevision(item);
      let callbacksDelivered = 0;
      let errorCode: string | undefined;
      let current = item;
      try {
        current = item.status === "active"
          ? await reconcile(item.watch_id)
          : dependencies.repository.load(item.watch_id);
      } catch (error) {
        errorCode = safeReasonCode(
          dependencies.classifyDeliveryError?.(error),
          "terminal_watch_observation_failed"
        );
        current = safeLoadWatch(dependencies.repository, item.watch_id, item);
      }
      try {
        const deliveryLimit = current.notification_outbox.length + 1;
        for (let attempt = 0; attempt < deliveryLimit; attempt += 1) {
          const delivery = await deliverNextNotification(item.watch_id);
          current = delivery.watch;
          if (delivery.status === "delivered") {
            callbacksDelivered += 1;
            continue;
          }
          if (delivery.status === "failed") {
            errorCode = errorCode ?? delivery.error_code;
          } else if (delivery.status === "claim_changed") {
            errorCode = errorCode ?? "callback_claim_changed";
          }
          break;
        }
      } catch (error) {
        errorCode = errorCode ?? safeReasonCode(
          dependencies.classifyDeliveryError?.(error),
          "terminal_watch_callback_recovery_failed"
        );
        current = safeLoadWatch(
          dependencies.repository,
          item.watch_id,
          current
        );
      }
      const changed = terminalWatchRevision(current) !== beforeRevision;
      if (changed) summary.changed += 1;
      summary.callbacks_delivered += callbacksDelivered;
      if (errorCode) summary.errors += 1;
      summary.items.push({
        watch_id: item.watch_id,
        status: current.status,
        changed,
        callbacks_delivered: callbacksDelivered,
        error_code: errorCode
      });
    }
    return summary;
  }

  return Object.freeze({
    create,
    cancel,
    get: (watchId: string) => dependencies.repository.load(watchId),
    list: () => dependencies.repository.list(),
    reconcile,
    reconcileAll,
    claimNextNotification,
    finishNotification,
    deliverNextNotification
  });
}

function claimNextTerminalWatchNotification(
  dependencies: Pick<
    TerminalWatchServiceDependencies,
    "repository" | "now" | "randomUUID"
  >,
  notificationLeaseMs: number,
  watchId: string
): ClaimedTerminalWatchNotification | undefined {
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
      return undefined;
    }
    const selected = current.notification_outbox[index];
    const attemptId = dependencies.randomUUID();
    const claimed: TerminalWatchNotification = {
      notification_id: selected.notification_id,
      idempotency_key: selected.idempotency_key,
      kind: selected.kind,
      evidence_fingerprint: selected.evidence_fingerprint,
      reason_code: selected.reason_code,
      status: "delivering",
      attempts: selected.attempts + 1,
      created_at: selected.created_at,
      last_attempt_at: now,
      attempt_id: attemptId,
      attempt_lease_expires_at: new Date(
        Date.parse(now) + notificationLeaseMs
      ).toISOString()
    };
    const saved = dependencies.repository.save({
      ...current,
      updated_at: now,
      notification_outbox: replaceAt(current.notification_outbox, index, claimed)
    }, { expectedRevision: terminalWatchRevision(current) });
    return {
      watch: saved,
      notification: saved.notification_outbox[index],
      attempt_id: attemptId
    };
  });
}

function firstUnresolvedNotificationIndex(watch: TerminalWatch): number {
  return watch.notification_outbox.findIndex((notification) =>
    notification.status !== "delivered" &&
    notification.status !== "superseded"
  );
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
  retryDelay(attempt: number): number;
} {
  return {
    notificationLeaseMs: positiveMilliseconds(
      dependencies.notificationLeaseMs,
      DEFAULT_NOTIFICATION_LEASE_MS,
      "terminal Watch notification lease"
    ),
    retryDelay: (attempt) => nonNegativeMilliseconds(
      typeof dependencies.notificationRetryDelayMs === "function"
        ? dependencies.notificationRetryDelayMs(attempt)
        : dependencies.notificationRetryDelayMs,
      DEFAULT_NOTIFICATION_RETRY_DELAY_MS,
      "terminal Watch notification retry delay"
    )
  };
}

export function terminalWatchObservationFence(
  watch: TerminalWatch
): TerminalWatchObservationFence {
  return {
    watch_id: watch.watch_id,
    terminal_identity_fingerprint: terminalWatchIdentityFingerprint(watch),
    anchor_fingerprint: watch.anchor.evidence_fingerprint
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
    approval_fingerprint: input.evidenceFingerprint,
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
  return {
    notification_id: notification.notification_id,
    idempotency_key: notification.idempotency_key,
    kind: notification.kind,
    evidence_fingerprint: notification.evidence_fingerprint,
    reason_code: notification.reason_code,
    status: "superseded",
    attempts: notification.attempts,
    created_at: notification.created_at,
    superseded_at: supersededAt
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
    return Date.parse(notification.next_attempt_at ?? "") <= Date.parse(now);
  }
  if (notification.status === "delivering") {
    return Date.parse(notification.attempt_lease_expires_at ?? "") <=
      Date.parse(now);
  }
  return false;
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

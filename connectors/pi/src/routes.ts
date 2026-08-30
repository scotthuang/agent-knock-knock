import { createHash, randomBytes } from "node:crypto";

import {
  CallbackInbox,
  type CallbackInboxEntry,
} from "./callback-inbox.js";

const RETRY_BASE_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 30_000;

export interface CallbackRequest {
  readonly controllerId: string;
  readonly deliveryId: string;
  readonly messageId: string;
  readonly idempotencyKey: string;
  readonly body: string;
}

export type CallbackStatus = "accepted" | "retry" | "rejected" | "unknown";

export interface CallbackAcknowledgement {
  readonly request: {
    readonly delivery_id: string;
    readonly message_id: string;
  };
  readonly result: {
    readonly status: CallbackStatus;
    readonly acceptance_id?: string;
    readonly error_code?: string;
  };
}

/** One exact Pi session/branch runtime that may receive AKK callbacks. */
export interface PiCallbackTarget {
  /** Exact object identity shared with the HostAdapter controller context. */
  readonly authority: object;
  readonly sessionId: string;
  /** Changes when the extension runtime or explicit branch epoch changes. */
  readonly runtimeGeneration: string;
  /** Diagnostic-only snapshot; normal conversation messages advance the leaf. */
  readonly anchorLeafId: string | null;
  isLive(): boolean;
  deliver(body: string, request: CallbackRequest): void | Promise<void>;
}

export interface PiCallbackRoute {
  readonly controllerId: string;
  readonly target: PiCallbackTarget;
  readonly sessionId: string;
  readonly runtimeGeneration: string;
  readonly anchorLeafId: string | null;
}

/**
 * Exact-object callback routing for a Pi controller incarnation.
 *
 * Admission is durable before an accepted ACK is returned. Delivery into Pi
 * is then at-least-once across the narrow `sendMessage()`/inbox-state window,
 * because Pi 0.84.4 does not expose an admission receipt for that API.
 */
export class PiRouteTable {
  private readonly routeByAuthority = new WeakMap<object, PiCallbackRoute>();
  private readonly disposedAuthorities = new WeakSet<object>();
  private readonly routeByControllerId = new Map<string, PiCallbackRoute>();
  private readonly deliveryByKey = new Map<string, Promise<void>>();
  private readonly retryTimerByKey = new Map<string, NodeJS.Timeout>();
  private readonly retryAttemptByKey = new Map<string, number>();
  private readonly instanceNonce: string;
  private nextRouteNonce = 0;
  private active = true;

  constructor(private readonly inbox: CallbackInbox, instanceNonce?: string) {
    this.instanceNonce = instanceNonce ?? randomBytes(12).toString("hex");
    if (!validIdentity(this.instanceNonce)) {
      throw new Error("Pi AKK route instance nonce is invalid");
    }
  }

  bind(target: PiCallbackTarget): PiCallbackRoute {
    this.assertActive();
    validateTarget(target);
    if (this.disposedAuthorities.has(target.authority)) {
      throw new Error("AKK cannot reuse a disposed Pi controller authority");
    }

    const existing = this.routeByAuthority.get(target.authority);
    if (existing) {
      if (
        existing.target !== target ||
        existing.sessionId !== target.sessionId ||
        existing.runtimeGeneration !== target.runtimeGeneration ||
        existing.anchorLeafId !== target.anchorLeafId
      ) {
        throw new Error("AKK Pi controller authority changed identity");
      }
      return existing;
    }

    this.nextRouteNonce += 1;
    const controllerId = [
      "akk-pi",
      this.instanceNonce,
      this.nextRouteNonce.toString(36),
      identityDigest(target.sessionId, target.runtimeGeneration),
    ].join(":");
    const route: PiCallbackRoute = Object.freeze({
      controllerId,
      target,
      sessionId: target.sessionId,
      runtimeGeneration: target.runtimeGeneration,
      anchorLeafId: target.anchorLeafId,
    });
    this.routeByAuthority.set(target.authority, route);
    this.routeByControllerId.set(controllerId, route);
    void this.replayPending(route);
    return route;
  }

  dispose(target: PiCallbackTarget): void {
    this.disposedAuthorities.add(target.authority);
    const route = this.routeByAuthority.get(target.authority);
    if (!route) return;
    if (this.routeByControllerId.get(route.controllerId) === route) {
      this.routeByControllerId.delete(route.controllerId);
    }
    this.cancelRouteRetries(route.controllerId);
  }

  async deliver(request: CallbackRequest): Promise<CallbackAcknowledgement> {
    const base = acknowledgementBase(request);
    if (!this.active || !validRequest(request)) {
      return rejected(base, "invalid_or_stopped_callback_route");
    }

    const route = this.routeByControllerId.get(request.controllerId);
    if (!route || !this.routeIsLive(route)) {
      return rejected(base, "pi_route_not_live");
    }

    let admission: Awaited<ReturnType<CallbackInbox["admit"]>>;
    try {
      admission = await this.inbox.admit(request);
    } catch {
      return retry(base, "callback_inbox_unavailable");
    }
    if (admission.disposition === "collision") {
      return rejected(base, "idempotency_collision");
    }

    if (admission.entry.state === "pending") {
      await this.ensureDelivery(route, admission.entry);
    }
    return accepted(base, admission.entry.acceptanceId);
  }

  async close(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    this.routeByControllerId.clear();
    for (const timer of this.retryTimerByKey.values()) clearTimeout(timer);
    this.retryTimerByKey.clear();
    await Promise.allSettled(this.deliveryByKey.values());
  }

  private async replayPending(route: PiCallbackRoute): Promise<void> {
    let pending: readonly CallbackInboxEntry[];
    try {
      pending = await this.inbox.listPending(route.controllerId);
    } catch {
      return;
    }
    for (const entry of pending) {
      if (!this.routeIsLive(route)) return;
      await this.ensureDelivery(route, entry);
    }
  }

  private ensureDelivery(route: PiCallbackRoute, entry: CallbackInboxEntry): Promise<void> {
    const key = deliveryKey(entry);
    const existing = this.deliveryByKey.get(key);
    if (existing) return existing;

    const delivery = this.attemptDelivery(route, entry).finally(() => {
      if (this.deliveryByKey.get(key) === delivery) this.deliveryByKey.delete(key);
    });
    this.deliveryByKey.set(key, delivery);
    return delivery;
  }

  private async attemptDelivery(
    route: PiCallbackRoute,
    entry: CallbackInboxEntry,
  ): Promise<void> {
    if (!this.routeIsLive(route)) return;
    try {
      await route.target.deliver(entry.body, callbackRequest(entry));
      await this.inbox.markDelivered(entry);
      this.retryAttemptByKey.delete(deliveryKey(entry));
      this.clearRetry(deliveryKey(entry));
    } catch {
      this.scheduleRetry(route, entry);
    }
  }

  private scheduleRetry(route: PiCallbackRoute, entry: CallbackInboxEntry): void {
    if (!this.routeIsLive(route)) return;
    const key = deliveryKey(entry);
    if (this.retryTimerByKey.has(key)) return;
    const attempt = (this.retryAttemptByKey.get(key) ?? 0) + 1;
    this.retryAttemptByKey.set(key, attempt);
    const delay = Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt - 1, 5), RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      this.retryTimerByKey.delete(key);
      void this.ensureDelivery(route, entry);
    }, delay);
    timer.unref();
    this.retryTimerByKey.set(key, timer);
  }

  private cancelRouteRetries(controllerId: string): void {
    for (const [key, timer] of this.retryTimerByKey) {
      if (!key.startsWith(`${controllerId}\u0000`)) continue;
      clearTimeout(timer);
      this.retryTimerByKey.delete(key);
      this.retryAttemptByKey.delete(key);
    }
  }

  private clearRetry(key: string): void {
    const timer = this.retryTimerByKey.get(key);
    if (timer) clearTimeout(timer);
    this.retryTimerByKey.delete(key);
  }

  private assertActive(): void {
    if (!this.active) throw new Error("Pi AKK route table is stopped");
  }

  private routeIsLive(route: PiCallbackRoute): boolean {
    if (!this.active || this.routeByControllerId.get(route.controllerId) !== route) {
      return false;
    }
    try {
      return route.target.sessionId === route.sessionId &&
        route.target.runtimeGeneration === route.runtimeGeneration &&
        route.target.anchorLeafId === route.anchorLeafId &&
        route.target.isLive();
    } catch {
      return false;
    }
  }
}

function validateTarget(target: PiCallbackTarget): void {
  if (
    typeof target.authority !== "object" ||
    target.authority === null ||
    !validIdentity(target.sessionId) ||
    !validIdentity(target.runtimeGeneration) ||
    (target.anchorLeafId !== null && !validIdentity(target.anchorLeafId)) ||
    typeof target.isLive !== "function" ||
    typeof target.deliver !== "function"
  ) {
    throw new Error("Pi AKK callback target is invalid");
  }
}

function callbackRequest(entry: CallbackInboxEntry): CallbackRequest {
  return {
    controllerId: entry.controllerId,
    deliveryId: entry.deliveryId,
    messageId: entry.messageId,
    idempotencyKey: entry.idempotencyKey,
    body: entry.body,
  };
}

function acknowledgementBase(request: CallbackRequest): CallbackAcknowledgement["request"] {
  return {
    delivery_id: request.deliveryId,
    message_id: request.messageId,
  };
}

function accepted(
  request: CallbackAcknowledgement["request"],
  acceptanceId: string,
): CallbackAcknowledgement {
  return { request, result: { status: "accepted", acceptance_id: acceptanceId } };
}

function retry(
  request: CallbackAcknowledgement["request"],
  errorCode: string,
): CallbackAcknowledgement {
  return { request, result: { status: "retry", error_code: errorCode } };
}

function rejected(
  request: CallbackAcknowledgement["request"],
  errorCode: string,
): CallbackAcknowledgement {
  return { request, result: { status: "rejected", error_code: errorCode } };
}

function validRequest(request: CallbackRequest): boolean {
  return validIdentity(request.controllerId) &&
    validIdentity(request.deliveryId) &&
    validIdentity(request.messageId) &&
    validIdentity(request.idempotencyKey) &&
    typeof request.body === "string";
}

function validIdentity(value: string): boolean {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function identityDigest(sessionId: string, generation: string): string {
  return createHash("sha256")
    .update(JSON.stringify([sessionId, generation]))
    .digest("base64url")
    .slice(0, 22);
}

function deliveryKey(entry: Pick<CallbackRequest, "controllerId" | "idempotencyKey">): string {
  return `${entry.controllerId}\u0000${entry.idempotencyKey}`;
}

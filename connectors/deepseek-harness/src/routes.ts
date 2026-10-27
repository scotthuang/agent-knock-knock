import { createHash, randomBytes } from "node:crypto";

import type { Agent } from "@deepseek-ai/dsh-agent";
import type { DurableCallbackAuthority, DurableRouteRecord } from "./callback-authority.js";
import type { DshRecoveryHostPorts } from "./host-ports.js";

// DSH 0.2 removed the catch-all plugin source. Each producer owns one kind;
// declaration merging is also supported by the older reviewed Host releases.
declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "agent-knock-knock": {
      readonly kind: "agent-knock-knock";
      readonly form: "notice";
      readonly summary: string;
    };
  }
}

export type CreateUserMessage =
  typeof import("@deepseek-ai/dsh-llm")["createUserMessage"];

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

export interface AgentRoute {
  readonly controllerId: string;
  readonly agent: Agent;
}

export interface LiveAgentLookup {
  get(agentId: Agent["id"]): Agent | undefined;
}

export interface RecoverableCallbackPorts {
  readonly authority: DurableCallbackAuthority;
  readonly host: DshRecoveryHostPorts;
  readonly callbackRoute?: (controllerId: string) =>
    Parameters<DurableCallbackAuthority["registerCallbackRoute"]>[1];
}

interface AcceptedDelivery {
  readonly fingerprint: string;
  readonly acceptanceId: string;
}

/**
 * Process-local routing authority from an unguessable controller id to one
 * exact DSH Agent object. Agent.id alone is deliberately insufficient: a
 * replacement Agent with the same Session id must never inherit an old route.
 */
export class AgentRouteTable {
  // bind() alone owns the stable command controller for each live Agent.
  // Several historical callback controllers may resolve to that same Agent.
  private readonly routeByAgent = new WeakMap<Agent, AgentRoute>();
  private readonly disposedAgents = new WeakSet<Agent>();
  private readonly routeByControllerId = new Map<string, AgentRoute>();
  private readonly accepted = new Map<string, AcceptedDelivery>();
  private readonly deliveries = new Map<string, Promise<CallbackAcknowledgement>>();
  private readonly admissions = new Map<string, "admitted" | "uncertain">();
  private readonly claimedControllers = new Map<string, Agent>();
  private readonly restoring = new Map<string, Promise<AgentRoute>>();
  private nextAgentNonce = 0;
  private active = true;

  constructor(
    private readonly agents: LiveAgentLookup,
    private readonly createUserMessage: CreateUserMessage,
    private readonly instanceNonce = randomBytes(12).toString("hex"),
    private readonly recovery?: RecoverableCallbackPorts,
  ) {}

  bind(agent: Agent): AgentRoute {
    this.assertActive();
    if (this.agents.get(agent.id) !== agent) {
      throw new Error("AKK requires the exact live DeepSeek Harness Agent");
    }
    if (this.disposedAgents.has(agent)) {
      throw new Error("AKK cannot reuse a disposed DeepSeek Harness Agent");
    }
    const existing = this.routeByAgent.get(agent);
    if (existing) {
      // Commands keep their controller while registering the current Profile
      // contract for future recovery. Callback aliases never change this key.
      if (this.recovery?.callbackRoute) this.recovery.authority.registerCallbackRoute(
        existing.controllerId, this.recovery.callbackRoute(existing.controllerId),
      );
      return existing;
    }

    this.nextAgentNonce += 1;
    let controllerId = [
      "akk-dsh",
      this.instanceNonce,
      this.recovery ? randomBytes(12).toString("hex") : this.nextAgentNonce.toString(36),
      Buffer.from(String(agent.id), "utf8").toString("base64url"),
    ].join(":");
    if (this.recovery) {
      const identity = this.recovery.host.sessionIdentity(agent);
      let persisted = this.recovery.authority.bindRoute(identity, controllerId);
      const claimed = this.claimedControllers.get(persisted.controllerId);
      if (claimed && claimed !== agent) {
        // A replacement may own new commands, but must never inherit the
        // previous live object's callback controller within this Host run.
        persisted = this.recovery.authority.bindFreshRoute(identity, controllerId);
      }
      controllerId = persisted.controllerId;
      if (this.recovery.callbackRoute) this.recovery.authority.registerCallbackRoute(
        controllerId, this.recovery.callbackRoute(controllerId),
      );
      this.claimedControllers.set(controllerId, agent);
    }
    const route = Object.freeze({ controllerId, agent });
    this.routeByAgent.set(agent, route);
    this.routeByControllerId.set(controllerId, route);
    return route;
  }

  disposeAgent(agent: Agent): void {
    this.disposedAgents.add(agent);
    const route = this.routeByAgent.get(agent);
    if (route && this.routeByControllerId.get(route.controllerId)?.agent === agent) {
      this.routeByControllerId.delete(route.controllerId);
    }
  }

  deliver(request: CallbackRequest): CallbackAcknowledgement {
    const base = acknowledgementBase(request);
    if (!this.active || !validRequest(request)) {
      return rejected(base, "invalid_or_stopped_callback_route");
    }
    if (this.recovery) return retry(base, "callback_requires_durable_delivery");

    const deliveryKey = `${request.controllerId}\u0000${request.idempotencyKey}`;
    const fingerprint = requestFingerprint(request);
    const previous = this.accepted.get(deliveryKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return rejected(base, "idempotency_collision");
      }
      return accepted(base, previous.acceptanceId);
    }

    const route = this.routeByControllerId.get(request.controllerId);
    if (!route || this.agents.get(route.agent.id) !== route.agent) {
      return rejected(base, "agent_route_not_live");
    }

    const message = this.createUserMessage({
      content: [{ type: "text", text: request.body }],
      source: {
        kind: "agent-knock-knock",
        form: "notice",
        summary: "AKK terminal update",
      },
    });

    try {
      // Do not yield between reading status and inbox admission. Running Agents
      // receive next-step context without a redundant wake; idle Agents receive
      // a normal waking follow-up turn.
      if (route.agent.status === "running") {
        route.agent.inject(message);
      } else if (route.agent.status === "idle") {
        route.agent.followup(message);
      } else {
        return rejected(base, "agent_status_invalid");
      }
    } catch {
      return retry(base, "agent_inbox_admission_failed");
    }

    const acceptanceId = String(message.id);
    this.accepted.set(deliveryKey, { fingerprint, acceptanceId });
    return accepted(base, acceptanceId);
  }

  /** Serialize one delivery through durable admission and acknowledgement. */
  deliverRecoverable(request: CallbackRequest): Promise<CallbackAcknowledgement> {
    if (!this.recovery) return Promise.resolve(this.deliver(request));
    const base = acknowledgementBase(request);
    if (!this.active || !validRequest(request)) {
      return Promise.resolve(rejected(base, "invalid_or_stopped_callback_route"));
    }
    const key = `${request.controllerId}\u0000${request.idempotencyKey}`;
    const prior = this.deliveries.get(key);
    const pending = (prior ?? Promise.resolve()).then(() => this.deliverDurably(request, key))
      .catch(() => this.active ? retry(base, "callback_recovery_unavailable")
        : rejected(base, "invalid_or_stopped_callback_route"));
    this.deliveries.set(key, pending);
    void pending.finally(() => {
      if (this.deliveries.get(key) === pending) this.deliveries.delete(key);
    });
    return pending;
  }

  private async deliverDurably(request: CallbackRequest, key: string): Promise<CallbackAcknowledgement> {
    const base = acknowledgementBase(request);
    const recovery = this.recovery!;
    if (!this.active) return rejected(base, "invalid_or_stopped_callback_route");
    const persisted = recovery.authority.getRoute(request.controllerId);
    if (!persisted) return rejected(base, "callback_controller_unauthorized");
    const claimed = this.claimedControllers.get(request.controllerId);
    if (claimed && !this.isLive(claimed)) return rejected(base, "agent_route_not_live");
    const fingerprint = requestFingerprint(request);
    let record = recovery.authority.readDelivery(request.controllerId, request.idempotencyKey);
    if (record && record.requestFingerprint !== fingerprint) return rejected(base, "idempotency_collision");
    if (record?.state === "accepted") return accepted(base, record.messageId);
    const route = await this.restoreRoute(persisted);
    if (!this.currentRoute(route, persisted)) return rejected(base, "agent_route_not_live");

    let message = this.createUserMessage({
      content: [{ type: "text", text: request.body }],
      source: { kind: "agent-knock-knock", form: "notice", summary: "AKK terminal update" },
    });
    let admitted = this.admissions.get(key) === "admitted";
    if (record) {
      // The Host must flush and inspect complete, own-session message events.
      // An unreadable inventory throws; absence is never inferred from error.
      admitted = await recovery.host.findOwnMessage(route.agent, record.messageId) || admitted;
      if (!this.currentRoute(route, persisted)) return rejected(base, "agent_route_not_live");
      if (!admitted && this.admissions.has(key)) return retry(base, "agent_inbox_admission_uncertain");
      message = { ...message, id: record.messageId as typeof message.id };
    } else {
      record = recovery.authority.prepareDelivery(request.controllerId, request.idempotencyKey, {
        requestFingerprint: fingerprint, messageId: String(message.id),
      });
    }
    if (!admitted) {
      if (!this.currentRoute(route, persisted)) return rejected(base, "agent_route_not_live");
      if (route.agent.status !== "running" && route.agent.status !== "idle") {
        return rejected(base, "agent_status_invalid");
      }
      this.admissions.set(key, "uncertain");
      try {
        if (route.agent.status === "running") route.agent.inject(message);
        else route.agent.followup(message);
        this.admissions.set(key, "admitted");
      } catch {
        return retry(base, "agent_inbox_admission_uncertain");
      }
    }
    if (!await recovery.host.flush(route.agent)) return retry(base, "agent_session_not_durable");
    if (!this.currentRoute(route, persisted)) return rejected(base, "agent_route_not_live");
    recovery.authority.acceptDelivery(request.controllerId, request.idempotencyKey, {
      requestFingerprint: fingerprint, messageId: record.messageId,
    });
    return accepted(base, record.messageId);
  }

  private isLive(agent: Agent): boolean {
    return this.active && !this.disposedAgents.has(agent) && this.agents.get(agent.id) === agent;
  }

  private currentRoute(route: AgentRoute, persisted: DurableRouteRecord): boolean {
    if (!this.isLive(route.agent)) return false;
    const identity = this.recovery!.host.sessionIdentity(route.agent);
    return identity.sessionId === persisted.sessionId &&
      identity.headerFingerprint === persisted.headerFingerprint;
  }

  private async restoreRoute(persisted: DurableRouteRecord): Promise<AgentRoute> {
    const existing = this.routeByControllerId.get(persisted.controllerId);
    if (existing) return existing;
    const restoring = this.restoring.get(persisted.controllerId);
    if (restoring) return restoring;
    const pending = (async () => {
      const agent = await this.recovery!.host.restoreAgent(persisted);
      const route = Object.freeze({ controllerId: persisted.controllerId, agent });
      if (!this.currentRoute(route, persisted)) throw new Error("Restored Agent identity does not match callback authority");
      const claimed = this.claimedControllers.get(persisted.controllerId);
      if (claimed && claimed !== agent) throw new Error("Callback Agent was replaced during recovery");
      this.claimedControllers.set(persisted.controllerId, agent);
      this.routeByControllerId.set(persisted.controllerId, route);
      return route;
    })();
    this.restoring.set(persisted.controllerId, pending);
    try { return await pending; }
    finally { this.restoring.delete(persisted.controllerId); }
  }

  close(): void {
    this.active = false;
    this.routeByControllerId.clear();
  }

  private assertActive(): void {
    if (!this.active) {
      throw new Error("DeepSeek Harness AKK route table is stopped");
    }
  }
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

function requestFingerprint(request: CallbackRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([
      request.controllerId,
      request.deliveryId,
      request.messageId,
      request.idempotencyKey,
      request.body,
    ]))
    .digest("hex");
}

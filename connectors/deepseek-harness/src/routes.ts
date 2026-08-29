import { createHash, randomBytes } from "node:crypto";

import type { Agent } from "@deepseek-ai/dsh-agent";

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
  private readonly routeByAgent = new WeakMap<Agent, AgentRoute>();
  private readonly disposedAgents = new WeakSet<Agent>();
  private readonly routeByControllerId = new Map<string, AgentRoute>();
  private readonly accepted = new Map<string, AcceptedDelivery>();
  private nextAgentNonce = 0;
  private active = true;

  constructor(
    private readonly agents: LiveAgentLookup,
    private readonly createUserMessage: CreateUserMessage,
    private readonly instanceNonce = randomBytes(12).toString("hex"),
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
    if (existing) return existing;

    this.nextAgentNonce += 1;
    const controllerId = [
      "akk-dsh",
      this.instanceNonce,
      this.nextAgentNonce.toString(36),
      Buffer.from(String(agent.id), "utf8").toString("base64url"),
    ].join(":");
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
        kind: "plugin",
        plugin: "agent-knock-knock",
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

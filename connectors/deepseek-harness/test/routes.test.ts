import assert from "node:assert/strict";
import test from "node:test";

import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { AgentRouteTable, type CallbackRequest } from "../src/routes.js";

interface FakeAgentState {
  agent: Agent;
  readonly followed: unknown[];
  readonly injected: unknown[];
  failAdmission: boolean;
}

test("routes idle callbacks to followup and running callbacks to inject", () => {
  const registry = new Map<Agent["id"], Agent>();
  const idle = fakeAgent("session-idle", "idle");
  const running = fakeAgent("session-running", "running");
  registry.set(idle.agent.id, idle.agent);
  registry.set(running.agent.id, running.agent);
  const routes = new AgentRouteTable(
    { get: (id) => registry.get(id) },
    createUserMessage,
    "host",
  );
  const idleRoute = routes.bind(idle.agent);
  const runningRoute = routes.bind(running.agent);

  const idleAck = routes.deliver(request(idleRoute.controllerId, "idle"));
  const runningAck = routes.deliver(request(runningRoute.controllerId, "running"));
  assert.equal(idleAck.result.status, "accepted");
  assert.equal(runningAck.result.status, "accepted");
  assert.equal(idle.followed.length, 1);
  assert.equal(idle.injected.length, 0);
  assert.equal(running.followed.length, 0);
  assert.equal(running.injected.length, 1);

  const message = idle.followed[0] as {
    content: Array<{ type: string; text: string }>;
    source: Record<string, unknown>;
  };
  assert.deepEqual(message.content, [{ type: "text", text: "body-idle" }]);
  assert.deepEqual(message.source, {
    kind: "plugin",
    plugin: "agent-knock-knock",
    form: "notice",
    summary: "AKK terminal update",
  });
});

test("deduplicates exact callbacks and rejects an idempotency collision", () => {
  const state = fakeAgent("session-one", "idle");
  const registry = new Map([[state.agent.id, state.agent]]);
  const routes = new AgentRouteTable(
    { get: (id) => registry.get(id) },
    createUserMessage,
    "host",
  );
  const route = routes.bind(state.agent);
  const original = request(route.controllerId, "same");
  const first = routes.deliver(original);
  const duplicate = routes.deliver(original);
  const collision = routes.deliver({ ...original, body: "different" });

  assert.equal(first.result.status, "accepted");
  assert.equal(duplicate.result.status, "accepted");
  assert.equal(duplicate.result.acceptance_id, first.result.acceptance_id);
  assert.equal(state.followed.length, 1);
  assert.deepEqual(collision.result, {
    status: "rejected",
    error_code: "idempotency_collision",
  });
});

test("does not let a replacement Agent inherit an old exact route", () => {
  const first = fakeAgent("same-session", "idle");
  const registry = new Map([[first.agent.id, first.agent]]);
  const routes = new AgentRouteTable(
    { get: (id) => registry.get(id) },
    createUserMessage,
    "host",
  );
  const firstRoute = routes.bind(first.agent);

  const replacement = fakeAgent("same-session", "idle");
  registry.set(replacement.agent.id, replacement.agent);
  const oldAck = routes.deliver(request(firstRoute.controllerId, "old"));
  const replacementRoute = routes.bind(replacement.agent);
  const newAck = routes.deliver(request(replacementRoute.controllerId, "new"));

  assert.equal(oldAck.result.status, "rejected");
  assert.equal(oldAck.result.error_code, "agent_route_not_live");
  assert.notEqual(replacementRoute.controllerId, firstRoute.controllerId);
  assert.equal(newAck.result.status, "accepted");
  assert.equal(first.followed.length, 0);
  assert.equal(replacement.followed.length, 1);
});

test("returns retry only when synchronous inbox admission throws", () => {
  const state = fakeAgent("session-error", "idle");
  state.failAdmission = true;
  const registry = new Map([[state.agent.id, state.agent]]);
  const routes = new AgentRouteTable(
    { get: (id) => registry.get(id) },
    createUserMessage,
    "host",
  );
  const route = routes.bind(state.agent);

  const failed = routes.deliver(request(route.controllerId, "retry"));
  assert.deepEqual(failed.result, {
    status: "retry",
    error_code: "agent_inbox_admission_failed",
  });
  state.failAdmission = false;
  assert.equal(routes.deliver(request(route.controllerId, "retry")).result.status, "accepted");
});

function fakeAgent(id: string, status: "idle" | "running"): FakeAgentState {
  const followed: unknown[] = [];
  const injected: unknown[] = [];
  const state: FakeAgentState = {
    agent: undefined as unknown as Agent,
    followed,
    injected,
    failAdmission: false,
  };
  state.agent = {
    id,
    status,
    followup(message: unknown) {
      if (state.failAdmission) throw new Error("failed");
      followed.push(message);
    },
    inject(message: unknown) {
      if (state.failAdmission) throw new Error("failed");
      injected.push(message);
    },
  } as unknown as Agent;
  return state;
}

function request(controllerId: string, suffix: string): CallbackRequest {
  return {
    controllerId,
    deliveryId: `delivery-${suffix}`,
    messageId: `message-${suffix}`,
    idempotencyKey: `key-${suffix}`,
    body: `body-${suffix}`,
  };
}

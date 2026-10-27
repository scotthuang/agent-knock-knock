import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

import { AgentRouteTable, type CallbackRequest } from "../src/routes.js";
import { openCallbackAuthority } from "../src/callback-authority.js";
import type { DshRecoveryHostPorts } from "../src/host-ports.js";

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
    kind: "agent-knock-knock",
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

test("durable routes restore their original session and deduplicate accepted callbacks after restart", async (t) => {
  const fixture = durableFixture(t);
  const original = fixture.routes.bind(fixture.state.agent);
  const callback = request(original.controllerId, "restart");
  const first = await fixture.routes.deliverRecoverable(callback);
  assert.equal(first.result.status, "accepted");
  assert.equal(fixture.persisted.size, 1, "acceptance follows durable own-session persistence");
  fixture.profileRevision = "profile-B";
  fixture.restart();
  const duplicate = await fixture.routes.deliverRecoverable(callback);
  assert.deepEqual(duplicate, first);
  assert.equal(fixture.restorations, 0, "accepted receipts do not wake a restored session");
  assert.equal(fixture.state.followed.length, 0);
  const next = await fixture.routes.deliverRecoverable(request(original.controllerId, "next"));
  assert.equal(next.result.status, "accepted");
  assert.equal(fixture.restorations, 1);
  assert.equal(fixture.state.followed.length, 1);
  assert.equal(fixture.routes.bind(fixture.state.agent).controllerId, original.controllerId);
  fixture.profileRevision = "profile-C";
  fixture.restart();
  assert.deepEqual(fixture.authority.callbackRoutes().map((route) => route.profile_revision),
    ["profile-A", "profile-B"],
    "commands bound to a restored Agent in Profile B remain recoverable by Profile C");
  assert.equal((await fixture.routes.deliverRecoverable({ ...callback, body: "changed" })).result.error_code,
    "idempotency_collision");
  assert.equal((await fixture.routes.deliverRecoverable(request("unregistered-controller", "foreign"))).result.status,
    "rejected");
});

test("prepared callback recovery requires definite own-session evidence and preserves its precreated message ID", async (t) => {
  const fixture = durableFixture(t);
  const route = fixture.routes.bind(fixture.state.agent);
  const callback = request(route.controllerId, "prepared");
  fixture.state.failAdmission = true;
  assert.equal((await fixture.routes.deliverRecoverable(callback)).result.status, "retry");
  const prepared = fixture.authority.readDelivery(route.controllerId, callback.idempotencyKey)!;
  assert.equal(prepared.state, "prepared");
  fixture.state.failAdmission = false;
  assert.equal((await fixture.routes.deliverRecoverable(callback)).result.error_code, "agent_inbox_admission_uncertain");
  assert.equal(fixture.state.followed.length, 0, "an uncertain same-process admission is never blindly replayed");
  fixture.restart();
  fixture.inventoryUnavailable = true;
  assert.equal((await fixture.routes.deliverRecoverable(callback)).result.status, "retry");
  assert.equal(fixture.state.followed.length, 0);
  fixture.inventoryUnavailable = false;
  const recovered = await fixture.routes.deliverRecoverable(callback);
  assert.equal(recovered.result.status, "accepted");
  assert.equal(recovered.result.acceptance_id, prepared.messageId);
  assert.equal((fixture.state.followed[0] as { id: string }).id, prepared.messageId);
  assert.equal(fixture.state.followed.length, 1);
});

test("a durable message whose receipt write failed is acknowledged after restart without reinjection", async (t) => {
  const fixture = durableFixture(t);
  const route = fixture.routes.bind(fixture.state.agent);
  const callback = request(route.controllerId, "persisted-message");
  fixture.authority.acceptDelivery = () => { throw new Error("receipt storage unavailable"); };
  assert.equal((await fixture.routes.deliverRecoverable(callback)).result.status, "retry");
  const prepared = fixture.authority.readDelivery(route.controllerId, callback.idempotencyKey)!;
  assert.equal(prepared.state, "prepared");
  assert.ok(fixture.persisted.has(prepared.messageId));
  fixture.restart();
  const acknowledgement = await fixture.routes.deliverRecoverable(callback);
  assert.equal(acknowledgement.result.acceptance_id, prepared.messageId);
  assert.equal(acknowledgement.result.status, "accepted");
  assert.equal(fixture.state.followed.length, 0, "the original session already persisted this exact message");
});

test("durable delivery waits for flush, serializes duplicates, and fences closed or replaced live Agents", async (t) => {
  const fixture = durableFixture(t);
  const route = fixture.routes.bind(fixture.state.agent);
  const callback = request(route.controllerId, "concurrent");
  let release!: () => void;
  let entered!: () => void;
  const flushing = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  fixture.flushGate = async () => { entered(); await gate; };
  const first = fixture.routes.deliverRecoverable(callback);
  const duplicate = fixture.routes.deliverRecoverable(callback);
  const collision = fixture.routes.deliverRecoverable({ ...callback, body: "different" });
  await flushing;
  assert.equal(fixture.authority.readDelivery(route.controllerId, callback.idempotencyKey)?.state, "prepared");
  assert.equal(fixture.state.followed.length, 1);
  release();
  const [accepted, replay, rejected] = await Promise.all([first, duplicate, collision]);
  assert.equal(accepted.result.status, "accepted");
  assert.deepEqual(replay, accepted);
  assert.equal(rejected.result.error_code, "idempotency_collision");
  assert.equal(fixture.state.followed.length, 1);

  fixture.flushGate = undefined;
  fixture.flushAvailable = false;
  const pending = request(route.controllerId, "flush-retry");
  assert.equal((await fixture.routes.deliverRecoverable(pending)).result.status, "retry");
  assert.equal(fixture.authority.readDelivery(route.controllerId, pending.idempotencyKey)?.state, "prepared");
  fixture.flushAvailable = true;
  assert.equal((await fixture.routes.deliverRecoverable(pending)).result.status, "accepted");
  assert.equal(fixture.state.followed.length, 2, "flush retry must not admit the message twice");

  const replacement = fakeAgent(String(fixture.state.agent.id), "idle");
  fixture.registry.set(replacement.agent.id, replacement.agent);
  assert.equal((await fixture.routes.deliverRecoverable(request(route.controllerId, "replacement"))).result.error_code,
    "agent_route_not_live");
  const replacementRoute = fixture.routes.bind(replacement.agent);
  assert.notEqual(replacementRoute.controllerId, route.controllerId);
  assert.equal(replacement.followed.length, 0);
  fixture.state = replacement;
  assert.equal((await fixture.routes.deliverRecoverable(request(replacementRoute.controllerId, "new-command"))).result.status,
    "accepted");
  assert.equal(replacement.followed.length, 1);
  assert.equal((await fixture.routes.deliverRecoverable(request(route.controllerId, "still-old"))).result.error_code,
    "agent_route_not_live");
  fixture.routes.close();
  assert.equal((await fixture.routes.deliverRecoverable(callback)).result.status, "rejected");
});

function durableFixture(t: test.TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-route-"));
  const options = { profileDirectory: directory, storeDirectory: path.join(directory, "store") };
  const registry = new Map<Agent["id"], Agent>();
  const persisted = new Set<string>();
  const fixture = {
    state: fakeAgent("original-session", "idle"), registry, persisted,
    authority: openCallbackAuthority(options),
    routes: undefined as unknown as AgentRouteTable,
    restorations: 0, inventoryUnavailable: false, flushAvailable: true, profileRevision: "profile-A",
    flushGate: undefined as (() => Promise<void>) | undefined,
    restart() {
      fixture.routes.close();
      fixture.authority.close();
      fixture.authority = openCallbackAuthority(options);
      fixture.state = fakeAgent("original-session", "idle");
      registry.clear();
      fixture.routes = makeRoutes();
    },
  };
  const host: DshRecoveryHostPorts = {
    sessionIdentity(agent) {
      return { sessionId: String(agent.id), headerFingerprint: "a".repeat(64) };
    },
    async restoreAgent(route) {
      assert.equal(route.sessionId, "original-session");
      assert.equal(route.headerFingerprint, "a".repeat(64));
      fixture.restorations += 1;
      registry.set(fixture.state.agent.id, fixture.state.agent);
      return fixture.state.agent;
    },
    async flush(agent) {
      assert.equal(agent, fixture.state.agent);
      await fixture.flushGate?.();
      if (!fixture.flushAvailable) return false;
      for (const message of [...fixture.state.followed, ...fixture.state.injected]) {
        persisted.add(String((message as { id: string }).id));
      }
      return true;
    },
    async findOwnMessage(agent, id) {
      if (fixture.inventoryUnavailable || !await host.flush(agent)) throw new Error("own-session events unavailable");
      return persisted.has(id);
    },
  };
  function makeRoutes() {
    return new AgentRouteTable({ get: (id) => registry.get(id) }, createUserMessage, "host",
      { authority: fixture.authority, host, callbackRoute: (controllerId) => ({
        schema: "agent-knock-knock/callback-route", version: 1, transport: "command_json_v1",
        profile_id: "deepseek-harness-native", profile_revision: fixture.profileRevision,
        controller_session_id: controllerId, capabilities: { wake: true, respond: true },
      }) });
  }
  registry.set(fixture.state.agent.id, fixture.state.agent);
  fixture.routes = makeRoutes();
  t.after(() => { fixture.routes.close(); fixture.authority.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return fixture;
}

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

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { Agent } from "@deepseek-ai/dsh-agent";

import { createDshRecoveryHostPorts, sessionHeaderIdentity } from "../src/host-ports.js";

const header = { id: "session-one", version: 4, createdAt: 1000, cwd: "/project", isSeeded: false };

test("session authority changes with immutable generation and lineage, not logical format upgrades", () => {
  const original = sessionHeaderIdentity(header);
  assert.deepEqual(sessionHeaderIdentity({ ...header, version: 5 }), original);
  for (const change of [{ createdAt: 1001 }, { cwd: "/other" }, { parentSession: "parent", isSeeded: true }, { agentPreset: "another" }]) {
    assert.notEqual(sessionHeaderIdentity({ ...header, ...change }).headerFingerprint, original.headerFingerprint);
  }
  assert.throws(() => sessionHeaderIdentity({ id: header.id }), /header/u);
  assert.equal(createDshRecoveryHostPorts({}, "/unused"), undefined);
  assert.equal(createDshRecoveryHostPorts({ get: () => undefined }, "/unused"), undefined);
});

test("restore verifies persisted generation before activation and the exact published Agent after activation", async () => {
  const fixture = hostFixture();
  try {
    const route = { controllerId: "controller", ...sessionHeaderIdentity(header) };
    fixture.state.observedHeader = { ...header, createdAt: 2000 };
    await assert.rejects(fixture.ports.restoreAgent(route), /generation/u);
    assert.equal(fixture.state.resumes, 0);
    fixture.state.observedHeader = header;
    assert.equal(await fixture.ports.restoreAgent(route), fixture.agent);
    fixture.state.resolvedAgent = fakeAgent({ ...header, createdAt: 2000 });
    fixture.state.liveAgent = fixture.state.resolvedAgent;
    await assert.rejects(fixture.ports.restoreAgent(route), /generation/u);
    fixture.state.liveAgent = fixture.agent;
    await assert.rejects(fixture.ports.restoreAgent(route), /exact live/u);
  } finally { fixture.remove(); }
});

test("prepared delivery recovery recognizes own durable admission even after consumption or cancellation", async () => {
  const fixture = hostFixture();
  try {
    const inheritedMessage = message("inherited");
    fixture.state.events = [
      { seq: 0, type: "user/message", data: inheritedMessage },
      { seq: 1, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message("own")] } },
      { seq: 2, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [], outcome: "canceled" } },
    ];
    fixture.state.inherited = 1;
    assert.equal(await fixture.ports.findOwnMessage(fixture.agent, "inherited"), false);
    assert.equal(await fixture.ports.findOwnMessage(fixture.agent, "own"), true);
    assert.equal(await fixture.ports.findOwnMessage(fixture.agent, "absent"), false);
    assert.equal(fixture.state.flushes, 3);
    assert.equal(fixture.state.disposals, 3);
  } finally { fixture.remove(); }
});

test("recovery never certifies absence without persistence, a complete observation, and live ownership", async () => {
  const fixture = hostFixture();
  try {
    fixture.state.durable = false;
    await assert.rejects(fixture.ports.findOwnMessage(fixture.agent, "pending"), /durability/u);
    fixture.state.durable = true;
    fixture.state.events = [{ seq: 1, type: "user/message", data: message("pending") }];
    await assert.rejects(fixture.ports.findOwnMessage(fixture.agent, "pending"), /incomplete/u);
    fixture.state.events = [{ seq: 0, type: "user/message", data: { ...message("pending"), source: { kind: "user" } } }];
    await assert.rejects(fixture.ports.findOwnMessage(fixture.agent, "pending"), /another producer/u);
    fixture.state.events = [];
    fixture.state.cursor = 1;
    await assert.rejects(fixture.ports.findOwnMessage(fixture.agent, "pending"), /incomplete/u);
    fixture.state.cursor = undefined;
    fixture.state.liveAgent = fakeAgent(header);
    await assert.rejects(fixture.ports.findOwnMessage(fixture.agent, "pending"), /exact live/u);
  } finally { fixture.remove(); }
});

function hostFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-host-ports-"));
  const agent = fakeAgent(header);
  const state = { observedHeader: header, liveAgent: agent, resolvedAgent: agent, resumes: 0, flushes: 0, disposals: 0,
    events: [] as unknown[], inherited: 0, durable: true, cursor: undefined as number | undefined };
  const services: Record<string, unknown> = {
    profileContext: { dir: root },
    agents: { get: () => state.liveAgent },
    sessions: { get: () => state.liveAgent.session, flush: async () => { state.flushes += 1; return state.durable; } },
    sessionController: { resolveAgent: async () => { state.resumes += 1; return { agent: state.resolvedAgent }; } },
    sessionQuery: { observeSession: async () => ({ header: state.observedHeader, inheritedEventCount: state.inherited,
      events: state.events, cursor: state.cursor ?? state.events.length - 1,
      [Symbol.dispose]() { state.disposals += 1; } }) },
  };
  const ports = createDshRecoveryHostPorts({ get: (name) => services[name] }, path.join(root, "store"));
  assert.ok(ports);
  return { root, agent, state, ports, remove: () => fs.rmSync(root, { recursive: true, force: true }) };
}
function fakeAgent(value: typeof header): Agent {
  return { id: value.id, session: { header: value }, status: "idle" } as unknown as Agent;
}
function message(id: string) {
  return { id, role: "user", content: [{ type: "text", text: "callback" }], source: { kind: "agent-knock-knock", form: "notice", summary: "AKK update" } };
}

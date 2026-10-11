import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createClaudeNativeClient, type ClaudeNativePeerTransport, type ClaudeNativeSendReceipt } from "../src/claude-native-client.js";
import { discoverClaudeNativeSessions, inspectClaudeNativeSession, type ClaudeNativeDiscoveryOptions } from "../src/claude-native-discovery.js";
import { ClaudeNativeError, createClaudeNativeConversationId, isClaudeNativeWatchId, parseClaudeNativeConversationId,
  type ClaudeNativeCatalogEntry, type ClaudeNativeIdentity } from "../src/claude-native-identity.js";

const identity: ClaudeNativeIdentity = { configDir: "/tmp/claude-fixture", sessionId: "11111111-1111-4111-8111-111111111111",
  pid: 123, processStart: "Sun Oct 11 10:20:30 2026" };
function entry(extra: Partial<ClaudeNativeCatalogEntry> = {}): ClaudeNativeCatalogEntry {
  return { ...identity, nativeId: createClaudeNativeConversationId(identity), cwd: "/tmp/project", version: "2.1.296",
    socketPath: "/tmp/cc-socks/123.sock", peerProtocol: 1, peerFeatures: ["notify_idle"], status: "idle", observedAt: new Date().toISOString(), ...extra };
}
const input = () => ({ text: "Only reply READY", inputUuid: randomUUID(), messageId: randomUUID() });
class Peer implements ClaudeNativePeerTransport {
  sent = 0; probes = 0; closed = false;
  senderPid?: number;
  receipt: ClaudeNativeSendReceipt = { dispatchState: "written" };
  probeError?: Error; sendError?: Error;
  async probe() { this.probes++; if (this.probeError) throw this.probeError; }
  async send() { this.sent++; if (this.sendError) throw this.sendError; return this.receipt; }
  close() { this.closed = true; }
}

test("Claude identities fence config, process incarnation and session, not cwd", () => {
  const id = createClaudeNativeConversationId(identity);
  assert.deepEqual(parseClaudeNativeConversationId(id), identity);
  for (const changed of [{ pid: 124 }, { processStart: "Sun Oct 11 10:20:31 2026" }, { configDir: "/tmp/other" }, { sessionId: randomUUID() }]) {
    assert.notEqual(createClaudeNativeConversationId({ ...identity, ...changed }), id);
  }
  assert.throws(() => parseClaudeNativeConversationId(id + "="), /Invalid/u);
  assert.throws(() => createClaudeNativeConversationId({ ...identity, pid: -1 }), /Invalid/u);
  assert.throws(() => createClaudeNativeConversationId({ ...identity, sessionId: "not-a-uuid" }), /Invalid/u);
  assert.equal(isClaudeNativeWatchId("claude-cli-watch:" + randomUUID()), true);
  assert.equal(isClaudeNativeWatchId("codex-cli-watch:" + randomUUID()), false);
});

test("native send rechecks exact identity and idle state after persisted intent; success is only written", async () => {
  const peer = new Peer(), observed: string[] = []; peer.senderPid = 456;
  const c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => { observed.push("inspect"); return entry(); } });
  const receipt = await c.send(identity, { ...input(), beforeDispatch: async (_entry, senderPid) => {
    assert.equal(senderPid, 456); assert.equal(c.senderPid, 456); observed.push("persist");
  } });
  assert.deepEqual(observed, ["inspect", "persist", "inspect"]);
  assert.deepEqual(receipt, { dispatchState: "written", senderPid: 456 }); assert.equal(peer.probes, 2); assert.equal(peer.sent, 1); c.close();
});

test("busy, blocked, unknown and a busy transition never dispatch an independent task", async () => {
  for (const status of ["working", "waiting", "unknown"] as const) {
    const peer = new Peer(), c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => entry({ status }) });
    assert.deepEqual(await c.send(identity, input()), { dispatchState: "not_sent", errorCode: "session_not_idle" });
    assert.equal(peer.sent, 0); c.close();
  }
  const peer = new Peer(); let busy = false;
  const c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => entry({ status: busy ? "working" : "idle" }) });
  assert.equal((await c.send(identity, { ...input(), beforeDispatch: async () => { busy = true; } })).dispatchState, "not_sent");
  assert.equal(peer.sent, 0); c.close();
});

test("peer/identity mismatch is not_sent; a transport exception after dispatch remains uncertain", async () => {
  const peer = new Peer(), c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => entry() });
  peer.probeError = new ClaudeNativeError("peer_identity_mismatch", "wrong peer");
  assert.deepEqual(await c.send(identity, input()), { dispatchState: "not_sent", errorCode: "peer_identity_mismatch" }); assert.equal(peer.sent, 0);
  peer.probeError = undefined; peer.sendError = new Error("connection lost");
  assert.equal((await c.send(identity, input())).dispatchState, "uncertain"); assert.equal(peer.sent, 1); c.close();
  const other = createClaudeNativeClient({ platform: "darwin", peerTransport: new Peer(), inspectSession: async () => entry({ sessionId: randomUUID() }) });
  assert.equal((await other.send(identity, input())).errorCode, "identity_changed"); other.close();
});

test("simultaneous sends to one native incarnation cannot both pass beforeDispatch", async () => {
  const peer = new Peer(), c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => entry() });
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(r => { release = r; }), beginning = new Promise<void>(r => { started = r; });
  const first = c.send(identity, { ...input(), beforeDispatch: async () => { started(); await gate; } });
  await beginning;
  assert.equal((await c.send(identity, input())).errorCode, "send_in_flight"); release(); await first;
  assert.equal(peer.sent, 1); c.close();
});

test("held/refused receipts preserve native semantics and never claim task acceptance", async () => {
  for (const deliveryStatus of ["held", "refused", "expired", "delivered"] as const) {
    const peer = new Peer(); peer.receipt = { dispatchState: "written", deliveryStatus };
    const c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer, inspectSession: async () => entry() });
    assert.deepEqual(await c.send(identity, input()), peer.receipt); c.close();
  }
});

test("native client rejects invalid envelope identities and unsupported platforms before transport", async () => {
  const peer = new Peer(), c = createClaudeNativeClient({ platform: "linux", peerTransport: peer, inspectSession: async () => entry() });
  assert.equal((await c.send(identity, input())).errorCode, "unsupported_platform");
  await assert.rejects(c.send(identity, { ...input(), inputUuid: "bad" }), /UUID/u);
  await assert.rejects(c.send(identity, { ...input(), text: "a".repeat(256 * 1024 + 1) }), /bounded/u);
  assert.equal(peer.probes, 0); c.close(); assert.equal(peer.closed, true);
  await assert.rejects(c.inspect(identity), /closed/u);
});

test("discovery does not advertise an owned socket as live until its peer identity is verified", async () => {
  const peer = new Peer(); peer.probeError = new ClaudeNativeError("peer_identity_mismatch", "wrong process");
  const c = createClaudeNativeClient({ platform: "darwin", peerTransport: peer,
    discoverSessions: async () => ({ sessions: [entry()], errors: [] }) });
  const result = await c.discover(); assert.equal(result.sessions.length, 0);
  assert.equal(result.errors[0].code, "peer_identity_mismatch"); assert.equal(peer.sent, 0); c.close();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "akk-cc-discovery-")), configDir = path.join(root, "config");
  await mkdir(path.join(configDir, "sessions"), { recursive: true, mode: 0o700 });
  const socketPath = path.join(root, "123.sock"), server = net.createServer(c => c.end());
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600);
  const m: Record<string, unknown> = { pid: 123, sessionId: identity.sessionId, procStart: identity.processStart, cwd: "/tmp/project",
    status: "idle", version: "2.1.999", messagingSocketPath: socketPath, peerProtocol: 1, peerFeatures: ["notify_idle"] };
  const row: Record<string, unknown> = { kind: "interactive", pid: 123, sessionId: identity.sessionId, cwd: "/tmp/project", status: "idle", name: "Fixture" };
  const save = () => writeFile(path.join(configDir, "sessions", "123.json"), JSON.stringify(m), { mode: 0o600 }); await save();
  let ps = `${process.getuid?.()} ${identity.processStart}`;
  const options: ClaudeNativeDiscoveryOptions = { platform: "darwin", configDirs: [configDir], run: async (file, _args, env) => {
    if (file !== "/bin/ps") return JSON.stringify([row]);
    assert.equal(env?.TZ, "UTC"); assert.equal(env?.LC_ALL, "C"); return ps;
  } };
  return { root, configDir, m, row, options, save, setPs: (value: string) => { ps = value; }, cleanup: async () => {
    await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true });
  } };
}
test("discovery uses live registry plus exact OS identity, accepts contract-valid new versions and fails closed on protocol drift", async () => {
  const f = await fixture();
  try {
    let result = await discoverClaudeNativeSessions(f.options);
    assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].version, "2.1.999");
    assert.equal(result.sessions[0].status, "idle");
    const selected = result.sessions[0];
    f.m.peerProtocol = 2; await f.save();
    result = await discoverClaudeNativeSessions(f.options); assert.equal(result.sessions.length, 0); assert.equal(result.errors[0].code, "unsupported_contract");
    f.m.peerProtocol = 1; f.m.sessionId = randomUUID(); await f.save();
    await assert.rejects(inspectClaudeNativeSession(selected, f.options), /no longer/u);
    f.m.sessionId = identity.sessionId; await f.save(); f.setPs(`${process.getuid?.()} Sun Oct 11 10:20:31 2026`);
    result = await discoverClaudeNativeSessions(f.options); assert.equal(result.errors[0].code, "process_changed");
  } finally { await f.cleanup(); }
});
test("discovery never treats disagreeing states or unsafe registry ownership as sendable", async () => {
  const f = await fixture();
  try {
    f.row.status = "busy";
    assert.equal((await discoverClaudeNativeSessions(f.options)).sessions[0].status, "unknown");
    f.m.status = "busy"; await f.save();
    assert.equal((await discoverClaudeNativeSessions(f.options)).sessions[0].status, "working");
    await chmod(path.join(f.configDir, "sessions", "123.json"), 0o666);
    const result = await discoverClaudeNativeSessions(f.options);
    assert.equal(result.sessions.length, 0); assert.equal(result.errors[0].code, "unsafe_metadata");
  } finally { await f.cleanup(); }
});

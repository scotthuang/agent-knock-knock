import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createDesktopConversationId } from "../src/desktop-identity.js";
import { createAkkSemanticToolCatalog } from "../src/semantic-tool-runtime.js";
import { bindSemanticToolRelayPath } from "../src/semantic-tool-relay.js";
import { toolResult, withTurnIdentity } from "../src/semantic-tool-presentation.js";

const target = { codexHome: "/test/codex-home", hostId: "local", threadId: "thread-desktop-one" };
const desktopId = createDesktopConversationId(target);
const controller = { sessionKey: "agent:test:desktop-controller", sessionId: "controller-incarnation-one" };
const watchId = "desktop-watch:acceptance-one";
const terminalId = "terminal:v2:tmux:codex:test:0.0:1234";
const accepted = () => ({ source: "codex_desktop", conversation_id: desktopId, watch_id: watchId,
  native_thread_id: target.threadId, native_turn_id: "native-turn-one", status: "watching",
  delivered: true, agent_acceptance: "proven", send_state: "accepted", delivery_receipt: "native_task_verified",
  callback_expected: true, capabilities: { interaction_respond: false, approve: false } });

type Result = { details: Record<string, any>; content: { text: string }[]; isError?: boolean };
function harness(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-desktop-semantic-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const relay = path.join(directory, "fake-relay.cjs"), calls = path.join(directory, "calls.jsonl"), reply = path.join(directory, "reply.json");
  fs.writeFileSync(reply, JSON.stringify(accepted()));
  // This relay only records arguments and returns fixtures. It never imports AKK CLI or connects to IPC.
  fs.writeFileSync(relay, `const fs = require("node:fs");\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n");\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(reply)}, "utf8"));\n`);
  const owner = { pluginConfig: { storeDir: path.join(directory, "store"), openclawBin: "/test/openclaw",
    codexHome: target.codexHome, agentHardTimeoutMinutes: 90 }, logger: { info() {}, warn() {} } };
  bindSemanticToolRelayPath(owner, relay);
  const catalog = createAkkSemanticToolCatalog(owner, new Map());
  return {
    async execute(name: string, args: Record<string, unknown>, callId = "call-desktop-one", context: Record<string, unknown> = controller): Promise<Result> {
      const tool = catalog.tools.find(entry => entry.name === `agent_knock_knock_${name}`);
      assert.ok(tool);
      return await tool.execute(context, callId, args) as Result;
    },
    calls: (): string[][] => fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    reply: (value: unknown) => fs.writeFileSync(reply, JSON.stringify(value)),
    store: owner.pluginConfig.storeDir
  };
}
const argument = (args: string[], flag: string): string | undefined => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

test("Desktop semantic Send goes directly to its conversation and binds stable IDs to controller incarnation", async t => {
  const h = harness(t);
  const result = await h.execute("send", { conversation_id: desktopId, request: "One benign task", type: "task", agentHardTimeoutMinutes: 5 });
  assert.equal(result.isError, undefined);
  assert.equal(result.details.conversation_id, desktopId);
  assert.equal(result.details.watch_id, watchId);
  assert.equal("session_id" in result.details, false);
  assert.equal("turn_id" in result.details, false);
  await h.execute("send", { conversation_id: desktopId, request: "One benign task" });
  await h.execute("send", { conversation_id: desktopId, request: "One benign task" }, "call-desktop-one",
    { ...controller, sessionId: "controller-incarnation-two" });
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["send", "send", "send"], "No terminal discovery or private terminal authority lookup");
  const expectedId = "msg-openclaw-" + createHash("sha256").update(JSON.stringify([
    controller.sessionKey, controller.sessionId, "agent_knock_knock_send", "call-desktop-one"
  ])).digest("hex");
  assert.equal(argument(calls[0], "--message-id"), expectedId);
  assert.equal(argument(calls[1], "--message-id"), expectedId);
  assert.notEqual(argument(calls[2], "--message-id"), expectedId);
  assert.equal(argument(calls[0], "--conversation"), desktopId);
  assert.equal(argument(calls[0], "--openclaw-session"), controller.sessionKey);
  assert.equal(argument(calls[0], "--message"), "One benign task");
  assert.equal(argument(calls[0], "--agent-hard-timeout-minutes"), "5");
  assert.equal(argument(calls[1], "--agent-hard-timeout-minutes"), "90");
  assert.equal(argument(calls[0], "--store-dir"), h.store);
  assert.equal(argument(calls[0], "--openclaw-bin"), "/test/openclaw");
  assert.equal(calls[0].includes("--background"), true);
  assert.equal(calls[0].some(arg => /token|fingerprint/u.test(arg)), false);
});

test("Desktop semantic mutation rejects mixed targets, unsupported types and missing controller or tool-call identity before relay", async t => {
  const h = harness(t);
  for (const extra of [{ terminal_id: terminalId }, { session_id: "session-one" }, { turn_id: "turn-one" }, { type: "response" }]) {
    await assert.rejects(h.execute("send", { conversation_id: desktopId, request: "No send", ...extra }));
  }
  await assert.rejects(h.execute("send", { conversation_id: desktopId, request: "No send" }, "call", {}), /controller session/iu);
  await assert.rejects(h.execute("send", { conversation_id: desktopId, request: "No send" }, ""), /tool call identity/iu);
  await assert.rejects(h.execute("watch", { conversation_id: desktopId, terminal_id: terminalId }));
  await assert.rejects(h.execute("watch", { conversation_id: desktopId }, "call", {}), /controller session/iu);
  await assert.rejects(h.execute("unwatch", { watch_id: watchId }, "call", {}), /controller session/iu);
  await assert.rejects(h.execute("status", { watch_id: watchId, conversation_id: desktopId }));
  await assert.rejects(h.execute("status", { conversation_id: desktopId, turn_id: "turn-one" }));
  await assert.rejects(h.execute("status", { watch_id: watchId }, "call", {}), /controller session/iu);
  await assert.rejects(h.execute("watch", { conversation_id: "terminal:invalid" }));
  for (const invalidWatch of ["desktop-watch:short", "desktop-watch:" + "a".repeat(129), "desktop-watch:../../escape"]) {
    await assert.rejects(h.execute("unwatch", { watch_id: invalidWatch }), /Invalid Desktop Watch ID/u);
    await assert.rejects(h.execute("status", { watch_id: invalidWatch }), /Invalid Desktop Watch ID/u);
  }
  assert.deepEqual(h.calls(), []);
});

test("Desktop semantic Watch, Status and Unwatch preserve exact targets and controller routes", async t => {
  const h = harness(t);
  await h.execute("watch", { conversation_id: desktopId, hardTimeoutMinutes: 12 });
  await h.execute("status", { conversation_id: desktopId });
  await h.execute("status", { watch_id: watchId });
  await h.execute("unwatch", { watch_id: watchId });
  const calls = h.calls();
  assert.deepEqual(calls.map(args => args[0]), ["watch-terminal", "status", "watch-status", "unwatch-terminal"]);
  assert.equal(argument(calls[0], "--conversation"), desktopId);
  assert.equal(argument(calls[0], "--terminal"), undefined);
  assert.equal(argument(calls[0], "--hard-timeout-minutes"), "12");
  assert.equal(argument(calls[1], "--conversation"), desktopId);
  for (const index of [0, 2, 3]) assert.equal(argument(calls[index], "--openclaw-session"), controller.sessionKey);
  for (const index of [2, 3]) assert.equal(argument(calls[index], "--watch"), watchId);
});

test("Desktop send presentation separates exact accepted tasks from uncertain receipts and never fabricates managed IDs", () => {
  assert.deepEqual(withTurnIdentity(accepted()), accepted());
  for (const changes of [
    { send_state: "uncertain", delivered: false, agent_acceptance: "unproven" },
    { send_state: "not_sent", status: "failed", delivered: false },
    { status: "failed" }, { status: "timed_out" }, { native_turn_id: null }, { watch_id: null },
    { native_thread_id: "other-thread" }, { delivery_receipt: "enter_dispatched" }
  ]) assert.equal(toolResult({ ...accepted(), ...changes }, { submissionErrors: true }).isError, true);
  assert.equal(toolResult(accepted(), { submissionErrors: true }).isError, undefined);
  assert.equal(toolResult({ ...accepted(), status: "completed" }, { submissionErrors: true }).isError, undefined);
});

test("Desktop semantic List routes filters and keeps public candidates while stripping native owner and raw state", async t => {
  const h = harness(t);
  h.reply({ terminals: [], terminal_watches: [], desktop_sessions: [{
    conversation_id: desktopId, id: desktopId, source: "codex_desktop", title: "Metadata-only Desktop",
    native_thread_id: target.threadId, connection_state: "unconfirmed", activity_state: "unknown",
    capabilities: { status: true, send: false, watch: false, approve: false, interaction_respond: false },
    available_actions: { status: { tool: "agent_knock_knock_status", input: { conversation_id: desktopId } } },
    owner_client_id: "PRIVATE_OWNER_MARKER", ownerClientId: "PRIVATE_OWNER_CAMEL_MARKER",
    raw: { marker: "PRIVATE_RAW_MARKER" }, conversationState: { marker: "PRIVATE_STATE_MARKER" }
  }], desktop_watches: [{ watch_id: watchId, conversation_id: desktopId, status: "watching", native_turn_id: "native-turn-one",
    owner_client_id: "PRIVATE_WATCH_OWNER", send_intent: { text: "PRIVATE_SEND_INTENT" } }],
    desktop_scan: { view: "history", catalog_complete: true, total_candidates: 31, returned: 1,
      live_probe_scope: "returned_page", live_count: 0, next_cursor: "next-desktop-page", raw: "PRIVATE_SCAN_RAW" } });
  const result = await h.execute("list", { desktop_view: "history", desktopSearch: "avatar", desktopProject: "/test/project", desktopCursor: "desktop-page", desktopLimit: 5, agent: "codex" });
  const args = h.calls()[0];
  assert.equal(h.calls().length, 1);
  assert.equal(args[0], "list");
  assert.equal(argument(args, "--desktop-view"), "history");
  assert.equal(argument(args, "--desktop-search"), "avatar");
  assert.equal(argument(args, "--desktop-project"), "/test/project");
  assert.equal(argument(args, "--desktop-cursor"), "desktop-page");
  assert.equal(argument(args, "--desktop-limit"), "5");
  assert.equal(argument(args, "--codex-home"), target.codexHome);
  assert.equal(result.details.desktop_sessions[0].conversation_id, desktopId);
  assert.equal(result.details.desktop_sessions[0].connection_state, "unconfirmed");
  assert.equal(result.details.desktop_watches[0].watch_id, watchId);
  assert.equal(result.details.desktop_scan.next_cursor, "next-desktop-page");
  assert.equal(result.details.desktop_scan.view, "history");
  assert.equal(result.details.desktop_scan.total_candidates, 31);
  assert.equal(result.details.desktop_scan.live_probe_scope, "returned_page");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/u);
});

test("Desktop List defaults to sidebar and rejects unknown views before catalog discovery", async t => {
  const h = harness(t);
  h.reply({ desktop_sessions: [], terminals: [], desktop_scan: {
    view: "sidebar", sidebar_status: "unsupported", sidebar_selection_scope: "persisted_expanded_membership",
    limitations: ["The saved connection layout cannot be reconstructed."], history_candidates: 341, total_candidates: 0
  } });
  const result = await h.execute("list", {});
  assert.equal(result.details.desktop_scan.sidebar_status, "unsupported");
  assert.equal(result.details.desktop_scan.sidebar_selection_scope, "persisted_expanded_membership");
  assert.equal(result.details.desktop_scan.history_candidates, 341);
  assert.deepEqual(result.details.desktop_scan.limitations, ["The saved connection layout cannot be reconstructed."]);
  await h.execute("list", { desktop_view: "sidebar" });
  assert.deepEqual(h.calls().map(args => argument(args, "--desktop-view")), ["sidebar", "sidebar"]);
  for (const desktop_view of ["all", "", true]) {
    await assert.rejects(h.execute("list", { desktop_view }), /desktop_view must be sidebar or history/u);
  }
  assert.equal(h.calls().length, 2, "An invalid view never widens discovery to history");
});

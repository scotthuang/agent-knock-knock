import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { dispatchRoutedConversationCli, backendPreflightUnavailable } from "../src/conversation-routing-cli-adapter.js";
import { conversationCommandPolicy } from "../src/conversation-routing-commands.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { createCodexNativeRuntime, type CodexNativeClientPort } from "../src/codex-native-runtime.js";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { CodexNativeError, type CodexNativeSnapshot } from "../src/codex-native-types.js";
import { createConversationRouteStore } from "../src/conversation-route-store.js";
import { createConversationRuntimeRouteStore } from "../src/conversation-runtime-route-store.js";
import { createTerminalUserSendIntentRepository } from "../src/terminal-user-send-intent.js";

const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
function fixture(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-routing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, ".codex");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const nativeId = createCodexNativeConversationId({ codexHome, threadId: uuid });
  const terminalId = "terminal:v2:tmux:codex:fixture:0.0:123";
  const row: Record<string, unknown> = { id: terminalId, agent: "codex", process_state: "active", pid: 123,
    native_agent_process_uuid: "process-123", native_agent_process_birth: "birth-123", codex_home: codexHome,
    native_agent_session_id: uuid, native_agent_identity_observation: { status: "resolved" },
    activity_state: "idle", approval_state: { blocked: false },
    available_actions: { send: { arguments: { expected_terminal_token: "current-terminal-authority" } } } };
  const snapshot: CodexNativeSnapshot = { threadId: uuid, thread: { id: uuid, sessionId: uuid, cwd: root,
    historyMode: "paginated", cliVersion: "0.162.0", originator: "codex-tui", source: "cli", status: { type: "idle" }, turns: [] },
    loaded: true, latestTurnId: null, turns: [], pendingInteractions: [], canSend: true };
  const calls: { command: string; options: Record<string, unknown> }[] = [];
  let failure: Error | undefined;
  let executionFailure: Error | undefined;
  let scans = 0;
  const scannedTargets: Array<string | undefined> = [];
  let beforeScan: ((scan: number) => void) | undefined;
  const client = { metadata: { serverVersion: "0.162.0", codexHome, socketPath: "fixture", platformFamily: "unix", platformOs: "macos" },
    async readSnapshot() { if (failure) throw failure; return snapshot; },
    async discover() { if (failure) throw failure; return [snapshot.thread]; }, close() {}
  } as unknown as CodexNativeClientPort;
  const run = async (command: string, target: string, extra: Record<string, unknown> = {}) => {
    const options = { conversation: target, storeDir, openclawSession: "controller",
      ...(command === "send" ? { messageId: "message-one", message: "READY" } : {}), ...extra };
    const result = await runCliCommandExecution(command, options, { cwd: root, env: { HOME: root, AKK_RUNTIME_DIR: runtimeDir }, runtimeLog() {},
      createCodexNativeRuntime: configuration => createCodexNativeRuntime({ ...configuration, clientFactory: async () => client }) },
    async () => {
      assert.equal(await dispatchRoutedConversationCli(command, options, {
        async terminals(_options, targetId) { scans++; scannedTargets.push(targetId); beforeScan?.(scans); return [row]; },
        async execute(selectedCommand, selectedOptions) {
          calls.push({ command: selectedCommand, options: selectedOptions });
          if (executionFailure) throw executionFailure;
          if (selectedCommand === "native-inspect" && selectedOptions.terminal === terminalId) {
            row.native_agent_status_card_session_id = uuid;
            return { native_thread_id: uuid, status: "observed", inspection: "status", agent: "codex", terminal_id: terminalId };
          }
          return { delivered: true, callback_expected: false, watch_id: "exact-watch", conversation_id: selectedOptions.conversation };
        }
      }), true);
    });
    return JSON.parse(result.stdout);
  };
  return { run, row, snapshot, calls, nativeId, terminalId, storeDir, runtimeDir, scannedTargets,
    set beforeScan(value: (scan: number) => void) { beforeScan = value; },
    set failure(value: Error | undefined) { failure = value; },
    set executionFailure(value: Error | undefined) { executionFailure = value; }, get scans() { return scans; } };
}

test("backend-first sends and reads a proven terminal alias without terminal input", async t => {
  const f = fixture(t);
  for (const command of ["send", "status", "watch-terminal"]) {
    const result = await f.run(command, f.terminalId);
    assert.equal(f.calls.at(-1)!.options.conversation, f.nativeId);
    assert.equal(result.routing.transport, "codex_backend");
  }
  assert.equal(f.calls.length, 3);
});

test("legacy exact session selector also enters backend-first routing", async t => {
  const f = fixture(t);
  await f.run("send", f.terminalId, { conversation: undefined, session: f.terminalId });
  assert.equal(f.calls[0].options.conversation, f.nativeId);
  assert.equal(f.calls[0].options.session, undefined);
});

test("legacy terminal IDs query the canonical exact terminal before backend routing", async t => {
  const f = fixture(t);
  const legacyId = "terminal:tmux:fixture:0.0:123";
  for (const command of ["send", "status", "watch-terminal"]) {
    await f.run(command, legacyId);
    assert.equal(f.calls.at(-1)!.options.conversation, f.nativeId);
  }
  assert.deepEqual(f.scannedTargets, [f.terminalId, f.terminalId, f.terminalId]);
});

test("legacy terminal fallback stores a canonical chosen target and replays the original immutable request", async t => {
  const f = fixture(t); f.failure = new CodexNativeError("closed", "offline");
  const legacyId = "terminal:tmux:fixture:0.0:123";
  const first = await f.run("send", legacyId);
  const input = { controllerSession: "controller", messageId: "message-one", requestText: "READY", canonicalTarget: legacyId };
  const saved = createConversationRuntimeRouteStore(f.storeDir, f.runtimeDir, { acquire: () => () => {} }).load(input)!;
  assert.equal(saved.canonical_target, legacyId);
  assert.equal(saved.target_id, f.terminalId);
  assert.equal(f.calls[0].options.conversation, f.terminalId);
  assert.deepEqual(f.scannedTargets, [f.terminalId, f.terminalId]);
  f.failure = undefined;
  const retry = await f.run("send", legacyId);
  assert.equal(retry.watch_id, first.watch_id); assert.equal(retry.replayed, true);
  assert.equal(f.calls.length, 1); assert.equal(f.scans, 2);
  await assert.rejects(f.run("send", f.terminalId), { code: "conversation_route_conflict" },
    "changing the original public selector must not rewrite an existing message journal");
});

test("legacy terminal IDs cannot match a different provider, agent, endpoint or PID, including after refresh", async t => {
  for (const changedId of ["terminal:v2:herdr:codex:fixture:0.0:123", "terminal:v2:tmux:claude:fixture:0.0:123",
    "terminal:v2:tmux:codex:other:0.0:123", "terminal:v2:tmux:codex:fixture:0.0:124"]) {
    for (const changedAtScan of [1, 2]) {
      const f = fixture(t);
      f.beforeScan = scan => { if (scan === changedAtScan) f.row.id = changedId; };
      await assert.rejects(f.run("cancel", "terminal:tmux:fixture:0.0:123"),
        /exact selected terminal is unavailable|no longer has its exact terminal fallback/);
      assert.equal(f.calls.length, 0, "identity drift must fail before any terminal operation");
    }
  }
});

test("existing legacy route receipts replay without discovery or reinterpretation", async t => {
  const f = fixture(t);
  const legacyId = "terminal:tmux:fixture:0.0:123";
  const input = { controllerSession: "controller", messageId: "message-one", requestText: "READY", canonicalTarget: legacyId };
  const choice = { route: "terminal" as const, targetId: legacyId };
  const journal = createConversationRouteStore(f.storeDir, { acquire: () => () => {} });
  journal.reserve(input, choice);
  journal.recordReceipt(input, choice, { delivered: true, watch_id: "old-exact-watch" });
  const result = await f.run("send", legacyId);
  assert.equal(result.watch_id, "old-exact-watch"); assert.equal(result.replayed, true);
  assert.equal(result.routing.selected_target, legacyId);
  assert.equal(f.scans, 0); assert.equal(f.calls.length, 0);
});

test("old terminal send receipts remain pinned to the exact terminal through a legacy selector", async t => {
  const f = fixture(t);
  const repository = createTerminalUserSendIntentRepository({ runtimeDir: f.runtimeDir });
  const boundary = { messageId: "message-one", terminalRuntimeKey: "original-runtime",
    physicalToken: "original-physical-token", requestHash: createHash("sha256").update("READY").digest("hex") };
  repository.reserve(boundary); repository.complete(boundary, "managed");
  const before = fs.readFileSync(repository.pathFor(boundary), "utf8");
  const result = await f.run("send", "terminal:tmux:fixture:0.0:123", { expectedTerminalToken: boundary.physicalToken });
  assert.equal(result.routing.reason, "legacy_terminal_message");
  assert.equal(result.routing.selected_target, f.terminalId);
  assert.equal(f.calls[0].options.conversation, f.terminalId);
  assert.equal(f.calls[0].options.expectedTerminalToken, boundary.physicalToken);
  assert.equal(fs.readFileSync(repository.pathFor(boundary), "utf8"), before);
});

test("explicit managed-only terminal diagnostics retain the existing state machine without routing discovery", async t => {
  const forbidden = async (): Promise<never> => { throw new Error("managed-only must not enter conversation routing"); };
  for (const target of ["terminal:tmux:fixture:0.0:123", "terminal:v2:tmux:codex:fixture:0.0:123"]) {
    assert.equal(await dispatchRoutedConversationCli("send", { conversation: target, message: "READY", managedOnly: true },
      { terminals: forbidden, execute: forbidden }), false);
  }
  const f = fixture(t);
  await f.run("send", f.nativeId, { managedOnly: true });
  assert.equal(f.calls[0].options.conversation, f.nativeId, "managed-only cannot bypass an explicitly native target");
});

test("native target unavailable before dispatch uses exact terminal and persists that choice when backend recovers", async t => {
  const f = fixture(t); f.failure = Object.assign(new Error("offline"), { code: "ENOENT" });
  const first = await f.run("send", f.nativeId);
  assert.equal(f.calls[0].options.conversation, f.terminalId);
  assert.equal(f.calls[0].options.expectedTerminalToken, "current-terminal-authority");
  f.failure = undefined;
  const again = await f.run("send", f.nativeId);
  assert.equal(again.watch_id, first.watch_id); assert.equal(f.calls.length, 1);
});

test("backend callback failure never selects terminal, and busy backend is left to the native operation", async t => {
  const f = fixture(t); f.snapshot.canSend = false; f.snapshot.thread.status = { type: "active", activeFlags: [] };
  const result = await f.run("send", f.nativeId);
  assert.equal(result.callback_expected, false); assert.equal(f.scans, 0);
  assert.equal(f.calls[0].options.conversation, f.nativeId);
});

test("unknown native mutation pins backend and cannot fall back on a later retry", async t => {
  const f = fixture(t); f.executionFailure = new CodexNativeError("timeout", "lost acknowledgement", "unknown");
  await assert.rejects(f.run("send", f.nativeId), /lost acknowledgement/);
  f.failure = Object.assign(new Error("offline"), { code: "ENOENT" });
  await assert.rejects(f.run("send", f.nativeId), /lost acknowledgement/);
  assert.equal(f.scans, 0); assert.deepEqual(f.calls.map(call => call.options.conversation), [f.nativeId, f.nativeId]);
});

test("same cwd and old startup UUID do not authorize native-offline terminal fallback", async t => {
  const f = fixture(t); f.failure = new CodexNativeError("closed", "offline");
  delete f.row.native_agent_session_id;
  f.row.command = `codex resume ${uuid}`;
  await assert.rejects(f.run("send", f.nativeId), /no unique verified terminal fallback/);
  assert.equal(f.calls.length, 0);
});

test("Status, Watch and permission operations resolve an idle alias before backend dispatch", async t => {
  const f = fixture(t); delete f.row.native_agent_session_id;
  f.row.agent_version = "0.160.0";
  f.row.native_agent_identity_observation = { status: "verified_absent" };
  f.row.available_actions = { native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { expected_binding_token: "binding" } } };
  for (const command of ["status", "watch-terminal", "permission-options", "set-permissions", "native-inspect"]) {
    delete f.row.native_agent_status_card_session_id;
    const result = await f.run(command, f.terminalId, command === "set-permissions" ? { mode: "full-access" } : {});
    assert.deepEqual(f.calls.slice(-2).map(call => call.command), ["native-inspect", command]);
    assert.equal(f.calls.at(-1)!.options.conversation, f.nativeId);
    assert.equal(result.routing.transport, "codex_backend");
  }
});

test("Status and Watch do not inspect a working or blocked terminal to acquire identity", async t => {
  const f = fixture(t); delete f.row.native_agent_session_id;
  f.row.agent_version = "0.160.0"; f.row.native_agent_identity_observation = { status: "verified_absent" };
  f.row.available_actions = { native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { expected_binding_token: "binding" } } };
  f.row.activity_state = "working";
  await f.run("status", f.terminalId);
  f.row.activity_state = "idle"; f.row.approval_state = { blocked: true };
  await f.run("watch-terminal", f.terminalId);
  assert.deepEqual(f.calls.map(call => call.command), ["status", "watch-terminal"]);
  assert.ok(f.calls.every(call => call.options.conversation === f.terminalId));
});

test("Send may reuse the advertised closed idle status transaction to resolve the exact backend", async t => {
  const f = fixture(t); delete f.row.native_agent_session_id;
  f.row.agent_version = "0.160.0";
  f.row.native_agent_identity_observation = { status: "verified_absent" };
  f.row.available_actions = { ...f.row.available_actions as object, native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { expected_binding_token: "binding" } } };
  await f.run("send", f.terminalId);
  assert.deepEqual(f.calls.map(call => call.command), ["native-inspect", "send"]);
  assert.equal(f.calls[1].options.conversation, f.nativeId);
  assert.equal(f.calls[0].options.message, undefined);
});

test("resolved legacy identity without a matching backend is not probed or reinterpreted", async t => {
  const f = fixture(t); f.row.agent_version = "0.155.1";
  f.row.native_agent_session_id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  f.row.available_actions = { ...f.row.available_actions as object, native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { expected_binding_token: "binding" } } };
  await f.run("send", f.terminalId);
  assert.deepEqual(f.calls.map(call => call.command), ["send"]);
  assert.equal(f.calls[0].options.conversation, f.terminalId);
});

test("a terminal without verified process home retains its terminal route without probing unrelated backends", async t => {
  const f = fixture(t); delete f.row.codex_home; delete f.row.native_agent_session_id;
  f.row.agent_version = "0.160.0";
  f.row.native_agent_identity_observation = { status: "verified_absent" };
  f.row.available_actions = { ...f.row.available_actions as object, native_inspect: { tool: "agent_knock_knock_native_inspect", arguments: { expected_binding_token: "binding" } } };
  await f.run("send", f.terminalId);
  assert.deepEqual(f.calls.map(call => call.command), ["send"]);
  assert.equal(f.calls[0].options.conversation, f.terminalId);
});

test("read identity or argument failures do not masquerade as backend unavailability", async t => {
  const f = fixture(t); f.failure = new CodexNativeError("invalid_response", "wrong identity");
  await assert.rejects(f.run("send", f.nativeId), /wrong identity/);
  await assert.rejects(f.run("send", f.terminalId), /failed verification/);
  assert.equal(f.calls.length, 0);
  for (const code of ["thread_not_idle", "duplicate_submission", "invalid_argument", "stale_interaction", "rpc_error"] as const) {
    assert.equal(backendPreflightUnavailable(new CodexNativeError(code, "semantic refusal")), false);
  }
  assert.equal(backendPreflightUnavailable(new CodexNativeError("closed", "mutation closed", "unknown")), false);
});

test("permission operations prefer the backend and discard terminal-only mutation offers", async t => {
  const f = fixture(t);
  for (const command of ["permission-options", "set-permissions", "native-inspect", "native-status"]) {
    const result = await f.run(command, f.terminalId, { mode: "full-access",
      ...(command === "native-inspect" ? { inspection: "permissions" } : {}),
      expectedBindingToken: "old-ui-binding", expectedCatalogFingerprint: "old-ui-catalog" });
    assert.equal(result.routing.transport, "codex_backend");
    const call = f.calls.at(-1)!;
    assert.equal(call.options.conversation, f.nativeId);
    assert.equal(call.options.expectedBindingToken, undefined);
    assert.equal(call.options.expectedCatalogFingerprint, undefined);
    if (command === "native-status") assert.equal(call.command, "native-inspect");
  }
});

test("terminal permission fallback refreshes query authority but never invents a displayed mutation offer", async t => {
  const f = fixture(t); f.failure = new CodexNativeError("closed", "offline");
  f.row.available_actions = { permission_options: { arguments: { expected_binding_token: "permission-binding" } } };
  const catalog = await f.run("native-inspect", f.nativeId, { action: "permissions" });
  assert.equal(catalog.routing.transport, "terminal");
  assert.equal(f.calls[0].command, "permission-options");
  assert.equal(f.calls[0].options.expectedBindingToken, "permission-binding");
  await assert.rejects(f.run("set-permissions", f.terminalId, { mode: "full-access" }), /refresh permission-options/);
  assert.equal(f.calls.length, 1);
  await f.run("set-permissions", f.terminalId, { mode: "full-access", expectedBindingToken: "displayed-binding", expectedCatalogFingerprint: "displayed-catalog" });
  assert.equal(f.calls[1].options.expectedBindingToken, "displayed-binding");
  assert.equal(f.calls[1].options.expectedCatalogFingerprint, "displayed-catalog");
});

test("native permission mutation uncertainty never dispatches a terminal fallback", async t => {
  const f = fixture(t); f.executionFailure = new CodexNativeError("timeout", "settings confirmation uncertain", "unknown");
  await assert.rejects(f.run("set-permissions", f.terminalId, { mode: "read-only" }), /confirmation uncertain/);
  assert.deepEqual(f.calls.map(call => call.options.conversation), [f.nativeId]);
});

test("old terminal permission preset names normalize only equivalent backend semantics", async t => {
  const f = fixture(t);
  for (const [requested, native] of [["read_only", "read-only"], ["ask_for_approval", "default"], ["full_access", "full-access"]]) {
    await f.run("set-permissions", f.terminalId, { mode: requested });
    assert.equal(f.calls.at(-1)!.options.mode, native);
    assert.equal(f.calls.at(-1)!.options.conversation, f.nativeId);
  }
  const result = await f.run("set-permissions", f.terminalId, { mode: "approve_for_me",
    expectedBindingToken: "displayed-binding", expectedCatalogFingerprint: "displayed-catalog" });
  assert.equal(result.routing.reason, "backend_operation_unavailable");
  assert.equal(f.calls.at(-1)!.options.mode, "approve_for_me");
  assert.equal(f.calls.at(-1)!.options.conversation, f.terminalId);
});

test("explicit terminal Send retains existing physical authority when no new List offer is available", async t => {
  const f = fixture(t); f.failure = new CodexNativeError("closed", "offline");
  f.row.available_actions = {};
  await f.run("send", f.terminalId, { expectedTerminalToken: "existing-authority" });
  assert.equal(f.calls[0].options.expectedTerminalToken, "existing-authority");
  assert.equal(f.calls[0].options.conversation, f.terminalId);
});

test("unimplemented backend operations use verified terminal capability without pretending native support", async t => {
  const f = fixture(t);
  f.row.available_actions = {
    model_options: { arguments: { expected_binding_token: "model-binding" } },
    new_thread: { arguments: { expected_binding_token: "lifecycle-binding" } }
  };
  for (const command of ["model-options", "new-thread", "cancel", "list-resumable-threads", "resume-thread"]) {
    const result = await f.run(command, f.nativeId);
    assert.equal(result.routing.transport, "terminal");
    assert.equal(result.routing.reason, "backend_operation_unavailable");
    assert.equal(f.calls.at(-1)!.options.conversation, f.terminalId);
  }
  delete f.row.native_agent_session_id;
  await assert.rejects(f.run("model-options", f.nativeId), /no unique verified terminal fallback/);
});

test("native interactions stay bound to backend while terminal approval authority stays terminal", async t => {
  const f = fixture(t);
  const interaction = "codex-native-interaction:" + "a".repeat(64);
  for (const command of ["approve", "respond-interaction"]) {
    const result = await f.run(command, f.terminalId, { interaction });
    assert.equal(result.routing.transport, "codex_backend");
    assert.equal(f.calls.at(-1)!.options.interaction, interaction);
  }
  const approval = await f.run("approve", f.terminalId, { expectedApprovalFingerprint: "shown-ui-approval" });
  assert.equal(approval.routing.transport, "terminal");
  f.failure = new CodexNativeError("closed", "offline");
  await assert.rejects(f.run("approve", f.nativeId, { interaction }), /no terminal response was sent/);
  assert.equal(f.calls.length, 3);
});

test("already-bound Watch and Turn operations never rebind through conversation routing", () => {
  for (const command of ["status", "watch-status", "unwatch-terminal", "approve", "respond-interaction", "cancel", "send"]) {
    assert.equal(conversationCommandPolicy(command, { watch: "codex-cli-watch:12345678" }), undefined);
    assert.equal(conversationCommandPolicy(command, { turn: "existing-turn" }), undefined);
  }
  for (const command of ["transcript", "respond", "renew"]) assert.equal(conversationCommandPolicy(command, {}), undefined);
});

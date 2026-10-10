import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createCodexNativeConversationId } from "../src/codex-native-identity.js";
import { createCodexNativeStateStore, type CodexNativeTaskRecord, type CodexNativeSendIntent } from "../src/codex-native-state-store.js";
import { CodexNativeTaskError, nativeDigest } from "../src/codex-native-task-service.js";
import { selectLegacyConversationRoute } from "../src/conversation-route-legacy.js";
import { createTerminalUserSendIntentRepository } from "../src/terminal-user-send-intent.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-route-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const terminalRuntimeDir = path.join(root, "runtime");
  const target = { codexHome: path.join(root, "codex"), threadId: "exact-thread" };
  const nativeId = createCodexNativeConversationId(target);
  const terminalId = "terminal:v2:tmux:codex:fixture:0.0:123";
  const input = { controllerSession: "controller", messageId: "old-message", requestText: "One task", canonicalTarget: nativeId };
  const id = `codex-cli-watch:${nativeDigest([input.controllerSession, input.messageId])}`;
  const storeDir = path.join(root, "store");
  const nativeRepository = createCodexNativeStateStore(storeDir, { acquire: () => () => {} });
  const nativeTasks = { status(taskId: string) {
    assert.equal(taskId, id, "migration reads only the exact controller/message task");
    const found = nativeRepository.load(taskId);
    if (!found) throw new CodexNativeTaskError("codex_native_watch_not_found", "absent");
    return found;
  } };
  const terminalRepository = createTerminalUserSendIntentRepository({ runtimeDir: terminalRuntimeDir });
  const terminalBoundary = { terminalRuntimeKey: "one-exact-runtime", physicalToken: "one-exact-process",
    messageId: input.messageId, requestHash: createHash("sha256").update(input.requestText).digest("hex") };
  const date = "2026-10-10T00:00:00.000Z";
  function saveNative(state: CodexNativeSendIntent["state"] = "uncertain", extra: Partial<CodexNativeTaskRecord> = {}) {
    const record: CodexNativeTaskRecord = { schema: "agent-knock-knock/codex-native-task", version: 1, revision: 1,
      id, watch_id: id, native_id: nativeId, target, controller_session: input.controllerSession, kind: "send",
      status: state === "accepted" ? "watching" : "awaiting_acceptance", created_at: date, updated_at: date,
      deadline_at: "2026-10-10T01:00:00.000Z", ...(state === "accepted" ? { native_turn_id: "exact-turn" } : {}),
      send_intent: { message_id: input.messageId, client_user_message_id: "stable-client-message", text: input.requestText,
        baseline_turn_ids: [], state, dispatched_at: date }, pending_interactions: [], notifications: [], ...extra };
    nativeRepository.save(record, null);
  }
  return { input, nativeId, terminalId, nativeTasks, terminalRuntimeDir, storeDir, terminalRepository, terminalBoundary, saveNative,
    select: (changed = input) => selectLegacyConversationRoute({ input: changed, nativeTasks, terminalRuntimeDir,
      expectedTerminalToken: terminalBoundary.physicalToken }) };
}

test("legacy native send retains its route in every dispatch state without backend discovery", t => {
  for (const state of ["reserved", "uncertain", "accepted", "not_sent"] as const) {
    const h = fixture(t); h.saveNative(state);
    assert.deepEqual(h.select(), { route: "native", targetId: h.nativeId, reason: "legacy_native_message" });
    assert.throws(() => h.select({ ...h.input, canonicalTarget: h.terminalId }),
      { code: "conversation_route_conflict" }, "an unproven terminal alias cannot relabel an old native request");
    assert.equal(fs.existsSync(h.terminalRuntimeDir), false, "read-only migration must not create the terminal runtime");
  }
});

test("missing legacy records permit planning without creating either store; read failures do not mean absence", t => {
  const h = fixture(t);
  assert.equal(h.select(), undefined);
  assert.equal(fs.existsSync(h.storeDir), false); assert.equal(fs.existsSync(h.terminalRuntimeDir), false);
  const failure = new Error("durable native ledger unreadable");
  assert.throws(() => selectLegacyConversationRoute({ input: h.input, terminalRuntimeDir: h.terminalRuntimeDir,
    nativeTasks: { status() { throw failure; } } }), error => error === failure);
});

test("legacy native immutable request, controller and selected native target conflicts cannot trigger fallback", t => {
  const h = fixture(t); h.saveNative();
  for (const changed of [{ ...h.input, requestText: "Another task" },
    { ...h.input, canonicalTarget: createCodexNativeConversationId({ codexHome: "/elsewhere", threadId: "other-thread" }) }]) {
    assert.throws(() => h.select(changed), { code: "conversation_route_conflict" });
  }
  const wrongController = fixture(t); wrongController.saveNative("reserved", { controller_session: "different-controller" });
  assert.throws(() => wrongController.select(), { code: "conversation_route_conflict" });
});

test("legacy terminal receipt and reservation pin terminal even when backend becomes available", t => {
  for (const state of ["reserved", "enter_dispatched", "zero_input_cancelled"]) {
    const h = fixture(t); h.terminalRepository.reserve(h.terminalBoundary);
    if (state === "enter_dispatched") h.terminalRepository.complete(h.terminalBoundary, "managed");
    if (state === "zero_input_cancelled") h.terminalRepository.cancelProvenZeroInput(h.terminalBoundary);
    const expected = { route: "terminal", targetId: h.terminalId, reason: "legacy_terminal_message" };
    assert.deepEqual(h.select({ ...h.input, canonicalTarget: h.terminalId }), expected);
    assert.deepEqual(h.select({ ...h.input, requestText: "One task\n", canonicalTarget: h.terminalId }), expected);
    assert.throws(() => h.select({ ...h.input, requestText: "Changed task", canonicalTarget: h.terminalId }),
      { code: "conversation_route_conflict" });
    assert.throws(() => h.select(), { code: "conversation_route_conflict" }, "a backend alias cannot invent the old terminal target");
    for (const options of [{}, { expectedTerminalToken: "replacement-process" },
      { expectedTerminalToken: h.terminalBoundary.physicalToken, managedOnly: true }]) {
      assert.throws(() => selectLegacyConversationRoute({ input: { ...h.input, canonicalTarget: h.terminalId },
        nativeTasks: h.nativeTasks, terminalRuntimeDir: h.terminalRuntimeDir, ...options }),
      /exact explicit terminal authority/u, "cannot bypass old explicit ledger through managed Send");
    }
    assert.throws(() => h.terminalRepository.load({ ...h.terminalBoundary, physicalToken: "replacement-process" }),
      /different physical terminal/u, "migration evidence must not bypass the terminal provider's authority");
  }
});

test("both old transport ledgers are ambiguous and corrupted terminal records do not allow a new native send", t => {
  const h = fixture(t); h.saveNative(); h.terminalRepository.reserve(h.terminalBoundary);
  assert.throws(() => h.select(), /both transport ledgers/u);
  const broken = fixture(t); broken.terminalRepository.reserve(broken.terminalBoundary);
  fs.writeFileSync(broken.terminalRepository.pathFor(broken.terminalBoundary), "{broken", { mode: 0o600 });
  assert.throws(() => broken.select());
  const displaced = fixture(t); const record = displaced.terminalRepository.reserve(displaced.terminalBoundary).intent;
  fs.writeFileSync(displaced.terminalRepository.pathFor(displaced.terminalBoundary),
    JSON.stringify({ ...record, message_id: "different-message" }), { mode: 0o600 });
  assert.throws(() => displaced.select(), /message identity does not match/u);
});

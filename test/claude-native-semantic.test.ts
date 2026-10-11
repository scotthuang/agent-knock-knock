import { parseAkkCommand, buildAkkCommandCliArgs } from "../src/semantic-tool-command-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeNativeConversationId } from "../src/claude-native-identity.js";
import { nativeConversationTarget, nativeSendToolArgs, nativePermissionToolArgs, validatedNativeWatchId, routedCodexTerminalControlArgs } from "../src/codex-native-semantic.js";
import { backendRecoveryToolArgs, normalizeBackendStatusTarget, assertBackendRecoveryCliTarget } from "../src/backend-recovery-semantic.js";
import { normalizeConversationSendResult } from "../src/semantic-conversation-target.js";
import { sendCommandResultIsError } from "../src/semantic-tool-presentation.js";
const target = { configDir: "/fixture/.claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pid: 123,
  processStart: "Sun Oct 11 01:00:00 2026" };
const id = createClaudeNativeConversationId(target), watch = "claude-cli-watch:12345678abc";

test("Claude semantic Send and native Status preserve exact native IDs and controller scope", () => {
  assert.equal(nativeConversationTarget({ conversation_id: id }), id);
  assert.throws(() => nativeConversationTarget({ conversation_id: id, terminal_id: "terminal" }), /another target/u);
  const args = nativeSendToolArgs({ conversation_id: id, request: "one task" }, { agentHardTimeoutMinutes: 721 }, { sessionKey: "controller" }, "stable-tool-call")!;
  assert.deepEqual(args.slice(0, 5), ["send", "--conversation", id, "--openclaw-session", "controller"]);
  assert.equal(args[args.indexOf("--message-id") + 1], "stable-tool-call");
  assert.equal(args[args.indexOf("--agent-hard-timeout-minutes") + 1], "721");
  assert.ok(nativePermissionToolArgs({ conversation_id: id, inspection: "status" }, {}, { sessionKey: "controller" }, "status")?.includes(id));
  assert.ok(routedCodexTerminalControlArgs({ terminal_id: "terminal:v2:tmux:claude:akk:0.0:123", inspection: "status" }, {}, { sessionKey: "controller" }, "status")?.includes("native-inspect"));
});

test("Claude backend Watch recovery uses explicit original Watch IDs and hard timeout policy", () => {
  assert.equal(validatedNativeWatchId(watch), watch);
  assert.throws(() => validatedNativeWatchId("claude-cli-watch:bad"), /Invalid Claude/u);
  assert.deepEqual(normalizeBackendStatusTarget({ turn_id: watch }), { watch_id: watch });
  const args = backendRecoveryToolArgs("renew", { watch_id: watch }, { sessionKey: "controller" })!;
  assert.deepEqual(args, ["renew", "--watch", watch, "--openclaw-session", "controller", "--minutes", "720"]);
  assert.throws(() => backendRecoveryToolArgs("close", { conversation_id: id }, { sessionKey: "controller" }), /exact backend/u);
  assert.throws(() => assertBackendRecoveryCliTarget("close", { watch, openclawSession: "controller", expectedBindingToken: "old-terminal" }), /terminal recovery fences/u);
});

test("Claude accepted receipts retain native fields while unproven transport writes remain an error", () => {
  const receipt = { source: "claude_cli", conversation_id: id, watch_id: watch, native_thread_id: target.sessionId,
    native_input_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", send_state: "accepted", agent_acceptance: "proven", delivered: true };
  assert.equal(normalizeConversationSendResult(receipt), receipt);
  assert.equal(sendCommandResultIsError(receipt), false);
  assert.equal(sendCommandResultIsError({ ...receipt, send_state: "uncertain", agent_acceptance: "unproven" }), true);
  assert.equal(sendCommandResultIsError({ ...receipt, native_thread_id: "different-session" }), true);
});


test("slash Watch and Status keep Claude native IDs out of terminal selectors", () => {
  const command = parseAkkCommand(`watch ${id}`);
  assert.deepEqual(command, { action: "watch", terminalId: id });
  const watchArgs = buildAkkCommandCliArgs(command, {}, { sessionKey: "controller" })!;
  assert.equal(watchArgs[1], "--conversation");
  const statusArgs = buildAkkCommandCliArgs(parseAkkCommand(`status ${id}`), {}, { sessionKey: "controller" })!;
  assert.ok(statusArgs.includes("--conversation"));
  const recovered = parseAkkCommand(`unwatch ${watch}`);
  assert.deepEqual(recovered, { action: "unwatch", watchId: watch });
});

import { parseAkkCommand, buildAkkCommandCliArgs } from "../src/semantic-tool-command-helpers.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeNativeConversationId } from "../src/claude-native-identity.js";
import { nativeConversationTarget, nativeSendToolArgs, nativePermissionToolArgs, validatedNativeWatchId, routedCodexTerminalControlArgs } from "../src/codex-native-semantic.js";
import { backendRecoveryToolArgs, normalizeBackendStatusTarget, assertBackendRecoveryCliTarget } from "../src/backend-recovery-semantic.js";
import { normalizeConversationSendResult } from "../src/semantic-conversation-target.js";
import { sendCommandResultIsError } from "../src/semantic-tool-presentation.js";
import { claudeNativeRuntimeOptions } from "../src/claude-native-cli-adapter.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
const target = { configDir: "/fixture/.claude", sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", pid: 123,
  processStart: "Sun Oct 11 01:00:00 2026" };
const id = createClaudeNativeConversationId(target), watch = "claude-cli-watch:12345678abc";

test("Claude sender class comes only from the Host environment, never from model or CLI options", async () => {
  const options = { senderPermissionClass: "bypass", sender_permission_class: "bypass" };
  for (const configured of [undefined, "prompting", "invalid-host-configuration"]) {
    await runCliCommandExecution("sender-policy-boundary", options, {
      cwd: "/fixture", env: { HOME: "/fixture", AKK_NATIVE_CLAUDE_SENDER_PERMISSION_CLASS: configured }, runtimeLog() {}
    }, async () => {
      // Raw configuration remains readable even when invalid; only a new Send validates it.
      assert.equal(claudeNativeRuntimeOptions(options).senderPermissionClass, configured);
    });
  }
  assert.throws(() => nativeSendToolArgs({ conversation_id: id, request: "one task", ...options }, {},
    { sessionKey: "controller" }, "policy-boundary"), /Unexpected Codex CLI parameters/u);
});

test("Claude semantic Send and native Status preserve exact native IDs and controller scope", () => {
  assert.equal(nativeConversationTarget({ conversation_id: id }), id);
  assert.throws(() => nativeConversationTarget({ conversation_id: id, terminal_id: "terminal" }), /another target/u);
  const args = nativeSendToolArgs({ conversation_id: id, request: "one task", agentTimeoutMinutes: 7 },
    { agentHardTimeoutMinutes: 721, agentTimeoutMinutes: 60, idleTimeoutMinutes: 5, claudeHome: "/fixture/.tclaude" },
    { sessionKey: "controller" }, "stable-tool-call")!;
  assert.deepEqual(args.slice(0, 5), ["send", "--conversation", id, "--openclaw-session", "controller"]);
  assert.equal(args[args.indexOf("--message-id") + 1], "stable-tool-call");
  assert.equal(args[args.indexOf("--agent-hard-timeout-minutes") + 1], "721");
  assert.equal(args[args.indexOf("--claude-home") + 1], "/fixture/.tclaude");
  assert.equal(args[args.indexOf("--agent-timeout-minutes") + 1], "7");
  assert.equal(args[args.indexOf("--idle-timeout-minutes") + 1], "5");
  assert.equal(args[args.indexOf("--gateway-method") + 1], "agent-knock-knock.callback");
  assert.equal(args[args.indexOf("--gateway-session") + 1], "controller");
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

import assert from "node:assert/strict";
import test from "node:test";
import { createCodexNativeConversationId, parseCodexNativeConversationId } from "../src/codex-native-identity.js";
import { isMainCodexCliThread, nativeAsyncInteractions, parseNativeThread, parseNativeTurn } from "../src/codex-native-snapshot.js";
import { buildNativeAsyncReply, parseNativeRequest } from "../src/codex-native-client-interactions.js";

test("native conversation identity is canonical and independent of mutable cwd/title", () => {
  const identity = { codexHome: "/tmp/codex-native", threadId: "thread-one" };
  const id = createCodexNativeConversationId(identity);
  assert.deepEqual(parseCodexNativeConversationId(id), identity);
  assert.throws(() => parseCodexNativeConversationId(id + "="));
  const alias = "codex-cli:v1:" + Buffer.from(JSON.stringify(["/tmp/codex-native/../codex-native", identity.threadId])).toString("base64url");
  assert.throws(() => parseCodexNativeConversationId(alias), /Non-canonical/u);
});

test("native discovery accepts CLI user threads with vscode source but rejects children and Desktop history", () => {
  const base = { id: "one", sessionId: "one", cwd: "/tmp/work", cliVersion: "0.155.1", historyMode: "paginated",
    originator: "codex-tui", source: "vscode", threadSource: "user", status: { type: "idle" }, turns: [] };
  assert.equal(isMainCodexCliThread(parseNativeThread(base, "one")), true);
  for (const change of [{ parentThreadId: "parent" }, { source: { subAgent: {} } }, { canAcceptDirectInput: false },
    { originator: "codex-desktop" }, { threadSource: "agent" }]) {
    assert.equal(isMainCodexCliThread(parseNativeThread({ ...base, ...change }, "one")), false);
  }
});

test("async interaction identity is tied to native question and only unresolved active questions are actionable", () => {
  const raw = { id: "turn-one", status: "inProgress", itemsView: "full", items: [{ id: "item-one", type: "agentMessage",
    text: "Choose", delivery: "async", questions: [{ title: "Color?", options: ["Blue", "Green"] }] }] };
  const turn = parseNativeTurn(raw);
  const interactions = nativeAsyncInteractions("thread-one", turn);
  assert.equal(interactions.length, 1);
  const interaction = interactions[0];
  assert.match(interaction.id, /^codex-native-interaction:[a-f0-9]{64}$/u);
  assert.equal(interaction.questions[0].id, JSON.stringify(["request_user_input_async", "item-one", 0]));
  const text = buildNativeAsyncReply(interaction, "Green");
  turn.items.push({ id: "answer", type: "userMessage", clientId: "client-answer", content: [{ type: "text", text }] });
  assert.deepEqual(nativeAsyncInteractions("thread-one", turn), []);
  assert.deepEqual(nativeAsyncInteractions("thread-one", { ...parseNativeTurn(raw), status: "completed" }), []);
  assert.deepEqual(nativeAsyncInteractions("thread-one", { ...parseNativeTurn(raw), itemsComplete: false }), []);
});

test("native approval callbacks disambiguate subcommands and support commandless network requests", () => {
  const request = { id: 1, method: "item/commandExecution/requestApproval", params: { threadId: "thread-one", turnId: "turn-one",
    itemId: "parent-exec", kind: "command", approvalId: "approval-one", command: "printf marker" } };
  const first = parseNativeRequest(request)!;
  const second = parseNativeRequest({ ...request, id: 2, params: { ...request.params, approvalId: "approval-two" } })!;
  const stdin = parseNativeRequest({ ...request, id: 3, params: { ...request.params, kind: "writeStdin" } })!;
  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, stdin.id);
  assert.equal(parseNativeRequest({ ...request, id: 99 })!.id, first.id);
  const network = parseNativeRequest({ ...request, params: { ...request.params, command: null,
    networkApprovalContext: { host: "example.com", protocol: "https" } } })!;
  assert.equal(network.command, undefined);
  assert.deepEqual(network.networkApprovalContext, { host: "example.com", protocol: "https" });
});

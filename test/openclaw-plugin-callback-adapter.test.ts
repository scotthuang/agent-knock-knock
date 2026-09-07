import assert from "node:assert/strict";
import test from "node:test";

import { registerOpenClawCallbackGateway } from
  "../src/openclaw-plugin-callback-adapter.js";
import { createConversation, createMessage } from "../src/protocol.js";
import { isRecord } from "../src/value-guards.js";

type GatewayMethodHandler = (context: {
  params: unknown;
  respond(ok: boolean, result?: unknown, error?: unknown): void;
}) => Promise<void>;

function callbackHarness() {
  let handler: GatewayMethodHandler | undefined;
  let injection = "";
  let response: { ok: boolean; result?: Record<string, unknown> } | undefined;
  const api = {
    pluginConfig: {},
    logger: { info() {}, warn() {} },
    session: {
      workflow: {
        async enqueueNextTurnInjection(input: Record<string, unknown>) {
          injection = String(input.text ?? "");
          return { enqueued: true, sessionKey: input.sessionKey };
        }
      }
    },
    registerGatewayMethod(method: string, candidate: GatewayMethodHandler) {
      if (method === "agent-knock-knock.callback") handler = candidate;
    }
  };
  registerOpenClawCallbackGateway(api);
  return {
    handler(): GatewayMethodHandler {
      assert.ok(handler);
      return handler;
    },
    respond(ok: boolean, result?: unknown) {
      response = { ok, ...(isRecord(result) ? { result } : {}) };
    },
    visible(): string {
      const chatSend = isRecord(response?.result?.chat_send)
        ? response.result.chat_send
        : undefined;
      return [injection, String(chatSend?.message ?? "")].join("\n");
    },
    response: () => response
  };
}

test("native questionnaire callbacks require Status before one semantic response", async () => {
  const harness = callbackHarness();
  const turnId = "turn-interaction-callback";
  const conversation = createConversation({
    userRequest: "native questionnaire callback",
    sessionId: "session-interaction-callback",
    turnId,
    openclawSession: "agent:main:interaction-callback",
    executorKind: "claude",
    executorSession: "claude-interaction-callback"
  });
  const message = createMessage({
    conversation,
    id: "message-interaction-callback",
    from: "claude-code",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: "Claude Code is waiting for a native questionnaire response.",
    metadata: {
      source: "terminal_bridge",
      reason: "interaction_required",
      interaction_state: {
        schema: "agent-knock-knock/terminal-interaction",
        version: 1,
        interaction_id: "interaction-callback-1",
        turn_id: turnId,
        agent: "claude",
        kind: "questionnaire",
        state: "pending",
        step: { index: 1, total: 1 },
        questions: [{
          question_id: "question-callback-1",
          prompt: "Choose one option",
          required: true,
          response_kind: "single_select",
          options: [
            { option_id: "option-a", label: "Option A" },
            { option_id: "option-b", label: "Option B" }
          ]
        }],
        expires_at: "2099-09-08T00:00:00.000Z",
        capabilities: {
          respond: true,
          batch_response: false,
          free_text: false,
          multi_select: false
        }
      }
    }
  });

  await harness.handler()({
    params: {
      sessionKey: "agent:main:interaction-callback",
      conversation,
      message
    },
    respond: harness.respond
  });

  assert.equal(harness.response()?.ok, true);
  const visible = harness.visible();
  assert.match(visible, /\[AKK native interaction refresh required\]/u);
  assert.match(visible, /agent_knock_knock_status/u);
  assert.match(visible, /agent_knock_knock_respond_interaction/u);
  assert.match(visible, /Answer exactly one current step/u);
  assert.doesNotMatch(visible, /\[AKK response command\]/u);
  assert.doesNotMatch(visible, /make the product decision/u);
});

test("ordinary question callbacks retain the managed respond workflow", async () => {
  const harness = callbackHarness();
  const conversation = createConversation({
    userRequest: "ordinary callback question",
    sessionId: "session-ordinary-question",
    turnId: "turn-ordinary-question",
    openclawSession: "agent:main:ordinary-question",
    executorKind: "claude",
    executorSession: "claude-ordinary-question"
  });
  const message = createMessage({
    conversation,
    id: "message-ordinary-question",
    from: "claude-code",
    to: "openclaw",
    type: "question",
    requiresResponse: true,
    body: "Which implementation tradeoff should I use?",
    metadata: { source: "terminal_bridge", reason: "agent_question" }
  });

  await harness.handler()({
    params: {
      sessionKey: "agent:main:ordinary-question",
      conversation,
      message
    },
    respond: harness.respond
  });

  assert.equal(harness.response()?.ok, true);
  const visible = harness.visible();
  assert.match(visible, /\[AKK response command\]/u);
  assert.match(visible, /agent_knock_knock_respond/u);
  assert.doesNotMatch(visible, /native interaction refresh required/u);
  assert.doesNotMatch(visible, /agent_knock_knock_respond_interaction/u);
  assert.doesNotMatch(visible, /agent_knock_knock_status/u);
});

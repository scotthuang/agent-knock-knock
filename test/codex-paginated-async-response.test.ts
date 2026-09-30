import assert from "node:assert/strict";
import test from "node:test";
import { respondCodexPaginatedAsyncQuestion } from "../src/codex-paginated-async-response.js";
import { codexTerminalAgentAdapter } from "../src/codex-terminal-agent-adapter.js";
import type { CodexAsyncQuestionDurableEvidence } from "../src/codex-async-question-adapter.js";
import type { TerminalBridgeStatus } from "../src/terminal-agent-bridge.js";
import type { TerminalRuntimeIdentity } from "../src/terminal-agent-adapter.js";
import { terminalControlEvidence, type TerminalControlRef } from "../src/terminal-control-ref.js";
import {
  captureTerminalInteractionRuntimeOffer,
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type TerminalInteractionRuntimeOffer
} from "../src/terminal-interaction-response-bridge.js";
import type {
  TerminalInteractionAnswer,
  TerminalInteractionSubjectResponse
} from "../src/terminal-interaction-protocol.js";

type ResponseInput = Parameters<typeof respondCodexPaginatedAsyncQuestion>[0];
type NativeAnswer = Parameters<NonNullable<ResponseInput["deliver"]>>[0];
const NOW = new Date("2026-10-01T00:00:00.000Z");
const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const TURN = "native_turn_async_42";
const ITEM = "native_async_item_42";
const CONTROL: TerminalControlRef = {
  kind: "herdr", target: "workspace/tab/pane", session: "fixture-session",
  socketPath: "/tmp/fixture.sock", panePid: 4242, currentCommand: "codex",
  currentPath: "/repo", capabilities: ["screen_status", "send_keys", "durable_completion"],
  sessionDir: "/tmp/fixture-session", workspaceId: "workspace", tabId: "tab",
  paneId: "pane", terminalId: "terminal_resource"
};
const RUNTIME: TerminalRuntimeIdentity = {
  pid: 4242, agentVersion: "0.158.0", nativeSessionId: THREAD,
  nativeTaskId: TURN, nativeProcessUuid: "codex-pid:4242:birth:exact-birth",
  nativeProcessBirth: "exact-birth",
  interactionSubject: { kind: "terminal_watch", watch_id: "watch_async_42", anchor_fingerprint: "a".repeat(64) },
  codexPaginatedThread: {
    codexHome: "/codex", threadId: THREAD,
    agentVersion: "0.158.0", serverVersion: "0.158.0",
    processUuid: "codex-pid:4242:birth:exact-birth", processBirth: "exact-birth",
    pid: 4242, observedAt: NOW.toISOString()
  }
};
const EVIDENCE: readonly CodexAsyncQuestionDurableEvidence[] = [{
  itemId: ITEM, turnId: TURN, currentIndex: 0, remainingCount: 2,
  questions: [
    { title: "What deadline should I use?" },
    { title: "Which environment should I use?", options: ["Staging", "Production"] }
  ]
}];
const OPTIONS_SCREEN = [
  "• Queued follow-up inputs", "", "  2 of 2", "",
  "  Which environment should I use?", "",
  "  › 1. Staging", "    2. Production", "    3. Other", "",
  "  enter submit   ctrl+] skip   shift+→ prev question"
].join("\n");
const OTHER_SCREEN = OPTIONS_SCREEN.replace("  › 1. Staging", "    1. Staging")
  .replace("    3. Other", "  › 3. Other");

function answerFor(offer: TerminalInteractionRuntimeOffer, option: number | string): TerminalInteractionAnswer {
  const question = offer.projection.questions[0];
  assert.ok(question);
  if (typeof option === "string") {
    assert.equal(question.response_kind, "free_text");
    return { question_id: question.question_id, response_kind: "free_text", text: option };
  }
  assert.equal(question.response_kind, "single_select");
  if (question.response_kind !== "single_select") throw new Error("Expected selectable question");
  return {
    question_id: question.question_id, response_kind: "single_select",
    selected_option_ids: [question.options[option]!.option_id]
  };
}

function responseFor(offer: TerminalInteractionRuntimeOffer, answer: TerminalInteractionAnswer): TerminalInteractionSubjectResponse {
  const subject = offer.projection.subject;
  assert.equal(subject.kind, "terminal_watch");
  if (subject.kind !== "terminal_watch") throw new Error("Expected exact Watch subject");
  return { interaction_id: offer.projection.interaction_id, subject, answers: [answer], delivery_mode: "steer_current_turn" };
}

function fixture(
  screen = OPTIONS_SCREEN,
  option: number | string = 1,
  evidence = EVIDENCE,
  runtime: TerminalRuntimeIdentity = RUNTIME
) {
  const events: string[] = [];
  const writes: NativeAnswer[] = [];
  const delegated: TerminalInteractionSubjectResponse[] = [];
  const state = {
    screen, evidence, reachable: true, blocked: false,
    approved: true, reservationThrows: false,
    delivery: "confirmed" as "confirmed" | "response_uncertain" | "preflight_throw" | "write_throw"
  };
  const offer = captureTerminalInteractionRuntimeOffer({
    agent: "codex", terminalControl: CONTROL, runtime, screen, now: NOW,
    trustedTerminalEvidence: terminalControlEvidence(CONTROL), codexAsyncQuestionEvidence: evidence
  });
  assert.ok(offer);
  const response = responseFor(offer, answerFor(offer, option));
  const bridge: ResponseInput["bridge"] = {
    async status(): Promise<TerminalBridgeStatus> {
      events.push("status");
      return {
        provider: CONTROL.kind, target: CONTROL.target, agent: "codex",
        reachable: state.reachable, capabilities: codexTerminalAgentAdapter.capabilities,
        activity_state: "working", activity_reason: "Exact native question",
        approval_state: { scanned: true, blocked: state.blocked, approvable: false },
        screen: { excerpt: state.screen }
      };
    },
    async respondInteraction(_agent, _control, current, options) {
      events.push("original_bridge");
      const authority = await options.authorize?.({
        agent: "codex", terminalControl: CONTROL, fingerprint: offer.promptFingerprint,
        projection: offer.projection, response, runtime
      });
      assert.equal(authority?.approved, true);
      await options.beforeDispatch?.({
        agent: "codex", terminalControl: CONTROL, fingerprint: offer.promptFingerprint,
        projection: offer.projection, response, runtime
      });
      events.push("native_other_open");
      delegated.push(current as TerminalInteractionSubjectResponse);
      return { responded: true, blocked: false, interactionId: offer.projection.interaction_id, outcome: "custom_text_opened" };
    }
  };
  const input: ResponseInput = {
    bridge, terminalControl: CONTROL, terminalEvidence: terminalControlEvidence(CONTROL),
    runtime, response, now: () => NOW,
    options: {
      agentVersion: runtime.agentVersion!, expectedFingerprint: offer.promptFingerprint,
      expectedExpiresAt: offer.projection.expires_at, runtime,
      authorize(context) {
        events.push("authorize");
        assert.equal(context.fingerprint, offer.promptFingerprint);
        assert.deepEqual(context.response.subject, response.subject);
        return { approved: state.approved };
      },
      beforeDispatch() {
        events.push("reserve");
        if (state.reservationThrows) throw new Error("Reservation receipt is unavailable");
      }
    },
    readQuestions: async () => { events.push("read_questions"); return state.evidence; },
    deliver: async (native) => {
      events.push("native_preflight");
      if (state.delivery === "preflight_throw") throw new Error("Exact native question is stale");
      await native.beforeDispatch?.();
      events.push("native_steer");
      writes.push(native);
      if (state.delivery === "write_throw") throw new Error("Native write result is unavailable");
      return {
        status: state.delivery, clientUserMessageId: "native_reply_42",
        nativeTurnId: native.nativeTurnId,
        nativeQuestionId: JSON.stringify(["request_user_input_async", native.itemId, native.questionIndex])
      };
    }
  };
  return { input, state, events, writes, delegated, offer };
}

test("paginated async selection uses the exact semantic label and native question tuple after authorization and reservation", async () => {
  const harness = fixture();
  const result = await respondCodexPaginatedAsyncQuestion(harness.input);
  assert.equal(result.outcome, "confirmed");
  assert.deepEqual(harness.events, ["read_questions", "status", "native_preflight", "authorize", "reserve", "native_steer"]);
  assert.equal(harness.delegated.length, 0);
  assert.equal(harness.writes.length, 1);
  const native = harness.writes[0]!;
  assert.equal(native.itemId, ITEM);
  assert.equal(native.questionIndex, 1);
  assert.equal(native.nativeTurnId, TURN);
  assert.equal(native.answer, "Production");
  assert.deepEqual(native.expectedQuestion, EVIDENCE[0]!.questions[1]);
  assert.equal(native.binding.threadId, THREAD);
  assert.deepEqual(harness.offer.projection.delivery_modes, ["steer_current_turn"]);
});

test("mixed Codex 0.159.0 physical and 0.159.2 backend keeps exact native async delivery", async () => {
  const runtime: TerminalRuntimeIdentity = {
    ...RUNTIME, agentVersion: "0.159.0",
    codexPaginatedThread: {
      ...RUNTIME.codexPaginatedThread!, agentVersion: "0.159.0", serverVersion: "0.159.2"
    }
  };
  const harness = fixture(OPTIONS_SCREEN, 1, EVIDENCE, runtime);
  const result = await respondCodexPaginatedAsyncQuestion(harness.input);
  assert.equal(result.outcome, "confirmed");
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0]?.binding.agentVersion, "0.159.0");
  assert.equal(harness.writes[0]?.binding.serverVersion, "0.159.2");
  assert.equal(harness.writes[0]?.nativeTurnId, TURN);
  assert.equal(harness.writes[0]?.answer, "Production");
});

test("Other only opens through the original bridge; its text answer uses the exact current-turn CAS", async () => {
  const opened = fixture(OPTIONS_SCREEN, 2);
  assert.equal((await respondCodexPaginatedAsyncQuestion(opened.input)).outcome, "custom_text_opened");
  assert.deepEqual(opened.events, ["read_questions", "status", "original_bridge", "authorize", "reserve", "native_other_open"]);
  assert.equal(opened.delegated.length, 1);
  assert.equal(opened.writes.length, 0);
  const answered = fixture(OTHER_SCREEN, "  Use the temporary staging environment.  ");
  assert.equal((await respondCodexPaginatedAsyncQuestion(answered.input)).outcome, "confirmed");
  assert.equal(answered.delegated.length, 0);
  assert.equal(answered.writes[0]?.answer, "Use the temporary staging environment.");
  assert.equal(answered.writes[0]?.itemId, ITEM);
  assert.equal(answered.writes[0]?.questionIndex, 1);
});

test("a Unicode-normalized native choice submits its original durable label", async () => {
  const nativeLabel = "Cafe\u0301";
  const evidence: readonly CodexAsyncQuestionDurableEvidence[] = [{
    ...EVIDENCE[0]!, questions: [EVIDENCE[0]!.questions[0]!, {
      title: "Which environment should I use?", options: ["Staging", nativeLabel]
    }]
  }];
  const harness = fixture(OPTIONS_SCREEN.replace("Production", "Café"), 1, evidence);
  assert.equal((await respondCodexPaginatedAsyncQuestion(harness.input)).outcome, "confirmed");
  assert.equal(harness.writes[0]?.answer, nativeLabel);
  assert.notEqual(harness.writes[0]?.answer, "Café");
});

test("changed, withdrawn, wrong-turn, blocked, or unreachable questions cause zero dispatch", async () => {
  const scenarios = ["changed_screen", "changed_payload", "withdrawn", "wrong_turn", "blocked", "unreachable"] as const;
  for (const scenario of scenarios) {
    const harness = fixture();
    if (scenario === "changed_screen") harness.state.screen = OPTIONS_SCREEN.replace("Which environment", "Which account");
    if (scenario === "changed_payload") harness.state.evidence = [{
      ...EVIDENCE[0]!, questions: [EVIDENCE[0]!.questions[0]!, { title: "Which account should I use?", options: ["Staging", "Production"] }]
    }];
    if (scenario === "withdrawn") harness.state.evidence = [];
    if (scenario === "wrong_turn") harness.state.evidence = [{ ...EVIDENCE[0]!, turnId: "another_native_turn" }];
    if (scenario === "blocked") harness.state.blocked = true;
    if (scenario === "unreachable") harness.state.reachable = false;
    await assert.rejects(respondCodexPaginatedAsyncQuestion(harness.input), TerminalInteractionInputNotStartedError, scenario);
    assert.deepEqual(harness.events, ["read_questions", "status"], scenario);
    assert.equal(harness.writes.length + harness.delegated.length, 0, scenario);
  }
});

test("native preflight and denied authority never reserve or write an answer", async () => {
  const stale = fixture();
  stale.state.delivery = "preflight_throw";
  await assert.rejects(respondCodexPaginatedAsyncQuestion(stale.input), TerminalInteractionInputNotStartedError);
  assert.deepEqual(stale.events, ["read_questions", "status", "native_preflight"]);
  const denied = fixture();
  denied.state.approved = false;
  await assert.rejects(respondCodexPaginatedAsyncQuestion(denied.input), TerminalInteractionInputNotStartedError);
  assert.deepEqual(denied.events, ["read_questions", "status", "native_preflight", "authorize"]);
  assert.equal(stale.writes.length + denied.writes.length, 0);
});

test("a rejecting reservation stays fenced without native input", async () => {
  const harness = fixture();
  harness.state.reservationThrows = true;
  await assert.rejects(respondCodexPaginatedAsyncQuestion(harness.input), (error: unknown) =>
    error instanceof TerminalInteractionDispatchReservedError && error.stage === "reservation_uncertain" && error.doNotRetry);
  assert.deepEqual(harness.events, ["read_questions", "status", "native_preflight", "authorize", "reserve"]);
  assert.equal(harness.writes.length, 0);
});

test("uncertain receipt or post-write failure stays fenced after exactly one native attempt", async () => {
  for (const delivery of ["response_uncertain", "write_throw"] as const) {
    const harness = fixture();
    harness.state.delivery = delivery;
    await assert.rejects(respondCodexPaginatedAsyncQuestion(harness.input), (error: unknown) =>
      error instanceof TerminalInteractionDispatchReservedError && error.stage === "key_uncertain" && error.doNotRetry);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.events.filter((event) => event === "native_steer").length, 1);
    assert.equal(harness.delegated.length, 0);
  }
});

test("paginated async response is scoped to exact Codex 0.158 current-turn delivery and task identity", async () => {
  for (const change of ["queue", "missing_task", "missing_binding", "0.157.1", "0.158.1"] as const) {
    const harness = fixture();
    const runtime = { ...RUNTIME };
    let response = harness.input.response;
    if (change === "queue") response = { ...response, delivery_mode: "queue_next_turn" };
    if (change === "missing_task") delete runtime.nativeTaskId;
    if (change === "missing_binding") delete runtime.codexPaginatedThread;
    if (change === "0.157.1" || change === "0.158.1") runtime.agentVersion = change;
    await assert.rejects(respondCodexPaginatedAsyncQuestion({ ...harness.input, runtime, response }), TerminalInteractionInputNotStartedError, change);
    assert.equal(harness.events.includes("native_preflight"), false, change);
    assert.equal(harness.writes.length + harness.delegated.length, 0, change);
  }
});

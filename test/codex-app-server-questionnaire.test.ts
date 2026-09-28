import assert from "node:assert/strict";
import test from "node:test";
import type {
  CodexAppServerInputQuestion,
  CodexAppServerPendingQuestion
} from "../src/codex-app-server-interaction-client.js";
import {
  accumulateCodexAppServerQuestionnaireAnswer,
  buildCodexAppServerQuestionnaireOffer,
  validateCodexBlockingQuestionDraft,
  type CodexAppServerQuestionnaireOffer,
  type CodexBlockingQuestionDraft
} from "../src/codex-app-server-questionnaire.js";
import {
  validateTerminalInteractionSubjectProjection,
  type TerminalInteractionSubject
} from "../src/terminal-interaction-protocol.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const SUBJECT: TerminalInteractionSubject = {
  kind: "terminal_watch", watch_id: "watch_158", anchor_fingerprint: "a".repeat(64)
};
const ENDPOINT = { pane: "%4", process: "codex:4242:exact-birth" };

function question(overrides: Partial<CodexAppServerInputQuestion> = {}): CodexAppServerInputQuestion {
  return {
    id: "native_question_id", header: "Company", question: "Do you mean UniPat AI?",
    isOther: false, isSecret: false,
    options: [
      { label: "Yes, UniPat AI", description: "Audit that company." },
      { label: "No", description: "Use a different company." }
    ],
    ...overrides
  };
}

function pending(questions = [question()]): CodexAppServerPendingQuestion {
  return {
    requestId: 42, threadId: "019ee559-7bb8-7fd1-970c-0f7b6978c44e",
    turnId: "native_turn_id", itemId: "native_item_id", isBlocking: true, questions
  };
}

function offer(
  request: CodexAppServerPendingQuestion,
  draft?: CodexBlockingQuestionDraft
): CodexAppServerQuestionnaireOffer {
  const result = buildCodexAppServerQuestionnaireOffer({
    pending: request, subject: SUBJECT, canonicalEndpointIdentity: ENDPOINT,
    now: NOW, ...(draft === undefined ? {} : { draft })
  });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected an executable native offer");
  return result.offer;
}

function response(current: CodexAppServerQuestionnaireOffer, optionIndex = 0): unknown {
  const projected = current.projection.questions[0];
  assert.equal(projected.response_kind, "single_select");
  if (projected.response_kind !== "single_select") throw new Error("Expected native options");
  return {
    interaction_id: current.projection.interaction_id,
    subject: current.projection.subject,
    answers: [{
      question_id: projected.question_id, response_kind: "single_select",
      selected_option_ids: [projected.options[optionIndex].option_id]
    }]
  };
}

test("native Codex RPC question projects real semantic options and returns exact labels", () => {
  const request = pending([question({ isOther: true })]);
  const current = offer(request);
  const projection = validateTerminalInteractionSubjectProjection(current.projection);
  assert.equal(projection.kind, "questionnaire");
  assert.equal(projection.turn_id, undefined);
  assert.equal(projection.delivery_modes, undefined);
  assert.deepEqual(projection.step, { index: 1, total: 1 });
  assert.deepEqual(projection.capabilities, {
    respond: true, batch_response: false, free_text: false, multi_select: false
  });
  const projected = projection.questions[0];
  assert.equal(projected.response_kind, "single_select");
  if (projected.response_kind !== "single_select") return;
  assert.deepEqual(projected.options.map((option) => option.label),
    ["Yes, UniPat AI", "No", "None of the above"]);
  assert.notEqual(projected.question_id, request.questions[0].id);
  const result = accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, offer: current, canonicalEndpointIdentity: ENDPOINT,
    response: response(current, 2), now: NOW
  });
  assert.deepEqual(result, {
    status: "ready", requestId: 42,
    answers: { native_question_id: { answers: ["None of the above"] } }
  });
  assert.equal("actionPlan" in current, false);
});

test("multiple native questions accumulate privately and send only a complete exact batch", () => {
  const request = pending([
    question({ id: "selected" }),
    question({ id: "notes", header: "Details", question: "What should the report cover?", options: null })
  ]);
  const first = offer(request);
  const advanced = accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, offer: first, canonicalEndpointIdentity: ENDPOINT,
    response: response(first), now: NOW
  });
  assert.equal(advanced.status, "advance");
  if (advanced.status !== "advance") return;
  assert.deepEqual(advanced.draft.answers, { selected: { answers: ["Yes, UniPat AI"] } });
  assert.equal(advanced.draft.nextQuestionIndex, 1);
  const second = offer(request, advanced.draft);
  assert.deepEqual(second.projection.step, { index: 2, total: 2 });
  assert.notEqual(second.projection.interaction_id, first.projection.interaction_id);
  assert.equal(JSON.stringify(second.projection).includes("Audit that company."), false);
  const result = accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, offer: second, canonicalEndpointIdentity: ENDPOINT,
    draft: advanced.draft, now: NOW,
    response: {
      interaction_id: second.projection.interaction_id,
      subject: SUBJECT,
      answers: [{
        question_id: second.projection.questions[0].question_id,
        response_kind: "free_text", text: "  financial and product evidence  "
      }]
    }
  });
  assert.deepEqual(result, {
    status: "ready", requestId: 42,
    answers: {
      selected: { answers: ["Yes, UniPat AI"] },
      notes: { answers: ["user_note: financial and product evidence"] }
    }
  });
  assert.deepEqual(advanced.draft.answers, { selected: { answers: ["Yes, UniPat AI"] } });
});

test("native standalone free text uses actual user_note encoding for null or empty options", () => {
  for (const options of [null, []]) {
    const request = pending([question({ options })]);
    const current = offer(request);
    const result = accumulateCodexAppServerQuestionnaireAnswer({
      pending: request, offer: current, canonicalEndpointIdentity: ENDPOINT,
      now: NOW, response: {
        interaction_id: current.projection.interaction_id, subject: SUBJECT,
        answers: [{
          question_id: current.projection.questions[0].question_id,
          response_kind: "free_text", text: "  exact native note  "
        }]
      }
    });
    assert.deepEqual(result, {
      status: "ready", requestId: 42,
      answers: { native_question_id: { answers: ["user_note: exact native note"] } }
    });
  }
});

test("question identity stays canonical while owner, endpoint, and full RPC payload changes fail closed", () => {
  const request = pending();
  const current = offer(request);
  const reordered = buildCodexAppServerQuestionnaireOffer({
    pending: request, subject: SUBJECT, now: NOW,
    canonicalEndpointIdentity: { process: ENDPOINT.process, pane: ENDPOINT.pane }
  });
  assert.equal(reordered.status, "ready");
  if (reordered.status !== "ready") return;
  assert.equal(reordered.offer.surfaceId, current.surfaceId);
  const otherOwner = buildCodexAppServerQuestionnaireOffer({
    pending: request, subject: { ...SUBJECT, watch_id: "another_watch" },
    canonicalEndpointIdentity: ENDPOINT, now: NOW
  });
  assert.equal(otherOwner.status, "ready");
  if (otherOwner.status !== "ready") return;
  assert.equal(otherOwner.offer.surfaceId, current.surfaceId);
  assert.notEqual(otherOwner.offer.projection.interaction_id, current.projection.interaction_id);
  for (const changed of [
    { ...request, requestId: "42" },
    { ...request, turnId: "different_turn" },
    { ...request, questions: [question({ question: "A different question?" })] },
    { ...request, questions: [question({ options: [
      { label: "Yes, UniPat AI", description: "Changed meaning." },
      { label: "No", description: "Use a different company." }
    ] })] }
  ]) {
    assert.equal(accumulateCodexAppServerQuestionnaireAnswer({
      pending: changed, offer: current, canonicalEndpointIdentity: ENDPOINT,
      response: response(current), now: NOW
    }).status, "invalidated");
  }
  assert.equal(accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, offer: current,
    canonicalEndpointIdentity: { ...ENDPOINT, process: "replacement-process" },
    response: response(current), now: NOW
  }).status, "invalidated");
});

test("partial drafts cannot survive changed native payloads or skip questions", () => {
  const request = pending([question({ id: "one" }), question({ id: "two" })]);
  const first = offer(request);
  const advanced = accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, offer: first, canonicalEndpointIdentity: ENDPOINT,
    response: response(first), now: NOW
  });
  assert.equal(advanced.status, "advance");
  if (advanced.status !== "advance") return;
  for (const draft of [
    { ...advanced.draft, requestId: "42" },
    { ...advanced.draft, stablePayloadFingerprint: "b".repeat(64) },
    { ...advanced.draft, answers: { two: { answers: ["Yes, UniPat AI"] } } },
    { ...advanced.draft, answers: { one: { answers: ["A fabricated label"] } } }
  ]) {
    assert.equal(buildCodexAppServerQuestionnaireOffer({
      pending: request, subject: SUBJECT, canonicalEndpointIdentity: ENDPOINT,
      draft, now: NOW
    }).status, "invalidated");
  }
  assert.equal(buildCodexAppServerQuestionnaireOffer({
    pending: { ...request, questions: [request.questions[0], question({ id: "two", question: "Changed?" })] },
    subject: SUBJECT, canonicalEndpointIdentity: ENDPOINT,
    draft: advanced.draft, now: NOW
  }).status, "invalidated");
  assert.throws(() => validateCodexBlockingQuestionDraft({
    ...advanced.draft, answers: { one: { answers: ["line\nbreak"] } }
  }));
});

test("secret or unrepresentable native batches advertise generic manual authority", () => {
  for (const questions of [
    [question({ isSecret: true, question: "SECRET PROMPT", options: null })],
    [question(), question({ id: "private", isSecret: true, question: "SECRET PROMPT" })],
    [question({ options: Array.from({ length: 6 }, (_, index) => ({
      label: "Choice " + index, description: ""
    })) })],
    [question({ question: "x".repeat(4_097) })],
    [question({ options: [
      { label: "duplicate", description: "First meaning." },
      { label: "duplicate", description: "Second meaning." }
    ] })]
  ]) {
    const request = pending(questions);
    const result = buildCodexAppServerQuestionnaireOffer({
      pending: request, subject: SUBJECT, canonicalEndpointIdentity: ENDPOINT, now: NOW
    });
    assert.equal(result.status, "manual_required");
    if (result.status !== "manual_required") return;
    assert.equal(result.offer.projection.response_authority, "notify_only");
    assert.equal(result.offer.projection.capabilities.respond, false);
    assert.equal(JSON.stringify(result.offer.projection).includes("SECRET PROMPT"), false);
    assert.equal(accumulateCodexAppServerQuestionnaireAnswer({
      pending: request, offer: result.offer, canonicalEndpointIdentity: ENDPOINT,
      now: NOW, response: {}
    }).status, "invalidated");
  }
});

test("expired, altered, invalid options and uncertain responses cannot produce a native write", () => {
  const request = pending();
  const current = offer(request);
  for (const bad of [
    { response: response(current), now: new Date(NOW.getTime() + 60_000) },
    { response: { interaction_id: current.projection.interaction_id, subject: SUBJECT, answers: [{
      question_id: current.projection.questions[0].question_id,
      response_kind: "single_select", selected_option_ids: ["invented_option"]
    }] }, now: NOW },
    { response: { interaction_id: current.projection.interaction_id, subject: SUBJECT, answers: [{
      question_id: current.projection.questions[0].question_id,
      response_kind: "free_text", text: "typed text is not this option"
    }] }, now: NOW }
  ]) {
    assert.equal(accumulateCodexAppServerQuestionnaireAnswer({
      pending: request, offer: current, canonicalEndpointIdentity: ENDPOINT, ...bad
    }).status, "invalidated");
  }
  assert.equal(accumulateCodexAppServerQuestionnaireAnswer({
    pending: request, canonicalEndpointIdentity: ENDPOINT, now: NOW,
    offer: { ...current, projection: {
      ...current.projection, prompt_fingerprint: "b".repeat(64)
    } },
    response: response(current)
  }).status, "invalidated");
  const uncertain = buildCodexAppServerQuestionnaireOffer({
    pending: request, subject: SUBJECT, canonicalEndpointIdentity: ENDPOINT,
    now: NOW, responseUncertain: true
  });
  assert.equal(uncertain.status, "manual_required");
  if (uncertain.status !== "manual_required") return;
  assert.equal(uncertain.offer.projection.state, "response_uncertain");
  assert.equal(uncertain.offer.projection.response_authority, "notify_only");
  assert.equal(buildCodexAppServerQuestionnaireOffer({
    pending: { ...request, isBlocking: false }, subject: SUBJECT,
    canonicalEndpointIdentity: ENDPOINT, now: NOW
  }).status, "invalidated");
});

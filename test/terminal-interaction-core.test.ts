import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateMatchesProjection,
  buildTerminalInteractionOffer,
  captureTerminalInteraction,
  createTerminalInteractionAggregate,
  hashTerminalInteractionResponse,
  type CaptureTerminalInteractionInput,
  reduceTerminalInteractionAggregate,
  TerminalInteractionTransitionError,
  validateTerminalInteractionAggregate
} from "../src/terminal-interaction-core.js";
import {
  selectTerminalInteractionResponder
} from "../src/terminal-interaction-authority.js";
import { executeTerminalInteractionResponseTransaction } from
  "../src/terminal-interaction-response-transaction.js";
import type { NativeQuestionnaireInspection } from
  "../src/terminal-questionnaire-adapter.js";

const PROMPT_SHA = "1".repeat(64);
const ANCHOR_SHA = "2".repeat(64);
const NOW = new Date("2026-09-09T00:00:00.000Z");

type TransactionScenario =
  | "success"
  | "input_not_started"
  | "input_uncertain"
  | "reserve_failed";

async function characterizeResponseTransaction(
  subject: "managed" | "watch",
  scenario: TransactionScenario
): Promise<string[]> {
  const calls: string[] = [];
  const inputNotStarted = new Error("input not started");
  await executeTerminalInteractionResponseTransaction<
    string,
    { approved: boolean },
    string,
    { responded: boolean }
  >({
    reservationFailureFence: subject === "managed"
      ? "write_started"
      : "confirmed",
    dispatch: async (hooks) => {
      calls.push("authorize");
      await hooks.authorize("surface");
      calls.push("reserve");
      await hooks.beforeDispatch("surface");
      if (scenario === "input_not_started") throw inputNotStarted;
      calls.push("input");
      if (scenario === "input_uncertain") throw new Error("uncertain");
      return { responded: true };
    },
    authorize: () => ({ approved: true }),
    createReservation: () => "receipt",
    reserve: () => {
      if (scenario === "reserve_failed") throw new Error("save failed");
      calls.push("reserved");
    },
    release: () => {
      calls.push("release");
    },
    releaseFailure: (_reservation, _error, releaseError) => releaseError,
    markUncertain: () => {
      calls.push("uncertain");
    },
    consume: () => {
      calls.push("consume");
    },
    responded: (execution) => execution.responded,
    isInputNotStarted: (error) => error === inputNotStarted,
    duplicateReservationError: () => new Error("duplicate"),
    inputNotStartedError: (error) => error,
    missingReservationError: () => new Error("missing reservation")
  }).catch(() => undefined);
  return calls;
}

test("managed and Watch share the response transaction ordering", async () => {
  for (const subject of ["managed", "watch"] as const) {
    assert.deepEqual(
      await characterizeResponseTransaction(subject, "success"),
      ["authorize", "reserve", "reserved", "input", "consume"],
      subject
    );
    assert.deepEqual(
      await characterizeResponseTransaction(subject, "input_not_started"),
      ["authorize", "reserve", "reserved", "release"],
      subject
    );
    assert.deepEqual(
      await characterizeResponseTransaction(subject, "input_uncertain"),
      ["authorize", "reserve", "reserved", "input", "uncertain"],
      subject
    );
  }
});

test("response transaction preserves each Store's save-failure fence", async () => {
  assert.deepEqual(
    await characterizeResponseTransaction("managed", "reserve_failed"),
    ["authorize", "reserve", "uncertain"]
  );
  assert.deepEqual(
    await characterizeResponseTransaction("watch", "reserve_failed"),
    ["authorize", "reserve"]
  );
});

function actionableInspection(): Extract<
  NativeQuestionnaireInspection,
  { readonly status: "actionable" }
> {
  return {
    status: "actionable",
    agent: "codex",
    profile: "codex/test/questionnaire-v1",
    current_step: 1,
    total_steps: 2,
    question: {
      question_id: "question_1",
      prompt: "Continue with the migration?",
      response_kind: "confirm",
      required: true
    },
    prompt_evidence: {
      profile: "codex/test/questionnaire-v1",
      exact_region: "private native screen region",
      sha256: PROMPT_SHA
    },
    action_plan: {
      kind: "confirm",
      confirm_stages: [{ kind: "key", key: "enter" }],
      cancel_stages: [{ kind: "key", key: "esc" }]
    }
  };
}

function watchSubject() {
  return {
    kind: "terminal_watch" as const,
    watch_id: "terminal-watch-123",
    anchor_fingerprint: ANCHOR_SHA
  };
}

test("subject-neutral builder gives monitor and Watch the same surface identity", () => {
  const common = {
    agent: "codex" as const,
    agentVersion: "0.153.4",
    canonicalTerminalIdentity: { pid: 42, endpoint: "tmux:test:0.0" },
    nativeTaskIdentity: { rollout: "rollout-1", thread: "thread-1" },
    inspection: actionableInspection(),
    now: NOW,
    expiresAt: "2026-09-09T00:10:00.000Z",
    responseAuthority: "executable" as const
  };
  const managed = buildTerminalInteractionOffer({
    ...common,
    subject: {
      kind: "managed_turn",
      turn_id: "turn_123",
      message_id: "message_123"
    }
  });
  const watch = buildTerminalInteractionOffer({
    ...common,
    subject: watchSubject()
  });

  assert.ok(managed);
  assert.ok(watch);
  assert.equal(managed.surfaceId, watch.surfaceId);
  assert.notEqual(
    managed.projection.interaction_id,
    watch.projection.interaction_id
  );
  assert.equal(managed.projection.version, 2);
  assert.deepEqual(managed.projection.subject, {
    kind: "managed_turn",
    turn_id: "turn_123",
    message_id: "message_123"
  });
  assert.equal("turn_id" in managed.projection, false);
  assert.equal(watch.projection.version, 2);
  assert.equal("turn_id" in watch.projection, false);
  assert.match(watch.projection.prompt_fingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(
    JSON.stringify(watch.projection).includes("private native screen region"),
    false
  );
});

test("surface identity canonicalizes record key order", () => {
  const base = {
    subject: watchSubject(),
    agent: "codex" as const,
    agentVersion: "0.153.4",
    nativeTaskIdentity: { thread: "thread-1", rollout: "rollout-1" },
    inspection: actionableInspection(),
    now: NOW,
    responseAuthority: "executable" as const
  };
  const first = buildTerminalInteractionOffer({
    ...base,
    canonicalTerminalIdentity: { endpoint: "tmux:test:0.0", pid: 42 }
  });
  const second = buildTerminalInteractionOffer({
    ...base,
    canonicalTerminalIdentity: { pid: 42, endpoint: "tmux:test:0.0" }
  });
  assert.equal(first?.surfaceId, second?.surfaceId);
});

test("async question is a parallel working interaction with delivery modes", () => {
  const input: CaptureTerminalInteractionInput = {
    subject: {
      kind: "managed_turn",
      turn_id: "turn_async",
      message_id: "message_async"
    },
    agent: "codex",
    agentVersion: "0.155.1",
    canonicalTerminalIdentity: { pid: 42, endpoint: "herdr:w1:p1" },
    nativeTaskIdentity: { rollout: "rollout-async", turn: "native-turn" },
    screen: [
      "• Working (3s • esc to interrupt)",
      "",
      "• Queued follow-up inputs",
      "  ? 1 question",
      "    shift + ← to answer"
    ].join("\n"),
    codexAsyncQuestionEvidence: [{
      itemId: "call_async",
      turnId: "native-turn",
      currentIndex: 0,
      remainingCount: 1,
      questions: [{
        title: "Which target should I use?",
        options: ["Local", "Remote"]
      }]
    }],
    now: NOW,
    expiresAt: "2026-09-09T00:10:00.000Z",
    responseAuthority: "executable"
  };
  const offer = captureTerminalInteraction(input);
  assert.ok(offer);
  assert.equal(offer.projection.kind, "async_question");
  assert.deepEqual(offer.projection.delivery_modes, [
    "steer_current_turn",
    "queue_next_turn"
  ]);
  assert.equal(offer.projection.capabilities.respond, true);
  assert.equal(offer.actionPlan.kind, "open_async_question_editor");
  const moved = buildTerminalInteractionOffer({
    ...input,
    inspection: { ...offer.nativeInspection, current_step: 2, total_steps: 3 }
  });
  assert.equal(moved?.projection.interaction_id, offer.projection.interaction_id);
  assert.equal(moved?.promptFingerprint, offer.promptFingerprint);
  assert.deepEqual(moved?.projection.step, { index: 2, total: 3 });
  assert.equal(captureTerminalInteraction({ ...input, secret: true }), undefined);
  for (const question of [
    { title: "Enter the password", options: ["Local", "Remote"] },
    { title: "Which target should I use?", options: ["API key", "Remote"] }
  ]) {
    assert.equal(captureTerminalInteraction({
      ...input,
      codexAsyncQuestionEvidence: [{
        ...input.codexAsyncQuestionEvidence![0]!,
        questions: [question]
      }]
    }), undefined);
  }
});

test("manual and best-effort observations cannot project response authority", () => {
  const manual: NativeQuestionnaireInspection = {
    ...actionableInspection(),
    status: "manual_required",
    reason: "unsupported_multi_select",
    action_plan: { kind: "manual_only" }
  };
  const manualOffer = buildTerminalInteractionOffer({
    subject: watchSubject(),
    agent: "codex",
    agentVersion: "0.153.4",
    canonicalTerminalIdentity: "terminal-1",
    nativeTaskIdentity: "task-1",
    inspection: manual,
    now: NOW,
    responseAuthority: "executable"
  });
  const notifyOffer = buildTerminalInteractionOffer({
    subject: watchSubject(),
    agent: "codex",
    agentVersion: "0.153.4",
    canonicalTerminalIdentity: "terminal-1",
    nativeTaskIdentity: "task-1",
    inspection: actionableInspection(),
    now: NOW,
    responseAuthority: "notify_only"
  });

  assert.equal(manualOffer?.projection.state, "manual_required");
  assert.equal(manualOffer?.projection.response_authority, "notify_only");
  assert.equal(manualOffer?.projection.capabilities.respond, false);
  assert.equal(notifyOffer?.projection.state, "pending");
  assert.equal(notifyOffer?.projection.response_authority, "notify_only");
  assert.equal(notifyOffer?.projection.capabilities.respond, false);
});

test("durable reducer permits only reserved one-shot response transitions", () => {
  const offer = buildTerminalInteractionOffer({
    subject: watchSubject(),
    agent: "codex",
    agentVersion: "0.153.4",
    canonicalTerminalIdentity: "terminal-1",
    nativeTaskIdentity: "task-1",
    inspection: actionableInspection(),
    now: NOW,
    expiresAt: "2026-09-09T00:01:00.000Z",
    responseAuthority: "executable"
  });
  assert.ok(offer);
  const pending = createTerminalInteractionAggregate(
    offer.projection,
    NOW.toISOString()
  );
  assert.equal(aggregateMatchesProjection(pending, offer.projection), true);
  const refreshed = reduceTerminalInteractionAggregate(pending, {
    type: "refresh",
    expires_at: "2026-09-09T00:02:00.000Z",
    response_authority: "notify_only"
  });
  const notifyProjection = {
    ...offer.projection,
    expires_at: refreshed.expires_at,
    response_authority: "notify_only" as const,
    capabilities: { ...offer.projection.capabilities, respond: false }
  };
  assert.equal(aggregateMatchesProjection(refreshed, notifyProjection), true);
  const executable = reduceTerminalInteractionAggregate(refreshed, {
    type: "refresh",
    expires_at: refreshed.expires_at,
    response_authority: "executable"
  });
  assert.equal(executable.response_authority, "executable");
  const responseHash = hashTerminalInteractionResponse({ confirm: true });
  const reserved = reduceTerminalInteractionAggregate(executable, {
    type: "reserve",
    attempt_id: "attempt_1",
    response_hash: responseHash,
    at: "2026-09-09T00:01:01.000Z"
  });
  const consumed = reduceTerminalInteractionAggregate(reserved, {
    type: "consume",
    at: "2026-09-09T00:01:02.000Z",
    reason_code: "native_step_advanced"
  });

  assert.equal(consumed.state, "consumed");
  assert.equal(consumed.reservation?.response_hash, responseHash);
  assert.deepEqual(validateTerminalInteractionAggregate(consumed), consumed);
  assert.throws(
    () => reduceTerminalInteractionAggregate(consumed, {
      type: "reserve",
      attempt_id: "attempt_2",
      response_hash: responseHash,
      at: "2026-09-09T00:01:03.000Z"
    }),
    TerminalInteractionTransitionError
  );
});

test("responder arbitration is deterministic and managed-first", () => {
  const claims = [
    {
      owner_id: "watch-a",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "exact_request_watch" as const,
      response_authority: "executable" as const,
      created_at: "2026-09-09T00:00:02.000Z"
    },
    {
      owner_id: "turn-a",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "managed_turn" as const,
      response_authority: "executable" as const,
      created_at: "2026-09-09T00:00:01.000Z"
    },
    {
      owner_id: "activity-a",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "activity_watch" as const,
      response_authority: "executable" as const,
      created_at: "2026-09-09T00:00:03.000Z"
    },
    {
      owner_id: "exact-task-newer",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "exact_task_watch" as const,
      response_authority: "executable" as const,
      created_at: "2026-09-09T00:00:04.000Z"
    }
  ];
  assert.equal(selectTerminalInteractionResponder(claims)?.owner_id, "turn-a");

  const watchOnly = claims.filter(({ responder_class }) =>
    responder_class !== "managed_turn");
  assert.equal(
    selectTerminalInteractionResponder(watchOnly)?.owner_id,
    "watch-a",
    "an activity Watch can never execute even when its claim is malformed"
  );
  assert.equal(
    selectTerminalInteractionResponder([
      {
        ...claims[0],
        owner_id: "watch-older",
        created_at: "2026-09-09T00:00:01.000Z"
      },
      {
        ...claims[0],
        owner_id: "watch-newer",
        created_at: "2026-09-09T00:00:04.000Z"
      }
    ])?.owner_id,
    "watch-newer"
  );
  assert.equal(
    selectTerminalInteractionResponder([{
      ...claims[1],
      response_authority: "notify_only"
    }]),
    undefined
  );
  const tied = [
    { ...claims[0], owner_id: "watch-b" },
    { ...claims[0], owner_id: "watch-a" }
  ];
  assert.equal(selectTerminalInteractionResponder(tied)?.owner_id, "watch-a");
  assert.equal(
    selectTerminalInteractionResponder([...tied].reverse())?.owner_id,
    "watch-a"
  );
});

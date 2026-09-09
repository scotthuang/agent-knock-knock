import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateMatchesProjection,
  buildTerminalInteractionOffer,
  createTerminalInteractionAggregate,
  hashTerminalInteractionResponse,
  reduceTerminalInteractionAggregate,
  TerminalInteractionTransitionError,
  validateTerminalInteractionAggregate
} from "../src/terminal-interaction-core.js";
import {
  selectTerminalInteractionResponder
} from "../src/terminal-interaction-authority.js";
import type { NativeQuestionnaireInspection } from
  "../src/terminal-questionnaire-adapter.js";

const PROMPT_SHA = "1".repeat(64);
const ANCHOR_SHA = "2".repeat(64);
const NOW = new Date("2026-09-09T00:00:00.000Z");

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
  assert.equal(managed.projection.turn_id, "turn_123");
  assert.equal("turn_id" in watch.projection, false);
  assert.equal(watch.projection.prompt_fingerprint, PROMPT_SHA);
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
    expires_at: "2026-09-09T00:02:00.000Z"
  });
  const responseHash = hashTerminalInteractionResponse({ confirm: true });
  const reserved = reduceTerminalInteractionAggregate(refreshed, {
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
      response_authority: "executable" as const
    },
    {
      owner_id: "turn-a",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "managed_turn" as const,
      response_authority: "executable" as const
    },
    {
      owner_id: "activity-a",
      owner_session: "agent:main:main",
      surface_id: "surface-1",
      responder_class: "activity_watch" as const,
      response_authority: "notify_only" as const
    }
  ];
  assert.equal(selectTerminalInteractionResponder(claims)?.owner_id, "turn-a");
});

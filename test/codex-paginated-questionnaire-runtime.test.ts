import assert from "node:assert/strict";
import test from "node:test";
import {
  observeCodexPaginatedBlockingQuestion,
  respondCodexPaginatedBlockingQuestion,
  type CodexPaginatedQuestionnaireClient,
  type CodexPaginatedQuestionnaireConnect
} from "../src/codex-paginated-questionnaire-runtime.js";
import type {
  CodexAppServerPendingQuestion,
  CodexAppServerQuestionAnswers
} from "../src/codex-app-server-interaction-client.js";
import {
  createCodexPaginatedTaskAnchor,
  createCodexPaginatedTaskCheckpoint,
  type CodexPaginatedTaskCheckpoint
} from "../src/codex-paginated-task.js";
import {
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  type TerminalWatch
} from "../src/terminal-watch-record.js";
import {
  terminalControlEvidence,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";
import {
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError
} from "../src/terminal-interaction-response-bridge.js";
import type {
  TerminalInteractionSubjectProjection,
  TerminalInteractionSubjectResponse
} from "../src/terminal-interaction-protocol.js";
import { fingerprint } from "../src/terminal-submission-facts.js";

const NOW = new Date("2026-10-01T00:00:00.000Z");
const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const TURN = "native_turn";
const CONTROL: TerminalControlRef = {
  kind: "herdr", target: "workspace/tab/pane", session: "fixture-session",
  socketPath: "/tmp/fixture.sock", panePid: 4242, currentCommand: "codex",
  currentPath: "/repo", capabilities: ["screen_status", "durable_completion"],
  sessionDir: "/tmp/fixture-session", workspaceId: "workspace", tabId: "tab",
  paneId: "pane", terminalId: "terminal_resource"
};

function fixture() {
  const anchor = createCodexPaginatedTaskAnchor({
    origin: "active_task", captured_at: NOW.toISOString(), codex_home: "/codex",
    codex_version: "0.158.0", native_thread_id: THREAD, turn_id: TURN,
    process_uuid: "codex-pid:4242:birth:exact-birth", process_birth: "exact-birth",
    pid: 4242, request_hash: "a".repeat(64)
  });
  const acceptanceBase = {
    source: "codex_paginated" as const, kind: "native_user_turn" as const,
    nativeThreadId: THREAD, requestHash: anchor.request_hash, acceptanceId: TURN,
    anchorFingerprint: anchor.anchor_fingerprint, metadata: { turn_id: TURN }
  };
  const checkpoint = createCodexPaginatedTaskCheckpoint({
    ...acceptanceBase, evidenceFingerprint: fingerprint(acceptanceBase)
  });
  const watch: TerminalWatch = {
    schema: TERMINAL_WATCH_SCHEMA, version: TERMINAL_WATCH_VERSION,
    watch_id: "watch_native_question", agent: "codex",
    terminal: {
      terminal_id: "terminal:v2:fixture", terminal_endpoint: terminalControlEvidence(CONTROL),
      workspace: "/repo", binding_token: "b".repeat(64)
    },
    anchor, observation_checkpoint: checkpoint, interaction_policy: "respond_when_exact",
    openclaw_session: "fixture-session", openclaw_bin: "openclaw",
    created_at: NOW.toISOString(), deadline_at: new Date(NOW.getTime() + 60_000).toISOString(),
    updated_at: NOW.toISOString(), status: "active", last_activity_at: NOW.toISOString(),
    notification_outbox: []
  };
  const pending: CodexAppServerPendingQuestion = {
    requestId: 42, threadId: THREAD, turnId: TURN, itemId: "native_item", isBlocking: true,
    questions: [{
      id: "native_choice", header: "Company", question: "Do you mean UniPat AI?",
      isSecret: false, isOther: false,
      options: [{ label: "Yes", description: "Use that company." }, { label: "No", description: "Use another company." }]
    }]
  };
  return { watch, checkpoint, pending };
}

function clientHarness(requests: CodexAppServerPendingQuestion[]) {
  const events: string[] = [];
  const writes: { requestId: string | number; answers: CodexAppServerQuestionAnswers }[] = [];
  let receipt: "confirmed" | "response_uncertain" | "throw" = "confirmed";
  let closeThrows = false;
  const client: CodexPaginatedQuestionnaireClient = {
    listPendingQuestions: () => structuredClone(requests),
    async answer(requestId, answers) {
      events.push("native_write");
      writes.push({ requestId, answers: structuredClone(answers) });
      if (receipt === "throw") throw new Error("Transport outcome unavailable");
      return { status: receipt, requestId, itemId: "native_item" };
    },
    async close() {
      events.push("close");
      if (closeThrows) throw new Error("Cleanup failure");
    }
  };
  const connect: CodexPaginatedQuestionnaireConnect = async (options) => {
    events.push("connect");
    assert.equal(options.binding.threadId, THREAD);
    assert.equal(options.nativeTurnId, TURN);
    return client;
  };
  return {
    connect, writes, events,
    receipt(value: typeof receipt) { receipt = value; },
    failClose() { closeThrows = true; }
  };
}

async function projection(
  watch: TerminalWatch, checkpoint: CodexPaginatedTaskCheckpoint,
  connect: CodexPaginatedQuestionnaireConnect
): Promise<TerminalInteractionSubjectProjection> {
  const observed = await observeCodexPaginatedBlockingQuestion({
    watch, checkpoint, now: NOW, connect,
    responseDecision: () => ({ executable: true, suppress: false })
  });
  assert.equal(observed?.kind, "interaction");
  if (observed?.kind !== "interaction" || !observed.current_interaction) {
    throw new Error("Expected a native question observation");
  }
  return observed.current_interaction.projection;
}

function response(current: TerminalInteractionSubjectProjection): TerminalInteractionSubjectResponse {
  const question = current.questions[0];
  const answers: TerminalInteractionSubjectResponse["answers"] =
    question.response_kind === "single_select"
      ? [{ question_id: question.question_id, response_kind: "single_select", selected_option_ids: [question.options[0].option_id] }]
      : [{ question_id: question.question_id, response_kind: "free_text", text: "  private additional scope  " }];
  return current.subject.kind === "terminal_watch"
    ? { interaction_id: current.interaction_id, subject: current.subject, answers }
    : { interaction_id: current.interaction_id, subject: current.subject, answers };
}

test("native questionnaire observation uses exact ownership and respects notification authority", async () => {
  const { watch, checkpoint, pending } = fixture();
  const harness = clientHarness([pending]);
  const observed = await observeCodexPaginatedBlockingQuestion({
    watch, checkpoint, now: NOW, connect: harness.connect,
    responseDecision: () => ({ executable: false, suppress: true })
  });
  assert.equal(observed?.kind, "interaction");
  if (observed?.kind !== "interaction") return;
  assert.equal(observed.anchor_fingerprint, watch.anchor.anchor_fingerprint);
  assert.equal(observed.current_interaction?.projection.response_authority, "notify_only");
  assert.equal(observed.current_interaction?.projection.capabilities.respond, false);
  assert.equal(observed.suppress_notification, true);
  assert.equal(observed.manual_interaction?.prompt, pending.questions[0].question);
  assert.equal(observed.evidence_fingerprint, fingerprint({
    schema: "agent-knock-knock/terminal-watch-interaction-event",
    version: 1,
    watch_id: watch.watch_id,
    interaction_id: observed.current_interaction!.projection.interaction_id,
    surface_id: observed.current_interaction!.projection.surface_id
  }), "the consume transaction must supersede this exact callback event");
  assert.equal(harness.writes.length, 0);
  assert.deepEqual(harness.events, ["connect", "close"]);
  const wrongTask = clientHarness([{ ...pending, turnId: "different_turn" }]);
  assert.equal(await observeCodexPaginatedBlockingQuestion({
    watch, checkpoint, now: NOW, connect: wrongTask.connect,
    responseDecision: () => ({ executable: true, suppress: false })
  }), undefined);
  assert.equal(wrongTask.writes.length, 0);
});

test("multi-question partial advance persists privately after reservation without native input", async () => {
  const { watch, checkpoint, pending } = fixture();
  pending.questions.push({
    id: "native_note", header: "Scope", question: "What evidence should be covered?",
    isSecret: false, isOther: false, options: null
  });
  const harness = clientHarness([pending]);
  let storedCheckpoint = checkpoint;
  const first = await projection(watch, storedCheckpoint, harness.connect);
  harness.events.length = 0;
  const partial = await respondCodexPaginatedBlockingQuestion({
    watch, checkpoint: storedCheckpoint, terminalControl: CONTROL,
    response: response(first), expectedFingerprint: first.prompt_fingerprint,
    now: () => NOW, connect: harness.connect,
    authorize: () => { harness.events.push("authorize"); return { approved: true }; },
    beforeDispatch: () => { harness.events.push("reserve"); },
    persistDraft: (draft) => {
      harness.events.push("persist_partial");
      assert.ok(draft);
      storedCheckpoint = { ...storedCheckpoint, blocking_question_draft: draft };
    }
  });
  assert.equal(partial.outcome, "submitted_or_advanced");
  assert.deepEqual(harness.events, ["connect", "authorize", "reserve", "persist_partial", "close"]);
  assert.equal(harness.writes.length, 0);
  assert.equal(storedCheckpoint.blocking_question_draft?.nextQuestionIndex, 1);
  const second = await projection(watch, storedCheckpoint, harness.connect);
  assert.equal(second.step.index, 2);
  assert.equal(JSON.stringify(second).includes("Use that company."), false);
  harness.events.length = 0;
  const final = await respondCodexPaginatedBlockingQuestion({
    watch, checkpoint: storedCheckpoint, terminalControl: CONTROL,
    response: response(second), expectedFingerprint: second.prompt_fingerprint,
    now: () => NOW, connect: harness.connect,
    authorize: () => { harness.events.push("authorize"); return { approved: true }; },
    beforeDispatch: () => { harness.events.push("reserve"); },
    persistDraft: (draft) => {
      harness.events.push("clear_draft");
      assert.equal(draft, undefined);
      storedCheckpoint = { ...storedCheckpoint };
      delete storedCheckpoint.blocking_question_draft;
    }
  });
  assert.equal(final.outcome, "confirmed");
  assert.deepEqual(harness.events, ["connect", "authorize", "reserve", "native_write", "clear_draft", "close"]);
  assert.deepEqual(harness.writes, [{
    requestId: 42,
    answers: {
      native_choice: { answers: ["Yes"] },
      native_note: { answers: ["user_note: private additional scope"] }
    }
  }]);
  assert.equal(storedCheckpoint.blocking_question_draft, undefined);
  assert.equal(JSON.stringify(final).includes("private additional scope"), false);
});

test("native response never writes when authorization or durable reservation is rejected", async () => {
  const { watch, checkpoint, pending } = fixture();
  for (const stage of ["authorize", "reserve"] as const) {
    const harness = clientHarness([pending]);
    const current = await projection(watch, checkpoint, harness.connect);
    await assert.rejects(respondCodexPaginatedBlockingQuestion({
      watch, checkpoint, terminalControl: CONTROL, response: response(current),
      expectedFingerprint: current.prompt_fingerprint, now: () => NOW,
      connect: harness.connect,
      authorize: () => ({ approved: stage !== "authorize" }),
      beforeDispatch: () => {
        if (stage === "reserve") throw new TerminalInteractionDispatchReservedError("reservation_uncertain", "Reservation failed");
      },
      persistDraft: () => assert.fail("No draft should be persisted")
    }), stage === "authorize" ? TerminalInteractionInputNotStartedError : TerminalInteractionDispatchReservedError);
    assert.equal(harness.writes.length, 0);
  }
});

test("uncertain or throwing native writes retain the no-retry reservation fence", async () => {
  const { watch, checkpoint, pending } = fixture();
  for (const receipt of ["response_uncertain", "throw"] as const) {
    const harness = clientHarness([pending]);
    const current = await projection(watch, checkpoint, harness.connect);
    harness.receipt(receipt);
    let reserved = false;
    await assert.rejects(respondCodexPaginatedBlockingQuestion({
      watch, checkpoint, terminalControl: CONTROL, response: response(current),
      expectedFingerprint: current.prompt_fingerprint, now: () => NOW,
      connect: harness.connect, authorize: () => ({ approved: true }),
      beforeDispatch: () => { reserved = true; },
      persistDraft: () => assert.fail("Unconfirmed answers must retain the private draft")
    }), (error: unknown) => error instanceof TerminalInteractionDispatchReservedError &&
      error.doNotRetry && error.stage === "key_uncertain");
    assert.equal(reserved, true);
    assert.equal(harness.writes.length, 1);
  }
});

test("cleanup failures cannot change a confirmed native answer into another attempt", async () => {
  const { watch, checkpoint, pending } = fixture();
  const harness = clientHarness([pending]);
  const current = await projection(watch, checkpoint, harness.connect);
  harness.failClose();
  const result = await respondCodexPaginatedBlockingQuestion({
    watch, checkpoint, terminalControl: CONTROL, response: response(current),
    expectedFingerprint: current.prompt_fingerprint, now: () => NOW,
    connect: harness.connect, authorize: () => ({ approved: true }),
    beforeDispatch: () => {}, persistDraft: (draft) => assert.equal(draft, undefined)
  });
  assert.equal(result.outcome, "confirmed");
  assert.equal(harness.writes.length, 1);
});

test("unavailable or changed native questions are proved not started before response", async () => {
  const { watch, checkpoint, pending } = fixture();
  const baseline = clientHarness([pending]);
  const current = await projection(watch, checkpoint, baseline.connect);
  const unavailable: CodexPaginatedQuestionnaireConnect = async () => { throw new Error("Native endpoint unavailable"); };
  const changed = clientHarness([{ ...pending, requestId: 43 }]);
  for (const connect of [unavailable, changed.connect]) {
    await assert.rejects(respondCodexPaginatedBlockingQuestion({
      watch, checkpoint, terminalControl: CONTROL, response: response(current),
      expectedFingerprint: current.prompt_fingerprint, now: () => NOW,
      connect, authorize: () => assert.fail("Changed question cannot be authorized"),
      beforeDispatch: () => assert.fail("Changed question cannot be reserved"),
      persistDraft: () => assert.fail("Changed question cannot persist answers")
    }), TerminalInteractionInputNotStartedError);
  }
  assert.equal(changed.writes.length, 0);
});

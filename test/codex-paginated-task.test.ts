import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type {
  CodexAppServerThreadItem,
  CodexAppServerTurn
} from "../src/codex-app-server-read-client.js";
import {
  codexPaginatedAsyncQuestionEvidence,
  createCodexPaginatedTaskAnchor,
  createCodexPaginatedTaskCheckpoint,
  observeCodexPaginatedTask,
  validateCodexPaginatedTaskAnchor,
  validateCodexPaginatedTaskCheckpoint,
  type CodexPaginatedTaskAnchor,
  type CodexPaginatedTaskSnapshot
} from "../src/codex-paginated-task.js";

const THREAD = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const REQUEST = "检查这一段\nThen verify the callback.";
const REQUEST_HASH = createHash("sha256").update(REQUEST).digest("hex");
const NOW = "2026-10-01T00:00:00.000Z";

function anchor(
  fields: Partial<Omit<CodexPaginatedTaskAnchor, "schema" | "version" | "anchor_fingerprint">> = {}
): CodexPaginatedTaskAnchor {
  return createCodexPaginatedTaskAnchor({
    origin: "user_explicit_send",
    captured_at: NOW,
    codex_home: "/codex",
    codex_version: "0.158.0",
    native_thread_id: THREAD,
    process_uuid: "codex-pid:4242:birth:exact-birth",
    process_birth: "exact-birth",
    pid: 4242,
    request_hash: REQUEST_HASH,
    baseline_latest_turn_id: "baseline",
    ...fields
  });
}

function user(id: string, text: string): CodexAppServerThreadItem {
  return { id, type: "userMessage", content: [{ type: "text", text }] };
}

function final(id: string, text: string): CodexAppServerThreadItem {
  return { id, type: "agentMessage", text, phase: "final_answer" };
}

function turn(
  id: string,
  startedAt: number,
  status: CodexAppServerTurn["status"] = "completed",
  items = [user(id + "-input", REQUEST), final(id + "-output", "Exact result.")]
): CodexAppServerTurn {
  return {
    id, status, items, itemsView: "full", error: null,
    startedAt, completedAt: status === "inProgress" ? null : startedAt + 1,
    durationMs: status === "inProgress" ? null : 1_000
  };
}

function snapshot(turns: CodexAppServerTurn[], version = "0.158.0"): CodexPaginatedTaskSnapshot {
  return {
    codexHome: "/codex",
    serverVersion: version,
    completeToBoundary: true,
    thread: {
      id: THREAD,
      sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c450",
      cwd: "/repo",
      historyMode: "paginated",
      cliVersion: "0.155.1",
      originator: "codex-tui",
      source: "vscode",
      status: { type: "active", activeFlags: [] },
      turns: []
    },
    turns
  };
}

function asyncQuestion(): CodexAppServerThreadItem {
  return {
    id: "question-item",
    type: "agentMessage",
    delivery: "async",
    phase: "final_answer",
    text: "This is a question, not a final answer.",
    questions: [
      { title: "Choose the framework.", options: ["React", "Vue"] },
      { title: "Choose the language.", options: ["TypeScript", "JavaScript"] }
    ]
  };
}

function answerText(index: number, itemId = "question-item"): string {
  return "<send_user_message_question_reply>\n" + JSON.stringify({
    answer: index === 0 ? "React" : "TypeScript",
    question: index === 0 ? "Choose the framework." : "Choose the language.",
    questionItemId: JSON.stringify(["request_user_input_async", itemId, index])
  }) + "\n</send_user_message_question_reply>";
}

for (const version of ["0.158.0", "0.159.0"] as const) {
  test(`paginated ${version} acceptance excludes the pre-Send boundary and binds a separate native turn`, () => {
    const original = anchor({ codex_version: version });
    const old = turn("baseline", 100);
    assert.equal(observeCodexPaginatedTask({
      anchor: original, snapshot: snapshot([old], version)
    }).status, "pending");
    const result = observeCodexPaginatedTask({
      anchor: original, snapshot: snapshot([turn("accepted", 200), old], version)
    });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") assert.fail("exact native turn should complete");
    assert.equal(result.evidence.source, "codex_paginated");
    assert.equal(result.evidence.nativeThreadId, THREAD);
    assert.equal(result.evidence.acceptanceId, "accepted");
    assert.equal(result.evidence.requestHash, REQUEST_HASH);
    assert.equal(result.completion.text, "Exact result.");
    assert.equal(result.completion.outcome, "success");
    assert.equal(validateCodexPaginatedTaskCheckpoint(result.checkpoint, original), result.checkpoint);
    assert.equal(JSON.stringify(original).includes(REQUEST), false);
  });

  test(`native ${version} Plan-mode completion preserves the exact task's plan body`, () => {
    const plan = { id: "plan-output", type: "plan", text: "Chosen answer: Yes.\n\nImplement the requested change." };
    const accepted = turn("accepted", 200, "completed", [user("accepted-input", REQUEST), plan]);
    const result = observeCodexPaginatedTask({
      anchor: anchor({ codex_version: version }), snapshot: snapshot([
        turn("unrelated", 300, "completed", [user("later-input", "A different task"),
          { id: "later-plan", type: "plan", text: "Unrelated plan" }]),
        accepted, turn("baseline", 100)
      ], version)
    });
    if (result.status !== "completed") assert.fail("the exact native Plan task should complete");
    assert.equal(result.completion.id, "accepted");
    assert.equal(result.completion.text, plan.text);
    assert.equal(result.completion.outcome, "success");
  });

}

test("completion selects the latest explicit native result without using async questions or commentary", () => {
  const plan = { id: "plan-output", type: "plan", text: "Final native plan." };
  const commentary = { id: "commentary", type: "agentMessage", phase: "commentary", text: "Working on it." };
  for (const [outputs, expected] of [
    [[final("older-result", "Earlier answer."), plan, commentary, asyncQuestion()], plan.text],
    [[plan, final("newer-result", "Final native answer."), commentary, asyncQuestion()], "Final native answer."]
  ] as const) {
    const result = observeCodexPaginatedTask({ anchor: anchor(), snapshot: snapshot([
      turn("accepted", 200, "completed", [user("accepted-input", REQUEST), ...outputs]),
      turn("baseline", 100)
    ]) });
    if (result.status !== "completed") assert.fail("native task should complete");
    assert.equal(result.completion.text, expected);
  }
});

test("paginated task matching rejects ambiguity, pagination gaps, and partial item views", () => {
  const original = anchor();
  const data = snapshot([turn("second", 300), turn("first", 200), turn("baseline", 100)]);
  assert.equal(observeCodexPaginatedTask({ anchor: original, snapshot: data }).status, "uncertain");
  assert.equal(observeCodexPaginatedTask({
    anchor: original, snapshot: { ...data, completeToBoundary: false }
  }).status, "unavailable");
  assert.equal(observeCodexPaginatedTask({
    anchor: original, snapshot: snapshot([turn("accepted", 200)])
  }).status, "unavailable");
  const partial = turn("accepted", 200);
  partial.itemsView = "summary";
  assert.equal(observeCodexPaginatedTask({
    anchor: original, snapshot: snapshot([partial, turn("baseline", 100)])
  }).status, "unavailable");
  assert.equal(observeCodexPaginatedTask({
    anchor: original, snapshot: { ...data, serverVersion: "0.158.1" }
  }).status, "invalidated");
});

test("persisted paginated acceptance never rebinds to a later identical request", () => {
  const original = anchor();
  const acceptedTurn = turn("accepted", 200, "inProgress");
  const first = observeCodexPaginatedTask({
    anchor: original, snapshot: snapshot([acceptedTurn, turn("baseline", 100)])
  });
  assert.equal(first.status, "accepted");
  if (first.status !== "accepted") assert.fail("native input should be accepted");
  const settled = observeCodexPaginatedTask({
    anchor: original,
    checkpoint: first.checkpoint,
    snapshot: snapshot([turn("later-identical-request", 300, "inProgress"), turn("accepted", 200)])
  });
  assert.equal(settled.status, "completed");
  if (settled.status !== "completed") assert.fail("original task should complete");
  assert.equal(settled.evidence, first.evidence);
  assert.equal(settled.evidence.acceptanceId, "accepted");
  assert.equal(settled.completion.id, "accepted");
  assert.equal(settled.completion.metadata?.answer_turn_id, undefined);
});

test("paginated anchors and checkpoints reject changed bindings", () => {
  const original = anchor();
  assert.equal(validateCodexPaginatedTaskAnchor(original), original);
  assert.throws(() => validateCodexPaginatedTaskAnchor({ ...original, pid: 9999 }), /fingerprint/u);
  assert.throws(() => anchor({ origin: "active_task", turn_id: undefined }), /task binding/u);
  const accepted = observeCodexPaginatedTask({
    anchor: original, snapshot: snapshot([turn("accepted", 200), turn("baseline", 100)])
  });
  if (accepted.status !== "completed") assert.fail("fixture must complete");
  assert.throws(() => validateCodexPaginatedTaskCheckpoint(accepted.checkpoint, anchor({
    request_hash: "0".repeat(64)
  })), /exact request binding/u);
});

test("persisted 0.159 task identity survives reload and rejects a different supported backend", () => {
  const original = anchor({ codex_version: "0.159.0" });
  const reloaded = validateCodexPaginatedTaskAnchor(JSON.parse(JSON.stringify(original)));
  const first = observeCodexPaginatedTask({ anchor: reloaded,
    snapshot: snapshot([turn("accepted", 200, "inProgress"), turn("baseline", 100)], "0.159.0") });
  if (first.status !== "accepted") assert.fail("0.159 task must bind before completion");
  const checkpoint = validateCodexPaginatedTaskCheckpoint(
    JSON.parse(JSON.stringify(first.checkpoint)), reloaded);
  const completed = observeCodexPaginatedTask({ anchor: reloaded, checkpoint,
    snapshot: snapshot([turn("later-identical", 300), turn("accepted", 200)], "0.159.0") });
  if (completed.status !== "completed") assert.fail("the bound turn must complete");
  assert.equal(completed.completion.id, "accepted");
  for (const [binding, backend] of [["0.158.0", "0.159.0"], ["0.159.0", "0.158.0"]] as const) {
    assert.equal(observeCodexPaginatedTask({ anchor: anchor({ codex_version: binding }),
      snapshot: snapshot([turn("accepted", 200), turn("baseline", 100)], backend) }).status, "invalidated");
  }
});

test("a persisted 0.159.0 frontend task completes on its bound 0.159.2 backend without rebinding", () => {
  const original = anchor({ codex_version: "0.159.0", backend_version: "0.159.2" });
  const reloaded = validateCodexPaginatedTaskAnchor(JSON.parse(JSON.stringify(original)));
  assert.equal(reloaded.codex_version, "0.159.0");
  assert.equal(reloaded.backend_version, "0.159.2");
  const first = observeCodexPaginatedTask({ anchor: reloaded,
    snapshot: snapshot([turn("accepted", 200, "inProgress"), turn("baseline", 100)], "0.159.2") });
  if (first.status !== "accepted") assert.fail("the audited mixed-version task must bind");
  const checkpoint = validateCodexPaginatedTaskCheckpoint(
    JSON.parse(JSON.stringify(first.checkpoint)), reloaded);
  const completed = observeCodexPaginatedTask({ anchor: reloaded, checkpoint,
    snapshot: snapshot([turn("later-identical", 300), turn("accepted", 200)], "0.159.2") });
  if (completed.status !== "completed") assert.fail("the originally accepted task must complete");
  assert.equal(completed.completion.id, "accepted");
  assert.equal(completed.completion.text, "Exact result.");
  assert.equal(completed.evidence.acceptanceId, first.evidence.acceptanceId);
  assert.equal(completed.evidence.anchorFingerprint, original.anchor_fingerprint);

  for (const backend of ["0.159.0", "0.158.0", "0.159.3"]) {
    assert.equal(observeCodexPaginatedTask({ anchor: reloaded, checkpoint,
      snapshot: snapshot([turn("accepted", 200)], backend) }).status, "invalidated",
    `a task bound to 0.159.2 must reject backend drift to ${backend}`);
  }
});

test("mixed-version anchors bind the backend into their fingerprint and acceptance checkpoint", () => {
  const mixed = anchor({ codex_version: "0.159.0", backend_version: "0.159.2" });
  const sameVersion = anchor({ codex_version: "0.159.0" });
  assert.notEqual(mixed.anchor_fingerprint, sameVersion.anchor_fingerprint);
  const missingBackend = { ...mixed };
  delete missingBackend.backend_version;
  assert.throws(() => validateCodexPaginatedTaskAnchor(missingBackend), /fingerprint/u);
  assert.throws(() => validateCodexPaginatedTaskAnchor({ ...sameVersion, backend_version: "0.159.2" }),
    /fingerprint/u);
  assert.throws(() => validateCodexPaginatedTaskAnchor({ ...mixed, backend_version: "0.159.3" }));
  const explicitNull = { ...mixed, backend_version: null };
  const { anchor_fingerprint: _previousFingerprint, ...unsignedNull } = explicitNull;
  const resignedNull = {
    ...explicitNull,
    anchor_fingerprint: createHash("sha256").update(JSON.stringify(unsignedNull)).digest("hex")
  };
  assert.throws(() => validateCodexPaginatedTaskAnchor(resignedNull), /anchor is invalid/u);
  const accepted = observeCodexPaginatedTask({ anchor: mixed,
    snapshot: snapshot([turn("accepted", 200, "inProgress"), turn("baseline", 100)], "0.159.2") });
  if (accepted.status !== "accepted") assert.fail("mixed-version fixture must bind");
  assert.throws(() => validateCodexPaginatedTaskCheckpoint(accepted.checkpoint, sameVersion),
    /different task/u);
});

test("legacy anchors without a backend version retain exact same-version history binding", () => {
  for (const version of ["0.158.0", "0.159.0"] as const) {
    const original = validateCodexPaginatedTaskAnchor(JSON.parse(JSON.stringify(anchor({ codex_version: version }))));
    assert.equal(Object.hasOwn(original, "backend_version"), false);
    assert.equal(observeCodexPaginatedTask({ anchor: original,
      snapshot: snapshot([turn("accepted", 200), turn("baseline", 100)], version) }).status, "completed");
    assert.equal(observeCodexPaginatedTask({ anchor: original,
      snapshot: snapshot([turn("accepted", 200), turn("baseline", 100)], "0.159.2") }).status, "invalidated");
  }
});

test("active paginated tasks settle explicit interrupted and failed native outcomes", () => {
  const active = anchor({ origin: "active_task", turn_id: "active", baseline_latest_turn_id: undefined });
  for (const status of ["failed", "interrupted"] as const) {
    const failed = turn("active", 200, status, [user("active-input", REQUEST)]);
    failed.error = { message: "Native failure." };
    const result = observeCodexPaginatedTask({ anchor: active, snapshot: snapshot([failed]) });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") assert.fail("native failure must settle");
    assert.equal(result.completion.outcome, "failure");
    assert.equal(result.completion.metadata?.status, status);
  }
});

test("historical async questions cannot suppress a true paginated turn completion", () => {
  const original = anchor();
  const items = [user("accepted-input", REQUEST), asyncQuestion()];
  const working = observeCodexPaginatedTask({
    anchor: original,
    snapshot: snapshot([turn("accepted", 200, "inProgress", items), turn("baseline", 100)])
  });
  assert.equal(working.status, "accepted");
  if (working.status !== "accepted") assert.fail("question task should stay accepted");
  assert.equal(working.questions[0]?.remainingCount, 2);
  assert.equal(codexPaginatedAsyncQuestionEvidence(
    turn("accepted", 200, "inProgress", items)
  )[0]?.remainingCount, 2);
  const completed = observeCodexPaginatedTask({
    anchor: original,
    checkpoint: working.checkpoint,
    snapshot: snapshot([turn("accepted", 200, "completed", items)])
  });
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") assert.fail("native completion must not wait forever");
  assert.equal(completed.completion.text, "");
  assert.equal(completed.questions[0]?.remainingCount, 2);
  for (const status of ["completed", "failed", "interrupted"] as const) {
    assert.deepEqual(codexPaginatedAsyncQuestionEvidence(
      turn("accepted", 200, status, items)
    ), []);
  }
});

test("private blocking drafts remain bound to a persisted exact paginated acceptance", () => {
  const original = anchor();
  const accepted = observeCodexPaginatedTask({
    anchor: original,
    snapshot: snapshot([turn("accepted", 200, "inProgress"), turn("baseline", 100)])
  });
  assert.equal(accepted.status, "accepted");
  if (accepted.status !== "accepted") return;
  const draft = {
    threadId: THREAD, turnId: "accepted", itemId: "native-item",
    requestId: 42, stablePayloadFingerprint: "b".repeat(64),
    answers: { first: { answers: ["Yes"] } }, nextQuestionIndex: 1
  };
  const checkpoint = createCodexPaginatedTaskCheckpoint(accepted.evidence, draft);
  assert.equal(validateCodexPaginatedTaskCheckpoint(checkpoint, original).blocking_question_draft, draft);
  assert.throws(() => createCodexPaginatedTaskCheckpoint(undefined, draft));
  assert.throws(() => createCodexPaginatedTaskCheckpoint(accepted.evidence, {
    ...draft, turnId: "different-task"
  }));
  assert.throws(() => createCodexPaginatedTaskCheckpoint(accepted.evidence, {
    ...draft, threadId: "019ee559-7bb8-7fd1-970c-0f7b6978c450"
  }));
  const resumed = observeCodexPaginatedTask({
    anchor: original, checkpoint,
    snapshot: snapshot([turn("accepted", 200, "inProgress")])
  });
  assert.equal(resumed.status, "accepted");
  if (resumed.status === "accepted") {
    assert.equal(resumed.checkpoint.blocking_question_draft, draft);
  }
});

test("only an exact async reply envelope extends completion into its native answer turn", () => {
  const original = anchor();
  const root = turn("accepted", 200, "completed", [
    user("accepted-input", REQUEST), asyncQuestion(), final("original-result", "Original result.")
  ]);
  const reply = turn("answer-turn", 300, "inProgress", [
    user("answer-input", "# Context from my IDE setup:\nFile A.\n## My request for Codex:\n" + answerText(0))
  ]);
  reply.items[0]!.content!.push({ type: "skill", name: "example" });
  const waiting = observeCodexPaginatedTask({
    anchor: original, snapshot: snapshot([reply, root, turn("baseline", 100)])
  });
  assert.equal(waiting.status, "accepted");
  if (waiting.status !== "accepted") assert.fail("exact answer turn is still working");
  assert.equal(waiting.evidence.acceptanceId, "accepted");
  assert.equal(waiting.questions[0]?.currentIndex, 1);
  assert.equal(waiting.questions[0]?.remainingCount, 1);
  reply.status = "completed";
  reply.completedAt = 301;
  reply.items.push(final("answer-result", "Used React."));
  const completed = observeCodexPaginatedTask({
    anchor: original, checkpoint: waiting.checkpoint,
    snapshot: snapshot([turn("unrelated", 400, "inProgress", [user("unrelated-input", "Other work.")]), reply, root])
  });
  assert.equal(completed.status, "completed");
  if (completed.status !== "completed") assert.fail("exact answer must settle independently");
  assert.equal(completed.evidence, waiting.evidence);
  assert.equal(completed.completion.text, "Used React.");
  assert.equal(completed.completion.metadata?.answer_turn_id, "answer-turn");
});

test("unrelated later inputs and prose cannot answer an exact question or delay completion", () => {
  const original = anchor();
  const root = turn("accepted", 200, "completed", [
    user("accepted-input", REQUEST), asyncQuestion(), final("original-result", "Original result.")
  ]);
  for (const laterText of [answerText(0, "different-question"), "The user answered React.", "Other work."]) {
    const result = observeCodexPaginatedTask({
      anchor: original,
      snapshot: snapshot([turn("other", 300, "inProgress", [user("other-input", laterText)]), root, turn("baseline", 100)])
    });
    assert.equal(result.status, "completed");
    if (result.status !== "completed") assert.fail("unrelated task cannot take over completion");
    assert.equal(result.completion.text, "Original result.");
    assert.equal(result.completion.metadata?.answer_turn_id, undefined);
    assert.equal(result.questions[0]?.remainingCount, 2);
  }
});

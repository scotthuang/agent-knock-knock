import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureCodexPaginatedAnswerProof,
  readCodexPaginatedAnswerProof
} from "../src/codex-paginated-answer-proof.js";

const THREAD_ID = "01a0e958-4bb1-7fc3-8649-e153fd90faae";
const TURN_ID = "01a0e959-4bb1-7fc3-8649-e153fd90faae";
const ITEM_ID = "call_answer";
const ANSWERS = { question: { answers: ["Yes"] } };

test("requires a new contiguous canonical answer and never confirms an old matching output", () => {
  const fixture = proofFixture([output(2)]);
  try {
    const anchor = fixture.capture();
    assert.equal(readCodexPaginatedAnswerProof(anchor, ANSWERS), "pending");
    fixture.append(output(3));
    assert.equal(readCodexPaginatedAnswerProof(anchor, ANSWERS), "matched");
    assert.equal(readCodexPaginatedAnswerProof(anchor, { question: { answers: ["No"] } }), "different");
  } finally { fixture.cleanup(); }
});

test("rejects writer replacement, truncation, ordinal gaps and wrong-turn output", () => {
  for (const change of ["replacement", "truncation", "ordinal-gap", "wrong-turn"] as const) {
    const fixture = proofFixture([]);
    try {
      const anchor = fixture.capture();
      if (change === "replacement") { fs.renameSync(fixture.rolloutPath, `${fixture.rolloutPath}.old`); fs.copyFileSync(`${fixture.rolloutPath}.old`, fixture.rolloutPath); }
      if (change === "truncation") fs.truncateSync(fixture.rolloutPath, 0);
      if (change === "ordinal-gap") fixture.append(output(3));
      if (change === "wrong-turn") {
        fixture.append({ ordinal: 2, type: "event_msg", payload: { type: "task_started", turn_id: "another-turn" } });
        fixture.append(output(3));
      }
      assert.throws(() => readCodexPaginatedAnswerProof(anchor, ANSWERS), /changed|truncated|sequence|different turn/u);
    } finally { fixture.cleanup(); }
  }
});

test("waits for a complete appended record and rejects nonpaginated headers", () => {
  const fixture = proofFixture([]);
  try {
    const anchor = fixture.capture();
    fs.appendFileSync(fixture.rolloutPath, JSON.stringify(output(2)));
    assert.equal(readCodexPaginatedAnswerProof(anchor, ANSWERS), "pending");
    fs.appendFileSync(fixture.rolloutPath, "\n");
    assert.equal(readCodexPaginatedAnswerProof(anchor, ANSWERS), "matched");
    fs.writeFileSync(fixture.rolloutPath, `${JSON.stringify({ ordinal: 0, type: "session_meta", payload: { id: THREAD_ID, history_mode: "legacy" } })}\n`);
    assert.throws(() => fixture.capture(), /selected paginated thread/u);
  } finally { fixture.cleanup(); }
});

test("requires the latest durable boundary to be the selected active turn before freezing EOF", () => {
  for (const record of [
    { ordinal: 2, type: "event_msg", payload: { type: "task_started", turn_id: "another-turn" } },
    { ordinal: 2, type: "turn_context", payload: { turn_id: "another-turn" } },
    { ordinal: 2, type: "event_msg", payload: { type: "task_complete", turn_id: TURN_ID } },
    { ordinal: 2, type: "event_msg", payload: { type: "turn_aborted", turn_id: TURN_ID } }
  ]) {
    const fixture = proofFixture([record]);
    try { assert.throws(() => fixture.capture(), /current turn changed|no longer active/u); }
    finally { fixture.cleanup(); }
  }
  const fixture = proofFixture([]);
  try {
    const anchor = fixture.capture();
    fixture.append({ ordinal: 2, type: "event_msg", payload: { type: "task_complete", turn_id: TURN_ID } });
    fixture.append(output(3));
    assert.throws(() => readCodexPaginatedAnswerProof(anchor, ANSWERS), /different turn/u);
  } finally { fixture.cleanup(); }
});

function output(ordinal: number) {
  return { ordinal, type: "response_item", payload: { type: "function_call_output", call_id: ITEM_ID, output: JSON.stringify({ answers: ANSWERS }) } };
}
function proofFixture(records: unknown[]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "akk-answer-proof-"));
  const rolloutPath = path.join(home, "sessions", "rollout.jsonl");
  fs.mkdirSync(path.dirname(rolloutPath));
  fs.writeFileSync(rolloutPath, [
    { ordinal: 0, type: "session_meta", payload: { id: THREAD_ID, history_mode: "paginated" } },
    { ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: TURN_ID } },
    ...records
  ].map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
  return {
    rolloutPath,
    capture: () => captureCodexPaginatedAnswerProof({ codexHome: home, rolloutPath, threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID }),
    append: (record: unknown) => fs.appendFileSync(rolloutPath, `${JSON.stringify(record)}\n`),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true })
  };
}

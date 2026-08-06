import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  captureCodexRolloutAcceptanceAnchor,
  detectCodexRolloutAcceptance,
  terminalSubmissionReplayReceipt,
  validateTerminalSubmissionAcceptanceEvidence,
  type CodexRolloutIdentity
} from "../src/terminal-submission-acceptance.js";

const SESSION_ID = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const REQUEST = "请检查第一行\nThen verify the second line.";
const REQUEST_HASH = createHash("sha256").update(REQUEST).digest("hex");

test("Codex acceptance requires an exact post-anchor task start and same-turn user response", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-1",
      processBirth: "codex-birth-1",
      mode: "existing",
      rollout: fixture.identity,
      now: new Date("2026-08-07T01:00:00.000Z")
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST));

    const evidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-1",
        processBirth: "codex-birth-1",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });

    assert.equal(evidence?.source, "codex_rollout");
    assert.equal(evidence?.kind, "native_user_turn");
    assert.equal(evidence?.nativeThreadId, SESSION_ID);
    assert.equal(evidence?.acceptanceId, "019f0000-0000-7000-8000-000000000001");
    assert.equal(evidence?.requestHash, REQUEST_HASH);
    assert.equal(evidence?.anchorFingerprint, anchor.anchor_fingerprint);
    assert.equal(typeof evidence?.evidenceFingerprint, "string");
    const serialized = JSON.stringify(evidence);
    assert.doesNotMatch(serialized, /请检查第一行/u);
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(fixture.path), "u"));
  } finally {
    fixture.cleanup();
  }
});

test("Codex acceptance ignores matching records before the byte anchor", () => {
  const fixture = codexFixture(acceptedTurnRecords(REQUEST));
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-2",
      processBirth: "codex-birth-2",
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, acceptedTurnRecords("a different request", 2));

    assert.equal(detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-2",
        processBirth: "codex-birth-2",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("durable replay preserves exact native proof and never upgrades legacy transport", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-replay-process",
      processBirth: "codex-replay-birth",
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 10));
    const evidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-replay-process",
        processBirth: "codex-replay-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(evidence);
    const expected = {
      source: "codex_rollout" as const,
      nativeThreadId: SESSION_ID,
      requestHash: REQUEST_HASH
    };
    assert.deepEqual(
      validateTerminalSubmissionAcceptanceEvidence(evidence, expected),
      evidence
    );
    const acceptedReplay = terminalSubmissionReplayReceipt({
      proofLevel: "agent_accepted",
      evidence,
      expected
    });
    assert.equal(acceptedReplay.replayed, true);
    assert.equal(acceptedReplay.delivered, true);
    assert.equal(acceptedReplay.submission_outcome, "agent_accepted");
    assert.equal(acceptedReplay.delivery_receipt, "agent_accepted");

    for (const proofLevel of ["submitted", "enter_dispatched"] as const) {
      const transportReplay = terminalSubmissionReplayReceipt({
        proofLevel,
        expected
      });
      assert.equal(transportReplay.replayed, true);
      assert.equal(transportReplay.delivered, false);
      assert.equal(transportReplay.submission_outcome, "pending_acceptance");
      assert.equal(transportReplay.delivery_receipt, proofLevel);
      assert.equal(transportReplay.do_not_retry, true);
    }

    const invalidReplay = terminalSubmissionReplayReceipt({
      proofLevel: "agent_accepted",
      evidence: { ...evidence, requestHash: "0".repeat(64) },
      expected
    });
    assert.equal(invalidReplay.replayed, true);
    assert.equal(invalidReplay.delivered, false);
    assert.equal(invalidReplay.submission_outcome, "uncertain");
  } finally {
    fixture.cleanup();
  }
});

test("Codex acceptance stays pending for a partial appended JSONL record", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-3",
      processBirth: "codex-birth-3",
      mode: "existing",
      rollout: fixture.identity
    });
    fs.appendFileSync(fixture.path, '{"type":"event_msg"');

    assert.equal(detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-3",
        processBirth: "codex-birth-3",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), undefined);
  } finally {
    fixture.cleanup();
  }
});

test("Codex acceptance rejects a matching user response without same-turn task-start evidence", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-4",
      processBirth: "codex-birth-4",
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, [userResponseRecord(
      REQUEST,
      "019f0000-0000-7000-8000-000000000004"
    )]);

    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-4",
        processBirth: "codex-birth-4",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /no same-turn post-anchor task_started evidence/u);
  } finally {
    fixture.cleanup();
  }
});

test("Codex acceptance rejects duplicate native matches and identity drift", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-5",
      processBirth: "codex-birth-5",
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, [
      ...acceptedTurnRecords(REQUEST, 5),
      ...acceptedTurnRecords(REQUEST, 6)
    ]);

    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-5",
        processBirth: "codex-birth-5",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /multiple Codex native turns/u);
    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "different-process",
        processBirth: "codex-birth-5",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /identity changed/u);
  } finally {
    fixture.cleanup();
  }
});

test("a pre-materialization Codex anchor accepts only the exact newly opened rollout", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-process-6",
      processBirth: "codex-birth-6",
      mode: "pre_materialization",
      expectedEmptyNativeSession: true
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 7));

    const evidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-6",
        processBirth: "codex-birth-6",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(evidence?.acceptanceId, "019f0000-0000-7000-8000-000000000007");
  } finally {
    fixture.cleanup();
  }
});

test("Codex acceptance permits read-only public rollout data but rejects externally writable data", () => {
  const publicFixture = codexFixture();
  try {
    fs.chmodSync(publicFixture.path, 0o644);
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-private-process",
      processBirth: "codex-private-birth",
      mode: "existing",
      rollout: publicFixture.identity
    });
    assert.equal(anchor.mode, "existing");
    fs.chmodSync(publicFixture.path, 0o664);
    assert.throws(() => captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-writable-process",
      processBirth: "codex-writable-birth",
      mode: "existing",
      rollout: publicFixture.identity
    }), /writable by another user/u);
  } finally {
    publicFixture.cleanup();
  }
});

test("Codex acceptance rejects a mismatched response turn identity", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid: "codex-mismatch-process",
      processBirth: "codex-mismatch-birth",
      mode: "existing",
      rollout: fixture.identity
    });
    const taskTurn = "019f0000-0000-7000-8000-000000000008";
    appendRecords(fixture.path, [
      {
        timestamp: "2026-08-07T01:00:01.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: taskTurn }
      },
      userResponseRecord(
        REQUEST,
        "019f0000-0000-7000-8000-000000000009"
      )
    ]);
    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-mismatch-process",
        processBirth: "codex-mismatch-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /no same-turn post-anchor task_started/u);
  } finally {
    fixture.cleanup();
  }
});

function codexFixture(initialRecords: readonly unknown[] = []) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-acceptance-"));
  const rolloutPath = path.join(directory, `rollout-${SESSION_ID}.jsonl`);
  const metadata = {
    timestamp: "2026-08-07T00:59:59.000Z",
    type: "session_meta",
    payload: {
      id: SESSION_ID,
      cwd: directory,
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.146.1"
    }
  };
  fs.writeFileSync(
    rolloutPath,
    [...[metadata], ...initialRecords].map((record) => JSON.stringify(record)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  const identity: CodexRolloutIdentity = {
    fd: "12r",
    device: String(stat.dev),
    inode: String(stat.ino),
    path: rolloutPath
  };
  return {
    path: rolloutPath,
    identity,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true })
  };
}

function acceptedTurnRecords(request: string, suffix = 1): unknown[] {
  const id = String(suffix).padStart(12, "0");
  const turnId = `019f0000-0000-7000-8000-${id}`;
  return [
    {
      timestamp: "2026-08-07T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: turnId
      }
    },
    userResponseRecord(request, turnId),
    {
      timestamp: "2026-08-07T01:00:01.011Z",
      type: "event_msg",
      payload: { type: "user_message", message: request }
    }
  ];
}

function userResponseRecord(request: string, turnId: string): unknown {
  return {
    timestamp: "2026-08-07T01:00:01.010Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request }],
      internal_chat_message_metadata_passthrough: {
        turn_id: turnId
      }
    }
  };
}

function appendRecords(filePath: string, records: readonly unknown[]): void {
  fs.appendFileSync(
    filePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n"
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

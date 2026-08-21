import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CodexOpenRootRolloutIdentity,
  CodexOpenRootRolloutInventory
} from "../src/agent-session-provider.js";
import {
  captureCodexCandidateSetRolloutAcceptanceAnchor,
  captureCodexHumanStartedActiveTaskAnchor,
  captureCodexRolloutAcceptanceAnchor,
  detectCodexBoundRolloutCompletion,
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  observeCodexHumanStartedActiveTask,
  validateTerminalSubmissionAcceptanceEvidence,
  type CodexRolloutIdentity
} from "../src/terminal-submission-acceptance.js";
import { terminalSubmissionReplayReceipt } from
  "../src/terminal-dispatch-receipt.js";

const SESSION_ID = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
const REQUEST = "请检查第一行\nThen verify the second line.";
const REQUEST_HASH = createHash("sha256").update(REQUEST).digest("hex");

test("captures and completes one exact human-started Codex task without persisting its prompt", () => {
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const fixture = codexFixture(acceptedTurnRecords(REQUEST, 901));
  const currentIdentity = {
    sessionId: SESSION_ID,
    processUuid,
    processBirth,
    rollout: fixture.identity
  };
  try {
    const anchor = captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity,
      now: new Date("2026-08-07T01:00:01.500Z")
    });
    assert.ok(anchor);
    assert.equal(anchor.turn_id, turnId(901));
    assert.equal(anchor.request_hash, REQUEST_HASH);
    assert.equal(anchor.codex_version, "0.147.0");
    assert.equal(JSON.stringify(anchor).includes(REQUEST), false);
    assert.equal(
      observeCodexHumanStartedActiveTask({ anchor, currentIdentity }).status,
      "pending"
    );

    appendRecords(fixture.path, [
      taskCompleteRecord(901, "Human task done"),
      ...acceptedTurnRecords("A later task must not erase completion", 906)
    ]);
    const observed = observeCodexHumanStartedActiveTask({
      anchor,
      currentIdentity
    });
    assert.equal(observed.status, "completed");
    if (observed.status === "completed") {
      assert.equal(observed.completion.outcome, "success");
      assert.equal(observed.completion.id, turnId(901));
      assert.equal(observed.completion.text, "Human task done");
    }
    assert.equal(
      observeCodexHumanStartedActiveTask({
        anchor,
        currentIdentity: {
          ...currentIdentity,
          processBirth: `${processBirth} replaced after completion`
        }
      }).status,
      "completed",
      "durable exact completion must win over later process drift"
    );
  } finally {
    fixture.cleanup();
  }
});

test("completed historical Codex prompts cannot poison the unique active task", () => {
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const historicalWithoutTurnId = {
    timestamp: "2026-08-07T00:59:59.100Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "completed legacy prompt" }]
    }
  };
  const historicalUnsupportedContent = {
    timestamp: "2026-08-07T00:59:59.200Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_image", image_url: "data:image/png;base64,AA==" }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId(899) }
    }
  };
  const fixture = codexFixture([
    {
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId(898) }
    },
    historicalWithoutTurnId,
    taskCompleteRecord(898, "legacy task completed"),
    {
      type: "event_msg",
      payload: { type: "task_started", turn_id: turnId(899) }
    },
    historicalUnsupportedContent,
    taskCompleteRecord(899, "multimodal task completed"),
    ...acceptedTurnRecords(REQUEST, 900)
  ]);
  try {
    const anchor = captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      }
    });
    assert.ok(anchor);
    assert.equal(anchor.turn_id, turnId(900));
    assert.equal(anchor.request_hash, REQUEST_HASH);
  } finally {
    fixture.cleanup();
  }
});

test("human-started Codex anchors fail closed on ambiguity, identity or file drift, and a later task", () => {
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const ambiguous = codexFixture([
    ...acceptedTurnRecords("First active task", 902),
    ...acceptedTurnRecords("Second active task", 903)
  ]);
  try {
    assert.throws(
      () => captureCodexHumanStartedActiveTaskAnchor({
        currentIdentity: {
          sessionId: SESSION_ID,
          processUuid,
          processBirth,
          rollout: ambiguous.identity
        }
      }),
      /multiple unmatched active tasks/u
    );
  } finally {
    ambiguous.cleanup();
  }

  const fixture = codexFixture(acceptedTurnRecords(REQUEST, 904));
  const currentIdentity = {
    sessionId: SESSION_ID,
    processUuid,
    processBirth,
    rollout: fixture.identity
  };
  try {
    const anchor = captureCodexHumanStartedActiveTaskAnchor({ currentIdentity });
    assert.ok(anchor);
    assert.equal(observeCodexHumanStartedActiveTask({
      anchor,
      currentIdentity: {
        ...currentIdentity,
        processBirth: `${processBirth} drifted`
      }
    }).status, "invalidated");

    appendRecords(fixture.path, acceptedTurnRecords("Later human task", 905));
    const observed = observeCodexHumanStartedActiveTask({
      anchor,
      currentIdentity
    });
    assert.equal(observed.status, "invalidated");
    if (observed.status === "invalidated") {
      assert.match(observed.reason, /later Codex human task/u);
    }
  } finally {
    fixture.cleanup();
  }

  const replaced = codexFixture(acceptedTurnRecords("Inode-bound task", 907));
  const replacedIdentity = {
    sessionId: SESSION_ID,
    processUuid,
    processBirth,
    rollout: replaced.identity
  };
  try {
    const anchor = captureCodexHumanStartedActiveTaskAnchor({
      currentIdentity: replacedIdentity
    });
    assert.ok(anchor);
    const contents = fs.readFileSync(replaced.path);
    fs.renameSync(replaced.path, `${replaced.path}.replaced`);
    fs.writeFileSync(replaced.path, contents, { mode: 0o600 });
    const observed = observeCodexHumanStartedActiveTask({
      anchor,
      currentIdentity: replacedIdentity
    });
    assert.equal(observed.status, "invalidated");
    if (observed.status === "invalidated") {
      assert.match(observed.reason, /descriptor identity does not match/u);
    }
  } finally {
    replaced.cleanup();
  }
});

test("candidate-set Codex acceptance uses the exact existing-root offset through completion", () => {
  const firstId = SESSION_ID;
  const secondId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const first = codexFixture([{ type: "event_msg", payload: { type: "old" } }], firstId);
  const second = codexFixture([{ type: "event_msg", payload: { type: "old" } }], secondId);
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  try {
    const baseline = candidateInventory({
      processUuid,
      processBirth,
      roots: [
        candidateIdentity(firstId, processUuid, processBirth, first.identity),
        candidateIdentity(secondId, processUuid, processBirth, second.identity)
      ]
    });
    const anchor = captureCodexCandidateSetRolloutAcceptanceAnchor({
      inventory: baseline,
      now: new Date("2026-08-07T01:00:00.000Z")
    });
    const secondOffset = anchor.candidate_rollouts.find((candidate) =>
      candidate.native_thread_id === secondId
    )?.offset_bytes;
    assert.ok(secondOffset && secondOffset > 0);

    appendRecords(second.path, acceptedTurnRecords(REQUEST, 501));
    const accepted = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: baseline,
      requestHash: REQUEST_HASH
    });
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") {
      return;
    }
    assert.equal(accepted.identity.sessionId, secondId);
    assert.equal(
      accepted.evidence.metadata?.anchor_offset_bytes,
      secondOffset
    );

    appendRecords(second.path, [taskCompleteRecord(501, "Candidate exact result")]);
    const completion = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence: accepted.evidence,
      currentIdentity: accepted.identity,
      requestHash: REQUEST_HASH
    });
    assert.equal(completion.status, "completed");
    assert.equal(completion.diagnostics.scan_start_offset_bytes, secondOffset);
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test("candidate-set Codex acceptance admits a unique new PID-open root from offset zero", () => {
  const nativeThreadId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const fixture = codexFixture([], nativeThreadId);
  try {
    const anchor = captureCodexCandidateSetRolloutAcceptanceAnchor({
      inventory: candidateInventory({ processUuid, processBirth, roots: [] }),
      now: new Date("2026-08-07T00:59:58.000Z")
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 502));
    const currentInventory = candidateInventory({
      processUuid,
      processBirth,
      roots: [candidateIdentity(
        nativeThreadId,
        processUuid,
        processBirth,
        fixture.identity
      )]
    });
    const accepted = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory,
      requestHash: REQUEST_HASH
    });
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") {
      return;
    }
    assert.equal(accepted.evidence.metadata?.anchor_offset_bytes, 0);

    appendRecords(fixture.path, [taskCompleteRecord(502, "New-root exact result")]);
    const completion = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence: accepted.evidence,
      currentIdentity: accepted.identity,
      requestHash: REQUEST_HASH
    });
    assert.equal(completion.status, "completed");
    assert.equal(completion.diagnostics.scan_start_offset_bytes, 0);
  } finally {
    fixture.cleanup();
  }
});

test("candidate-set Codex acceptance rejects a newly opened historical rollout", () => {
  const nativeThreadId = "019ee559-7bb8-7fd1-970c-0f7b6978c455";
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const fixture = codexFixture([], nativeThreadId);
  try {
    const anchor = captureCodexCandidateSetRolloutAcceptanceAnchor({
      inventory: candidateInventory({ processUuid, processBirth, roots: [] }),
      now: new Date("2026-08-07T01:00:00.000Z")
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 505));
    const result = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: candidateInventory({
        processUuid,
        processBirth,
        roots: [candidateIdentity(
          nativeThreadId,
          processUuid,
          processBirth,
          fixture.identity
        )]
      }),
      requestHash: REQUEST_HASH
    });
    assert.equal(result.status, "uncertain");
    if (result.status === "uncertain") {
      assert.equal(result.code, "candidate_scan_invalid");
      assert.match(result.reason, /predates its terminal submission anchor/u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("candidate-set Codex acceptance is uncertain for a missing anchor or multiple exact matches", () => {
  const secondId = "019ee559-7bb8-7fd1-970c-0f7b6978c453";
  const first = codexFixture([], SESSION_ID);
  const second = codexFixture([], secondId);
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  try {
    const firstIdentity = candidateIdentity(
      SESSION_ID,
      processUuid,
      processBirth,
      first.identity
    );
    const secondIdentity = candidateIdentity(
      secondId,
      processUuid,
      processBirth,
      second.identity
    );
    const anchor = captureCodexCandidateSetRolloutAcceptanceAnchor({
      inventory: candidateInventory({
        processUuid,
        processBirth,
        roots: [firstIdentity, secondIdentity]
      })
    });
    const missing = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: candidateInventory({
        processUuid,
        processBirth,
        roots: [firstIdentity]
      }),
      requestHash: REQUEST_HASH
    });
    assert.equal(missing.status, "uncertain");
    if (missing.status === "uncertain") {
      assert.equal(missing.code, "candidate_inventory_changed");
    }

    appendRecords(first.path, acceptedTurnRecords(REQUEST, 503));
    appendRecords(second.path, acceptedTurnRecords(REQUEST, 504));
    const duplicate = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: candidateInventory({
        processUuid,
        processBirth,
        roots: [firstIdentity, secondIdentity]
      }),
      requestHash: REQUEST_HASH
    });
    assert.equal(duplicate.status, "uncertain");
    if (duplicate.status === "uncertain") {
      assert.equal(duplicate.code, "multiple_exact_request_acceptances");
      assert.equal(duplicate.exact_matches, 2);
    }
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

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
    assert.ok(evidence);
    appendRecords(fixture.path, [taskCompleteRecord(7, "Materialized exact result")]);
    const completion = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence: evidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-process-6",
        processBirth: "codex-birth-6",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(completion.status, "completed");
    if (completion.status === "completed") {
      assert.equal(completion.completion.id, turnId(7));
    }
  } finally {
    fixture.cleanup();
  }
});

test("a virgin Codex anchor binds the first exact rollout only after submission", () => {
  const fixture = codexFixture();
  try {
    const processUuid = "codex-virgin-process";
    const processBirth = "codex-virgin-birth";
    const anchor = captureCodexRolloutAcceptanceAnchor({
      processUuid,
      processBirth,
      mode: "pre_materialization",
      expectedEmptyNativeSession: true,
      now: new Date("2026-08-07T00:59:58.000Z")
    });
    assert.equal(anchor.version, 2);
    assert.equal("native_thread_id" in anchor, false);
    // Codex may allocate its in-memory SessionMeta when the TUI starts, long
    // before it persists the first rollout. The authoritative freshness proof
    // is the outer rollout-item timestamp, not payload.timestamp.
    assert.ok(
      Date.parse("2026-08-07T00:00:00.000Z") <
        Date.parse(anchor.captured_at)
    );
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 70));

    const evidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(evidence);
    assert.equal(evidence.nativeThreadId, SESSION_ID);
    assert.equal(evidence.anchorFingerprint, anchor.anchor_fingerprint);

    appendRecords(fixture.path, [taskCompleteRecord(70, "Virgin exact result")]);
    const completion = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence: evidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(completion.status, "completed");
    if (completion.status === "completed") {
      assert.equal(completion.completion.metadata?.native_thread_id, SESSION_ID);
    }
  } finally {
    fixture.cleanup();
  }
});

test("a virgin Codex anchor rejects process drift and a forged pre-bound UUID", () => {
  const fixture = codexFixture();
  try {
    const anchor = captureCodexRolloutAcceptanceAnchor({
      processUuid: "codex-virgin-process",
      processBirth: "codex-virgin-birth",
      mode: "pre_materialization",
      expectedEmptyNativeSession: true
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 71));
    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-virgin-process",
        processBirth: "codex-virgin-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /rollout predates its terminal submission anchor/u);
    assert.throws(() => detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-reused-process",
        processBirth: "codex-reused-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /identity changed/u);

    assert.throws(() => detectCodexRolloutAcceptance({
      anchor: {
        ...anchor,
        native_thread_id: SESSION_ID
      } as never,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-virgin-process",
        processBirth: "codex-virgin-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /fingerprint does not match|virgin Codex acceptance anchor is inconsistent/u);

    const { anchor_fingerprint: _fingerprint, ...stringVersionBase } = {
      ...anchor,
      version: "2"
    };
    const stringVersionAnchor = {
      ...stringVersionBase,
      anchor_fingerprint: createHash("sha256")
        .update(JSON.stringify(stringVersionBase))
        .digest("hex")
    };
    assert.throws(() => detectCodexRolloutAcceptance({
      anchor: stringVersionAnchor as never,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "codex-virgin-process",
        processBirth: "codex-virgin-birth",
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    }), /acceptance anchor is invalid/u);
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

test("bound Codex completion scans the exact accepted turn beyond the recent 12-turn window", () => {
  const fixture = codexFixture();
  try {
    const processUuid = "codex-bound-process";
    const processBirth = "codex-bound-birth";
    const targetSuffix = 100;
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid,
      processBirth,
      mode: "existing",
      rollout: fixture.identity,
      now: new Date("2026-08-07T01:00:00.000Z")
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, targetSuffix));
    const acceptanceEvidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(acceptanceEvidence);

    appendRecords(fixture.path, [
      taskCompleteRecord(targetSuffix, "Exact bound result. sk-supersecret123456789 was redacted."),
      ...Array.from({ length: 20 }, (_, index) => {
        const suffix = 101 + index;
        return [
          ...acceptedTurnRecords(`later native request ${suffix}`, suffix),
          taskCompleteRecord(suffix, `Later result ${suffix}`)
        ];
      }).flat()
    ]);

    const result = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });

    assert.equal(result.status, "completed");
    if (result.status !== "completed") {
      return;
    }
    assert.equal(result.completion.id, turnId(targetSuffix));
    assert.equal(result.completion.source, "durable");
    assert.equal(result.completion.confidence, "high");
    assert.equal(
      result.completion.text,
      "Exact bound result. sk-[REDACTED] was redacted."
    );
    assert.equal(
      result.completion.metadata?.match,
      "bound_rollout_task_complete"
    );
    assert.equal(result.diagnostics.code, "completion_found");
    assert.equal(result.diagnostics.observed_task_complete_records, 21);
    assert.ok(Number(result.diagnostics.scanned_records) > 12);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(fixture.path), "u"));
  } finally {
    fixture.cleanup();
  }
});

test("bound Codex completion remains pending when only other native turns complete", () => {
  const fixture = codexFixture();
  try {
    const processUuid = "codex-pending-process";
    const processBirth = "codex-pending-birth";
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid,
      processBirth,
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 200));
    const acceptanceEvidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(acceptanceEvidence);
    appendRecords(fixture.path, [taskCompleteRecord(201, "Not the bound turn")]);

    const result = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(result.status, "pending");
    assert.equal(result.diagnostics.code, "exact_turn_not_complete");
    assert.equal(result.diagnostics.observed_task_complete_records, 1);
  } finally {
    fixture.cleanup();
  }
});

test("bound Codex completion returns typed failures for identity drift and duplicate completion", () => {
  const fixture = codexFixture();
  try {
    const processUuid = "codex-failure-process";
    const processBirth = "codex-failure-birth";
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid,
      processBirth,
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 300));
    const acceptanceEvidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(acceptanceEvidence);

    const drift = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid: "different-process",
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(drift.status, "failure");
    assert.equal(drift.diagnostics.code, "binding_identity_mismatch");

    const missingRollout = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(missingRollout.status, "failure");
    assert.equal(
      missingRollout.diagnostics.code,
      "rollout_identity_mismatch"
    );

    appendRecords(fixture.path, [
      taskCompleteRecord(300, "First exact result"),
      taskCompleteRecord(300, "Duplicated exact result")
    ]);
    const duplicate = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(duplicate.status, "failure");
    assert.equal(duplicate.diagnostics.code, "duplicate_exact_completion");
  } finally {
    fixture.cleanup();
  }
});

test("bound Codex completion treats an incomplete stable record as retryable pending", () => {
  const fixture = codexFixture();
  try {
    const processUuid = "codex-partial-process";
    const processBirth = "codex-partial-birth";
    const anchor = captureCodexRolloutAcceptanceAnchor({
      nativeThreadId: SESSION_ID,
      processUuid,
      processBirth,
      mode: "existing",
      rollout: fixture.identity
    });
    appendRecords(fixture.path, acceptedTurnRecords(REQUEST, 400));
    const acceptanceEvidence = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.ok(acceptanceEvidence);
    fs.appendFileSync(fixture.path, '{"type":"event_msg"');

    const result = detectCodexBoundRolloutCompletion({
      anchor,
      acceptanceEvidence,
      currentIdentity: {
        sessionId: SESSION_ID,
        processUuid,
        processBirth,
        rollout: fixture.identity
      },
      requestHash: REQUEST_HASH
    });
    assert.equal(result.status, "pending");
    assert.equal(result.diagnostics.code, "partial_rollout_record");
  } finally {
    fixture.cleanup();
  }
});

function codexFixture(
  initialRecords: readonly unknown[] = [],
  nativeThreadId = SESSION_ID
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-acceptance-"));
  const rolloutPath = path.join(directory, `rollout-${nativeThreadId}.jsonl`);
  const metadata = {
    timestamp: "2026-08-07T00:59:59.000Z",
    type: "session_meta",
    payload: {
      id: nativeThreadId,
      timestamp: "2026-08-07T00:00:00.000Z",
      cwd: directory,
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.147.0"
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

function candidateIdentity(
  nativeThreadId: string,
  processUuid: string,
  processBirth: string,
  rollout: CodexRolloutIdentity
): CodexOpenRootRolloutIdentity {
  return {
    sessionId: nativeThreadId,
    processUuid,
    processBirth,
    rollout,
    evidence: "codex_open_root_rollout"
  };
}

function candidateInventory({
  processUuid,
  processBirth,
  roots
}: {
  processUuid: string;
  processBirth: string;
  roots: CodexOpenRootRolloutIdentity[];
}): CodexOpenRootRolloutInventory {
  const authority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid: 4242,
    processUuid,
    processBirth,
    roots
  };
  const inventoryFingerprint = createHash("sha256")
    .update(JSON.stringify(authority))
    .digest("hex");
  if (roots.length === 0) {
    return {
      ...authority,
      status: "verified_absent",
      roots: [],
      inventoryFingerprint
    };
  }
  if (roots.length === 1) {
    return {
      ...authority,
      status: "resolved",
      roots: [roots[0]],
      inventoryFingerprint
    };
  }
  return {
    ...authority,
    status: "unbound",
    reason: "multiple_open_root_rollouts",
    inventoryFingerprint
  };
}

function acceptedTurnRecords(request: string, suffix = 1): unknown[] {
  const nativeTurnId = turnId(suffix);
  return [
    {
      timestamp: "2026-08-07T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_started",
        turn_id: nativeTurnId
      }
    },
    userResponseRecord(request, nativeTurnId),
    {
      timestamp: "2026-08-07T01:00:01.011Z",
      type: "event_msg",
      payload: { type: "user_message", message: request }
    }
  ];
}

function taskCompleteRecord(suffix: number, message: string): unknown {
  return {
    timestamp: "2026-08-07T01:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      turn_id: turnId(suffix),
      last_agent_message: message
    }
  };
}

function turnId(suffix: number): string {
  return `019f0000-0000-7000-8000-${String(suffix).padStart(12, "0")}`;
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

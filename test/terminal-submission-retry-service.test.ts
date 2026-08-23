import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  decideTerminalSubmissionRetryStartup,
  decideTerminalSubmissionRetry,
  loadTerminalSubmissionRetry,
  projectTerminalSubmissionRetryPending,
  saveTerminalSubmissionRetry,
  terminalSubmissionRetryLedgerFields,
  terminalSubmissionRetryLedgerPrefix,
  TERMINAL_SUBMISSION_RETRY_SCHEMA,
  TERMINAL_SUBMISSION_RETRY_VERSION,
  type TerminalSubmissionRetryRecord
} from "../src/terminal-submission-retry-service.js";

const baseFacts = {
  agent: "codex",
  exactTurnTarget: true,
  accepted: false,
  composer: "exact_draft" as const,
  submissionStatus: "uncertain",
  lastProvenStage: "text_injected",
  submissionTextInjectedAt: "2026-08-23T09:59:59.000Z",
  ledgerStatus: "uncertain",
  ledgerTextInjectedAt: "2026-08-23T09:59:59.000Z",
  originalMessageId: "msg-original",
  currentMessageId: "msg-original"
};

test("accepted reconciliation always repairs without terminal input", () => {
  assert.deepEqual(decideTerminalSubmissionRetry({
    ...baseFacts,
    accepted: true,
    composer: "working"
  }), { action: "repair_accepted" });
});

test("an exact legacy draft authorizes one explicit Enter recovery", () => {
  assert.deepEqual(decideTerminalSubmissionRetry(baseFacts), {
    action: "submit_exact_draft",
    activeMessageId: "msg-original"
  });
});

test("empty replacement requires structured no-Enter proof", () => {
  const withoutProof = decideTerminalSubmissionRetry({
    ...baseFacts,
    composer: "exact_empty"
  });
  assert.equal(withoutProof.action, "refuse");
  assert.match(
    withoutProof.action === "refuse" ? withoutProof.reason : "",
    /structured pre-key proof/u
  );
  assert.deepEqual(decideTerminalSubmissionRetry({
    ...baseFacts,
    composer: "exact_empty",
    enterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
    enterNotAttemptedReason: "pre_key_failure",
    ledgerEnterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
    ledgerEnterNotAttemptedReason: "pre_key_failure"
  }), { action: "start_replacement" });
});

test("legacy recovery requires matching Turn and ledger transport authority", () => {
  for (const override of [
    { ledgerStatus: "enter_dispatched" },
    { ledgerTextInjectedAt: "2026-08-23T09:59:58.000Z" },
    { ledgerEnterDispatchedAt: "2026-08-23T10:00:00.000Z" },
    { ledgerAgentAcceptedAt: "2026-08-23T10:00:00.000Z" }
  ]) {
    assert.equal(decideTerminalSubmissionRetry({
      ...baseFacts,
      ...override
    }).action, "refuse");
  }
});

test("replacement refuses one-sided or conflicting no-Enter proof", () => {
  for (const override of [
    {
      enterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
      enterNotAttemptedReason: "pre_key_failure"
    },
    {
      enterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
      enterNotAttemptedReason: "pre_key_failure",
      ledgerEnterNotAttemptedAt: "2026-08-23T10:00:01.000Z",
      ledgerEnterNotAttemptedReason: "pre_key_failure"
    },
    {
      enterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
      enterNotAttemptedReason: "pre_key_failure",
      ledgerEnterNotAttemptedAt: "2026-08-23T10:00:00.000Z",
      ledgerEnterNotAttemptedReason: "legacy_error"
    }
  ]) {
    assert.equal(decideTerminalSubmissionRetry({
      ...baseFacts,
      composer: "exact_empty",
      ...override
    }).action, "refuse");
  }
});

test("working, approval, modal, different, drift, and unavailable stay zero-input", () => {
  for (const composer of [
    "working", "approval_or_modal", "different_draft", "identity_drift",
    "unavailable"
  ] as const) {
    assert.equal(decideTerminalSubmissionRetry({
      ...baseFacts,
      composer
    }).action, "refuse", composer);
  }
});

test("a durable Enter reservation permanently forbids another key", () => {
  const attempt = record({
    mode: "exact_draft_enter",
    state: "enter_reserved",
    active_message_id: "msg-original",
    enter_reserved_at: "2026-08-23T10:00:01.000Z"
  });
  const decision = decideTerminalSubmissionRetry({ ...baseFacts, attempt });
  assert.equal(decision.action, "refuse");
  assert.match(
    decision.action === "refuse" ? decision.reason : "",
    /another key dispatch is forbidden/u
  );
});

test("replacement retry uses an explicit text reservation before injection", () => {
  const reserved = record({
    state: "replacement_text_reserved",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z"
  });
  assert.equal(decideTerminalSubmissionRetry({
    ...baseFacts,
    composer: "exact_empty",
    attempt: reserved,
    currentMessageId: reserved.active_message_id,
    submissionStatus: "prepared"
  }).action, "refuse");
  assert.deepEqual(decideTerminalSubmissionRetry({
    ...baseFacts,
    attempt: reserved,
    currentMessageId: reserved.active_message_id,
    submissionStatus: "prepared"
  }), {
    action: "submit_exact_draft",
    activeMessageId: reserved.active_message_id
  });
});

test("retry metadata alone never proves native acceptance", () => {
  const accepted = record({
    state: "agent_accepted",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    enter_dispatched_at: "2026-08-23T10:00:04.000Z",
    agent_accepted_at: "2026-08-23T10:00:05.000Z"
  });
  assert.equal(decideTerminalSubmissionRetry({
    ...baseFacts,
    composer: "working",
    attempt: accepted,
    currentMessageId: accepted.active_message_id
  }).action, "refuse");
});

test("native acceptance can settle a real retry prefix without fabricated transport stages", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-submission-accepted-"));
  const statePath = path.join(
    root, "store", "conversations", "turn-1", "state.json"
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}\n");
  const created = saveTerminalSubmissionRetry(statePath, record({
    state_path: statePath,
    store_dir: path.join(root, "store")
  }), null);
  const accepted = saveTerminalSubmissionRetry(statePath, {
    ...created,
    state: "agent_accepted",
    agent_accepted_at: "2026-08-23T10:00:05.000Z",
    updated_at: "2026-08-23T10:00:05.000Z"
  }, created.revision);
  assert.equal(accepted.replacement_text_reserved_at, undefined);
  assert.equal(accepted.enter_dispatched_at, undefined);
});

test("pending startup projection admits only the exact one-write ledger lag", () => {
  const attempt = record({
    revision: 5,
    state: "enter_dispatched",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    enter_dispatched_at: "2026-08-23T10:00:04.000Z",
    updated_at: "2026-08-23T10:00:04.000Z"
  });
  const submission = {
    status: "uncertain",
    message_id: "msg-original",
    prepared_at: "2026-08-23T09:59:58.000Z"
  };
  const ledger = {
    status: "uncertain",
    message_id: "msg-original",
    prepared_at: "2026-08-23T09:59:58.000Z",
    submission_retry_attempt_id: "retry-1",
    submission_retry_mode: "replacement_send",
    submission_retry_state: "enter_reserved",
    submission_retry_revision: 4,
    submission_retry_original_message_id: "msg-original",
    submission_retry_active_message_id: "msg-original",
    submission_retry_reserved_at: "2026-08-23T10:00:00.000Z",
    submission_retry_replacement_text_reserved_at:
      "2026-08-23T10:00:01.000Z",
    submission_retry_replacement_text_injected_at:
      "2026-08-23T10:00:02.000Z",
    submission_retry_enter_reserved_at: "2026-08-23T10:00:03.000Z"
  };
  assert.deepEqual(projectTerminalSubmissionRetryPending({
    attempt,
    submission,
    ledger
  }), {
    messageId: "msg-original",
    preparedAt: "2026-08-23T09:59:58.000Z",
    textInjectedAt: "2026-08-23T10:00:02.000Z",
    enterDispatchedAt: "2026-08-23T10:00:04.000Z"
  });
  assert.throws(() => projectTerminalSubmissionRetryPending({
    attempt,
    submission,
    ledger: { ...ledger, submission_retry_revision: 3 }
  }), /exact durable retry prefix/u);
  assert.throws(() => projectTerminalSubmissionRetryPending({
    attempt,
    submission,
    ledger: {
      ...ledger,
      submission_retry_state: "enter_dispatched",
      submission_retry_revision: 5
    }
  }), /exact durable retry prefix/u);
});

test("startup retry ledger promotes only one write and preserves terminal outcomes", () => {
  const attempt = record({
    revision: 5,
    state: "enter_dispatched",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    enter_dispatched_at: "2026-08-23T10:00:04.000Z",
    updated_at: "2026-08-23T10:00:04.000Z"
  });
  const current = terminalSubmissionRetryLedgerFields(attempt);
  const previous: Record<string, unknown> = {
    ...current,
    submission_retry_state: "enter_reserved",
    submission_retry_revision: 4
  };
  delete previous.submission_retry_enter_dispatched_at;
  assert.equal(
    terminalSubmissionRetryLedgerPrefix(attempt, previous),
    "previous"
  );
  assert.equal(
    terminalSubmissionRetryLedgerPrefix(attempt, {
      ...current,
      status: "not_accepted",
      not_accepted_at: "2026-08-23T10:00:05.000Z"
    }),
    "current",
    "a fully mirrored terminal outcome is never a pending-promotion lag"
  );
  assert.throws(() => terminalSubmissionRetryLedgerPrefix(attempt, {
    ...previous,
    submission_retry_revision: 3
  }), /one-write-lagging prefix/u);
});

test("accepted retry prefix distinguishes state-write and sidecar-write crashes", () => {
  const accepted = record({
    revision: 6,
    state: "agent_accepted",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    enter_dispatched_at: "2026-08-23T10:00:04.000Z",
    agent_accepted_at: "2026-08-23T10:00:05.000Z",
    updated_at: "2026-08-23T10:00:05.000Z"
  });
  const current = terminalSubmissionRetryLedgerFields(accepted);
  assert.equal(terminalSubmissionRetryLedgerPrefix(accepted, current), "current");
  const beforeAcceptedLedger = {
    ...current,
    submission_retry_state: "enter_dispatched",
    submission_retry_revision: 5
  };
  assert.equal(
    terminalSubmissionRetryLedgerPrefix(accepted, beforeAcceptedLedger),
    "previous"
  );
});

test("startup terminal-outcome matrix is monotonic and crash-repairable", () => {
  const attempt = record({
    revision: 5,
    state: "enter_dispatched",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    enter_dispatched_at: "2026-08-23T10:00:04.000Z",
    updated_at: "2026-08-23T10:00:04.000Z"
  });
  const current = terminalSubmissionRetryLedgerFields(attempt);
  const previous: Record<string, unknown> = {
    ...current,
    submission_retry_state: "enter_reserved",
    submission_retry_revision: 4
  };
  delete previous.submission_retry_enter_dispatched_at;
  const pendingSubmission = {
    status: "uncertain",
    uncertain_at: "2026-08-23T10:00:00.000Z"
  };
  const pendingLedger = {
    ...previous,
    status: "uncertain",
    uncertain_at: "2026-08-23T10:00:00.000Z"
  };
  assert.deepEqual(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: pendingSubmission,
    ledger: pendingLedger
  }), { action: "promote_pending" });
  assert.deepEqual(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: {
      status: "not_accepted",
      not_accepted_at: "2026-08-23T10:00:05.000Z"
    },
    ledger: { ...current, status: "enter_dispatched" }
  }), {
    action: "repair_terminal_ledger",
    outcome: "not_accepted",
    at: "2026-08-23T10:00:05.000Z"
  });
  assert.deepEqual(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: {
      status: "uncertain",
      uncertain_at: "2026-08-23T10:00:05.000Z",
      error: "identity drift"
    },
    ledger: { ...current, status: "enter_dispatched" }
  }), {
    action: "repair_terminal_ledger",
    outcome: "uncertain",
    at: "2026-08-23T10:00:05.000Z",
    reason: "identity drift"
  });
  assert.deepEqual(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: { status: "enter_dispatched" },
    ledger: {
      ...current,
      status: "uncertain",
      uncertain_at: "2026-08-23T10:00:05.000Z",
      error: "rollout identity drift"
    }
  }), {
    action: "repair_terminal_state",
    outcome: "uncertain",
    at: "2026-08-23T10:00:05.000Z",
    reason: "rollout identity drift"
  });
  assert.equal(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: {
      status: "uncertain",
      uncertain_at: "2026-08-23T10:00:05.000Z"
    },
    ledger: {
      ...current,
      status: "uncertain",
      uncertain_at: "2026-08-23T10:00:05.000Z"
    }
  }).action, "no_change");
  assert.equal(decideTerminalSubmissionRetryStartup({
    attempt,
    submission: {
      status: "agent_accepted",
      agent_accepted_at: "2026-08-23T10:00:05.000Z"
    },
    ledger: {
      ...current,
      status: "not_accepted",
      not_accepted_at: "2026-08-23T10:00:05.000Z"
    }
  }).action, "refuse");
});

test("accepted startup alone may repair an exact missing initial retry mirror", () => {
  const replacement = record();
  assert.equal(terminalSubmissionRetryLedgerPrefix(replacement, {}),
    "missing_initial");
  assert.deepEqual(decideTerminalSubmissionRetryStartup({
    attempt: replacement,
    submission: {
      status: "agent_accepted",
      agent_accepted_at: "2026-08-23T10:00:01.000Z"
    },
    ledger: { status: "uncertain" }
  }), { action: "finalize_accepted" });
  assert.equal(decideTerminalSubmissionRetryStartup({
    attempt: replacement,
    submission: { status: "uncertain" },
    ledger: { status: "uncertain" }
  }).action, "no_change");
});

test("retry record uses revision CAS and monotonic one-shot state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-submission-retry-"));
  const statePath = path.join(root, "store", "conversations", "turn-1", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}\n");
  const created = saveTerminalSubmissionRetry(
    statePath,
    record({ state_path: statePath, store_dir: path.join(root, "store") }),
    null
  );
  assert.equal(created.revision, 1);
  const textReserved = saveTerminalSubmissionRetry(statePath, {
    ...created,
    state: "replacement_text_reserved",
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z",
    updated_at: "2026-08-23T10:00:01.000Z"
  }, 1);
  const textInjected = saveTerminalSubmissionRetry(statePath, {
    ...textReserved,
    state: "replacement_text_injected",
    replacement_text_injected_at: "2026-08-23T10:00:02.000Z",
    updated_at: "2026-08-23T10:00:02.000Z"
  }, 2);
  const reserved = saveTerminalSubmissionRetry(statePath, {
    ...textInjected,
    state: "enter_reserved",
    enter_reserved_at: "2026-08-23T10:00:03.000Z",
    updated_at: "2026-08-23T10:00:03.000Z"
  }, 3);
  assert.equal(reserved.revision, 4);
  assert.deepEqual(loadTerminalSubmissionRetry(statePath), reserved);
  assert.throws(
    () => saveTerminalSubmissionRetry(statePath, reserved, 3),
    /changed before its CAS write/u
  );
  assert.throws(
    () => saveTerminalSubmissionRetry(statePath, {
      ...reserved,
      state: "replacement_reserved",
      updated_at: "2026-08-23T10:00:04.000Z"
    }, 4),
    /cannot regress|cannot become|replacement state is malformed/u
  );
});

test("lower states reject future transport timestamps and string revisions", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-submission-shape-"));
  const statePath = path.join(root, "store", "conversations", "turn-1", "state.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}\n");
  assert.throws(() => saveTerminalSubmissionRetry(statePath, {
    ...record({ state_path: statePath, store_dir: path.join(root, "store") }),
    replacement_text_reserved_at: "2026-08-23T10:00:01.000Z"
  }, null), /replacement state is malformed/u);
  fs.writeFileSync(path.join(path.dirname(statePath), "submission-retry.json"),
    JSON.stringify({
      ...record({ state_path: statePath, store_dir: path.join(root, "store") }),
      revision: "1"
    }));
  assert.throws(() => loadTerminalSubmissionRetry(statePath), /malformed/u);
});

test("retry record rejects a noncanonical Store or Turn directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-submission-path-"));
  const statePath = path.join(
    root, "store", "conversations", "turn-1", "state.json"
  );
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, "{}\n");
  assert.throws(() => saveTerminalSubmissionRetry(statePath, record({
    state_path: statePath,
    store_dir: path.join(root, "other-store")
  }), null), /canonical Turn Store path/u);
  assert.throws(() => saveTerminalSubmissionRetry(statePath, record({
    state_path: statePath,
    store_dir: path.join(root, "store"),
    turn_id: "turn-other"
  }), null), /canonical Turn Store path/u);
});

function record(
  overrides: Partial<TerminalSubmissionRetryRecord> = {}
): TerminalSubmissionRetryRecord {
  return {
    schema: TERMINAL_SUBMISSION_RETRY_SCHEMA,
    version: TERMINAL_SUBMISSION_RETRY_VERSION,
    revision: 1,
    attempt_id: "retry-1",
    mode: "replacement_send",
    state: "replacement_reserved",
    store_dir: "/tmp/store",
    state_path: "/tmp/store/conversations/turn-1/state.json",
    session_id: "session-1",
    turn_id: "turn-1",
    original_message_id: "msg-original",
    active_message_id: "msg-original",
    request_hash: "a".repeat(64),
    terminal_target: "workspace:0.0",
    callback_route_fingerprint: null,
    deferred_foreground_transfer_id: null,
    reserved_at: "2026-08-23T10:00:00.000Z",
    updated_at: "2026-08-23T10:00:00.000Z",
    ...overrides
  };
}

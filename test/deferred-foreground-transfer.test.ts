import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDeferredForegroundTransfer,
  DeferredForegroundTransferConflictError,
  isDeferredForegroundSubmissionRetryPending,
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer,
  pathsForDeferredForegroundTransfer,
  saveDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../src/deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "../src/deferred-foreground-transfer-policy.js";
import { deferredForegroundUserAbandonmentLedgerPlan } from
  "../src/deferred-foreground-user-abandonment-ledger.js";
import { ensureDeferredForegroundUserAbandonmentCloseEvent } from
  "../src/deferred-foreground-user-abandonment-event.js";
import { deferredForegroundUserAbandonmentTurnAuthority,
  exactDeferredForegroundUserAbandonmentTurnReceipt } from
  "../src/deferred-foreground-user-abandonment-turn.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedTerminalBinding
} from "../src/managed-session.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";
import { createConversation } from "../src/protocol.js";
import { appendEvent } from "../src/store.js";
import { createTerminalHandoffCliFacade,
  type TerminalHandoffCliDependencies } from
  "../src/terminal-handoff-cli-adapter.js";

const SOURCE_UUID = "00000000-0000-4000-8000-000000000401";
const OTHER_UUID = "00000000-0000-4000-8000-000000000402";
const T0 = "2026-08-12T02:00:00.000Z";
const T1 = "2026-08-12T02:00:01.000Z";
const T2 = "2026-08-12T02:00:02.000Z";
const T3 = "2026-08-12T02:00:03.000Z";
const T4 = "2026-08-12T02:00:04.000Z";
const T5 = "2026-08-12T02:00:05.000Z";
const T6 = "2026-08-12T02:00:06.000Z";
const T7 = "2026-08-12T02:00:07.000Z";
const T8 = "2026-08-12T02:00:08.000Z";
const T9 = "2026-08-12T02:00:09.000Z";
const T10 = "2026-08-12T02:00:10.000Z";

test("deferred foreground final status policy is exhaustive and fail closed", () => {
  for (const [status, final] of [
    ["resolved", true],
    ["abort_resolved", true],
    ["prepared", false],
    ["source_reserved", false],
    ["target_prepared", false],
    ["dispatch_started", false],
    ["committed", false],
    ["aborted", false],
    ["uncertain", false],
    ["user_abandoning", false],
    ["user_abandoned", true],
    [undefined, false],
    [null, false],
    [42, false],
    [{}, false]
  ] as const) {
    assert.equal(isFinalDeferredForegroundTransferStatus(status), final, String(status));
  }
  const nonCoercible = { toString(): never { throw new Error("coerced"); } };
  assert.doesNotThrow(() =>
    isFinalDeferredForegroundTransferStatus(nonCoercible));
  assert.equal(isFinalDeferredForegroundTransferStatus(nonCoercible), false);
});

test("generic Turn mutation rejects every unmatched nonfinal target claim", async (t) => {
  const unavailable = new Proxy({}, {
    get(_target, property) {
      throw new Error(`unexpected handoff dependency ${String(property)}`);
    }
  });
  const handoff = createTerminalHandoffCliFacade({
    runtime: unavailable,
    identity: unavailable,
    acceptance: unavailable,
    authority: unavailable,
    repository: unavailable
  } as TerminalHandoffCliDependencies);
  for (const scenario of [
    "missing_takeover",
    "wrong_takeover",
    "duplicate",
    "missing_state_path",
    "mismatched_state_path"
  ] as const) {
    await t.test(scenario, () => {
      const sandbox = fs.mkdtempSync(path.join(
        os.tmpdir(),
        `akk-target-claim-${scenario}-`
      ));
      try {
        const storeDir = path.join(sandbox, "store");
        const statePath = path.join(
          storeDir,
          "conversations",
          "turn-target-claim",
          "state.json"
        );
        const persistTarget = (
          transferId: string,
          targetStatePath: string
        ): DeferredForegroundTransfer => {
          const created = saveDeferredForegroundTransfer(storeDir, {
            ...prepared(),
            transfer_id: transferId,
            target_session_id: "session-target-claim"
          }, { expectedRevision: null });
          const reserved = saveDeferredForegroundTransfer(storeDir, {
            ...sourceReserved(created),
            revision: created.revision
          }, { expectedRevision: created.revision! });
          const target = targetPrepared(reserved).transfer;
          return saveDeferredForegroundTransfer(storeDir, {
            ...target,
            revision: reserved.revision,
            turn_id: "turn-target-claim",
            state_path: targetStatePath
          }, { expectedRevision: reserved.revision! });
        };
        const savedFirst = persistTarget(
          "target-claim-one",
          scenario === "mismatched_state_path"
            ? path.join(storeDir, "conversations", "other", "state.json")
            : statePath
        );
        if (scenario === "missing_state_path") {
          const malformed = { ...savedFirst } as Record<string, unknown>;
          delete malformed.state_path;
          fs.writeFileSync(
            pathsForDeferredForegroundTransfer(
              savedFirst.transfer_id,
              storeDir
            ).statePath,
            `${JSON.stringify(malformed, null, 2)}\n`,
            { mode: 0o600 }
          );
        }
        if (scenario === "duplicate") {
          persistTarget("target-claim-two", statePath);
        }
        const conversation = {
          ...createConversation({
            userRequest: "generic close must not orphan target authority",
            sessionId: savedFirst.target_session_id,
            turnId: savedFirst.turn_id!,
            executorKind: "codex",
            now: new Date(T3)
          }),
          state_path: statePath,
          native_session_takeover: scenario !== "wrong_takeover"
            ? {}
            : { deferred_foreground_transfer_id: "wrong-transfer-id" }
        };
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(
          statePath,
          `${JSON.stringify(conversation, null, 2)}\n`,
          { mode: 0o600 }
        );
        const stateBefore = fs.readFileSync(statePath, "utf8");
        const transferIds = scenario === "duplicate"
          ? ["target-claim-one", "target-claim-two"]
          : ["target-claim-one"];
        const transferBytesBefore = transferIds.map((transferId) =>
          fs.readFileSync(
            pathsForDeferredForegroundTransfer(transferId, storeDir).statePath,
            "utf8"
          ));

        assert.throws(() =>
          handoff.assertConversationHasNoNonterminalDeferredForegroundTransfer({
            storeDir,
            conversation,
            action: "close"
          }), scenario === "duplicate"
          ? /multiple nonfinal deferred foreground transfers/u
          : scenario === "mismatched_state_path"
            ? /mismatched canonical state authority/u
            : scenario === "missing_state_path"
              ? /requires its target\/Turn identity/u
              : /target authority|does not exist|ENOENT/u);
        assert.equal(fs.readFileSync(statePath, "utf8"), stateBefore);
        assert.deepEqual(
          transferIds.map((transferId) => fs.readFileSync(
            pathsForDeferredForegroundTransfer(transferId, storeDir).statePath,
            "utf8"
          )),
          transferBytesBefore
        );
      } finally {
        fs.rmSync(sandbox, { recursive: true, force: true });
      }
    });
  }
});

test("user abandonment persists one intent CAS and one final CAS", () => {
  const sandbox = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-deferred-user-abandonment-"
  ));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
      expectedRevision: null
    });
    const reserved = saveDeferredForegroundTransfer(storeDir, {
      ...sourceReserved(created),
      revision: created.revision
    }, { expectedRevision: created.revision! });
    const target = saveDeferredForegroundTransfer(storeDir, {
      ...targetPrepared(reserved).transfer,
      revision: reserved.revision
    }, { expectedRevision: reserved.revision! });
    const fingerprint = "d".repeat(64);
    const intent = saveDeferredForegroundTransfer(storeDir, {
      ...target,
      status: "user_abandoning",
      user_abandonment_disposition: "user_abandoned_management",
      user_abandonment_origin_status: "target_prepared",
      user_abandonment_origin_revision: target.revision,
      user_abandonment_turn_id: target.turn_id,
      user_abandonment_turn_fingerprint: fingerprint,
      user_abandonment_requested_at: T3,
      user_abandonment_close_reason: "closed by request",
      user_abandonment_ledger_disposition: "absent",
      user_abandonment_ledger_fingerprint: fingerprint
    }, { expectedRevision: target.revision! });
    assert.equal(intent.revision, Number(target.revision) + 1);
    assert.equal(intent.status, "user_abandoning");

    const final = saveDeferredForegroundTransfer(storeDir, {
      ...intent,
      status: "user_abandoned",
      user_abandonment_completed_at: T4,
      user_abandonment_source_disposition: "already_released",
      user_abandonment_source_fingerprint: fingerprint,
      user_abandonment_target_disposition: "already_released",
      user_abandonment_target_fingerprint: fingerprint
    }, { expectedRevision: intent.revision! });
    assert.equal(final.revision, Number(target.revision) + 2);
    assert.equal(final.status, "user_abandoned");
    assert.equal(isFinalDeferredForegroundTransferStatus(final.status), true);
    assert.throws(() => assertDeferredForegroundTransfer({
      ...final,
      user_abandonment_origin_revision:
        Number(final.user_abandonment_origin_revision) + 1
    }), /user abandonment intent is invalid/u);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("user abandonment ledger plan is exact, stable, and fail closed", () => {
  const transfer = {
    ...targetPrepared().transfer,
    state_path: "/tmp/akk-store/conversations/turn-deferred/state.json"
  };
  const statePath = transfer.state_path;
  const logPath = path.join(path.dirname(statePath), "events.ndjson");
  const storeDir = "/tmp/akk-store";
  const exact = {
    version: 2,
    terminal_endpoint: transfer.terminal_endpoint,
    status: "prepared",
    generation_id: transfer.message_id,
    conversation_id: transfer.turn_id,
    session_id: transfer.target_session_id,
    turn_id: transfer.turn_id,
    message_id: transfer.message_id,
    message_type: "task",
    request_hash: transfer.request_hash,
    prepared_at: transfer.prepared_at,
    store_dir: storeDir,
    state_path: statePath,
    event_log_path: logPath,
    deferred_foreground_transfer_id: transfer.transfer_id,
    callback_expected: true,
    dispatcher_pid: 99
  };
  const plan = deferredForegroundUserAbandonmentLedgerPlan({
    current: exact,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  assert.equal(plan.disposition, "resolved");
  assert.equal(plan.next?.status, "resolved");
  assert.equal(plan.next?.resolved_at, T3);
  assert.equal(plan.next?.callback_expected, false);

  const applied = deferredForegroundUserAbandonmentLedgerPlan({
    current: plan.next,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  assert.equal(applied.disposition, "already_released");
  assert.equal(applied.fingerprint, plan.fingerprint);
  assert.deepEqual(applied.next, plan.next);

  const legacyResolved = deferredForegroundUserAbandonmentLedgerPlan({
    current: {
      ...exact,
      status: "resolved",
      resolved_at: T2,
      dispatcher_pid: 99,
      callback_expected: true
    },
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  assert.equal(legacyResolved.disposition, "already_released");
  assert.equal(legacyResolved.next?.dispatcher_pid, null);
  assert.equal(legacyResolved.next?.callback_expected, false);

  const acceptedEvidenceBase = {
    source: "codex_rollout" as const,
    kind: "native_user_turn" as const,
    nativeThreadId: OTHER_UUID,
    requestHash: transfer.request_hash,
    acceptanceId: "acceptance-after-resolve",
    acceptedAt: T1,
    anchorFingerprint: "a".repeat(64)
  };
  const acceptedEvidence = {
    ...acceptedEvidenceBase,
    evidenceFingerprint: createHash("sha256")
      .update(JSON.stringify(acceptedEvidenceBase))
      .digest("hex")
  };
  for (const resolvedReceipt of [
    {
      ...exact,
      status: "resolved",
      agent_accepted_at: T1,
      acceptance_evidence: acceptedEvidence,
      resolved_at: T2
    },
    {
      ...exact,
      status: "resolved",
      uncertain_at: T1,
      resolved_at: T2
    },
    {
      ...exact,
      status: "resolved",
      aborted_at: T1,
      safe_to_retry: false,
      resolved_at: T2
    }
  ]) {
    const resolvedPlan = deferredForegroundUserAbandonmentLedgerPlan({
      current: resolvedReceipt,
      transfer,
      terminalControl,
      storeDir,
      statePath,
      logPath,
      resolvedAt: T3
    });
    assert.equal(resolvedPlan.disposition, "already_released");
    assert.equal(resolvedPlan.next?.dispatcher_pid, null);
    assert.equal(resolvedPlan.next?.callback_expected, false);
  }

  const absent = deferredForegroundUserAbandonmentLedgerPlan({
    current: undefined,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  assert.equal(absent.disposition, "absent");
  assert.equal(absent.next, undefined);

  const oldReceipt = {
    ...exact,
    version: undefined,
    status: "text_injected",
    text_injected_at: T1
  };
  const replacementRequestHash = "e".repeat(64);
  const replacementPreparedAt = T3;
  const replacementStatePath =
    "/tmp/akk-store/conversations/turn-new/state.json";
  const replacementLogPath =
    "/tmp/akk-store/conversations/turn-new/events.ndjson";
  const replacement = {
    ...exact,
    generation_id: "message-new",
    message_id: "message-new",
    conversation_id: "turn-new",
    turn_id: "turn-new",
    session_id: "session-new",
    request_hash: replacementRequestHash,
    prepared_at: replacementPreparedAt,
    state_path: replacementStatePath,
    event_log_path: replacementLogPath,
    deferred_foreground_transfer_id: "transfer-new",
    callback_expected: false,
    terminal_submission_receipts: [oldReceipt]
  };
  const replacementOwner = {
    ...createConversation({
      userRequest: "newer terminal owner",
      sessionId: "session-new",
      turnId: "turn-new",
      executorKind: "codex",
      now: new Date(replacementPreparedAt)
    }),
    status: "waiting_for_agent" as const,
    state_path: replacementStatePath,
    event_log_path: replacementLogPath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_control: terminalControl,
      terminal_bridge_message_id: "message-new",
      terminal_bridge_request_hash: replacementRequestHash,
      terminal_bridge_submission: {
        status: "prepared",
        message_id: "message-new",
        message_type: "task",
        request_hash: replacementRequestHash,
        prepared_at: replacementPreparedAt
      }
    }
  };
  const superseded = deferredForegroundUserAbandonmentLedgerPlan({
    current: replacement,
    currentOwner: replacementOwner,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  const evolved = deferredForegroundUserAbandonmentLedgerPlan({
    current: { ...replacement, updated_at: T8 },
    currentOwner: replacementOwner,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  });
  assert.equal(superseded.disposition, "superseded");
  assert.equal(evolved.fingerprint, superseded.fingerprint);

  for (const malformedCurrent of [
    {
      ...replacement,
      generation_id: undefined,
      message_id: undefined,
      conversation_id: undefined,
      turn_id: undefined,
      state_path: undefined,
      event_log_path: undefined
    },
    {
      ...replacement,
      generation_id: exact.generation_id,
      message_id: exact.message_id
    },
    {
      ...replacement,
      conversation_id: exact.conversation_id,
      turn_id: exact.turn_id,
      state_path: exact.state_path,
      event_log_path: exact.event_log_path
    }
  ]) {
    assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
      current: malformedCurrent,
      currentOwner: replacementOwner,
      transfer,
      terminalControl,
      storeDir,
      statePath,
      logPath,
      resolvedAt: T3
    }), /neither its exact generation/u);
  }

  assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
    current: {
      ...replacement,
      terminal_submission_receipts: [oldReceipt, { ...oldReceipt }]
    },
    currentOwner: replacementOwner,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  }), /duplicated/u);
  assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
    current: { ...exact, kind: "lifecycle" },
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  }), /neither its exact generation/u);
  assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
    current: {
      ...exact,
      terminal_endpoint: {
        ...transfer.terminal_endpoint,
        route_key: "different-terminal-route"
      }
    },
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  }), /neither its exact generation/u);
  for (const malformedExact of [
    { ...exact, status: "garbage" },
    { ...exact, message_type: undefined },
    { ...exact, prepared_at: undefined },
    { ...exact, callback_expected: "yes" },
    { ...exact, dispatcher_pid: 1 }
  ]) {
    assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
      current: malformedExact,
      transfer,
      terminalControl,
      storeDir,
      statePath,
      logPath,
      resolvedAt: T3
    }), /neither its exact generation/u);
  }
  assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
    current: replacement,
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  }), /neither its exact generation/u);
  assert.throws(() => deferredForegroundUserAbandonmentLedgerPlan({
    current: replacement,
    currentOwner: {
      ...replacementOwner,
      native_session_takeover: {
        ...replacementOwner.native_session_takeover,
        terminal_bridge_message_id: "wrong-message"
      }
    },
    transfer,
    terminalControl,
    storeDir,
    statePath,
    logPath,
    resolvedAt: T3
  }), /neither its exact generation/u);
});

test("user abandonment Turn receipt is exact and recovery trusts frozen intent", () => {
  const target = targetPrepared().transfer;
  const transfer: DeferredForegroundTransfer = {
    ...target,
    revision: 4,
    status: "user_abandoning",
    user_abandonment_disposition: "user_abandoned_management",
    user_abandonment_origin_status: "target_prepared",
    user_abandonment_origin_revision: 3,
    user_abandonment_turn_id: target.turn_id,
    user_abandonment_turn_fingerprint: "d".repeat(64),
    user_abandonment_requested_at: T3,
    user_abandonment_close_reason: "closed by request",
    user_abandonment_ledger_disposition: "absent",
    user_abandonment_ledger_fingerprint: "e".repeat(64)
  };
  const open = {
    ...createConversation({
      userRequest: "abandon management",
      sessionId: target.target_session_id,
      turnId: target.turn_id!,
      executorKind: "codex",
      now: new Date(T2)
    }),
    status: "waiting_for_agent" as const,
    updated_at: T8
  };
  assert.equal(
    deferredForegroundUserAbandonmentTurnAuthority(open, transfer)
      .turnFingerprint,
    transfer.user_abandonment_turn_fingerprint
  );
  const closed = {
    ...open,
    status: "closed" as const,
    disposition: "user_abandoned_management",
    callback_expected: false,
    closed_at: T3,
    close_reason: "closed by request",
    management_abandonment: {
      version: 1,
      disposition: "user_abandoned_management",
      transfer_id: transfer.transfer_id,
      transfer_origin_revision: transfer.user_abandonment_origin_revision,
      turn_fingerprint: transfer.user_abandonment_turn_fingerprint,
      requested_at: transfer.user_abandonment_requested_at,
      close_reason: transfer.user_abandonment_close_reason
    }
  };
  assert.equal(
    exactDeferredForegroundUserAbandonmentTurnReceipt(closed, transfer),
    true
  );
  for (const malformed of [
    { ...closed, callback_expected: true },
    {
      ...closed,
      management_abandonment: {
        ...closed.management_abandonment,
        transfer_origin_revision: 2
      }
    },
    {
      ...closed,
      management_abandonment: {
        ...closed.management_abandonment,
        requested_at: T4
      }
    }
  ]) {
    assert.equal(
      exactDeferredForegroundUserAbandonmentTurnReceipt(malformed, transfer),
      false
    );
  }
});

test("user abandonment close event is append-once and conflict exact", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-abandon-event-"));
  try {
    const transfer = {
      ...targetPrepared().transfer,
      status: "user_abandoning" as const,
      user_abandonment_requested_at: T3,
      user_abandonment_close_reason: "closed by request"
    };
    const conversation = {
      ...createConversation({
        userRequest: "close event",
        sessionId: transfer.target_session_id,
        turnId: transfer.turn_id!,
        executorKind: "codex",
        now: new Date(T2)
      }),
      status: "closed" as const,
      close_reason: "closed by request"
    };
    const eventPath = (name: string) => path.join(
      sandbox,
      name,
      "conversations",
      conversation.conversation_id,
      "events.ndjson"
    );
    const exactPath = eventPath("exact");
    ensureDeferredForegroundUserAbandonmentCloseEvent({
      logPath: exactPath,
      conversation,
      transfer
    });
    ensureDeferredForegroundUserAbandonmentCloseEvent({
      logPath: exactPath,
      conversation,
      transfer
    });
    assert.equal(
      fs.readFileSync(exactPath, "utf8").trim().split("\n").length,
      1
    );

    const conflictPath = eventPath("conflict");
    appendEvent(conflictPath, {
      ts: T4,
      conversation_id: conversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: conversation.close_reason,
      disposition: "user_abandoned_management",
      transfer_id: transfer.transfer_id,
      terminal_input_sent: false,
      coding_agent_stopped: false,
      management_release_pending: true
    });
    assert.throws(() => ensureDeferredForegroundUserAbandonmentCloseEvent({
      logPath: conflictPath,
      conversation,
      transfer
    }), /close event conflicts/u);

    const extraPath = eventPath("extra");
    appendEvent(extraPath, {
      ts: T3,
      conversation_id: conversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: conversation.close_reason,
      disposition: "user_abandoned_management",
      transfer_id: transfer.transfer_id,
      terminal_input_sent: false,
      coding_agent_stopped: false,
      management_release_pending: true,
      unexpected_authority: "must fail closed"
    });
    assert.throws(() => ensureDeferredForegroundUserAbandonmentCloseEvent({
      logPath: extraPath,
      conversation,
      transfer
    }), /close event conflicts/u);

    const duplicatePath = eventPath("duplicate");
    const duplicate = {
      ts: T3,
      conversation_id: conversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: conversation.close_reason,
      disposition: "user_abandoned_management",
      transfer_id: transfer.transfer_id,
      terminal_input_sent: false,
      coding_agent_stopped: false,
      management_release_pending: true
    };
    appendEvent(duplicatePath, duplicate);
    appendEvent(duplicatePath, duplicate);
    assert.throws(() => ensureDeferredForegroundUserAbandonmentCloseEvent({
      logPath: duplicatePath,
      conversation,
      transfer
    }), /duplicate user abandonment close events/u);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

const terminalControl: TerminalControlRef = {
  kind: "herdr" as const,
  target: "w1:p1",
  session: "w1",
  socketPath: "/tmp/herdr-session/herdr.sock",
  sessionDir: "/tmp/herdr-session",
  workspaceId: "w1",
  tabId: "t1",
  paneId: "p1",
  terminalId: "term-1",
  panePid: 100,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys", "durable_completion"]
};

function sourceBinding(): ManagedTerminalBinding {
  return terminalBindingFrom({
    terminalId: "terminal:v2:herdr:codex:w1:p1:200",
    terminalControl,
    pid: 200,
    nativeThreadId: SOURCE_UUID,
    processUuid: "codex-pid:200:birth:fixture",
    processBirth: "fixture",
    evidence: "codex_status_card+process_birth",
    generation: 1,
    now: new Date(T0)
  });
}

function targetBindingPair(targetUuid = OTHER_UUID): {
  before: ManagedTerminalBinding;
  accepted: ManagedTerminalBinding;
} {
  const before = terminalBindingFrom({
    terminalId: "terminal:v2:herdr:codex:w1:p1:200",
    terminalControl,
    pid: 200,
    processUuid: "codex-pid:200:birth:fixture",
    processBirth: "fixture",
    evidence: "codex_process_birth",
    generation: 1,
    now: new Date(T0)
  });
  return {
    before,
    accepted: {
      ...before,
      native_thread_id: targetUuid,
      native_process: {
        ...before.native_process,
        rollout: {
          fd: "9",
          device: "1",
          inode: targetUuid === SOURCE_UUID ? "400" : "401",
          path: "/tmp/deferred-target.jsonl"
        },
        evidence: "codex_rollout_fd"
      },
      last_verified_at: T6
    }
  };
}

function scrubbedSourceBinding(
  before: ManagedTerminalBinding
): ManagedTerminalBinding {
  return terminalBindingFrom({
    terminalId: before.terminal_id,
    terminalControl: before.terminal_control,
    pid: before.native_process.pid,
    processUuid: before.native_process.process_uuid,
    processBirth: before.native_process.process_birth,
    evidence: "deferred_foreground_source_retired+process_birth",
    generation: before.generation + 1,
    now: new Date(T6)
  });
}

function prepared(): DeferredForegroundTransfer {
  const before = sourceBinding();
  return {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 1,
    transfer_id: "deferred-transfer-test",
    status: "prepared",
    input_stage: "none",
    terminal_id: before.terminal_id,
    terminal_endpoint: before.terminal_endpoint!,
    process_pid: before.native_process.pid,
    process_uuid: before.native_process.process_uuid!,
    process_birth: before.native_process.process_birth!,
    workspace: "/workspace/project",
    source_session_id: "session-status-card",
    source_expected_revision: 1,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-status-card",
      status: "bound",
      binding: before
    }),
    source_before_binding: before,
    target_session_id: "session-provisional",
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: createHash("sha256")
      .update("deferred-foreground-no-previous-dispatch")
      .digest("hex"),
    request_hash: createHash("sha256").update("ordinary task").digest("hex"),
    dispatcher_pid: 999,
    prepared_at: T0
  };
}

function candidatePrepared(): DeferredForegroundTransfer {
  const statusCard = sourceBinding();
  const before: ManagedTerminalBinding = {
    ...statusCard,
    native_process: {
      ...statusCard.native_process,
      rollout: {
        fd: "7",
        device: "1",
        inode: "399",
        path: "/tmp/source-rollout.jsonl"
      },
      evidence: "codex_rollout_fd+process_birth"
    }
  };
  return {
    ...prepared(),
    version: 2,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-status-card",
      status: "bound",
      binding: before
    }),
    source_previous_last_transition_id: "transition-already-committed",
    source_before_binding: before,
    source_kind: "candidate_rollout_quiescent",
    source_turn_history: [
      {
        turn_id: "turn-history-1",
        status: "idle",
        updated_at: T0,
        binding_id: before.binding_id,
        binding_generation: before.generation,
        native_thread_id: SOURCE_UUID,
        turn_fingerprint: createHash("sha256")
          .update("exact historical Turn state")
          .digest("hex")
      }
    ]
  };
}

function abandonedPredecessorPrepared(): DeferredForegroundTransfer {
  const candidate = candidatePrepared();
  return {
    ...candidate,
    source_turn_history: candidate.source_turn_history?.map((turn) => ({
      ...turn,
      status: "closed" as const
    })),
    source_rollout_authority: "explicitly_abandoned_predecessor",
    source_abandonment_fingerprint: createHash("sha256")
      .update("exact abandoned predecessor receipt authority")
      .digest("hex"),
    previous_dispatch_status: "resolved",
    previous_dispatch_fingerprint: createHash("sha256")
      .update("exact resolved predecessor dispatch")
      .digest("hex")
  };
}

function sourceReserved(
  value: DeferredForegroundTransfer = prepared()
): DeferredForegroundTransfer {
  return {
    ...value,
    status: "source_reserved",
    source_reserved_at: T1
  };
}

function targetPrepared(
  value: DeferredForegroundTransfer = sourceReserved(),
  targetUuid = OTHER_UUID
): { transfer: DeferredForegroundTransfer; pair: ReturnType<typeof targetBindingPair> } {
  const pair = targetBindingPair(targetUuid);
  return {
    pair,
    transfer: {
      ...value,
      status: "target_prepared",
      target_prepared_at: T2,
      target_prepared_revision: 1,
      target_prepared_status: "transitioning",
      target_prepared_last_transition_id: value.transfer_id,
      target_prepared_binding_token: managedSessionBindingToken({
        session_id: value.target_session_id,
        status: "transitioning",
        binding: pair.before
      }),
      target_before_binding: pair.before,
      message_id: "msg-deferred",
      turn_id: "turn-deferred",
      state_path: "/tmp/turn-deferred/state.json"
    }
  };
}

function enterDispatched(
  targetUuid = OTHER_UUID
): { transfer: DeferredForegroundTransfer; pair: ReturnType<typeof targetBindingPair> } {
  const target = targetPrepared(undefined, targetUuid);
  return {
    pair: target.pair,
    transfer: {
      ...target.transfer,
      status: "dispatch_started",
      input_stage: "enter_dispatched",
      dispatch_started_at: T3,
      text_injected_at: T4,
      enter_dispatched_at: T5
    }
  };
}

function committed(
  targetUuid = OTHER_UUID,
  options: {
    uncertainAt?: string;
    recoveredAt?: string;
    error?: string;
  } = {},
  existing?: {
    transfer: DeferredForegroundTransfer;
    pair: ReturnType<typeof targetBindingPair>;
  }
): DeferredForegroundTransfer {
  const dispatched = existing ?? enterDispatched(targetUuid);
  const sourceBefore = dispatched.transfer.source_before_binding;
  const sourcePreRetirement = targetUuid === SOURCE_UUID
    ? scrubbedSourceBinding(sourceBefore)
    : sourceBefore;
  return {
    ...dispatched.transfer,
    status: "committed",
    input_stage: "agent_accepted",
    enter_dispatched_at: dispatched.transfer.enter_dispatched_at ?? T5,
    agent_accepted_at: options.uncertainAt ? T8 : T6,
    target_native_thread_id: targetUuid,
    target_accepted_revision: 2,
    target_accepted_status: "transitioning",
    target_accepted_binding_token: managedSessionBindingToken({
      session_id: dispatched.transfer.target_session_id,
      status: "transitioning",
      binding: dispatched.pair.accepted
    }),
    target_accepted_binding: dispatched.pair.accepted,
    source_pre_retirement_revision: targetUuid === SOURCE_UUID ? 3 : 2,
    source_pre_retirement_status: "transitioning",
    source_pre_retirement_binding_token: managedSessionBindingToken({
      session_id: dispatched.transfer.source_session_id,
      status: "transitioning",
      binding: sourcePreRetirement
    }),
    source_pre_retirement_binding: sourcePreRetirement,
    source_retirement: targetUuid === SOURCE_UUID
      ? "binding_scrubbed_same_native_thread"
      : "binding_retained",
    committed_at: options.uncertainAt ? T9 : T6,
    ...(options.uncertainAt
      ? {
          uncertain_at: options.uncertainAt,
          recovered_at: options.recoveredAt ?? T9,
          error: options.error ?? "dispatch outcome required recovery",
          do_not_retry: true
        }
      : {})
  };
}

function resolved(
  targetUuid = OTHER_UUID,
  existing?: DeferredForegroundTransfer
): DeferredForegroundTransfer {
  const value = existing ?? committed(targetUuid);
  return {
    ...value,
    status: "resolved",
    target_after_revision: 3,
    target_after_status: "bound",
    target_after_binding_token: managedSessionBindingToken({
      session_id: value.target_session_id,
      status: "bound",
      binding: value.target_accepted_binding
    }),
    source_after_revision:
      Number(value.source_pre_retirement_revision) + 1,
    source_after_status: "detached",
    source_after_binding: value.source_pre_retirement_binding,
    source_after_binding_token: managedSessionBindingToken({
      session_id: value.source_session_id,
      status: "detached",
      binding: value.source_pre_retirement_binding
    }),
    resolved_at: T7
  };
}

function assertValid(value: DeferredForegroundTransfer): void {
  assert.doesNotThrow(() =>
    assertDeferredForegroundTransfer(value, undefined, {
      allowMissingRevision: true
    })
  );
}

test("staged schema validation preserves source-before-target getter order", () => {
  const candidate: any = candidatePrepared();
  candidate.source_turn_history = [{
    ...candidate.source_turn_history[0],
    binding_generation: 0
  }];
  Object.defineProperty(candidate, "target_session_id", {
    configurable: true,
    enumerable: true,
    get() {
      throw new Error("later target getter must not run");
    }
  });
  assert.throws(
    () => assertDeferredForegroundTransfer(candidate, undefined, {
      allowMissingRevision: true
    }),
    /source Turn history is invalid/u
  );
});

test("schema keeps target UUID behind exact transitioning provisional authority", () => {
  assertValid(prepared());
  const target = targetPrepared().transfer;
  assertValid(target);

  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...prepared(),
      target_native_thread_id: OTHER_UUID
    }, undefined, { allowMissingRevision: true }),
    /fully accepted commit/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...target,
      target_prepared_status: "bound"
    }, undefined, { allowMissingRevision: true }),
    /target_prepared_status/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...target,
      target_prepared_last_transition_id: "some-other-transfer"
    }, undefined, { allowMissingRevision: true }),
    /fenced by its transfer id/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...target,
      target_prepared_binding_token: managedSessionBindingToken({
        session_id: target.target_session_id,
        status: "bound",
        binding: target.target_before_binding
      })
    }, undefined, { allowMissingRevision: true }),
    /zero-UUID authority/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...target,
      target_prepared_revision: 2
    }, undefined, { allowMissingRevision: true }),
    /create-only fence evidence/u
  );
});

test("schema rejects ineligible source and provisional binding drift", () => {
  const base = prepared();
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...base,
      source_before_binding: {
        ...base.source_before_binding,
        native_process: {
          ...base.source_before_binding.native_process,
          rollout: {
            fd: "7",
            device: "1",
            inode: "400",
            path: "/tmp/source.jsonl"
          }
        }
      }
    }, undefined, { allowMissingRevision: true }),
    /source binding disagrees/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...base,
      source_previous_last_transition_id: "transition-existing"
    }, undefined, { allowMissingRevision: true }),
    /source binding disagrees/u
  );
  const target = targetPrepared().transfer;
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...target,
      target_before_binding: {
        ...target.target_before_binding!,
        native_thread_id: OTHER_UUID
      }
    }, undefined, { allowMissingRevision: true }),
    /zero-UUID authority/u
  );
});

test("schema follows a canonical Herdr resource across route refresh only", () => {
  const bindingAt = ({
    target,
    paneId,
    terminalId = "stable-terminal-1",
    panePid = 100
  }: {
    target: string;
    paneId: string;
    terminalId?: string;
    panePid?: number;
  }): ManagedTerminalBinding => terminalBindingFrom({
    terminalId: `terminal:v2:herdr:codex:${target}:200`,
    terminalControl: {
      ...terminalControl,
      target,
      paneId,
      terminalId,
      panePid
    },
    pid: 200,
    nativeThreadId: SOURCE_UUID,
    processUuid: "codex-pid:200:birth:fixture",
    processBirth: "fixture",
    evidence: "codex_status_card+process_birth",
    generation: 1,
    now: new Date(T0)
  });
  const current = bindingAt({ target: "workspace:0.0", paneId: "p0" });
  const previousRoute = bindingAt({
    target: "workspace:0.1",
    paneId: "p1"
  });
  const transfer = {
    ...prepared(),
    terminal_id: current.terminal_id,
    terminal_endpoint: current.terminal_endpoint!,
    source_before_binding: previousRoute,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-status-card",
      status: "bound",
      binding: previousRoute
    })
  };

  assertValid(transfer);

  for (const incompatible of [
    bindingAt({
      target: "workspace:0.1",
      paneId: "p1",
      terminalId: "different-stable-terminal"
    }),
    bindingAt({
      target: "workspace:0.1",
      paneId: "p1",
      panePid: 101
    })
  ]) {
    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...transfer,
        source_before_binding: incompatible,
        source_binding_token: managedSessionBindingToken({
          session_id: "session-status-card",
          status: "bound",
          binding: incompatible
        })
      }, undefined, { allowMissingRevision: true }),
      /source binding disagrees/u
    );
  }
});

test("version 2 freezes exact rollout-backed source history while version 1 remains readable", () => {
  assertValid(prepared());
  const candidate = candidatePrepared();
  assertValid(candidate);
  assert.equal(candidate.source_kind, "candidate_rollout_quiescent");
  assert.equal(candidate.source_turn_history?.length, 1);
  assert.equal(candidate.source_rollout_authority, undefined);

  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...candidate,
      source_turn_history: candidate.source_turn_history?.map((turn) => ({
        ...turn,
        turn_fingerprint: "not-a-fingerprint"
      }))
    }, undefined, { allowMissingRevision: true }),
    /Turn history is invalid/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...candidate,
      source_kind: "status_card_only",
      source_turn_history: undefined
    }, undefined, { allowMissingRevision: true }),
    /source binding disagrees/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...prepared(),
      version: 1,
      source_kind: "candidate_rollout_quiescent",
      source_turn_history: []
    }, undefined, { allowMissingRevision: true }),
    /source kind is invalid/u
  );
});

test("explicit predecessor abandonment is paired, resolved, and immutable", () => {
  const explicit = abandonedPredecessorPrepared();
  assertValid(explicit);
  assertValid({
    ...candidatePrepared(),
    source_rollout_authority: "present"
  });

  for (const candidate of [
    {
      ...explicit,
      source_abandonment_fingerprint: undefined
    },
    {
      ...explicit,
      source_abandonment_fingerprint: "not-a-fingerprint"
    },
    {
      ...explicit,
      previous_dispatch_status: "none" as const
    },
    {
      ...explicit,
      source_turn_history: []
    },
    {
      ...explicit,
      source_turn_history: explicit.source_turn_history?.map((turn) => ({
        ...turn,
        status: "idle" as const
      }))
    }
  ]) {
    assert.throws(
      () => assertDeferredForegroundTransfer(candidate, undefined, {
        allowMissingRevision: true
      }),
      /exact resolved abandonment authority/u
    );
  }
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...candidatePrepared(),
      source_rollout_authority: "present",
      source_abandonment_fingerprint: createHash("sha256")
        .update("not valid for present authority")
        .digest("hex")
    }, undefined, { allowMissingRevision: true }),
    /present deferred source rollout cannot carry abandonment authority/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...candidatePrepared(),
      source_rollout_authority: "unknown"
    }, undefined, { allowMissingRevision: true }),
    /source rollout authority is invalid/u
  );
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...prepared(),
      version: 2,
      source_kind: "status_card_only",
      source_rollout_authority: "explicitly_abandoned_predecessor",
      source_abandonment_fingerprint: createHash("sha256")
        .update("status cards cannot retire rollout predecessors")
        .digest("hex")
    }, undefined, { allowMissingRevision: true }),
    /source rollout authority is invalid/u
  );

  const sandbox = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-deferred-abandoned-predecessor-"
  ));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, explicit, {
      expectedRevision: null
    });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...sourceReserved(created),
        source_abandonment_fingerprint: createHash("sha256")
          .update("changed abandonment authority")
          .digest("hex"),
        revision: created.revision
      }, { expectedRevision: 1 }),
      /cannot change immutable source_abandonment_fingerprint/u
    );
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...sourceReserved(created),
        source_rollout_authority: "present",
        source_abandonment_fingerprint: undefined,
        revision: created.revision
      }, { expectedRevision: 1 }),
      /cannot change immutable source_rollout_authority/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("candidate source history authority is immutable across CAS advances", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-candidate-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, candidatePrepared(), {
      expectedRevision: null
    });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...sourceReserved(created),
        source_turn_history: created.source_turn_history?.map((turn) => ({
          ...turn,
          updated_at: T1
        })),
        revision: created.revision
      }, { expectedRevision: 1 }),
      /cannot change immutable source_turn_history/u
    );
    const loaded = loadDeferredForegroundTransfer(
      storeDir,
      created.transfer_id
    );
    assert.equal(loaded.version, 2);
    assert.deepEqual(loaded.source_turn_history, created.source_turn_history);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("CAS preserves a different-UUID commit and exact resolved evidence", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-transfer-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
      expectedRevision: null
    });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...sourceReserved(created),
        previous_dispatch_status: "resolved",
        previous_dispatch_fingerprint: createHash("sha256")
          .update("changed previous terminal dispatch")
          .digest("hex"),
        revision: created.revision
      }, { expectedRevision: 1 }),
      /cannot change immutable previous_dispatch_status/u
    );
    const reserved = saveDeferredForegroundTransfer(storeDir, {
      ...sourceReserved(created),
      revision: created.revision
    }, { expectedRevision: 1 });
    const targetFixture = targetPrepared(reserved);
    const target = targetFixture.transfer;
    const targetSaved = saveDeferredForegroundTransfer(storeDir, {
      ...target,
      revision: reserved.revision
    }, { expectedRevision: 2 });
    const dispatch = saveDeferredForegroundTransfer(storeDir, {
      ...targetSaved,
      status: "dispatch_started",
      input_stage: "dispatch_started",
      dispatch_started_at: T3
    }, { expectedRevision: 3 });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...dispatch,
        input_stage: "text_injected",
        dispatch_started_at: T4,
        text_injected_at: T4
      }, { expectedRevision: 4 }),
      /cannot change dispatch_started_at/u
    );
    const text = saveDeferredForegroundTransfer(storeDir, {
      ...dispatch,
      input_stage: "text_injected",
      text_injected_at: T4
    }, { expectedRevision: 4 });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...text,
        input_stage: "dispatch_started",
        text_injected_at: undefined
      }, { expectedRevision: 5 }),
      /input proof cannot regress/u
    );
    const enter = saveDeferredForegroundTransfer(storeDir, {
      ...text,
      input_stage: "enter_dispatched",
      enter_dispatched_at: T5
    }, { expectedRevision: 5 });
    const commitCandidate = committed(OTHER_UUID, {}, {
      transfer: enter,
      pair: targetFixture.pair
    });
    const commit = saveDeferredForegroundTransfer(storeDir, {
      ...commitCandidate,
      revision: enter.revision
    }, { expectedRevision: 6 });
    const resolvedCandidate = resolved(OTHER_UUID, commit);
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...resolvedCandidate,
        committed_at: T7,
        resolved_at: T8,
        revision: commit.revision
      }, { expectedRevision: 7 }),
      /cannot change committed_at/u
    );
    const final = saveDeferredForegroundTransfer(storeDir, {
      ...resolvedCandidate,
      revision: commit.revision
    }, { expectedRevision: 7 });

    assert.equal(final.revision, 8);
    assert.equal(final.status, "resolved");
    assert.deepEqual(final.source_after_binding, final.source_before_binding);
    assert.deepEqual(
      listDeferredForegroundTransfers(storeDir).map((item) => item.transfer_id),
      [created.transfer_id]
    );
    assert.equal(
      loadDeferredForegroundTransfer(storeDir, created.transfer_id).status,
      "resolved"
    );
    const statePath = pathsForDeferredForegroundTransfer(
      created.transfer_id,
      storeDir
    ).statePath;
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...final,
        target_after_revision: 4
      }),
      /revision\/status evidence is invalid/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("submission retry evidence advances monotonically on the original deferred message", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-retry-"));
  try {
    for (const mode of ["exact_draft_enter", "replacement_send"] as const) {
      const storeDir = path.join(sandbox, mode);
      const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
        expectedRevision: null
      });
      const reserved = saveDeferredForegroundTransfer(storeDir, {
        ...sourceReserved(created),
        revision: created.revision
      }, { expectedRevision: 1 });
      const targetFixture = targetPrepared(reserved);
      const target = saveDeferredForegroundTransfer(storeDir, {
        ...targetFixture.transfer,
        revision: reserved.revision
      }, { expectedRevision: 2 });
      let current = saveDeferredForegroundTransfer(storeDir, {
        ...target,
        status: "uncertain",
        input_stage: "text_injected",
        dispatch_started_at: T3,
        text_injected_at: T4,
        uncertain_at: T4,
        do_not_retry: true,
        error: "original Enter was not attempted"
      }, { expectedRevision: 3 });
      current = saveDeferredForegroundTransfer(storeDir, {
        ...current,
        submission_retry_attempt_id: `retry-${mode}`,
        submission_retry_mode: mode,
        submission_retry_message_id: current.message_id,
        submission_retry_prepared_at: current.prepared_at
      }, { expectedRevision: current.revision as number });
      if (mode === "replacement_send") {
        current = saveDeferredForegroundTransfer(storeDir, {
          ...current,
          submission_retry_text_reserved_at: T5
        }, { expectedRevision: current.revision as number });
        current = saveDeferredForegroundTransfer(storeDir, {
          ...current,
          submission_retry_text_injected_at: T6
        }, { expectedRevision: current.revision as number });
      }
      current = saveDeferredForegroundTransfer(storeDir, {
        ...current,
        submission_retry_enter_reserved_at: T7
      }, { expectedRevision: current.revision as number });
      current = saveDeferredForegroundTransfer(storeDir, {
        ...current,
        input_stage: "enter_dispatched",
        enter_dispatched_at: T8,
        submission_retry_enter_dispatched_at: T8
      }, { expectedRevision: current.revision as number });
      assert.equal(
        isDeferredForegroundSubmissionRetryPending(current),
        true,
        mode
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("same-UUID retirement requires a generation+1 scrubbed source binding", () => {
  const same = resolved(SOURCE_UUID);
  assertValid(same);
  assert.notEqual(
    same.source_pre_retirement_binding?.binding_id,
    same.source_before_binding.binding_id
  );
  assert.equal(
    same.source_pre_retirement_binding?.generation,
    same.source_before_binding.generation + 1
  );
  assert.equal(same.source_pre_retirement_binding?.native_thread_id, undefined);
  assert.equal(
    same.source_pre_retirement_binding?.native_process.rollout,
    undefined
  );

  const retained = sourceBinding();
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...same,
      source_retirement: "binding_retained",
      source_pre_retirement_revision: 2,
      source_pre_retirement_binding: retained,
      source_pre_retirement_binding_token: managedSessionBindingToken({
        session_id: same.source_session_id,
        status: "transitioning",
        binding: retained
      }),
      source_after_binding: retained,
      source_after_revision: 3,
      source_after_binding_token: managedSessionBindingToken({
        session_id: same.source_session_id,
        status: "detached",
        binding: retained
      })
    }, undefined, { allowMissingRevision: true }),
    /committed authority/u
  );
  const different = resolved();
  assert.throws(
    () => assertDeferredForegroundTransfer({
      ...different,
      source_pre_retirement_binding: scrubbedSourceBinding(
        different.source_before_binding
      )
    }, undefined, { allowMissingRevision: true }),
    /committed authority/u
  );
});

test("uncertain direct-from-target recovery is monotonic and never rewrites proof", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-uncertain-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
      expectedRevision: null
    });
    const reserved = saveDeferredForegroundTransfer(storeDir, {
      ...sourceReserved(created),
      revision: created.revision
    }, { expectedRevision: 1 });
    const targetFixture = targetPrepared(reserved);
    const target = saveDeferredForegroundTransfer(storeDir, {
      ...targetFixture.transfer,
      revision: reserved.revision
    }, { expectedRevision: 2 });
    const uncertain = saveDeferredForegroundTransfer(storeDir, {
      ...target,
      status: "uncertain",
      input_stage: "text_injected",
      dispatch_started_at: T3,
      text_injected_at: T4,
      uncertain_at: T7,
      error: "provider may have mutated the terminal",
      do_not_retry: true
    }, { expectedRevision: 3 });
    const recoveredCandidate = committed(OTHER_UUID, {
      uncertainAt: T7,
      recoveredAt: T9,
      error: uncertain.error
    }, {
      transfer: uncertain,
      pair: targetFixture.pair
    });
    const recovered = saveDeferredForegroundTransfer(storeDir, {
      ...recoveredCandidate,
      revision: uncertain.revision,
      // Exact request acceptance closes the missing submit-stage evidence.
      enter_dispatched_at: T5
    }, { expectedRevision: 4 });
    assert.equal(recovered.status, "committed");
    assert.equal(recovered.uncertain_at, T7);

    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...uncertain,
        uncertain_at: T3
      }),
      /timestamps must be monotonic/u
    );
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...recovered,
        status: "resolved",
        target_after_revision: 3,
        target_after_status: "bound",
        target_after_binding_token: managedSessionBindingToken({
          session_id: recovered.target_session_id,
          status: "bound",
          binding: recovered.target_accepted_binding
        }),
        source_after_revision:
          Number(recovered.source_pre_retirement_revision) + 1,
        source_after_status: "detached",
        source_after_binding: recovered.source_pre_retirement_binding,
        source_after_binding_token: managedSessionBindingToken({
          session_id: recovered.source_session_id,
          status: "detached",
          binding: recovered.source_pre_retirement_binding
        }),
        resolved_at: T10,
        uncertain_at: T8
      }, { expectedRevision: 5 }),
      /cannot change uncertain_at/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("zero-input abort advances from durable intent to self-contained cleanup receipt", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-abort-"));
  const storeDir = path.join(sandbox, "store");
  try {
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...prepared(),
        status: "aborted",
        aborted_at: T1
      }, { expectedRevision: null }),
      /must be created as zero-input prepared/u
    );
    const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
      expectedRevision: null
    });
    const aborted = saveDeferredForegroundTransfer(storeDir, {
      ...created,
      status: "aborted",
      aborted_at: T1,
      error: "pre-input validation failed"
    }, { expectedRevision: 1 });
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.input_stage, "none");
    const cleanup = saveDeferredForegroundTransfer(storeDir, {
      ...aborted,
      status: "abort_resolved",
      abort_cleanup_completed_at: T2,
      abort_source_after_revision: 1,
      abort_source_after_status: "bound",
      abort_source_after_binding_token: aborted.source_binding_token,
      abort_source_after_binding: aborted.source_before_binding,
      abort_target_after_status: "absent"
    }, { expectedRevision: 2 });
    assert.equal(cleanup.status, "abort_resolved");
    assert.equal(cleanup.abort_source_after_revision, 1);
    assert.equal(cleanup.abort_target_after_status, "absent");
    const unpublishedPrepared = saveDeferredForegroundTransfer(storeDir, {
      ...prepared(),
      transfer_id: "deferred-transfer-unpublished-source-reservation",
      target_session_id: "session-provisional-unpublished"
    }, { expectedRevision: null });
    const unpublishedAbort = saveDeferredForegroundTransfer(storeDir, {
      ...unpublishedPrepared,
      status: "aborted",
      aborted_at: T1,
      error: "crashed after source Session CAS"
    }, { expectedRevision: 1 });
    const unpublishedCleanup = saveDeferredForegroundTransfer(storeDir, {
      ...unpublishedAbort,
      status: "abort_resolved",
      abort_cleanup_completed_at: T2,
      // Crash after the source Session reservation CAS but before the transfer
      // could publish source_reserved_at, followed by an exact restore.
      abort_source_after_revision: 3,
      abort_source_after_status: "bound",
      abort_source_after_binding_token: unpublishedAbort.source_binding_token,
      abort_source_after_binding: unpublishedAbort.source_before_binding,
      abort_target_after_status: "absent"
    }, { expectedRevision: 2 });
    assert.equal(unpublishedCleanup.abort_source_after_revision, 3);
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...cleanup,
        status: "prepared",
        aborted_at: undefined,
        abort_cleanup_completed_at: undefined,
        abort_source_after_revision: undefined,
        abort_source_after_status: undefined,
        abort_source_after_binding_token: undefined,
        abort_source_after_binding: undefined,
        abort_target_after_status: undefined,
        error: undefined
      }, { expectedRevision: 3 }),
      /cannot move from abort_resolved to prepared/u
    );
    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...aborted,
        input_stage: "text_injected",
        dispatch_started_at: T1,
        text_injected_at: T1
      }),
      /cannot carry input evidence|zero-input|exact no-input proof/u
    );

    const target = targetPrepared().transfer;
    const targetAbort = {
      ...target,
      status: "aborted" as const,
      aborted_at: T3,
      error: "target preparation failed"
    };
    assertValid(targetAbort);
    assertValid({
      ...targetAbort,
      status: "abort_resolved",
      abort_cleanup_completed_at: T4,
      abort_source_after_revision: 3,
      abort_source_after_status: "bound",
      abort_source_after_binding_token: targetAbort.source_binding_token,
      abort_source_after_binding: targetAbort.source_before_binding,
      abort_target_after_status: "detached",
      abort_target_after_revision: 2,
      abort_target_after_binding_token: managedSessionBindingToken({
        session_id: targetAbort.target_session_id,
        status: "detached",
        binding: targetAbort.target_before_binding
      }),
      abort_target_after_binding: targetAbort.target_before_binding
    });
    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...targetAbort,
        status: "abort_resolved",
        abort_cleanup_completed_at: T4,
        abort_source_after_revision: 3,
        abort_source_after_status: "bound",
        abort_source_after_binding_token: targetAbort.source_binding_token,
        abort_source_after_binding: targetAbort.source_before_binding,
        abort_target_after_status: "detached",
        abort_target_after_revision: 3,
        abort_target_after_binding_token: managedSessionBindingToken({
          session_id: targetAbort.target_session_id,
          status: "detached",
          binding: targetAbort.target_before_binding
        }),
        abort_target_after_binding: targetAbort.target_before_binding
      }, undefined, { allowMissingRevision: true }),
      /target cleanup evidence is invalid/u
    );

    const notStartedPrepared = saveDeferredForegroundTransfer(storeDir, {
      ...prepared(),
      transfer_id: "deferred-transfer-dispatch-intent-not-started",
      target_session_id: "session-provisional-not-started"
    }, { expectedRevision: null });
    const notStartedReserved = saveDeferredForegroundTransfer(storeDir, {
      ...sourceReserved(notStartedPrepared),
      revision: notStartedPrepared.revision
    }, { expectedRevision: 1 });
    const notStartedTargetFixture = targetPrepared(notStartedReserved);
    const notStartedTarget = saveDeferredForegroundTransfer(storeDir, {
      ...notStartedTargetFixture.transfer,
      revision: notStartedReserved.revision
    }, { expectedRevision: 2 });
    const dispatchIntent = saveDeferredForegroundTransfer(storeDir, {
      ...notStartedTarget,
      status: "dispatch_started",
      input_stage: "dispatch_started",
      dispatch_started_at: T3
    }, { expectedRevision: 3 });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...dispatchIntent,
        status: "aborted",
        aborted_at: T4,
        error: "provider proved no input but omitted its durable proof"
      }, { expectedRevision: 4 }),
      /exact no-input proof|not-started proof/u
    );
    const provedNotStarted = saveDeferredForegroundTransfer(storeDir, {
      ...dispatchIntent,
      status: "aborted",
      terminal_input_not_started_at: T4,
      aborted_at: T4,
      error: "provider proved terminal input did not start"
    }, { expectedRevision: 4 });
    assert.equal(provedNotStarted.input_stage, "dispatch_started");
    const provedNotStartedCleanup = saveDeferredForegroundTransfer(storeDir, {
      ...provedNotStarted,
      status: "abort_resolved",
      abort_cleanup_completed_at: T5,
      abort_source_after_revision: 3,
      abort_source_after_status: "bound",
      abort_source_after_binding_token: provedNotStarted.source_binding_token,
      abort_source_after_binding: provedNotStarted.source_before_binding,
      abort_target_after_status: "detached",
      abort_target_after_revision: 2,
      abort_target_after_binding_token: managedSessionBindingToken({
        session_id: provedNotStarted.target_session_id,
        status: "detached",
        binding: provedNotStarted.target_before_binding
      }),
      abort_target_after_binding: provedNotStarted.target_before_binding
    }, { expectedRevision: 5 });
    assert.equal(
      provedNotStartedCleanup.terminal_input_not_started_at,
      T4
    );
    assert.throws(
      () => assertDeferredForegroundTransfer({
        ...provedNotStarted,
        input_stage: "text_injected",
        text_injected_at: T4
      }),
      /not-started proof|exact no-input proof/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("storage and listing fail closed on stale CAS, symlinks, and malformed entries", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-storage-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveDeferredForegroundTransfer(storeDir, prepared(), {
      expectedRevision: null
    });
    assert.throws(
      () => saveDeferredForegroundTransfer(storeDir, {
        ...created,
        status: "aborted",
        aborted_at: T1
      }, { expectedRevision: 2 }),
      (error: unknown) =>
        error instanceof DeferredForegroundTransferConflictError &&
        error.actualRevision === 1
    );

    const paths = pathsForDeferredForegroundTransfer(created.transfer_id, storeDir);
    fs.unlinkSync(paths.statePath);
    fs.symlinkSync("/dev/null", paths.statePath);
    assert.throws(
      () => loadDeferredForegroundTransfer(storeDir, created.transfer_id),
      /regular file/u
    );
    fs.unlinkSync(paths.statePath);
    fs.writeFileSync(paths.statePath, "{not-json", { mode: 0o600 });
    assert.throws(() => listDeferredForegroundTransfers(storeDir), /JSON/u);
    fs.writeFileSync(paths.statePath, JSON.stringify(created), { mode: 0o600 });
    fs.writeFileSync(
      path.join(path.dirname(paths.directory), "unexpected-file"),
      "unexpected",
      { mode: 0o600 }
    );
    assert.throws(
      () => listDeferredForegroundTransfers(storeDir),
      /only real record directories/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

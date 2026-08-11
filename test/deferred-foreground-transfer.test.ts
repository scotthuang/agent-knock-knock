import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertDeferredForegroundTransfer,
  DeferredForegroundTransferConflictError,
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer,
  pathsForDeferredForegroundTransfer,
  saveDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../src/deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedTerminalBinding
} from "../src/managed-session.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";

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

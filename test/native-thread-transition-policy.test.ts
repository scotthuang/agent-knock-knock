import test from "node:test";
import assert from "node:assert/strict";
import {
  decideBindingReconciliation,
  decideNativeThreadTransitionEligibility,
  decideNativeThreadTransitionFailure,
  decideResumeCandidateEligibility,
  decideResumeTargetSession,
  prepareNativeThreadTransition,
  reduceNativeThreadTransitionPhase,
  type DurableNativeThreadTransitionStatus
} from "../src/native-thread-transition-policy.js";
import type { ManagedTerminalBinding } from "../src/managed-session.js";

const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE = {
  native_thread_id: NATIVE_THREAD_ID,
  candidate_token: "candidate-token",
  agent: "codex" as const,
  workspace: "/tmp/workspace",
  resumable: true
};
const SESSION = {
  schema: "agent-knock-knock/session" as const,
  version: 1 as const,
  session_id: "session-source",
  revision: 7,
  agent: "codex" as const,
  workspace: "/tmp/workspace",
  status: "detached" as const,
  lineage: { created_by: "attach" as const },
  created_at: "2026-08-14T00:00:00.000Z",
  updated_at: "2026-08-14T00:00:00.000Z",
  last_transition_id: "transition-old"
};
const AFTER_BINDING: ManagedTerminalBinding = {
  binding_id: "binding-after",
  generation: 1,
  terminal_id: "tmux:codex:akk:0.0:123",
  terminal_control: {
    kind: "tmux",
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 123,
    currentCommand: "codex",
    currentPath: "/tmp/workspace",
    capabilities: ["screen_status", "send_keys", "durable_completion"]
  },
  native_thread_id: "22222222-2222-4222-8222-222222222222",
  native_process: {
    pid: 456,
    process_uuid: "codex-pid:456:birth:after",
    process_birth: "after",
    evidence: "codex_rollout_fd"
  },
  bound_at: "2026-08-14T00:00:03.000Z",
  last_verified_at: "2026-08-14T00:00:03.000Z"
};

test("transition eligibility preserves binding and capability gate priority", () => {
  const supported = {
    operation: "new_thread" as const,
    bindingTokenMatches: true,
    capabilityStatus: "supported" as const,
    newThreadSupported: true,
    resumeExactSupported: true
  };
  assert.deepEqual(decideNativeThreadTransitionEligibility(supported), {
    action: "proceed"
  });
  assert.deepEqual(decideNativeThreadTransitionEligibility({
    ...supported,
    bindingTokenMatches: false,
    capabilityStatus: "unsupported",
    newThreadSupported: false
  }), {
    action: "reject",
    reason: "binding_token_changed"
  });
  for (const capabilityStatus of ["unsupported", "unknown"] as const) {
    assert.deepEqual(decideNativeThreadTransitionEligibility({
      ...supported,
      capabilityStatus
    }), {
      action: "reject",
      reason: "lifecycle_status_not_supported"
    });
  }
  assert.deepEqual(decideNativeThreadTransitionEligibility({
    ...supported,
    newThreadSupported: false
  }), {
    action: "reject",
    reason: "new_thread_not_supported"
  });
  assert.deepEqual(decideNativeThreadTransitionEligibility({
    ...supported,
    operation: "resume_thread",
    resumeExactSupported: false
  }), {
    action: "reject",
    reason: "resume_thread_not_supported"
  });
});

test("resume candidate eligibility preserves discovery validation priority", () => {
  const cases = [
    {
      input: {
        candidate: undefined,
        expectedCandidateToken: "changed"
      },
      expected: { action: "reject", reason: "candidate_not_found" }
    },
    {
      input: {
        candidate: { ...CANDIDATE, resumable: false },
        expectedCandidateToken: "changed"
      },
      expected: { action: "reject", reason: "candidate_not_resumable" }
    },
    {
      input: {
        candidate: CANDIDATE,
        expectedCandidateToken: "changed"
      },
      expected: { action: "reject", reason: "candidate_token_changed" }
    },
    {
      input: {
        candidate: CANDIDATE,
        expectedCandidateToken: "candidate-token"
      },
      expected: { action: "proceed", candidate: CANDIDATE }
    }
  ] as const;
  for (const { input, expected } of cases) {
    assert.deepEqual(decideResumeCandidateEligibility(input), expected);
  }
});

test("resume target Session policy blocks turns before considering stale binding detachment", () => {
  assert.deepEqual(decideResumeTargetSession({
    hasUnresolvedTurn: true,
    loadedSession: { ...SESSION, status: "bound" },
    boundOwnerConclusivelyInactive: true
  }), { action: "reject", reason: "unresolved_turn" });
  assert.deepEqual(decideResumeTargetSession({
    hasUnresolvedTurn: false,
    loadedSession: { ...SESSION, status: "bound" },
    boundOwnerConclusivelyInactive: false
  }), {
    action: "reject",
    reason: "bound_owner_not_conclusively_inactive"
  });
  assert.deepEqual(decideResumeTargetSession({
    hasUnresolvedTurn: false,
    loadedSession: { ...SESSION, status: "bound" },
    boundOwnerConclusivelyInactive: true
  }), { action: "detach_stale_binding" });
  for (const loadedSession of [undefined, SESSION] as const) {
    assert.deepEqual(decideResumeTargetSession({
      hasUnresolvedTurn: false,
      loadedSession,
      boundOwnerConclusivelyInactive: false
    }), { action: "proceed" });
  }
});

test("binding reconciliation permits only explicit detachable conflict classes", () => {
  const cases = [
    ["provisional_orphan", { action: "detach_conflicting_binding" }],
    ["live_external_thread_change", { action: "detach_conflicting_binding" }],
    [
      "stale_process_incarnation",
      { action: "reject", reason: "stale_process_incarnation" }
    ],
    [undefined, { action: "reject", reason: "already_exact" }],
    ["unverifiable", { action: "reject", reason: "unverifiable" }]
  ] as const;
  for (const [conflictKind, expected] of cases) {
    assert.deepEqual(decideBindingReconciliation(conflictKind), expected);
  }
});

test("prepared transition and phase reducer preserve the durable state shape", () => {
  const prepared = prepareNativeThreadTransition({
    transitionId: "transition-1",
    operation: {
      kind: "resume_thread",
      nativeThreadId: "22222222-2222-4222-8222-222222222222"
    },
    terminalId: "tmux:codex:akk:0.0:123",
    agent: "codex",
    workspace: "/tmp/workspace",
    source: { state: SESSION, revision: 7 },
    targetSessionId: "session-target",
    candidateFileIdentity: {
      path: "/tmp/rollout.jsonl",
      device: "1",
      inode: "42"
    },
    beforeIdentity: {
      sessionId: NATIVE_THREAD_ID,
      processUuid: "codex-pid:456:birth:before",
      processBirth: "before",
      evidence: "codex_rollout_fd"
    },
    beforeProcessUuid: "codex-pid:456:birth:before",
    adapterVersion: "0.147.0",
    commandFingerprint: "command-fingerprint",
    dispatcherPid: 999,
    preparedAt: "2026-08-14T00:00:00.000Z"
  });
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.source_session_id, SESSION.session_id);
  assert.equal(prepared.source_expected_revision, 7);
  assert.equal(prepared.source_previous_last_transition_id, "transition-old");
  assert.equal(prepared.target_expected_revision, null);
  assert.equal(
    prepared.target_native_thread_id,
    "22222222-2222-4222-8222-222222222222"
  );
  assert.equal(prepared.before_native_thread_id, NATIVE_THREAD_ID);

  const newPrepared = prepareNativeThreadTransition({
    transitionId: "transition-new",
    operation: { kind: "new_thread" },
    terminalId: "tmux:codex:akk:0.0:123",
    agent: "codex",
    workspace: "/tmp/workspace",
    targetSessionId: "session-target",
    target: {
      state: { ...SESSION, session_id: "session-not-authoritative" },
      revision: 9
    },
    beforeIdentity: {
      sessionId: NATIVE_THREAD_ID,
      processStartedAt: 12345,
      processUuid: "codex-pid:456:birth:before",
      processBirth: "before",
      rollout: {
        fd: "7",
        device: "1",
        inode: "41",
        path: "/tmp/rollout-before.jsonl"
      },
      evidence: "codex_rollout_fd"
    },
    beforeProcessUuid: "codex-pid:456:birth:before",
    beforeBinding: {
      ...AFTER_BINDING,
      binding_id: "binding-before",
      native_thread_id: NATIVE_THREAD_ID,
      native_process: {
        ...AFTER_BINDING.native_process,
        process_uuid: "codex-pid:456:birth:before",
        process_birth: "before",
        rollout: {
          fd: "7",
          device: "1",
          inode: "41",
          path: "/tmp/rollout-before.jsonl"
        }
      }
    },
    adapterVersion: "0.147.0",
    commandFingerprint: "new-command-fingerprint",
    dispatcherPid: 1000,
    preparedAt: "2026-08-14T00:00:10.000Z"
  });
  assert.equal(newPrepared.operation, "new_thread");
  assert.equal(newPrepared.source_session_id, undefined);
  assert.equal(newPrepared.source_expected_revision, undefined);
  assert.equal(newPrepared.target_session_id, "session-target");
  assert.equal(newPrepared.target_expected_revision, 9);
  assert.equal(newPrepared.target_native_thread_id, undefined);
  assert.equal(newPrepared.target_candidate_file_identity, undefined);
  assert.equal(newPrepared.before_process_started_at, 12345);
  assert.equal(newPrepared.before_process_uuid, "codex-pid:456:birth:before");
  assert.equal(newPrepared.before_process_birth, "before");
  assert.equal(newPrepared.before_process_rollout?.inode, "41");
  assert.equal(newPrepared.before_binding?.binding_id, "binding-before");
  assert.equal(newPrepared.adapter_version, "0.147.0");
  assert.equal(newPrepared.command_fingerprint, "new-command-fingerprint");
  assert.equal(newPrepared.dispatcher_pid, 1000);
  assert.equal(newPrepared.prepared_at, "2026-08-14T00:00:10.000Z");

  const dispatching = reduceNativeThreadTransitionPhase(prepared, {
    type: "dispatch_started",
    at: "2026-08-14T00:00:01.000Z"
  });
  const submitted = reduceNativeThreadTransitionPhase(dispatching, {
    type: "submission_recorded",
    at: "2026-08-14T00:00:02.000Z"
  });
  const verified = reduceNativeThreadTransitionPhase(submitted, {
    type: "target_verified",
    at: "2026-08-14T00:00:03.000Z",
    afterBinding: AFTER_BINDING
  });
  const committed = reduceNativeThreadTransitionPhase(verified, {
    type: "commit_recorded",
    at: "2026-08-14T00:00:04.000Z"
  });
  assert.equal(prepared.status, "prepared", "the reducer is immutable");
  assert.equal(dispatching.status, "dispatching");
  assert.equal(dispatching.dispatching_at, "2026-08-14T00:00:01.000Z");
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.submitted_at, "2026-08-14T00:00:02.000Z");
  assert.equal(verified.status, "verified");
  assert.equal(verified.after_binding, AFTER_BINDING);
  assert.equal(verified.verified_at, "2026-08-14T00:00:03.000Z");
  assert.equal(committed.status, "committed");
  assert.equal(committed.committed_at, "2026-08-14T00:00:04.000Z");
  assert.equal(committed.transition_id, prepared.transition_id);
  assert.equal(
    committed.before_process_uuid,
    prepared.before_process_uuid,
    "phase changes preserve immutable authority fields"
  );
  assert.deepEqual(
    committed.target_candidate_file_identity,
    prepared.target_candidate_file_identity
  );

  const aborted = reduceNativeThreadTransitionPhase(prepared, {
    type: "aborted_before_input",
    at: "2026-08-14T00:00:05.000Z",
    error: "input not started"
  });
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.aborted_at, "2026-08-14T00:00:05.000Z");
  assert.equal(aborted.error, "input not started");

  const uncertain = reduceNativeThreadTransitionPhase(submitted, {
    type: "outcome_uncertain",
    at: "2026-08-14T00:00:06.000Z",
    error: "outcome unknown"
  });
  assert.equal(uncertain.status, "uncertain");
  assert.equal(uncertain.uncertain_at, "2026-08-14T00:00:06.000Z");
  assert.equal(uncertain.error, "outcome unknown");
  assert.equal(uncertain.do_not_retry, true);
});

test("failure reducer preserves durable phase priority and no-retry boundary", () => {
  const statuses: DurableNativeThreadTransitionStatus[] = [
    "prepared",
    "dispatching",
    "submitted",
    "uncertain",
    "verified",
    "committed",
    "aborted"
  ];
  for (const durableStatus of statuses) {
    const priority = durableStatus === "committed"
      ? { action: "report_committed_bookkeeping_failure" }
      : durableStatus === "verified"
        ? { action: "require_verified_recovery" }
        : { action: "abort_before_terminal_input" };
    assert.deepEqual(decideNativeThreadTransitionFailure({
      durableStatus,
      inputStarted: false,
      errorProvesInputNotStarted: true
    }), priority, durableStatus);

    const uncertain = durableStatus === "committed"
      ? { action: "report_committed_bookkeeping_failure" }
      : durableStatus === "verified"
        ? { action: "require_verified_recovery" }
        : { action: "mark_uncertain" };
    assert.deepEqual(decideNativeThreadTransitionFailure({
      durableStatus,
      inputStarted: true,
      errorProvesInputNotStarted: true
    }), uncertain, `${durableStatus}: input started`);
    assert.deepEqual(decideNativeThreadTransitionFailure({
      durableStatus,
      inputStarted: false,
      errorProvesInputNotStarted: false
    }), uncertain, `${durableStatus}: input outcome not proven`);
  }
});

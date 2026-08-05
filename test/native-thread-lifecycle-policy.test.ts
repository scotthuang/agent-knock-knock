import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyCodexLifecyclePostcondition,
  codexIdentityVerifiesLifecyclePostcondition,
  evaluateResumeCandidateAvailability,
  isFreshCodexPostProbeScreen
} from "../src/native-thread-lifecycle-policy.js";

const AVAILABLE = {
  hasCandidateToken: true,
  current: false,
  activeElsewhere: false,
  activeOwnershipUnverifiable: false,
  managedSessionCount: 0,
  managedSessionWorkspaceMatches: undefined,
  archived: false
};

test("resume candidate policy permits unowned, detached, or conclusively inactive bound histories", () => {
  assert.deepEqual(evaluateResumeCandidateAvailability(AVAILABLE), {
    resumable: true
  });
  assert.deepEqual(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    managedSessionCount: 1,
    managedSessionStatus: "detached",
    managedSessionWorkspaceMatches: true
  }), { resumable: true });
  assert.deepEqual(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    managedSessionCount: 1,
    managedSessionStatus: "bound",
    managedSessionBindingInactive: true,
    managedSessionWorkspaceMatches: true
  }), { resumable: true });

  for (const status of ["bound", "transitioning", "quarantined"] as const) {
    assert.deepEqual(evaluateResumeCandidateAvailability({
      ...AVAILABLE,
      managedSessionCount: 1,
      managedSessionStatus: status,
      managedSessionWorkspaceMatches: true
    }), {
      resumable: false,
      unavailableReason: `managed_session_${status}`
    });
  }
});

test("resume candidate policy fails closed for unknown or conflicting ownership", () => {
  assert.equal(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    activeOwnershipUnverifiable: true
  }).unavailableReason, "active_thread_ownership_unverifiable");
  assert.equal(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    activeElsewhere: true
  }).unavailableReason, "active_in_another_process");
  assert.equal(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    managedSessionCount: 2
  }).unavailableReason, "multiple_managed_sessions_reference_this_native_thread");
  assert.equal(evaluateResumeCandidateAvailability({
    ...AVAILABLE,
    managedSessionCount: 1,
    managedSessionStatus: "detached",
    managedSessionWorkspaceMatches: false
  }).unavailableReason, "managed_session_workspace_mismatch");
});

test("Codex lifecycle identity postcondition distinguishes errors, virgin clear, and exact resume", () => {
  const nativeThreadId = "22222222-2222-4222-8222-222222222222";
  const strongIdentity = {
    sessionId: nativeThreadId,
    processUuid: "codex-pid:7200:birth:now",
    processBirth: "now",
    rollout: {
      fd: "12u",
      device: "1,18",
      inode: "42",
      path: "/safe/sessions/rollout.jsonl"
    }
  };
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: nativeThreadId,
    observationSucceeded: true
  }), true);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: nativeThreadId,
    observationSucceeded: false
  }), false);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: "partial",
    observationSucceeded: true
  }), false);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "resume_thread",
    parsedNativeThreadId: nativeThreadId,
    observationSucceeded: true
  }), false);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "resume_thread",
    parsedNativeThreadId: nativeThreadId,
    observationSucceeded: true,
    observedIdentity: { sessionId: nativeThreadId }
  }), false);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "resume_thread",
    parsedNativeThreadId: nativeThreadId,
    observationSucceeded: true,
    observedIdentity: strongIdentity
  }), true);
  assert.equal(codexIdentityVerifiesLifecyclePostcondition({
    operation: "resume_thread",
    parsedNativeThreadId: "33333333-3333-4333-8333-333333333333",
    observationSucceeded: true,
    observedIdentity: strongIdentity
  }), false);
});

test("Codex new-thread accepts an exact lingering before rollout without rebinding it", () => {
  const beforeIdentity = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    processUuid: "codex-pid:7200:birth:now",
    processBirth: "now",
    rollout: {
      fd: "12u",
      device: "1,18",
      inode: "41",
      path: "/safe/sessions/rollout-before.jsonl"
    }
  };
  const afterId = "22222222-2222-4222-8222-222222222222";
  assert.equal(classifyCodexLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: afterId,
    observationSucceeded: true,
    beforeIdentity,
    observedIdentity: beforeIdentity
  }), "lingering_before");
  assert.equal(classifyCodexLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: afterId,
    observationSucceeded: true,
    beforeIdentity
  }), "no_rollout");
  assert.equal(classifyCodexLifecyclePostcondition({
    operation: "resume_thread",
    parsedNativeThreadId: afterId,
    observationSucceeded: true,
    beforeIdentity,
    observedIdentity: beforeIdentity
  }), "invalid");
  assert.equal(classifyCodexLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: afterId,
    observationSucceeded: true,
    beforeIdentity,
    observedIdentity: {
      ...beforeIdentity,
      rollout: { ...beforeIdentity.rollout, inode: "changed" }
    }
  }), "invalid");
  assert.equal(classifyCodexLifecyclePostcondition({
    operation: "new_thread",
    parsedNativeThreadId: afterId,
    observationSucceeded: true,
    beforeIdentity,
    observedIdentity: {
      ...beforeIdentity,
      processBirth: "reused-pid"
    }
  }), "invalid");
});

test("Codex status postcondition requires a screen change after the probe", () => {
  assert.equal(isFreshCodexPostProbeScreen({
    probeSent: false,
    screenDigest: "after",
    postProbeBaselineDigest: "before"
  }), false);
  assert.equal(isFreshCodexPostProbeScreen({
    probeSent: true,
    screenDigest: "before",
    postProbeBaselineDigest: "before"
  }), false);
  assert.equal(isFreshCodexPostProbeScreen({
    probeSent: true,
    screenDigest: "after",
    postProbeBaselineDigest: "before"
  }), true);
});

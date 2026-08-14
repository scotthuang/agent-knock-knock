import test from "node:test";
import assert from "node:assert/strict";
import type {
  ManagedSessionState,
  ManagedTerminalBinding,
  NativeThreadTransition,
  NativeThreadTransitionStatus
} from "../src/managed-session.js";
import {
  canonicalMutationResource,
  withCanonicalMutationLocks,
  type CanonicalMutationResources,
  type CanonicalMutationScopes
} from "../src/mutation-transaction.js";
import {
  settleFailedNativeThreadTransition,
  settleVerifiedNativeThreadTransition,
  type NativeThreadTransitionSettlementPorts
} from "../src/native-thread-transition-settlement-service.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const BEFORE_THREAD = "11111111-1111-4111-8111-111111111111";
const AFTER_THREAD = "22222222-2222-4222-8222-222222222222";
const TRANSITION_ID = "transition-settlement-direct";
const TERMINAL_CONTROL = {
  kind: "tmux" as const,
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 100,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys", "durable_completion"]
} satisfies TerminalControlRef;
const AFTER_IDENTITY = {
  sessionId: AFTER_THREAD,
  processUuid: "codex-pid:200:birth:after",
  processBirth: "after",
  rollout: {
    fd: "7",
    device: "1",
    inode: "2",
    path: "/workspace/project/rollout.jsonl"
  },
  evidence: "codex_status_card+rollout_fd"
};
const AFTER_BINDING: ManagedTerminalBinding = {
  binding_id: "binding-after",
  generation: 1,
  terminal_id: "terminal:v2:fixture",
  terminal_control: TERMINAL_CONTROL,
  native_thread_id: AFTER_THREAD,
  native_process: {
    pid: 200,
    process_uuid: AFTER_IDENTITY.processUuid,
    process_birth: AFTER_IDENTITY.processBirth,
    rollout: AFTER_IDENTITY.rollout,
    evidence: AFTER_IDENTITY.evidence
  },
  bound_at: "2026-08-15T00:00:01.000Z",
  last_verified_at: "2026-08-15T00:00:01.000Z"
};
const SOURCE_BEFORE: ManagedSessionState = {
  schema: "agent-knock-knock/session",
  version: 1,
  session_id: "session-source",
  revision: 1,
  agent: "codex",
  workspace: "/workspace/project",
  status: "bound",
  binding: {
    ...AFTER_BINDING,
    binding_id: "binding-before",
    native_thread_id: BEFORE_THREAD
  },
  lineage: { created_by: "attach" },
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  last_transition_id: "transition-before"
};
const SOURCE_TRANSITIONING: ManagedSessionState = {
  ...SOURCE_BEFORE,
  revision: 2,
  status: "transitioning",
  updated_at: "2026-08-15T00:00:01.000Z",
  last_transition_id: TRANSITION_ID
};
const COMMITTED_TARGET: ManagedSessionState = {
  ...SOURCE_BEFORE,
  session_id: "session-target",
  revision: 1,
  binding: AFTER_BINDING,
  lineage: {
    created_by: "new_thread",
    previous_session_id: SOURCE_BEFORE.session_id,
    transition_id: TRANSITION_ID
  },
  updated_at: "2026-08-15T00:00:02.000Z",
  last_transition_id: TRANSITION_ID
};

function transition(
  status: NativeThreadTransitionStatus
): NativeThreadTransition {
  return {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: TRANSITION_ID,
    revision: 3,
    operation: "new_thread",
    status,
    terminal_id: "terminal:v2:fixture",
    agent: "codex",
    workspace: "/workspace/project",
    source_session_id: SOURCE_BEFORE.session_id,
    source_expected_revision: 1,
    source_previous_last_transition_id: "transition-before",
    target_session_id: COMMITTED_TARGET.session_id,
    target_expected_revision: null,
    before_native_thread_id: BEFORE_THREAD,
    before_process_uuid: "codex-pid:200:birth:before",
    before_process_birth: "before",
    adapter_version: "0.146.0",
    command_fingerprint: "command-fingerprint",
    dispatcher_pid: 999,
    prepared_at: "2026-08-15T00:00:00.000Z",
    ...(status === "verified" || status === "committed"
      ? {
          after_binding: AFTER_BINDING,
          verified_at: "2026-08-15T00:00:01.000Z"
        }
      : {}),
    ...(status === "committed"
      ? { committed_at: "2026-08-15T00:00:02.000Z" }
      : {})
  };
}

type RecordingOptions = Readonly<{
  durable: NativeThreadTransition;
  events: string[];
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  times: readonly string[];
  inputNotStartedError?: unknown;
  onPresent?: (status: string) => void;
}>;

function recordingPorts(options: RecordingOptions): {
  ports: NativeThreadTransitionSettlementPorts;
  scopedOperations: () => number;
} {
  const times = [...options.times];
  let scopedOperations = 0;
  const scoped = (
    actualScopes: CanonicalMutationScopes,
    actualResources: CanonicalMutationResources
  ) => {
    assert.equal(actualScopes, options.scopes);
    assert.equal(actualResources, options.resources);
    scopedOperations += 1;
  };
  const ports: NativeThreadTransitionSettlementPorts = {
    persistence: {
      saveLedger: (
        scopes,
        resources,
        _value,
        phase,
        expectation
      ) => {
        scoped(scopes, resources);
        assert.equal(expectation.expectedTransitionId, TRANSITION_ID);
        options.events.push(`ledger:build:${phase.phase}`);
        const document = {
          status: phase.phase === "command_resolved" || phase.phase === "resolved"
            ? "resolved"
            : "uncertain",
          phase: phase.phase
        };
        options.events.push(`ledger:save:${String(document.status)}`);
      },
      loadTransition: (scopes, resources, transitionId) => {
        scoped(scopes, resources);
        assert.equal(transitionId, TRANSITION_ID);
        options.events.push(`transition:load:${options.durable.status}`);
        return options.durable;
      },
      saveTransition: (scopes, resources, value, expectation) => {
        scoped(scopes, resources);
        assert.equal(expectation.expectedRevision, value.revision);
        options.events.push(`transition:save:${value.status}`);
        return { ...value, revision: (value.revision ?? 0) + 1 };
      },
      saveSession: (scopes, resources, value, expectation) => {
        scoped(scopes, resources);
        assert.equal(expectation.expectedRevision, value.revision ?? null);
        options.events.push(`session:save:${value.status}`);
        return { ...value, revision: (value.revision ?? 0) + 1 };
      },
      commitVerified: (scopes, resources, value, verifiedAt) => {
        scoped(scopes, resources);
        assert.equal(value.status, "verified");
        assert.equal(verifiedAt, "2026-08-15T00:00:01.000Z");
        options.events.push("session:commit:verified");
        return COMMITTED_TARGET;
      }
    },
    effects: {
      finalizeIdentity: () => {
        options.events.push("identity:finalize");
        return { identity: AFTER_IDENTITY, binding: AFTER_BINDING };
      },
      assertTargetOwnership: async (scopes, resources) => {
        scoped(scopes, resources);
        options.events.push("ownership:assert");
      },
      targetConflictWorkspace: () => {
        options.events.push("conflict:workspace");
        return "/workspace/project";
      }
    },
    runtime: {
      now: () => {
        options.events.push("clock");
        const value = times.shift();
        assert.ok(value, "the test must provide every settlement clock value");
        return new Date(value);
      },
      crashAfterVerified: () => {
        options.events.push("crash:after-verified");
      },
      injectTargetConflict: () => {
        options.events.push("conflict:check");
        return false;
      },
      errorProvesInputNotStarted: (error) => {
        options.events.push("input:not-started:classify");
        return error === options.inputNotStartedError;
      },
      summarizeError: (message) => {
        options.events.push("error:summarize");
        return { length: message.length };
      }
    },
    verification: async (scopes, resources) => {
      scoped(scopes, resources);
      options.events.push("identity:verify");
      return AFTER_IDENTITY;
    },
    present: (result) => {
      options.events.push(`present:${result.status}`);
      options.onPresent?.(result.status);
    }
  };
  return { ports, scopedOperations: () => scopedOperations };
}

test("verified settlement preserves scoped commit order and presents before lock release", async () => {
  const events: string[] = [];
  let terminalHeld = false;
  let writerHeld = false;
  const resources = {
    terminal: canonicalMutationResource("terminal:v2:fixture", TERMINAL_CONTROL),
    storeWriter: canonicalMutationResource("/workspace/store", "/workspace/store")
  };
  await withCanonicalMutationLocks({
    resources,
    acquireTerminal: () => {
      terminalHeld = true;
      events.push("lock:terminal:acquire");
      return () => {
        terminalHeld = false;
        events.push("lock:terminal:release");
      };
    },
    withStoreWriter: async (operation) => {
      writerHeld = true;
      events.push("lock:writer:acquire");
      try {
        return await operation();
      } finally {
        writerHeld = false;
        events.push("lock:writer:release");
      }
    }
  }, async (scopes, transactionResources) => {
    const recording = recordingPorts({
      durable: transition("submitted"),
      events,
      scopes,
      resources: transactionResources,
      times: [
        "2026-08-15T00:00:01.000Z",
        "2026-08-15T00:00:02.000Z"
      ],
      onPresent: () => {
        assert.equal(terminalHeld, true);
        assert.equal(writerHeld, true);
      }
    });
    await settleVerifiedNativeThreadTransition({
      transition: transition("submitted"),
      verification: {
        operation: { kind: "new_thread" },
        plan: {
          operation: { kind: "new_thread" },
          behaviorProfile: "fixture",
          steps: [],
          command: "/clear",
          expectedResult: { kind: "different_native_thread" }
        }
      }
    }, scopes, transactionResources, recording.ports);
    assert.equal(recording.scopedOperations(), 6);
  });
  assert.deepEqual(events, [
    "lock:terminal:acquire",
    "lock:writer:acquire",
    "identity:verify",
    "clock",
    "identity:finalize",
    "transition:save:verified",
    "crash:after-verified",
    "ownership:assert",
    "conflict:check",
    "session:commit:verified",
    "clock",
    "transition:save:committed",
    "ledger:build:command_resolved",
    "ledger:save:resolved",
    "present:committed",
    "lock:writer:release",
    "lock:terminal:release"
  ]);
});

test("verified failure records recovery-required without rolling forward", async () => {
  const events: string[] = [];
  const scopes = Object.freeze({}) as CanonicalMutationScopes;
  const resources = Object.freeze({}) as CanonicalMutationResources;
  const recording = recordingPorts({
    durable: transition("verified"),
    events,
    scopes,
    resources,
    times: ["2026-08-15T00:00:03.000Z"]
  });
  await settleFailedNativeThreadTransition({
    transitionId: TRANSITION_ID,
    inputStarted: true
  }, new Error("commit interrupted"), scopes, resources, recording.ports);
  assert.equal(recording.scopedOperations(), 2);
  assert.deepEqual(events, [
    "clock",
    "transition:load:verified",
    "input:not-started:classify",
    "error:summarize",
    "ledger:build:uncertain_reason_error",
    "ledger:save:uncertain",
    "present:verified_recovery_required"
  ]);
});

test("zero-input failure aborts and restores the source Session before rethrow", async () => {
  const events: string[] = [];
  const scopes = Object.freeze({}) as CanonicalMutationScopes;
  const resources = Object.freeze({}) as CanonicalMutationResources;
  const inputNotStarted = new Error("composer changed before text");
  const recording = recordingPorts({
    durable: transition("dispatching"),
    events,
    scopes,
    resources,
    times: ["2026-08-15T00:00:03.000Z"],
    inputNotStartedError: inputNotStarted
  });
  await assert.rejects(
    settleFailedNativeThreadTransition({
      transitionId: TRANSITION_ID,
      inputStarted: false,
      sourceBefore: SOURCE_BEFORE,
      sourceTransitioning: SOURCE_TRANSITIONING
    }, inputNotStarted, scopes, resources, recording.ports),
    (error: unknown) => error === inputNotStarted
  );
  assert.equal(recording.scopedOperations(), 4);
  assert.deepEqual(events, [
    "clock",
    "transition:load:dispatching",
    "input:not-started:classify",
    "transition:save:aborted",
    "session:save:bound",
    "ledger:build:resolved",
    "ledger:save:resolved"
  ]);
});

test("possible-input failure becomes uncertain and quarantines the source", async () => {
  const events: string[] = [];
  const scopes = Object.freeze({}) as CanonicalMutationScopes;
  const resources = Object.freeze({}) as CanonicalMutationResources;
  const recording = recordingPorts({
    durable: transition("submitted"),
    events,
    scopes,
    resources,
    times: ["2026-08-15T00:00:03.000Z"]
  });
  await settleFailedNativeThreadTransition({
    transitionId: TRANSITION_ID,
    inputStarted: true,
    sourceBefore: SOURCE_BEFORE,
    sourceTransitioning: SOURCE_TRANSITIONING
  }, new Error("verification unavailable"), scopes, resources, recording.ports);
  assert.equal(recording.scopedOperations(), 4);
  assert.deepEqual(events, [
    "clock",
    "transition:load:submitted",
    "input:not-started:classify",
    "transition:save:uncertain",
    "session:save:quarantined",
    "error:summarize",
    "ledger:build:uncertain_error_reason",
    "ledger:save:uncertain",
    "present:uncertain"
  ]);
});

test("committed transition preserves bookkeeping error precedence", async () => {
  const events: string[] = [];
  const scopes = Object.freeze({}) as CanonicalMutationScopes;
  const resources = Object.freeze({}) as CanonicalMutationResources;
  const recording = recordingPorts({
    durable: transition("committed"),
    events,
    scopes,
    resources,
    times: ["2026-08-15T00:00:03.000Z"]
  });
  await assert.rejects(
    settleFailedNativeThreadTransition({
      transitionId: TRANSITION_ID,
      inputStarted: true
    }, new Error("stdout closed"), scopes, resources, recording.ports),
    /committed, but final bookkeeping failed: stdout closed/u
  );
  assert.equal(recording.scopedOperations(), 1);
  assert.deepEqual(events, [
    "clock",
    "transition:load:committed",
    "input:not-started:classify"
  ]);
});

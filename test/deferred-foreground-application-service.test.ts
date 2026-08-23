import assert from "node:assert/strict";
import test from "node:test";

import {
  DeferredForegroundApplicationService,
  type DeferredForegroundApplicationPorts
} from "../src/deferred-foreground-application-service.js";
import type { DeferredForegroundApplicationScope } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundBindingBoundary } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";

const BOUNDARY = {
  terminal: {
    conversationId: "terminal-1",
    agent: "codex",
    pid: 42,
    workspace: "/workspace",
    target: "terminal-target",
    resourceKey: "terminal-resource",
    canonicalEndpoint: true
  },
  transferId: "transfer-1",
  targetSessionId: "target-1",
  sourceSessionId: "source-1",
  sourceBoundRevision: 3,
  sourceBoundBindingToken: "a".repeat(64),
  processUuid: "process-1",
  processBirth: "birth-1",
  previousDispatchSnapshot: {
    status: "none" as const,
    fingerprint: "b".repeat(64)
  },
  sourceKind: "status_card_only" as const,
  sourceRolloutAuthority: "present" as const
} satisfies DeferredForegroundBindingBoundary;

function transfer(
  status: DeferredForegroundTransfer["status"],
  inputStage: DeferredForegroundTransfer["input_stage"]
): DeferredForegroundTransfer {
  return {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 2,
    transfer_id: BOUNDARY.transferId,
    revision: 7,
    status,
    input_stage: inputStage,
    terminal_id: BOUNDARY.terminal.conversationId,
    terminal_endpoint: {} as DeferredForegroundTransfer["terminal_endpoint"],
    process_pid: BOUNDARY.terminal.pid,
    process_uuid: BOUNDARY.processUuid,
    process_birth: BOUNDARY.processBirth,
    workspace: "/workspace",
    source_session_id: BOUNDARY.sourceSessionId,
    source_expected_revision: BOUNDARY.sourceBoundRevision,
    source_binding_token: BOUNDARY.sourceBoundBindingToken,
    source_before_binding: {} as
      DeferredForegroundTransfer["source_before_binding"],
    source_kind: BOUNDARY.sourceKind,
    target_session_id: BOUNDARY.targetSessionId,
    target_expected_revision: null,
    previous_dispatch_status: BOUNDARY.previousDispatchSnapshot.status,
    previous_dispatch_fingerprint: BOUNDARY.previousDispatchSnapshot.fingerprint,
    request_hash: "c".repeat(64),
    dispatcher_pid: 99,
    prepared_at: "2026-08-15T00:00:00.000Z",
    ...(inputStage === "none"
      ? {}
      : { dispatch_started_at: "2026-08-15T00:00:01.000Z" })
  };
}

function harness(
  initial: DeferredForegroundTransfer,
  additionalTransfers: DeferredForegroundTransfer[] = []
): {
  application: DeferredForegroundApplicationService;
  current(): DeferredForegroundTransfer;
  scope: DeferredForegroundApplicationScope;
  trace: string[];
} {
  const trace: string[] = [];
  let current = initial;
  const scope = {
    assertBoundary: (boundary: DeferredForegroundBindingBoundary) => {
      assert.equal(boundary, BOUNDARY);
      trace.push("capability:boundary");
    },
    terminalMatches: () => {
      trace.push("capability:terminal");
      return true;
    },
    transferMatchesTerminal: (candidate: DeferredForegroundTransfer) =>
      candidate.terminal_id === initial.terminal_id,
    transferBelongsToTurn: () => {
      trace.push("capability:turn");
      return true;
    },
    loadTransfer: (transferId: string) => {
      assert.equal(transferId, BOUNDARY.transferId);
      trace.push("transfer:load");
      return current;
    },
    listTransfers: () => [current, ...additionalTransfers],
    saveTransfer: (
      candidate: DeferredForegroundTransfer,
      expectedRevision: number | null
    ) => {
      assert.equal(expectedRevision, current.revision);
      trace.push(`transfer:save:${String(expectedRevision)}`);
      current = { ...candidate, revision: Number(expectedRevision) + 1 };
      return current;
    }
  } as unknown as DeferredForegroundApplicationScope;
  const clockValues = [
    new Date("2026-08-15T00:00:02.000Z"),
    new Date("2026-08-15T00:00:03.000Z")
  ];
  const ports: DeferredForegroundApplicationPorts = {
    authority: {
      verifyReservedSource: async () => {
        throw new Error("reserved source is not expected");
      },
      assertExclusive: async () => {},
      assertFrozenPredecessor: () => {},
      valuesMatch: (left, right) => JSON.stringify(left) === JSON.stringify(right)
    },
    clock: {
      now: () => {
        trace.push("clock:now");
        return clockValues.shift() ?? new Date("2026-08-15T00:00:04.000Z");
      }
    },
    runtime: {
      crashAt: () => {},
      errorReceipt: (reason) => reason,
      summary: (value) => value,
      log: () => trace.push("runtime:log")
    }
  };
  return {
    application: new DeferredForegroundApplicationService(ports),
    current: () => current,
    scope,
    trace
  };
}

test("uncertain direct transition table preserves revision CAS and clock order", () => {
  for (const fixture of [
    {
      status: "target_prepared" as const,
      stage: "none" as const,
      clockCount: 2,
      expectedStage: "dispatch_started" as const
    },
    {
      status: "dispatch_started" as const,
      stage: "text_injected" as const,
      clockCount: 1,
      expectedStage: "text_injected" as const
    }
  ]) {
    const recording = harness(transfer(fixture.status, fixture.stage));
    const result = recording.application.markUncertain({
      scope: recording.scope,
      boundary: BOUNDARY,
      reason: "acceptance is not exact"
    });
    assert.equal(result.status, "uncertain");
    assert.equal(result.input_stage, fixture.expectedStage);
    assert.equal(result.revision, 8);
    assert.equal(result.do_not_retry, true);
    assert.equal(
      recording.trace.filter((event) => event === "clock:now").length,
      fixture.clockCount
    );
    assert.equal(recording.trace.at(-1), "transfer:save:7");
  }
});

test("possible-input abort rejects before rollback, Session, or transfer writes", () => {
  const recording = harness(transfer("dispatch_started", "text_injected"));
  assert.throws(() => recording.application.abortBeforeInput({
    scope: recording.scope,
    boundary: BOUNDARY,
    reason: "must not retry",
    terminalInputNotStartedAt: "2026-08-15T00:00:02.000Z"
  }), /may have started terminal input and cannot restore its source/u);
  assert.equal(
    recording.trace.some((event) =>
      event.startsWith("transfer:save") || event === "runtime:log"),
    false
  );
});

test("user abandonment rejects ambiguous terminal and foreign source history before intent", () => {
  const target = {
    ...transfer("target_prepared", "none"),
    message_id: "message-1",
    turn_id: "turn-1",
    state_path: "/tmp/turn-1/state.json"
  };
  const request = {
    transferId: target.transfer_id,
    turnId: target.turn_id,
    turnFingerprint: "d".repeat(64),
    requestedAt: "2026-08-15T00:00:02.000Z",
    closeReason: "closed by request",
    ledgerDisposition: "absent" as const,
    ledgerFingerprint: "e".repeat(64)
  };
  const ambiguous = harness(target, [{
    ...target,
    transfer_id: "transfer-2"
  }]);
  assert.throws(() => ambiguous.application.beginUserAbandonment({
    ...request,
    scope: ambiguous.scope
  }), /not the unique nonfinal transfer/u);
  assert.equal(
    ambiguous.trace.some((entry) => entry.startsWith("transfer:save")),
    false
  );

  const foreignSourceOwner = {
    ...target,
    transfer_id: "transfer-source-owner",
    terminal_id: "terminal-2",
    source_kind: "candidate_rollout_quiescent" as const,
    source_turn_history: [{ turn_id: "turn-1" }]
  } as DeferredForegroundTransfer;
  const frozen = harness(target, [foreignSourceOwner]);
  assert.throws(() => frozen.application.beginUserAbandonment({
    ...request,
    scope: frozen.scope
  }), /frozen source history/u);
  assert.equal(
    frozen.trace.some((entry) => entry.startsWith("transfer:save")),
    false
  );

  const crossSession = harness(target, [{
    ...target,
    transfer_id: "transfer-cross-session",
    terminal_id: "terminal-3",
    target_session_id: "target-other",
    source_session_id: target.target_session_id
  }]);
  assert.throws(() => crossSession.application.beginUserAbandonment({
    ...request,
    scope: crossSession.scope
  }), /overlaps Sessions/u);
  assert.equal(
    crossSession.trace.some((entry) => entry.startsWith("transfer:save")),
    false
  );

  const selfHistoryTarget = {
    ...target,
    source_kind: "candidate_rollout_quiescent" as const,
    source_turn_history: [{ turn_id: target.turn_id }]
  } as DeferredForegroundTransfer;
  const selfHistory = harness(selfHistoryTarget);
  assert.throws(() => selfHistory.application.beginUserAbandonment({
    ...request,
    scope: selfHistory.scope
  }), /frozen source history/u);
  assert.equal(
    selfHistory.trace.some((entry) => entry.startsWith("transfer:save")),
    false
  );
});

const ABANDON_CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "%9",
  session: "akk-test",
  window: 1,
  pane: 0,
  socketPath: "/tmp/tmux-abandon.sock",
  panePid: 42,
  currentCommand: "codex",
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys", "durable_completion"]
};

function userAbandonmentHarness(
  status: "target_prepared" | "dispatch_started" | "uncertain" |
    "committed" | "aborted",
  crashOnce?: "user_abandonment_source_released"
): {
  application: DeferredForegroundApplicationService;
  scope: DeferredForegroundApplicationScope;
  transfer(): DeferredForegroundTransfer;
  session(id: string): ManagedSessionState;
  replaceSession(id: string, session: ManagedSessionState): void;
  trace: string[];
} {
  const sourceBinding = terminalBindingFrom({
    terminalId: "terminal-1",
    terminalControl: ABANDON_CONTROL,
    pid: 42,
    nativeThreadId: "11111111-1111-4111-8111-111111111111",
    processUuid: "process-1",
    processBirth: "birth-1",
    evidence: "codex_status_card+process_birth",
    generation: 1,
    now: new Date("2026-08-15T00:00:00.000Z")
  });
  const targetBinding = terminalBindingFrom({
    terminalId: "terminal-1",
    terminalControl: ABANDON_CONTROL,
    pid: 42,
    processUuid: "process-1",
    processBirth: "birth-1",
    evidence: "codex_process_birth",
    generation: 1,
    now: new Date("2026-08-15T00:00:00.000Z")
  });
  let current: DeferredForegroundTransfer = {
    ...transfer(status, status === "target_prepared" ? "none" :
      status === "committed" ? "agent_accepted" : "enter_dispatched"),
    revision: 7,
    source_before_binding: sourceBinding,
    source_binding_token: managedSessionBindingToken({
      session_id: "source-1",
      status: "bound",
      binding: sourceBinding
    }),
    target_prepared_revision: 1,
    target_prepared_status: "transitioning",
    target_prepared_last_transition_id: "transfer-1",
    target_prepared_binding_token: managedSessionBindingToken({
      session_id: "target-1",
      status: "transitioning",
      binding: targetBinding
    }),
    target_before_binding: targetBinding,
    target_prepared_at: "2026-08-15T00:00:01.000Z",
    message_id: "message-1",
    turn_id: "turn-1",
    state_path: "/tmp/turn-1/state.json",
    ...(status === "committed"
      ? {
          source_pre_retirement_revision: 4,
          source_pre_retirement_status: "transitioning" as const,
          source_pre_retirement_binding: sourceBinding,
          source_pre_retirement_binding_token: managedSessionBindingToken({
            session_id: "source-1",
            status: "transitioning",
            binding: sourceBinding
          })
        }
      : {})
  };
  const now = "2026-08-15T00:00:02.000Z";
  const sessions = new Map<string, ManagedSessionState>([
    ["source-1", {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "source-1",
      revision: status === "committed" ? 4 : 4,
      agent: "codex",
      workspace: "/workspace",
      status: "transitioning",
      binding: sourceBinding,
      lineage: { created_by: "attach" },
      last_transition_id: "transfer-1",
      created_at: now,
      updated_at: now
    }],
    ["target-1", {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "target-1",
      revision: 1,
      agent: "codex",
      workspace: "/workspace",
      status: "transitioning",
      binding: targetBinding,
      lineage: {
        created_by: "attach",
        previous_session_id: "source-1",
        transition_id: "transfer-1"
      },
      last_transition_id: "transfer-1",
      created_at: now,
      updated_at: now
    }]
  ]);
  const trace: string[] = [];
  let pendingCrash = crashOnce;
  const scope = {
    loadTransfer: () => current,
    listTransfers: () => [current],
    saveTransfer: (candidate: DeferredForegroundTransfer) => {
      current = { ...candidate, revision: Number(current.revision) + 1 };
      trace.push(`transfer:save:${current.status}`);
      return current;
    },
    loadSession: (id: string) => sessions.get(id)!,
    tryLoadSession: (id: string) => sessions.get(id),
    saveSession: (candidate: ManagedSessionState) => {
      const saved = {
        ...candidate,
        revision: Number(sessions.get(candidate.session_id)?.revision) + 1
      };
      sessions.set(candidate.session_id, saved);
      trace.push(`session:save:${candidate.session_id}:${candidate.status}`);
      return saved;
    },
    transferMatchesTerminal: () => true,
    transferBelongsToTurn: () => true
  } as unknown as DeferredForegroundApplicationScope;
  const application = new DeferredForegroundApplicationService({
    authority: {
      verifyReservedSource: async () => { throw new Error("unused"); },
      assertExclusive: async () => {},
      assertFrozenPredecessor: () => {},
      valuesMatch: (left, right) => JSON.stringify(left) === JSON.stringify(right)
    },
    clock: { now: () => new Date("2026-08-15T00:00:03.000Z") },
    runtime: {
      crashAt: (point) => {
        trace.push(`crash:${point}`);
        if (pendingCrash === point) {
          pendingCrash = undefined;
          throw new Error(`simulated crash at ${point}`);
        }
      },
      errorReceipt: (reason) => reason,
      summary: (value) => value,
      log: () => trace.push("runtime:log")
    }
  });
  return {
    application,
    scope,
    transfer: () => current,
    session: (id) => sessions.get(id)!,
    replaceSession: (id: string, session: ManagedSessionState) =>
      sessions.set(id, session),
    trace
  };
}

test("user abandonment releases exact source and target Sessions for every managed origin", () => {
  for (const status of [
    "target_prepared",
    "dispatch_started",
    "uncertain",
    "committed",
    "aborted"
  ] as const) {
    const recording = userAbandonmentHarness(status);
    const ledgerFingerprint = "e".repeat(64);
    const intent = recording.application.beginUserAbandonment({
      scope: recording.scope,
      transferId: "transfer-1",
      turnId: "turn-1",
      turnFingerprint: "d".repeat(64),
      requestedAt: "2026-08-15T00:00:02.000Z",
      closeReason: "closed by request",
      ledgerDisposition: "absent",
      ledgerFingerprint
    });
    assert.equal(intent.status, "user_abandoning", status);
    const final = recording.application.completeUserAbandonment({
      scope: recording.scope,
      transferId: "transfer-1",
      ledgerDisposition: "absent",
      ledgerFingerprint,
      ensureCloseEvent: () => recording.trace.push("event:before-final"),
      assertCloseEvent: () => {
        throw new Error("final event assertion is not expected before final");
      }
    });
    assert.equal(final.status, "user_abandoned", status);
    assert.equal(recording.session("source-1").status, "detached", status);
    assert.equal(recording.session("target-1").status, "detached", status);
    assert.ok(
      recording.trace.indexOf("event:before-final") <
        recording.trace.indexOf("transfer:save:user_abandoned"),
      status
    );
    const replay = recording.application.completeUserAbandonment({
      scope: recording.scope,
      transferId: "transfer-1",
      ledgerDisposition: "absent",
      ledgerFingerprint,
      ensureCloseEvent: () => {
        throw new Error("final replay must not append its close event");
      },
      assertCloseEvent: () => recording.trace.push("event:final-replay")
    });
    assert.equal(replay.status, "user_abandoned", status);
    assert.equal(recording.trace.at(-1), "event:final-replay", status);
  }
});

test("user abandonment recovers after Session release before final marker", () => {
  const recording = userAbandonmentHarness("uncertain");
  const ledgerFingerprint = "e".repeat(64);
  recording.application.beginUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    turnId: "turn-1",
    turnFingerprint: "d".repeat(64),
    requestedAt: "2026-08-15T00:00:02.000Z",
    closeReason: "closed by request",
    ledgerDisposition: "absent",
    ledgerFingerprint
  });
  assert.throws(() => recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => { throw new Error("crash before final"); },
    assertCloseEvent: () => {
      throw new Error("final event assertion is not expected before final");
    }
  }), /crash before final/u);
  assert.equal(recording.transfer().status, "user_abandoning");
  assert.equal(recording.session("source-1").status, "detached");
  assert.equal(recording.session("target-1").status, "detached");
  const recovered = recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => recording.trace.push("event:ensure"),
    assertCloseEvent: () => {
      throw new Error("final event assertion is not expected before final");
    }
  });
  assert.equal(recovered.status, "user_abandoned");
  assert.equal(recovered.user_abandonment_source_disposition,
    "already_released");
  assert.equal(recovered.user_abandonment_target_disposition,
    "already_released");
});

test("user abandonment recovers after only the source Session was released", () => {
  const recording = userAbandonmentHarness(
    "uncertain",
    "user_abandonment_source_released"
  );
  const ledgerFingerprint = "e".repeat(64);
  recording.application.beginUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    turnId: "turn-1",
    turnFingerprint: "d".repeat(64),
    requestedAt: "2026-08-15T00:00:02.000Z",
    closeReason: "closed by request",
    ledgerDisposition: "absent",
    ledgerFingerprint
  });
  assert.throws(() => recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => recording.trace.push("event:ensure"),
    assertCloseEvent: () => {
      throw new Error("final event assertion is not expected before final");
    }
  }), /simulated crash at user_abandonment_source_released/u);
  assert.equal(recording.transfer().status, "user_abandoning");
  assert.equal(recording.session("source-1").status, "detached");
  assert.equal(recording.session("target-1").status, "transitioning");

  const recovered = recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => recording.trace.push("event:ensure"),
    assertCloseEvent: () => {
      throw new Error("final event assertion is not expected before final");
    }
  });
  assert.equal(recovered.status, "user_abandoned");
  assert.equal(recovered.user_abandonment_source_disposition,
    "already_released");
  assert.equal(recovered.user_abandonment_target_disposition, "detached");
  assert.equal(recording.session("target-1").status, "detached");
});

test("final user abandonment replay fails closed on changed Session receipts", () => {
  const recording = userAbandonmentHarness("uncertain");
  const ledgerFingerprint = "e".repeat(64);
  recording.application.beginUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    turnId: "turn-1",
    turnFingerprint: "d".repeat(64),
    requestedAt: "2026-08-15T00:00:02.000Z",
    closeReason: "closed by request",
    ledgerDisposition: "absent",
    ledgerFingerprint
  });
  recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => recording.trace.push("event:ensure"),
    assertCloseEvent: () => {
      throw new Error("final assertion is not expected before final");
    }
  });
  const source = recording.session("source-1");
  recording.replaceSession("source-1", {
    ...source,
    updated_at: "2026-08-15T00:00:09.000Z"
  });
  const before = [...recording.trace];

  assert.throws(() => recording.application.completeUserAbandonment({
    scope: recording.scope,
    transferId: "transfer-1",
    ledgerDisposition: "absent",
    ledgerFingerprint,
    ensureCloseEvent: () => {
      throw new Error("final replay must not append its close event");
    },
    assertCloseEvent: () => recording.trace.push("event:assert")
  }), /final Session abandonment receipts changed/u);
  assert.deepEqual(recording.trace, before);
  assert.equal(recording.transfer().status, "user_abandoned");
});

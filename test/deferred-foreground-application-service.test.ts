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

function harness(initial: DeferredForegroundTransfer): {
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
    transferBelongsToTurn: () => {
      trace.push("capability:turn");
      return true;
    },
    loadTransfer: (transferId: string) => {
      assert.equal(transferId, BOUNDARY.transferId);
      trace.push("transfer:load");
      return current;
    },
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

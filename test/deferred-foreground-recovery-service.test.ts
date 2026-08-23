import assert from "node:assert/strict";
import test from "node:test";

import type { DeferredForegroundApplicationScope } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundBindingBoundary } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import {
  DeferredForegroundRecoveryService,
  type DeferredForegroundRecoveryPorts
} from "../src/deferred-foreground-recovery-service.js";
import type { Conversation } from "../src/protocol.js";
import type { TerminalNativeIdentity } from
  "../src/terminal-binding-authority.js";

const SCOPE = Object.freeze({}) as DeferredForegroundApplicationScope;
const BOUNDARY = Object.freeze({
  transferId: "transfer-1"
}) as DeferredForegroundBindingBoundary;
const ACCEPTED = Object.freeze({
  conversation: {} as Conversation,
  identity: {} as TerminalNativeIdentity
});

function transfer(
  status: DeferredForegroundTransfer["status"],
  inputStage: DeferredForegroundTransfer["input_stage"] = "none"
): DeferredForegroundTransfer {
  return {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 2,
    transfer_id: "transfer-1",
    revision: 4,
    status,
    input_stage: inputStage,
    terminal_id: "terminal-1",
    terminal_endpoint: {} as DeferredForegroundTransfer["terminal_endpoint"],
    process_pid: 42,
    process_uuid: "process-1",
    process_birth: "birth-1",
    workspace: "/workspace",
    source_session_id: "source-1",
    source_expected_revision: 1,
    source_binding_token: "a".repeat(64),
    source_before_binding: {} as
      DeferredForegroundTransfer["source_before_binding"],
    source_kind: "status_card_only",
    target_session_id: "target-1",
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: "b".repeat(64),
    request_hash: "c".repeat(64),
    dispatcher_pid: 99,
    prepared_at: "2026-08-15T00:00:00.000Z"
  };
}

interface HarnessOptions {
  all?: DeferredForegroundTransfer[];
  matching: DeferredForegroundTransfer[];
  durableZeroInput?: string;
  pendingAnchorVersion?: number;
  recoverAccepted?: boolean;
  recoverError?: Error;
  mutationTimeout?: boolean;
}

function harness(options: HarnessOptions): {
  service: DeferredForegroundRecoveryService;
  trace: string[];
} {
  const trace: string[] = [];
  let all = [...(options.all ?? options.matching)];
  let matching = [...options.matching];
  let current = matching.find((entry) => entry.status !== "aborted") ??
    matching[0];
  const ports: DeferredForegroundRecoveryPorts = {
    transaction: {
      writerScope: () => {
        trace.push("scope:writer");
        return SCOPE;
      },
      withTransferScope: async (candidate, operation) => {
        trace.push(`scope:transfer:${candidate.status}`);
        return operation(SCOPE);
      }
    },
    repository: {
      all: (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("transfer:all");
        return all;
      },
      matching: (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("transfer:matching");
        return matching;
      },
      load: (scope, transferId) => {
        assert.equal(scope, SCOPE);
        assert.equal(transferId, "transfer-1");
        trace.push("transfer:load");
        return current!;
      },
      markUncertain: (scope, boundary, reason) => {
        assert.equal(scope, SCOPE);
        assert.equal(boundary, BOUNDARY);
        trace.push(`transfer:uncertain:${reason}`);
        current = { ...current!, status: "uncertain", do_not_retry: true };
        return current;
      }
    },
    recovery: {
      boundary: (candidate) => {
        assert.equal(candidate.transfer_id, "transfer-1");
        trace.push("authority:boundary");
        return BOUNDARY;
      },
      assertRoute: (scope, candidate, boundary) => {
        assert.equal(scope, SCOPE);
        assert.equal(candidate.transfer_id, "transfer-1");
        assert.equal(boundary, BOUNDARY);
        trace.push("authority:route");
      },
      finalizeAbort: (scope, candidate) => {
        assert.equal(scope, SCOPE);
        trace.push("recovery:finalize-abort");
        all = all.map((entry) => entry === candidate
          ? { ...entry, status: "abort_resolved" }
          : entry);
        matching = matching.map((entry) => entry === candidate
          ? { ...entry, status: "abort_resolved" }
          : entry);
      },
      persistCommitted: async (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("recovery:persist-committed");
        return ACCEPTED;
      },
      crashAfterCommittedBackfill: () => {
        trace.push("runtime:committed-crash-point");
      },
      resolveCommitted: async (scope, boundary) => {
        assert.equal(scope, SCOPE);
        assert.equal(boundary, BOUNDARY);
        trace.push("recovery:resolve-committed");
      },
      assertAcceptedTurn: (accepted) => {
        assert.equal(accepted, ACCEPTED);
        trace.push("recovery:assert-accepted");
      },
      abortPrepared: (scope, _candidate, boundary, at) => {
        assert.equal(scope, SCOPE);
        assert.equal(boundary, BOUNDARY);
        trace.push(`recovery:abort:${at ?? "ordinary"}`);
      },
      durableInputNotStartedAt: (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("recovery:durable-zero-input");
        return options.durableZeroInput;
      },
      recoverAccepted: async (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("recovery:acceptance-once");
        if (options.recoverError) throw options.recoverError;
        return options.recoverAccepted ?? false;
      },
      pendingAnchorVersion: (scope) => {
        assert.equal(scope, SCOPE);
        trace.push("recovery:pending-anchor-version");
        return options.pendingAnchorVersion ?? 2;
      }
    },
    runtime: {
      terminalTarget: "terminal-target",
      isStoreMutationLockTimeout: (error) => {
        trace.push("runtime:classify-error");
        return options.mutationTimeout === true &&
          error === options.recoverError;
      }
    }
  };
  return { service: new DeferredForegroundRecoveryService(ports), trace };
}

test("recovery routes durable statuses through the exact ordered effects", async () => {
  const cases: Array<{
    name: string;
    options: HarnessOptions;
    expected: string[];
  }> = [
    {
      name: "none",
      options: { matching: [] },
      expected: ["scope:writer", "transfer:all", "transfer:matching"]
    },
    {
      name: "user abandoned is already final",
      options: { matching: [transfer("user_abandoned")] },
      expected: ["scope:writer", "transfer:all", "transfer:matching"]
    },
    {
      name: "finalize aborted before selecting",
      options: { matching: [transfer("aborted")] },
      expected: [
        "scope:writer",
        "transfer:all",
        "recovery:finalize-abort",
        "transfer:matching"
      ]
    },
    ...(["prepared", "source_reserved", "target_prepared"] as const).map(
      (status) => ({
        name: status,
        options: { matching: [transfer(status)] },
        expected: [
          "scope:writer",
          "transfer:all",
          "transfer:matching",
          `scope:transfer:${status}`,
          "authority:boundary",
          "authority:route",
          "recovery:abort:ordinary"
        ]
      })
    ),
    {
      name: "committed",
      options: { matching: [transfer("committed", "agent_accepted")] },
      expected: [
        "scope:writer",
        "transfer:all",
        "transfer:matching",
        "scope:transfer:committed",
        "authority:boundary",
        "authority:route",
        "recovery:persist-committed",
        "runtime:committed-crash-point",
        "recovery:resolve-committed",
        "recovery:assert-accepted"
      ]
    },
    {
      name: "durable zero input",
      options: {
        matching: [transfer("dispatch_started", "dispatch_started")],
        durableZeroInput: "2026-08-15T00:00:01.000Z"
      },
      expected: [
        "scope:writer",
        "transfer:all",
        "transfer:matching",
        "scope:transfer:dispatch_started",
        "authority:boundary",
        "authority:route",
        "recovery:durable-zero-input",
        "recovery:abort:2026-08-15T00:00:01.000Z"
      ]
    }
  ];
  for (const fixture of cases) {
    const recording = harness(fixture.options);
    await recording.service.recover();
    assert.deepEqual(recording.trace, fixture.expected, fixture.name);
  }
});

test("possible-input version-three pending recovery never retries or rolls back", async () => {
  const recording = harness({
    matching: [transfer("dispatch_started", "enter_dispatched")],
    pendingAnchorVersion: 3
  });
  await recording.service.recover();
  assert.deepEqual(recording.trace, [
    "scope:writer",
    "transfer:all",
    "transfer:matching",
    "scope:transfer:dispatch_started",
    "authority:boundary",
    "authority:route",
    "recovery:durable-zero-input",
    "recovery:acceptance-once",
    "recovery:pending-anchor-version"
  ]);
  assert.equal(recording.trace.some((entry) => entry.includes("abort")), false);
  assert.equal(recording.trace.filter((entry) =>
    entry === "recovery:acceptance-once").length, 1);
});

test("uncertain exact submission-retry pending remains monitorable", async () => {
  for (const mode of ["exact_draft_enter", "replacement_send"] as const) {
    const pending = {
      ...transfer("uncertain", "enter_dispatched"),
      message_id: "message-1",
      text_injected_at: "2026-08-15T00:00:01.000Z",
      enter_dispatched_at: "2026-08-15T00:00:03.000Z",
      submission_retry_attempt_id: "retry-1",
      submission_retry_mode: mode,
      submission_retry_message_id: "message-1",
      submission_retry_prepared_at: "2026-08-15T00:00:00.000Z",
      ...(mode === "replacement_send"
        ? {
            submission_retry_text_reserved_at:
              "2026-08-15T00:00:01.000Z",
            submission_retry_text_injected_at:
              "2026-08-15T00:00:02.000Z"
          }
        : {}),
      submission_retry_enter_reserved_at: "2026-08-15T00:00:03.000Z",
      submission_retry_enter_dispatched_at: "2026-08-15T00:00:03.000Z"
    };
    const recording = harness({
      matching: [pending],
      pendingAnchorVersion: 3
    });
    await recording.service.recover();
    assert.equal(
      recording.trace.some((entry) => entry.includes("abort")),
      false,
      mode
    );
    assert.equal(
      recording.trace.some((entry) => entry.startsWith("transfer:uncertain")),
      false,
      mode
    );
  }
});

test("possible-input pending recovery marks uncertain once and fails closed", async () => {
  const recording = harness({
    matching: [transfer("dispatch_started", "text_injected")]
  });
  await assert.rejects(
    recording.service.recover(),
    /uncertain dispatch; do not retry/u
  );
  assert.equal(recording.trace.filter((entry) =>
    entry.startsWith("transfer:uncertain:")).length, 1);
  assert.equal(recording.trace.some((entry) => entry.includes("abort")), false);
  assert.equal(recording.trace.filter((entry) =>
    entry === "recovery:acceptance-once").length, 1);
});

test("possible-input acceptance failure records uncertainty after durable reload", async () => {
  const recording = harness({
    matching: [transfer("dispatch_started", "enter_dispatched")],
    recoverError: new Error("acceptance observer failed")
  });
  await assert.rejects(
    recording.service.recover(),
    /recovery failed closed: acceptance observer failed/u
  );
  const failureTail = recording.trace.slice(-3);
  assert.equal(failureTail[0], "runtime:classify-error");
  assert.equal(failureTail[1], "transfer:load");
  assert.match(failureTail[2], /^transfer:uncertain:/u);
  assert.equal(recording.trace.some((entry) => entry.includes("abort")), false);
});

test("multiple unresolved transfers fail before any transfer scope is entered", async () => {
  const recording = harness({
    matching: [
      transfer("prepared"),
      { ...transfer("committed", "agent_accepted"), transfer_id: "transfer-2" }
    ]
  });
  await assert.rejects(recording.service.recover(), /multiple unresolved/u);
  assert.deepEqual(recording.trace, [
    "scope:writer",
    "transfer:all",
    "transfer:matching"
  ]);
});

test("recovery finalizes cross-terminal abort intent before terminal matching", async () => {
  const crossTerminal = {
    ...transfer("aborted"),
    transfer_id: "transfer-cross-terminal",
    terminal_id: "terminal-elsewhere",
    process_pid: 8181
  };
  const local = transfer("prepared");
  const recording = harness({ all: [crossTerminal, local], matching: [local] });
  await recording.service.recover();
  assert.deepEqual(recording.trace, [
    "scope:writer",
    "transfer:all",
    "recovery:finalize-abort",
    "transfer:matching",
    "scope:transfer:prepared",
    "authority:boundary",
    "authority:route",
    "recovery:abort:ordinary"
  ]);
});

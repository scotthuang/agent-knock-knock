import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createConversation, type Conversation } from "../src/protocol.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";
import {
  TerminalDispatchRecoveryService,
  decideLaggingDispatchRecovery,
  decidePreparedDispatchRecovery,
  type LocalCompletionRecoveryContext,
  type TerminalDispatchRecoveryPorts,
  type VerifiedDeadRecoveryContext
} from "../src/terminal-dispatch-recovery-service.js";
import {
  verifiedDeadTerminalAgentProcessEvidenceId,
  type VerifiedDeadAgentAuthorityDecision,
  type VerifiedDeadAgentCompletionObservation,
  type VerifiedDeadTerminalAgentProcessProof
} from "../src/verified-dead-agent-policy.js";

const NOW = new Date("2026-08-15T04:05:06.000Z");
const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.1",
  socketPath: "/private/tmp/tmux-501/default",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4200,
  currentPath: "/repo/project",
  capabilities: ["send_keys", "screen_status"]
};

function conversation(status: Conversation["status"] = "waiting_for_agent"):
  Conversation {
  return {
    ...createConversation({
      userRequest: "recover this terminal Turn",
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      now: NOW
    }),
    status
  };
}

function proof(): VerifiedDeadTerminalAgentProcessProof {
  return {
    kind: "exact_pid_absent_from_complete_process_inventory",
    agent: "codex",
    pid: 4300,
    process_uuid: "codex-pid:4300:birth:exact",
    process_birth: "exact",
    conversation_id: "turn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    terminal_control: CONTROL,
    terminal_endpoint: terminalControlEvidence(CONTROL),
    binding_id: "binding-1",
    binding_generation: 2,
    message_id: "message-1",
    observed_at: NOW.toISOString()
  };
}

function createHarness(input: {
  persisted?: VerifiedDeadAgentAuthorityDecision;
  prior?:
    | { status: "absent" }
    | { status: "valid"; completionObservation: "absent" | "unverifiable" }
    | { status: "invalid"; reason: string };
  completion?: VerifiedDeadAgentCompletionObservation<TerminalCompletionEvidence>;
  ledgerResolved?: boolean;
} = {}) {
  const trace: string[] = [];
  const current = conversation();
  const deadProof = proof();
  const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(deadProof);
  const verifiedContext: VerifiedDeadRecoveryContext = {
    scope: {},
    conversation: current,
    terminalControl: CONTROL,
    messageId: "message-1"
  };
  const localContext: LocalCompletionRecoveryContext = {
    scope: {},
    conversation: conversation("idle"),
    terminalControl: CONTROL,
    terminalMessageId: "message-1",
    completionId: "completion-1",
    callbackMessageId: "callback-1",
    outcome: "success"
  };
  let stored: Conversation | undefined;
  const ports: TerminalDispatchRecoveryPorts<string> = {
    transaction: {
      async verifiedDead(_request, operation) {
        trace.push("transaction:terminal:enter");
        try {
          return await operation(verifiedContext);
        } finally {
          trace.push("transaction:terminal:exit");
        }
      },
      localCompletion(_request, operation) {
        trace.push("transaction:local:enter");
        try {
          return operation(localContext);
        } finally {
          trace.push("transaction:local:exit");
        }
      }
    },
    authority: {
      assertBinding() {
        trace.push("authority:binding");
      },
      basicAcceptedDispatch() {
        trace.push("authority:basic-dispatch");
        return true;
      },
      assertAcceptedDispatch() {
        trace.push("authority:dispatch");
      },
      persistedDeath() {
        trace.push("authority:persisted");
        return input.persisted ?? { status: "absent" };
      },
      async observeDeath() {
        trace.push("authority:observe");
        return { status: "verified_dead", proof: deadProof };
      },
      priorStall() {
        trace.push("authority:prior-stall");
        return input.prior ?? { status: "absent" };
      },
      async durableCompletion() {
        trace.push("authority:completion");
        return input.completion ?? { status: "absent" };
      },
      assertLocalCompletion() {
        trace.push("authority:local-completion");
        return { ledgerResolved: input.ledgerResolved ?? false };
      }
    },
    evidence: {
      ensureDeath() {
        trace.push("evidence:death");
        return {
          proof: deadProof,
          evidenceId,
          recordedAt: deadProof.observed_at
        };
      },
      ensureStall() {
        trace.push("evidence:stall");
      }
    },
    state: {
      save(_context, next) {
        trace.push("state:save");
        stored = next;
      },
      crashAfterStallEvents() {
        trace.push("state:crash-fence");
      },
      logDeath() {
        trace.push("state:log-death");
      },
      settleLocalCompletion() {
        trace.push("state:settle-local");
      }
    },
    completion: {
      prepareAfterStateRelease(_context, completion) {
        trace.push("state:release");
        trace.push("callback:prepare");
        assert.equal(completion.source, "durable");
        return {
          claimed: true,
          conversation: conversation("idle"),
          prepared: "prepared-callback-1"
        };
      }
    }
  };
  return {
    service: new TerminalDispatchRecoveryService(ports),
    trace,
    stored: () => stored
  };
}

const REQUEST = {
  storeDir: "/store",
  statePath: "/store/turn-1/state.json",
  logPath: "/store/turn-1/events.ndjson",
  expectedConversationId: "turn-1",
  expectedMessageId: "message-1"
};

test("durable completion wins before new stall evidence and prepares after state release", async () => {
  const harness = createHarness({
    completion: {
      status: "present",
      completion: {
        source: "durable",
        outcome: "success",
        text: "completed exactly once",
        id: "completion-1"
      }
    }
  });
  const result = await harness.service.stallAcceptedForVerifiedDead(REQUEST);

  assert.equal(result.stalled, false);
  assert.equal(result.reason, "bound_agent_process_dead_completion_prepared");
  assert.equal(result.completionPreparation?.claimed, true);
  assert.deepEqual(harness.trace, [
    "transaction:terminal:enter",
    "authority:binding",
    "authority:basic-dispatch",
    "authority:dispatch",
    "authority:persisted",
    "authority:observe",
    "authority:prior-stall",
    "authority:completion",
    "state:release",
    "callback:prepare",
    "transaction:terminal:exit"
  ]);
  assert.equal(harness.stored(), undefined);
});

test("fresh verified-dead recovery writes audit events before state and logging", async () => {
  const deadProof = proof();
  const harness = createHarness({
    persisted: {
      status: "valid",
      proof: deadProof,
      evidenceId: verifiedDeadTerminalAgentProcessEvidenceId(deadProof),
      recordedAt: deadProof.observed_at
    },
    completion: { status: "absent" }
  });
  const result = await harness.service.stallAcceptedForVerifiedDead(REQUEST);

  assert.equal(result.stalled, true);
  assert.equal(result.reason, "bound_agent_process_verified_dead");
  assert.deepEqual(harness.trace, [
    "transaction:terminal:enter",
    "authority:binding",
    "authority:basic-dispatch",
    "authority:dispatch",
    "authority:persisted",
    "authority:prior-stall",
    "authority:completion",
    "evidence:death",
    "evidence:stall",
    "state:crash-fence",
    "state:save",
    "state:log-death",
    "transaction:terminal:exit"
  ]);
  assert.equal(harness.stored()?.status, "stalled");
  assert.equal(
    (harness.stored()?.terminal_agent_process_disposition as
      { status?: string } | undefined)?.status,
    "verified_dead"
  );
});

test("local completion settles only after exact authority and remains idempotent", () => {
  const unsettled = createHarness();
  assert.deepEqual(unsettled.service.settleLocalCompletion({
    storeDir: REQUEST.storeDir,
    statePath: REQUEST.statePath,
    logPath: REQUEST.logPath
  }), {
    handled: true,
    recovered: true,
    reason: "local_terminal_completion_ledger_recovered"
  });
  assert.deepEqual(unsettled.trace, [
    "transaction:local:enter",
    "authority:local-completion",
    "state:settle-local",
    "transaction:local:exit"
  ]);

  const settled = createHarness({ ledgerResolved: true });
  assert.equal(settled.service.settleLocalCompletion({
    storeDir: REQUEST.storeDir,
    statePath: REQUEST.statePath,
    logPath: REQUEST.logPath
  }).recovered, false);
  assert.deepEqual(settled.trace, [
    "transaction:local:enter",
    "authority:local-completion",
    "transaction:local:exit"
  ]);
});

test("prepared recovery resolves only zero-input owners and never emits replay", () => {
  const base = {
    ledger: {
      lifecycle: false,
      status: "prepared",
      dispatcherActive: false,
      statePath: "/store/turn-1/state.json",
      eventLogPath: "/store/turn-1/events.ndjson",
      messageId: "message-1",
      conversationId: "turn-1"
    },
    now: () => NOW.toISOString()
  };
  const zeroInput = decidePreparedDispatchRecovery({
    ...base,
    owner: { status: "missing" }
  });
  assert.equal(zeroInput.action, "save_ledger");
  assert.equal(
    zeroInput.action === "save_ledger" ? zeroInput.mutation.status : "",
    "resolved"
  );

  const possibleInput = decidePreparedDispatchRecovery({
    ...base,
    owner: {
      status: "loaded",
      conversationId: "turn-1",
      updatedAt: NOW.toISOString(),
      storedMessageId: "message-1",
      submission: {
        status: "text_injected",
        messageId: "message-1",
        textInjectedAt: NOW.toISOString()
      },
      binding: { executor_kind: "codex" },
      requestHash: "request-1",
      statePath: base.ledger.statePath,
      eventLogPath: base.ledger.eventLogPath,
      callbackExpected: true
    }
  });
  assert.equal(possibleInput.action, "save_ledger");
  assert.equal(
    possibleInput.action === "save_ledger"
      ? possibleInput.mutation.status
      : "",
    "text_injected"
  );
  assert.equal("replay" in possibleInput, false);
});

test("prepared keep paths never observe the clock and prior restore replaces", () => {
  let clockReads = 0;
  const now = () => {
    clockReads += 1;
    throw new Error("prepared keep path read the clock");
  };
  const ledger = {
    lifecycle: false,
    status: "prepared",
    dispatcherActive: false,
    statePath: "/store/turn-1/state.json",
    eventLogPath: "/store/turn-1/events.ndjson",
    messageId: "message-new",
    conversationId: "turn-1"
  };
  for (const input of [
    { ledger: { ...ledger, dispatcherActive: true }, owner: { status: "unreadable" as const }, now },
    { ledger: { ...ledger, statePath: undefined }, owner: { status: "unreadable" as const }, now },
    { ledger, owner: { status: "unreadable" as const }, now },
    { ledger, owner: { status: "mismatch" as const }, now }
  ]) {
    assert.deepEqual(decidePreparedDispatchRecovery(input), { action: "keep" });
  }
  assert.equal(clockReads, 0);

  const restored = decidePreparedDispatchRecovery({
    ledger,
    owner: {
      status: "loaded",
      conversationId: "turn-1",
      updatedAt: NOW.toISOString(),
      storedMessageId: "message-prior",
      submission: {
        status: "submitted",
        messageId: "message-prior",
        preparedAt: NOW.toISOString(),
        submittedAt: NOW.toISOString()
      },
      binding: { executor_kind: "codex" },
      requestHash: "request-prior",
      statePath: ledger.statePath,
      eventLogPath: ledger.eventLogPath,
      callbackExpected: false
    },
    now
  });
  assert.equal(restored.action, "replace_ledger");
  assert.equal(clockReads, 0);
  assert.equal(
    restored.action === "replace_ledger"
      ? "previous_generation_id" in restored.mutation
      : true,
    false
  );
  assert.equal(
    restored.action === "replace_ledger"
      ? Object.hasOwn(restored.mutation, "callback_route_fingerprint")
      : true,
    false
  );
});

test("prior generation restore preserves exact callback route authority", () => {
  const ledger = {
    lifecycle: false,
    status: "prepared",
    dispatcherActive: false,
    statePath: "/store/turn-1/state.json",
    eventLogPath: "/store/turn-1/events.ndjson",
    messageId: "message-new",
    conversationId: "turn-1"
  };
  const fingerprint = `sha256:${"a".repeat(64)}`;
  for (const authority of [fingerprint, null] as const) {
    const restored = decidePreparedDispatchRecovery({
      ledger,
      owner: {
        status: "loaded",
        conversationId: "turn-1",
        updatedAt: NOW.toISOString(),
        storedMessageId: "message-prior",
        submission: {
          status: "submitted",
          messageId: "message-prior",
          preparedAt: NOW.toISOString(),
          submittedAt: NOW.toISOString(),
          callbackRouteFingerprint: authority
        },
        binding: { executor_kind: "codex" },
        requestHash: "request-prior",
        statePath: ledger.statePath,
        eventLogPath: ledger.eventLogPath,
        callbackExpected: authority !== null
      },
      now: () => {
        throw new Error("prior restore must not observe the clock");
      }
    });
    assert.equal(restored.action, "replace_ledger");
    assert.equal(
      restored.action === "replace_ledger"
        ? restored.mutation.callback_route_fingerprint
        : undefined,
      authority
    );
  }
});

test("active crash recovery preserves hash, null, and legacy route authority", () => {
  const fingerprint = `sha256:${"c".repeat(64)}`;
  const authorities = [fingerprint, null, undefined] as const;
  for (const authority of authorities) {
    const submission = {
      status: "submitted",
      messageId: "message-1",
      preparedAt: NOW.toISOString(),
      submittedAt: NOW.toISOString(),
      ...(authority !== undefined
        ? { callbackRouteFingerprint: authority }
        : {})
    };
    const prepared = decidePreparedDispatchRecovery({
      ledger: {
        lifecycle: false,
        status: "prepared",
        dispatcherActive: false,
        statePath: "/store/turn-1/state.json",
        eventLogPath: "/store/turn-1/events.ndjson",
        messageId: "message-1",
        conversationId: "turn-1"
      },
      owner: {
        status: "loaded",
        conversationId: "turn-1",
        updatedAt: NOW.toISOString(),
        storedMessageId: "message-1",
        submission,
        binding: { executor_kind: "codex" },
        requestHash: "request-1",
        statePath: "/store/turn-1/state.json",
        eventLogPath: "/store/turn-1/events.ndjson",
        callbackExpected: authority !== null
      },
      now: () => NOW.toISOString()
    });
    assert.equal(prepared.action, "save_ledger");
    if (prepared.action === "save_ledger") {
      assert.equal(
        Object.hasOwn(prepared.mutation, "callback_route_fingerprint"),
        authority !== undefined
      );
      assert.equal(prepared.mutation.callback_route_fingerprint, authority);
    }

    const acceptance = { source: "codex_rollout" } as never;
    const accepted = decideLaggingDispatchRecovery({
      eligible: true,
      ledgerStatus: "enter_dispatched",
      stateStatus: "agent_accepted",
      stateAcceptance: acceptance,
      submission: {
        ...submission,
        status: "agent_accepted",
        acceptanceEvidence: acceptance
      },
      binding: { executor_kind: "codex" },
      now: NOW.toISOString()
    });
    assert.equal(accepted.action, "save_ledger");
    if (accepted.action === "save_ledger") {
      assert.equal(
        Object.hasOwn(accepted.mutation, "callback_route_fingerprint"),
        authority !== undefined
      );
      assert.equal(accepted.mutation.callback_route_fingerprint, authority);
    }

    const submitted = decideLaggingDispatchRecovery({
      eligible: true,
      ledgerStatus: "text_injected",
      stateStatus: "submitted",
      submission,
      binding: { executor_kind: "codex" },
      now: NOW.toISOString()
    });
    assert.equal(submitted.action, "save_ledger");
    if (submitted.action === "save_ledger") {
      assert.equal(
        Object.hasOwn(submitted.mutation, "callback_route_fingerprint"),
        authority !== undefined
      );
      assert.equal(submitted.mutation.callback_route_fingerprint, authority);
    }
  }
});

test("recovery service keeps infrastructure and broad terminal capabilities outside", () => {
  const source = fs.readFileSync(
    "src/terminal-dispatch-recovery-service.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /node:|cli-core|file-lock|session-store|from "\.\/store\.js"|JSON\.(?:parse|stringify)|Record<[^>]*any|ResolvedTerminalConversation|TerminalAgentAdapter/u
  );
  const ports = source.slice(
    source.indexOf("export interface TerminalDispatchRecoveryPorts"),
    source.indexOf("/** Own verified-dead")
  );
  assert.deepEqual(
    [...ports.matchAll(/^  (transaction|authority|evidence|state|completion):/gmu)]
      .map((match) => match[1]),
    ["transaction", "authority", "evidence", "state", "completion"]
  );
});

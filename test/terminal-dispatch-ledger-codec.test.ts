import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  constructTerminalDispatchLedgerDocument,
  constructTerminalOrdinaryDispatchLedger,
  decodeTerminalDispatchLedgerDocument,
  mergeTerminalDispatchReceipt,
  nativeThreadLifecycleLedger,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptCandidate,
  terminalDispatchReceiptHistory,
  type TerminalOrdinaryDispatchIdentityFields,
  type TerminalOrdinaryDispatchPhaseFields,
  type TerminalOrdinaryDispatchPostCallbackFields
} from "../src/terminal-dispatch-ledger-codec.js";
import {
  terminalControlEvidence,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";
import type {
  ManagedTerminalBinding,
  NativeThreadTransition
} from "../src/managed-session.js";

const tmuxControl: TerminalControlRef = {
  kind: "tmux",
  target: "%7",
  socketPath: "/tmp/tmux.sock",
  session: "akk",
  window: 1,
  pane: 2,
  panePid: 4321,
  currentPath: "/workspace",
  capabilities: []
};

const legacyKey = "legacy-key";
const canonicalKey = "canonical-key";
const ledgerPath = "/runtime/terminal-dispatch.json";

function decode(document: unknown) {
  return decodeTerminalDispatchLedgerDocument(JSON.stringify(document), {
    ledgerPath,
    terminalControl: tmuxControl,
    legacyTerminalKey: legacyKey,
    canonicalTerminalKey: canonicalKey
  });
}

function endpoint(panePid = 4321) {
  return terminalControlEvidence({ ...tmuxControl, panePid });
}

function control(panePid = 4321) {
  return {
    kind: "tmux",
    target: "%7",
    socket_path: "/tmp/tmux.sock",
    pane_pid: panePid,
    current_path: "/workspace"
  };
}

function receipt(
  status: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    message_id: "message-1",
    request_hash: "request-hash",
    binding_id: "binding-1",
    binding_generation: 1,
    native_thread_id: "thread-1",
    store_dir: "/store",
    conversation_id: "conversation-1",
    session_id: "session-1",
    turn_id: "turn-1",
    terminal_control: control(),
    terminal_endpoint: endpoint(),
    ...overrides
  };
}

test("decode preserves native JSON.parse failures", () => {
  assert.throws(
    () => decodeTerminalDispatchLedgerDocument("{", {
      ledgerPath,
      terminalControl: tmuxControl,
      legacyTerminalKey: legacyKey,
      canonicalTerminalKey: canonicalKey
    }),
    SyntaxError
  );
});

test("decode accepts exact v1 route documents", () => {
  const document = {
    version: 1,
    terminal_key: legacyKey,
    terminal_control: {
      target: "%7",
      socket_path: "/tmp/tmux.sock"
    },
    status: "prepared"
  };
  assert.deepEqual(decode(document), document);
});

test("decode applies the exact v1 invalid-ledger fence", () => {
  for (const document of [
    null,
    [],
    {},
    { version: 3 },
    {
      version: 1,
      terminal_key: "wrong",
      terminal_control: { target: "%7", socket_path: "/tmp/tmux.sock" }
    },
    {
      version: 1,
      terminal_key: legacyKey,
      terminal_control: { target: "%8", socket_path: "/tmp/tmux.sock" }
    },
    {
      version: 1,
      terminal_key: legacyKey,
      terminal_control: { target: "%7", socket_path: "/tmp/other.sock" }
    }
  ]) {
    assert.throws(
      () => decode(document),
      new Error(`terminal dispatch ledger is invalid: ${ledgerPath}`)
    );
  }
});

test("decode preserves legacy null-as-absent socket semantics", () => {
  const noSocketControl: TerminalControlRef = {
    ...tmuxControl,
    socketPath: undefined
  };
  const options = {
    ledgerPath,
    terminalControl: noSocketControl,
    legacyTerminalKey: legacyKey,
    canonicalTerminalKey: canonicalKey
  };
  assert.equal(
    decodeTerminalDispatchLedgerDocument(JSON.stringify({
      version: 1,
      terminal_key: legacyKey,
      terminal_control: { target: "%7" }
    }), options).version,
    1
  );
  assert.equal(
    decodeTerminalDispatchLedgerDocument(JSON.stringify({
      version: 1,
      terminal_key: legacyKey,
      terminal_control: { target: "%7", socket_path: null }
    }), options).version,
    1
  );
});

test("decode accepts exact v2 endpoint identity and rejects drift", () => {
  const document = {
    version: 2,
    terminal_key: canonicalKey,
    terminal_endpoint: terminalControlEvidence(tmuxControl),
    status: "submitted"
  };
  assert.deepEqual(decode(document), document);
  for (const changed of [
    { ...document, terminal_key: "wrong" },
    { ...document, terminal_endpoint: undefined },
    {
      ...document,
      terminal_endpoint: {
        ...terminalControlEvidence(tmuxControl),
        target: "%8",
        endpoint_key: "tmux:/tmp/tmux.sock:%8"
      }
    }
  ]) {
    assert.throws(
      () => decode(changed),
      new Error(`terminal dispatch ledger is invalid: ${ledgerPath}`)
    );
  }
});

test("lifecycle predicate recognizes every legacy lifecycle discriminator", () => {
  assert.equal(terminalDispatchLedgerLooksLifecycle(undefined), false);
  assert.equal(terminalDispatchLedgerLooksLifecycle({}), false);
  const cases: Array<[string, unknown]> = [
    ["kind", "lifecycle"],
    ["transition_id", "transition-1"],
    ["operation", "new_thread"],
    ["operation", "resume_thread"],
    ["operation", "adopt_external_thread"],
    ["adapter_version", "v1"],
    ["command_fingerprint", "hash"],
    ["target_session_id", "session-2"],
    ["before_native_thread_id", "thread-0"],
    ["before_process_uuid", "process-0"],
    ["before_process_started_at", "2026-01-01T00:00:00.000Z"],
    ["before_process_birth", {}],
    ["before_process_rollout", {}]
  ];
  for (const [key, value] of cases) {
    assert.equal(
      terminalDispatchLedgerLooksLifecycle({ [key]: value }),
      true,
      key
    );
  }
  assert.equal(
    terminalDispatchLedgerLooksLifecycle({ operation: "close_thread" }),
    false
  );
});

test("lifecycle phase builder preserves every legacy key and JSON byte", () => {
  const beforeBinding: ManagedTerminalBinding = {
    binding_id: "binding-before",
    generation: 3,
    terminal_id: "terminal-1",
    terminal_control: tmuxControl,
    native_thread_id: "thread-before",
    native_process: {
      pid: 111,
      process_uuid: "process-before",
      process_birth: "birth-before",
      rollout: {
        fd: "7",
        device: "10",
        inode: "20",
        path: "/rollout/before.jsonl"
      },
      evidence: "codex_rollout_fd"
    },
    bound_at: "2026-08-14T00:00:00.000Z",
    last_verified_at: "2026-08-14T00:00:01.000Z"
  };
  const afterBinding: ManagedTerminalBinding = {
    ...beforeBinding,
    binding_id: "binding-after",
    generation: 4,
    native_thread_id: "thread-after"
  };
  const transition: NativeThreadTransition = {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: "transition-1",
    operation: "resume_thread",
    status: "verified",
    terminal_id: "terminal-1",
    agent: "codex",
    workspace: "/workspace",
    source_session_id: "session-before",
    source_expected_revision: 2,
    target_session_id: "session-after",
    target_expected_revision: null,
    target_native_thread_id: "thread-after",
    target_candidate_file_identity: {
      path: "/rollout/after.jsonl",
      device: "10",
      inode: "21"
    },
    before_native_thread_id: "thread-before",
    before_process_uuid: "process-before",
    before_process_started_at: 1_723_590_000_000,
    before_process_birth: "birth-before",
    before_process_rollout: beforeBinding.native_process.rollout,
    before_binding: beforeBinding,
    after_binding: afterBinding,
    adapter_version: "codex/1",
    command_fingerprint: "command-hash",
    dispatcher_pid: 222,
    prepared_at: "2026-08-14T00:00:02.000Z",
    dispatching_at: "2026-08-14T00:00:03.000Z",
    submitted_at: "2026-08-14T00:00:04.000Z",
    verified_at: "2026-08-14T00:00:05.000Z"
  };
  const storeDir = "/store";
  const previousLedger = {
    generation_id: "previous-generation",
    message_id: "previous-message"
  };
  const error = { length: 9, preview: "transition" };
  const base = {
    kind: "lifecycle",
    generation_id: transition.transition_id,
    transition_id: transition.transition_id,
    operation: transition.operation,
    origin: transition.origin,
    terminal_input_sent: transition.terminal_input_sent,
    terminal_id: transition.terminal_id,
    agent: transition.agent,
    workspace: transition.workspace,
    adapter_version: transition.adapter_version,
    command_fingerprint: transition.command_fingerprint,
    source_session_id: transition.source_session_id,
    target_session_id: transition.target_session_id,
    target_native_thread_id: transition.target_native_thread_id,
    target_candidate_file_identity: transition.target_candidate_file_identity,
    native_thread_id: transition.after_binding?.native_thread_id ??
      transition.before_native_thread_id,
    before_native_thread_id: transition.before_native_thread_id,
    before_process_uuid: transition.before_process_uuid,
    before_process_started_at: transition.before_process_started_at,
    before_process_birth: transition.before_process_birth,
    before_process_rollout: transition.before_process_rollout,
    store_dir: storeDir,
    prepared_at: transition.prepared_at,
    dispatching_at: transition.dispatching_at,
    submitted_at: transition.submitted_at,
    verified_at: transition.verified_at,
    dispatcher_pid: transition.dispatcher_pid,
    binding: transition.before_binding
  };
  const terminalFields = {
    terminal_id: transition.terminal_id,
    agent: transition.agent,
    workspace: transition.workspace,
    adapter_version: transition.adapter_version,
    command_fingerprint: transition.command_fingerprint
  };
  const targetFields = {
    source_session_id: transition.source_session_id,
    target_session_id: transition.target_session_id,
    target_native_thread_id: transition.target_native_thread_id,
    target_candidate_file_identity: transition.target_candidate_file_identity
  };
  const beforeFields = {
    before_native_thread_id: transition.before_native_thread_id,
    before_process_uuid: transition.before_process_uuid,
    before_process_started_at: transition.before_process_started_at,
    before_process_birth: transition.before_process_birth,
    before_process_rollout: transition.before_process_rollout
  };
  const identityFields = {
    kind: "lifecycle",
    generation_id: transition.transition_id,
    transition_id: transition.transition_id
  };
  const commandPrepared = {
    status: "prepared",
    ...identityFields,
    operation: transition.operation,
    ...terminalFields,
    ...targetFields,
    ...beforeFields,
    store_dir: storeDir,
    prepared_at: transition.prepared_at,
    dispatcher_pid: transition.dispatcher_pid,
    binding: transition.before_binding,
    previous_generation_id: previousLedger.generation_id
  };
  const commandInFlight = (status: "dispatching" | "submitted") => ({
    status,
    ...identityFields,
    ...terminalFields,
    operation: transition.operation,
    ...targetFields,
    ...beforeFields,
    store_dir: storeDir,
    prepared_at: transition.prepared_at,
    [`${status}_at`]: transition[`${status}_at`],
    dispatcher_pid: transition.dispatcher_pid,
    binding: transition.before_binding,
    previous_generation_id: previousLedger.generation_id
  });
  const herdrControl: TerminalControlRef = {
    kind: "herdr",
    target: "default:w1:p1",
    socketPath: "/tmp/herdr.sock",
    session: "default",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "term_0123456789abcd",
    panePid: 333,
    currentPath: "/workspace",
    capabilities: []
  };
  const terminalControlFields = (value: TerminalControlRef) => ({
    kind: value.kind,
    target: value.target,
    socket_path: value.socketPath ?? null,
    pane_pid: value.panePid ?? null,
    current_path: value.currentPath ?? null
  });
  const cases = [
    {
      name: "prepared",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "prepared", previous: previousLedger,
        targetNativeThreadId: "thread-selected"
      }),
      expected: {
        ...base,
        status: "prepared",
        target_native_thread_id: "thread-selected",
        previous_generation_id: previousLedger.generation_id
      }
    },
    {
      name: "verified",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "verified", binding: afterBinding
      }),
      expected: { ...base, status: "verified", binding: afterBinding }
    },
    {
      name: "verified with previous generation",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "verified_with_previous", binding: beforeBinding,
        previousGenerationId: "retained-generation"
      }),
      expected: {
        ...base,
        status: "verified",
        binding: beforeBinding,
        previous_generation_id: "retained-generation"
      }
    },
    {
      name: "resolved",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "resolved", at: "resolved-at", reason: "resolved-reason"
      }),
      expected: {
        ...base, status: "resolved", resolved_at: "resolved-at",
        reason: "resolved-reason"
      }
    },
    {
      name: "resolved with binding",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "resolved_with_binding", at: "resolved-at",
        binding: afterBinding, reason: "resolved-reason"
      }),
      expected: {
        ...base, status: "resolved", resolved_at: "resolved-at",
        binding: afterBinding, reason: "resolved-reason"
      }
    },
    {
      name: "uncertain reason",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "uncertain", at: "uncertain-at", reason: "uncertain-reason"
      }),
      expected: {
        ...base, status: "uncertain", uncertain_at: "uncertain-at",
        reason: "uncertain-reason"
      }
    },
    {
      name: "uncertain reason then error",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "uncertain_reason_error", at: "uncertain-at",
        reason: "uncertain-reason", error
      }),
      expected: {
        ...base, status: "uncertain", uncertain_at: "uncertain-at",
        reason: "uncertain-reason", error
      }
    },
    {
      name: "uncertain error then reason",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "uncertain_error_reason", at: "uncertain-at",
        error, reason: "uncertain-reason"
      }),
      expected: {
        ...base, status: "uncertain", uncertain_at: "uncertain-at",
        error, reason: "uncertain-reason"
      }
    },
    {
      name: "rebuild without canonical endpoint",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "rebuild", control: tmuxControl, previous: previousLedger
      }),
      expected: {
        ...base,
        status: transition.status,
        binding: transition.before_binding,
        terminal_control: terminalControlFields(tmuxControl),
        previous_generation_id: previousLedger.generation_id
      }
    },
    {
      name: "rebuild with canonical endpoint",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "rebuild", control: herdrControl, previous: previousLedger
      }),
      expected: {
        ...base,
        status: transition.status,
        binding: transition.before_binding,
        terminal_control: terminalControlFields(herdrControl),
        terminal_endpoint: terminalControlEvidence(herdrControl),
        previous_generation_id: previousLedger.generation_id
      }
    },
    {
      name: "command prepared",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "command_prepared", previous: previousLedger
      }),
      expected: commandPrepared
    },
    {
      name: "command dispatching",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "command_dispatching", previous: previousLedger
      }),
      expected: commandInFlight("dispatching")
    },
    {
      name: "command submitted",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "command_submitted", previous: previousLedger
      }),
      expected: commandInFlight("submitted")
    },
    {
      name: "command resolved",
      actual: nativeThreadLifecycleLedger(transition, storeDir, {
        phase: "command_resolved", at: "resolved-at",
        binding: afterBinding, reason: "resolved-reason"
      }),
      expected: {
        status: "resolved",
        ...identityFields,
        ...terminalFields,
        operation: transition.operation,
        ...targetFields,
        target_native_thread_id: afterBinding.native_thread_id,
        store_dir: storeDir,
        prepared_at: transition.prepared_at,
        submitted_at: transition.submitted_at,
        verified_at: transition.verified_at,
        resolved_at: "resolved-at",
        dispatcher_pid: transition.dispatcher_pid,
        binding: afterBinding,
        reason: "resolved-reason"
      }
    }
  ];
  for (const current of cases) {
    assert.deepEqual(Object.keys(current.actual), Object.keys(current.expected), current.name);
    assert.equal(
      `${JSON.stringify(current.actual, null, 2)}\n`,
      `${JSON.stringify(current.expected, null, 2)}\n`,
      current.name
    );
  }
});

test("lifecycle builder and scoped save calls retain their exact adjacent CAS", () => {
  const actual = [
    "src/terminal-handoff-cli-adapter.ts",
    "src/cli-core.ts",
    "src/native-thread-transition-application.ts"
  ].flatMap((sourcePath) => {
    const source = readFileSync(sourcePath, "utf8");
    const starts = [...source.matchAll(/lifecycleLedger\(/gu)]
      .map((match) => match.index);
    return starts.map((start, index) => {
      const section = source.slice(start, starts[index + 1]);
      const phase = /phase: "([^"]+)"/u.exec(section)?.[1];
      const cas = /expectedTransitionId:\s*([^,}\n]+)(?:,\s*expectedStatus:\s*"([^"]+)")?/u
        .exec(section);
      return [phase, cas?.[1].trim(), cas?.[2]];
    }).filter(([phase]) => phase !== undefined);
  });
  assert.deepEqual(actual, [
    ["prepared", "null", undefined],
    ["verified", "transitionId", "prepared"],
    ["resolved_with_binding", "transitionId", "verified"],
    ["uncertain", "transitionId", undefined],
    ["command_prepared", "null", undefined],
    ["command_dispatching", "transitionId", "prepared"],
    ["command_submitted", "transitionId", "dispatching"]
  ]);

  const recoverySource = readFileSync(
    "src/native-thread-lifecycle-recovery-service.ts",
    "utf8"
  );
  const recoveryStarts = [
    ...recoverySource.matchAll(/ports\.ledger\.save\(/gu)
  ].map((match) => match.index);
  const recoveryActual = recoveryStarts.map((start, index) => {
    const section = recoverySource.slice(start, recoveryStarts[index + 1]);
    const phase = /phase: "([^"]+)"/u.exec(section)?.[1];
    const cas = /expectedTransitionId:\s*([^,}\n]+)(?:,\s*expectedStatus:\s*"([^"]+)")?/u
      .exec(section);
    return [phase, cas?.[1].trim(), cas?.[2]];
  });
  assert.deepEqual(recoveryActual, [
    ["rebuild", "null", undefined],
    ["resolved", "transition.transition_id", undefined],
    ["verified", "transition.transition_id", "prepared"],
    ["verified_with_previous", "transition.transition_id", "prepared"],
    ["resolved", "transitionId", undefined],
    ["resolved_with_binding", "transitionId", undefined],
    ["resolved_with_binding", "transitionId", undefined],
    ["resolved", "transitionId", undefined],
    ["uncertain", "transitionId", undefined],
    ["resolved", "transition.transition_id", undefined],
    ["resolved_with_binding", "transition.transition_id", undefined]
  ]);
  const rebuildStart = recoverySource.indexOf(
    "const rebuilt = ports.ledger.build"
  );
  assert.notEqual(rebuildStart, -1);
  assert.ok(rebuildStart < recoveryStarts[0]);

  const settlementSource = readFileSync(
    "src/native-thread-transition-settlement-service.ts",
    "utf8"
  );
  const settlementStarts = [
    ...settlementSource.matchAll(/ports\.persistence\.saveLedger\(/gu)
  ].map((match) => match.index);
  const settlementActual = settlementStarts.map((start, index) => {
    const section = settlementSource.slice(start, settlementStarts[index + 1]);
    const phase = /phase: "([^"]+)"/u.exec(section)?.[1];
    const cas = /expectedTransitionId:\s*([^,}\n]+)(?:,\s*expectedStatus:\s*"([^"]+)")?/u
      .exec(section);
    return [phase, cas?.[1].trim(), cas?.[2]];
  });
  assert.deepEqual(settlementActual, [
    ["command_resolved", "transition.transition_id", "submitted"],
    ["uncertain_reason_error", "request.transitionId", undefined],
    ["resolved", "request.transitionId", undefined],
    ["uncertain_error_reason", "request.transitionId", undefined]
  ]);
});

test("receipt candidate preserves direct statuses and strips document metadata", () => {
  for (const status of [
    "text_injected",
    "enter_dispatched",
    "submitted",
    "agent_accepted",
    "not_accepted",
    "uncertain",
    "aborted"
  ]) {
    assert.deepEqual(
      terminalDispatchReceiptCandidate({
        ...receipt(status),
        version: 2,
        terminal_key: canonicalKey,
        terminal_submission_receipts: [receipt("submitted")]
      }),
      receipt(status),
      status
    );
  }
  assert.equal(
    terminalDispatchReceiptCandidate({ status: "prepared", message_id: "m" }),
    undefined
  );
  assert.equal(
    terminalDispatchReceiptCandidate({ status: "submitted" }),
    undefined
  );
  assert.equal(
    terminalDispatchReceiptCandidate({
      kind: "lifecycle",
      status: "submitted",
      message_id: "m"
    }),
    undefined
  );
});

test("resolved receipt candidate uses the former evidence priority", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["agent_accepted", { agent_accepted_at: "now", uncertain_at: "now" }],
    ["uncertain", { uncertain_at: "now", not_accepted_at: "now" }],
    ["not_accepted", { not_accepted_at: "now", aborted_at: "now" }],
    ["aborted", { aborted_at: "now", enter_dispatched_at: "now" }],
    ["enter_dispatched", { enter_dispatched_at: "now", submitted_at: "now" }],
    ["submitted", { submitted_at: "now" }]
  ];
  for (const [expected, evidence] of cases) {
    assert.equal(
      terminalDispatchReceiptCandidate({
        status: "resolved",
        message_id: "message-1",
        ...evidence
      })?.status,
      expected
    );
  }
});

test("receipt history validates shape, ids, and duplicates exactly", () => {
  assert.deepEqual(terminalDispatchReceiptHistory(undefined), []);
  assert.deepEqual(terminalDispatchReceiptHistory({}), []);
  for (const malformed of [null, {}, "history", [null], [{}], [
    { message_id: "   " }
  ]]) {
    assert.throws(
      () => terminalDispatchReceiptHistory({
        terminal_submission_receipts: malformed
      }),
      new Error("terminal dispatch receipt history is malformed")
    );
  }
  assert.throws(
    () => terminalDispatchReceiptHistory({
      terminal_submission_receipts: [
        { message_id: "message-1" },
        { message_id: "message-1" }
      ]
    }),
    new Error("terminal dispatch receipt message-1 is duplicated")
  );
});

test("receipt history appends, merges, and keeps resolved history authoritative", () => {
  const historical = receipt("submitted", { submitted_at: "old" });
  assert.deepEqual(
    terminalDispatchReceiptHistory({
      ...receipt("submitted", { message_id: "message-2" }),
      terminal_submission_receipts: [historical]
    }).map((item) => item.message_id),
    ["message-1", "message-2"]
  );
  assert.equal(
    terminalDispatchReceiptHistory({
      ...receipt("agent_accepted", { agent_accepted_at: "new" }),
      terminal_submission_receipts: [historical]
    })[0].status,
    "agent_accepted"
  );
  assert.deepEqual(
    terminalDispatchReceiptHistory({
      ...receipt("resolved", { agent_accepted_at: "new" }),
      terminal_submission_receipts: [historical]
    }),
    [historical]
  );
});

test("merge rejects every changed immutable field with exact text", () => {
  const immutableFields = [
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "store_dir",
    "conversation_id",
    "session_id",
    "turn_id",
    "message_id",
    "message_type",
    "message_body_hash",
    "request_hash",
    "executor_kind",
    "openclaw_session",
    "callback_route_fingerprint",
    "state_path",
    "event_log_path",
    "deferred_foreground_transfer_id"
  ];
  for (const field of immutableFields) {
    const previous = receipt("submitted", { [field]: { nested: [1, 2] } });
    const next = receipt("agent_accepted", { [field]: { nested: [1, 3] } });
    if (field === "message_id") {
      previous.message_id = "message-1";
      next.message_id = "message-2";
    }
    assert.throws(
      () => mergeTerminalDispatchReceipt(previous, next),
      new Error(
        `terminal dispatch receipt message-1 changed immutable ${field}`
      ),
      field
    );
  }
});

test("merge treats terminal incarnation as immutable", () => {
  assert.throws(
    () => mergeTerminalDispatchReceipt(
      receipt("submitted"),
      receipt("agent_accepted", {
        terminal_control: control(9999),
        terminal_endpoint: endpoint(9999)
      })
    ),
    new Error(
      "terminal dispatch receipt message-1 changed immutable terminal_control"
    )
  );
});

test("merge never weakens accepted or durable failure proof", () => {
  const accepted = receipt("agent_accepted", { agent_accepted_at: "accepted" });
  assert.equal(
    mergeTerminalDispatchReceipt(accepted, receipt("submitted")),
    accepted
  );
  for (const status of ["not_accepted", "uncertain", "aborted"]) {
    const failure = receipt(status, { safe_to_retry: false });
    for (const transport of ["text_injected", "enter_dispatched", "submitted"]) {
      assert.equal(
        mergeTerminalDispatchReceipt(failure, receipt(transport)),
        failure,
        `${status} -> ${transport}`
      );
    }
  }
});

test("merge fills omitted immutable identity and terminal evidence", () => {
  const previous = receipt("submitted", {
    message_type: "prompt",
    terminal_control: control(),
    terminal_endpoint: endpoint()
  });
  const next = {
    status: "agent_accepted",
    message_id: "message-1",
    acceptance_evidence: { kind: "rollout" }
  };
  assert.deepEqual(mergeTerminalDispatchReceipt(previous, next), {
    ...next,
    binding_id: "binding-1",
    binding_generation: 1,
    native_thread_id: "thread-1",
    store_dir: "/store",
    conversation_id: "conversation-1",
    session_id: "session-1",
    turn_id: "turn-1",
    message_type: "prompt",
    request_hash: "request-hash",
    terminal_control: control(),
    terminal_endpoint: endpoint()
  });
});

test("safe zero-input abort permits only a chronologically valid retry generation", () => {
  const previous = receipt("aborted", {
    safe_to_retry: true,
    aborted_at: "2026-08-14T01:00:00.000Z"
  });
  const retry = receipt("text_injected", {
    previous_generation_id: "message-1",
    prepared_at: "2026-08-14T01:00:01.000Z",
    binding_id: "binding-2",
    conversation_id: "conversation-2",
    session_id: "session-2",
    turn_id: "turn-2"
  });
  assert.equal(mergeTerminalDispatchReceipt(previous, retry), retry);
  for (const invalidRetry of [
    { ...retry, previous_generation_id: "other" },
    { ...retry, status: "prepared" },
    { ...retry, prepared_at: "2026-08-14T00:59:59.000Z" },
    { ...retry, prepared_at: "invalid" }
  ]) {
    assert.throws(
      () => mergeTerminalDispatchReceipt(previous, invalidRetry),
      /changed immutable binding_id/u
    );
  }
});

test("ordinary dispatch writes preserve every phase key and JSON byte", () => {
  const bindingFields = {
    binding_id: "binding-1",
    binding_generation: 2,
    native_thread_id: "thread-1",
    executor_kind: "codex"
  };
  const acceptanceEvidence = {
    source: "codex_rollout" as const,
    kind: "native_user_turn" as const,
    nativeThreadId: "thread-1",
    requestHash: "request-hash",
    acceptanceId: "acceptance-1",
    anchorFingerprint: "anchor",
    evidenceFingerprint: "evidence"
  };
  type WriteCase = {
    name: string;
    status: TerminalOrdinaryDispatchIdentityFields["status"];
    phaseFields?: TerminalOrdinaryDispatchPhaseFields;
    dispatcherPid?: number | null;
    callbackExpected?: boolean;
    postCallbackFields?: TerminalOrdinaryDispatchPostCallbackFields;
  };
  const identity = (status: WriteCase["status"]):
    TerminalOrdinaryDispatchIdentityFields => ({
    status,
    generation_id: "message-1",
    conversation_id: "conversation-1",
    session_id: "session-1",
    turn_id: "turn-1",
    message_id: "message-1",
    message_type: "task" as const,
    request_hash: "request-hash",
    prepared_at: "2026-08-14T00:00:01.000Z"
  });
  const write = ({
    status,
    phaseFields = {},
    dispatcherPid = 99,
    callbackExpected = true,
    postCallbackFields = {}
  }: WriteCase) => constructTerminalOrdinaryDispatchLedger({
    bindingFields,
    identityFields: identity(status),
    phaseFields,
    dispatcherPid,
    statePath: "/store/conversations/turn-1/state.json",
    eventLogPath: "/store/conversations/turn-1/events.ndjson",
    callbackExpected,
    postCallbackFields,
    previousGenerationId: "message-0"
  });
  const expected = ({
    status,
    phaseFields = {},
    dispatcherPid = 99,
    callbackExpected = true,
    postCallbackFields = {}
  }: WriteCase) => ({
    ...bindingFields,
    ...identity(status),
    ...phaseFields,
    dispatcher_pid: dispatcherPid,
    state_path: "/store/conversations/turn-1/state.json",
    event_log_path: "/store/conversations/turn-1/events.ndjson",
    callback_expected: callbackExpected,
    ...postCallbackFields,
    previous_generation_id: "message-0"
  });
  const textInjected = "2026-08-14T00:00:02.000Z";
  const enterDispatched = "2026-08-14T00:00:03.000Z";
  const uncertainAt = "2026-08-14T00:00:04.000Z";
  const error = { length: 9, preview: "transport" };
  const cases: WriteCase[] = [
    { name: "prepared", status: "prepared" },
    {
      name: "text injected",
      status: "text_injected",
      phaseFields: { text_injected_at: textInjected }
    },
    {
      name: "enter dispatched",
      status: "enter_dispatched",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched
      }
    },
    {
      name: "agent accepted",
      status: "agent_accepted",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched,
        agent_accepted_at: uncertainAt,
        acceptance_evidence: acceptanceEvidence
      },
      dispatcherPid: null
    },
    {
      name: "not accepted",
      status: "not_accepted",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched,
        not_accepted_at: uncertainAt
      },
      dispatcherPid: null
    },
    {
      name: "acceptance uncertain",
      status: "uncertain",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched,
        uncertain_at: uncertainAt,
        error
      },
      dispatcherPid: null
    },
    {
      name: "binding uncertain",
      status: "uncertain",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched,
        uncertain_at: uncertainAt
      },
      callbackExpected: false,
      postCallbackFields: {
        native_identity_status: "unresolved_after_submit",
        error
      }
    },
    {
      name: "transport uncertain",
      status: "uncertain",
      phaseFields: {
        text_injected_at: textInjected,
        enter_dispatched_at: enterDispatched,
        uncertain_at: uncertainAt
      },
      postCallbackFields: { error }
    }
  ];
  for (const current of cases) {
    const actual = write(current);
    const exact = expected(current);
    assert.deepEqual(Object.keys(actual), Object.keys(exact), current.name);
    assert.equal(
      `${JSON.stringify(actual, null, 2)}\n`,
      `${JSON.stringify(exact, null, 2)}\n`,
      current.name
    );
  }
});

test("ordinary ledger records route digest and explicit no-route authority", () => {
  const base = {
    bindingFields: { executor_kind: "codex" },
    identityFields: {
      status: "prepared" as const,
      generation_id: "message-route",
      conversation_id: "turn-route",
      session_id: "session-route",
      turn_id: "turn-route",
      message_id: "message-route",
      message_type: "task" as const,
      request_hash: "request-route",
      prepared_at: "2026-08-14T00:00:01.000Z"
    },
    dispatcherPid: 99,
    statePath: "/store/conversations/turn-route/state.json",
    eventLogPath: "/store/conversations/turn-route/events.ndjson",
    callbackExpected: true
  };
  const fingerprint = `sha256:${"a".repeat(64)}`;
  assert.equal(
    constructTerminalOrdinaryDispatchLedger({
      ...base,
      callbackRouteFingerprint: fingerprint
    }).callback_route_fingerprint,
    fingerprint
  );
  const noRoute = constructTerminalOrdinaryDispatchLedger({
    ...base,
    callbackExpected: false,
    callbackRouteFingerprint: null
  });
  assert.equal(
    Object.hasOwn(noRoute, "callback_route_fingerprint"),
    true
  );
  assert.equal(noRoute.callback_route_fingerprint, null);
});

test("construct emits v1 field presence and insertion order exactly", () => {
  const built = constructTerminalDispatchLedgerDocument({
    previousLedger: undefined,
    incomingLedger: {
      status: "prepared",
      generation_id: "generation-1",
      message_id: "message-1"
    },
    version: 1,
    terminalKey: legacyKey,
    terminalControl: control()
  });
  assert.deepEqual(Object.keys(built), [
    "status",
    "generation_id",
    "message_id",
    "version",
    "terminal_key",
    "terminal_control"
  ]);
  assert.deepEqual(built, {
    status: "prepared",
    generation_id: "generation-1",
    message_id: "message-1",
    version: 1,
    terminal_key: legacyKey,
    terminal_control: control()
  });
});

test("construct emits v2 endpoint then append-only receipt history", () => {
  const priorReceipt = receipt("submitted", { message_id: "message-0" });
  const incomingEndpoint = endpoint(4000);
  const built = constructTerminalDispatchLedgerDocument({
    previousLedger: {
      status: "resolved",
      terminal_submission_receipts: [priorReceipt]
    },
    incomingLedger: {
      ...receipt("agent_accepted", {
        agent_accepted_at: "2026-08-14T01:00:00.000Z",
        terminal_endpoint: incomingEndpoint,
        terminal_control: control(4000)
      }),
      terminal_submission_receipts: []
    },
    version: 2,
    terminalKey: canonicalKey,
    terminalControl: control(4321),
    terminalEndpoint: endpoint(4321)
  });
  assert.deepEqual(Object.keys(built).slice(-4), [
    "version",
    "terminal_key",
    "terminal_endpoint",
    "terminal_submission_receipts"
  ]);
  assert.ok(
    Object.keys(built).indexOf("terminal_control") <
      Object.keys(built).indexOf("version")
  );
  assert.deepEqual(built.terminal_control, control(4321));
  assert.deepEqual(built.terminal_endpoint, endpoint(4321));
  const history = built.terminal_submission_receipts as Array<
    Record<string, unknown>
  >;
  assert.deepEqual(history.map((item) => item.message_id), [
    "message-0",
    "message-1"
  ]);
  assert.deepEqual(history[1].terminal_control, control(4000));
  assert.deepEqual(history[1].terminal_endpoint, incomingEndpoint);
});

test("construct preserves existing key positions while replacing values", () => {
  const built = constructTerminalDispatchLedgerDocument({
    previousLedger: undefined,
    incomingLedger: {
      version: 1,
      terminal_key: "old-key",
      terminal_control: { target: "old" },
      status: "prepared"
    },
    version: 2,
    terminalKey: canonicalKey,
    terminalControl: control(),
    terminalEndpoint: endpoint()
  });
  assert.deepEqual(Object.keys(built), [
    "version",
    "terminal_key",
    "terminal_control",
    "status",
    "terminal_endpoint"
  ]);
  assert.equal(built.version, 2);
  assert.equal(built.terminal_key, canonicalKey);
});

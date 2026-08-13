import assert from "node:assert/strict";
import test from "node:test";

import {
  constructTerminalDispatchLedgerDocument,
  decodeTerminalDispatchLedgerDocument,
  mergeTerminalDispatchReceipt,
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptCandidate,
  terminalDispatchReceiptHistory
} from "../src/terminal-dispatch-ledger-codec.js";
import {
  terminalControlEvidence,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";

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

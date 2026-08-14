import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createConversation, type Conversation } from "../src/protocol.js";
import type { EventRecord } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import { TerminalInputNotStartedError } from
  "../src/terminal-agent-bridge.js";
import {
  TerminalDispatchApplication,
  type TerminalDispatchApplicationPorts
} from "../src/terminal-dispatch-application.js";
import type { TerminalDispatchLedgerDocument } from
  "../src/terminal-dispatch-ledger-codec.js";
import {
  applyTerminalBridgeSubmission,
  terminalBridgeSubmission,
  terminalDispatchTextSummary
} from "../src/terminal-dispatch-receipt.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "../src/terminal-submission-acceptance.js";

const PREPARED_AT = "2026-08-14T12:00:00.000Z";
const TEXT_AT = "2026-08-14T12:00:01.000Z";
const ENTER_AT = "2026-08-14T12:00:02.000Z";
const RESOLVED_AT = "2026-08-14T12:00:03.000Z";
const REQUEST_TEXT = "Please inspect the dispatch transaction.\n";
const MESSAGE_BODY = "Inspect the dispatch transaction.";
const REQUEST_HASH = sha256(REQUEST_TEXT);
const MESSAGE_BODY_HASH = sha256(MESSAGE_BODY);
const STATE_PATH = "/store/session-a/turn-a/state.json";
const EVENT_LOG_PATH = "/store/session-a/turn-a/events.ndjson";
const TERMINAL_CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "%7",
  socketPath: "/tmp/tmux.sock",
  session: "akk",
  window: 1,
  pane: 2,
  panePid: 5102,
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};

interface HarnessOptions {
  failLedgerStatus?: string;
  failFinalLedger?: boolean;
  failStateStatus?: string;
  failEvent?: string;
  failRestore?: boolean;
  failureError?: Error;
  rollbackResult?: boolean;
  receiptTerminalControl?: TerminalControlRef;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function originalConversation(): Conversation {
  return {
    ...createConversation({
      userRequest: "Inspect dispatch",
      sessionId: "session-a",
      turnId: "turn-a",
      executorKind: "codex",
      now: new Date("2026-08-14T11:59:00.000Z")
    }),
    status: "waiting_for_agent",
    terminal_binding_id: "binding-a",
    terminal_binding_generation: 7,
    native_thread_id: "thread-a",
    store_dir: "/store/session-a",
    gateway_method: "agent-knock-knock.callback",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-a",
      terminal_bridge_request_text: REQUEST_TEXT,
      terminal_agent_session_id: "thread-a"
    }
  };
}

function acceptanceEvidence(): TerminalSubmissionAcceptanceEvidence {
  const base = {
    source: "codex_rollout" as const,
    kind: "native_user_turn" as const,
    nativeThreadId: "thread-a",
    requestHash: REQUEST_HASH,
    acceptanceId: "acceptance-a",
    acceptedAt: RESOLVED_AT,
    anchorFingerprint: "a".repeat(64)
  };
  return {
    ...base,
    evidenceFingerprint: sha256(JSON.stringify(base))
  };
}

function statusOf(conversation: Conversation): string {
  return String(terminalBridgeSubmission(conversation)?.status);
}

function createHarness(options: HarnessOptions = {}) {
  const original = originalConversation();
  const receiptTerminalControl = options.receiptTerminalControl ??
    TERMINAL_CONTROL;
  const prepared = applyTerminalBridgeSubmission({
    conversation: original,
    messageId: "message-a",
    messageType: "task",
    messageBody: MESSAGE_BODY,
    requestText: REQUEST_TEXT,
    status: "prepared",
    preparedAt: PREPARED_AT
  }, {
    dispatcherPid: 4102,
    storeDir: "/store/session-a",
    terminalControl: receiptTerminalControl
  });
  const order: string[] = [];
  const states: Conversation[] = [];
  const ledgers: TerminalDispatchLedgerDocument[] = [];
  const events: EventRecord[] = [];
  let stagedConversation = prepared;
  let textInjectedAt: string | undefined;
  let enterDispatchedAt: string | undefined;
  const ports: TerminalDispatchApplicationPorts = {
    synchronizeStageProgress(conversation, stage, at) {
      order.push(`progress:${stage}:${at}`);
      stagedConversation = conversation;
      if (stage === "text_injected") {
        textInjectedAt = at;
      } else {
        enterDispatchedAt = at;
      }
    },
    state: {
      save(conversation) {
        const status = statusOf(conversation);
        order.push(`state:${status}`);
        if (options.failStateStatus === status) {
          throw options.failureError ?? new Error(`state ${status} failed`);
        }
        states.push(conversation);
      }
    },
    ledger: {
      save(ledger, phase) {
        const status = String(ledger.status);
        order.push(`ledger:${status}`);
        if (
          options.failLedgerStatus === status ||
          (phase === "final" && options.failFinalLedger)
        ) {
          throw options.failureError ?? new Error(`ledger ${status} failed`);
        }
        ledgers.push(ledger);
      },
      restore(reason, terminalInputNotStartedAt) {
        order.push(
          `restore:${reason}:${terminalInputNotStartedAt ?? "not-started"}`
        );
        if (options.failRestore) {
          throw new Error("restore failed");
        }
      }
    },
    audit: {
      append(event) {
        order.push(`event:${event.event}`);
        if (options.failEvent === event.event) {
          throw new Error(`event ${event.event} failed`);
        }
        events.push(event);
      },
      log(_level, event) {
        order.push(`log:${event}`);
      },
      recordBookkeepingFailure(phase) {
        order.push(`bookkeeping:${phase}`);
      },
      recordPersistenceFailure(phase) {
        order.push(`persistence:${phase}`);
      }
    },
    rollbackBeforeInput() {
      order.push("rollback");
      return options.rollbackResult ?? true;
    }
  };
  const application = new TerminalDispatchApplication({
    originalConversation: original,
    preparedConversation: prepared,
    message: { id: "message-a", type: "task", body: MESSAGE_BODY },
    executor: original.executor,
    terminalControl: TERMINAL_CONTROL,
    receiptTerminalControl,
    requestText: REQUEST_TEXT,
    requestHash: REQUEST_HASH,
    preparedAt: PREPARED_AT,
    statePath: STATE_PATH,
    eventLogPath: EVENT_LOG_PATH,
    previousGenerationId: "message-previous",
    dispatcherPid: 4102,
    storeDir: "/store/session-a",
    recordMessageAfterSend: false,
    recordRawAttachmentAfterSend: false,
    ledgerBindingFields: () => ({
      binding_id: "binding-a",
      binding_generation: 7,
      native_thread_id: "thread-a",
      store_dir: "/store/session-a",
      message_type: "task",
      message_body_hash: MESSAGE_BODY_HASH,
      executor_kind: "codex",
      openclaw_session: "agent:main:main"
    })
  }, ports);
  return {
    application,
    events,
    ledgers,
    order,
    original,
    prepared,
    progress: () => ({
      stagedConversation,
      textInjectedAt,
      enterDispatchedAt
    }),
    states
  };
}

async function advanceThroughEnter(
  harness: ReturnType<typeof createHarness>
): Promise<void> {
  harness.application.persistPrepared();
  await harness.application.recordTransportStage(
    "text_injected",
    TEXT_AT,
    () => {
      harness.order.push("boundary:text_injected");
    }
  );
  await harness.application.recordTransportStage(
    "enter_dispatched",
    ENTER_AT,
    () => {
      harness.order.push("boundary:enter_dispatched");
    }
  );
}

function expectedFinalLedger(
  evidence: TerminalSubmissionAcceptanceEvidence
): TerminalDispatchLedgerDocument {
  return {
    binding_id: "binding-a",
    binding_generation: 7,
    native_thread_id: "thread-a",
    store_dir: "/store/session-a",
    message_type: "task",
    message_body_hash: MESSAGE_BODY_HASH,
    executor_kind: "codex",
    openclaw_session: "agent:main:main",
    status: "agent_accepted",
    generation_id: "message-a",
    conversation_id: "turn-a",
    session_id: "session-a",
    turn_id: "turn-a",
    message_id: "message-a",
    request_hash: REQUEST_HASH,
    prepared_at: PREPARED_AT,
    text_injected_at: TEXT_AT,
    enter_dispatched_at: ENTER_AT,
    agent_accepted_at: RESOLVED_AT,
    acceptance_evidence: evidence,
    dispatcher_pid: null,
    state_path: STATE_PATH,
    event_log_path: EVENT_LOG_PATH,
    callback_expected: true,
    previous_generation_id: "message-previous"
  };
}

test("dispatch application preserves ledger/state/stage/final order and bytes", async () => {
  const harness = createHarness();
  await advanceThroughEnter(harness);
  const evidence = acceptanceEvidence();
  const result = harness.application.applyAcceptance(
    harness.progress().stagedConversation,
    { outcome: "agent_accepted", evidence },
    RESOLVED_AT
  );
  assert.deepEqual(harness.order, [
    "ledger:prepared",
    "state:prepared",
    `progress:text_injected:${TEXT_AT}`,
    "state:text_injected",
    "ledger:text_injected",
    "boundary:text_injected",
    "event:terminal_message_text_injected",
    `progress:enter_dispatched:${ENTER_AT}`,
    "state:enter_dispatched",
    "ledger:enter_dispatched",
    "boundary:enter_dispatched",
    "event:terminal_message_enter_dispatched",
    "state:agent_accepted",
    "ledger:agent_accepted",
    "event:terminal_message_agent_accepted"
  ]);
  const finalLedger = harness.ledgers.at(-1);
  const expectedLedger = expectedFinalLedger(evidence);
  assert.deepEqual(Object.keys(finalLedger ?? {}), Object.keys(expectedLedger));
  assert.equal(
    `${JSON.stringify(finalLedger, null, 2)}\n`,
    `${JSON.stringify(expectedLedger, null, 2)}\n`
  );
  const finalReceipt = terminalBridgeSubmission(result.conversation);
  const expectedReceipt = {
    ...terminalBridgeSubmission(harness.prepared),
    status: "agent_accepted",
    dispatcher_pid: 4102,
    last_proven_stage: "agent_accepted",
    text_injected_at: TEXT_AT,
    enter_dispatched_at: ENTER_AT,
    agent_accepted_at: RESOLVED_AT,
    acceptance_evidence: evidence
  };
  assert.deepEqual(Object.keys(finalReceipt ?? {}), Object.keys(expectedReceipt));
  assert.equal(
    `${JSON.stringify(finalReceipt, null, 2)}\n`,
    `${JSON.stringify(expectedReceipt, null, 2)}\n`
  );
});

test("prepared failures restore the ledger then roll back before input", () => {
  const ledgerFailure = createHarness({ failLedgerStatus: "prepared" });
  assert.throws(
    () => ledgerFailure.application.persistPrepared(),
    /ledger prepared failed/u
  );
  assert.deepEqual(ledgerFailure.order, [
    "ledger:prepared",
    "restore:prepared ledger persistence failed before terminal input:not-started",
    "rollback"
  ]);

  const stateFailure = createHarness({ failStateStatus: "prepared" });
  assert.throws(
    () => stateFailure.application.persistPrepared(),
    /state prepared failed/u
  );
  assert.deepEqual(stateFailure.order, [
    "ledger:prepared",
    "state:prepared",
    "restore:prepared state persistence failed before terminal input:not-started",
    "rollback"
  ]);
});

test("text progress fences TerminalInputNotStarted across stage failures", async () => {
  for (const point of ["state", "ledger", "boundary"] as const) {
    const failure = new TerminalInputNotStartedError(`${point} failed`);
    const harness = createHarness({
      ...(point === "state" ? { failStateStatus: "text_injected" } : {}),
      ...(point === "ledger" ? { failLedgerStatus: "text_injected" } : {}),
      failureError: failure
    });
    harness.application.persistPrepared();
    harness.order.length = 0;
    let thrown: unknown;
    try {
      await harness.application.recordTransportStage(
        "text_injected",
        TEXT_AT,
        () => {
          harness.order.push("boundary:text_injected");
          if (point === "boundary") {
            throw failure;
          }
        }
      );
    } catch (error) {
      thrown = error;
    }
    assert.equal(thrown, failure, point);
    assert.deepEqual(
      harness.order,
      [
        `progress:text_injected:${TEXT_AT}`,
        "state:text_injected",
        "ledger:text_injected",
        "boundary:text_injected"
      ].slice(0, point === "state" ? 2 : point === "ledger" ? 3 : 4),
      point
    );
    const progress = harness.progress();
    assert.equal(statusOf(progress.stagedConversation), "text_injected", point);
    assert.equal(progress.textInjectedAt, TEXT_AT, point);
    const wouldRecordZeroInput = !progress.textInjectedAt &&
      thrown instanceof TerminalInputNotStartedError;
    assert.equal(wouldRecordZeroInput, false, point);
  }
});

test("receipt identity stays stored while audit uses the refreshed route", async () => {
  const harness = createHarness({
    receiptTerminalControl: { ...TERMINAL_CONTROL, target: "%6" }
  });
  harness.application.persistPrepared();
  await harness.application.recordTransportStage(
    "text_injected",
    TEXT_AT,
    () => {}
  );
  assert.equal(
    terminalBridgeSubmission(harness.states.at(-1))?.terminal_target,
    "%6"
  );
  assert.equal(harness.events.at(-1)?.terminal_control, TERMINAL_CONTROL);
});

test("final ledger failure remains bookkeeping debt and still appends event", async () => {
  const harness = createHarness({ failFinalLedger: true });
  await advanceThroughEnter(harness);
  harness.order.length = 0;
  harness.application.applyAcceptance(
    harness.progress().stagedConversation,
    { outcome: "agent_accepted", evidence: acceptanceEvidence() },
    RESOLVED_AT
  );
  assert.deepEqual(harness.order, [
    "state:agent_accepted",
    "ledger:agent_accepted",
    "bookkeeping:final_terminal_ledger",
    "event:terminal_message_agent_accepted"
  ]);
});

test("identity failure preserves quarantine then ledger/state/event/log order", async () => {
  const harness = createHarness();
  await advanceThroughEnter(harness);
  harness.order.length = 0;
  harness.application.applyIdentityFailure(
    RESOLVED_AT,
    "native identity missing",
    () => harness.order.push("quarantine")
  );
  assert.deepEqual(harness.order, [
    "quarantine",
    "ledger:uncertain",
    "state:uncertain",
    "event:terminal_agent_identity_binding_failed",
    "log:terminal_agent_identity_binding_failed"
  ]);
});

test("generic uncertainty preserves ledger/state/event order and error key bytes", async () => {
  const harness = createHarness();
  await advanceThroughEnter(harness);
  harness.order.length = 0;
  harness.application.applyUncertain(RESOLVED_AT, new Error("transport failed"));
  assert.deepEqual(harness.order, [
    "ledger:uncertain",
    "state:uncertain",
    "event:terminal_message_submit_uncertain"
  ]);
  const ledger = harness.ledgers.at(-1);
  assert.deepEqual(Object.keys(ledger ?? {}).slice(-6), [
    "dispatcher_pid",
    "state_path",
    "event_log_path",
    "callback_expected",
    "error",
    "previous_generation_id"
  ]);
  assert.equal(
    `${JSON.stringify(ledger?.error, null, 2)}\n`,
    `${JSON.stringify(terminalDispatchTextSummary("transport failed"), null, 2)}\n`
  );
});

test("zero-input setup and transport keep their distinct receipt authority", () => {
  const setup = createHarness({ failStateStatus: "aborted" });
  setup.application.persistPrepared();
  setup.order.length = 0;
  const setupFailure = setup.application.recordZeroInputAbort({
    failureKind: "setup",
    error: new Error("setup failed"),
    abortedAt: RESOLVED_AT
  });
  assert.deepEqual(setup.order, [
    "restore:terminal submission aborted before terminal input:not-started",
    "rollback",
    "state:aborted",
    "persistence:terminal_message_submit_aborted_persist_failed",
    "event:terminal_message_submit_aborted",
    "log:terminal_message_submit_aborted"
  ]);
  assert.equal(
    terminalBridgeSubmission(setupFailure.receiptConversation)?.safe_to_retry,
    true
  );
  assert.equal(
    terminalBridgeSubmission(setupFailure.reportedConversation)?.safe_to_retry,
    false
  );

  const transport = createHarness({ failStateStatus: "aborted" });
  transport.application.persistPrepared();
  transport.order.length = 0;
  const transportFailure = transport.application.recordZeroInputAbort({
    failureKind: "transport",
    error: new Error("transport failed"),
    abortedAt: RESOLVED_AT
  });
  assert.deepEqual(transport.order, [
    `restore:terminal transport was proved not to have started:${RESOLVED_AT}`,
    "rollback",
    "state:aborted",
    "persistence:terminal_message_submit_aborted_persist_failed",
    "event:terminal_message_submit_aborted",
    "log:terminal_message_submit_aborted"
  ]);
  assert.equal(
    transportFailure.receiptConversation,
    transportFailure.reportedConversation
  );
  assert.equal(
    terminalBridgeSubmission(transportFailure.receiptConversation)?.safe_to_retry,
    false
  );
});

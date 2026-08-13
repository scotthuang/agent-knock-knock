import assert from "node:assert/strict";
import test from "node:test";
import {
  TerminalDispatchService,
  type TerminalBridgeSubmissionMutation
} from "../src/terminal-dispatch-service.js";
import {
  createConversation,
  createMessage,
  type Conversation
} from "../src/protocol.js";

type Failure =
  | "prepared_ledger"
  | "prepared_state"
  | "final_ledger"
  | "acceptance_event"
  | "monitor";

const terminalControl = {
  kind: "tmux" as const,
  target: "%7",
  session: "akk",
  window: 1,
  pane: 2,
  panePid: 4321,
  capabilities: []
};

function fixture(failure?: Failure, setupFailureInjected = false) {
  const conversation = createConversation({
    sessionId: "session-1",
    turnId: "turn-1",
    userRequest: "ship it",
    executorKind: "codex",
    now: new Date("2026-08-14T00:00:00.000Z")
  });
  const message = {
    ...createMessage({
      conversation,
      from: "openclaw",
      to: "codex",
      type: "task",
      body: "ship it"
    }),
    type: "task" as const
  };
  const preparedConversation = withSubmission({
    conversation,
    messageId: message.id,
    requestText: message.body,
    status: "prepared",
    preparedAt: "2026-08-14T00:00:01.000Z"
  });
  const calls: string[] = [];
  const printed: Record<string, unknown>[] = [];
  let savedState: Conversation | undefined;
  const fail = (candidate: Failure): void => {
    if (failure === candidate) {
      throw new Error(`failed:${candidate}`);
    }
  };
  const service = new TerminalDispatchService({
    bridgeEnabled: true,
    conversation,
    preparedConversation,
    message,
    executor: conversation.executor,
    terminalControl,
    terminalPayload: message.body,
    terminalRequestHash: "request-hash",
    bridgeStartedAt: "2026-08-14T00:00:01.000Z",
    statePath: "/store/conversations/turn-1/state.json",
    logPath: "/store/conversations/turn-1/events.ndjson",
    recordMessageAfterSend: false,
    recordRawAttachmentAfterSend: false,
    setupFailureInjected,
    abortedStatePersistenceFailureInjected: false,
    finalLedgerFailureInjected: false,
    dispatcherPid: 99,
    agentTimeoutMinutes: 60,
    agentHardTimeoutMinutes: 720
  }, {
    nowIso: () => "2026-08-14T00:00:02.000Z",
    withSubmission,
    ledgerFields: () => ({}),
    saveState: (state) => {
      const status = submissionStatus(state);
      calls.push(`state:${status}`);
      if (status === "prepared") fail("prepared_state");
      savedState = state;
    },
    saveLedger: (ledger) => {
      const status = String(ledger.status);
      calls.push(`ledger:${status}`);
      if (status === "prepared") fail("prepared_ledger");
      if (status === "agent_accepted") fail("final_ledger");
    },
    appendEvent: (event) => {
      calls.push(`event:${event.event}`);
      if (event.event === "terminal_message_agent_accepted") {
        fail("acceptance_event");
      }
    },
    appendMessage: () => undefined,
    log: () => undefined,
    print: (value) => printed.push(value),
    abortDeferredPreInput: () => {
      calls.push("abort_deferred");
      return false;
    },
    rollbackRawAttach: () => {
      calls.push("rollback_attach");
      return true;
    },
    markDeferredUncertain: () => calls.push("transfer_uncertain"),
    stallOtherConversations: () => {
      calls.push("stall_others");
      return [];
    },
    startMonitor: () => {
      calls.push("monitor");
      fail("monitor");
      return { pid: 88 };
    }
  });
  return {
    service,
    calls,
    printed,
    get savedState() {
      return savedState;
    }
  };
}

function submissionStatus(conversation: Conversation): string {
  const takeover = conversation.native_session_takeover as
    Record<string, Record<string, unknown>>;
  return String(takeover.terminal_bridge_submission.status);
}

function withSubmission(
  mutation: TerminalBridgeSubmissionMutation
): Conversation {
  return {
    ...mutation.conversation,
    native_session_takeover: {
      terminal_bridge_submission: {
        status: mutation.status,
        message_id: mutation.messageId,
        prepared_at: mutation.preparedAt,
        text_injected_at: mutation.textInjectedAt,
        enter_dispatched_at: mutation.enterDispatchedAt
      }
    }
  };
}

test("prepared failures restore the ledger before raw-attach rollback", () => {
  const cases = [
    [
      "prepared_ledger",
      [
        "ledger:prepared",
        "abort_deferred",
        "ledger:resolved",
        "rollback_attach"
      ]
    ],
    [
      "prepared_state",
      [
        "ledger:prepared",
        "state:prepared",
        "abort_deferred",
        "ledger:resolved",
        "rollback_attach"
      ]
    ]
  ] as const;
  for (const [failure, expected] of cases) {
    const current = fixture(failure);
    assert.throws(
      () => current.service.persistPrepared(),
      new RegExp(`failed:${failure}`)
    );
    assert.deepEqual(current.calls, expected);
  }
});

test("setup failure records a retryable zero-input abort", () => {
  const current = fixture(undefined, true);
  assert.equal(current.service.recordPreparedBookkeeping(), true);
  assert.deepEqual(current.calls, [
    "abort_deferred",
    "ledger:resolved",
    "rollback_attach",
    "state:aborted",
    "event:terminal_message_submit_aborted"
  ]);
  assert.equal(current.printed[0]?.submission_outcome, "aborted");
  assert.equal(current.printed[0]?.safe_to_retry, true);
});

test("transport proof aborts before input but fences after text", async () => {
  const cases = [
    [
      false,
      "aborted",
      [
        "abort_deferred",
        "ledger:resolved",
        "rollback_attach",
        "state:aborted",
        "event:terminal_message_submit_aborted"
      ]
    ],
    [
      true,
      "uncertain",
      [
        "ledger:uncertain",
        "state:uncertain",
        "event:terminal_message_submit_uncertain",
        "stall_others"
      ]
    ]
  ] as const;
  for (const [afterText, outcome, expected] of cases) {
    const current = fixture();
    if (afterText) await current.service.recordTransportStage("text_injected");
    current.calls.length = 0;
    current.service.handleTransportFailure(new Error("transport"), true);
    assert.deepEqual(current.calls, expected);
    assert.equal(current.printed[0]?.submission_outcome, outcome);
  }
});

test("final bookkeeping failures preserve the accepted state", async () => {
  for (const failure of [
    "final_ledger",
    "acceptance_event",
    "monitor"
  ] as const) {
    const current = fixture(failure);
    await current.service.recordTransportStage("text_injected");
    await current.service.recordTransportStage("enter_dispatched");
    current.calls.length = 0;
    const result = current.service.commitAcceptance(
      current.service.progress().stagedConversation,
      {
        outcome: "agent_accepted",
        evidence: {
          source: "codex_rollout",
          kind: "native_user_turn",
          nativeThreadId: "thread-1",
          requestHash: "request-hash",
          acceptanceId: "acceptance-1",
          anchorFingerprint: "anchor",
          evidenceFingerprint: "evidence"
        }
      }
    );
    assert.equal(submissionStatus(result.deliveredConversation), "agent_accepted");
    assert.equal(submissionStatus(current.savedState!), "agent_accepted");
    assert.equal(result.bookkeepingWarning, `failed:${failure}`);
    assert.equal(current.calls[0], "state:agent_accepted");
    assert.equal(current.calls.some((call) => call.includes("uncertain")), false);
  }
});

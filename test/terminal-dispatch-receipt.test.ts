import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createConversation, type Conversation } from "../src/protocol.js";
import { callbackRouteFingerprintForConversation } from
  "../src/callback-route-authority.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";
import {
  applyTerminalBridgeSubmission,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission,
  terminalBridgeSubmissionReceipts,
  unresolvedTerminalBridgeSubmission,
  withTerminalBridgeState
} from "../src/terminal-dispatch-receipt.js";

const STARTED_AT = "2026-08-14T12:00:00.000Z";
const REQUEST_TEXT = "Please inspect the dispatch transaction.\n";
const MESSAGE_BODY = "Inspect the dispatch transaction.";
const STORE_DIR = "/store/session-a";
const TERMINAL_CONTROL: TerminalControlRef = {
  kind: "herdr",
  target: "default:workspace-a:pane-a",
  socketPath: "/tmp/herdr.sock",
  session: "default",
  sessionDir: "/runtime/herdr/default",
  workspaceId: "workspace-a",
  tabId: "tab-a",
  paneId: "pane-a",
  terminalId: "terminal-a",
  panePid: 5102,
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function conversation(): Conversation {
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
    store_dir: STORE_DIR,
    native_session_takeover: {
      terminal_agent_session_id: "thread-a"
    }
  };
}

function preparedReceipt(base = conversation()): Conversation {
  return applyTerminalBridgeSubmission({
    conversation: base,
    messageId: "message-a",
    messageType: "task",
    messageBody: MESSAGE_BODY,
    requestText: REQUEST_TEXT,
    status: "prepared",
    preparedAt: STARTED_AT
  }, {
    dispatcherPid: 4102,
    storeDir: STORE_DIR,
    terminalControl: TERMINAL_CONTROL
  });
}

test("terminal bridge state preserves exact keys and pretty JSON bytes", () => {
  const base = conversation();
  const actual = withTerminalBridgeState({
    conversation: base,
    message: { id: "message-a" },
    requestText: REQUEST_TEXT,
    startedAt: STARTED_AT,
    agentTimeoutMinutes: 15,
    agentHardTimeoutMinutes: 60,
    monitorLockVersion: 3,
    preSendScreenFingerprint: "screen-a",
    codexRolloutAcceptanceAnchor: { version: 2 },
    claudeTranscriptAnchor: undefined,
    claudeHome: undefined
  });
  const expected = {
    ...base,
    native_session_takeover: {
      terminal_agent_session_id: "thread-a",
      terminal_bridge: true,
      terminal_bridge_started_at: STARTED_AT,
      terminal_bridge_message_id: "message-a",
      terminal_bridge_request_text: REQUEST_TEXT,
      terminal_bridge_request_hash: sha256(REQUEST_TEXT),
      terminal_bridge_pre_send_screen_fingerprint: "screen-a",
      codex_rollout_acceptance_anchor: { version: 2 },
      claude_transcript_anchor: undefined,
      claude_home: undefined,
      terminal_bridge_completion_claim: undefined,
      terminal_bridge_approval_dispatch: undefined,
      terminal_bridge_detector_diagnostic: undefined,
      terminal_bridge_monitor_lock_version: 3,
      terminal_bridge_monitor_started_at: STARTED_AT,
      terminal_bridge_last_activity_at: STARTED_AT,
      terminal_bridge_inactivity_timeout_minutes: 15,
      terminal_bridge_hard_timeout_minutes: 60,
      terminal_bridge_inactivity_deadline_at: "2026-08-14T12:15:00.000Z",
      terminal_bridge_hard_deadline_at: "2026-08-14T13:00:00.000Z"
    },
    updated_at: STARTED_AT
  };
  assert.deepEqual(
    Object.keys(actual.native_session_takeover as object),
    Object.keys(expected.native_session_takeover)
  );
  assert.equal(
    `${JSON.stringify(actual, null, 2)}\n`,
    `${JSON.stringify(expected, null, 2)}\n`
  );
});

test("prepared receipt preserves exact Object.keys and durable state bytes", () => {
  const actual = terminalBridgeSubmission(preparedReceipt());
  const expected = {
    status: "prepared",
    session_id: "session-a",
    turn_id: "turn-a",
    message_id: "message-a",
    binding_id: "binding-a",
    binding_generation: 7,
    message_type: "task",
    message_body_hash: sha256(MESSAGE_BODY),
    request_hash: sha256(REQUEST_TEXT),
    executor_kind: "codex",
    openclaw_session: "agent:main:main",
    callback_route_fingerprint: null,
    store_dir: STORE_DIR,
    native_thread_id: "thread-a",
    terminal_target: TERMINAL_CONTROL.target,
    terminal_socket_path: TERMINAL_CONTROL.socketPath,
    terminal_pane_pid: TERMINAL_CONTROL.panePid,
    terminal_endpoint: terminalControlEvidence(TERMINAL_CONTROL),
    prepared_at: STARTED_AT,
    dispatcher_pid: 4102,
    last_proven_stage: "prepared"
  };
  assert.deepEqual(Object.keys(actual ?? {}), Object.keys(expected));
  assert.equal(
    `${JSON.stringify(actual, null, 2)}\n`,
    `${JSON.stringify(expected, null, 2)}\n`
  );
  assert.deepEqual(terminalBridgeSubmissionReceipts(preparedReceipt()), [expected]);
  assert.deepEqual(unresolvedTerminalBridgeSubmission(preparedReceipt()), expected);
  assert.equal(terminalBridgeRequestFingerprint(""), undefined);
});

test("receipt history is append-only and immutable within one generation", () => {
  const prepared = preparedReceipt();
  const injected = applyTerminalBridgeSubmission({
    conversation: prepared,
    messageId: "message-a",
    requestText: REQUEST_TEXT,
    status: "text_injected",
    preparedAt: STARTED_AT,
    textInjectedAt: "2026-08-14T12:00:01.000Z"
  }, {
    dispatcherPid: 9999,
    storeDir: STORE_DIR,
    terminalControl: TERMINAL_CONTROL
  });
  assert.equal(terminalBridgeSubmissionReceipts(injected).length, 1);
  assert.equal(terminalBridgeSubmission(injected)?.dispatcher_pid, 4102);

  const next = applyTerminalBridgeSubmission({
    conversation: injected,
    messageId: "message-b",
    messageType: "answer",
    messageBody: "Second message",
    requestText: "Second request",
    status: "prepared",
    preparedAt: "2026-08-14T12:01:00.000Z"
  }, {
    dispatcherPid: 5102,
    storeDir: STORE_DIR,
    terminalControl: TERMINAL_CONTROL
  });
  assert.deepEqual(
    terminalBridgeSubmissionReceipts(next).map((receipt) => receipt.message_id),
    ["message-a", "message-b"]
  );

  assert.throws(
    () => applyTerminalBridgeSubmission({
      conversation: {
        ...injected,
        terminal_binding_id: "binding-b"
      },
      messageId: "message-a",
      requestText: REQUEST_TEXT,
      status: "enter_dispatched",
      preparedAt: STARTED_AT,
      textInjectedAt: "2026-08-14T12:00:01.000Z",
      enterDispatchedAt: "2026-08-14T12:00:02.000Z"
    }, {
      dispatcherPid: 4102,
      storeDir: STORE_DIR,
      terminalControl: TERMINAL_CONTROL
    }),
    /changed immutable binding_id/u
  );
});

test("dispatch receipt binds a canonical callback route fingerprint", () => {
  const routedConversation: Conversation = {
    ...conversation(),
    gateway_method: "agent.callback",
    gateway_session: "agent:controller:one"
  };
  const prepared = preparedReceipt(routedConversation);
  const expected = callbackRouteFingerprintForConversation(routedConversation);
  assert.ok(expected);
  assert.equal(
    terminalBridgeSubmission(prepared)?.callback_route_fingerprint,
    expected
  );

  assert.throws(
    () => applyTerminalBridgeSubmission({
      conversation: {
        ...prepared,
        gateway_session: "agent:controller:redirected"
      },
      messageId: "message-a",
      requestText: REQUEST_TEXT,
      status: "text_injected",
      preparedAt: STARTED_AT,
      textInjectedAt: "2026-08-14T12:00:01.000Z"
    }, {
      dispatcherPid: 4102,
      storeDir: STORE_DIR,
      terminalControl: TERMINAL_CONTROL
    }),
    /changed immutable callback_route_fingerprint/u
  );
});

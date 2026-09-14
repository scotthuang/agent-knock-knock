import assert from "node:assert/strict";
import test from "node:test";

import type { TerminalBridgeStatus } from
  "../src/terminal-agent-bridge.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import {
  assertSafeUserExplicitTerminalSend,
  assertTerminalNativeBindingBeforeSend,
  assertTerminalPreSendStatus,
  terminalPreSendRuntime
} from "../src/terminal-command-send-preflight.js";
import type { TerminalControlSendRequest } from
  "../src/terminal-dispatch-composition.js";
import type { TerminalDispatchExecutionService } from
  "../src/terminal-dispatch-execution.js";

function status(
  overrides: Partial<TerminalBridgeStatus> = {}
): TerminalBridgeStatus {
  return {
    reachable: true,
    activity_state: "idle",
    activity_reason: "fixture idle",
    approval_state: { scanned: true, blocked: false },
    screen: {},
    ...overrides
  } as TerminalBridgeStatus;
}

function request(
  overrides: Partial<TerminalControlSendRequest> = {}
): TerminalControlSendRequest {
  return {
    transaction: {} as TerminalControlSendRequest["transaction"],
    options: {},
    conversation: { conversation_id: "turn-1" } as
      TerminalControlSendRequest["conversation"],
    nextConversation: { conversation_id: "turn-1" } as
      TerminalControlSendRequest["nextConversation"],
    executor: { kind: "codex", display_name: "Codex" } as
      TerminalControlSendRequest["executor"],
    message: { id: "message-1", type: "task", body: "hello" } as
      TerminalControlSendRequest["message"],
    ...overrides
  };
}

test("human-priority preflight retains the shared physical exclusion gate", () => {
  assert.doesNotThrow(() => assertSafeUserExplicitTerminalSend(status()));
  assert.throws(
    () => assertSafeUserExplicitTerminalSend(undefined),
    /unreachable/u
  );
  assert.throws(
    () => assertSafeUserExplicitTerminalSend(status({
      approval_state: {
        scanned: true,
        blocked: true,
        approvable: false,
        reason: "approval"
      }
    })),
    /approval/u
  );
  assert.throws(
    () => assertSafeUserExplicitTerminalSend(status({
      interaction_state: {} as TerminalBridgeStatus["interaction_state"]
    })),
    /questionnaire/u
  );
});

test("ordinary and deferred preflight keep distinct fail-closed policy", () => {
  const calls: string[] = [];
  const ports = {
    assertSafeTerminalSend: () => calls.push("ordinary")
  };
  assertTerminalPreSendStatus({ request: request(), status: status() }, ports);
  assert.deepEqual(calls, ["ordinary"]);

  const deferred = request({
    postSendCodexCandidateAnchor: {} as NonNullable<
      TerminalControlSendRequest["postSendCodexCandidateAnchor"]
    >
  });
  assert.doesNotThrow(() => assertTerminalPreSendStatus({
    request: deferred,
    status: status({ activity_state: "unknown" })
  }, ports));
  assert.deepEqual(calls, ["ordinary"]);
  assert.throws(() => assertTerminalPreSendStatus({
    request: deferred,
    status: status({ interaction_state: {} as never })
  }, ports), /safe prompt/u);
});

test("pre-send runtime uses physical-only identity for candidate acceptance", () => {
  const calls: string[] = [];
  const terminalControl = {
    kind: "tmux",
    target: "demo:0.0",
    session: "demo",
    window: 0,
    pane: 0,
    panePid: 42,
    capabilities: []
  } as TerminalControlRef;
  const candidate = request({
    postSendCodexCandidateAnchor: {} as NonNullable<
      TerminalControlSendRequest["postSendCodexCandidateAnchor"]
    >
  });
  const runtime = terminalPreSendRuntime({
    request: candidate,
    terminalControl,
    terminalAgentPid: 42
  }, {
    terminalRuntimeForLiveIdentity: (input) => {
      calls.push(`physical:${input.physicalOnly}`);
      return { pid: 42 } as never;
    },
    terminalRuntimeIdentityForConversation: () => {
      calls.push("conversation");
      return {} as never;
    }
  });
  assert.deepEqual(calls, ["physical:true"]);
  assert.equal(runtime.messageId, "message-1");
});

test("native binding preflight validates the exact existing Turn identity", () => {
  const calls: unknown[] = [];
  const execution = {
    assertTurnIdentity: (input: unknown) => calls.push(input)
  } as unknown as TerminalDispatchExecutionService;
  assertTerminalNativeBindingBeforeSend({
    execution,
    conversation: request().conversation,
    needsPostSendNativeBinding: false
  });
  assert.equal(calls.length, 1);
});

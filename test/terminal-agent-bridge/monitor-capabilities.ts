import {
  test,
  assert,
  PANE,
  RecordingTerminalProvider,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  type TerminalAgentAdapter,
  type TerminalCompletionEvidence,
  type TerminalDurableCompletionRequest
} from "../support/terminal-agent-bridge-contract-support.js";

test("monitor dispatches durable completion without requiring Codex context", async () => {
  let receivedRequest: TerminalDurableCompletionRequest | undefined;
  const durableEvidence: TerminalCompletionEvidence = {
    source: "durable",
    text: "Claude durable result",
    id: "claude-turn-1",
    confidence: "high"
  };
  const adapter = createTestClaudeAdapter({
    async detectDurableCompletion(request) {
      receivedRequest = request;
      return durableEvidence;
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "idle screen-complete"
  });
  const bridge = createBridge(adapter, provider);
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-1",
    cwd: "/repo",
    requestText: "finish the task",
    startedAt: "2026-07-22T10:00:00.000Z"
  };

  const poll = await bridge.monitorPoll({
    agent: "claude",
    terminalControl: terminalControl(adapter),
    durableRequest
  });

  assert.deepEqual(receivedRequest, durableRequest);
  assert.equal(Object.hasOwn(receivedRequest ?? {}, "context"), false);
  assert.equal(poll.inspection?.completion?.source, "screen");
  assert.equal(poll.durableCompletion, durableEvidence);
  assert.equal(poll.completion, durableEvidence);
  assert.equal(poll.status.agent, "claude");
});

test("missing adapter and semantic capabilities fail closed without terminal input", async () => {
  const adapter = createTestClaudeAdapter({
    capabilities: {
      screenStatus: false,
      terminalApproval: false,
      screenCompletion: false,
      durableCompletion: false,
      cancellation: false
    },
    cancelKeys: []
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:must not be read"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const unsupportedAgent = "unknown-agent" as never;

  assert.throws(
    () => bridge.adapterFor(unsupportedAgent),
    /terminal agent adapter is not registered for unknown-agent/
  );
  await assert.rejects(
    () => bridge.discoverProcesses([], [unsupportedAgent]),
    /terminal agent adapter is not registered for unknown-agent/
  );

  const status = await bridge.status("claude", control);
  assert.equal(status.activity_state, "unknown");
  assert.match(status.capability_limitation ?? "", /screen status is not supported/);
  const approval = await bridge.approve("claude", control);
  assert.equal(approval.approved, false);
  assert.equal(approval.blocked, true);
  assert.match(approval.reason ?? "", /approval is not supported/);
  const cancellation = await bridge.cancel("claude", control);
  assert.equal(cancellation.cancelRequested, false);
  assert.match(cancellation.reason ?? "", /cancellation is not supported/);
  assert.deepEqual(provider.operations, []);
});

test("bridge gates semantic actions on the capabilities stored with the terminal reference", async () => {
  let inspectionCalls = 0;
  let durableCalls = 0;
  const baseAdapter = createTestClaudeAdapter();
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...baseAdapter,
    inspectScreen(options) {
      inspectionCalls += 1;
      return {
        ...baseAdapter.inspectScreen(options),
        completion: {
          source: "screen",
          text: "must be hidden without screen_completion"
        }
      };
    },
    async detectDurableCompletion() {
      durableCalls += 1;
      return {
        source: "durable",
        text: "must be hidden without durable_completion"
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);
  const inputOnlyControl = {
    ...terminalControl(adapter),
    capabilities: ["send_keys" as const]
  };

  const status = await bridge.status("claude", inputOnlyControl);
  assert.equal(status.approval_state.scanned, false);
  assert.match(status.capability_limitation ?? "", /screen status is not supported/);

  const approval = await bridge.approve("claude", inputOnlyControl, {
    expectedFingerprint: "untrusted-caller-fingerprint"
  });
  assert.equal(approval.approved, false);
  assert.match(approval.reason ?? "", /approval is not supported/);

  const cancellation = await bridge.cancel("claude", inputOnlyControl);
  assert.equal(cancellation.cancelRequested, false);
  assert.match(cancellation.reason ?? "", /cancellation is not supported/);

  const noCapturePoll = await bridge.monitorPoll({
    agent: "claude",
    terminalControl: inputOnlyControl,
    durableRequest: { sessionId: "claude-session-1" }
  });
  assert.equal(noCapturePoll.completion, undefined);
  assert.equal(inspectionCalls, 0);
  assert.equal(durableCalls, 0);
  assert.equal(provider.operations.length, 0);

  const screenStatusOnlyControl = {
    ...terminalControl(adapter),
    capabilities: ["send_keys" as const, "screen_status" as const]
  };
  const screenStatusOnlyPoll = await bridge.monitorPoll({
    agent: "claude",
    terminalControl: screenStatusOnlyControl,
    durableRequest: { sessionId: "claude-session-1" }
  });
  assert.equal(inspectionCalls, 1);
  assert.equal(durableCalls, 0);
  assert.equal(screenStatusOnlyPoll.inspection?.completion?.source, "screen");
  assert.equal(screenStatusOnlyPoll.completion, undefined);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

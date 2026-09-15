import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  TerminalAgentBridge,
  TerminalInputNotStartedError,
  PANE,
  RecordingTerminalProvider,
  CapabilityLimitedTerminalProvider,
  SequencedResolutionProvider,
  endpointForPane,
  stablePane,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  type TerminalCompletionEvidence
} from "../support/terminal-agent-bridge-contract-support.js";

test("durable completion dispatch survives unavailable screen inspection", async (t) => {
  const evidence: TerminalCompletionEvidence = {
    source: "durable",
    text: "durable result"
  };

  await t.test("screen capture failure", async () => {
    let durableCalls = 0;
    const adapter = createTestClaudeAdapter({
      async detectDurableCompletion() {
        durableCalls += 1;
        return evidence;
      }
    });
    const provider = new RecordingTerminalProvider([PANE]);
    provider.capture = async () => {
      throw new Error("tmux capture failed");
    };
    const poll = await createBridge(adapter, provider).monitorPoll({
      agent: "claude",
      terminalControl: terminalControl(adapter),
      durableRequest: { sessionId: "claude-session-1" }
    });

    assert.equal(durableCalls, 1);
    assert.equal(poll.status.reachable, false);
    assert.match(poll.status.screen.error ?? "", /tmux capture failed/);
    assert.equal(poll.completion, evidence);
  });

  await t.test("screen status unsupported", async () => {
    let durableCalls = 0;
    const adapter = createTestClaudeAdapter({
      capabilities: { screenStatus: false },
      async detectDurableCompletion() {
        durableCalls += 1;
        return evidence;
      }
    });
    const provider = new RecordingTerminalProvider([PANE]);
    const poll = await createBridge(adapter, provider).monitorPoll({
      agent: "claude",
      terminalControl: terminalControl(adapter),
      durableRequest: { sessionId: "claude-session-1" }
    });

    assert.equal(durableCalls, 1);
    assert.match(poll.status.capability_limitation ?? "", /screen status is not supported/);
    assert.equal(poll.completion, evidence);
    assert.deepEqual(provider.operations, []);
  });
});

test("monitor reports an explicit limitation without screen or durable completion", async () => {
  const adapter = createTestClaudeAdapter({
    capabilities: { screenCompletion: false, durableCompletion: false }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "idle"
  });

  const poll = await createBridge(adapter, provider).monitorPoll({
    agent: "claude",
    terminalControl: terminalControl(adapter),
    durableRequest: { sessionId: "claude-session-1" }
  });

  assert.equal(poll.completion, undefined);
  assert.match(
    poll.status.capability_limitation ?? "",
    /terminal completion detection is not supported/
  );
});

test("send requires both a registered agent and send_keys capability", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const unsupportedAgent = "unknown-agent" as never;

  await assert.rejects(
    () => bridge.send(unsupportedAgent, control, "do work"),
    /terminal agent adapter is not registered for unknown-agent/
  );
  await assert.rejects(
    () => bridge.send("claude", { ...control, capabilities: [] }, "do work"),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInputNotStartedError);
      assert.match(error.message, /terminal:send_keys/u);
      return true;
    }
  );
  assert.deepEqual(provider.operations, []);
});

test("send preflights compound transport capabilities before terminal input", async () => {
  const adapter = createTestClaudeAdapter();
  const pane = stablePane("claude-capabilities:1.2");
  const provider = new CapabilityLimitedTerminalProvider(
    ["stable_resource_resolution", "text_delivery"],
    [pane]
  );
  const [endpoint] = await provider.listTerminals();
  assert.ok(endpoint);
  const control = provider.toControlRef(endpoint, ["send_keys"]);

  await assert.rejects(
    createBridge(adapter, provider).send("claude", control, "do work"),
    (error: unknown) => {
      assert.ok(error instanceof TerminalInputNotStartedError);
      assert.equal(error.code, "AKK_TERMINAL_INPUT_NOT_STARTED");
      assert.match(error.message, /provider:key_delivery/u);
      return true;
    }
  );
  assert.deepEqual(provider.operations, []);
});

test("approval preflights capture and key capabilities before observation or reservation", async () => {
  const adapter = createTestClaudeAdapter();
  const pane = stablePane("claude-approval-capabilities:1.2");
  const provider = new CapabilityLimitedTerminalProvider(
    ["stable_resource_resolution", "screen_capture"],
    [pane],
    { [pane.target]: "approval:npm test" }
  );
  const [endpoint] = await provider.listTerminals();
  assert.ok(endpoint);
  const control = provider.toControlRef(endpoint, [
    "screen_status",
    "send_keys",
    "terminal_approval"
  ]);

  await assert.rejects(
    createBridge(adapter, provider).approve("claude", control, {
      expectedFingerprint: "caller-supplied-fingerprint"
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        (error as Error & { code?: string }).code,
        "AKK_TERMINAL_INPUT_NOT_SENT"
      );
      assert.match(error.message, /provider:key_delivery/u);
      return true;
    }
  );
  assert.deepEqual(provider.operations, []);
});

test("stale terminal identity is rejected before any tmux input", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      throw new Error("agent pid no longer belongs to the pane");
    }
  });

  await assert.rejects(
    () => bridge.resolveConversationId(
      `terminal:v2:tmux:claude:${PANE.target}:110`
    ),
    /no longer available/
  );
  await assert.rejects(
    () => bridge.send("claude", terminalControl(adapter), "do work", {
      runtime: { pid: 110 }
    }),
    /no longer belongs/
  );
  assert.deepEqual(provider.operations, []);
});

test("send leaves injected text untouched and never submits after identity failure", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  let checks = 0;
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      checks += 1;
      if (checks === 3) {
        throw new Error("agent exited after text injection");
      }
    }
  });

  await assert.rejects(
    () => bridge.send("claude", terminalControl(adapter), "do work", {
      runtime: { pid: 110 }
    }),
    /agent exited/
  );
  assert.deepEqual(provider.operations, [
    {
      kind: "text",
      target: PANE.target,
      text: "do work",
      socketPath: PANE.socketPath
    }
  ]);
  assert.equal(
    provider.operations.some(
      (operation) => operation.kind === "keys" && operation.keys.includes("C-m")
    ),
    false
  );
});

test("send resolves a stable endpoint again for text and Enter routes", async () => {
  const adapter = createTestClaudeAdapter();
  const initialEndpoint = await endpointForPane(
    stablePane("claude-original:1.2")
  );
  const textEndpoint = await endpointForPane(
    stablePane("claude-renamed:3.4")
  );
  const enterEndpoint = await endpointForPane(
    stablePane("claude-final:5.6")
  );
  const provider = new SequencedResolutionProvider([
    textEndpoint,
    textEndpoint,
    enterEndpoint
  ]);
  const bridge = createBridge(adapter, provider);
  const control = provider.toControlRef(
    initialEndpoint,
    terminalControl(adapter).capabilities
  );
  const stages: string[] = [];

  const result = await bridge.send("claude", control, "do work", {
    onTransportStage(event) {
      stages.push(event.stage);
    }
  });

  assert.equal(result.stage, "enter_dispatched");
  assert.equal(provider.resolveCount, 3);
  assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
  assert.deepEqual(provider.operations, [
    {
      kind: "text",
      target: "claude-renamed:3.4",
      text: "do work",
      socketPath: PANE.socketPath
    },
    {
      kind: "keys",
      target: "claude-final:5.6",
      keys: ["C-m"],
      socketPath: PANE.socketPath
    }
  ]);
});

test("send preserves not-started and post-injection uncertainty across endpoint drift", async (t) => {
  const adapter = createTestClaudeAdapter();
  const initialEndpoint = await endpointForPane(
    stablePane("claude-original:1.2")
  );
  const freshTextEndpoint = await endpointForPane(
    stablePane("claude-renamed:3.4")
  );
  const driftCases = [
    {
      label: "stable resource identity",
      endpoint: await endpointForPane(
        stablePane("claude-drifted:5.6", { paneId: "%99" })
      )
    },
    {
      label: "process anchor",
      endpoint: await endpointForPane(
        stablePane("claude-drifted:5.6", { panePid: PANE.panePid + 1 })
      )
    }
  ];

  for (const drift of driftCases) {
    await t.test(`${drift.label} drift before text is proven not started`, async () => {
      const provider = new SequencedResolutionProvider([drift.endpoint]);
      const bridge = createBridge(adapter, provider);
      const control = provider.toControlRef(
        initialEndpoint,
        terminalControl(adapter).capabilities
      );

      await assert.rejects(
        bridge.send("claude", control, "do work"),
        (error: unknown) => {
          assert.ok(error instanceof TerminalInputNotStartedError);
          assert.equal(error.code, "AKK_TERMINAL_INPUT_NOT_STARTED");
          assert.match(
            error.message,
            /stable resource or process anchor changed/u
          );
          return true;
        }
      );
      assert.equal(provider.resolveCount, 1);
      assert.deepEqual(provider.operations, []);
    });

    await t.test(`${drift.label} drift after text never presses Enter`, async () => {
      const provider = new SequencedResolutionProvider([
        freshTextEndpoint,
        freshTextEndpoint,
        drift.endpoint
      ]);
      const bridge = createBridge(adapter, provider);
      const control = provider.toControlRef(
        initialEndpoint,
        terminalControl(adapter).capabilities
      );
      const stages: string[] = [];

      await assert.rejects(
        bridge.send("claude", control, "do work", {
          onTransportStage(event) {
            stages.push(event.stage);
          }
        }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.equal(error instanceof TerminalInputNotStartedError, false);
          assert.match(
            error.message,
            /stable resource or process anchor changed/u
          );
          return true;
        }
      );
      assert.equal(provider.resolveCount, 3);
      assert.deepEqual(stages, ["text_injected"]);
      assert.deepEqual(provider.operations, [{
        kind: "text",
        target: "claude-renamed:3.4",
        text: "do work",
        socketPath: PANE.socketPath
      }]);
    });

    await t.test(`${drift.label} drift after beforeText sends no input`, async () => {
      const provider = new SequencedResolutionProvider([
        freshTextEndpoint,
        drift.endpoint
      ]);
      const bridge = createBridge(adapter, provider);
      const control = provider.toControlRef(
        initialEndpoint,
        terminalControl(adapter).capabilities
      );
      let beforeTextCalled = false;

      await assert.rejects(
        bridge.send("claude", control, "do work", {
          beforeText() {
            beforeTextCalled = true;
          }
        }),
        (error: unknown) => {
          assert.ok(error instanceof TerminalInputNotStartedError);
          assert.equal(error.code, "AKK_TERMINAL_INPUT_NOT_STARTED");
          assert.match(
            error.message,
            /stable resource or process anchor changed/u
          );
          return true;
        }
      );
      assert.equal(beforeTextCalled, true);
      assert.equal(provider.resolveCount, 2);
      assert.deepEqual(provider.operations, []);
    });
  }
});

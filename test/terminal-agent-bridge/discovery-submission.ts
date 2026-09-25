import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  codexTerminalAgentAdapter,
  TerminalAgentBridge,
  TerminalEnterDispatchNotAttemptedError,
  PANE,
  RecordingTerminalProvider,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  codexPaddedStyledIdleScreen,
  strictCodexCommandApprovalScreen,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("bridge discovers a non-Codex process and preserves agent-aware list identity", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider();
  const bridge = createBridge(adapter, provider);

  const discovered = await bridge.listProcesses([
    { pid: 110, ppid: PANE.panePid, command: "test-claude", cwd: "/repo" },
    { pid: 120, ppid: PANE.panePid, command: "unrelated", cwd: "/repo" }
  ]);

  assert.equal(discovered.length, 1);
  assert.equal(discovered[0].agent, "claude");
  assert.equal(discovered[0].kind, "test_claude_cli");
  assert.equal(discovered[0].terminalControl?.target, PANE.target);
  assert.deepEqual(discovered[0].terminalControl?.capabilities, [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ]);

  const conversationId = bridge.terminalConversationId(discovered[0]);
  assert.equal(conversationId, `terminal:v2:tmux:claude:${PANE.target}:110`);
  const resolved = await bridge.resolveConversationId(conversationId);
  assert.equal(resolved?.agent, "claude");
  assert.equal(resolved?.pid, 110);
  assert.equal(resolved?.legacy, false);
  assert.equal(resolved?.adapter, adapter);
  assert.equal(resolved?.terminalControl.target, PANE.target);
});

test("bridge status and send dispatch through a non-Codex adapter and tmux provider", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "working: compiling tests"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const status = await bridge.status("claude", control);
  assert.equal(status.agent, "claude");
  assert.equal(status.reachable, true);
  assert.equal(status.activity_state, "working");
  assert.equal(status.activity_reason, "compiling tests");
  assert.equal(status.approval_state.scanned, true);
  assert.equal(status.approval_state.approvable, false);

  const stages: string[] = [];
  const result = await bridge.send("claude", control, "run the focused tests\n", {
    onTransportStage(event) {
      stages.push(event.stage);
    }
  });
  assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
  assert.equal(result.stage, "enter_dispatched");
  assert.equal(result.multiline, false);
  assert.deepEqual(provider.operations, [
    { kind: "capture", target: PANE.target, socketPath: PANE.socketPath },
    { kind: "text", target: PANE.target, text: "run the focused tests", socketPath: PANE.socketPath },
    { kind: "keys", target: PANE.target, keys: ["C-m"], socketPath: PANE.socketPath }
  ]);
});

test("send awaits the text-injected persistence boundary before Enter", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  const bridge = createBridge(adapter, provider);

  await assert.rejects(
    () => bridge.send("claude", terminalControl(adapter), "do work", {
      async onTransportStage(event) {
        if (event.stage === "text_injected") {
          throw new Error("could not persist text injection");
        }
      }
    }),
    /could not persist text injection/u
  );
  assert.deepEqual(provider.operations, [{
    kind: "text",
    target: PANE.target,
    text: "do work",
    socketPath: PANE.socketPath
  }]);
});

test("Codex multiline send crosses the paste window and requires a stable exact composer", async () => {
  const request = "第一行：检查状态\nThen run the focused tests.";
  class SettlingCodexProvider extends RecordingTerminalProvider {
    textInjectedAt?: number;
    enterDispatchedAt?: number;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, [
        "Ready",
        "› 第一行：检查状态",
        "  Then run the focused tests.",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterDispatchedAt = performance.now();
      }
      await super.sendKeys(target, keys, options);
    }
  }

  const provider = new SettlingCodexProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const stages: string[] = [];
  const result = await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    {
      runtime: { pid: 110 },
      onTransportStage(event) {
        stages.push(event.stage);
      }
    }
  );

  assert.equal(result.stage, "enter_dispatched");
  assert.equal(result.multiline, true);
  assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
  assert.ok(provider.textInjectedAt !== undefined);
  assert.ok(provider.enterDispatchedAt !== undefined);
  assert.ok(
    provider.enterDispatchedAt - provider.textInjectedAt >= 120,
    "Enter must cross Codex's upstream 120ms suppression window"
  );
  assert.ok(
    provider.operations.filter((operation) => operation.kind === "capture").length >= 3
  );
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("Codex multiline send proves an exact draft across visual composer wraps", async () => {
  const request = [
    "请核对这次投递，并保持下面内容逐字不变。",
    "   - 碰撞安全的短 ID 只用于展示；实际 resume 仍用完整 UUID + fresh tokens。",
    "Second line with  two spaces.",
    "Markdown hard break  ",
    "continues on the next logical line.",
    "",
    "完成后只回复 ACK。"
  ].join("\n");
  class WrappedCodexComposerProvider extends RecordingTerminalProvider {
    textInjectedAt?: number;
    enterDispatchedAt?: number;
    acceptedEnterCount = 0;
    suppressedEnterCount = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, [
        "Ready",
        "› 请核对这次投递，并保持下面内容",
        "  逐字不变。",
        "     - 碰撞安全的短 ID 只用于展示；实际 resume 仍用完整",
        "  UUID + fresh tokens。",
        "  Second line with  two spaces.",
        "  Markdown hard break",
        "  continues on the next logical line.",
        "  ",
        "  完成后只回复 ACK。",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterDispatchedAt = performance.now();
        if (
          this.textInjectedAt !== undefined &&
          this.enterDispatchedAt - this.textInjectedAt >= 120
        ) {
          this.acceptedEnterCount += 1;
          this.setScreen(target, "working: accepted wrapped request");
        } else {
          this.suppressedEnterCount += 1;
        }
      }
      await super.sendKeys(target, keys, options);
    }
  }

  const provider = new WrappedCodexComposerProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const stages: string[] = [];
  const result = await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    {
      runtime: { pid: 110 },
      onTransportStage(event) {
        stages.push(event.stage);
      }
    }
  );

  assert.equal(result.stage, "enter_dispatched");
  assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
  assert.ok(provider.textInjectedAt !== undefined);
  assert.ok(provider.enterDispatchedAt !== undefined);
  assert.ok(provider.enterDispatchedAt - provider.textInjectedAt >= 120);
  assert.equal(provider.acceptedEnterCount, 1);
  assert.equal(provider.suppressedEnterCount, 0);
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("Codex multiline send rejects mutated content across visual composer wraps", async () => {
  const originalSettleTimeoutMs = 2_000;
  let nowMs = 0;
  const requestedSleepMs: number[] = [];
  const request = [
    "请核对这次投递，并保持下面内容逐字不变。",
    "实际 resume 仍用完整 UUID + fresh tokens。"
  ].join("\n");
  class MutatedWrappedComposerProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› 请核对这次投递，并保持下面内容",
        "  逐字不符。",
        "  实际 resume 仍用完整 UUID + fresh tokens。",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }

  const provider = new MutatedWrappedComposerProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      requestedSleepMs.push(milliseconds);
      nowMs += milliseconds;
    }
  });
  const startedAt = nowMs;

  await assert.rejects(
    () => bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      { runtime: { pid: 110 } }
    ),
    /did not become exact/u
  );
  assert.ok(requestedSleepMs.length > 0);
  assert.ok(nowMs - startedAt > originalSettleTimeoutMs);
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ),
    false
  );
});

test("Codex multiline settle starts only after the exact composer materializes", async () => {
  const materializeAfterMs = 90;
  const suppressionWindowMs = 121;
  let nowMs = 0;
  const requestedSleepMs: number[] = [];
  const request = "延迟出现的第一行\nDelayed second line.";
  class DelayedComposerProvider extends RecordingTerminalProvider {
    materializedAt?: number;
    enterDispatchedAt?: number;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
    }

    materialize(target: TerminalEndpointRef | string): void {
      this.materializedAt = nowMs;
      this.setScreen(target, [
        "Ready",
        "› 延迟出现的第一行",
        "  Delayed second line.",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterDispatchedAt = nowMs;
      }
      await super.sendKeys(target, keys, options);
    }
  }

  const provider = new DelayedComposerProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      requestedSleepMs.push(milliseconds);
      const beforeSleep = nowMs;
      nowMs += milliseconds;
      if (
        provider.materializedAt === undefined &&
        beforeSleep < materializeAfterMs &&
        nowMs >= materializeAfterMs
      ) {
        provider.materialize(PANE.target);
      }
    }
  });
  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    { runtime: { pid: 110 } }
  );

  assert.ok(provider.materializedAt !== undefined);
  assert.ok(provider.enterDispatchedAt !== undefined);
  assert.ok(requestedSleepMs.length > 0);
  assert.equal(provider.materializedAt, materializeAfterMs);
  assert.ok(
    provider.enterDispatchedAt - provider.materializedAt >= suppressionWindowMs
  );
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("Codex multiline send preserves stable-capture opportunity after a slow first capture", async () => {
  const request = "slow first capture\nstill submit exactly";
  let nowMs = 0;
  class SlowFirstCaptureProvider extends RecordingTerminalProvider {
    private delayed = false;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› slow first capture",
        "  still submit exactly",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async capture(
      target: TerminalEndpointRef | string,
      options: { scrollbackLines?: number; socketPath?: string } = {}
    ): Promise<string> {
      if (!this.delayed) {
        this.delayed = true;
        nowMs += 2_100;
      }
      return super.capture(target, options);
    }
  }
  const provider = new SlowFirstCaptureProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request
  );

  assert.ok(nowMs >= 2_100 + 121);
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("send exposes typed proof when injected text fails before any Enter attempt", async () => {
  let nowMs = 0;
  const request = "typed boundary proof\nsecond line";
  class ExactAfterTextProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› typed boundary proof",
        "  second line",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }
  const provider = new ExactAfterTextProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });
  await assert.rejects(
    bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      {
        beforeEnter() {
          throw new Error("store fence rejected");
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof TerminalEnterDispatchNotAttemptedError);
      assert.equal(error.stage, "enter_not_attempted");
      assert.match(error.message, /store fence rejected/u);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("Codex composer observation returns every closed state without draft text", async (t) => {
  const expected = "managed exact draft";
  const cases: Array<{
    name: string;
    screen: string;
    state: "exact_draft" | "exact_empty" | "different_draft" | "working" |
      "approval_or_modal";
  }> = [
    {
      name: "exact draft",
      screen: `› ${expected}\ngpt-5.6-sol high · /repo`,
      state: "exact_draft"
    },
    {
      name: "positively styled empty composer",
      screen: codexPaddedStyledIdleScreen(80),
      state: "exact_empty"
    },
    {
      name: "different live draft",
      screen: "› human-authored draft\ngpt-5.6-sol high · /repo",
      state: "different_draft"
    },
    {
      name: "working",
      screen: "• Working (1s • esc to interrupt)",
      state: "working"
    },
    {
      name: "approval",
      screen: strictCodexCommandApprovalScreen("npm test"),
      state: "approval_or_modal"
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: testCase.screen
      });
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });
      const observation = await bridge.observeCodexComposer(
        terminalControl(codexTerminalAgentAdapter),
        expected
      );
      assert.equal(observation.state, testCase.state);
      assert.doesNotMatch(JSON.stringify(observation), /managed exact draft/u);
      if ("stableCaptures" in observation) {
        assert.ok(observation.stableCaptures >= 3);
      }
    });
  }

  await t.test("identity drift", async () => {
    const provider = new RecordingTerminalProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      async verifyIdentity() {
        throw new Error("test identity changed");
      }
    });
    assert.equal((await bridge.observeCodexComposer(
      terminalControl(codexTerminalAgentAdapter),
      expected,
      { runtime: { pid: 110 } }
    )).state, "identity_drift");
  });

  await t.test("unavailable", async () => {
    class UnavailableProvider extends RecordingTerminalProvider {
      override async capture(): Promise<string> {
        throw new Error("capture unavailable");
      }
    }
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: new UnavailableProvider([PANE])
    });
    assert.equal((await bridge.observeCodexComposer(
      terminalControl(codexTerminalAgentAdapter),
      expected
    )).state, "unavailable");
  });
});

import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  codexTerminalAgentAdapter,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  PANE,
  RecordingTerminalProvider,
  CapabilityLimitedTerminalProvider,
  stablePane,
  createBridge,
  terminalControl,
  codexStatusInspectionPlan,
  codexPaddedStyledIdleScreen,
  type TerminalPane,
  type TerminalEndpointRef,
  type TerminalProviderCapability
} from "../support/terminal-agent-bridge-contract-support.js";

test("native inspection preflights every transport capability before terminal input", async (t) => {
  const pane = stablePane("codex-capabilities:1.2");
  const cases: Array<{
    label: string;
    providerCapabilities: readonly TerminalProviderCapability[];
    missing: TerminalProviderCapability;
  }> = [
    {
      label: "key delivery",
      providerCapabilities: [
        "stable_resource_resolution",
        "screen_capture",
        "text_delivery"
      ],
      missing: "key_delivery"
    },
    {
      label: "screen capture",
      providerCapabilities: [
        "stable_resource_resolution",
        "text_delivery",
        "key_delivery"
      ],
      missing: "screen_capture"
    }
  ];

  for (const testCase of cases) {
    await t.test(`missing ${testCase.label}`, async () => {
      const provider = new CapabilityLimitedTerminalProvider(
        testCase.providerCapabilities,
        [pane]
      );
      const [endpoint] = await provider.listTerminals();
      assert.ok(endpoint);
      const control = provider.toControlRef(endpoint, [
        "send_keys",
        "screen_status"
      ]);

      await assert.rejects(
        createBridge(codexTerminalAgentAdapter, provider)
          .submitNativeInspection(
            "codex",
            control,
            codexStatusInspectionPlan()
          ),
        (error: unknown) => {
          assert.ok(error instanceof NativeInspectionSubmissionError);
          assert.equal(error.stage, "not_started");
          assert.equal(error.doNotRetry, false);
          assert.match(error.message, new RegExp(`provider:${testCase.missing}`, "u"));
          return true;
        }
      );
      assert.deepEqual(provider.operations, []);
    });
  }
});

test("closed Codex status probe crosses a Herdr-style paste window before exactly one Enter", async () => {
  let nowMs = 0;
  class HerdrBracketedPasteFake extends RecordingTerminalProvider {
    injectedAt?: number;
    enterAttempts = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.injectedAt = nowMs;
      const pad = (value: string): string =>
        `${value}${" ".repeat(Math.max(0, 80 - Array.from(value).length))}`;
      this.setScreen(target, [
        pad("Ready"),
        pad("› /status"),
        pad("gpt-5.6-sol high · /repo")
      ].join("\n"));
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterAttempts += 1;
        assert.ok(this.injectedAt !== undefined);
        assert.ok(nowMs - this.injectedAt >= 121);
      }
      await super.sendKeys(target, keys, options);
    }
  }

  const provider = new HerdrBracketedPasteFake([PANE], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });
  const result = await bridge.submitCodexStatusProbe(
    terminalControl(codexTerminalAgentAdapter),
    "0.153.0",
    { runtime: { pid: 110 } }
  );

  assert.equal(result.agent, "codex");
  assert.equal(result.enterCount, 1);
  assert.equal(result.materialization.stableForMs >= 121, true);
  assert.match(result.preTextScreenDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(result.observationBaselineDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    result.preEnterScreenDigest,
    `sha256:${result.observationBaselineDigest}`
  );
  assert.equal(result.observationScrollbackLines, 240);
  assert.equal(provider.enterAttempts, 1);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [
      {
        kind: "text",
        target: PANE.target,
        text: "/status",
        socketPath: PANE.socketPath
      },
      {
        kind: "keys",
        target: PANE.target,
        keys: ["C-m"],
        socketPath: PANE.socketPath
      }
    ]
  );
});

test("closed Codex status probe preserves an exact candidate after a slow first capture", async () => {
  let nowMs = 0;
  class SlowFirstStatusCaptureProvider extends RecordingTerminalProvider {
    injected = false;
    delayed = false;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.injected = true;
      this.setScreen(target, [
        "Ready",
        "› /status",
        "  /status      show current session configuration and token usage",
        "  /statusline  configure which items appear in the status line"
      ].join("\n"));
    }

    override async capture(
      terminal: TerminalEndpointRef | string,
      options: {
        scrollbackLines?: number;
        socketPath?: string;
        preserveEscapes?: boolean;
      } = {}
    ): Promise<string> {
      if (this.injected && !this.delayed) {
        this.delayed = true;
        nowMs += 2_500;
      }
      return super.capture(terminal, options);
    }
  }

  const provider = new SlowFirstStatusCaptureProvider([PANE], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  const result = await bridge.submitCodexStatusProbe(
    terminalControl(codexTerminalAgentAdapter),
    "0.153.0",
    { runtime: { pid: 110 } }
  );

  assert.equal(result.enterCount, 1);
  assert.equal(result.materialization.kind, "exact_slash_popup");
  assert.equal(provider.delayed, true);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    1
  );
});

test("Codex status freshness baseline matches the returned 240-line observation domain", async () => {
  let nowMs = 0;
  const unchangedLongScreen = [
    ...Array.from({ length: 130 }, (_, index) => `history-${index}`),
    "/status",
    "Session: 11111111-1111-4111-8111-111111111111",
    "Ready",
    "› /status",
    "  /status      show current session configuration and token usage",
    "  /statusline  configure which items appear in the status line"
  ].join("\n");
  class UnchangedLongStatusProvider extends RecordingTerminalProvider {
    override async capture(
      terminal: TerminalEndpointRef | string,
      options: {
        scrollbackLines?: number;
        socketPath?: string;
        preserveEscapes?: boolean;
      } = {}
    ): Promise<string> {
      const screen = await super.capture(terminal, options);
      const lines = screen.split("\n");
      return options.scrollbackLines === undefined
        ? screen
        : lines.slice(-options.scrollbackLines).join("\n");
    }

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, unchangedLongScreen);
    }
  }

  const provider = new UnchangedLongStatusProvider([PANE], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  const submission = await bridge.submitCodexStatusProbe(
    terminalControl(codexTerminalAgentAdapter),
    "0.148.0",
    { runtime: { pid: 110 } }
  );
  const legacyDepth = await bridge.status(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    { runtime: { pid: 110 }, scrollbackLines: 120 }
  );
  const exactDepth = await bridge.status(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    {
      runtime: { pid: 110 },
      scrollbackLines: submission.observationScrollbackLines
    }
  );

  assert.notEqual(
    legacyDepth.screen.digest,
    submission.observationBaselineDigest
  );
  assert.equal(
    exactDepth.screen.digest,
    submission.observationBaselineDigest
  );
});

test("closed Codex status probe rejects a proven narrow viewport before text", async () => {
  const provider = new RecordingTerminalProvider([{ ...PANE, columns: 54 }], {
    [PANE.target]: codexPaddedStyledIdleScreen(54)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });

  await assert.rejects(
    bridge.submitCodexStatusProbe(
      terminalControl(codexTerminalAgentAdapter),
      "0.148.0",
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "not_started");
      assert.equal(error.doNotRetry, false);
      assert.equal(error.diagnostic, "viewport_too_narrow");
      assert.match(error.message, /at least 80 columns.*observed 54/u);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "text" || operation.kind === "keys"
    ),
    false
  );
});

test("generic Codex native inspection shares the pre-text viewport gate", async () => {
  const provider = new RecordingTerminalProvider([{ ...PANE, columns: 54 }], {
    [PANE.target]: codexPaddedStyledIdleScreen(54)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });

  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan("0.150.0"),
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "not_started");
      assert.equal(error.diagnostic, "viewport_too_narrow");
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "text" || operation.kind === "keys"
    ),
    false
  );
});

test("Codex status sends no text when an available viewport inspector returns unknown", async () => {
  class UnknownViewportProvider extends RecordingTerminalProvider {
    async inspectViewport(): Promise<undefined> {
      return undefined;
    }
  }
  const provider = new UnknownViewportProvider([PANE], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });

  await assert.rejects(
    bridge.submitCodexStatusProbe(
      terminalControl(codexTerminalAgentAdapter),
      "0.148.0",
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "not_started");
      assert.equal(error.diagnostic, "viewport_unavailable");
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "text" || operation.kind === "keys"
    ),
    false
  );
});

test("closed Codex status probe diagnoses a truncated popup and sends no Enter", async () => {
  let nowMs = 0;
  class NarrowPopupProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "  /status      show current session configuration and token…",
        "  /statusline  configure which items appear in the status…"
      ].join("\n"));
    }
  }
  const idleAdapter = {
    ...codexTerminalAgentAdapter,
    inspectScreen(options: Parameters<
      typeof codexTerminalAgentAdapter.inspectScreen
    >[0]) {
      return {
        ...codexTerminalAgentAdapter.inspectScreen(options),
        activity: { state: "idle" as const, reason: "test-only idle" }
      };
    }
  };
  const provider = new NarrowPopupProvider([PANE], {
    [PANE.target]: "› \n\ngpt-5.6-sol high · /repo"
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([idleAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  await assert.rejects(
    bridge.submitCodexStatusProbe(
      terminalControl(codexTerminalAgentAdapter),
      "0.148.0",
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      assert.equal(error.diagnostic, "composer_viewport_truncated");
      return true;
    }
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("Codex status rechecks viewport after beforeEnter and sends no Enter after resize", async () => {
  let nowMs = 0;
  const mutablePane: TerminalPane = { ...PANE, columns: 80, rows: 40 };
  class ResizeBeforeEnterProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "Ready",
        "› /status",
        "",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }
  const provider = new ResizeBeforeEnterProvider([mutablePane], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  await assert.rejects(
    bridge.submitCodexStatusProbe(
      terminalControl(codexTerminalAgentAdapter),
      "0.148.0",
      {
        runtime: { pid: 110 },
        beforeEnter() {
          mutablePane.columns = 70;
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      assert.equal(error.diagnostic, "viewport_too_narrow");
      assert.match(error.message, /narrowed to 70 columns before Enter/u);
      return true;
    }
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("Codex status catches composer drift during the final viewport proof", async () => {
  let nowMs = 0;
  class ComposerDriftDuringViewportProvider extends RecordingTerminalProvider {
    viewportInspections = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "Ready",
        "› /status",
        "",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async inspectViewport(
      terminal: TerminalEndpointRef
    ): Promise<{ columns: number; rows: number }> {
      this.viewportInspections += 1;
      if (this.viewportInspections === 3) {
        await Promise.resolve();
        this.setScreen(terminal, [
          "Ready",
          "› /status changed by a human",
          "",
          "gpt-5.6-sol high · /repo"
        ].join("\n"));
      }
      return { columns: 80, rows: 40 };
    }
  }

  const provider = new ComposerDriftDuringViewportProvider([PANE], {
    [PANE.target]: codexPaddedStyledIdleScreen(80)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  await assert.rejects(
    bridge.submitCodexStatusProbe(
      terminalControl(codexTerminalAgentAdapter),
      "0.148.0",
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      assert.equal(error.diagnostic, "composer_drift");
      return true;
    }
  );
  assert.equal(provider.viewportInspections, 3);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("native status inspection proves an exact stable composer before one Enter", async () => {
  const composerScreen = [
    "Ready",
    "› /status",
    "",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  class NativeStatusProvider extends RecordingTerminalProvider {
    textInjectedAt?: number;
    enterDispatchedAt?: number;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, composerScreen);
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

  const provider = new NativeStatusProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const hookDigests: string[] = [];
  const result = await bridge.submitNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    codexStatusInspectionPlan(),
    {
      runtime: { pid: 110 },
      beforeEnter(context) {
        hookDigests.push(context.preEnterScreenDigest);
      }
    }
  );

  assert.equal(result.stage, "enter_dispatched");
  assert.equal(result.enterCount, 1);
  assert.equal(result.materialization.kind, "exact_slash_composer");
  assert.ok(result.materialization.stableForMs >= 121);
  assert.match(result.preEnterScreenDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(result.preEnterEvidenceInventory, []);
  assert.deepEqual(hookDigests, [result.preEnterScreenDigest]);
  assert.ok(provider.textInjectedAt !== undefined);
  assert.ok(provider.enterDispatchedAt !== undefined);
  assert.ok(provider.enterDispatchedAt - provider.textInjectedAt >= 120);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind !== "capture"),
    [
      {
        kind: "text",
        target: PANE.target,
        text: "/status",
        socketPath: PANE.socketPath
      },
      {
        kind: "keys",
        target: PANE.target,
        keys: ["C-m"],
        socketPath: PANE.socketPath
      }
    ]
  );
});

test("native status inspection can settle against an injected monotonic clock", async () => {
  const composerScreen = [
    "Ready",
    "› /status",
    "",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  class VirtualClockNativeStatusProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, composerScreen);
    }
  }

  let nowMs = 0;
  const sleeps: number[] = [];
  const provider = new VirtualClockNativeStatusProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {},
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    }
  });

  const result = await bridge.submitNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    codexStatusInspectionPlan(),
    { runtime: { pid: 110 } }
  );

  assert.equal(result.stage, "enter_dispatched");
  assert.equal(result.enterCount, 1);
  assert.ok(result.materialization.stableForMs >= 121);
  assert.ok(sleeps.length >= 1);
  assert.ok(nowMs >= 121);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{
      kind: "keys",
      target: PANE.target,
      keys: ["C-m"],
      socketPath: PANE.socketPath
    }]
  );
});

import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  createClaudeTerminalAgentAdapter,
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  PANE,
  RecordingTerminalProvider,
  terminalControl,
  claudeStatusInspectionPlan,
  claudeNativeComposerScreen,
  claudeNarrowNativeComposerScreen,
  claudeNativeStatusPanel,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("verified and unverified Claude versions use the closed stable composer and modal dismissal", async () => {
  for (const version of [
    "2.1.226",
    "2.1.237",
    "2.1.251",
    "2.1.259",
    "2.1.260",
    "2.1.263",
    "2.1.264",
    "2.1.266",
    "2.1.267",
    "2.1.268"
  ]) {
    const nativeThreadId = "40ce9ddb-6de3-45d1-be57-7684808712a0";
    const idleScreen = [
      "────────────────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
    ].join("\n");
    class ClaudeNativeStatusProvider extends RecordingTerminalProvider {
      textInjectedAt?: number;
      enterDispatchedAt?: number;

      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.textInjectedAt = performance.now();
        this.setScreen(target, claudeNativeComposerScreen(text));
      }

      override async sendKeys(
        target: TerminalEndpointRef | string,
        keys: readonly string[],
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendKeys(target, keys, options);
        if (keys.includes("C-m")) {
          this.enterDispatchedAt = performance.now();
          this.setScreen(
            target,
            claudeNativeStatusPanel(nativeThreadId, version)
          );
        } else if (keys.includes("Escape")) {
          this.setScreen(target, idleScreen);
        }
      }
    }

    const adapter = createClaudeTerminalAgentAdapter();
    const provider = new ClaudeNativeStatusProvider([PANE], {
      [PANE.target]: idleScreen
    });
    let identityChecks = 0;
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider,
      async verifyIdentity() {
        identityChecks += 1;
      }
    });
    const plan = claudeStatusInspectionPlan(version);
    const submission = await bridge.submitNativeInspection(
      "claude",
      terminalControl(adapter),
      plan,
      { runtime: { pid: 110 } }
    );
    assert.equal(submission.agent, "claude");
    assert.equal(submission.enterCount, 1);
    assert.equal(submission.materialization.kind, "exact_slash_popup");
    assert.ok(submission.materialization.stableForMs >= 80);
    assert.ok(provider.textInjectedAt !== undefined);
    assert.ok(provider.enterDispatchedAt !== undefined);
    assert.ok(provider.enterDispatchedAt - provider.textInjectedAt >= 79);

    const request = {
      operation: plan.operation,
      previousScreenFingerprint: submission.preEnterScreenDigest,
      preEnterEvidenceInventory: submission.preEnterEvidenceInventory,
      expectedNativeThreadId: nativeThreadId,
      expectedAgentVersion: version,
      expectedCwd: "/repo"
    };
    const observed = await bridge.observeNativeInspection(
      "claude",
      terminalControl(adapter),
      request,
      { runtime: { pid: 110 } }
    );
    assert.equal(observed.observation.status, "observed");
    assert.equal("screen" in observed, false);
    const dismissal = await bridge.dismissNativeInspection(
      "claude",
      terminalControl(adapter),
      plan,
      request,
      observed.observation.evidenceFingerprint!,
      { runtime: { pid: 110 } }
    );
    assert.equal(dismissal.dismissCount, 1);
    assert.deepEqual(dismissal.keys, ["Escape"]);
    assert.equal(identityChecks >= 7, true);
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys"),
      [
        {
          kind: "keys",
          target: PANE.target,
          keys: ["C-m"],
          socketPath: PANE.socketPath
        },
        {
          kind: "keys",
          target: PANE.target,
          keys: ["Escape"],
          socketPath: PANE.socketPath
        }
      ]
    );
  }
});

test("verified and generic Claude native status profiles accept the closed 80-column popup", async () => {
  class NarrowClaudeProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, claudeNarrowNativeComposerScreen(text));
    }
  }
  for (const version of [
    "2.1.226",
    "2.1.237",
    "2.1.251",
    "2.1.259",
    "2.1.260",
    "2.1.263",
    "2.1.264",
    "2.1.266",
    "2.1.267",
    "2.1.268"
  ]) {
    const adapter = createClaudeTerminalAgentAdapter();
    const provider = new NarrowClaudeProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider,
      async verifyIdentity() {}
    });
    const result = await bridge.submitNativeInspection(
      "claude",
      terminalControl(adapter),
      claudeStatusInspectionPlan(version),
      { runtime: { pid: 110 } }
    );
    assert.equal(result.materialization.kind, "exact_slash_popup");
    assert.equal(result.enterCount, 1);
  }
});

for (const version of [
  "2.1.259",
  "2.1.263",
  "2.1.266",
  "2.1.267"
] as const) {
  test(`Claude ${version} native status rejects a non-prefix truncated popup`, async () => {
    const adapter = createClaudeTerminalAgentAdapter();
    class DriftedNarrowClaudeProvider extends RecordingTerminalProvider {
      private capturesAfterInjection = 0;

      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(
          target,
          claudeNarrowNativeComposerScreen(text).replace("tool st…", "tool xx…")
        );
      }

      override async capture(
        target: TerminalEndpointRef | string,
        options: { scrollbackLines?: number; socketPath?: string } = {}
      ): Promise<string> {
        this.capturesAfterInjection += 1;
        if (this.capturesAfterInjection >= 8) {
          throw new Error("bounded test capture stop after rejecting popup");
        }
        return super.capture(target, options);
      }
    }
    const provider = new DriftedNarrowClaudeProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider,
      async verifyIdentity() {}
    });
    await assert.rejects(
      bridge.submitNativeInspection(
        "claude",
        terminalControl(adapter),
        claudeStatusInspectionPlan(version),
        { runtime: { pid: 110 } }
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeInspectionSubmissionError);
        assert.equal(error.stage, "text_injected");
        return true;
      }
    );
    assert.equal(
      provider.operations.some((operation) =>
        operation.kind === "keys" && operation.keys.includes("C-m")
      ),
      false
    );
  });
}

test("Claude native modal dismissal fails closed on evidence drift and never sends Escape", async () => {
  const nativeThreadId = "40ce9ddb-6de3-45d1-be57-7684808712a0";
  const adapter = createClaudeTerminalAgentAdapter();
  const panel = claudeNativeStatusPanel(nativeThreadId);
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: panel
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const plan = claudeStatusInspectionPlan();
  const request = {
    operation: plan.operation,
    previousScreenFingerprint: "sha256:before",
    preEnterEvidenceInventory: [],
    expectedNativeThreadId: nativeThreadId,
    expectedAgentVersion: "2.1.218",
    expectedCwd: "/repo"
  };
  const observed = await bridge.observeNativeInspection(
    "claude",
    terminalControl(adapter),
    request,
    { runtime: { pid: 110 } }
  );
  provider.setScreen(
    PANE.target,
    panel.replace("Model:               claude-sonnet", "Model:               drifted")
  );
  await assert.rejects(
    bridge.dismissNativeInspection(
      "claude",
      terminalControl(adapter),
      plan,
      request,
      observed.observation.evidenceFingerprint!,
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionDismissalError);
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("Claude native inspection sends no Enter after post-injection identity drift", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  class ClaudeIdentityDriftProvider extends RecordingTerminalProvider {
    injected = false;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.injected = true;
      this.setScreen(target, claudeNativeComposerScreen(text));
    }
  }
  const provider = new ClaudeIdentityDriftProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      if (provider.injected) {
        throw new Error("Claude agents process incarnation changed");
      }
    }
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "claude",
      terminalControl(adapter),
      claudeStatusInspectionPlan(),
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("Claude modal dismissal attempts Escape once and never retries an uncertain key", async () => {
  const nativeThreadId = "40ce9ddb-6de3-45d1-be57-7684808712a0";
  const adapter = createClaudeTerminalAgentAdapter();
  class UncertainDismissProvider extends RecordingTerminalProvider {
    escapeAttempts = 0;

    override async sendKeys(
      _target: TerminalEndpointRef | string,
      keys: readonly string[]
    ): Promise<void> {
      if (keys.includes("Escape")) {
        this.escapeAttempts += 1;
        throw new Error("tmux Escape outcome is uncertain");
      }
    }
  }
  const provider = new UncertainDismissProvider([PANE], {
    [PANE.target]: claudeNativeStatusPanel(nativeThreadId)
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const plan = claudeStatusInspectionPlan();
  const request = {
    operation: plan.operation,
    previousScreenFingerprint: "sha256:before",
    preEnterEvidenceInventory: [],
    expectedNativeThreadId: nativeThreadId,
    expectedAgentVersion: "2.1.218",
    expectedCwd: "/repo"
  };
  const observed = await bridge.observeNativeInspection(
    "claude",
    terminalControl(adapter),
    request,
    { runtime: { pid: 110 } }
  );
  await assert.rejects(
    bridge.dismissNativeInspection(
      "claude",
      terminalControl(adapter),
      plan,
      request,
      observed.observation.evidenceFingerprint!,
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionDismissalError);
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(provider.escapeAttempts, 1);
});

test("Claude native inspection attempts Enter once and never retries an uncertain key", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  class UncertainEnterProvider extends RecordingTerminalProvider {
    enterAttempts = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, claudeNativeComposerScreen(text));
    }

    override async sendKeys(
      _target: TerminalEndpointRef | string,
      keys: readonly string[]
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterAttempts += 1;
        throw new Error("tmux Enter outcome is uncertain");
      }
    }
  }
  const provider = new UncertainEnterProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "claude",
      terminalControl(adapter),
      claudeStatusInspectionPlan(),
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "enter_uncertain");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(provider.enterAttempts, 1);
});

test("Claude native inspection rejects forged slash and dismissal plans before input", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const plan = claudeStatusInspectionPlan();
  const forgedPlans = [
    { ...plan, command: "/usage" },
    {
      ...plan,
      composer: { ...plan.composer, maximumSettleMs: 5_000 }
    },
    {
      ...plan,
      expectedResult: {
        ...plan.expectedResult,
        dismissal: {
          keys: ["C-m"],
          expected: "idle_empty_composer" as const
        }
      }
    }
  ];
  for (const forged of forgedPlans) {
    await assert.rejects(
      bridge.submitNativeInspection(
        "claude",
        terminalControl(adapter),
        forged,
        { runtime: { pid: 110 } }
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeInspectionSubmissionError);
        assert.equal(error.stage, "not_started");
        assert.equal(error.doNotRetry, false);
        return true;
      }
    );
  }
  assert.deepEqual(provider.operations, []);
});

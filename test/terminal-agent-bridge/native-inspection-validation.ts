import {
  test,
  assert,
  createHash,
  createTerminalAgentAdapterRegistry,
  codexTerminalAgentAdapter,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  PANE,
  RecordingTerminalProvider,
  terminalControl,
  codexStatusInspectionPlan,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("native status inspection accepts an exact current slash popup only at a proven idle prompt", async () => {
  class SlashPopupProvider extends RecordingTerminalProvider {
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
        "",
        "  /status  show current session configuration and token usage"
      ].join("\n"));
    }
  }

  const provider = new SlashPopupProvider([PANE]);
  const idlePopupAdapter = {
    ...codexTerminalAgentAdapter,
    inspectScreen(options: Parameters<
      typeof codexTerminalAgentAdapter.inspectScreen
    >[0]) {
      return {
        ...codexTerminalAgentAdapter.inspectScreen(options),
        activity: {
          state: "idle" as const,
          reason: "version-profiled slash popup is current and idle"
        }
      };
    }
  };
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([idlePopupAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const result = await bridge.submitNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    codexStatusInspectionPlan(),
    { runtime: { pid: 110 } }
  );

  assert.equal(result.materialization.kind, "exact_slash_popup");
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("Codex 0.147.0 through 0.154.0 require their exact ordered two-row slash popup", async () => {
  class CurrentPopupProvider extends RecordingTerminalProvider {
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
        "  /status      show current session configuration and token usage",
        "  /statusline  configure which items appear in the status line"
      ].join("\n"));
    }
  }

  const idlePopupAdapter = {
    ...codexTerminalAgentAdapter,
    inspectScreen(options: Parameters<
      typeof codexTerminalAgentAdapter.inspectScreen
    >[0]) {
      return {
        ...codexTerminalAgentAdapter.inspectScreen(options),
        activity: {
          state: "idle" as const,
          reason: "verified version-scoped slash popup is current and idle"
        }
      };
    }
  };
  for (const version of [
    "0.147.0",
    "0.148.0",
    "0.149.1",
    "0.150.1",
    "0.151.0",
    "0.153.0",
    "0.153.4",
    "0.154.0"
  ]) {
    const provider = new CurrentPopupProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([idlePopupAdapter]),
      terminalProvider: provider,
      async verifyIdentity() {}
    });
    const result = await bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(version),
      { runtime: { pid: 110 } }
    );
    assert.equal(result.materialization.kind, "exact_slash_popup");
    assert.equal(result.enterCount, 1);
  }
});

for (const version of ["0.153.0", "0.153.4", "0.154.0"] as const) {
  test(`Codex ${version} native status refuses an incomplete two-row popup`, async () => {
    class IncompleteCurrentPopupProvider extends RecordingTerminalProvider {
      private capturesAfterInjection = 0;

      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(target, [
          "› /status",
          "",
          "  /status      show current session configuration and token usage"
        ].join("\n"));
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

    const provider = new IncompleteCurrentPopupProvider([PANE]);
    const idlePopupAdapter = {
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
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([idlePopupAdapter]),
      terminalProvider: provider,
      async verifyIdentity() {}
    });
    await assert.rejects(
      bridge.submitNativeInspection(
        "codex",
        terminalControl(codexTerminalAgentAdapter),
        codexStatusInspectionPlan(version),
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

test("native status inspection rejects an unprofiled slash popup description before Enter", async () => {
  class UnprofiledPopupProvider extends RecordingTerminalProvider {
    private capturesAfterInjection = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "",
        "  /status  caller-controlled description"
      ].join("\n"));
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

  const provider = new UnprofiledPopupProvider([PANE]);
  const idlePopupAdapter = {
    ...codexTerminalAgentAdapter,
    inspectScreen(options: Parameters<
      typeof codexTerminalAgentAdapter.inspectScreen
    >[0]) {
      return {
        ...codexTerminalAgentAdapter.inspectScreen(options),
        activity: {
          state: "idle" as const,
          reason: "test-only proven idle prompt"
        }
      };
    }
  };
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([idlePopupAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(),
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("native status inspection ignores historical /status when the current composer changed", async () => {
  class DriftedComposerProvider extends RecordingTerminalProvider {
    private capturesAfterInjection = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "gpt-5.6-sol high · /repo",
        "historical output",
        "› /danger",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async capture(
      target: TerminalEndpointRef | string,
      options: { scrollbackLines?: number; socketPath?: string } = {}
    ): Promise<string> {
      this.capturesAfterInjection += 1;
      if (this.capturesAfterInjection >= 8) {
        this.setScreen(target, "• Working · esc to interrupt");
      }
      return super.capture(target, options);
    }
  }

  const provider = new DriftedComposerProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(),
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("native status inspection rejects working composer activity", async () => {
  for (const screen of [[
    "› /status",
    "gpt-5.6-sol high · /repo",
    "• Working · esc to interrupt"
  ].join("\n")]) {
    class NonIdleProvider extends RecordingTerminalProvider {
      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(target, screen);
      }
    }

    const provider = new NonIdleProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      async verifyIdentity() {}
    });
    await assert.rejects(
      bridge.submitNativeInspection(
        "codex",
        terminalControl(codexTerminalAgentAdapter),
        codexStatusInspectionPlan(),
        { runtime: { pid: 110 } }
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeInspectionSubmissionError);
        assert.equal(error.stage, "text_injected");
        assert.equal(error.doNotRetry, true);
        assert.match(error.message, /became busy or blocked/u);
        return true;
      }
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  }
});

test("native inspection error stages cannot regress after text injection", async () => {
  class NativeStatusProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }

  const provider = new NativeStatusProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(),
      {
        runtime: { pid: 110 },
        beforeEnter() {
          throw new NativeInspectionSubmissionError(
            "not_started",
            "nested stale validation"
          );
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      assert.match(error.message, /nested stale validation/u);
      return true;
    }
  );
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    0
  );
});

test("native status inspection requires an unambiguous bounded pre-Enter evidence inventory", async () => {
  const originalPreEnterWindowMs = 120;
  for (const observation of [
    {
      status: "missing" as const,
      screenFingerprint: `sha256:${"a".repeat(64)}`,
      reason: "test adapter omitted its evidence inventory"
    },
    {
      status: "ambiguous" as const,
      screenFingerprint: `sha256:${"b".repeat(64)}`,
      evidenceInventory: [],
      reason: "test adapter found ambiguous pre-Enter evidence"
    }
  ]) {
    class NativeStatusProvider extends RecordingTerminalProvider {
      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(target, [
          "› /status",
          "gpt-5.6-sol high · /repo"
        ].join("\n"));
      }
    }

    const inventoryAdapter = {
      ...codexTerminalAgentAdapter,
      observeNativeInspection() {
        return observation;
      }
    };
    let nowMs = 0;
    const requestedSleepMs: number[] = [];
    const provider = new NativeStatusProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([inventoryAdapter]),
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
      bridge.submitNativeInspection(
        "codex",
        terminalControl(codexTerminalAgentAdapter),
        codexStatusInspectionPlan(),
        { runtime: { pid: 110 } }
      ),
      (error: unknown) => {
        assert.ok(error instanceof NativeInspectionSubmissionError);
        assert.equal(error.stage, "text_injected");
        assert.equal(error.doNotRetry, true);
        assert.match(error.message, /test adapter/u);
        return true;
      }
    );
    assert.ok(requestedSleepMs.length > 0);
    assert.equal(
      requestedSleepMs.reduce(
        (total, milliseconds) => total + milliseconds,
        0
      ),
      nowMs - startedAt
    );
    assert.ok(nowMs - startedAt >= originalPreEnterWindowMs);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  }
});

test("native status inspection rejects a caller-forged plan before terminal input", async () => {
  const provider = new RecordingTerminalProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      {
        ...codexStatusInspectionPlan(),
        behaviorProfile: "caller-selected-profile"
      },
      { runtime: { pid: 110 } }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "not_started");
      assert.equal(error.doNotRetry, false);
      return true;
    }
  );
  assert.deepEqual(provider.operations, []);
});

test("native status inspection leaves injected text untouched when the final popup drifts", async () => {
  class SlashPopupProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "",
        "  /status  show current session configuration and token usage"
      ].join("\n"));
    }
  }

  const provider = new SlashPopupProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(),
      {
        runtime: { pid: 110 },
        beforeEnter() {
          provider.setScreen(PANE.target, [
            "› /status",
            "",
            "  /usage  inspect limits"
          ].join("\n"));
        }
      }
    ),
    (error: unknown) => {
      assert.ok(error instanceof NativeInspectionSubmissionError);
      assert.equal(error.stage, "text_injected");
      assert.equal(error.doNotRetry, true);
      return true;
    }
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("native status inspection marks any failed Enter attempt uncertain and never retries", async () => {
  class UncertainEnterProvider extends RecordingTerminalProvider {
    enterAttempts = 0;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "› /status",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async sendKeys(): Promise<void> {
      this.enterAttempts += 1;
      throw new Error("tmux send-keys outcome is uncertain");
    }
  }

  const provider = new UncertainEnterProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    bridge.submitNativeInspection(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      codexStatusInspectionPlan(),
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

test("native inspection observation is identity-fenced and never exposes raw screen", async () => {
  const nativeThreadId = "22222222-2222-4222-8222-222222222222";
  const screen = [
    "› /status",
    "",
    "╭────────────────────────────────────────────────────────────╮",
    "│  >_ OpenAI Codex (v0.146.1)                               │",
    `│  Session:               ${nativeThreadId}     │`,
    "╰────────────────────────────────────────────────────────────╯",
    "",
    "› "
  ].join("\n");
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: screen
  });
  let identityChecks = 0;
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      identityChecks += 1;
    }
  });
  const observed = await bridge.observeNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    {
      operation: { kind: "status" },
      previousScreenFingerprint: "sha256:before",
      expectedNativeThreadId: nativeThreadId,
      expectedAgentVersion: "0.146.1"
    },
    { runtime: { pid: 110 } }
  );

  assert.equal(identityChecks, 1);
  assert.equal(observed.observation.status, "observed");
  assert.equal(observed.observation.nativeThreadId, nativeThreadId);
  assert.equal(
    observed.screenDigest,
    `sha256:${createHash("sha256").update(screen).digest("hex")}`
  );
  assert.equal("screen" in observed, false);

  const stale = await bridge.observeNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    {
      operation: { kind: "status" },
      previousScreenFingerprint: "sha256:before",
      preEnterEvidenceInventory: [{
        evidenceFingerprint:
          observed.observation.evidenceFingerprint ?? "missing",
        occurrenceCount: 1
      }],
      expectedNativeThreadId: nativeThreadId,
      expectedAgentVersion: "0.146.1"
    },
    { runtime: { pid: 110 } }
  );
  assert.equal(stale.observation.status, "stale");
  assert.match(
    stale.observation.reason ?? "",
    /did not add a fresh exact evidence occurrence/u
  );
});

import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  createClaudeTerminalAgentAdapter,
  codexTerminalAgentAdapter,
  TerminalAgentBridge,
  planTerminalModelControl,
  probeTerminalModelControl,
  PANE,
  RecordingTerminalProvider,
  terminalControl,
  codexPaddedStyledIdleScreen,
  strictCodexCommandApprovalScreen,
  type TerminalAgentAdapter,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("Codex model control accepts only its exact 0.154 slash completion", async (t) => {
  const plan = planTerminalModelControl(
    probeTerminalModelControl("codex", "0.154.0")
  );
  const exactSuggestion =
    "  /model  choose what model and reasoning effort to use";
  const modelCommandScreen = (
    suggestions: readonly string[],
    command = "/model"
  ): string => {
    const columns = 80;
    const background = (value: string): string =>
      `\u001b[48;2;57;57;57m${value}${" ".repeat(
        columns - Array.from(value).length
      )}\u001b[0m`;
    return [
      "Ready",
      background(""),
      background(`› ${command}`),
      background(""),
      ...suggestions
    ].join("\n");
  };
  const modelBareCommandScreen = (command = "/model"): string => {
    const columns = 80;
    const background = (value: string): string =>
      `\u001b[48;2;57;57;57m${value}${" ".repeat(
        columns - Array.from(value).length
      )}\u001b[0m`;
    return [
      "Ready",
      background(""),
      background(`› ${command}`),
      background(""),
      "  gpt-5.6-sol high · /repo"
    ].join("\n");
  };
  const modelIdleScreen = () => {
    const lines = codexPaddedStyledIdleScreen(80).split("\n");
    lines[2] = `  ${lines[2].slice(0, -2)}`;
    return lines.join("\n");
  };
  class ModelControlProvider extends RecordingTerminalProvider {
    phase: "idle" | "draft" | "bare" | "picker" = "idle";
    draftCaptures = 0;
    throwOnDraftCapture?: number;
    overrideScreenAfterText?: string;
    replaceOnDraftCapture?: { capture: number; screen: string };

    constructor(readonly suggestions: readonly string[]) {
      super([PANE], { [PANE.target]: modelIdleScreen() });
    }

    override async capture(
      target: TerminalEndpointRef | string,
      options: {
        scrollbackLines?: number;
        socketPath?: string;
        preserveEscapes?: boolean;
      } = {}
    ): Promise<string> {
      if (this.phase === "draft" || this.phase === "bare") {
        this.draftCaptures += 1;
        if (this.draftCaptures === this.replaceOnDraftCapture?.capture) {
          this.setScreen(target, this.replaceOnDraftCapture.screen);
        }
        if (this.draftCaptures === this.throwOnDraftCapture) {
          throw new Error("synthetic bounded capture stop");
        }
      }
      return super.capture(target, options);
    }

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      assert.equal(text, "/model");
      this.phase = "draft";
      this.setScreen(
        target,
        this.overrideScreenAfterText ?? modelCommandScreen(this.suggestions)
      );
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendKeys(target, keys, options);
      assert.equal(keys.length, 1);
      if (keys[0] === "C-m" &&
          (this.phase === "draft" || this.phase === "bare")) {
        this.phase = "picker";
        this.setScreen(target, [
          "  Select Model and Effort",
          "  1. gpt-6-astra (default)",
          "› 2. gpt-5.6-sol (current)",
          "  3. gpt-5.6-terra",
          "  4. gpt-5.6-luna",
          "  5. gpt-5.5",
          "  6. gpt-5.3-codex-spark",
          "  Press enter to confirm or esc to go back"
        ].join("\n"));
        return;
      }
      if (keys[0] === "Escape" && this.phase === "draft") {
        this.phase = "bare";
        this.setScreen(target, [
          "Ready",
          "› /model",
          "gpt-5.6-sol high · /repo"
        ].join("\n"));
        return;
      }
      if (keys[0] === "C-u" && this.phase === "bare") {
        this.phase = "idle";
        this.setScreen(target, modelIdleScreen());
        return;
      }
      assert.equal(keys[0], "Escape");
      this.phase = "idle";
      this.setScreen(target, modelIdleScreen());
    }
  }
  const catalog = async () => ({ models: [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6 Sol",
      reasoningEfforts: ["low", "high"] as const
    },
    {
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      reasoningEfforts: ["high", "ultra"] as const
    }
  ] });
  const transportInputOwnerMarker = "synthetic transport input owner";
  const transportInputOwnerAdapter: TerminalAgentAdapter = {
    ...codexTerminalAgentAdapter,
    inspectScreen(options) {
      const inspection = codexTerminalAgentAdapter.inspectScreen(options);
      return options.screen.includes(transportInputOwnerMarker)
        ? {
            ...inspection,
            activity: {
              state: "awaiting_approval",
              reason: "synthetic transport-bound approval race"
            },
            approval: {
              blocked: true,
              approvable: false,
              reason: "synthetic transport-bound approval race"
            }
          }
        : inspection;
    }
  };
  const createModelBridge = (
    provider: ModelControlProvider,
    adapter: TerminalAgentAdapter = codexTerminalAgentAdapter
  ) =>
    new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider,
      async sleep() {}
    });

  await t.test("enters and dismisses the real indented picker without a false busy classification", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    let authorityChecks = 0;
    const result = await createModelBridge(provider).modelOptions(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "0.154.0",
      plan,
      {
        beforeInput: () => { authorityChecks += 1; },
        loadCodexCatalog: catalog
      }
    );
    assert.equal(result.catalog.current.model, "gpt-5.6-sol");
    assert.equal(provider.phase, "idle");
    assert.equal(authorityChecks, 3);
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["C-m"], ["Escape"]]
    );
  });

  await t.test("status classifies the open model picker as a model-control surface, not idle or a questionnaire", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "picker";
    provider.setScreen(PANE.target, [
      "  Select Model and Effort",
      "  1. gpt-6-astra (default)",
      "› 2. gpt-5.6-sol (current)",
      "  3. gpt-5.6-terra",
      "  4. gpt-5.6-luna",
      "  5. gpt-5.5",
      "  6. gpt-5.3-codex-spark",
      "  Press enter to confirm or esc to go back"
    ].join("\n"));

    const status = await createModelBridge(provider).status(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      { runtime: { pid: PANE.panePid, agentVersion: "0.154.0" } }
    );

    assert.equal(status.activity_state, "unknown");
    assert.equal(status.screen_state, "unknown");
    assert.match(status.activity_reason, /model-control surface is open/u);
    assert.equal(status.interaction_state, undefined);
    assert.equal(status.approval_state.blocked, false);
  });

  await t.test("repairs the real indented picker with one verified Escape", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "picker";
    provider.setScreen(PANE.target, [
      "  Select Model and Effort",
      "  1. gpt-6-astra (default)",
      "› 2. gpt-5.6-sol (current)",
      "  3. gpt-5.6-terra",
      "  4. gpt-5.6-luna",
      "  5. gpt-5.5",
      "  6. gpt-5.3-codex-spark",
      "  Press enter to confirm or esc to go back"
    ].join("\n"));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };

    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    assert.equal(residual.kind, "model_surface");

    const result = await bridge.repairModelControlResidual(
      "codex", control, "0.154.0", plan, residual.fingerprint, options
    );
    assert.equal(result.outcome, "repaired");
    assert.equal(result.composerPostcondition, "empty");
    assert.equal(provider.phase, "idle");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"]]
    );
  });

  await t.test("enters when Herdr materializes an exact fixed-width bare /model Composer", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.overrideScreenAfterText = modelBareCommandScreen();
    const result = await createModelBridge(provider).modelOptions(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "0.154.0",
      plan,
      { beforeInput() {}, loadCodexCatalog: catalog }
    );

    assert.equal(result.catalog.current.model, "gpt-5.6-sol");
    assert.equal(provider.phase, "idle");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["C-m"], ["Escape"]],
      "the exact bare command must enter directly instead of timing out into cleanup"
    );
  });

  for (const [name, phase, screen] of [
    [
      "profiled completion",
      "draft",
      modelCommandScreen([exactSuggestion])
    ],
    [
      "bare command",
      "bare",
      modelBareCommandScreen()
    ]
  ] as const) {
    await t.test(`continues an authorized exact ${name} into catalog discovery`, async () => {
      const provider = new ModelControlProvider([exactSuggestion]);
      provider.phase = phase;
      provider.setScreen(PANE.target, screen);
      const bridge = createModelBridge(provider);
      const control = terminalControl(codexTerminalAgentAdapter);
      const residual = await bridge.inspectModelControlResidual(
        "codex", control, "0.154.0", plan, { beforeInput() {} }
      );
      assert.equal(residual.state, "recoverable");
      if (residual.state !== "recoverable") return;

      const result = await bridge.modelOptions(
        "codex",
        control,
        "0.154.0",
        plan,
        {
          beforeInput() {},
          loadCodexCatalog: catalog,
          initialResidual: residual
        }
      );

      assert.equal(result.catalog.current.model, "gpt-5.6-sol");
      assert.equal(provider.phase, "idle");
      assert.equal(
        provider.operations.some((operation) => operation.kind === "text"),
        false
      );
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys")
          .map((operation) => operation.kind === "keys" ? operation.keys : []),
        [["C-m"], ["Escape"]]
      );
    });
  }

  await t.test("residual continuation drift dispatches zero Enter", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "bare";
    provider.setScreen(PANE.target, [
      "Ready",
      "› /model",
      "  gpt-5.6-sol high · /repo"
    ].join("\n"));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, { beforeInput() {} }
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    provider.replaceOnDraftCapture = {
      // Two discovery captures follow the two captures above. Replace the
      // fifth draft capture at the final pre-Enter proof.
      capture: 5,
      screen: ["Ready", "» /model", "  gpt-5.6-sol high · /repo"].join("\n")
    };

    await assert.rejects(
      bridge.modelOptions("codex", control, "0.154.0", plan, {
        beforeInput() {},
        loadCodexCatalog: catalog,
        initialResidual: residual
      }),
      /changed immediately before Enter/u
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("exact suggestion authorizes Escape cleanup after a pre-Enter failure", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    let authorityChecks = 0;
    await assert.rejects(createModelBridge(provider).modelOptions(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "0.154.0",
      plan,
      {
        beforeInput: () => {
          authorityChecks += 1;
          if (authorityChecks === 2) {
            throw new Error("synthetic authority failure before Enter");
          }
        },
        loadCodexCatalog: catalog
      }
    ), /synthetic authority failure before Enter/u);
    assert.equal(provider.phase, "idle");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"], ["C-u"]]
    );
  });

  for (const [name, suggestions] of [
    ["different suggestion", ["  /models  choose an unrelated command"]],
    ["multiple suggestions", [
      exactSuggestion,
      "  /model-status  show a second matching command"
    ]]
  ] as const) {
    await t.test(name, async () => {
      const provider = new ModelControlProvider(suggestions);
      provider.throwOnDraftCapture = 2;
      let authorityChecks = 0;
      await assert.rejects(createModelBridge(provider).modelOptions(
        "codex",
        terminalControl(codexTerminalAgentAdapter),
        "0.154.0",
        plan,
        {
          beforeInput: () => { authorityChecks += 1; },
          loadCodexCatalog: catalog
        }
      ), /synthetic bounded capture stop/u);
      assert.equal(authorityChecks, 3);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys")
          .map((operation) => operation.kind === "keys" ? operation.keys : []),
        [["Escape"], ["C-u"]]
      );
    });
  }

  await t.test("unstyled footerless transcript text authorizes no input", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.throwOnDraftCapture = 2;
    provider.overrideScreenAfterText = [
      "Ready",
      "› /model",
      "",
      exactSuggestion
    ].join("\n");
    await assert.rejects(createModelBridge(provider).modelOptions(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "0.154.0",
      plan,
      { beforeInput() {}, loadCodexCatalog: catalog }
    ), /synthetic bounded capture stop/u);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("a prompt replacing the final proof dispatches no Enter", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    // Poll capture, final logical capture, then the transport-bound capture.
    provider.replaceOnDraftCapture = {
      capture: 3,
      screen: strictCodexCommandApprovalScreen("npm test")
    };
    await assert.rejects(createModelBridge(provider).modelOptions(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "0.154.0",
      plan,
      { beforeInput() {}, loadCodexCatalog: catalog }
    ), /changed before key dispatch/u);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("an input owner appearing at the transport-bound empty proof receives no /model text", async () => {
    class InputOwnerBeforeTextProvider extends ModelControlProvider {
      private captureCount = 0;

      override async capture(
        target: TerminalEndpointRef | string,
        options: {
          scrollbackLines?: number;
          socketPath?: string;
          preserveEscapes?: boolean;
        } = {}
      ): Promise<string> {
        this.captureCount += 1;
        // openModelPicker's third capture is the bridge's private proof bound
        // directly to provider text delivery.
        if (this.captureCount === 3) {
          this.setScreen(target, [
            transportInputOwnerMarker,
            "",
            modelIdleScreen()
          ].join("\n"));
        }
        return super.capture(target, options);
      }
    }
    const provider = new InputOwnerBeforeTextProvider([exactSuggestion]);

    await assert.rejects(createModelBridge(
      provider, transportInputOwnerAdapter
    ).modelOptions(
      "codex",
      terminalControl(transportInputOwnerAdapter),
      "0.154.0",
      plan,
      { beforeInput() {}, loadCodexCatalog: catalog }
    ), /changed before \/model text delivery/u);
    assert.equal(
      provider.operations.some((operation) =>
        operation.kind === "text" || operation.kind === "keys"
      ),
      false
    );
  });

  await t.test("repairs one exact footerless /model residual to an exact empty Composer", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    let authorityChecks = 0;
    const options = {
      beforeInput() { authorityChecks += 1; }
    };

    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    assert.equal(residual.kind, "profiled_command_popup");

    const result = await bridge.repairModelControlResidual(
      "codex",
      control,
      "0.154.0",
      plan,
      residual.fingerprint,
      options
    );
    assert.deepEqual({
      outcome: result.outcome,
      terminalInputAttempted: result.terminalInputAttempted,
      composerPostcondition: result.composerPostcondition,
      doNotRetry: result.doNotRetry
    }, {
      outcome: "repaired",
      terminalInputAttempted: true,
      composerPostcondition: "empty",
      doNotRetry: false
    });
    assert.equal(provider.phase, "idle");
    assert.equal(authorityChecks, 2);
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"], ["C-u"]]
    );

    const after = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(after.state, "absent");
    assert.match(after.reason, /already empty/u);
  });

  await t.test("repairs an exact bare /model without a preceding Escape", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "bare";
    provider.setScreen(PANE.target, [
      "Ready",
      "› /model",
      "  gpt-5.6-sol high · /repo"
    ].join("\n"));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, { beforeInput() {} }
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    assert.equal(residual.kind, "bare_command");

    const result = await bridge.repairModelControlResidual(
      "codex", control, "0.154.0", plan, residual.fingerprint,
      { beforeInput() {} }
    );
    assert.equal(result.outcome, "repaired");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["C-u"]]
    );
  });

  await t.test("a non-model draft has no repair authority and receives zero input", async () => {
    const provider = new ModelControlProvider([
      "  /status  show current session configuration and token usage"
    ]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen(
      ["  /status  show current session configuration and token usage"],
      "/status"
    ));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };

    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "absent");
    await assert.rejects(
      bridge.repairModelControlResidual(
        "codex", control, "0.154.0", plan, "0".repeat(64), options
      ),
      /not one exact profiled \/model residual/u
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  for (const [name, screen] of [
    ["approval", strictCodexCommandApprovalScreen("npm test")],
    ["questionnaire", [
      "  Question 1/1 (1 unanswered)",
      "  Choose an option.",
      "",
      "  › 1. Option 1  First choice.",
      "    2. Option 2  Second choice.",
      "",
      "  tab to add notes | enter to submit answer | esc to interrupt"
    ].join("\n")],
    ["question editor", [
      "• Queued follow-up inputs",
      "",
      "  1 of 2",
      "  Which way?",
      "",
      "  Type your answer",
      "",
      "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
    ].join("\n")],
    ["active-writer viewer", [
      "  🔒   This conversation is open in another app  R to Retry",
      "      Close it there and press R to continue here.",
      "",
      "   r retry   esc/ctrl+c/q exit   ctrl+t transcript"
    ].join("\n")]
  ] as const) {
    await t.test(`${name} refuses residual repair with zero input`, async () => {
      const provider = new ModelControlProvider([exactSuggestion]);
      provider.setScreen(PANE.target, screen);
      const bridge = createModelBridge(provider);
      const control = terminalControl(codexTerminalAgentAdapter);
      const options = { beforeInput() {} };

      const residual = await bridge.inspectModelControlResidual(
        "codex", control, "0.154.0", plan, options
      );
      assert.notEqual(residual.state, "recoverable");
      await assert.rejects(
        bridge.repairModelControlResidual(
          "codex", control, "0.154.0", plan, "0".repeat(64), options
        )
      );
      assert.equal(
        provider.operations.some((operation) => operation.kind === "keys"),
        false
      );
    });
  }

  await t.test("screen drift before the first cleanup key fails with zero input", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const discoveryOptions = { beforeInput() {} };
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, discoveryOptions
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    let boundaryChecks = 0;

    await assert.rejects(
      bridge.repairModelControlResidual(
        "codex",
        control,
        "0.154.0",
        plan,
        residual.fingerprint,
        {
          beforeInput() {
            boundaryChecks += 1;
            provider.setScreen(PANE.target, modelCommandScreen(
              ["  /status  show current session configuration and token usage"],
              "/status"
            ));
          }
        }
      ),
      /exact \/model composer changed during cleanup/u
    );
    assert.equal(boundaryChecks, 1);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("an input owner appearing at the transport-bound cleanup proof receives zero input", async () => {
    const provider = new ModelControlProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    // Two captures above, two inside repair, then unwind's logical capture and
    // final command capture. The seventh draft capture is the bridge's private
    // transport-bound proof immediately before it would dispatch Escape.
    provider.replaceOnDraftCapture = {
      capture: 7,
      screen: [
        transportInputOwnerMarker,
        "",
        modelCommandScreen([exactSuggestion])
      ].join("\n")
    };

    const raced = await createModelBridge(
      provider, transportInputOwnerAdapter
    ).repairModelControlResidual(
      "codex",
      terminalControl(transportInputOwnerAdapter),
      "0.154.0",
      plan,
      residual.fingerprint,
      options
    );
    assert.equal(raced.outcome, "uncertain");
    assert.equal(raced.doNotRetry, true);
    assert.match(raced.reason ?? "", /changed before key dispatch/u);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("physical terminal identity drift rejects repair with zero input", async () => {
    class IdentityDriftProvider extends ModelControlProvider {
      drift = false;

      override async resolve(
        terminal: TerminalEndpointRef
      ): Promise<TerminalEndpointRef> {
        const resolved = await super.resolve(terminal);
        return this.drift
          ? { ...resolved, processAnchorPid: (resolved.processAnchorPid ?? 0) + 1 }
          : resolved;
      }
    }
    const provider = new IdentityDriftProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;
    provider.drift = true;

    await assert.rejects(
      bridge.repairModelControlResidual(
        "codex", control, "0.154.0", plan, residual.fingerprint, options
      ),
      /stable resource or process anchor changed/u
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("a post-key proof failure is uncertain and never retries cleanup", async () => {
    class PostKeyCaptureFailureProvider extends ModelControlProvider {
      keyDispatched = false;

      override async capture(
        target: TerminalEndpointRef | string,
        options: {
          scrollbackLines?: number;
          socketPath?: string;
          preserveEscapes?: boolean;
        } = {}
      ): Promise<string> {
        if (this.keyDispatched) {
          throw new Error("synthetic post-key capture failure");
        }
        return super.capture(target, options);
      }

      override async sendKeys(
        target: TerminalEndpointRef | string,
        keys: readonly string[],
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendKeys(target, keys, options);
        this.keyDispatched = true;
      }
    }
    const provider = new PostKeyCaptureFailureProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;

    const result = await bridge.repairModelControlResidual(
      "codex", control, "0.154.0", plan, residual.fingerprint, options
    );
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.terminalInputAttempted, true);
    assert.equal(result.composerPostcondition, "unproven");
    assert.equal(result.doNotRetry, true);
    assert.match(result.reason ?? "", /synthetic post-key capture failure/u);
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"]],
      "an uncertain post-key result must not dispatch C-u or retry Escape"
    );
  });

  await t.test("a nonempty post-cleanup Composer cannot report repaired", async () => {
    class UnprovenEmptyProvider extends ModelControlProvider {
      clearDispatched = false;

      override async capture(
        target: TerminalEndpointRef | string,
        options: {
          scrollbackLines?: number;
          socketPath?: string;
          preserveEscapes?: boolean;
        } = {}
      ): Promise<string> {
        if (this.clearDispatched) {
          throw new Error("synthetic nonempty post-cleanup Composer");
        }
        return super.capture(target, options);
      }

      override async sendKeys(
        target: TerminalEndpointRef | string,
        keys: readonly string[],
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendKeys(target, keys, options);
        if (keys[0] === "C-u") this.clearDispatched = true;
      }
    }
    const provider = new UnprovenEmptyProvider([exactSuggestion]);
    provider.phase = "draft";
    provider.setScreen(PANE.target, modelCommandScreen([exactSuggestion]));
    const bridge = createModelBridge(provider);
    const control = terminalControl(codexTerminalAgentAdapter);
    const options = { beforeInput() {} };
    const residual = await bridge.inspectModelControlResidual(
      "codex", control, "0.154.0", plan, options
    );
    assert.equal(residual.state, "recoverable");
    if (residual.state !== "recoverable") return;

    const result = await bridge.repairModelControlResidual(
      "codex", control, "0.154.0", plan, residual.fingerprint, options
    );
    assert.equal(result.outcome, "uncertain");
    assert.equal(result.composerPostcondition, "unproven");
    assert.equal(result.doNotRetry, true);
    assert.match(result.reason ?? "", /nonempty post-cleanup Composer/u);
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"], ["C-u"]]
    );
  });
});

test("Claude model control accepts only its selected 2.1.266 /model suggestion", async (t) => {
  const plan = planTerminalModelControl(
    probeTerminalModelControl("claude", "2.1.266")
  );
  const divider = "─".repeat(80);
  const exactModelSuggestion =
    "/model                        Set the AI model for Claude Code (currently deepseek-flash)";
  const idleScreen = [divider, "❯ ", divider].join("\n");
  class ClaudeModelControlProvider extends RecordingTerminalProvider {
    phase: "idle" | "draft" | "bare" | "picker" = "idle";
    nativeAgentState: "idle" | "status_dialog" = "idle";
    effort: "high" | "low" = "high";
    draftCaptures = 0;
    throwOnDraftCapture?: number;
    dropDialogAfterPickerCapture = false;
    replacePickerAfterArmedDialogVerification = false;
    armedDialogVerifications = 0;

    constructor(readonly suggestions: readonly string[]) {
      super([PANE], { [PANE.target]: idleScreen });
    }

    override async capture(
      target: TerminalEndpointRef | string,
      options: {
        scrollbackLines?: number;
        socketPath?: string;
        preserveEscapes?: boolean;
      } = {}
    ): Promise<string> {
      if (this.phase === "draft") {
        this.draftCaptures += 1;
        if (this.draftCaptures === this.throwOnDraftCapture) {
          throw new Error("synthetic bounded Claude capture stop");
        }
      }
      const screen = await super.capture(target, options);
      if (this.phase === "picker" && this.dropDialogAfterPickerCapture) {
        this.nativeAgentState = "idle";
      }
      return screen;
    }

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      assert.equal(text, "/model");
      this.phase = "draft";
      this.setScreen(target, [
        ...this.suggestions,
        divider,
        "❯\u00a0/model",
        divider,
        "⏵⏵ plan mode on · shift+tab to cycle"
      ].join("\n"));
    }

    override async sendKeys(
      target: TerminalEndpointRef | string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendKeys(target, keys, options);
      assert.equal(keys.length, 1);
      if (keys[0] === "C-m" && this.phase === "draft") {
        this.phase = "picker";
        this.nativeAgentState = "status_dialog";
        this.paintPicker(target);
        return;
      }
      if (keys[0] === "Right" && this.phase === "picker") {
        this.effort = this.effort === "high" ? "low" : "high";
        this.paintPicker(target);
        return;
      }
      if (keys[0] === "Escape" && this.phase === "draft") {
        this.phase = "bare";
        this.setScreen(target, [
          divider,
          "❯ /model",
          divider,
          "⏵⏵ plan mode on · shift+tab to cycle"
        ].join("\n"));
        return;
      }
      if (keys[0] === "C-u" && this.phase === "bare") {
        this.phase = "idle";
        this.setScreen(target, idleScreen);
        return;
      }
      assert.equal(keys[0], "Escape");
      this.phase = "idle";
      this.nativeAgentState = "idle";
      this.setScreen(target, idleScreen);
    }

    private paintPicker(target: TerminalEndpointRef | string): void {
      this.setScreen(target, [
        "▔".repeat(80),
        "   Select model",
        "   Switch between Claude models.",
        "   ❯ 1. Claude Sonnet 4.6 ✔  Claude Sonnet 4.6 model",
        `   ${this.effort === "high" ? "● High" : "○ Low"} effort ←/→ to adjust`,
        "   Enter to set as default · s to use this session only · Esc to cancel"
      ].join("\n"));
    }

    replacePickerWithPermissionDialog(): void {
      this.setScreen(PANE.target, [
        "Permission request",
        "Allow this unrelated command?",
        "❯ 1. Yes",
        "  2. No"
      ].join("\n"));
    }
  }
  const runtime = {
    pid: PANE.panePid,
    nativeSessionId: "claude-model-control-session",
    nativeProcessStartedAt: 1_789_000_000_000,
    requireExactClaudeAgentRow: true,
    exactClaudeAgentState: "idle" as const
  };
  const catalog = async () => ({ models: [] });
  const createModelBridge = (provider: ClaudeModelControlProvider) =>
    new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([
        createClaudeTerminalAgentAdapter()
      ]),
      terminalProvider: provider,
      async verifyIdentity(request) {
        if (
          request.runtime?.exactClaudeAgentState !== provider.nativeAgentState
        ) {
          throw new Error(
            `synthetic Claude native state is ${provider.nativeAgentState}`
          );
        }
        if (
          provider.replacePickerAfterArmedDialogVerification &&
          request.runtime?.exactClaudeAgentState === "status_dialog"
        ) {
          provider.armedDialogVerifications += 1;
          if (provider.armedDialogVerifications === 3) {
            provider.replacePickerWithPermissionDialog();
          }
        }
        return { terminalControl: request.terminalControl };
      },
      async sleep() {}
    });

  await t.test("accepts the exact selected row and restores idle", async () => {
    const provider = new ClaudeModelControlProvider([
      exactModelSuggestion,
      "/claude-api                  Configure a Claude API model",
      "/loop                        Run a prompt repeatedly with the current model",
      "/effort                      Adjust model usage"
    ]);
    const result = await createModelBridge(provider).modelOptions(
      "claude",
      terminalControl(createClaudeTerminalAgentAdapter()),
      "2.1.266",
      plan,
      {
        beforeInput: () => undefined,
        loadCodexCatalog: catalog,
        runtime
      }
    );
    assert.deepEqual(result.catalog.current, {
      model: "sonnet-4.6", reasoningEffort: "high"
    });
    assert.equal(provider.phase, "idle");
    assert.ok(provider.operations.some((operation) =>
      operation.kind === "keys" && operation.keys[0] === "C-m"
    ));
  });

  await t.test("exact row authorizes Escape cleanup before Enter", async () => {
    const provider = new ClaudeModelControlProvider([exactModelSuggestion]);
    let authorityChecks = 0;
    await assert.rejects(createModelBridge(provider).modelOptions(
      "claude",
      terminalControl(createClaudeTerminalAgentAdapter()),
      "2.1.266",
      plan,
      {
        runtime,
        beforeInput: () => {
          authorityChecks += 1;
          if (authorityChecks === 2) {
            throw new Error("synthetic Claude authority failure before Enter");
          }
        }
      }
    ), /synthetic Claude authority failure before Enter/u);
    assert.equal(provider.phase, "idle");
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["Escape"], ["C-u"]]
    );
  });

  for (const [name, suggestions] of [
    ["wrong selected description", [
      "/model  Replace this verified description"
    ]],
    ["missing selected model row", [
      "/loop  Run a prompt repeatedly"
    ]],
    ["ambiguous selected row", [
      `❯ ${exactModelSuggestion}`,
      "❯ /loop  Run a prompt repeatedly"
    ]]
  ] as const) {
    await t.test(name, async () => {
      const provider = new ClaudeModelControlProvider(suggestions);
      provider.throwOnDraftCapture = 2;
      let authorityChecks = 0;
      await assert.rejects(createModelBridge(provider).modelOptions(
        "claude",
        terminalControl(createClaudeTerminalAgentAdapter()),
        "2.1.266",
        plan,
        {
          beforeInput: () => { authorityChecks += 1; },
          runtime
        }
      ), /synthetic bounded Claude capture stop/u);
      assert.equal(authorityChecks, 3);
      assert.equal(provider.phase, "idle");
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys")
          .map((operation) => operation.kind === "keys" ? operation.keys : []),
        [["Escape"], ["C-u"]]
      );
    });
  }

  await t.test("a stale picker screen cannot authorize a key after agents returns idle", async () => {
    const provider = new ClaudeModelControlProvider([exactModelSuggestion]);
    provider.dropDialogAfterPickerCapture = true;
    await assert.rejects(
      createModelBridge(provider).modelOptions(
        "claude",
        terminalControl(createClaudeTerminalAgentAdapter()),
        "2.1.266",
        plan,
        { beforeInput: () => undefined, runtime }
      ),
      /synthetic Claude native state is idle/u
    );
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["C-m"]],
      "the command may open the picker, but no picker key may target an idle composer"
    );
  });

  await t.test("a different dialog cannot consume a picker permit after final identity verification", async () => {
    const provider = new ClaudeModelControlProvider([exactModelSuggestion]);
    let authorityChecks = 0;
    await assert.rejects(
      createModelBridge(provider).modelOptions(
        "claude",
        terminalControl(createClaudeTerminalAgentAdapter()),
        "2.1.266",
        plan,
        {
          runtime,
          beforeInput: () => {
            authorityChecks += 1;
            if (authorityChecks === 3) {
              provider.replacePickerAfterArmedDialogVerification = true;
            }
          }
        }
      ),
      /exact Claude model picker changed before key dispatch/u
    );
    assert.deepEqual(
      provider.operations.filter((operation) => operation.kind === "keys")
        .map((operation) => operation.kind === "keys" ? operation.keys : []),
      [["C-m"]],
      "no model-picker key may land in a replacement dialog"
    );
  });
});

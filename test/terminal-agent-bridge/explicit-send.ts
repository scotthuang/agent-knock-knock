import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  codexTerminalAgentAdapter,
  inspectCodexAsyncQuestionInputMode,
  TerminalAgentBridge,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  TerminalControlInputNotSentError,
  PANE,
  MANAGED_CLAUDE_RUNTIME,
  RecordingTerminalProvider,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  codexPaddedStyledIdleScreen,
  strictCodexCommandApprovalScreen,
  type TerminalPane,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("explicit Codex Send replaces even when the Composer is off-screen", async (t) => {
  const request = Array.from(
    { length: 19 },
    (_, index) => `line ${index + 1}: the user's newest explicit request`
  ).join("\n");
  const workingLine =
    "• Working (8s · esc to interrupt) · 1 background terminal running";
  const cases = [
    {
      name: "empty composer",
      screen: codexPaddedStyledIdleScreen(91)
    },
    {
      name: "same visible draft",
      screen: `› ${request}\ngpt-5.6-sol high · /repo`
    },
    {
      name: "different visible draft",
      screen: "› an older unrelated draft\ngpt-5.6-sol high · /repo"
    },
    {
      name: "off-screen composer",
      screen: Array.from(
        { length: 30 },
        (_, index) => `Assistant output fills viewport row ${index + 1}`
      ).join("\n")
    },
    {
      name: "working with a background terminal",
      screen: [
        workingLine,
        "Assistant output fills the visible viewport; composer is below it."
      ].join("\n")
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      let injectedAt: number | undefined;
      let mutationStarted = false;
      const narrowPane: TerminalPane = {
        ...PANE,
        columns: 91,
        rows: 30
      };
      class BlindReplacementProvider extends RecordingTerminalProvider {
        override async capture(
          terminal: TerminalEndpointRef | string,
          options: {
            scrollbackLines?: number;
            socketPath?: string;
            preserveEscapes?: boolean;
          } = {}
        ): Promise<string> {
          if (mutationStarted) {
            throw new Error("post-mutation Composer capture is forbidden");
          }
          return super.capture(terminal, options);
        }

        override async sendText(
          terminal: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          assert.equal(mutationStarted, true);
          injectedAt = nowMs;
          await super.sendText(terminal, text, options);
        }

        override async sendKeys(
          terminal: TerminalEndpointRef | string,
          keys: readonly string[],
          options: { socketPath?: string } = {}
        ): Promise<void> {
          if (keys.includes("C-u")) {
            mutationStarted = true;
          }
          if (keys.includes("C-m")) {
            assert.notEqual(injectedAt, undefined);
            assert.ok(nowMs - Number(injectedAt) >= 121);
          }
          await super.sendKeys(terminal, keys, options);
        }
      }
      const provider = new BlindReplacementProvider([narrowPane], {
        [narrowPane.target]: testCase.screen
      });
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });
      const reservations: Array<{ target: string; text: string }> = [];
      const result = await bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        {
          beforeMutationReservation: ({ terminalControl, text }) => {
            reservations.push({ target: terminalControl.target, text });
          }
        }
      );
      assert.deepEqual(reservations, [{ target: PANE.target, text: request }]);
      assert.deepEqual(result, {
        stage: "enter_dispatched",
        terminalControl: result.terminalControl,
        disposition: "replaced_current_composer",
        clearCount: 1,
        textInjectionCount: 1,
        enterCount: 1
      });
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        ["keys:C-u", "text", "keys:C-m"]
      );
      assert.equal(
        provider.operations.filter((operation) => operation.kind === "capture")
          .length,
        2,
        "only the two pre-mutation approval/identity scans are allowed"
      );
    });
  }
});

test("explicit Codex Send keeps approval as a zero-input boundary", async (t) => {
  await t.test("an existing approval blocks Send", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: strictCodexCommandApprovalScreen()
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("an approval appearing during reservation blocks Send", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "Assistant output with the Composer off-screen"
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        {
          beforeMutationReservation() {
            provider.setScreen(PANE.target, strictCodexCommandApprovalScreen());
          }
        }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("a 0.154 active-writer resume viewer blocks Send", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: [
        "  🔒   This conversation is open in another app  R to Retry",
        "      Close it there and press R to continue here.",
        "",
        "   r retry   esc/ctrl+c/q exit   ctrl+t transcript"
      ].join("\n")
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("a narrow remapped active-writer viewer blocks Send", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: [
        "  🔒",
        "  This conversation is open",
        "  in another app",
        "  R to Retry",
        "      Close it there and press",
        "      R to continue here.",
        "",
        "   r retry",
        "   esc/ctrl+c/q exit",
        "   ctrl+k transcript"
      ].join("\n")
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("an active-writer viewer without transcript binding blocks Send", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: [
        "  🔒   This conversation is open in another app  R to Retry",
        "      Close it there and press R to continue here.",
        "",
        "   r retry   esc/ctrl+c/q exit"
      ].join("\n")
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("quoted active-writer text does not hide a later live Composer", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: [
        "  🔒   This conversation is open in another app  R to Retry",
        "      Close it there and press R to continue here.",
        "",
        "   r retry   esc/ctrl+c/q exit   ctrl+t transcript",
        "",
        "› Ask Codex to do anything",
        "gpt-5.6-sol high · /repo"
      ].join("\n")
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await bridge.sendUserExplicitCodex(
      terminalControl(codexTerminalAgentAdapter),
      "new explicit request",
      { beforeMutationReservation() {} }
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u", "text", "keys:C-m"]
    );
  });
});

test("Codex 0.154 async questions preserve explicit Send input ownership", async (t) => {
  const mainComposer = [
    "› Summarize recent commits",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const collapsed = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ? 2 questions · 15s",
    "    ⌥ + ↑ to answer",
    mainComposer
  ].join("\n");
  const collapsedWithoutVisibleComposer = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ? 2 questions · 15s",
    "    ⌥ + ↑ to answer"
  ].join("\n");
  const collapsedWithoutHintOrVisibleComposer = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ? 2 questions · 15s"
  ].join("\n");
  const ordinaryQueue = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ↳ queued follow-up",
    mainComposer
  ].join("\n");
  const queueDescribingShortcuts = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ↳ document enter submit   ctrl + ] skip and main",
    "    prompt while this long message wraps",
    "    ⌥ + ↑ edit last queued message"
  ].join("\n");
  const queueContainingLiteralHeader = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ↳ quote this exact UI heading:",
    "    • Queued follow-up inputs",
    "     enter submit   ctrl + ] skip and main prompt",
    "    ⌥ + ↑ edit last queued message"
  ].join("\n");
  const queueThenCollapsedQuestions = [
    "• Working (7s • esc to interrupt)",
    "",
    "• Queued follow-up inputs",
    "  ↳ document enter submit   ctrl + ] skip and main",
    "    prompt while this queued message wraps",
    "    ⌥ + ↑ edit last queued message",
    "  ? 2 questions · 15s",
    "    ⌥ + ↑ to answer",
    mainComposer
  ].join("\n");
  const expandedOptions = [
    "• Queued follow-up inputs",
    "",
    "  2 of 2",
    "  Second?",
    "",
    "  › 1. Next",
    "    2. Other",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ prev question   ⌥ + ↑ queued messages"
  ].join("\n");
  const expandedFreeText = [
    "• Queued follow-up inputs",
    "",
    "  1 of 2",
    "  Which way?",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt   ⌥ + ↑ next question"
  ].join("\n");
  const narrowTruncated = [
    "  2 of",
    "  Secon",
    "  d",
    "  › x",
    "  ente…",
    "  ctrl…"
  ].join("\n");
  const clippedChoice = [
    "  Second",
    "",
    "  › 2. A suggested answer that is long enough to",
    "       wrap across multiple rows",
    "",
    "  Expand terminal to read the entire option"
  ].join("\n");
  const wrappedHeader = [
    "• Queued follow-up",
    "  inputs",
    "",
    "  1 of 2",
    "  Which way?",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip",
    "  ⌥ + ↓ main prompt"
  ].join("\n");
  const remappedSplitFooter = [
    "  2 of 2",
    "  Second?",
    "",
    "  › 1. Next",
    "    2. Other",
    "",
    "  enter submit",
    "  ctrl-alt-q skip"
  ].join("\n");
  const staleComposerThenExpanded = [
    "• Queued follow-up inputs",
    "",
    "› stale main prompt repaint",
    "gpt-5.6-sol high · /repo",
    "",
    "  1 of 2",
    "  Which way?",
    "",
    "  Type your answer",
    "",
    "  enter submit   ctrl + ] skip   ⌥ + ↓ main prompt"
  ].join("\n");
  const missingSubmitFooter = [
    "  Type your answer",
    "  ctrl+] skip",
    "  alt-down main prompt"
  ].join("\n");
  const singleBoundFooter = [
    "  Type your answer",
    "  ctrl+] skip"
  ].join("\n");
  const mainMultilineDraftUsingEditorVocabulary = [
    "› document this exact sample",
    "  gpt-5.6-sol high · /fake-draft-statusline",
    "  Type your answer",
    "  1 of 2",
    "  enter submit",
    "  ctrl-alt-q skip",
    "  alt-down main prompt",
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const staleCollapsedThenPartialEditor = [
    "• Queued follow-up inputs",
    "  ? 2 questions · 15s",
    "    ⌥ + ↑ to answer",
    "  1 of 2",
    "  Type your answer"
  ].join("\n");

  assert.equal(inspectCodexAsyncQuestionInputMode(mainComposer), "absent");
  assert.equal(inspectCodexAsyncQuestionInputMode(collapsed), "collapsed");
  assert.equal(
    inspectCodexAsyncQuestionInputMode(collapsedWithoutVisibleComposer),
    "collapsed"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(collapsedWithoutHintOrVisibleComposer),
    "collapsed"
  );
  assert.equal(inspectCodexAsyncQuestionInputMode(ordinaryQueue), "absent");
  assert.equal(
    inspectCodexAsyncQuestionInputMode(queueDescribingShortcuts),
    "absent"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(queueContainingLiteralHeader),
    "absent"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(queueThenCollapsedQuestions),
    "collapsed"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(expandedOptions),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(expandedFreeText),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(narrowTruncated),
    "ambiguous"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(clippedChoice),
    "ambiguous"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(wrappedHeader),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(remappedSplitFooter),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(staleComposerThenExpanded),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(missingSubmitFooter),
    "expanded"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(singleBoundFooter),
    "ambiguous"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(mainMultilineDraftUsingEditorVocabulary),
    "absent"
  );
  assert.equal(
    inspectCodexAsyncQuestionInputMode(staleCollapsedThenPartialEditor),
    "ambiguous"
  );
  for (const weakEvidence of [
    "  1 of 2",
    "  › 1. documentation example",
    "  Type your answer"
  ]) {
    assert.equal(inspectCodexAsyncQuestionInputMode(weakEvidence), "absent");
  }

  for (const [name, screen] of [
    ["expanded options", expandedOptions],
    ["expanded free text", expandedFreeText],
    ["narrow truncated editor", narrowTruncated],
    ["clipped option editor", clippedChoice],
    ["wrapped header and footer", wrappedHeader],
    ["remapped split footer", remappedSplitFooter],
    ["stale Composer before expanded editor", staleComposerThenExpanded],
    ["collapsed summary before a partial editor", staleCollapsedThenPartialEditor],
    ["editor footer without submit binding", missingSubmitFooter],
    ["editor with one remaining footer binding", singleBoundFooter]
  ] as const) {
    await t.test(`${name} rejects before any terminal mutation`, async () => {
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: screen
      });
      const bridge = createBridge(codexTerminalAgentAdapter, provider);
      await assert.rejects(
        bridge.sendUserExplicitCodex(
          terminalControl(codexTerminalAgentAdapter),
          "new explicit request",
          { beforeMutationReservation() {} }
        ),
        TerminalInputNotStartedError
      );
      assert.equal(
        provider.operations.some((operation) => operation.kind !== "capture"),
        false
      );
    });
  }

  for (const [name, screen] of [
    ["collapsed questions", collapsed],
    ["collapsed questions without a visible Composer", collapsedWithoutVisibleComposer],
    ["collapsed questions without an edit hint", collapsedWithoutHintOrVisibleComposer],
    ["ordinary queued messages", ordinaryQueue],
    ["queued shortcut prose without a statusline", queueDescribingShortcuts],
    ["queued text containing the literal header", queueContainingLiteralHeader],
    ["queued text followed by collapsed questions", queueThenCollapsedQuestions],
    ["main multiline draft using editor vocabulary", mainMultilineDraftUsingEditorVocabulary]
  ] as const) {
    await t.test(`${name} keeps the main Composer sendable`, async () => {
      let nowMs = 0;
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: screen
      });
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });
      await bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        { beforeMutationReservation() {} }
      );
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        ["keys:C-u", "text", "keys:C-m"]
      );
    });
  }

  await t.test(
    "collapsed-to-expanded reservation race rejects before mutation",
    async () => {
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: collapsed
      });
      const bridge = createBridge(codexTerminalAgentAdapter, provider);
      let reservationCalls = 0;
      let clearHookCalls = 0;
      await assert.rejects(
        bridge.sendUserExplicitCodex(
          terminalControl(codexTerminalAgentAdapter),
          "new explicit request",
          {
            beforeMutationReservation() {
              reservationCalls += 1;
              provider.setScreen(PANE.target, expandedOptions);
            },
            onComposerClearDispatched() {
              clearHookCalls += 1;
            }
          }
        ),
        (error: unknown) => {
          assert.ok(error instanceof TerminalInputNotStartedError);
          assert.match(error.message, /async question editor.*owns terminal input/u);
          return true;
        }
      );
      assert.equal(reservationCalls, 1);
      assert.equal(clearHookCalls, 0);
      assert.equal(
        provider.operations.filter((operation) => operation.kind === "capture")
          .length,
        2
      );
      assert.equal(
        provider.operations.some((operation) => operation.kind !== "capture"),
        false
      );
    }
  );
});

test("managed user Send recaptures exact empty immediately before text", async (t) => {
  const request = "the user's newest managed request";

  await t.test("exact-empty Codex proceeds once", async () => {
    let nowMs = 0;
    class ManagedGuardProvider extends RecordingTerminalProvider {
      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(target, `› ${text}\ngpt-5.6-sol high · /repo`);
      }
    }
    const provider = new ManagedGuardProvider([PANE], {
      [PANE.target]: codexPaddedStyledIdleScreen(80)
    });
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
      request,
      {
        requireExactEmptyComposerBeforeText: true,
        requireExactComposerBeforeEnter: true
      }
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["text", "keys:C-m"]
    );
  });

  await t.test("user-explicit managed Codex ignores post-text Composer visibility", async () => {
    let nowMs = 0;
    let textInjected = false;
    let injectedAt = 0;
    class ManagedExplicitProvider extends RecordingTerminalProvider {
      override async capture(
        terminal: TerminalEndpointRef | string,
        options: {
          scrollbackLines?: number;
          socketPath?: string;
          preserveEscapes?: boolean;
        } = {}
      ): Promise<string> {
        if (textInjected) {
          throw new Error("post-text Composer capture must not run");
        }
        return super.capture(terminal, options);
      }

      override async sendText(
        terminal: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        textInjected = true;
        injectedAt = nowMs;
        await super.sendText(terminal, text, options);
      }

      override async sendKeys(
        terminal: TerminalEndpointRef | string,
        keys: readonly string[],
        options: { socketPath?: string } = {}
      ): Promise<void> {
        if (keys.includes("C-m")) {
          assert.ok(nowMs - injectedAt >= 121);
        }
        await super.sendKeys(terminal, keys, options);
      }
    }
    const provider = new ManagedExplicitProvider([PANE], {
      [PANE.target]: codexPaddedStyledIdleScreen(80)
    });
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
      request,
      {
        requireExactEmptyComposerBeforeText: true,
        requireExactComposerBeforeEnter: true,
        userExplicitEnterAfterTextWithoutComposerVeto: true
      }
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["text", "keys:C-m"]
    );
  });

  await t.test("post-text bookkeeping failure cannot strand an explicit draft", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: codexPaddedStyledIdleScreen(80)
    });
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
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true,
          userExplicitEnterAfterTextWithoutComposerVeto: true,
          onTransportStage({ stage }) {
            if (stage === "text_injected") {
              throw new Error("durable text receipt is unavailable");
            }
          },
          beforeEnter() {
            throw new Error("managed pre-Enter bookkeeping is unavailable");
          }
        }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["text", "keys:C-m"],
      "the user request must still receive Enter exactly once"
    );
  });

  await t.test("Codex draft drift before text proves zero input", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: codexPaddedStyledIdleScreen(80)
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.send(
        "codex",
        terminalControl(codexTerminalAgentAdapter),
        request,
        {
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true,
          beforeText() {
            provider.setScreen(
              PANE.target,
              "› a human draft arrived after preflight\n" +
                "gpt-5.6-sol high · /repo"
            );
          }
        }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("exact-empty Claude manual mode proceeds once", async () => {
    const divider = "────────────────────────────────────────────────";
    const idleFooter = "  ⏸ manual mode on · ? for shortcuts · ← for agents";
    const injectedFooter = "  ⏸ manual mode on";
    class ManualModeClaudeProvider extends RecordingTerminalProvider {
      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(
          target,
          [divider, `❯ ${text}`, divider, injectedFooter].join("\n")
        );
      }
    }
    const provider = new ManualModeClaudeProvider([PANE], {
      [PANE.target]: [divider, "❯ ", divider, idleFooter].join("\n")
    });
    const adapter = createTestClaudeAdapter();
    const bridge = createBridge(adapter, provider);

    const result = await bridge.send(
      "claude",
      terminalControl(adapter),
      request,
      {
        runtime: MANAGED_CLAUDE_RUNTIME,
        requireExactEmptyComposerBeforeText: true,
        requireExactComposerBeforeEnter: true
      }
    );

    assert.equal(result.stage, "enter_dispatched");
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["text", "keys:C-m"]
    );
  });

  await t.test(
    "exact-empty Claude accepts its stable injected multiline paste placeholder once",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = [
        "第一行：修复 Claude 多行发送。",
        "Second line keeps mixed-language input.",
        "第三行：保持一次注入。",
        "Fourth line proves the collapsed draft.",
        "第五行：不要额外发送 Enter。",
        "Sixth line closes the request.",
        "第七行：完成。"
      ].join("\n");
      const newlineCount = multilineRequest.match(/\n/gu)?.length ?? 0;
      let nowMs = 0;
      class CollapsedClaudePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, [
            divider,
            `❯ [Pasted text #1 +${newlineCount} lines]`,
            divider,
            "  paste again to expand       ✘ Auto-update failed · Run claude doctor",
            "                              ● high · /effort"
          ].join("\n"));
        }
      }
      const provider = new CollapsedClaudePasteProvider([PANE], {
        [PANE.target]: [
          divider,
          "❯ ",
          divider,
          "  ⏸ manual mode on · ? for shortcuts · ← for agents"
        ].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([adapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });

      const result = await bridge.send(
        "claude",
        terminalControl(adapter),
        multilineRequest,
        {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true
        }
      );

      assert.equal(result.stage, "enter_dispatched");
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        ["text", "keys:C-m"]
      );
      assert.equal(
        provider.operations.filter((operation) => operation.kind === "text")
          .length,
        1,
        "the placeholder proof is bound to one text delivery"
      );
      assert.equal(
        provider.operations.filter((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ).length,
        1,
        "Claude receives exactly one Enter"
      );
      assert.ok(nowMs >= 30, "the placeholder must be captured stably");
    }
  );

  await t.test(
    "Claude injected paste placeholder fails closed on line-count mismatch",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = "line one\nline two\nline three\nline four";
      let nowMs = 0;
      class WrongCountClaudePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, [
            divider,
            "❯ [Pasted text #1 +2 lines]",
            divider,
            "  paste again to expand"
          ].join("\n"));
        }
      }
      const provider = new WrongCountClaudePasteProvider([PANE], {
        [PANE.target]: [divider, "❯ ", divider].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([adapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });

      await assert.rejects(
        bridge.send("claude", terminalControl(adapter), multilineRequest, {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true
        }),
        /stable exact_injected_paste_placeholder/u
      );
      assert.equal(
        provider.operations.some((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ),
        false
      );
      assert.ok(nowMs >= 5_000);
    }
  );

  await t.test(
    "Claude injected paste placeholder rejects an unknown footer profile",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = "line one\nline two\nline three\nline four";
      let nowMs = 0;
      class UnknownFooterClaudePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, [
            divider,
            "❯ [Pasted text #1 +3 lines]",
            divider,
            "  paste again to expand       unknown interactive mode"
          ].join("\n"));
        }
      }
      const provider = new UnknownFooterClaudePasteProvider([PANE], {
        [PANE.target]: [divider, "❯ ", divider].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([adapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });

      await assert.rejects(
        bridge.send("claude", terminalControl(adapter), multilineRequest, {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true
        }),
        /stable exact_injected_paste_placeholder/u
      );
      assert.equal(
        provider.operations.some((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ),
        false
      );
      assert.ok(nowMs >= 5_000);
    }
  );

  await t.test(
    "Claude injected paste placeholder drift after reservation blocks Enter",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = "line one\nline two\nline three\nline four";
      let nowMs = 0;
      const placeholderScreen = (pasteId: number) => [
        divider,
        `❯ [Pasted text #${pasteId} +3 lines]`,
        divider,
        "  paste again to expand"
      ].join("\n");
      class DriftingClaudePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, placeholderScreen(1));
        }
      }
      const provider = new DriftingClaudePasteProvider([PANE], {
        [PANE.target]: [divider, "❯ ", divider].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([adapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        }
      });

      await assert.rejects(
        bridge.send("claude", terminalControl(adapter), multilineRequest, {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true,
          beforeEnter() {
            provider.setScreen(PANE.target, placeholderScreen(2));
          }
        }),
        /exact_injected_paste_placeholder changed before Enter/u
      );
      assert.equal(
        provider.operations.some((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ),
        false
      );
    }
  );

  await t.test(
    "Claude injected paste placeholder never crosses terminal identity drift",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = "line one\nline two\nline three\nline four";
      let nowMs = 0;
      class IdentityDriftClaudePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, [
            divider,
            "❯ [Pasted text #1 +3 lines]",
            divider,
            "  paste again to expand"
          ].join("\n"));
        }
      }
      const provider = new IdentityDriftClaudePasteProvider([PANE], {
        [PANE.target]: [divider, "❯ ", divider].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([adapter]),
        terminalProvider: provider,
        nowMs: () => nowMs,
        async sleep(milliseconds) {
          nowMs += milliseconds;
        },
        async verifyIdentity({ terminalControl }) {
          if (
            provider.operations.some((operation) =>
              operation.kind === "text"
            )
          ) {
            throw new Error("Claude terminal identity drifted after paste");
          }
          return { terminalControl };
        }
      });

      await assert.rejects(
        bridge.send("claude", terminalControl(adapter), multilineRequest, {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true
        }),
        /identity drifted after paste/u
      );
      assert.equal(
        provider.operations.some((operation) =>
          operation.kind === "keys" && operation.keys.includes("C-m")
        ),
        false
      );
    }
  );

  await t.test(
    "a pre-existing Claude paste placeholder is never injection authority",
    async () => {
      const divider = "────────────────────────────────────────────────";
      const multilineRequest = "line one\nline two\nline three\nline four";
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: [
          divider,
          "❯ [Pasted text #7 +3 lines]",
          divider,
          "  paste again to expand"
        ].join("\n")
      });
      const adapter = createTestClaudeAdapter();
      const bridge = createBridge(adapter, provider);

      await assert.rejects(
        bridge.send("claude", terminalControl(adapter), multilineRequest, {
          runtime: MANAGED_CLAUDE_RUNTIME,
          requireExactEmptyComposerBeforeText: true,
          requireExactComposerBeforeEnter: true
        }),
        TerminalInputNotStartedError
      );
      assert.equal(
        provider.operations.some((operation) => operation.kind !== "capture"),
        false
      );
    }
  );

  await t.test("Claude draft drift before text proves zero input", async () => {
    const divider = "────────────────────────────────────────────────";
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: [divider, "❯ ", divider].join("\n")
    });
    const adapter = createTestClaudeAdapter();
    const bridge = createBridge(adapter, provider);
    await assert.rejects(
      bridge.send("claude", terminalControl(adapter), request, {
        runtime: MANAGED_CLAUDE_RUNTIME,
        requireExactEmptyComposerBeforeText: true,
        requireExactComposerBeforeEnter: true,
        beforeText() {
          provider.setScreen(
            PANE.target,
            [divider, "❯ a human draft arrived after preflight", divider]
              .join("\n")
          );
        }
      }),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("working Claude exact-empty fallback may steer once", async () => {
    const divider = "────────────────────────────────────────────────";
    const working = (composer: string) => [
      "working: background terminal remains active",
      divider,
      composer,
      divider
    ].join("\n");
    class WorkingClaudeProvider extends RecordingTerminalProvider {
      override async sendText(
        target: TerminalEndpointRef | string,
        text: string,
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendText(target, text, options);
        this.setScreen(target, working(`❯ ${text}`));
      }
    }
    const provider = new WorkingClaudeProvider([PANE], {
      [PANE.target]: working("❯ ")
    });
    const adapter = createTestClaudeAdapter();
    const bridge = createBridge(adapter, provider);
    await bridge.send("claude", terminalControl(adapter), request, {
      runtime: MANAGED_CLAUDE_RUNTIME,
      requireExactEmptyComposerBeforeText: true,
      requireExactComposerBeforeEnter: true,
      allowWorkingComposerForUserExplicit: true
    });
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["text", "keys:C-m"]
    );
  });
});

test("explicit Codex Send reserves before its first physical mutation", async (t) => {
  await t.test("reservation failure is retry-safe and sends zero input", async () => {
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "Assistant output with the Composer off-screen"
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        "new explicit request",
        {
          beforeMutationReservation() {
            throw new Error("fresh physical authority was lost");
          }
        }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("Composer drift during reservation is replaced, not vetoed", async () => {
    let nowMs = 0;
    const request = "new explicit request";
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: codexPaddedStyledIdleScreen(80)
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    const result = await bridge.sendUserExplicitCodex(
      terminalControl(codexTerminalAgentAdapter),
      request,
      {
        beforeMutationReservation() {
          provider.setScreen(
            PANE.target,
            "› human changed the draft\ngpt-5.6-sol high · /repo"
          );
        }
      }
    );
    assert.equal(result.disposition, "replaced_current_composer");
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u", "text", "keys:C-m"]
    );
  });
});

test("explicit Codex Send classifies transport failures around its one-shot sequence", async (t) => {
  const request = "new explicit request";

  await t.test("proven C-u not-sent remains retry-safe", async () => {
    let clearAttempts = 0;
    class ProvenNoClearProvider extends RecordingTerminalProvider {
      override async sendKeys(
        _terminal: TerminalEndpointRef | string,
        keys: readonly string[]
      ): Promise<void> {
        assert.deepEqual(keys, ["C-u"]);
        clearAttempts += 1;
        throw new TerminalControlInputNotSentError(
          "test provider proved C-u was not delivered"
        );
      }
    }
    const provider = new ProvenNoClearProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(clearAttempts, 1);
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  await t.test("unknown C-u outcome is uncertain and stops", async () => {
    let clearAttempts = 0;
    class UnknownClearProvider extends RecordingTerminalProvider {
      override async sendKeys(
        _terminal: TerminalEndpointRef | string,
        keys: readonly string[]
      ): Promise<void> {
        assert.deepEqual(keys, ["C-u"]);
        clearAttempts += 1;
        throw new Error("C-u delivery outcome is unknown");
      }
    }
    const provider = new UnknownClearProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.equal(clearAttempts, 1);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "text"),
      false
    );
  });

  await t.test("text-not-sent after C-u is uncertain", async () => {
    class ProvenNoTextProvider extends RecordingTerminalProvider {
      override async sendText(): Promise<void> {
        throw new TerminalControlInputNotSentError(
          "test provider proved text was not delivered"
        );
      }
    }
    const provider = new ProvenNoTextProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u"]
    );
  });

  await t.test("post-clear hook failure cannot strand the user's draft", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        {
          beforeMutationReservation() {},
          onComposerClearDispatched() {
            throw new Error("internal clear receipt is unavailable");
          }
        }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u", "text", "keys:C-m"],
      "internal acknowledgement failure must not veto physical Enter"
    );
  });

  await t.test("Enter failure is uncertain and attempted exactly once", async () => {
    let nowMs = 0;
    let enterAttempts = 0;
    class UnknownEnterProvider extends RecordingTerminalProvider {
      override async sendKeys(
        terminal: TerminalEndpointRef | string,
        keys: readonly string[],
        options: { socketPath?: string } = {}
      ): Promise<void> {
        await super.sendKeys(terminal, keys, options);
        if (keys.includes("C-m")) {
          enterAttempts += 1;
          throw new Error("Enter delivery outcome is unknown");
        }
      }
    }
    const provider = new UnknownEnterProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.equal(enterAttempts, 1);
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u", "text", "keys:C-m"]
    );
  });

  await t.test("identity drift after text prevents Enter without retry", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "Composer may be off-screen"
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      },
      async verifyIdentity({ terminalControl }) {
        if (provider.operations.some((operation) => operation.kind === "text")) {
          throw new Error("terminal process changed after text");
        }
        return { terminalControl };
      }
    });
    await assert.rejects(
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        {
          runtime: { pid: 110 },
          beforeMutationReservation() {}
        }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.deepEqual(
      provider.operations.flatMap((operation) =>
        operation.kind === "capture"
          ? []
          : operation.kind === "text"
            ? ["text"]
            : [`keys:${operation.keys.join(",")}`]
      ),
      ["keys:C-u", "text"]
    );
  });
});

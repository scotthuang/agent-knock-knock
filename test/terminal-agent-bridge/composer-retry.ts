import {
  test,
  assert,
  createTerminalAgentAdapterRegistry,
  createClaudeTerminalAgentAdapter,
  codexTerminalAgentAdapter,
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  TerminalAgentBridge,
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  PANE,
  MANAGED_CLAUDE_RUNTIME,
  RecordingTerminalProvider,
  TimelineTerminalProvider,
  createTestClaudeAdapter,
  createBridge,
  terminalControl,
  codexPaddedStyledIdleScreen,
  type TerminalEndpointRef
} from "../support/terminal-agent-bridge-contract-support.js";

test("Codex empty composer observation rejects footerless, truncated, and scrollback prompts", async (t) => {
  const styledPrompt = "› \u001b[2mSummarize recent commits\u001b[0m";
  const cases = [
    {
      name: "missing footer",
      screen: `Ready\n${styledPrompt}`
    },
    {
      name: "truncated footer",
      screen: `Ready\n${styledPrompt}\ngpt-5.6-sol high ·`
    },
    {
      name: "scrollback empty prompt",
      screen: [
        "Ready",
        styledPrompt,
        "gpt-5.6-sol high · /repo",
        "Assistant output painted after the old composer"
      ].join("\n")
    },
    {
      name: "styled placeholder with a nonempty continuation row",
      screen: [
        "Ready",
        styledPrompt,
        "  human-authored continuation",
        "gpt-5.6-sol high · /repo"
      ].join("\n"),
      expectedState: "different_draft"
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
        "managed exact draft"
      );
      assert.equal(
        observation.state,
        testCase.expectedState ?? "unavailable"
      );
    });
  }
});

test("Codex exact composer observation is bounded when its digest never stabilizes", async () => {
  let nowMs = 0;
  let captures = 0;
  const expected = "managed exact draft";
  class RewrappingProvider extends RecordingTerminalProvider {
    override async capture(
      target: TerminalEndpointRef | string,
      options: { scrollbackLines?: number; socketPath?: string } = {}
    ): Promise<string> {
      await super.capture(target, options);
      captures += 1;
      return captures % 2 === 0
        ? "› managed exact\n  draft\ngpt-5.6-sol high · /repo"
        : `› ${expected}\ngpt-5.6-sol high · /repo`;
    }
  }
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: new RewrappingProvider([PANE]),
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  const observation = await bridge.observeCodexComposer(
    terminalControl(codexTerminalAgentAdapter),
    expected
  );
  assert.equal(observation.state, "unavailable");
  assert.ok(nowMs >= 5_000);
  assert.ok(captures < 200, "the post-deadline exact-draft grace must be finite");
});

test("retry recovery treats a matching-length Codex paste placeholder as opaque", async (t) => {
  const expected = "x".repeat(1_001);
  const screen = [
    "› [Pasted Content 1001 chars]",
    "gpt-5.6-sol high · /repo"
  ].join("\n");

  await t.test("observation is unavailable", async () => {
    let nowMs = 0;
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: new RecordingTerminalProvider([PANE], {
        [PANE.target]: screen
      }),
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    assert.equal((await bridge.observeCodexComposer(
      terminalControl(codexTerminalAgentAdapter),
      expected
    )).state, "unavailable");
  });

  await t.test("exact-draft submit never reserves or presses Enter", async () => {
    let nowMs = 0;
    let reserved = false;
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
    await assert.rejects(
      bridge.submitExactCodexDraft(
        terminalControl(codexTerminalAgentAdapter),
        expected,
        {
          beforeEnterReservation() {
            reserved = true;
          }
        }
      ),
      TerminalEnterDispatchNotAttemptedError
    );
    assert.equal(reserved, false);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });
});

test("fresh Codex send retains immediate large-paste placeholder support", async () => {
  let nowMs = 0;
  const request = `${"x".repeat(1_001)}\nsecond line`;
  class FreshLargePasteProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        `› [Pasted Content ${Array.from(text).length} chars]`,
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }
  const provider = new FreshLargePasteProvider([PANE]);
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
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("retry replacement reserves before final exact-empty recapture and text delivery", async () => {
  const timeline: string[] = [];
  let nowMs = 0;
  class ReplacementProvider extends TimelineTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      timeline.push("sendText");
      await super.sendText(target, text, options);
      this.setScreen(target, `› ${text}\ngpt-5.6-sol high · /repo`);
    }
  }
  const provider = new ReplacementProvider(timeline, [PANE], {
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
  const preliminary = await bridge.observeCodexComposer(
    terminalControl(codexTerminalAgentAdapter),
    "replacement request"
  );
  assert.equal(preliminary.state, "exact_empty");
  if (preliminary.state !== "exact_empty") {
    assert.fail("expected exact-empty replacement authority");
  }
  timeline.length = 0;
  provider.operations.length = 0;

  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    "replacement request",
    {
      beforeText() {
        timeline.push("reservation");
      },
      requireExactEmptyComposerAfterBeforeText: {
        preliminaryComposerDigest: preliminary.digest
      }
    }
  );

  const reservationIndex = timeline.indexOf("reservation");
  const finalCaptureIndex = timeline.indexOf("capture", reservationIndex + 1);
  const textIndex = timeline.indexOf("sendText");
  assert.ok(reservationIndex >= 0);
  assert.ok(reservationIndex < finalCaptureIndex);
  assert.ok(finalCaptureIndex < textIndex);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
});

test("retry replacement consumes its reservation and sends no input after an empty-composer edit", async () => {
  let nowMs = 0;
  let reserved = false;
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
  const preliminary = await bridge.observeCodexComposer(
    terminalControl(codexTerminalAgentAdapter),
    "replacement request"
  );
  assert.equal(preliminary.state, "exact_empty");
  if (preliminary.state !== "exact_empty") {
    assert.fail("expected exact-empty replacement authority");
  }
  provider.operations.length = 0;

  await assert.rejects(
    bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "replacement request",
      {
        beforeText() {
          reserved = true;
          provider.setScreen(
            PANE.target,
            "› human draft\ngpt-5.6-sol high · /repo"
          );
        },
        requireExactEmptyComposerAfterBeforeText: {
          preliminaryComposerDigest: preliminary.digest
        }
      }
    ),
    TerminalEnterDispatchReservedError
  );
  assert.equal(reserved, true);
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "text" || operation.kind === "keys"
    ),
    false
  );
});

test("retry replacement sends no Enter when the injected draft changes", async () => {
  let nowMs = 0;
  let reserved = false;
  class ChangedAfterTextProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(
        target,
        "› human changed injected draft\ngpt-5.6-sol high · /repo"
      );
    }
  }
  const provider = new ChangedAfterTextProvider([PANE], {
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
  const preliminary = await bridge.observeCodexComposer(
    terminalControl(codexTerminalAgentAdapter),
    "replacement request"
  );
  assert.equal(preliminary.state, "exact_empty");
  if (preliminary.state !== "exact_empty") {
    assert.fail("expected exact-empty replacement authority");
  }
  provider.operations.length = 0;

  await assert.rejects(
    bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      "replacement request",
      {
        beforeText() {
          reserved = true;
        },
        requireExactEmptyComposerAfterBeforeText: {
          preliminaryComposerDigest: preliminary.digest
        }
      }
    ),
    TerminalEnterDispatchReservedError
  );
  assert.equal(reserved, true);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("retry replacement consumes its attempt and sends no Enter for an opaque paste placeholder", async () => {
  let nowMs = 0;
  let reserved = false;
  const request = "x".repeat(1_001);
  class OpaqueReplacementProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        `› [Pasted Content ${Array.from(text).length} chars]`,
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }
  const provider = new OpaqueReplacementProvider([PANE], {
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
  const preliminary = await bridge.observeCodexComposer(
    terminalControl(codexTerminalAgentAdapter),
    request
  );
  assert.equal(preliminary.state, "exact_empty");
  if (preliminary.state !== "exact_empty") {
    assert.fail("expected exact-empty replacement authority");
  }
  provider.operations.length = 0;

  await assert.rejects(
    bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      {
        beforeText() {
          reserved = true;
        },
        requireExactEmptyComposerAfterBeforeText: {
          preliminaryComposerDigest: preliminary.digest
        }
      }
    ),
    TerminalEnterDispatchReservedError
  );
  assert.equal(reserved, true);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    1
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind === "keys"),
    false
  );
});

test("exact Codex draft submission reserves before final recapture and emits at most one Enter", async () => {
  const timeline: string[] = [];
  let nowMs = 0;
  const expected = "retry this exact draft";
  const provider = new TimelineTerminalProvider(timeline, [PANE], {
    [PANE.target]: `› ${expected}\ngpt-5.6-sol high · /repo`
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    nowMs: () => nowMs,
    async sleep(milliseconds) {
      nowMs += milliseconds;
    }
  });

  const result = await bridge.submitExactCodexDraft(
    terminalControl(codexTerminalAgentAdapter),
    expected,
    {
      beforeEnterReservation() {
        timeline.push("reservation");
      }
    }
  );
  assert.equal(result.enterCount, 1);
  const reservationIndex = timeline.indexOf("reservation");
  const finalCaptureIndex = timeline.lastIndexOf("capture");
  const enterIndex = timeline.indexOf("sendKeys:C-m");
  assert.ok(timeline.slice(0, reservationIndex).includes("capture"));
  assert.ok(reservationIndex < finalCaptureIndex);
  assert.ok(finalCaptureIndex < enterIndex);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "text").length,
    0
  );
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("exact Codex draft submission fails closed before Enter on drift or reservation failure", async (t) => {
  const expected = "retry this exact draft";
  await t.test("persistent different draft times out with zero Enter", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "› different draft\ngpt-5.6-sol high · /repo"
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
      bridge.submitExactCodexDraft(
        terminalControl(codexTerminalAgentAdapter),
        expected,
        { beforeEnterReservation() {} }
      ),
      TerminalEnterDispatchNotAttemptedError
    );
    assert.ok(nowMs >= 5_000);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("reservation exception emits zero Enter", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: `› ${expected}\ngpt-5.6-sol high · /repo`
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
      bridge.submitExactCodexDraft(
        terminalControl(codexTerminalAgentAdapter),
        expected,
        {
          beforeEnterReservation() {
            throw new Error("reservation rejected");
          }
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof TerminalEnterDispatchReservedError);
        assert.equal(error.doNotRetry, true);
        assert.match(error.message, /reservation rejected/u);
        return true;
      }
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("human draft edit during reservation consumes the attempt with zero Enter", async () => {
    let nowMs = 0;
    let reserved = false;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: `› ${expected}\ngpt-5.6-sol high · /repo`
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
      bridge.submitExactCodexDraft(
        terminalControl(codexTerminalAgentAdapter),
        expected,
        {
          beforeEnterReservation() {
            reserved = true;
            provider.setScreen(
              PANE.target,
              "› human changed this draft\ngpt-5.6-sol high · /repo"
            );
          }
        }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.equal(reserved, true);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });

  await t.test("identity drift after reservation consumes the attempt with zero Enter", async () => {
    let nowMs = 0;
    let reserved = false;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: `› ${expected}\ngpt-5.6-sol high · /repo`
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
      terminalProvider: provider,
      async verifyIdentity() {
        if (reserved) {
          throw new Error("identity changed after reservation");
        }
      },
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await assert.rejects(
      bridge.submitExactCodexDraft(
        terminalControl(codexTerminalAgentAdapter),
        expected,
        {
          runtime: { pid: 110 },
          beforeEnterReservation() {
            reserved = true;
          }
        }
      ),
      TerminalEnterDispatchReservedError
    );
    assert.equal(reserved, true);
    assert.equal(
      provider.operations.some((operation) => operation.kind === "keys"),
      false
    );
  });
});

test("unchanged multilingual multiline composer after one Enter is proven not accepted", async () => {
  const suppressionWindowMs = 121;
  let nowMs = 0;
  const requestedSleepMs: number[] = [];
  const request = "第一行：保留精确内容\nSecond line with  two spaces.";
  class UnchangedComposerProvider extends RecordingTerminalProvider {
    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, [
        "Ready",
        "› 第一行：保留精确内容",
        "  Second line with  two spaces.",
        "",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }
  }
  const provider = new UnchangedComposerProvider([PANE]);
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
  const sendStartedAt = nowMs;
  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    { runtime: { pid: 110 } }
  );
  const sendCompletedAt = nowMs;
  assert.ok(sendCompletedAt - sendStartedAt >= suppressionWindowMs);
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
  assert.equal(await bridge.proveExactDraftStillPresent(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    { runtime: { pid: 110 } }
  ), true);
  assert.ok(nowMs > sendCompletedAt);
  assert.equal(
    requestedSleepMs.reduce((total, milliseconds) => total + milliseconds, 0),
    nowMs - sendStartedAt
  );
});

test("Claude exact-draft proof only accepts the complete bottom composer frame", async () => {
  const request = "检查历史提示\nKeep the exact second line.";
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: [
      "❯ 检查历史提示",
      "  Keep the exact second line.",
      "",
      "Completed the earlier request.",
      "────────────────────────────────────",
      "❯ ",
      "────────────────────────────────────",
      "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"
    ].join("\n")
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  assert.equal(await bridge.proveExactDraftStillPresent(
    "claude",
    control,
    request,
    { runtime: MANAGED_CLAUDE_RUNTIME }
  ), false, "a matching historical prompt is not the live composer");

  provider.setScreen(PANE.target, [
    "Older output",
    "────────────────────────────────────",
    "❯ 检查历史提示",
    "  Keep the exact second line.",
    "────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
  ].join("\n"));
  assert.equal(await bridge.proveExactDraftStillPresent(
    "claude",
    control,
    request,
    { runtime: MANAGED_CLAUDE_RUNTIME }
  ), true, "the exact draft in the complete bottom frame is authoritative");

  provider.setScreen(PANE.target, [
    "❯ 检查历史提示",
    "  Keep the exact second line.",
    "Completed output without a bottom composer frame"
  ].join("\n"));
  assert.equal(await bridge.proveExactDraftStillPresent(
    "claude",
    control,
    request,
    { runtime: MANAGED_CLAUDE_RUNTIME }
  ), false, "an unframed scrollback match must fail closed");

  provider.setScreen(PANE.target, [
    "────────────────────────────────────",
    "❯ 检查历史提示",
    "  Keep the exact second line.",
    "────────────────────────────────────",
    "Assistant output: press Esc to dismiss this note."
  ].join("\n"));
  assert.equal(await bridge.proveExactDraftStillPresent(
    "claude",
    control,
    request,
    { runtime: MANAGED_CLAUDE_RUNTIME }
  ), false, "ordinary prose containing a key hint is not a composer footer");
});

test("Claude exact send accepts Herdr visual wraps without relaxing draft equality", async (t) => {
  const request = "Herdr live validation. Reply with exactly: " +
    "AKK-HERDR-CLAUDE-LIVE-1786438038. Do not run commands or modify files.";
  const composerScreen = (lastLine: string) => [
    "❯ /clear",
    "",
    "───────────────────────────────────────────────────",
    "❯\u00a0Herdr live validation. Reply with exactly:",
    "  AKK-HERDR-CLAUDE-LIVE-1786438038. Do not run",
    `  ${lastLine}`,
    "───────────────────────────────────────────────────",
    "  ⏵⏵ bypass permissions on (shift+tab to cycle)"
  ].join("\n");

  class WrappedClaudeComposerProvider extends RecordingTerminalProvider {
    constructor(private readonly finalLine: string) {
      super([PANE]);
    }

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, composerScreen(this.finalLine));
    }
  }

  await t.test("dispatches one Enter for the exact soft-wrapped draft", async () => {
    const provider = new WrappedClaudeComposerProvider(
      "commands or modify files."
    );
    const bridge = createBridge(createTestClaudeAdapter(), provider);
    const stages: string[] = [];

    const result = await bridge.send(
      "claude",
      terminalControl(),
      request,
      {
        runtime: MANAGED_CLAUDE_RUNTIME,
        requireExactComposerBeforeEnter: true,
        onTransportStage(event) {
          stages.push(event.stage);
        }
      }
    );

    assert.equal(result.stage, "enter_dispatched");
    assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
    assert.equal(
      provider.operations.filter((operation) =>
        operation.kind === "keys" && operation.keys.includes("C-m")
      ).length,
      1
    );
  });

  await t.test("fails closed when a visible wrapped character differs", async () => {
    const provider = new WrappedClaudeComposerProvider(
      "commands or modify filez."
    );
    const bridge = createBridge(createTestClaudeAdapter(), provider);
    const stages: string[] = [];

    await assert.rejects(
      bridge.send("claude", terminalControl(), request, {
        runtime: MANAGED_CLAUDE_RUNTIME,
        requireExactComposerBeforeEnter: true,
        onTransportStage(event) {
          stages.push(event.stage);
        }
      }),
      /composer was not exact and idle immediately before Enter/u
    );

    assert.deepEqual(stages, ["text_injected"]);
    assert.equal(
      provider.operations.some((operation) =>
        operation.kind === "keys" && operation.keys.includes("C-m")
      ),
      false
    );
  });
});

test("Claude exact idle proof uses only the current Herdr composer frame", () => {
  const divider = "────────────────────────────────────────────────";
  const clearedScreen = [
    "Welcome back",
    "❯ /clear",
    "",
    divider,
    `❯\u00a0`,
    divider,
    "\u00a0 ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
  ].join("\n");

  assert.equal(isExactClaudeIdleComposer(clearedScreen), true);
  assert.equal(
    isExactClaudeNativeInspectionIdleComposer(clearedScreen),
    true,
    "the compatibility export must preserve the same exact-frame proof"
  );
  assert.equal(isExactClaudeIdleComposer([
    divider,
    `❯\u00a0`,
    divider,
    "  ⏸ manual mode on · ? for shortcuts · ← for agents"
  ].join("\n")), true, "Claude 2.1.259 manual mode is an exact idle footer");
  assert.equal(isExactClaudeIdleComposer([
    "❯ /clear",
    divider,
    "❯ A human-authored draft must be preserved.",
    divider,
    "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
  ].join("\n")), false);
  assert.equal(isExactClaudeIdleComposer([
    "Completed earlier output",
    "❯ "
  ].join("\n")), false, "an unframed prompt must fail closed");
});

test("Codex multiline send fails closed when the stable composer drifts before Enter", async () => {
  const request = "first exact line\nsecond exact line";
  class DriftingCodexProvider extends RecordingTerminalProvider {
    textInjectedAt?: number;
    capturesAfterText = 0;
    drifted = false;

    override async sendText(
      target: TerminalEndpointRef | string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, [
        "› first exact line",
        "  second exact line",
        "gpt-5.6-sol high · /repo"
      ].join("\n"));
    }

    override async capture(
      target: TerminalEndpointRef | string,
      options: { scrollbackLines?: number; socketPath?: string } = {}
    ): Promise<string> {
      const screen = await super.capture(target, options);
      if (this.textInjectedAt !== undefined) {
        this.capturesAfterText += 1;
        if (
          !this.drifted &&
          this.capturesAfterText >= 2 &&
          performance.now() - this.textInjectedAt >= 120
        ) {
          this.drifted = true;
          this.setScreen(target, [
            "› first exact line",
            "  second exact line changed",
            "gpt-5.6-sol high · /repo"
          ].join("\n"));
        }
      }
      return screen;
    }
  }

  const provider = new DriftingCodexProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await assert.rejects(
    () => bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      { runtime: { pid: 110 } }
    ),
    /composer (?:changed|did not become exact)/u
  );
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ),
    false
  );
});

test("Codex multiline send fails closed on identity drift without cleanup or Enter", async () => {
  const request = "first line\nsecond line";
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: [
      "› first line",
      "  second line",
      "gpt-5.6-sol high · /repo"
    ].join("\n")
  });
  let checks = 0;
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      checks += 1;
      if (checks > 2) {
        throw new Error("Codex process identity drifted after multiline paste");
      }
    }
  });

  await assert.rejects(
    () => bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      { runtime: { pid: 110 } }
    ),
    /identity drifted/u
  );
  assert.deepEqual(provider.operations, [{
    kind: "text",
    target: PANE.target,
    text: request,
    socketPath: PANE.socketPath
  }]);
});

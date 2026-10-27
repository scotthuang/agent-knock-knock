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
  type TerminalEndpointRef,
  type TerminalProviderTextOptions
} from "../support/terminal-agent-bridge-contract-support.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createClaudeTerminalAgentAdapter } from
  "../../src/claude-terminal-agent-adapter.js";
import {
  captureClaudeTranscriptAnchor,
  detectClaudeTranscriptAcceptance
} from "../../src/claude-local-transcript-provider.js";
import {
  TerminalUserExplicitClearUncertainError
} from
  "../../src/terminal-user-explicit-send-clear.js";
import {
  createTerminalEndpointRef,
  type TerminalControlRef
} from "../../src/terminal-control-ref.js";
import type {
  TerminalControlProvider,
  TerminalTextDeliveryOptions
} from "../../src/terminal-control-provider.js";

const FORWARD_CODEX_COMPOSER = [
  "• Working (2s • esc to interrupt)", "",
  "\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m", "",
  "  GPT-6-Astra high · /repo", "  ← for agents · ? for shortcuts"
].join("\n");

test("explicit Send uses paginated tmux paste after audited or freshly recognized input authority", async (t) => {
  const cases = [
    { version: "0.158.0", providerKind: "tmux", bracketedPaste: true },
    { version: "0.157.1", providerKind: "tmux", bracketedPaste: undefined },
    { version: undefined, providerKind: "tmux", bracketedPaste: undefined },
    { version: "0.158.1", providerKind: "tmux", bracketedPaste: true },
    { version: "0.159.3", providerKind: "tmux", bracketedPaste: true },
    { version: "0.160.0", providerKind: "tmux", bracketedPaste: true },
    { version: "1.0.0", providerKind: "tmux", bracketedPaste: true },
    { version: "0.158.0", providerKind: "herdr", bracketedPaste: undefined }
  ] as const;
  const request = "Submit the complete single-line request once. ".repeat(12).trimEnd();
  for (const testCase of cases) {
    await t.test(`${testCase.providerKind} ${testCase.version ?? "unknown"}`, async () => {
      const control: TerminalControlRef = testCase.providerKind === "tmux"
        ? terminalControl(codexTerminalAgentAdapter)
        : {
            kind: "herdr", target: "w1:p1", session: "herdr-test", panePid: 100,
            workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1",
            terminalId: "terminal-1", capabilities: ["screen_status", "send_keys"]
          };
      const endpoint = createTerminalEndpointRef({
        identity: {
          providerKind: control.kind, endpointKey: "endpoint-1", resourceKey: "resource-1"
        },
        route: { routeKey: "route-1", label: control.target },
        processAnchorPid: control.panePid,
        capabilities: control.capabilities,
        providerRef: control
      });
      const defaults = new RecordingTerminalProvider();
      const textDeliveries: Array<{ text: string; options?: TerminalTextDeliveryOptions }> = [];
      const keys: string[][] = [];
      const provider: TerminalControlProvider = {
        kind: control.kind,
        supportedCapabilities: defaults.supportedCapabilities,
        providerCapabilities: defaults.providerCapabilities,
        diagnostics: async () => ({}),
        listTerminals: async () => [endpoint],
        endpoint: () => endpoint,
        toControlRef: () => control,
        resolve: async () => endpoint,
        containsProcess: () => true,
        capture: async () => ["0.158.1", "0.159.3", "0.160.0", "1.0.0"].includes(testCase.version ?? "")
          ? FORWARD_CODEX_COMPOSER : "Assistant output with the main Composer off-screen",
        sendText: async (_terminal, text, options) => {
          textDeliveries.push({ text, options });
        },
        sendKeys: async (_terminal, value) => { keys.push([...value]); }
      };
      const bridge = new TerminalAgentBridge({
        registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
        terminalProvider: provider,
        sleep: async () => {}
      });
      await bridge.sendUserExplicitCodex(control, request, {
        runtime: { agentVersion: testCase.version },
        beforeMutationReservation() {}
      });
      assert.deepEqual(textDeliveries, [{
        text: request,
        options: testCase.bracketedPaste ? { bracketedPaste: true } : undefined
      }]);
      assert.deepEqual(keys, [["C-u"], ["C-m"]]);
    });
  }
});

test("unverified main Send requires a fresh visible Composer and verifies explicit draft replacement", async () => {
  const version = "0.160.1";
  const draft = FORWARD_CODEX_COMPOSER.replace(
    "\x1b[2mAsk Codex to do anything\x1b[0m", "replace my visible draft\n  and its second line");
  class ForwardProvider extends RecordingTerminalProvider {
    clearWorks = true;
    override async sendKeys(target: TerminalEndpointRef | string, keys: readonly string[]): Promise<void> {
      await super.sendKeys(target, keys);
      if (this.clearWorks && keys.join(",") === "C-u") this.setScreen(target, FORWARD_CODEX_COMPOSER);
    }
  }
  const request = "Run the requested task once.";
  const fixture = (screen: string) => {
    const provider = new ForwardProvider([PANE], { [PANE.target]: screen });
    const bridge = createBridge(codexTerminalAgentAdapter, provider);
    const run = (beforeMutationReservation = () => {}) => bridge.sendUserExplicitCodex(
      terminalControl(codexTerminalAgentAdapter), request,
      { runtime: { agentVersion: version }, beforeMutationReservation });
    const mutations = () => provider.operations.filter((operation) => operation.kind !== "capture");
    return { provider, run, mutations };
  };
  const accepted = fixture(draft);
  await accepted.run();
  assert.deepEqual(accepted.mutations().map((operation) =>
    operation.kind === "keys" ? operation.keys : operation.kind === "text" ? operation.text : undefined),
  [["C-u"], request, ["C-m"]]);
  assert.deepEqual(accepted.provider.textDeliveryOptions, [{ bracketedPaste: true }]);
  for (const screen of [
    "Assistant output with the main Composer off-screen",
    FORWARD_CODEX_COMPOSER.replace("? for shortcuts", "unknown footer"),
    draft.replace("\x1b[1m›\x1b[0m", "›"),
    FORWARD_CODEX_COMPOSER + "\n  unknown input owner"
  ]) {
    const blocked = fixture(screen);
    await assert.rejects(blocked.run(), TerminalInputNotStartedError);
    assert.deepEqual(blocked.mutations(), []);
  }
  const drifted = fixture(FORWARD_CODEX_COMPOSER);
  await assert.rejects(drifted.run(() => drifted.provider.setScreen(PANE.target,
    "Assistant output with the main Composer off-screen")), TerminalInputNotStartedError);
  assert.deepEqual(drifted.mutations(), [], "preparation never caches input authority across reservation");
  const unclear = fixture(draft);
  unclear.provider.clearWorks = false;
  await assert.rejects(unclear.run(), (error: unknown) => {
    assert.ok(error instanceof TerminalUserExplicitClearUncertainError);
    assert.match(error.message, /task text was not sent/u);
    return true;
  });
  assert.deepEqual(unclear.mutations().map((operation) => operation.kind === "keys" ? operation.keys : undefined), [["C-u"]]);
});

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
          options: TerminalProviderTextOptions = {}
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

test("explicit Claude Send refuses occupied stashes and probes an empty Composer without writing cleanup text", async (t) => {
  const adapter = createTestClaudeAdapter();
  const request = "the user's newest explicit Claude request";
  const legacyMarker = " [AKK replacing current draft 12345678-abcd-4abc-9abc-1234567890ab]";
  type NativeState = { draft: string; cursor?: number; stash?: string; hideStashLabel?: boolean;
    stashPlacement?: "above" | "trailing"; notificationHint?: string;
    restoredToast?: boolean; offscreen?: boolean; working?: boolean; userTextAfterEnter?: string;
    footer?: readonly string[]; beforeComposer?: readonly string[] };
  type Fault = "probe_not_sent" | "probe_ignored" | "probe_uncertain" | "post_probe_capture";
  // Native C-s on an empty editor restores a stash or does nothing; on nonempty
  // text it overwrites the sole slot. Enter restores any remaining stash.
  class NativeClaudeProvider extends RecordingTerminalProvider {
    composer: string;
    cursor: number;
    stash: string | undefined;
    submitted: string[] = [];
    probeKeys = 0;
    taskInjected = false;
    fault?: Fault;
    driftAfterProbe = false;
    runningAfterProbe = false;
    constructor(readonly initial: NativeState) {
      super([PANE]);
      this.composer = initial.draft;
      this.cursor = initial.cursor ?? initial.draft.length;
      this.stash = initial.stash;
      this.redraw(initial.offscreen);
    }
    redraw(offscreen = false): void {
      const running = this.initial.working || this.runningAfterProbe && this.probeKeys > 0;
      // Claude composes one notification row: /clear advice and restore toasts
      // can precede the stash badge; the badge is not necessarily a whole row.
      const notificationParts = [this.initial.restoredToast ? "Draft restored" : undefined,
        this.initial.notificationHint,
        this.stash === undefined || this.initial.hideStashLabel ? undefined : "› stashed"]
        .filter((part): part is string => part !== undefined);
      const notification = notificationParts.length === 0 ? [] : [
        `                                    ${notificationParts.join(" · ")}`];
      this.setScreen(PANE.target, offscreen ? "recent Claude output" : [
        ...(this.initial.beforeComposer ?? []),
        ...(running ? ["✻ Working… (8s · thinking)"] : []),
        ...(this.initial.stashPlacement === "trailing" ? [] : notification),
        "────────────────────────────────────────────────",
        ...this.composer.split("\n").map((line, index) => `${index === 0 ? "❯ " : "  "}${line}`),
        "────────────────────────────────────────────────",
        ...(this.initial.footer ?? ["  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"]),
        ...(this.initial.stashPlacement === "trailing" ? notification : [])
      ].join("\n"));
    }
    override async capture(terminal: TerminalEndpointRef | string,
      options: { scrollbackLines?: number; socketPath?: string; preserveEscapes?: boolean } = {}): Promise<string> {
      assert.equal(this.taskInjected, false, "no Composer observation after request injection or Enter");
      if (this.fault === "post_probe_capture" && this.probeKeys > 0) throw new Error("screen temporarily unavailable");
      return super.capture(terminal, options);
    }
    override async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
      const result = await super.resolve(terminal);
      return this.driftAfterProbe && this.probeKeys > 0
        ? { ...result, route: { ...result.route, currentCommand: "nvim task.md" },
          providerRef: { ...(result.providerRef as Record<string, unknown>), currentCommand: "nvim task.md" } } : result;
    }
    override async sendText(terminal: TerminalEndpointRef | string, text: string,
      options: TerminalProviderTextOptions = {}): Promise<void> {
      assert.equal(this.submitted.length, 0, "no asynchronous cleanup or mutation after Enter");
      assert.equal(text, request, "AKK writes only the requested task, never cleanup text into a user's draft slot");
      this.taskInjected = true;
      await super.sendText(terminal, text, options);
      this.composer = this.composer.slice(0, this.cursor) + text + this.composer.slice(this.cursor);
      this.cursor += text.length;
      this.redraw();
    }
    override async sendKeys(terminal: TerminalEndpointRef | string, keys: readonly string[],
      options: { socketPath?: string } = {}): Promise<void> {
      assert.equal(this.submitted.length, 0, "no cleanup keys after Enter may erase new user input");
      if (keys.includes("C-s") && this.fault === "probe_not_sent") {
        throw new TerminalControlInputNotSentError("probe key was not delivered");
      }
      await super.sendKeys(terminal, keys, options);
      for (const key of keys) {
        assert.ok(["C-s", "C-m"].includes(key), `unexpected destructive or interrupting key: ${key}`);
        if (key === "C-s") {
          this.probeKeys += 1;
          if (this.fault === "probe_ignored") continue;
          if (this.composer.trim()) {
            this.stash = this.composer;
            this.composer = "";
            this.cursor = 0;
          } else if (this.stash !== undefined) {
            this.composer = this.stash;
            this.cursor = this.composer.length;
            this.stash = undefined;
          }
        } else {
          this.submitted.push(this.composer);
          this.composer = (this.stash ?? "") + (this.initial.userTextAfterEnter ?? "");
          this.stash = undefined;
          this.cursor = this.composer.length;
        }
      }
      this.redraw();
      if (keys.includes("C-s") && this.fault === "probe_uncertain") throw new Error("transport disconnected after key delivery");
    }
    userClearsVisibleDraft(): void {
      this.composer = "";
      this.cursor = 0;
      this.redraw();
    }
  }
  const fixture = (state: NativeState) => {
    let nowMs = 0;
    const provider = new NativeClaudeProvider(state);
    const bridge = new TerminalAgentBridge({ registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider, nowMs: () => nowMs, async sleep(ms) { nowMs += ms; } });
    const reservations: Array<{ target: string; text: string }> = [];
    return { provider, reservations, run: (afterReservation = () => {}) => bridge.sendUserExplicit("claude", terminalControl(adapter), request,
      { beforeMutationReservation({ terminalControl, text }) {
        reservations.push({ target: terminalControl.target, text }); afterReservation();
      } }) };
  };
  const dynamicFooter = "  ⏵⏵ auto mode on · 1 shell · esc to interrupt · ← for agents · ↓ to manage          Debug";
  const multiline = "first line\nsecond line\nthird line\nfourth line";
  const clearHint = "new task? /clear to save 337.6k tokens";
  const cases: Array<{ name: string; state: NativeState; fault?: Fault }> = [
    { name: "empty composer", state: { draft: "" } },
    { name: "native /clear advice without a stash remains sendable", state: { draft: "", notificationHint: clearHint } },
    { name: "manual mode", state: { draft: "", footer: ["  ⏸ manual mode on"] } },
    { name: "historical badge above a newer normal reply", state: { draft: "",
      beforeComposer: ["                                    › stashed", "", "⏺ The current task is complete.", ""] } },
    { name: "background shell and Debug footer", state: { draft: "", footer: [dynamicFooter],
      beforeComposer: ["✻ Sautéed for 16s · done 1:35", ""] } },
    { name: "completed turn with /clear advice and lingering interrupt hint", state: { draft: "", footer: [dynamicFooter],
      notificationHint: clearHint, beforeComposer: ["✻ Sautéed for 16s · done 1:35", ""] } },
    { name: "wrapped background-shell footer", state: { draft: "", beforeComposer: ["✻ Brewed for 43s · done 1:37", ""],
      footer: ["  ⏵⏵ auto mode on · 2 shells · esc to interrupt · ← for agents", "  · ↓ to manage          Debug"] } },
    { name: "post-Enter user input remains untouched", state: { draft: "", userTextAfterEnter: "new human draft" } },
    { name: "ignored empty-editor probe cannot create a marker", state: { draft: "" }, fault: "probe_ignored" }
  ];
  for (const { name, state, fault } of cases) await t.test(name, async () => {
    const { provider, reservations, run } = fixture(state);
    provider.fault = fault;
    const result = await run();
    assert.deepEqual(reservations, [{ target: PANE.target, text: request }]);
    assert.equal(result.stage, "enter_dispatched");
    assert.equal(result.disposition, "replaced_current_composer");
    assert.equal(result.clearCount, 1);
    assert.equal(result.textInjectionCount, 1);
    assert.equal(result.enterCount, 1);
    assert.deepEqual(provider.submitted, [request], "only the exact requested task is submitted");
    assert.equal(provider.composer, state.userTextAfterEnter ?? "", "no cleanup marker returns after submission");
    assert.equal(provider.stash, undefined);
    assert.equal(provider.probeKeys, 1, "only a non-destructive empty-editor restore probe precedes the request");
    assert.equal(provider.textDeliveryOptions.some(options => options.bracketedPaste), false);
  });

  const blocked: Array<{ name: string; state: NativeState; reason: RegExp }> = [
    { name: "empty composer with an old stash above the input border", state: { draft: "", stash: "old hidden user draft" }, reason: /stash/iu },
    { name: "real /clear advice with an inline stash above the input border", state: { draft: "", stash: "STASH6-PROTECT-MARKER-abc123", notificationHint: clearHint }, reason: /stash/iu },
    { name: "short /clear advice with an inline stash", state: { draft: "", stash: multiline, notificationHint: "/clear to save 1k tokens" }, reason: /stash/iu },
    { name: "Draft restored and /clear advice before an occupied stash", state: { draft: "", stash: multiline, restoredToast: true, notificationHint: clearHint }, reason: /stash/iu },
    { name: "trailing /clear advice with an inline stash", state: { draft: "", stash: "trailing notification draft", stashPlacement: "trailing", notificationHint: clearHint }, reason: /stash/iu },
    { name: "trailing Draft restored and /clear advice with an inline stash", state: { draft: "", stash: multiline, stashPlacement: "trailing", restoredToast: true, notificationHint: clearHint }, reason: /stash/iu },
    { name: "trailing stash badge", state: { draft: "", stash: "draft from a trailing badge", stashPlacement: "trailing" }, reason: /stash/iu },
    { name: "Draft restored toast with a newly occupied slot", state: { draft: "", stash: multiline, restoredToast: true }, reason: /stash/iu },
    { name: "wrapped footer with a right-aligned stash", state: { draft: "", stash: "older hidden stash", stashPlacement: "trailing",
      beforeComposer: ["✻ Brewed for 43s · done 1:37", ""],
      footer: ["  ⏵⏵ auto mode on · 2 shells · esc to interrupt · ← for agents", "  · ↓ to manage          Debug"] }, reason: /stash/iu },
    { name: "visible legacy AKK marker", state: { draft: legacyMarker }, reason: /AKK/iu },
    { name: "same visible draft", state: { draft: request }, reason: /(?:empty|draft)/iu },
    { name: "different visible draft", state: { draft: "an older unrelated draft" }, reason: /(?:empty|draft)/iu },
    { name: "off-screen composer", state: { draft: "unseen old draft", offscreen: true }, reason: /Composer/iu },
    { name: "foreground turn despite empty prompt and background shell", state: { draft: "", working: true,
      footer: [dynamicFooter] }, reason: /(?:foreground|running|working)/iu },
    { name: "foreground spinner with /clear advice still owns the turn", state: { draft: "", working: true,
      notificationHint: clearHint, footer: [dynamicFooter], beforeComposer: ["✻ Sautéed for 16s · done 1:35"] },
      reason: /(?:foreground|running|working)/iu },
    { name: "unknown notification after completion cannot prove a lingering interrupt hint safe", state: { draft: "",
      notificationHint: `${clearHint} unexpected overlay`, footer: [dynamicFooter],
      beforeComposer: ["✻ Sautéed for 16s · done 1:35"] }, reason: /(?:foreground|running|working)/iu },
    { name: "foreground turn with wrapped current-work tip", state: { draft: "", footer: [dynamicFooter],
      beforeComposer: ["✻ Brewed for 43s · done 1:37", "", "✽ Flibbertigibbeting… (9m 26s · ↓ 5.7k tokens)",
        "  ⎿  Tip: Use /btw to ask a quick side question without interrupting Claude's current work", ""] },
      reason: /(?:foreground|running|working)/iu },
    { name: "middle-dot foreground spinner", state: { draft: "", footer: [dynamicFooter],
      beforeComposer: ["· Thinking… (8s · ↓ 123 tokens)"] }, reason: /(?:foreground|running|working)/iu },
    { name: "interrupt hint without positive foreground completion", state: { draft: "", footer: [dynamicFooter] },
      reason: /(?:foreground|running|working|ended|finish)/iu },
    ...[0, 11, multiline.length].map(cursor => ({ name: `multiline draft cursor ${cursor}`,
      state: { draft: multiline, cursor, stash: "pre-existing hidden stash" }, reason: /(?:empty|draft)/iu })),
    { name: "500-line draft remains user-owned", state: { draft: "line\n".repeat(500), cursor: 0 }, reason: /(?:empty|draft)/iu },
    { name: "unknown footer prefix", state: { draft: "", beforeComposer: ["✻ Sautéed for 16s · done 1:35"], footer: [dynamicFooter.replace("auto mode on", "auto mode on unexpected text")] },
      reason: /footer/iu },
    { name: "unknown footer middle", state: { draft: "", beforeComposer: ["✻ Sautéed for 16s · done 1:35"], footer: [dynamicFooter.replace("1 shell", "1 shell · unfamiliar shortcut")] },
      reason: /footer/iu },
    { name: "unknown footer suffix", state: { draft: "", beforeComposer: ["✻ Sautéed for 16s · done 1:35"], footer: [dynamicFooter + " unexpected overlay"] }, reason: /footer/iu }
  ];
  for (const { name, state, reason } of blocked) await t.test(`${name} blocks without touching input`, async () => {
    const { provider, reservations, run } = fixture(state);
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TerminalInputNotStartedError);
      assert.match(error.message, reason);
      return true;
    });
    assert.deepEqual(reservations, [], "initial safety failure precedes the mutation reservation");
    assert.equal(provider.operations.some(operation => operation.kind !== "capture"), false);
    assert.equal(provider.composer, state.draft, "the user's existing draft remains byte-for-byte intact");
    assert.equal(provider.stash, state.stash, "AKK must not overwrite or consume a visibly occupied stash");
    assert.deepEqual(provider.submitted, []);
  });
  for (const location of ["draft", "stash"] as const) await t.test(`${location} arriving during reservation blocks before the probe`, async () => {
    const { provider, run } = fixture({ draft: "" });
    await assert.rejects(run(() => {
      if (location === "draft") provider.composer = "new human draft";
      else provider.stash = "new human stash";
      provider.redraw();
    }), TerminalInputNotStartedError);
    assert.equal(provider.operations.some(operation => operation.kind !== "capture"), false);
    assert.equal(location === "draft" ? provider.composer : provider.stash, `new human ${location}`);
  });
  await t.test("refused user stash can be restored byte-for-byte and retried after user cleanup", async () => {
    const original = "用户暂存草稿  α\nsecond line\n  trailing spaces  ";
    const { provider, run } = fixture({ draft: "", stash: original });
    await assert.rejects(run(), /stash/iu);
    assert.equal(provider.stash, original);
    await provider.sendKeys(PANE.target, ["C-s"]);
    assert.equal(provider.composer, original);
    assert.equal(provider.stash, undefined);
    await assert.rejects(run(), /draft/iu);
    provider.userClearsVisibleDraft();
    assert.equal((await run()).stage, "enter_dispatched");
    assert.deepEqual(provider.submitted, [request]);
  });
  await t.test("hidden stash is restored without erasing user text or submitting a task", async () => {
    const original = "  hidden user text\n下一行  ";
    const { provider, run } = fixture({ draft: "", stash: original, hideStashLabel: true });
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TerminalUserExplicitClearUncertainError);
      assert.match(error.message, /(?:draft|restor)/iu);
      return true;
    });
    assert.equal(provider.composer, original);
    assert.equal(provider.stash, undefined, "the user's payload is visible, not deleted");
    assert.equal(provider.taskInjected, false);
    assert.deepEqual(provider.submitted, []);
    assert.deepEqual(provider.operations.filter(operation => operation.kind !== "capture")
      .map(operation => operation.kind === "keys" ? operation.keys : []), [["C-s"]]);
  });
  await t.test("legacy AKK stash failure explains manual recovery without claiming ownership of hidden text", async () => {
    const { provider, run } = fixture({ draft: "", stash: legacyMarker });
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TerminalInputNotStartedError);
      assert.match(error.message, /Ctrl\+S|C-s/iu);
      assert.match(error.message, /AKK/iu);
      assert.match(error.message, /(?:if|may|cannot|unknown)/iu, "hidden contents cannot be identified from the label alone");
      return true;
    });
    assert.equal(provider.stash, legacyMarker);
    await provider.sendKeys(PANE.target, ["C-s"]);
    await assert.rejects(run(), /AKK/iu);
    assert.equal(provider.composer, legacyMarker);
    provider.userClearsVisibleDraft();
    assert.equal((await run()).stage, "enter_dispatched");
    assert.equal(provider.composer, "");
  });
  await t.test("a proven unsent restore probe is retry-safe", async () => {
    const { provider, run } = fixture({ draft: "" });
    provider.fault = "probe_not_sent";
    await assert.rejects(run(), TerminalInputNotStartedError);
    assert.equal(provider.operations.some(operation => operation.kind !== "capture"), false);
    provider.fault = undefined;
    assert.equal((await run()).stage, "enter_dispatched");
  });
  for (const fault of ["probe_uncertain", "post_probe_capture"] as const) await t.test(`${fault} has no marker residue and can recover`, async () => {
    const { provider, run } = fixture({ draft: "" });
    provider.fault = fault;
    await assert.rejects(run(), (error: unknown) => {
      assert.ok(error instanceof TerminalUserExplicitClearUncertainError);
      assert.equal(error.code, "AKK_TERMINAL_USER_EXPLICIT_CLEAR_UNCERTAIN");
      assert.equal(error.stage, "composer_clear_uncertain");
      assert.equal(error.doNotRetry, true);
      assert.match(error.message, /(?:inspect|check|restore|retry|window)/iu, "failures explain what the user should do");
      return true;
    });
    assert.equal(provider.taskInjected, false);
    assert.deepEqual(provider.submitted, []);
    assert.equal(provider.composer, "");
    assert.equal(provider.stash, undefined);
    provider.fault = undefined;
    assert.equal((await run()).stage, "enter_dispatched");
    assert.deepEqual(provider.submitted, [request], "manual recovery never replays a submitted task");
  });
  for (const drift of ["runningAfterProbe", "driftAfterProbe"] as const) await t.test(`${drift} blocks further task input`, async () => {
    const { provider, run } = fixture({ draft: "", footer: [dynamicFooter],
      beforeComposer: ["✻ Sautéed for 16s · done 1:35", ""] });
    provider[drift] = true;
    await assert.rejects(run(), TerminalUserExplicitClearUncertainError);
    assert.equal(provider.taskInjected, false);
    assert.deepEqual(provider.submitted, []);
    assert.equal(provider.probeKeys, 1);
    assert.equal(provider.operations.some(operation => operation.kind === "keys" && operation.keys.some(key =>
      ["C-m", "C-u", "C-k", "Escape", "C-c"].includes(key))), false);
  });
});

test("explicit Claude Send keeps input-owning surfaces as zero-input boundaries", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);

  await assert.rejects(
    bridge.sendUserExplicit(
      "claude",
      terminalControl(adapter),
      "new explicit request",
      { beforeMutationReservation() {} }
    ),
    TerminalInputNotStartedError
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind !== "capture"),
    false
  );

  const editorPane = { ...PANE, currentCommand: "nvim /tmp/claude-edit.md" };
  const editorProvider = new RecordingTerminalProvider([editorPane], {
    [editorPane.target]: "~  NORMAL  claude-edit.md"
  });
  const editorBridge = createBridge(adapter, editorProvider);
  await assert.rejects(
    editorBridge.sendUserExplicit(
      "claude",
      { ...terminalControl(adapter), currentCommand: editorPane.currentCommand },
      "do not write this request into the external editor",
      { beforeMutationReservation() {} }
    ),
    TerminalInputNotStartedError
  );
  assert.equal(
    editorProvider.operations.some((operation) =>
      operation.kind !== "capture"
    ),
    false
  );

  class DriftingOwnerProvider extends RecordingTerminalProvider {
    private resolutions = 0;
    override async resolve(
      terminal: TerminalEndpointRef
    ): Promise<TerminalEndpointRef> {
      const resolved = await super.resolve(terminal);
      this.resolutions += 1;
      return this.resolutions < 2
        ? resolved
        : {
            ...resolved,
            route: { ...resolved.route, currentCommand: "nvim task.md" },
            providerRef: {
              ...(resolved.providerRef as Record<string, unknown>),
              currentCommand: "nvim task.md"
            }
          };
    }
  }
  const driftingProvider = new DriftingOwnerProvider([PANE], {
    [PANE.target]: [
      "────────────────────────────────",
      "❯ ",
      "────────────────────────────────",
      "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
    ].join("\n")
  });
  await assert.rejects(
    createBridge(adapter, driftingProvider).sendUserExplicit(
      "claude",
      terminalControl(adapter),
      "do not cross the foreground-owner race",
      { beforeMutationReservation() {} }
    ),
    TerminalInputNotStartedError
  );
  assert.equal(
    driftingProvider.operations.some((operation) =>
      operation.kind !== "capture"
    ),
    false
  );

  provider.operations.length = 0;
  provider.setScreen(PANE.target, [
    "old conversation output",
    " ☐ Color",
    "",
    "Which color do you prefer?",
    "",
    "❯ 1. Red",
    "     The color red",
    "  2. Blue",
    "     The color blue",
    "  3. Type something.",
    "────────────────────────────────",
    "  4. Chat about this",
    "",
    "Enter to select · ↑/↓ to navigate · Esc to cancel"
  ].join("\n"));
  await assert.rejects(
    bridge.sendUserExplicit(
      "claude",
      terminalControl(adapter),
      "do not overwrite the native questionnaire",
      { beforeMutationReservation() {} }
    ),
    TerminalInputNotStartedError
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind !== "capture"),
    false
  );

  provider.operations.length = 0;
  provider.setScreen(PANE.target, [
    "────────────────────────────────────────────────",
    "❯ ",
    "────────────────────────────────────────────────",
    "  search prompts:   ⏵⏵ auto mode on (shift+tab to cycle)"
  ].join("\n"));
  await assert.rejects(
    bridge.sendUserExplicit(
      "claude",
      terminalControl(adapter),
      "do not accept or append to a history-search result",
      { beforeMutationReservation() {} }
    ),
    TerminalInputNotStartedError
  );
  assert.equal(
    provider.operations.some((operation) => operation.kind !== "capture"),
    false
  );
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
        options: TerminalProviderTextOptions = {}
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
        options: TerminalProviderTextOptions = {}
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

  await t.test("user-explicit managed Claude multiline never waits for a paste placeholder", async () => {
    const adapter = createTestClaudeAdapter();
    const multilineRequest = Array.from(
      { length: 6 },
      (_, index) => `line ${index + 1}: explicit managed Claude request`
    ).join("\n");
    let nowMs = 0;
    let textInjected = false;
    let injectedAt = 0;
    class ManagedClaudeProvider extends RecordingTerminalProvider {
      override async capture(
        terminal: TerminalEndpointRef | string,
        options: {
          scrollbackLines?: number;
          socketPath?: string;
          preserveEscapes?: boolean;
        } = {}
      ): Promise<string> {
        if (textInjected) {
          throw new Error("post-text Claude Composer capture must not run");
        }
        return super.capture(terminal, options);
      }

      override async sendText(
        terminal: TerminalEndpointRef | string,
        text: string,
        options: TerminalProviderTextOptions = {}
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
    const provider = new ManagedClaudeProvider([PANE], {
      [PANE.target]: [
        "────────────────────────────────────────────────",
        "❯ ",
        "────────────────────────────────────────────────",
        "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents"
      ].join("\n")
    });
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([adapter]),
      terminalProvider: provider,
      nowMs: () => nowMs,
      async sleep(milliseconds) {
        nowMs += milliseconds;
      }
    });
    await bridge.send(
      "claude",
      terminalControl(adapter),
      multilineRequest,
      {
        runtime: MANAGED_CLAUDE_RUNTIME,
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

  await t.test("Claude default permission mode submits once and proves native acceptance", async (t) => {
    for (const userExplicitEnterAfterTextWithoutComposerVeto of [false, true]) {
      await t.test(userExplicitEnterAfterTextWithoutComposerVeto
        ? "managed explicit Enter" : "strict Composer proof", async (t) => {
        const divider = "────────────────────────────────────────────────";
        const idleFooter = "  ⏸ manual mode on";
        const injectedFooter = "  ⏸ manual mode on";
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-manual-send-"));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const claudeHome = path.join(root, ".claude");
        const workspace = path.join(root, "workspace");
        const sessionId = "11111111-1111-4111-8111-111111111111";
        const promptUuid = "22222222-2222-4222-8222-222222222222";
        const startedAt = "2026-10-26T06:03:45.000Z";
        const acceptedAt = "2026-10-26T06:03:46.000Z";
        const projectDirectory = path.join(
          claudeHome, "projects", workspace.replace(/[^A-Za-z0-9]/gu, "-")
        );
        const transcriptPath = path.join(projectDirectory, `${sessionId}.jsonl`);
        fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
        fs.mkdirSync(workspace);
        fs.writeFileSync(transcriptPath, JSON.stringify({
          type: "permission-mode", permissionMode: "default", sessionId
        }) + "\n", { mode: 0o600 });
        const agentRows = [{
          pid: MANAGED_CLAUDE_RUNTIME.pid,
          cwd: workspace,
          kind: "interactive",
          sessionId,
          startedAt: Date.parse("2026-10-23T07:00:00.000Z"),
          status: "idle"
        }];
        const anchor = captureClaudeTranscriptAnchor({
          sessionId, cwd: workspace, pid: MANAGED_CLAUDE_RUNTIME.pid,
          claudeHome, agentRows, now: new Date(startedAt)
        });
        assert.ok(anchor);
        const requestHash = createHash("sha256").update(request).digest("hex");
        const detectAcceptance = () => detectClaudeTranscriptAcceptance({
          sessionId, cwd: workspace, requestText: request, requestHash, startedAt,
          context: {
            pid: MANAGED_CLAUDE_RUNTIME.pid,
            sessionId,
            nativeTakeover: { claude_transcript_anchor: anchor }
          }
        }, { claudeHome, agentRows });
        assert.equal(detectAcceptance(), undefined);
        class ManualModeClaudeProvider extends RecordingTerminalProvider {
          private injectedText: string | undefined;

          override async sendText(
            target: TerminalEndpointRef | string,
            text: string,
            options: TerminalProviderTextOptions = {}
          ): Promise<void> {
            await super.sendText(target, text, options);
            this.injectedText = text;
            this.setScreen(
              target,
              [divider, `❯ ${text}`, divider, injectedFooter].join("\n")
            );
            assert.equal(detectAcceptance(), undefined,
              "text in the manual Composer is not native acceptance");
          }

          override async sendKeys(
            target: TerminalEndpointRef | string,
            keys: readonly string[],
            options: { socketPath?: string } = {}
          ): Promise<void> {
            await super.sendKeys(target, keys, options);
            if (!keys.includes("C-m")) return;
            assert.equal(this.injectedText, request);
            fs.appendFileSync(transcriptPath, JSON.stringify({
              type: "user",
              uuid: promptUuid,
              parentUuid: null,
              isSidechain: false,
              entrypoint: "cli",
              timestamp: acceptedAt,
              sessionId,
              cwd: workspace,
              version: "2.1.295",
              permissionMode: "default",
              message: { role: "user", content: this.injectedText }
            }) + "\n");
            agentRows[0].status = "working";
          }
        }
        const provider = new ManualModeClaudeProvider([{ ...PANE, currentPath: workspace }], {
          [PANE.target]: [divider, "❯ ", divider, idleFooter].join("\n")
        });
        const adapter = createClaudeTerminalAgentAdapter({ agentRows });
        const bridge = createBridge(adapter, provider);
        const stages: string[] = [];

        const result = await bridge.send(
          "claude",
          { ...terminalControl(adapter), currentPath: workspace },
          request,
          {
            runtime: { ...MANAGED_CLAUDE_RUNTIME, cwd: workspace, agentVersion: "2.1.295" },
            requireExactEmptyComposerBeforeText: true,
            requireExactComposerBeforeEnter: true,
            userExplicitEnterAfterTextWithoutComposerVeto,
            beforeEnter() {
              assert.equal(detectAcceptance(), undefined,
                "acceptance requires the native root user row after Enter");
            },
            onTransportStage({ stage }) {
              stages.push(stage);
            }
          }
        );

        assert.equal(result.stage, "enter_dispatched");
        assert.deepEqual(stages, ["text_injected", "enter_dispatched"]);
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
        const acceptance = detectAcceptance();
        assert.ok(acceptance);
        assert.equal(acceptance.source, "claude_transcript");
        assert.equal(acceptance.kind, "native_user_turn");
        assert.equal(acceptance.nativeThreadId, sessionId);
        assert.equal(acceptance.acceptanceId, promptUuid);
        assert.equal(acceptance.requestHash, requestHash);
        assert.equal(acceptance.acceptedAt, acceptedAt);
      });
    }
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
          options: TerminalProviderTextOptions = {}
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
          options: TerminalProviderTextOptions = {}
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
          options: TerminalProviderTextOptions = {}
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
          options: TerminalProviderTextOptions = {}
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
          options: TerminalProviderTextOptions = {}
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
        options: TerminalProviderTextOptions = {}
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
      TerminalUserExplicitClearUncertainError
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

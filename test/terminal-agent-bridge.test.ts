import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createTerminalAgentAdapterRegistry,
  type TerminalAgentAdapter,
  type TerminalAgentAdapterCapabilities,
  type TerminalCompletionEvidence,
  type TerminalDurableCompletionRequest,
  type TerminalScreenInspection
} from "../src/terminal-agent-adapter.js";
import {
  createClaudeTerminalAgentAdapter,
  planClaudeNativeInspection,
  probeClaudeNativeInspection
} from "../src/claude-terminal-agent-adapter.js";
import {
  codexTerminalAgentAdapter,
  planCodexNativeInspection,
  probeCodexNativeInspection
} from "../src/codex-terminal-agent-adapter.js";
import {
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import {
  terminalRefFromPane,
  type TerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";

const PANE: TerminalPane = {
  kind: "tmux",
  target: "claude-work:1.2",
  socketPath: "/tmp/test-tmux.sock",
  session: "claude-work",
  window: 1,
  pane: 2,
  panePid: 100,
  currentCommand: "node",
  currentPath: "/repo"
};

const MANAGED_CLAUDE_RUNTIME = {
  pid: 110,
  cwd: "/repo",
  conversationId: "terminal-claude-conversation",
  messageId: "terminal-claude-message",
  terminalTarget: PANE.target
};

const FULL_CAPABILITIES: TerminalAgentAdapterCapabilities = {
  processDiscovery: true,
  screenStatus: true,
  terminalApproval: true,
  screenCompletion: true,
  durableCompletion: true,
  cancellation: true
};

type ProviderOperation =
  | { kind: "capture"; target: string; socketPath?: string }
  | { kind: "text"; target: string; text: string; socketPath?: string }
  | { kind: "keys"; target: string; keys: string[]; socketPath?: string };

class RecordingTerminalProvider implements TerminalControlProvider {
  readonly operations: ProviderOperation[] = [];
  private readonly screens = new Map<string, string>();

  constructor(
    private readonly panes: TerminalPane[] = [PANE],
    screens: Record<string, string> = {}
  ) {
    for (const [target, screen] of Object.entries(screens)) {
      this.screens.set(target, screen);
    }
  }

  setScreen(target: string, screen: string): void {
    this.screens.set(target, screen);
  }

  async listPanes(): Promise<TerminalPane[]> {
    return this.panes;
  }

  async capture(
    target: string,
    options: { scrollbackLines?: number; socketPath?: string } = {}
  ): Promise<string> {
    this.operations.push({ kind: "capture", target, socketPath: options.socketPath });
    return this.screens.get(target) ?? "";
  }

  async sendText(
    target: string,
    text: string,
    options: { socketPath?: string } = {}
  ): Promise<void> {
    this.operations.push({ kind: "text", target, text, socketPath: options.socketPath });
  }

  async sendKeys(
    target: string,
    keys: readonly string[],
    options: { socketPath?: string } = {}
  ): Promise<void> {
    this.operations.push({ kind: "keys", target, keys: [...keys], socketPath: options.socketPath });
  }
}

class TimelineTerminalProvider extends RecordingTerminalProvider {
  constructor(
    private readonly timeline: string[],
    panes: TerminalPane[] = [PANE],
    screens: Record<string, string> = {}
  ) {
    super(panes, screens);
  }

  override async capture(
    target: string,
    options: { scrollbackLines?: number; socketPath?: string } = {}
  ): Promise<string> {
    this.timeline.push("capture");
    return super.capture(target, options);
  }

  override async sendKeys(
    target: string,
    keys: readonly string[],
    options: { socketPath?: string } = {}
  ): Promise<void> {
    this.timeline.push(`sendKeys:${keys.join(",")}`);
    return super.sendKeys(target, keys, options);
  }
}

function createTestClaudeAdapter(options: {
  capabilities?: Partial<TerminalAgentAdapterCapabilities>;
  cancelKeys?: readonly string[];
  detectDurableCompletion?: (
    request: TerminalDurableCompletionRequest
  ) => Promise<TerminalCompletionEvidence | undefined>;
} = {}): TerminalAgentAdapter<"test_claude_cli"> {
  return {
    agent: "claude",
    displayName: "Test Claude",
    capabilities: { ...FULL_CAPABILITIES, ...options.capabilities },
    cancelKeys: options.cancelKeys ?? ["Escape", "C-c"],
    classifyProcess(snapshot) {
      if (snapshot.command !== "test-claude") {
        return undefined;
      }
      return {
        ...snapshot,
        agent: "claude",
        kind: "test_claude_cli",
        confidence: "high",
        reason: "matched the test-only Claude executable"
      };
    },
    inspectScreen({ screen }) {
      return inspectTestClaudeScreen(screen);
    },
    async detectDurableCompletion(request) {
      return options.detectDurableCompletion?.(request);
    }
  };
}

function inspectTestClaudeScreen(screen: string): TerminalScreenInspection {
  const approvalMatch = /^approval:([^\n]+)$/mu.exec(screen);
  if (approvalMatch) {
    return {
      activity: { state: "awaiting_approval", reason: "test permission prompt" },
      approval: {
        blocked: true,
        approvable: true,
        promptKind: "test_permission",
        command: approvalMatch[1],
        action: { keys: ["Down", "C-m"], label: "Allow once" }
      },
      screenExcerpt: screen
    };
  }

  const workingMatch = /^working:(.*)$/mu.exec(screen);
  if (workingMatch) {
    return {
      activity: { state: "working", reason: workingMatch[1].trim() || "working" },
      approval: { blocked: false, approvable: false, reason: "no permission prompt" },
      screenExcerpt: screen
    };
  }

  return {
    activity: { state: "idle", reason: "test prompt is idle" },
    approval: { blocked: false, approvable: false, reason: "no permission prompt" },
    screenExcerpt: screen,
    completion: screen.includes("screen-complete")
      ? { source: "screen", text: "screen result", confidence: "screen_only" }
      : undefined
  };
}

function createBridge(
  adapter: TerminalAgentAdapter = createTestClaudeAdapter(),
  provider: TerminalControlProvider = new RecordingTerminalProvider()
): TerminalAgentBridge {
  return new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider
  });
}

function terminalControl(adapter: TerminalAgentAdapter = createTestClaudeAdapter()) {
  return terminalRefFromPane(PANE, [
    ...(adapter.capabilities.screenStatus ? ["screen_status" as const] : []),
    "send_keys",
    ...(adapter.capabilities.terminalApproval ? ["terminal_approval" as const] : []),
    ...(adapter.capabilities.screenCompletion ? ["screen_completion" as const] : []),
    ...(adapter.capabilities.durableCompletion ? ["durable_completion" as const] : []),
    ...(adapter.capabilities.cancellation ? ["terminal_cancel" as const] : [])
  ]);
}

function codexStatusInspectionPlan(version = "0.146.1") {
  return planCodexNativeInspection(
    { kind: "status" },
    probeCodexNativeInspection(version)
  );
}

function claudeStatusInspectionPlan(version = "2.1.218") {
  return planClaudeNativeInspection(
    { kind: "status" },
    probeClaudeNativeInspection(version)
  );
}

function claudeNativeComposerScreen(command = "/status"): string {
  return [
    "────────────────────────────────────────────────",
    `❯ ${command}`,
    "────────────────────────────────────────────────",
    "/status                       Show Claude Code status including version, model, account, API",
    "                              connectivity, and tool statuses",
    "/statusline                   Set up Claude Code's status line UI",
    "/ide                          Manage IDE integrations and show status",
    "/usage                        Show session cost, plan usage, and activity stats"
  ].join("\n");
}

function claudeNarrowNativeComposerScreen(command = "/status"): string {
  return [
    "────────────────────────────────────────────────────────────────────────────────",
    `❯ ${command}`,
    "────────────────────────────────────────────────────────────────────────────────",
    "/status                       Show Claude Code status including version,",
    "                              model, account, API connectivity, and tool st…",
    "/statusline                   Set up Claude Code's status line UI",
    "/ide                          Manage IDE integrations and show status",
    "/usage                        Show session cost, plan usage, and activity",
    "                              stats"
  ].join("\n");
}

function claudeNativeStatusPanel(
  nativeThreadId = "40ce9ddb-6de3-45d1-be57-7684808712a0",
  version = "2.1.218"
): string {
  return [
    "────────────────────────────────────────────────",
    "  Settings  Status   Config   Usage   Stats",
    "",
    `  Version:             ${version}`,
    `  Session ID:          ${nativeThreadId}`,
    ...(version === "2.1.226"
      ? ["  Session kind:        interactive"]
      : []),
    "  cwd:                 /repo",
    "  Auth token:          ANTHROPIC_AUTH_TOKEN",
    "",
    "  Model:               claude-sonnet",
    "  MCP servers:         all connected",
    "  Setting sources:     User settings",
    "",
    "  Esc to cancel"
  ].join("\n");
}

function strictClaudeBashApprovalScreen(
  selectedChoice: 1 | 2 | 3 = 1,
  command = "npm test"
): string {
  const choices = [
    "1. Yes",
    `2. Yes, and don’t ask again for: ${command.split(/\s+/u)[0]} *`,
    "3. No"
  ];
  return [
    " Bash command",
    "",
    `   ${command}`,
    "",
    " Do you want to proceed?",
    ...choices.map((choice, index) =>
      ` ${index + 1 === selectedChoice ? "❯" : " "} ${choice}`
    ),
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}

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
      target: string,
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
      target: string,
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
      target: string,
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
      target: string,
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
  const request = [
    "请核对这次投递，并保持下面内容逐字不变。",
    "实际 resume 仍用完整 UUID + fresh tokens。"
  ].join("\n");
  class MutatedWrappedComposerProvider extends RecordingTerminalProvider {
    override async sendText(
      target: string,
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
    async verifyIdentity() {}
  });

  await assert.rejects(
    () => bridge.send(
      "codex",
      terminalControl(codexTerminalAgentAdapter),
      request,
      { runtime: { pid: 110 } }
    ),
    /did not become exact/u
  );
  assert.equal(
    provider.operations.some((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ),
    false
  );
});

test("Codex multiline settle starts only after the exact composer materializes", async () => {
  const request = "延迟出现的第一行\nDelayed second line.";
  class DelayedComposerProvider extends RecordingTerminalProvider {
    materializedAt?: number;
    enterDispatchedAt?: number;

    override async sendText(
      target: string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      setTimeout(() => {
        this.materializedAt = performance.now();
        this.setScreen(target, [
          "Ready",
          "› 延迟出现的第一行",
          "  Delayed second line.",
          "gpt-5.6-sol high · /repo"
        ].join("\n"));
      }, 90);
    }

    override async sendKeys(
      target: string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      if (keys.includes("C-m")) {
        this.enterDispatchedAt = performance.now();
      }
      await super.sendKeys(target, keys, options);
    }
  }

  const provider = new DelayedComposerProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([codexTerminalAgentAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    { runtime: { pid: 110 } }
  );

  assert.ok(provider.materializedAt !== undefined);
  assert.ok(provider.enterDispatchedAt !== undefined);
  assert.ok(
    provider.enterDispatchedAt - provider.materializedAt >= 120,
    "Enter must cross the suppression window after Codex consumes the full paste"
  );
  assert.equal(
    provider.operations.filter((operation) =>
      operation.kind === "keys" && operation.keys.includes("C-m")
    ).length,
    1
  );
});

test("unchanged multilingual multiline composer after one Enter is proven not accepted", async () => {
  const request = "第一行：保留精确内容\nSecond line with  two spaces.";
  class UnchangedComposerProvider extends RecordingTerminalProvider {
    override async sendText(
      target: string,
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
    async verifyIdentity() {}
  });
  await bridge.send(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    request,
    { runtime: { pid: 110 } }
  );
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

test("Codex multiline send fails closed when the stable composer drifts before Enter", async () => {
  const request = "first exact line\nsecond exact line";
  class DriftingCodexProvider extends RecordingTerminalProvider {
    textInjectedAt?: number;
    capturesAfterText = 0;
    drifted = false;

    override async sendText(
      target: string,
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
      target: string,
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
    /composer changed/u
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
      if (checks > 1) {
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

test("bridge preserves ordered approval and cancellation key sequences", async () => {
  const adapter = createTestClaudeAdapter({ cancelKeys: ["Escape", "C-c"] });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const status = await bridge.status("claude", control);
  const approval = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint
  });
  assert.equal(approval.approved, true);
  assert.deepEqual(approval.keys, ["Down", "C-m"]);
  assert.equal(approval.key, undefined);
  assert.equal(approval.command, "npm test");

  const cancellation = await bridge.cancel("claude", control);
  assert.equal(cancellation.cancelRequested, true);
  assert.deepEqual(cancellation.keys, ["Escape", "C-c"]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [
      { kind: "keys", target: PANE.target, keys: ["Down", "C-m"], socketPath: PANE.socketPath },
      { kind: "keys", target: PANE.target, keys: ["Escape", "C-c"], socketPath: PANE.socketPath }
    ]
  );
});

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

test("approval revalidates fingerprint A to B and sends zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:command A"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const initialStatus = await bridge.status("claude", control);
  const fingerprintA = initialStatus.approval_state.fingerprint;
  assert.ok(fingerprintA);

  provider.setScreen(PANE.target, "approval:command B");
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprintA
  });

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed/);
  assert.notEqual(result.fingerprint, fingerprintA);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("keys approval rejects a prompt switch after authorization and sends zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:command A"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  let authorizationCalls = 0;
  const status = await bridge.status("claude", control);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    authorize(context) {
      authorizationCalls += 1;
      assert.equal(context.inspection.approval.approvable, true);
      if (context.inspection.approval.approvable) {
        assert.equal(context.inspection.approval.command, "command A");
      }
      provider.setScreen(PANE.target, "approval:command B");
      return { approved: true };
    }
  });

  assert.equal(authorizationCalls, 1);
  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.command, "command B");
  assert.match(result.reason ?? "", /fingerprint changed after authorization/);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude approval sends one Enter only after a stable double capture", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(status.approval_state.approvable, true);
  assert.equal(status.approval_state.decision_mode, "keys");
  assert.deepEqual(status.approval_state.keys, ["C-m"]);
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(result.approved, true);
  assert.equal(result.blocked, false);
  assert.equal(result.key, "C-m");
  assert.deepEqual(result.keys, ["C-m"]);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "capture").length,
    3
  );
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

test("hookless Claude exposes only transcript hashes publicly and keeps raw policy evidence local", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const commandSha256 = createHash("sha256").update(command).digest("hex");
  const evidenceFingerprint = "d".repeat(64);
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture",
    requestHash: "request-hash",
    startedAt: "2026-07-25T02:00:00.000Z",
    context: { managed: true }
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval(request) {
      detectorCalls += 1;
      assert.equal(request, durableRequest);
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256,
        evidenceFingerprint,
        observedEndOffsetBytes: 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const poll = await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  });
  const fingerprint = poll.status.approval_state.fingerprint;
  assert.ok(fingerprint);
  assert.deepEqual(poll.status.approval_state.policy_evidence, {
    source: "claude_transcript",
    kind: "run_command",
    command_sha256: commandSha256,
    evidence_fingerprint: evidenceFingerprint,
    request_id: "toolu_bridge_approval"
  });
  assert.equal(poll.status.approval_state.command, undefined);
  assert.equal(JSON.stringify(poll.status).includes(command), false);

  let authorizeSawRawEvidence = false;
  let dispatchSawFreshEvidence = false;
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    requiredDecisionMode: "keys",
    authorize({ inspection }) {
      assert.equal(
        inspection.approval.approvable
          ? inspection.approval.policyEvidence?.command
          : undefined,
        command
      );
      authorizeSawRawEvidence = true;
      return { approved: true };
    },
    beforeKeyDispatch({ inspection }) {
      assert.equal(
        inspection.approval.approvable
          ? inspection.approval.policyEvidence?.evidenceFingerprint
          : undefined,
        evidenceFingerprint
      );
      dispatchSawFreshEvidence = true;
    }
  });

  assert.equal(result.approved, true);
  assert.equal(authorizeSawRawEvidence, true);
  assert.equal(dispatchSawFreshEvidence, true);
  assert.equal(detectorCalls, 4);
  assert.equal(JSON.stringify(result).includes(command), false);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    1
  );
});

test("hookless Claude sends zero keys when transcript evidence changes after authorization", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture"
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval() {
      detectorCalls += 1;
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256: createHash("sha256").update(command).digest("hex"),
        evidenceFingerprint: (detectorCalls >= 3 ? "e" : "d").repeat(64),
        observedEndOffsetBytes: detectorCalls >= 3 ? 8193 : 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = (await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  })).status;
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    authorize: () => ({ approved: true })
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed after authorization/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude sends zero keys when transcript evidence changes after reservation", async () => {
  const command = "rm /repo/.akk-safe-fixture";
  const durableRequest: TerminalDurableCompletionRequest = {
    sessionId: "claude-session-approval",
    cwd: "/repo",
    requestText: "Remove the exact test fixture"
  };
  let detectorCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter({
    detectPendingApproval() {
      detectorCalls += 1;
      return {
        source: "claude_transcript",
        kind: "run_command",
        command,
        cwd: "/repo",
        toolName: "Bash",
        toolUseId: "toolu_bridge_approval",
        promptUuid: "prompt-bridge-approval",
        assistantUuid: "assistant-bridge-approval",
        claudeVersion: "2.1.218",
        transcriptFileId: "transcript-bridge-approval",
        commandSha256: createHash("sha256").update(command).digest("hex"),
        evidenceFingerprint: (detectorCalls >= 4 ? "e" : "d").repeat(64),
        observedEndOffsetBytes: detectorCalls >= 4 ? 8193 : 8192
      };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen(1, command)
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = (await bridge.monitorPoll({
    agent: "claude",
    terminalControl: control,
    screenOptions: { runtime: MANAGED_CLAUDE_RUNTIME },
    durableRequest
  })).status;
  assert.ok(status.approval_state.fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    managedRequest: durableRequest,
    authorize: () => ({ approved: true }),
    beforeKeyDispatch: () => undefined
  });

  assert.equal(detectorCalls, 4);
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed after dispatch reservation/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude dispatch reservation is followed by recapture and identity validation", async () => {
  const timeline: string[] = [];
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new TimelineTerminalProvider(timeline, [PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity(request) {
      assert.equal(request.agent, "claude");
      assert.equal(request.pid, MANAGED_CLAUDE_RUNTIME.pid);
      assert.equal(request.terminalControl.target, PANE.target);
      timeline.push("identity");
    }
  });
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(status.approval_state.fingerprint);
  timeline.length = 0;

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: status.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    async beforeKeyDispatch(context) {
      assert.deepEqual(timeline, [
        "identity",
        "capture",
        "identity",
        "capture",
        "identity"
      ]);
      assert.equal(context.agent, "claude");
      assert.equal(context.fingerprint, status.approval_state.fingerprint);
      assert.equal(context.terminalControl.target, PANE.target);
      assert.equal(context.inspection.approval.approvable, true);
      assert.deepEqual(context.keys, ["C-m"]);
      assert.equal(context.runtime, MANAGED_CLAUDE_RUNTIME);
      timeline.push("beforeKeyDispatch");
    }
  });

  assert.equal(result.approved, true);
  assert.deepEqual(timeline, [
    "identity",
    "capture",
    "identity",
    "capture",
    "identity",
    "beforeKeyDispatch",
    "identity",
    "capture",
    "identity",
    "sendKeys:C-m"
  ]);
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

test("hookless Claude revalidates terminal identity after reservation and sends zero keys on reuse", async () => {
  let reservationPersisted = false;
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      if (reservationPersisted) {
        throw new Error("terminal pane was reused after approval reservation");
      }
    }
  });
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  await assert.rejects(
    () => bridge.approve("claude", control, {
      expectedFingerprint: fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch() {
        reservationPersisted = true;
      }
    }),
    /pane was reused after approval reservation/u
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude rejects a changed terminal ref from the final identity check", async () => {
  let verificationCalls = 0;
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity({ terminalControl }) {
      verificationCalls += 1;
      if (verificationCalls === 6) {
        return {
          terminalControl: {
            ...terminalControl,
            socketPath: "/tmp/reused-tmux.sock"
          }
        };
      }
      return { terminalControl };
    }
  });
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  await assert.rejects(
    bridge.approve("claude", control, {
      expectedFingerprint: fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch: () => undefined
    }),
    /terminal control identity changed after the final approval capture/u
  );
  assert.equal(verificationCalls, 6);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude recaptures the one-time choice after reservation and sends zero keys on selection change", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME,
    beforeKeyDispatch() {
      provider.setScreen(PANE.target, strictClaudeBashApprovalScreen(2));
    }
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /no longer approvable after dispatch reservation/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude sends zero keys when the dispatch callback throws", async () => {
  const timeline: string[] = [];
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new TimelineTerminalProvider(timeline, [PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      timeline.push("identity");
    }
  });
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(status.approval_state.fingerprint);
  timeline.length = 0;

  await assert.rejects(
    () => bridge.approve("claude", control, {
      expectedFingerprint: status.approval_state.fingerprint,
      runtime: MANAGED_CLAUDE_RUNTIME,
      beforeKeyDispatch() {
        assert.deepEqual(timeline, [
          "identity",
          "capture",
          "identity",
          "capture",
          "identity"
        ]);
        timeline.push("beforeKeyDispatch");
        throw new Error("dispatch reservation failed");
      }
    }),
    /dispatch reservation failed/u
  );

  assert.deepEqual(timeline, [
    "identity",
    "capture",
    "identity",
    "capture",
    "identity",
    "beforeKeyDispatch"
  ]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude approval sends zero keys when Yes changes before the second capture", async (t) => {
  for (const [label, selectedChoice] of [
    ["persistent permission", 2],
    ["No", 3]
  ] as const) {
    await t.test(label, async () => {
      const adapter = createClaudeTerminalAgentAdapter();
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: strictClaudeBashApprovalScreen()
      });
      const bridge = createBridge(adapter, provider);
      const control = terminalControl(adapter);
      const status = await bridge.status("claude", control, {
        runtime: MANAGED_CLAUDE_RUNTIME
      });
      assert.ok(status.approval_state.fingerprint);

      const result = await bridge.approve("claude", control, {
        expectedFingerprint: status.approval_state.fingerprint,
        runtime: MANAGED_CLAUDE_RUNTIME,
        authorize() {
          provider.setScreen(
            PANE.target,
            strictClaudeBashApprovalScreen(selectedChoice)
          );
          return { approved: true };
        }
      });

      assert.equal(result.approved, false);
      assert.equal(result.blocked, true);
      assert.match(result.reason ?? "", /no longer approvable after authorization/u);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        []
      );
    });
  }
});

test("hookless Claude fingerprints raw screen changes hidden by redaction", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const firstScreen = strictClaudeBashApprovalScreen(
    1,
    "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa' https://example.test"
  );
  const secondScreen = strictClaudeBashApprovalScreen(
    1,
    "curl -H 'Authorization: Bearer bbbbbbbbbbbbbbbbbbbbbbbb' https://example.test"
  );
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: firstScreen
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const firstStatus = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(firstStatus.approval_state.fingerprint);
  assert.equal(firstStatus.approval_state.command, undefined);
  assert.equal(
    firstStatus.approval_state.request_detail,
    "Bash request details omitted; inspect the live terminal pane directly"
  );
  assert.doesNotMatch(firstStatus.approval_state.request_detail, /Bearer/u);
  assert.doesNotMatch(firstStatus.screen.excerpt ?? "", /aaaaaaaa/u);

  provider.setScreen(PANE.target, secondScreen);
  const secondStatus = await bridge.status("claude", control, {
    runtime: MANAGED_CLAUDE_RUNTIME
  });
  assert.ok(secondStatus.approval_state.fingerprint);
  assert.equal(
    secondStatus.approval_state.request_detail,
    firstStatus.approval_state.request_detail
  );
  assert.equal(secondStatus.screen.excerpt, firstStatus.screen.excerpt);
  assert.notEqual(
    secondStatus.approval_state.fingerprint,
    firstStatus.approval_state.fingerprint
  );

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: firstStatus.approval_state.fingerprint,
    runtime: MANAGED_CLAUDE_RUNTIME
  });

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /fingerprint changed before execution/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("hookless Claude key approval requires the latest expected fingerprint", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: strictClaudeBashApprovalScreen()
  });
  const bridge = createBridge(adapter, provider);

  const result = await bridge.approve(
    "claude",
    terminalControl(adapter),
    { runtime: MANAGED_CLAUDE_RUNTIME }
  );

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /requires the latest expected fingerprint/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("cancel fails closed for an ambiguous non-approvable prompt without sending keys", async () => {
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "ambiguous permission state" },
        approval: {
          blocked: true,
          approvable: false,
          reason: "multiple pending permission requests are ambiguous"
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "ambiguous permission"
  });

  const result = await createBridge(adapter, provider).cancel(
    "claude",
    terminalControl(adapter)
  );

  assert.equal(result.cancelRequested, false);
  assert.match(result.reason ?? "", /ambiguous/);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("ordered approval keys participate in fingerprint revalidation", async () => {
  let approvalKeys: readonly string[] = ["Down", "C-m"];
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "test permission prompt" },
        approval: {
          blocked: true,
          approvable: true,
          promptKind: "test_permission",
          command: "npm test",
          action: { keys: approvalKeys, label: "Allow once" }
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "same approval screen"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const fingerprintA = (await bridge.status("claude", control)).approval_state.fingerprint;
  assert.ok(fingerprintA);

  approvalKeys = ["C-m", "Down"];
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprintA
  });

  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed/);
  assert.notEqual(result.fingerprint, fingerprintA);
  assert.deepEqual(result.keys, ["C-m", "Down"]);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("approval with an empty ordered key sequence fails closed", async () => {
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "test permission prompt" },
        approval: {
          blocked: true,
          approvable: true,
          promptKind: "test_permission",
          command: "npm test",
          action: { keys: [], label: "Broken action" }
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);

  const result = await bridge.approve("claude", terminalControl(adapter));

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.match(result.reason ?? "", /approval action has no keys/);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

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
    /terminal input is not supported/
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

test("send clears pasted text and never submits it when the second identity check fails", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE]);
  let checks = 0;
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {
      checks += 1;
      if (checks === 2) {
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
    },
    {
      kind: "keys",
      target: PANE.target,
      keys: ["C-u"],
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
      target: string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, composerScreen);
    }

    override async sendKeys(
      target: string,
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

test("Claude 2.1.226 native status uses its own stable composer and one modal dismissal", async () => {
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
      target: string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.textInjectedAt = performance.now();
      this.setScreen(target, claudeNativeComposerScreen(text));
    }

    override async sendKeys(
      target: string,
      keys: readonly string[],
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendKeys(target, keys, options);
      if (keys.includes("C-m")) {
        this.enterDispatchedAt = performance.now();
        this.setScreen(
          target,
          claudeNativeStatusPanel(nativeThreadId, "2.1.226")
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
  const plan = claudeStatusInspectionPlan("2.1.226");
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
    expectedAgentVersion: "2.1.226",
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
});

test("Claude 2.1.226 native status accepts its exact 80-column truncated popup", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  class NarrowClaudeProvider extends RecordingTerminalProvider {
    override async sendText(
      target: string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, claudeNarrowNativeComposerScreen(text));
    }
  }
  const provider = new NarrowClaudeProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([adapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const result = await bridge.submitNativeInspection(
    "claude",
    terminalControl(adapter),
    claudeStatusInspectionPlan("2.1.226"),
    { runtime: { pid: 110 } }
  );
  assert.equal(result.materialization.kind, "exact_slash_popup");
  assert.equal(result.enterCount, 1);
});

test("Claude 2.1.226 native status rejects a non-prefix truncated popup", async () => {
  const adapter = createClaudeTerminalAgentAdapter();
  class DriftedNarrowClaudeProvider extends RecordingTerminalProvider {
    private capturesAfterInjection = 0;

    override async sendText(
      target: string,
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
      target: string,
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
      claudeStatusInspectionPlan("2.1.226"),
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
      target: string,
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
      _target: string,
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
      target: string,
      text: string,
      options: { socketPath?: string } = {}
    ): Promise<void> {
      await super.sendText(target, text, options);
      this.setScreen(target, claudeNativeComposerScreen(text));
    }

    override async sendKeys(
      _target: string,
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

test("native status inspection accepts an exact current slash popup only at a proven idle prompt", async () => {
  class SlashPopupProvider extends RecordingTerminalProvider {
    override async sendText(
      target: string,
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

test("Codex 0.147.0 native status requires its exact ordered two-row slash popup", async () => {
  class CurrentPopupProvider extends RecordingTerminalProvider {
    override async sendText(
      target: string,
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
          reason: "verified 0.147.0 slash popup is current and idle"
        }
      };
    }
  };
  const provider = new CurrentPopupProvider([PANE]);
  const bridge = new TerminalAgentBridge({
    registry: createTerminalAgentAdapterRegistry([idlePopupAdapter]),
    terminalProvider: provider,
    async verifyIdentity() {}
  });
  const result = await bridge.submitNativeInspection(
    "codex",
    terminalControl(codexTerminalAgentAdapter),
    codexStatusInspectionPlan("0.147.0"),
    { runtime: { pid: 110 } }
  );
  assert.equal(result.materialization.kind, "exact_slash_popup");
  assert.equal(result.enterCount, 1);
});

test("Codex 0.147.0 native status refuses an incomplete two-row popup", async () => {
  class IncompleteCurrentPopupProvider extends RecordingTerminalProvider {
    private capturesAfterInjection = 0;

    override async sendText(
      target: string,
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
      target: string,
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
      codexStatusInspectionPlan("0.147.0"),
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

test("native status inspection rejects an unprofiled slash popup description before Enter", async () => {
  class UnprofiledPopupProvider extends RecordingTerminalProvider {
    private capturesAfterInjection = 0;

    override async sendText(
      target: string,
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
      target: string,
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
      target: string,
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
      target: string,
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
        target: string,
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
      target: string,
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
        target: string,
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
    const provider = new NativeStatusProvider([PANE]);
    const bridge = new TerminalAgentBridge({
      registry: createTerminalAgentAdapterRegistry([inventoryAdapter]),
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
        assert.match(error.message, /test adapter/u);
        return true;
      }
    );
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
      target: string,
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
      target: string,
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

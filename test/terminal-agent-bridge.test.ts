import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createTerminalAgentAdapterRegistry,
  terminalApprovalPromptEvidence,
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
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  terminalApprovalFingerprint
} from "../src/terminal-agent-bridge.js";
import {
  terminalRefFromPane,
  StaticTerminalControlProvider,
  TerminalControlInputNotSentError,
  type TerminalControlProvider,
  type TerminalPane
} from "../src/terminal-control-provider.js";
import type {
  TerminalControlRef,
  TerminalEndpointRef,
  TerminalProviderCapability
} from "../src/terminal-control-ref.js";

const PANE: TerminalPane = {
  kind: "tmux",
  target: "claude-work:1.2",
  socketPath: "/tmp/test-tmux.sock",
  session: "claude-work",
  window: 1,
  pane: 2,
  panePid: 100,
  currentCommand: "node",
  currentPath: "/repo",
  columns: 80,
  rows: 40
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

class RecordingTerminalProvider extends StaticTerminalControlProvider {
  readonly operations: ProviderOperation[] = [];
  private readonly recordingScreens = new Map<string, string>();

  constructor(
    panes: TerminalPane[] = [PANE],
    screens: Record<string, string> = {}
  ) {
    super({ panes, screens });
    for (const [target, screen] of Object.entries(screens)) {
      this.recordingScreens.set(target, screen);
    }
    for (const pane of panes) {
      if (!this.recordingScreens.has(pane.target)) {
        // Mutating bridge tests start from the newly required exact safe
        // Codex pre-text frame. Tests for another initial state always pass an
        // explicit screen and therefore do not inherit this fixture default.
        this.recordingScreens.set(
          pane.target,
          codexPaddedStyledIdleScreen(80)
        );
      }
    }
  }

  setScreen(target: TerminalEndpointRef | string, screen: string): void {
    this.recordingScreens.set(providerTarget(target).target, screen);
  }

  override async capture(
    terminal: TerminalEndpointRef | string,
    options: {
      scrollbackLines?: number;
      socketPath?: string;
      preserveEscapes?: boolean;
    } = {}
  ): Promise<string> {
    const { target, socketPath } = providerTarget(terminal, options.socketPath);
    this.operations.push({ kind: "capture", target, socketPath });
    return this.recordingScreens.get(target) ?? "";
  }

  override async sendText(
    terminal: TerminalEndpointRef | string,
    text: string,
    options: { socketPath?: string } = {}
  ): Promise<void> {
    const { target, socketPath } = providerTarget(terminal, options.socketPath);
    this.operations.push({ kind: "text", target, text, socketPath });
  }

  override async sendKeys(
    terminal: TerminalEndpointRef | string,
    keys: readonly string[],
    options: { socketPath?: string } = {}
  ): Promise<void> {
    const { target, socketPath } = providerTarget(terminal, options.socketPath);
    this.operations.push({ kind: "keys", target, keys: [...keys], socketPath });
  }
}

class CapabilityLimitedTerminalProvider extends RecordingTerminalProvider {
  override readonly providerCapabilities: readonly TerminalProviderCapability[];

  constructor(
    providerCapabilities: readonly TerminalProviderCapability[],
    panes: TerminalPane[] = [PANE],
    screens: Record<string, string> = {}
  ) {
    super(panes, screens);
    this.providerCapabilities = [...providerCapabilities];
  }
}

function providerTarget(
  terminal: TerminalEndpointRef | string,
  legacySocketPath?: string
): { target: string; socketPath?: string } {
  if (typeof terminal === "string") {
    return { target: terminal, socketPath: legacySocketPath };
  }
  const providerRef = terminal.providerRef as Partial<TerminalControlRef>;
  if (providerRef.kind !== "tmux" || !providerRef.target) {
    throw new Error("test provider expected a tmux terminal endpoint");
  }
  return {
    target: providerRef.target,
    socketPath: providerRef.socketPath
  };
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
    target: TerminalEndpointRef | string,
    options: { scrollbackLines?: number; socketPath?: string } = {}
  ): Promise<string> {
    this.timeline.push("capture");
    return super.capture(target, options);
  }

  override async sendKeys(
    target: TerminalEndpointRef | string,
    keys: readonly string[],
    options: { socketPath?: string } = {}
  ): Promise<void> {
    this.timeline.push(`sendKeys:${keys.join(",")}`);
    return super.sendKeys(target, keys, options);
  }
}

class SequencedResolutionProvider extends RecordingTerminalProvider {
  resolveCount = 0;

  constructor(private readonly resolutions: readonly TerminalEndpointRef[]) {
    super([]);
    if (resolutions.length === 0) {
      throw new Error("sequenced provider requires at least one resolution");
    }
  }

  override async resolve(
    _terminal: TerminalEndpointRef
  ): Promise<TerminalEndpointRef> {
    const resolved = this.resolutions[
      Math.min(this.resolveCount, this.resolutions.length - 1)
    ];
    this.resolveCount += 1;
    return resolved;
  }
}

async function endpointForPane(pane: TerminalPane): Promise<TerminalEndpointRef> {
  const endpoints = await new StaticTerminalControlProvider({
    panes: [pane]
  }).listTerminals();
  assert.equal(endpoints.length, 1);
  return endpoints[0];
}

function stablePane(
  target: string,
  overrides: Partial<TerminalPane> = {}
): TerminalPane {
  const [session = target, route = "0.0"] = target.split(":", 2);
  const [windowText = "0", paneText = "0"] = route.split(".", 2);
  return {
    ...PANE,
    target,
    session,
    window: Number.parseInt(windowText, 10),
    pane: Number.parseInt(paneText, 10),
    serverSocketPath: "/tmp/stable-tmux-server.sock",
    paneId: "%42",
    ...overrides
  };
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
        promptEvidence: terminalApprovalPromptEvidence(
          "test-approval-prompt-v1",
          approvalMatch[0]
        ),
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

function codexPaddedStyledIdleScreen(columns: number): string {
  const pad = (value: string): string => {
    const visible = value.replace(/\u001b\[[0-9;]*m/gu, "");
    return `${value}${" ".repeat(
      Math.max(0, columns - Array.from(visible).length)
    )}`;
  };
  return [
    pad("Ready"),
    pad("› \u001b[2mSummarize recent commits\u001b[0m"),
    pad("gpt-5.6-sol high · /repo")
  ].join("\n");
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
    ...(version === "2.1.218"
      ? []
      : ["  Session kind:        interactive"]),
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

function strictCodexCommandApprovalScreen(command = "npm test"): string {
  return [
    "  Would you like to run the following command?",
    "",
    `  $ ${command}`,
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
}

function ambiguousCodexCommandApprovalScreen(dangerousPrefix: string): string {
  return [
    "  Would you like to run the following command?",
    "",
    "  $ printf '%s\\n' \\",
    `    '${dangerousPrefix}' \\`,
    "    apparently-harmless-first-suffix",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel",
    "  Would you like to run the following command?",
    "    apparently-harmless-suffix",
    "",
    "› 1. Yes, proceed (y)",
    "  2. No, and tell Codex what to do differently (esc)",
    "",
    "  Press enter to confirm or esc to cancel"
  ].join("\n");
}

function ambiguousClaudeBashApprovalScreen(dangerousPrefix: string): string {
  return [
    " Bash command",
    "",
    `   ${dangerousPrefix} && \\`,
    ...Array.from(
      { length: 49 },
      (_, index) => `   wrapped command detail ${index + 1}`
    ),
    " Bash command",
    "   printf harmless-looking-suffix",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don't ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}

function approvalScreenWithOutsideOutput(
  outsideOutput: string,
  prompt: string
): string {
  return `${outsideOutput}\n${prompt}`;
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
  assert.equal(
    requestedSleepMs.reduce((total, milliseconds) => total + milliseconds, 0),
    nowMs - startedAt
  );
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
  assert.equal(
    requestedSleepMs.reduce((total, milliseconds) => total + milliseconds, 0),
    nowMs
  );
  assert.equal(provider.materializedAt, materializeAfterMs);
  assert.ok(
    provider.enterDispatchedAt - provider.materializedAt >= 120,
    "Enter must cross the suppression window after Codex consumes the full paste"
  );
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

test("explicit Codex Send injects, submits, or replaces by composer state", async (t) => {
  const request = "the user's newest explicit request";
  const cases = [
    {
      name: "empty composer",
      screen: codexPaddedStyledIdleScreen(80),
      disposition: "injected_empty_composer",
      mutations: ["text", "keys:C-m"]
    },
    {
      name: "same draft",
      screen: `› ${request}\ngpt-5.6-sol high · /repo`,
      disposition: "submitted_existing_draft",
      mutations: ["keys:C-m"]
    },
    {
      name: "different draft",
      screen: "› an older unrelated draft\ngpt-5.6-sol high · /repo",
      disposition: "replaced_existing_draft",
      mutations: ["keys:C-u", "text", "keys:C-m"]
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      class ExplicitSendProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, `› ${text}\ngpt-5.6-sol high · /repo`);
        }

        override async sendKeys(
          target: TerminalEndpointRef | string,
          keys: readonly string[],
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendKeys(target, keys, options);
          if (keys.includes("C-u")) {
            this.setScreen(target, codexPaddedStyledIdleScreen(80));
          }
        }
      }
      const provider = new ExplicitSendProvider([PANE], {
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
      const reservations: string[] = [];
      const result = await bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        {
          beforeMutationReservation: ({ composerState }) => {
            reservations.push(composerState);
          }
        }
      );
      assert.equal(result.disposition, testCase.disposition);
      assert.deepEqual(reservations, [
        testCase.name === "empty composer"
          ? "exact_empty"
          : testCase.name === "same draft"
            ? "exact_draft"
            : "different_draft"
      ]);
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        testCase.mutations
      );
    });
  }
});

test("explicit Codex Send preserves user priority on a working mutable composer", async (t) => {
  const request = "the user's newest explicit request";
  const workingLine =
    "• Working (8s · esc to interrupt) · 1 background terminal running";
  const workingScreen = (composer: string) => [
    workingLine,
    composer,
    "gpt-5.6-sol high · /repo"
  ].join("\n");
  const cases = [
    {
      name: "empty composer",
      screen: `${workingLine}\n${codexPaddedStyledIdleScreen(80)}`,
      disposition: "injected_empty_composer",
      mutations: ["text", "keys:C-m"]
    },
    {
      name: "same draft",
      screen: workingScreen(`› ${request}`),
      disposition: "submitted_existing_draft",
      mutations: ["keys:C-m"]
    },
    {
      name: "different draft",
      screen: workingScreen("› an older unrelated draft"),
      disposition: "replaced_existing_draft",
      mutations: ["keys:C-u", "text", "keys:C-m"]
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      class WorkingExplicitSendProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, workingScreen(`› ${text}`));
        }

        override async sendKeys(
          target: TerminalEndpointRef | string,
          keys: readonly string[],
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendKeys(target, keys, options);
          if (keys.includes("C-u")) {
            this.setScreen(
              target,
              `${workingLine}\n${codexPaddedStyledIdleScreen(80)}`
            );
          }
        }
      }
      const provider = new WorkingExplicitSendProvider([PANE], {
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
      const result = await bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      );
      assert.equal(result.disposition, testCase.disposition);
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        testCase.mutations
      );
    });
  }
});

test("explicit Codex Send still rejects approval while working is allowed", async () => {
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

test("explicit Codex Send keeps every pre-mutation callback failure retry-safe", async (t) => {
  const request = "new explicit request";
  const cases = [
    {
      name: "empty composer",
      screen: codexPaddedStyledIdleScreen(80)
    },
    {
      name: "same draft",
      screen: `› ${request}\ngpt-5.6-sol high · /repo`
    },
    {
      name: "different draft",
      screen: "› older draft\ngpt-5.6-sol high · /repo"
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
      await assert.rejects(
        bridge.sendUserExplicitCodex(
          terminalControl(codexTerminalAgentAdapter),
          request,
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
  }
});

test("explicit Codex Send distinguishes proven zero text from uncertain injected text", async (t) => {
  const request = "new explicit request";

  await t.test("typed text-not-sent proof remains retry-safe", async () => {
    let nowMs = 0;
    class ProvenNoTextProvider extends RecordingTerminalProvider {
      override async sendText(): Promise<void> {
        throw new TerminalControlInputNotSentError(
          "test provider proved text was not delivered"
        );
      }
    }
    const provider = new ProvenNoTextProvider([PANE], {
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
      bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      ),
      TerminalInputNotStartedError
    );
    assert.equal(
      provider.operations.some((operation) => operation.kind !== "capture"),
      false
    );
  });

  for (const testCase of [
    {
      name: "typed exact-draft Enter-not-sent proof remains retry-safe",
      screen: `› ${request}\ngpt-5.6-sol high · /repo`
    },
    {
      name: "typed different-draft clear-not-sent proof remains retry-safe",
      screen: "› older draft\ngpt-5.6-sol high · /repo"
    }
  ]) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      class ProvenNoKeyProvider extends RecordingTerminalProvider {
        override async sendKeys(): Promise<void> {
          throw new TerminalControlInputNotSentError(
            "test provider proved the first key was not delivered"
          );
        }
      }
      const provider = new ProvenNoKeyProvider([PANE], {
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
      await assert.rejects(
        bridge.sendUserExplicitCodex(
          terminalControl(codexTerminalAgentAdapter),
          request,
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

  await t.test("successful text call followed by an inexact draft is uncertain", async () => {
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
      ["text"]
    );
  });
});

test("explicit Codex Send treats every attempted Enter as uncertain on transport failure", async (t) => {
  const request = "new explicit request";
  const cases = [
    {
      name: "empty composer",
      screen: codexPaddedStyledIdleScreen(80),
      mutations: ["text", "keys:C-m"]
    },
    {
      name: "same draft",
      screen: `› ${request}\ngpt-5.6-sol high · /repo`,
      mutations: ["keys:C-m"]
    },
    {
      name: "different draft",
      screen: "› older draft\ngpt-5.6-sol high · /repo",
      mutations: ["keys:C-u", "text", "keys:C-m"]
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      class FailedEnterProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(target, `› ${text}\ngpt-5.6-sol high · /repo`);
        }

        override async sendKeys(
          target: TerminalEndpointRef | string,
          keys: readonly string[],
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendKeys(target, keys, options);
          if (keys.includes("C-u")) {
            this.setScreen(target, codexPaddedStyledIdleScreen(80));
          }
          if (keys.includes("C-m")) {
            throw new Error("Enter delivery outcome is unknown");
          }
        }
      }
      const provider = new FailedEnterProvider([PANE], {
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
        testCase.mutations
      );
    });
  }
});

test("explicit Codex Send submits fresh large-paste placeholders and replaces opaque old drafts", async (t) => {
  const request = "x".repeat(1_001);
  const cases = [
    {
      name: "empty composer",
      screen: codexPaddedStyledIdleScreen(80),
      disposition: "injected_empty_composer",
      mutations: ["text", "keys:C-m"]
    },
    {
      name: "different visible draft",
      screen: "› older draft\ngpt-5.6-sol high · /repo",
      disposition: "replaced_existing_draft",
      mutations: ["keys:C-u", "text", "keys:C-m"]
    },
    {
      name: "same-length opaque existing draft",
      screen: "› [Pasted Content 1001 chars]\ngpt-5.6-sol high · /repo",
      disposition: "replaced_existing_draft",
      mutations: ["keys:C-u", "text", "keys:C-m"]
    }
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let nowMs = 0;
      class LargePasteProvider extends RecordingTerminalProvider {
        override async sendText(
          target: TerminalEndpointRef | string,
          text: string,
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendText(target, text, options);
          this.setScreen(
            target,
            `› [Pasted Content ${Array.from(text).length} chars]\n` +
              "gpt-5.6-sol high · /repo"
          );
        }

        override async sendKeys(
          target: TerminalEndpointRef | string,
          keys: readonly string[],
          options: { socketPath?: string } = {}
        ): Promise<void> {
          await super.sendKeys(target, keys, options);
          if (keys.includes("C-u")) {
            this.setScreen(target, codexPaddedStyledIdleScreen(80));
          }
        }
      }
      const provider = new LargePasteProvider([PANE], {
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
      const result = await bridge.sendUserExplicitCodex(
        terminalControl(codexTerminalAgentAdapter),
        request,
        { beforeMutationReservation() {} }
      );
      assert.equal(result.disposition, testCase.disposition);
      assert.deepEqual(
        provider.operations.flatMap((operation) =>
          operation.kind === "capture"
            ? []
            : operation.kind === "text"
              ? ["text"]
              : [`keys:${operation.keys.join(",")}`]
        ),
        testCase.mutations
      );
    });
  }
});

test("explicit Codex replacement revalidates before clear and proves clear before text", async (t) => {
  const request = "new explicit request";
  await t.test("empty and same drafts that drift before mutation stay retry-safe", async (nested) => {
    const cases = [
      {
        name: "empty composer",
        screen: codexPaddedStyledIdleScreen(80)
      },
      {
        name: "same draft",
        screen: `› ${request}\ngpt-5.6-sol high · /repo`
      }
    ];
    for (const testCase of cases) {
      await nested.test(testCase.name, async () => {
        let nowMs = 0;
        const provider = new RecordingTerminalProvider([PANE], {
          [PANE.target]: testCase.screen
        });
        const bridge = new TerminalAgentBridge({
          registry: createTerminalAgentAdapterRegistry([
            codexTerminalAgentAdapter
          ]),
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
              beforeMutationReservation() {
                provider.setScreen(
                  PANE.target,
                  "› human changed the draft\ngpt-5.6-sol high · /repo"
                );
              }
            }
          ),
          TerminalInputNotStartedError
        );
        assert.equal(
          provider.operations.some((operation) =>
            operation.kind !== "capture"
          ),
          false
        );
      });
    }
  });

  await t.test("draft drift before clear sends no input", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "› old draft\ngpt-5.6-sol high · /repo"
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
          beforeMutationReservation() {
            provider.setScreen(
              PANE.target,
              "› human changed the draft\ngpt-5.6-sol high · /repo"
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

  await t.test("failed clear is uncertain and never injects the new request", async () => {
    let nowMs = 0;
    const provider = new RecordingTerminalProvider([PANE], {
      [PANE.target]: "› old draft\ngpt-5.6-sol high · /repo"
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
    assert.equal(
      provider.operations.filter((operation) =>
        operation.kind === "keys" && operation.keys.includes("C-u")
      ).length,
      1
    );
    assert.equal(
      provider.operations.some((operation) =>
        operation.kind === "text" ||
        (operation.kind === "keys" && operation.keys.includes("C-m"))
      ),
      false
    );
  });
});

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

test("prompt-scoped approval survives outside output drift across every capture and dispatches exactly once", async (t) => {
  for (const fixture of [
    {
      name: "Codex",
      agent: "codex" as const,
      adapter: codexTerminalAgentAdapter,
      prompt: strictCodexCommandApprovalScreen(),
      runtime: { pid: 110, cwd: "/repo", terminalTarget: PANE.target },
      expectedKeys: ["y"]
    },
    {
      name: "Claude",
      agent: "claude" as const,
      adapter: createClaudeTerminalAgentAdapter(),
      prompt: strictClaudeBashApprovalScreen(),
      runtime: MANAGED_CLAUDE_RUNTIME,
      expectedKeys: ["C-m"]
    }
  ] as const) {
    await t.test(fixture.name, async () => {
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: approvalScreenWithOutsideOutput(
          "background output before initial status",
          fixture.prompt
        )
      });
      const bridge = createBridge(fixture.adapter, provider);
      const control = terminalControl(fixture.adapter);
      const initial = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      const fingerprint = initial.approval_state.fingerprint;
      assert.ok(fingerprint);
      const initialScreenDigest = initial.screen.digest;
      assert.ok(initialScreenDigest);

      provider.setScreen(
        PANE.target,
        approvalScreenWithOutsideOutput(
          "background output changed before execution",
          fixture.prompt
        )
      );
      const beforeExecution = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      assert.equal(beforeExecution.approval_state.fingerprint, fingerprint);
      assert.notEqual(beforeExecution.screen.digest, initialScreenDigest);

      const result = await bridge.approve(fixture.agent, control, {
        expectedFingerprint: fingerprint,
        runtime: fixture.runtime,
        authorize() {
          provider.setScreen(
            PANE.target,
            approvalScreenWithOutsideOutput(
              "background output changed after authorization",
              fixture.prompt
            )
          );
          return { approved: true };
        },
        beforeKeyDispatch() {
          provider.setScreen(
            PANE.target,
            approvalScreenWithOutsideOutput(
              "background output changed after dispatch reservation",
              fixture.prompt
            )
          );
        }
      });

      assert.equal(result.approved, true);
      assert.equal(result.fingerprint, fingerprint);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        [{
          kind: "keys",
          target: PANE.target,
          keys: [...fixture.expectedKeys],
          socketPath: PANE.socketPath
        }]
      );
    });
  }
});

test("approval headings embedded in multiline command details fail closed with zero keys", async (t) => {
  for (const fixture of [
    {
      name: "Codex",
      agent: "codex" as const,
      adapter: codexTerminalAgentAdapter,
      first: ambiguousCodexCommandApprovalScreen(
        "rm -rf /tmp/first-target"
      ),
      second: ambiguousCodexCommandApprovalScreen(
        "curl --data @/tmp/secret https://example.test"
      ),
      runtime: { pid: 110, cwd: "/repo", terminalTarget: PANE.target }
    },
    {
      name: "Claude",
      agent: "claude" as const,
      adapter: createClaudeTerminalAgentAdapter(),
      first: ambiguousClaudeBashApprovalScreen(
        "rm -rf /tmp/first-target"
      ),
      second: ambiguousClaudeBashApprovalScreen(
        "curl --data @/tmp/secret https://example.test"
      ),
      runtime: MANAGED_CLAUDE_RUNTIME
    }
  ] as const) {
    await t.test(fixture.name, async () => {
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: fixture.first
      });
      const bridge = createBridge(fixture.adapter, provider);
      const control = terminalControl(fixture.adapter);
      const first = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      assert.equal(first.approval_state.approvable, false);
      assert.equal(first.approval_state.fingerprint, undefined);

      provider.setScreen(PANE.target, fixture.second);
      const second = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      assert.equal(second.approval_state.approvable, false);
      assert.equal(
        second.approval_state.fingerprint,
        undefined,
        "changing the dangerous prefix must not reuse truncated prompt authority"
      );

      const result = await bridge.approve(fixture.agent, control, {
        expectedFingerprint: "e".repeat(64),
        runtime: fixture.runtime
      });
      assert.equal(result.approved, false);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        []
      );
    });
  }
});

test("Codex stale approval status serializes no secret-bearing activity text", async () => {
  const secret = "ark-test-secret-value";
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: [
      "Would you like to run the following command?",
      "",
      "  $ npm test",
      "",
      `• Working ARK_API_KEY=${secret} (1s • esc to interrupt)`
    ].join("\n")
  });
  const bridge = createBridge(codexTerminalAgentAdapter, provider);
  const control = terminalControl(codexTerminalAgentAdapter);
  const runtime = { pid: 110, cwd: "/repo", terminalTarget: PANE.target };

  const status = await bridge.status("codex", control, { runtime });
  assert.equal(status.approval_state.approvable, false);
  assert.equal(status.approval_state.fingerprint, undefined);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret, "u"));

  const result = await bridge.approve("codex", control, {
    expectedFingerprint: "e".repeat(64),
    runtime
  });
  assert.equal(result.approved, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("prompt-scoped fingerprint rejects unredacted secret drift hidden by public redaction", async (t) => {
  for (const fixture of [
    {
      name: "Codex",
      agent: "codex" as const,
      adapter: codexTerminalAgentAdapter,
      first: strictCodexCommandApprovalScreen(
        "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa' https://example.test"
      ),
      second: strictCodexCommandApprovalScreen(
        "curl -H 'Authorization: Bearer bbbbbbbbbbbbbbbbbbbbbbbb' https://example.test"
      ),
      runtime: { pid: 110, cwd: "/repo", terminalTarget: PANE.target }
    },
    {
      name: "Claude",
      agent: "claude" as const,
      adapter: createClaudeTerminalAgentAdapter(),
      first: strictClaudeBashApprovalScreen(
        1,
        "curl -H 'Authorization: Bearer aaaaaaaaaaaaaaaaaaaaaaaa' https://example.test"
      ),
      second: strictClaudeBashApprovalScreen(
        1,
        "curl -H 'Authorization: Bearer bbbbbbbbbbbbbbbbbbbbbbbb' https://example.test"
      ),
      runtime: MANAGED_CLAUDE_RUNTIME
    }
  ] as const) {
    await t.test(fixture.name, async () => {
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: fixture.first
      });
      const bridge = createBridge(fixture.adapter, provider);
      const control = terminalControl(fixture.adapter);
      const first = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      const firstFingerprint = first.approval_state.fingerprint;
      assert.ok(firstFingerprint);
      assert.doesNotMatch(first.screen.excerpt ?? "", /aaaaaaaa/u);

      provider.setScreen(PANE.target, fixture.second);
      const second = await bridge.status(fixture.agent, control, {
        runtime: fixture.runtime
      });
      assert.ok(second.approval_state.fingerprint);
      assert.doesNotMatch(second.screen.excerpt ?? "", /bbbbbbbb/u);
      assert.notEqual(second.approval_state.fingerprint, firstFingerprint);

      const result = await bridge.approve(fixture.agent, control, {
        expectedFingerprint: firstFingerprint,
        runtime: fixture.runtime
      });
      assert.equal(result.approved, false);
      assert.match(result.reason ?? "", /fingerprint changed before execution/u);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        []
      );
    });
  }
});

test("approval fingerprint rejects command, options, highlight, reason, kind, cwd, and request identity drift", async (t) => {
  type MutableApproval = {
    command: string;
    cwd: string;
    keys: readonly string[];
    label: string;
    promptKind: string;
    requestDetail: string;
    requestId: string;
    promptRegion: string;
  };
  const initial: MutableApproval = {
    command: "npm test",
    cwd: "/repo",
    keys: ["Down", "C-m"],
    label: "Allow once",
    promptKind: "run_command",
    requestDetail: "Run the exact test command",
    requestId: "request-a",
    promptRegion: "approval region A"
  };
  const drifts: ReadonlyArray<{
    name: string;
    mutate(value: MutableApproval): void;
  }> = [
    { name: "command", mutate: (value) => { value.command = "npm run release"; } },
    { name: "options", mutate: (value) => { value.keys = ["C-m", "Down"]; } },
    { name: "highlight", mutate: (value) => { value.label = "Allow always"; } },
    { name: "reason", mutate: (value) => { value.requestDetail = "Run a different requested command"; } },
    { name: "kind", mutate: (value) => { value.promptKind = "file_edit"; } },
    { name: "cwd", mutate: (value) => { value.cwd = "/repo/other"; } },
    { name: "request id", mutate: (value) => { value.requestId = "request-b"; } }
  ];

  for (const drift of drifts) {
    await t.test(drift.name, async () => {
      const current: MutableApproval = {
        ...initial,
        keys: [...initial.keys]
      };
      const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
        ...createTestClaudeAdapter(),
        inspectScreen({ screen }) {
          return {
            activity: {
              state: "awaiting_approval",
              reason: "mutable exact approval"
            },
            approval: {
              blocked: true,
              approvable: true,
              promptKind: current.promptKind,
              command: current.command,
              cwd: current.cwd,
              requestDetail: current.requestDetail,
              promptEvidence: terminalApprovalPromptEvidence(
                "test-mutable-approval-v1",
                current.promptRegion
              ),
              action: {
                keys: current.keys,
                label: current.label,
                requestId: current.requestId
              }
            },
            screenExcerpt: screen
          };
        }
      };
      const provider = new RecordingTerminalProvider([PANE], {
        [PANE.target]: "same diagnostic screen"
      });
      const bridge = createBridge(adapter, provider);
      const control = terminalControl(adapter);
      const fingerprint = (await bridge.status("claude", control))
        .approval_state.fingerprint;
      assert.ok(fingerprint);

      drift.mutate(current);
      const result = await bridge.approve("claude", control, {
        expectedFingerprint: fingerprint
      });
      assert.equal(result.approved, false);
      assert.match(result.reason ?? "", /fingerprint changed/u);
      assert.deepEqual(
        provider.operations.filter((operation) => operation.kind === "keys"),
        []
      );
    });
  }
});

test("approval fingerprint rejects process identity drift with zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control, {
    runtime: { ...MANAGED_CLAUDE_RUNTIME, pid: 110 }
  })).approval_state.fingerprint;
  assert.ok(fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    runtime: { ...MANAGED_CLAUDE_RUNTIME, pid: 111 }
  });
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /fingerprint changed before execution/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("approval prompt disappearance after authorization fails closed with zero keys", async () => {
  const adapter = createTestClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const fingerprint = (await bridge.status("claude", control))
    .approval_state.fingerprint;
  assert.ok(fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    authorize() {
      provider.setScreen(PANE.target, "idle after prompt disappeared");
      return { approved: true };
    }
  });
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /no longer approvable after authorization/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("v15 whole-screen approval fingerprint is stale under v16 prompt-scoped authority", async () => {
  const adapter = createTestClaudeAdapter();
  const screen = "approval:npm test";
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: screen
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const inspection = adapter.inspectScreen({ screen });
  assert.equal(inspection.approval.approvable, true);
  const oldWholeScreenFingerprint = createHash("sha256")
    .update(JSON.stringify({
      agent: "claude",
      provider: "tmux",
      terminal: {
        target: PANE.target,
        socket_path: PANE.socketPath,
        session: PANE.session,
        window: PANE.window,
        pane: PANE.pane,
        pane_pid: PANE.panePid
      },
      runtime: {},
      keys: ["Down", "C-m"],
      label: "Allow once",
      prompt_kind: "test_permission",
      command: "npm test",
      raw_screen_sha256: createHash("sha256").update(screen).digest("hex"),
      decision_mode: "keys"
    }))
    .digest("hex");
  const freshFingerprint = (await bridge.status("claude", control))
    .approval_state.fingerprint;
  assert.ok(freshFingerprint);
  assert.notEqual(freshFingerprint, oldWholeScreenFingerprint);

  const stale = await bridge.approve("claude", control, {
    expectedFingerprint: oldWholeScreenFingerprint
  });
  assert.equal(stale.approved, false);
  assert.match(stale.reason ?? "", /fingerprint changed before execution/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );

  const fresh = await bridge.approve("claude", control, {
    expectedFingerprint: freshFingerprint
  });
  assert.equal(fresh.approved, true);
  assert.equal(
    provider.operations.filter((operation) => operation.kind === "keys").length,
    1
  );
});

test("key approval without adapter-owned prompt evidence fails closed with zero keys", async () => {
  const adapter: TerminalAgentAdapter<"test_claude_cli"> = {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return {
        activity: { state: "awaiting_approval", reason: "missing evidence" },
        approval: {
          blocked: true,
          approvable: true,
          promptKind: "test_permission",
          command: "npm test",
          action: { keys: ["C-m"], label: "Allow once" }
        },
        screenExcerpt: screen
      };
    }
  };
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval without an exact bounded region"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const status = await bridge.status("claude", control);
  assert.equal(status.approval_state.blocked, true);
  assert.equal(status.approval_state.approvable, false);
  assert.equal(status.approval_state.fingerprint, undefined);
  assert.match(
    status.approval_state.reason ?? "",
    /no adapter-verified prompt evidence/u
  );

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: "f".repeat(64)
  });
  assert.equal(result.approved, false);
  assert.match(result.reason ?? "", /no adapter-verified prompt evidence/u);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("approval accepts a fresh prompt-scoped fingerprint after endpoint discovery", async () => {
  const adapter = createTestClaudeAdapter();
  const screen = "approval:npm test";
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: screen
  });
  const control = terminalControl(adapter);
  const inspection = adapter.inspectScreen({ screen });
  const freshStoredControlFingerprint = terminalApprovalFingerprint(
    "claude",
    control,
    inspection,
    { screen }
  );
  assert.ok(freshStoredControlFingerprint);
  assert.match(freshStoredControlFingerprint, /^[0-9a-f]{64}$/u);

  const approval = await createBridge(adapter, provider).approve(
    "claude",
    control,
    { expectedFingerprint: freshStoredControlFingerprint }
  );

  assert.equal(approval.approved, true);
  assert.equal(approval.fingerprint, freshStoredControlFingerprint);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    [{
      kind: "keys",
      target: PANE.target,
      keys: ["Down", "C-m"],
      socketPath: PANE.socketPath
    }]
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
    /terminal control identity changed/u
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
          promptEvidence: terminalApprovalPromptEvidence(
            "test-approval-prompt-v1",
            screen
          ),
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
          promptEvidence: terminalApprovalPromptEvidence(
            "test-approval-prompt-v1",
            screen
          ),
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
    "0.149.1",
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

test("verified and unverified Claude versions use the closed stable composer and modal dismissal", async () => {
  for (const version of ["2.1.226", "2.1.237", "2.1.238"]) {
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
  for (const version of ["2.1.226", "2.1.237", "2.1.238"]) {
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

test("Claude 2.1.237 native status rejects a non-prefix truncated popup", async () => {
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
      claudeStatusInspectionPlan("2.1.237"),
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

test("Codex 0.147.0 through 0.149.1 require their exact ordered two-row slash popup", async () => {
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
  for (const version of ["0.147.0", "0.148.0", "0.149.1"]) {
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

test("Codex 0.149.1 native status refuses an incomplete two-row popup", async () => {
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
      codexStatusInspectionPlan("0.149.1"),
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

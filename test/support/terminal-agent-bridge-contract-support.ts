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
} from "../../src/terminal-agent-adapter.js";
import {
  createClaudeTerminalAgentAdapter,
  planClaudeNativeInspection,
  probeClaudeNativeInspection
} from "../../src/claude-terminal-agent-adapter.js";
import {
  codexTerminalAgentAdapter,
  planCodexNativeInspection,
  probeCodexNativeInspection
} from "../../src/codex-terminal-agent-adapter.js";
import {
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  inspectCodexAsyncQuestionInputMode,
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  terminalApprovalFingerprint
} from "../../src/terminal-agent-bridge.js";
import {
  terminalRefFromPane,
  StaticTerminalControlProvider,
  TerminalControlInputNotSentError,
  type TerminalControlProvider,
  type TerminalPane
} from "../../src/terminal-control-provider.js";
import type {
  TerminalControlRef,
  TerminalEndpointRef,
  TerminalProviderCapability
} from "../../src/terminal-control-ref.js";
import {
  planTerminalModelControl,
  probeTerminalModelControl
} from "../../src/terminal-model-control.js";

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
        choices: [{
          decision: "approve_once",
          keys: ["Down", "C-m"],
          label: "Allow once"
        }, {
          decision: "reject",
          keys: ["n"],
          label: "Reject once"
        }],
        action: {
          decision: "approve_once",
          keys: ["Down", "C-m"],
          label: "Allow once"
        }
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
    ...(["2.1.251", "2.1.259", "2.1.263", "2.1.266", "2.1.267"].includes(version)
      ? ["  Peer address:        unix:///private/tmp/claude.sock"]
      : []),
    "  cwd:                 /repo",
    "  Auth token:          ANTHROPIC_AUTH_TOKEN",
    "",
    "  Model:               claude-sonnet",
    "  MCP servers:         all connected",
    "  Setting sources:     User settings",
    ...(["2.1.251", "2.1.259", "2.1.263", "2.1.266", "2.1.267"].includes(version)
      ? ["  Managed settings (remote): connected"]
      : []),
    ...(["2.1.263", "2.1.266", "2.1.267"].includes(version)
      ? ["  Organization policy: failed to load through proxy"]
      : []),
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


export {
  test,
  assert,
  createHash,
  createTerminalAgentAdapterRegistry,
  terminalApprovalPromptEvidence,
  createClaudeTerminalAgentAdapter,
  planClaudeNativeInspection,
  probeClaudeNativeInspection,
  codexTerminalAgentAdapter,
  planCodexNativeInspection,
  probeCodexNativeInspection,
  isExactClaudeIdleComposer,
  isExactClaudeNativeInspectionIdleComposer,
  inspectCodexAsyncQuestionInputMode,
  NativeInspectionDismissalError,
  NativeInspectionSubmissionError,
  TerminalAgentBridge,
  TerminalEnterDispatchNotAttemptedError,
  TerminalEnterDispatchReservedError,
  TerminalInputNotStartedError,
  terminalApprovalFingerprint,
  terminalRefFromPane,
  StaticTerminalControlProvider,
  TerminalControlInputNotSentError,
  planTerminalModelControl,
  probeTerminalModelControl,
  PANE,
  MANAGED_CLAUDE_RUNTIME,
  FULL_CAPABILITIES,
  RecordingTerminalProvider,
  CapabilityLimitedTerminalProvider,
  providerTarget,
  TimelineTerminalProvider,
  SequencedResolutionProvider,
  endpointForPane,
  stablePane,
  createTestClaudeAdapter,
  inspectTestClaudeScreen,
  createBridge,
  terminalControl,
  codexStatusInspectionPlan,
  codexPaddedStyledIdleScreen,
  claudeStatusInspectionPlan,
  claudeNativeComposerScreen,
  claudeNarrowNativeComposerScreen,
  claudeNativeStatusPanel,
  strictClaudeBashApprovalScreen,
  strictCodexCommandApprovalScreen,
  ambiguousCodexCommandApprovalScreen,
  ambiguousClaudeBashApprovalScreen,
  approvalScreenWithOutsideOutput
};
export type {
  ProviderOperation,
  TerminalAgentAdapter,
  TerminalAgentAdapterCapabilities,
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest,
  TerminalScreenInspection,
  TerminalControlProvider,
  TerminalPane,
  TerminalControlRef,
  TerminalEndpointRef,
  TerminalProviderCapability
};

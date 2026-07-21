import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalAgentAdapterRegistry,
  type TerminalAgentAdapter,
  type TerminalAgentAdapterCapabilities,
  type TerminalCompletionEvidence,
  type TerminalDurableCompletionRequest,
  type TerminalScreenInspection
} from "../src/terminal-agent-adapter.js";
import { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
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

  await bridge.send("claude", control, "run the focused tests\n");
  assert.deepEqual(provider.operations, [
    { kind: "capture", target: PANE.target, socketPath: PANE.socketPath },
    { kind: "text", target: PANE.target, text: "run the focused tests", socketPath: PANE.socketPath },
    { kind: "keys", target: PANE.target, keys: ["C-m"], socketPath: PANE.socketPath }
  ]);
});

test("bridge preserves ordered approval and cancellation key sequences", async () => {
  const adapter = createTestClaudeAdapter({ cancelKeys: ["Escape", "C-c"] });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "approval:npm test"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);

  const approval = await bridge.approve("claude", control);
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

  assert.throws(
    () => bridge.adapterFor("cursor"),
    /terminal agent adapter is not registered for cursor/
  );
  await assert.rejects(
    () => bridge.discoverProcesses([], ["cursor"]),
    /terminal agent adapter is not registered for cursor/
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

  await assert.rejects(
    () => bridge.send("cursor", control, "do work"),
    /terminal agent adapter is not registered for cursor/
  );
  await assert.rejects(
    () => bridge.send("claude", { ...control, capabilities: [] }, "do work"),
    /terminal input is not supported/
  );
  assert.deepEqual(provider.operations, []);
});

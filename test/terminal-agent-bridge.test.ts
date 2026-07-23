import test from "node:test";
import assert from "node:assert/strict";
import {
  createTerminalAgentAdapterRegistry,
  type TerminalAgentAdapter,
  type TerminalAgentAdapterCapabilities,
  type TerminalApprovalDecisionRequest,
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

function structuredApprovalInspection(
  screen: string,
  requestId = "permission-request-1"
): TerminalScreenInspection {
  return {
    activity: { state: "awaiting_approval", reason: "structured permission request" },
    approval: {
      blocked: true,
      approvable: true,
      promptKind: "tool_permission",
      command: "npm test",
      toolName: "Bash",
      requestDetail: "Workspace command",
      action: {
        mode: "structured",
        keys: [],
        label: "Allow once",
        requestId
      }
    },
    screenExcerpt: screen
  };
}

function createStructuredClaudeAdapter(options: {
  requestId?: () => string;
  inspectScreen?: (screen: string) => TerminalScreenInspection;
  resolveApproval?: (
    request: TerminalApprovalDecisionRequest
  ) => Promise<{ resolved: boolean; requestId?: string; reason?: string }>;
} = {}): TerminalAgentAdapter<"test_claude_cli"> {
  return {
    ...createTestClaudeAdapter(),
    inspectScreen({ screen }) {
      return options.inspectScreen?.(screen) ?? structuredApprovalInspection(
        screen,
        options.requestId?.() ?? "permission-request-1"
      );
    },
    async resolveApproval(request) {
      return options.resolveApproval?.(request) ?? {
        resolved: true,
        requestId: request.inspection.approval.approvable
          ? request.inspection.approval.action.requestId
          : undefined
      };
    }
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

test("bridge gates semantic actions on the capabilities stored with the terminal reference", async () => {
  let inspectionCalls = 0;
  let resolverCalls = 0;
  let durableCalls = 0;
  const baseAdapter = createStructuredClaudeAdapter({
    async resolveApproval() {
      resolverCalls += 1;
      return { resolved: true, requestId: "permission-request-1" };
    }
  });
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
    [PANE.target]: "structured permission"
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
  assert.equal(resolverCalls, 0);
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

  const result = await bridge.approve("claude", control, {
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
    2
  );
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("structured approval status exposes decision mode and request identity", async () => {
  const adapter = createStructuredClaudeAdapter();
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "structured permission"
  });

  const status = await createBridge(adapter, provider).status(
    "claude",
    terminalControl(adapter)
  );

  assert.equal(status.activity_state, "awaiting_approval");
  assert.equal(status.approval_state.approvable, true);
  assert.equal(status.approval_state.decision_mode, "structured");
  assert.equal(status.approval_state.request_id, "permission-request-1");
  assert.equal(status.approval_state.tool_name, "Bash");
  assert.equal(status.approval_state.request_detail, "Workspace command");
  assert.equal(status.approval_state.keys?.length, 0);
  assert.ok(status.approval_state.fingerprint);
  assert.equal(status.screen.approval?.decisionMode, "structured");
  assert.equal(status.screen.approval?.requestId, "permission-request-1");
  assert.equal(status.screen.approval?.toolName, "Bash");
  assert.equal(status.screen.approval?.requestDetail, "Workspace command");
});

test("structured approval requires an exact expected fingerprint before resolving", async () => {
  const resolverCalls: TerminalApprovalDecisionRequest[] = [];
  const adapter = createStructuredClaudeAdapter({
    async resolveApproval(request) {
      resolverCalls.push(request);
      return { resolved: true, requestId: "permission-request-1" };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "structured permission"
  });

  const result = await createBridge(adapter, provider).approve(
    "claude",
    terminalControl(adapter)
  );

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.decisionMode, "structured");
  assert.equal(result.requestId, "permission-request-1");
  assert.match(result.reason ?? "", /requires the latest expected fingerprint/);
  assert.equal(resolverCalls.length, 0);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("structured approval with the exact fingerprint calls the resolver without sending keys", async () => {
  const resolverCalls: TerminalApprovalDecisionRequest[] = [];
  const adapter = createStructuredClaudeAdapter({
    async resolveApproval(request) {
      resolverCalls.push(request);
      return { resolved: true, requestId: "permission-request-1" };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "structured permission"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const runtime = {
    pid: 110,
    sessionId: "claude-session-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    terminalTarget: PANE.target
  };
  const fingerprint = (await bridge.status("claude", control, { runtime }))
    .approval_state.fingerprint;
  assert.ok(fingerprint);

  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprint,
    requiredDecisionMode: "structured",
    runtime
  });

  assert.equal(result.approved, true);
  assert.equal(result.blocked, false);
  assert.equal(result.decisionMode, "structured");
  assert.equal(result.requestId, "permission-request-1");
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].decision, "allow");
  assert.equal(resolverCalls[0].expectedFingerprint, fingerprint);
  assert.equal(resolverCalls[0].actualFingerprint, fingerprint);
  assert.deepEqual(resolverCalls[0].runtime, runtime);
  assert.equal(resolverCalls[0].interrupt, undefined);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("structured approval rejects a changed request fingerprint without resolving or sending keys", async () => {
  let requestId = "permission-request-A";
  const resolverCalls: TerminalApprovalDecisionRequest[] = [];
  const adapter = createStructuredClaudeAdapter({
    requestId: () => requestId,
    async resolveApproval(request) {
      resolverCalls.push(request);
      return { resolved: true, requestId };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "unchanged terminal screen"
  });
  const bridge = createBridge(adapter, provider);
  const control = terminalControl(adapter);
  const fingerprintA = (await bridge.status("claude", control)).approval_state.fingerprint;
  assert.ok(fingerprintA);

  requestId = "permission-request-B";
  const result = await bridge.approve("claude", control, {
    expectedFingerprint: fingerprintA,
    requiredDecisionMode: "structured"
  });

  assert.equal(result.approved, false);
  assert.equal(result.blocked, true);
  assert.equal(result.requestId, "permission-request-B");
  assert.match(result.reason ?? "", /fingerprint changed/);
  assert.notEqual(result.fingerprint, fingerprintA);
  assert.equal(resolverCalls.length, 0);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("cancel denies a structured approval with interrupt and never sends Escape", async () => {
  const resolverCalls: TerminalApprovalDecisionRequest[] = [];
  const adapter = createStructuredClaudeAdapter({
    async resolveApproval(request) {
      resolverCalls.push(request);
      return { resolved: true, requestId: "permission-request-1" };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "structured permission"
  });
  const runtime = {
    pid: 110,
    sessionId: "claude-session-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    terminalTarget: PANE.target
  };

  const result = await createBridge(adapter, provider).cancel(
    "claude",
    terminalControl(adapter),
    { runtime }
  );

  assert.equal(result.cancelRequested, true);
  assert.equal(result.deniedApproval, true);
  assert.equal(result.requestId, "permission-request-1");
  assert.equal(resolverCalls.length, 1);
  assert.equal(resolverCalls[0].decision, "deny");
  assert.equal(resolverCalls[0].interrupt, true);
  assert.equal(resolverCalls[0].expectedFingerprint, resolverCalls[0].actualFingerprint);
  assert.deepEqual(resolverCalls[0].runtime, runtime);
  assert.deepEqual(
    provider.operations.filter((operation) => operation.kind === "keys"),
    []
  );
});

test("cancel fails closed for an ambiguous non-approvable prompt without sending keys", async () => {
  let resolverCalls = 0;
  const adapter = createStructuredClaudeAdapter({
    inspectScreen(screen) {
      return {
        activity: { state: "awaiting_approval", reason: "ambiguous permission state" },
        approval: {
          blocked: true,
          approvable: false,
          reason: "multiple pending permission requests are ambiguous"
        },
        screenExcerpt: screen
      };
    },
    async resolveApproval() {
      resolverCalls += 1;
      return { resolved: true };
    }
  });
  const provider = new RecordingTerminalProvider([PANE], {
    [PANE.target]: "ambiguous permission"
  });

  const result = await createBridge(adapter, provider).cancel(
    "claude",
    terminalControl(adapter)
  );

  assert.equal(result.cancelRequested, false);
  assert.match(result.reason ?? "", /ambiguous/);
  assert.equal(resolverCalls, 0);
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

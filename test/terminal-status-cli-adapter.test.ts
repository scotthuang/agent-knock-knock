import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { CodingAgentSessionProvider } from
  "../src/agent-session-provider.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createConversation,
  type Conversation
} from "../src/protocol.js";
import {
  createTerminalStatusCliFacade,
  type TerminalStatusCliDependencies
} from "../src/terminal-status-cli-adapter.js";
import * as terminalStatusCliAdapter from
  "../src/terminal-status-cli-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalBridgeStatus
} from "../src/terminal-agent-bridge.js";
import {
  appendEvent,
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";

const NOW = new Date("2026-08-20T01:02:03.004Z");

function conversation(name: string): Conversation {
  return createConversation({
    userRequest: `request ${name}`,
    sessionId: `session-${name}`,
    turnId: `turn-${name}`,
    executorKind: "codex",
    executorSession: `codex-${name}`,
    workspace: "/workspace/project",
    now: NOW
  });
}

function provider(overrides: Partial<CodingAgentSessionProvider> = {}):
  CodingAgentSessionProvider {
  return {
    agent: "codex",
    getCapabilities: async () => ({
      historicalSessions: "full",
      forkContext: "full",
      activeSessions: "process_scan",
      takeover: "plan_only",
      reasons: []
    }),
    listHistoricalSessions: async () => [],
    listActiveSessions: async () => [],
    resolveActiveSessionIdentityForPid: async () => undefined,
    getSession: async () => undefined,
    getForkContext: async () => undefined,
    ...overrides
  };
}

function terminalStatus(): TerminalBridgeStatus {
  return {
    provider: "tmux",
    target: "status:0.0",
    agent: "codex",
    reachable: true,
    capabilities: {} as TerminalBridgeStatus["capabilities"],
    activity_state: "idle",
    activity_reason: "input prompt",
    approval_state: {
      scanned: true,
      blocked: false,
      approvable: false,
      reason: "no approval"
    },
    screen: { excerpt: "ready" }
  };
}

function resolvedTerminal(): ResolvedTerminalConversation {
  return {
    conversationId: "terminal:v2:tmux:codex:status:0.0:73001",
    agent: "codex",
    pid: 73001,
    legacy: false,
    adapter: {} as ResolvedTerminalConversation["adapter"],
    terminalControl: {
      kind: "tmux",
      target: "status:0.0",
      currentPath: "/workspace/project",
      panePid: 73001
    } as ResolvedTerminalConversation["terminalControl"]
  };
}

function dependencies(input: {
  marker: string;
  events: string[];
  storeDir: string;
  loaded?: Conversation;
  terminal?: ResolvedTerminalConversation;
  codexProvider?: CodingAgentSessionProvider;
  activeProcesses?: Awaited<ReturnType<
    CodingAgentSessionProvider["listActiveSessions"]>>;
  monitorResult?: Awaited<ReturnType<
    TerminalStatusCliDependencies["reconciliation"]["reconcileMonitors"]>>;
  acquireStateLock?: TerminalStatusCliDependencies["reconciliation"]["acquireStateLock"];
  terminalBridgeEnabled?: TerminalStatusCliDependencies["reconciliation"]["terminalBridgeEnabled"];
  terminalControlFromTakeover?: TerminalStatusCliDependencies["selection"]["terminalControlFromTakeover"];
  terminalAdapter?: TerminalStatusCliDependencies["observation"]["terminalAdapter"];
  bridgeStatus?: TerminalBridgeStatus;
}): TerminalStatusCliDependencies {
  const loaded = input.loaded ?? conversation(input.marker);
  const statePath = path.join(input.storeDir, `${input.marker}.state.json`);
  const logPath = path.join(input.storeDir, `${input.marker}.ndjson`);
  return {
    selection: {
      statusStoreSelection() {
        input.events.push(`${input.marker}:store-selection`);
        return { storeDir: input.storeDir };
      },
      async resolveTerminalConversation() {
        input.events.push(`${input.marker}:resolve-terminal`);
        return input.terminal;
      },
      assertExpectedTerminalSelector() {
        input.events.push(`${input.marker}:selector`);
      },
      loadConversation() {
        input.events.push(`${input.marker}:load-conversation`);
        return { conversation: loaded, statePath, logPath };
      },
      terminalControlFromTakeover:
        input.terminalControlFromTakeover ?? (() => undefined),
      terminalRuntimeIdentity: () => ({})
    },
    observation: {
      readEvents() {
        input.events.push(`${input.marker}:read-events`);
        return [{
          event: "message",
          ts: NOW.toISOString(),
          from: "codex",
          to: "openclaw",
          type: "progress",
          round: 1,
          body: `progress ${input.marker}`
        }];
      },
      createCodexProvider() {
        input.events.push(`${input.marker}:provider`);
        return input.codexProvider ?? provider();
      },
      async listActiveCodexSessions() {
        input.events.push(`${input.marker}:active-sessions`);
        return input.activeProcesses ?? [];
      },
      createTerminalBridge() {
        return {
          async status(_agent, _control, request) {
            input.events.push(
              `${input.marker}:terminal-status:${request?.scrollbackLines}`);
            return input.bridgeStatus ?? terminalStatus();
          }
        };
      },
      terminalAdapter:
        input.terminalAdapter ?? (() => ({ displayName: "Codex" }))
    },
    reconciliation: {
      async reconcileMonitors(_options, request) {
        input.events.push(`${input.marker}:monitors:${request.reason}`);
        return input.monitorResult ?? {
          checked: 0,
          launched: 0,
          repaired: 0,
          collateral_stalls_checked: 0,
          collateral_stalls_skipped: 0,
          already_running: 0,
          skipped: 0,
          errors: 0,
          items: []
        };
      },
      isFinalDeferredTransferStatus: (status) =>
        status === "resolved" || status === "abort_resolved",
      workspaceMatches: (configured, observed) =>
        configured === undefined || configured === observed,
      acquireStateLock: input.acquireStateLock ?? (() => () => undefined),
      terminalBridgeEnabled: input.terminalBridgeEnabled ?? (() => false)
    },
    projection: {
      callbackRetryDisposition: () => ({ state: "unavailable" }),
      textSummary: (value) => ({ preview: String(value) })
    }
  };
}

async function runStatus(
  facade: ReturnType<typeof createTerminalStatusCliFacade>,
  options: Record<string, unknown>,
  logs: string[] = []
) {
  return runCliCommandExecution("status", options, {
    now: () => NOW,
    runtimeLog: (_level, event) => logs.push(event)
  }, () => facade.runStatus(options));
}

test("status facade exports only its factory and isolates read-only executions", async (t) => {
  assert.deepEqual(
    Object.keys(terminalStatusCliAdapter).sort(),
    ["createTerminalStatusCliFacade"]
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-facade-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: string[] = [];
  const storeA = path.join(root, "store-a");
  const storeB = path.join(root, "store-b");
  const facadeA = createTerminalStatusCliFacade(dependencies({
    marker: "A", events, storeDir: storeA
  }));
  const facadeB = createTerminalStatusCliFacade(dependencies({
    marker: "B", events, storeDir: storeB
  }));

  const [resultA, resultB] = await Promise.all([
    runStatus(facadeA, {}),
    runStatus(facadeB, {})
  ]);
  const outputA = JSON.parse(resultA.stdout);
  const outputB = JSON.parse(resultB.stdout);
  assert.equal(outputA.conversation.conversation_id, "turn-A");
  assert.equal(outputB.conversation.conversation_id, "turn-B");
  assert.deepEqual(Object.keys(outputA), [
    "conversation", "store", "reconciliation", "summary", "confidence",
    "about", "limitations", "state_path", "event_log_path", "budget",
    "recent_events"
  ]);
  assert.deepEqual(events.filter((event) => event.includes("monitors")), []);
  assert.equal(fs.existsSync(storeA), false);
  assert.equal(fs.existsSync(storeB), false);
});

test("managed status prints before a no-control microtask mutates its Turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-sync-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loaded = conversation("sync");
  const sequence: string[] = [];
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "S",
    events: [],
    storeDir: path.join(root, "store"),
    loaded,
    terminalControlFromTakeover() {
      queueMicrotask(() => {
        loaded.user_request = "microtask mutation";
        sequence.push("microtask");
      });
      return undefined;
    }
  }));
  const result = await runStatus(facade, {}, sequence);

  assert.equal(JSON.parse(result.stdout).conversation.user_request, "request sync");
  assert.doesNotMatch(result.stdout, /microtask mutation/u);
  assert.ok(sequence.indexOf("task_status_read") < sequence.indexOf("microtask"));
  assert.equal(loaded.user_request, "microtask mutation");
});

test("managed status prints the first screen before its getter microtask", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-screen-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loaded: Conversation = {
    ...conversation("screen"),
    native_session_takeover: {}
  };
  const status = terminalStatus();
  let visibleScreen = { excerpt: "parent-exact screen" };
  let mutationCount = 0;
  Object.defineProperty(status, "screen", {
    configurable: true,
    enumerable: true,
    get() {
      queueMicrotask(() => {
        visibleScreen = { excerpt: "microtask screen" };
        mutationCount += 1;
      });
      return visibleScreen;
    }
  });
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "G",
    events: [],
    storeDir: path.join(root, "store"),
    loaded,
    bridgeStatus: status,
    terminalControlFromTakeover: () => resolvedTerminal().terminalControl
  }));
  const result = await runStatus(facade, {});
  const output = JSON.parse(result.stdout);

  assert.equal(output.terminal_status.screen.excerpt, "parent-exact screen");
  assert.equal(output.terminal_screen.excerpt, "parent-exact screen");
  assert.doesNotMatch(result.stdout, /microtask screen/u);
  assert.ok(mutationCount > 0);
});

test("terminal status preserves selector, JSON, and newest-cwd history order", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: string[] = [];
  const forkRequests: string[] = [];
  const codexProvider = provider({
    listHistoricalSessions: async () => [
      {
        id: "older", cwd: "/workspace/project", archived: false,
        capability: "full", updatedAtMs: 10
      },
      {
        id: "newer", cwd: "/workspace/project", archived: false,
        capability: "full", updatedAtMs: 20
      }
    ],
    getForkContext: async (options) => {
      forkRequests.push([
        options.sessionId,
        options.maxMessages,
        options.maxCommands,
        options.maxTextLength
      ].join(":"));
      return {
        source: {
          agent: "codex",
          sessionId: options.sessionId,
          cwd: "/workspace/project",
          title: "status work"
        },
        messages: [
          { role: "user", text: "<environment_context>hidden</environment_context>" },
          { role: "user", text: "finish status facade" },
          { role: "assistant", text: "working" }
        ],
        commands: [{ command: "npm test" }],
        turns: [],
        truncated: false
      };
    }
  });
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "T",
    events,
    storeDir: path.join(root, "store"),
    terminal: resolvedTerminal(),
    codexProvider,
    activeProcesses: [{
      agent: "codex",
      kind: "codex_cli",
      pid: 73001,
      ppid: 1,
      command: "codex",
      cwd: "/workspace/project",
      confidence: "medium",
      reason: "test fixture"
    }]
  }));
  const result = await runStatus(facade, {});
  const output = JSON.parse(result.stdout);

  assert.deepEqual(events.slice(0, 6), [
    "T:store-selection",
    "T:resolve-terminal",
    "T:selector",
    "T:terminal-status:120",
    "T:provider",
    "T:active-sessions"
  ]);
  assert.equal(forkRequests[0], "newer:16:10:1200");
  assert.match(output.about, /finish status facade/u);
  assert.equal(output.confidence, "low");
  assert.deepEqual(Object.keys(output), [
    "conversation_id", "source", "agent", "store", "reconciliation",
    "confidence", "about", "limitations", "terminal_control",
    "terminal_status", "terminal_screen"
  ]);
});

test("non-Codex context preserves registry and reachable getter priority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-claude-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const trace: string[] = [];
  const displayError = new Error("display getter failed");
  const status: TerminalBridgeStatus = {
    ...terminalStatus(),
    agent: "claude"
  };
  Object.defineProperty(status, "reachable", {
    configurable: true,
    enumerable: true,
    get() {
      trace.push("reachable");
      return true;
    }
  });
  const terminal: ResolvedTerminalConversation = {
    ...resolvedTerminal(),
    conversationId: "terminal:v2:tmux:claude:status:0.0:73001",
    agent: "claude"
  };
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "C",
    events: [],
    storeDir: path.join(root, "store"),
    terminal,
    bridgeStatus: status,
    terminalAdapter() {
      trace.push("registry.require");
      return {
        get displayName(): string {
          trace.push("displayName");
          throw displayError;
        }
      };
    }
  }));

  await assert.rejects(runStatus(facade, {}), (error) => error === displayError);
  assert.deepEqual(trace, [
    "registry.require", "reachable", "reachable", "displayName"
  ]);
});

test("explicit reconciliation aggregates monitor and disabled-idle facts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-reconcile-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events: string[] = [];
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "R",
    events,
    storeDir: path.join(root, "store"),
    monitorResult: {
      checked: 4,
      launched: 2,
      repaired: 3,
      collateral_stalls_checked: 5,
      collateral_stalls_skipped: 1,
      already_running: 6,
      skipped: 7,
      errors: 8,
      items: [
        { status: "repaired", conversation_id: "turn-repaired" },
        { status: "skipped" }
      ]
    }
  }));
  const result = await runStatus(facade, {
    reconcile: true,
    idleTimeoutMinutes: 0
  });
  const reconciliation = JSON.parse(result.stdout).reconciliation;
  assert.deepEqual(reconciliation, {
    status: "completed",
    checked: 4,
    changed: 5,
    closed: 0,
    repaired: 3,
    collateral_stalls_checked: 5,
    collateral_stalls_skipped: 1,
    collateral_stall_repairs: [
      { status: "repaired", conversation_id: "turn-repaired" }
    ],
    monitors_launched: 2,
    monitors_already_running: 6,
    skipped: 7,
    errors: 8,
    idle_timeout_minutes: 0
  });
  assert.ok(events.includes("R:monitors:status_reconciliation"));
});

test("idle reconciliation reloads under lock, persists then logs, and releases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-idle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  const created = conversation("idle");
  const paths = pathsForConversation(created.conversation_id, storeDir);
  const idle: Conversation = {
    ...created,
    status: "idle",
    idle_since: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir
  };
  saveState(paths.statePath, idle);
  appendEvent(paths.logPath, {
    event: "conversation_created",
    ts: idle.created_at,
    conversation_id: idle.conversation_id
  });
  const events: string[] = [];
  const logs: string[] = [];
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "I",
    events,
    storeDir,
    acquireStateLock(statePath) {
      events.push(`lock:${path.basename(statePath)}`);
      return () => {
        events.push(`release:${path.basename(statePath)}`);
      };
    }
  }));
  let reconciliation;
  await runCliCommandExecution("status", {}, {
    now: () => NOW,
    runtimeLog: (_level, event) => logs.push(event)
  }, async () => {
    reconciliation = facade.reconcileIdleConversations(
      storeDir, { idleTimeoutMinutes: 1 }, NOW);
  });

  assert.deepEqual(reconciliation, {
    checked: 1,
    closed: 1,
    skipped: 0,
    idle_timeout_minutes: 1
  });
  assert.deepEqual(events, ["lock:state.json", "release:state.json"]);
  assert.equal(loadState(paths.statePath).status, "closed");
  assert.ok(logs.includes("idle_conversation_closed"));
});

test("idle log evaluates unsupported executor fields before conversation id", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-log-order-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  const created = conversation("log-order");
  const paths = pathsForConversation(created.conversation_id, storeDir);
  const idle: Conversation = {
    ...created,
    status: "idle",
    idle_since: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir
  };
  saveState(paths.statePath, idle);
  const trace: string[] = [];
  const conversationIdError = new Error("conversation id getter failed");
  const unsupportedExecutor = {
    get kind() {
      trace.push("kind");
      return "unsupported-agent";
    },
    get session() {
      trace.push("session");
      return "unsupported-session";
    }
  };
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "O",
    events: [],
    storeDir,
    acquireStateLock: () => () => trace.push("release"),
    terminalBridgeEnabled(conversation) {
      const conversationId = conversation.conversation_id;
      const executor = conversation.executor;
      let conversationIdReads = 0;
      let executorReads = 0;
      let logPhase = false;
      Object.defineProperty(conversation, "conversation_id", {
        configurable: true,
        enumerable: true,
        get() {
          conversationIdReads += 1;
          if (conversationIdReads === 2) {
            trace.length = 0;
            executorReads = 0;
            logPhase = true;
          } else if (conversationIdReads === 3) {
            trace.push("conversation_id");
            throw conversationIdError;
          }
          return conversationId;
        }
      });
      Object.defineProperty(conversation, "executor", {
        configurable: true,
        enumerable: true,
        get() {
          if (!logPhase) {
            return executor;
          }
          executorReads += 1;
          trace.push(`executor:${executorReads}`);
          return executorReads === 1 ? undefined : unsupportedExecutor;
        }
      });
      return false;
    }
  }));

  assert.throws(
    () => facade.reconcileIdleConversations(
      storeDir, { idleTimeoutMinutes: 1 }, NOW),
    (error) => error === conversationIdError
  );
  assert.deepEqual(trace, [
    "executor:1", "executor:2", "executor:3", "kind", "session",
    "conversation_id", "release"
  ]);
  assert.equal(loadState(paths.statePath).status, "closed");
});

test("idle lock timeout skips without loading or mutating the fresh Turn", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  const created = conversation("locked");
  const paths = pathsForConversation(created.conversation_id, storeDir);
  const idle: Conversation = {
    ...created,
    status: "idle",
    idle_since: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir
  };
  saveState(paths.statePath, idle);
  const facade = createTerminalStatusCliFacade(dependencies({
    marker: "L",
    events: [],
    storeDir,
    acquireStateLock() {
      throw { code: "LOCK_TIMEOUT" };
    }
  }));
  let reconciliation;
  await runCliCommandExecution("status", {}, {
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    reconciliation = facade.reconcileIdleConversations(
      storeDir, { idleTimeoutMinutes: 1 }, NOW);
  });
  assert.deepEqual(reconciliation, {
    checked: 1,
    closed: 0,
    skipped: 1,
    idle_timeout_minutes: 1
  });
  assert.equal(loadState(paths.statePath).status, "idle");
});

test("status facts stay data-only and public declarations contain no any", () => {
  const root = path.resolve(import.meta.dirname, "../..");
  const facts = fs.readFileSync(
    path.join(root, "src/terminal-status-facts.ts"), "utf8");
  const adapter = fs.readFileSync(
    path.join(root, "src/terminal-status-cli-adapter.ts"), "utf8");
  const declarations = fs.readFileSync(
    path.join(root, "dist/src/terminal-status-cli-adapter.d.ts"), "utf8");
  assert.doesNotMatch(facts, /node:(?:fs|path)|\.\/store\.js|\.\/session-store\.js/u);
  assert.doesNotMatch(facts, /Record<[^>]*\bany\b/u);
  assert.doesNotMatch(adapter, /Record<[^>]*\bany\b/u);
  assert.doesNotMatch(adapter, /ResolvedTerminalCapability/u);
  assert.doesNotMatch(declarations, /\bany\b/u);
  assert.doesNotMatch(declarations, /\bTerminalAgentBridge\b/u);
});

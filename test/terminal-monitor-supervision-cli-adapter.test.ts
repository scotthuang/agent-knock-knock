import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import {
  isBinaryExpression,
  isCaseClause,
  isCatchClause,
  isConditionalExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionLikeDeclaration,
  isIfStatement,
  isWhileStatement,
  type FunctionLikeDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast";

import type { Conversation } from "../src/protocol.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
import type { TerminalMonitorStateCliAdapter } from
  "../src/terminal-monitor-state-cli-adapter.js";
import {
  createTerminalMonitorSupervisionCliAdapter,
  type DetachedMonitorProcess,
  type TerminalMonitorSupervisionCliDependencies
} from "../src/terminal-monitor-supervision-cli-adapter.js";

const control = {
  kind: "tmux",
  target: "tmux:work:0.1",
  session: "work",
  window: 0,
  pane: 1,
  panePid: 71,
  capabilities: []
} as TerminalControlRef;

function conversation(
  status: Conversation["status"] = "waiting_for_agent",
  messageId = "message-1"
): Conversation {
  return {
    conversation_id: "turn-1",
    status,
    workspace: "/workspace",
    state_path: "/store/turn-1/state.json",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: messageId,
      terminal_bridge_inactivity_timeout_minutes: 61,
      terminal_bridge_hard_timeout_minutes: 721
    }
  } as unknown as Conversation;
}

function eligible(monitorLockVersion: unknown) {
  return {
    eligible: true,
    nativeTakeover: {
      terminal_bridge_monitor_lock_version: monitorLockVersion
    },
    terminalMessageId: "message-1",
    terminalControl: control,
    runtime: { pid: 71, cwd: "/workspace" },
    inactivityTimeoutMinutes: 61,
    hardTimeoutMinutes: 721,
    inactivityDeadlineAtMs: 1,
    hardDeadlineAtMs: 2
  } as const;
}

interface FixtureHooks {
  spawn?: TerminalMonitorSupervisionCliDependencies["io"]["spawn"];
  acquire?: TerminalMonitorSupervisionCliDependencies["io"]["locks"]["acquire"];
  exists?(filePath: string): boolean;
  stale?(filePath: string): boolean;
  owner?(filePath: string): { pid?: number };
  loadState?(statePath: string): Conversation;
  listConversations?(storeDir: string): Conversation[];
  readEvents?(logPath: string): Array<Record<string, unknown>>;
  isProcessAlive?(pid: number): boolean;
  reconcileState?: TerminalMonitorStateCliAdapter["reconcileState"];
  prepareLaunch?: TerminalMonitorStateCliAdapter["prepareLaunch"];
  eligibility?: TerminalMonitorStateCliAdapter["eligibility"];
  runService?: TerminalMonitorStateCliAdapter["runService"];
  migrateIdentity?(input: {
    conversation: Conversation;
    statePath: string;
    logPath: string;
    options: Record<string, unknown>;
  }): Promise<Conversation>;
  createBridge?(options: Record<string, unknown>): TerminalAgentBridge;
}

function fixture(hooks: FixtureHooks = {}) {
  const order: string[] = [];
  const events: Array<Record<string, unknown>> = [];
  const prints: Array<Record<string, unknown>> = [];
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const callbacks: Array<Record<string, unknown>> = [];
  const spawned: Array<{ executable: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  let nextPid = 80;
  const defaultSpawn: TerminalMonitorSupervisionCliDependencies["io"]["spawn"] =
    (executable, args, options): DetachedMonitorProcess => {
      order.push("spawn");
      spawned.push({ executable, args: [...args], env: options.env });
      const pid = nextPid++;
      return { pid, unref: () => order.push(`unref:${pid}`) };
    };
  const current = conversation();
  const state = {
    runService: hooks.runService ?? (async () => undefined),
    deferralPorts: () => ({
      state: { load: () => current, appendEvent: () => undefined },
      authority: {
        terminalControl: () => control,
        bindingSuperseded: () => undefined,
        storeOperationTimeout: () => undefined
      },
      runtime: {},
      presentation: {}
    }),
    reconcileCollateral: async () => ({
      checked: 0,
      repaired: 0,
      skipped: 0,
      errors: [],
      items: []
    }),
    statePaths: () => ({
      statePath: "/store/turn-1/state.json",
      logPath: "/store/turn-1/events.ndjson"
    }),
    reconcileState: hooks.reconcileState ?? (async () => ({ kind: "ignored" })),
    eligibility: hooks.eligibility ?? (() => ({
      eligible: false,
      reason: "test_ineligible"
    })),
    prepareLaunch: hooks.prepareLaunch ?? (() => ({
      prepared: false,
      alreadyRunning: false,
      reason: "test_unprepared"
    }))
  } as unknown as TerminalMonitorStateCliAdapter;
  const dependencies: TerminalMonitorSupervisionCliDependencies = {
    state,
    callbacks: {
      runRetryMonitor: (input) => { callbacks.push({ ...input }); }
    },
    authority: {
      migrateIdentity: hooks.migrateIdentity ?? (async (input) => {
        order.push("migrate");
        return input.conversation;
      }),
      createBridge: hooks.createBridge ?? (() => {
        order.push("bridge");
        return { marker: "bridge" } as unknown as TerminalAgentBridge;
      })
    },
    io: {
      spawn: hooks.spawn ?? defaultSpawn,
      locks: {
        acquire: hooks.acquire ?? (() => {
          order.push("acquire");
          return () => order.push("release");
        }),
        stale: hooks.stale ?? (() => false),
        owner: hooks.owner ?? (() => ({ pid: 41 }))
      },
      exists: hooks.exists ?? (() => false),
      loadState: hooks.loadState ?? (() => current),
      listConversations: hooks.listConversations ?? (() => []),
      readEvents: (logPath) =>
        (hooks.readEvents?.(logPath) ?? []) as never[],
      appendEvent: (_logPath, event) => events.push({ ...event }),
      logPathForStatePath: () => "/store/turn-1/events.ndjson"
    },
    runtime: {
      executablePath: () => "/node",
      entryPath: () => {
        order.push("entry");
        return "/dist/cli.js";
      },
      cwd: () => {
        order.push("cwd");
        return "/workspace";
      },
      environment: () => {
        order.push("env");
        return {
          PATH: "/bin",
          AKK_GATEWAY_TOKEN: "secret",
          OPENCLAW_GATEWAY_TOKEN: "secret"
        };
      },
      now: () => new Date("2026-08-20T00:00:00.000Z"),
      sleepSync: () => order.push("sleep"),
      isProcessAlive: hooks.isProcessAlive ?? (() => false),
      storeDir: () => "/store",
      workspaceMatches: () => true,
      bindingSuperseded: () => false,
      print: (value) => prints.push(value),
      log: (_level, event, fields) => logs.push({ event, fields })
    }
  };
  return {
    facade: createTerminalMonitorSupervisionCliAdapter(dependencies),
    order,
    events,
    prints,
    logs,
    callbacks,
    spawned
  };
}

test("factory-local launch and approval supervision preserve process ordering", () => {
  const first = fixture();
  const second = fixture();
  const request = {
    conversation: conversation(),
    statePath: "/store/turn-1/state.json",
    logPath: "/store/turn-1/events.ndjson",
    options: { monitorPollIntervalMs: 25 }
  };
  assert.equal(
    first.facade.startTerminalBridgeMonitorForConversation(request)?.pid,
    80
  );
  assert.equal(
    second.facade.startTerminalBridgeMonitorForConversation(request)?.pid,
    80,
    "parallel factories must not share process state"
  );
  assert.deepEqual(first.order, ["entry", "env", "cwd", "spawn", "unref:80"]);
  assert.equal(first.spawned[0]?.env.AKK_GATEWAY_TOKEN, undefined);
  assert.equal(first.spawned[0]?.env.OPENCLAW_GATEWAY_TOKEN, undefined);

  const reused = fixture({
    exists: () => true,
    stale: () => false,
    owner: () => ({ pid: 47 })
  });
  const approval = reused.facade.ensureTerminalBridgeMonitorAfterApproval({
    ...request,
    terminalControl: control
  });
  assert.equal(approval.activeMonitor?.ownerPid, 47);
  assert.equal(approval.launchedMonitor, undefined);
  assert.equal(approval.handoffWatchdog?.pid, 80);
  assert.deepEqual(
    reused.events.map((event) => event.event),
    [
      "terminal_bridge_monitor_reused",
      "terminal_bridge_monitor_handoff_watchdog_launch"
    ]
  );

  const failed = fixture({
    spawn: () => { throw new Error("spawn failed"); }
  });
  assert.throws(() => failed.facade.ensureTerminalBridgeMonitorAfterApproval({
    ...request,
    terminalControl: control
  }), /spawn failed/u);
  assert.equal(failed.events.length, 0, "failed spawn must not record launch");
});

test("reconciliation honors current then legacy ownership and fresh launch facts", async () => {
  const candidate = async () => ({
    kind: "candidate" as const,
    conversation: conversation(),
    eligibility: eligible(1)
  });
  const current = fixture({
    listConversations: () => [conversation()],
    reconcileState: candidate,
    readEvents: () => [{ event: "terminal_bridge_monitor_launch", pid: 31 }],
    exists: () => true,
    owner: () => ({ pid: 41 })
  });
  const currentResult = await current.facade.reconcileMonitors({}, {
    includeCallbackRecovery: false,
    reason: "test"
  });
  assert.equal(currentResult.already_running, 1);
  assert.equal(current.spawned.length, 0);

  const legacy = fixture({
    listConversations: () => [conversation()],
    reconcileState: async () => ({
      kind: "candidate",
      conversation: conversation(),
      eligibility: eligible(undefined)
    }),
    readEvents: () => [{ event: "terminal_bridge_monitor_launch", pid: 51 }],
    isProcessAlive: (pid) => pid === 51
  });
  const legacyResult = await legacy.facade.reconcileMonitors({}, {
    includeCallbackRecovery: false,
    reason: "test"
  });
  assert.equal(legacyResult.already_running, 1);
  assert.equal(legacyResult.items[0]?.reason, "legacy_monitor_launch_pid_alive");

  let prepareCalls = 0;
  const recoveredConversation = conversation("waiting_for_agent", "message-1");
  const recovery = fixture({
    listConversations: () => [conversation()],
    reconcileState: candidate,
    readEvents: () => [{ event: "terminal_bridge_monitor_launch", pid: 52 }],
    isProcessAlive: () => false,
    prepareLaunch: (input) => {
      prepareCalls += 1;
      assert.equal(input.activeOwner(input.statePath, input.expectedMessageId), undefined);
      return {
        prepared: true,
        conversation: recoveredConversation,
        terminalControl: control,
        inactivityTimeoutMinutes: 61,
        hardTimeoutMinutes: 721
      };
    }
  });
  const recoveryResult = await recovery.facade.reconcileMonitors({}, {
    includeCallbackRecovery: false,
    reason: "startup_reconciliation"
  });
  assert.equal(prepareCalls, 1);
  assert.equal(recoveryResult.launched, 1);
  assert.equal(recoveryResult.items[0]?.reason, "unexpected_exit_recovery");
  assert.deepEqual(
    recovery.events.map((event) => event.event),
    ["terminal_bridge_monitor_exit_observed", "terminal_bridge_monitor_launch"]
  );

  const failed = fixture({
    listConversations: () => [conversation()],
    reconcileState: candidate,
    prepareLaunch: () => ({
      prepared: true,
      conversation: conversation(),
      terminalControl: control,
      inactivityTimeoutMinutes: 61,
      hardTimeoutMinutes: 721
    }),
    spawn: () => { throw new Error("spawn failed"); }
  });
  const failedResult = await failed.facade.reconcileMonitors({}, {
    includeCallbackRecovery: false,
    reason: "test"
  });
  assert.equal(failedResult.errors, 1);
  assert.equal(failed.events.length, 0);
});

test("monitor routing retains singleton lock and lazy configuration boundaries", async () => {
  let configurationReads = 0;
  let bridgeCreates = 0;
  const ready = fixture({
    runService: async (input) => {
      assert.equal(bridgeCreates, 0);
      assert.deepEqual(input.configuration(), {
        pollIntervalMs: 50,
        timeoutMinutes: 63,
        hardTimeoutMinutes: 723
      });
      configurationReads += 1;
      assert.equal(input.terminalBridge(), input.terminalBridge());
      assert.equal(bridgeCreates, 1);
    },
    createBridge: () => {
      bridgeCreates += 1;
      return { marker: "bridge" } as unknown as TerminalAgentBridge;
    }
  });
  await ready.facade.runMonitor({
    terminalBridge: true,
    state: "/store/turn-1/state.json",
    pollIntervalMs: 20,
    agentTimeoutMinutes: 63,
    agentHardTimeoutMinutes: 723
  });
  assert.equal(configurationReads, 1);
  assert.deepEqual(ready.order, ["acquire", "migrate", "release"]);

  let timeoutReads = 0;
  let generationBridgeCreates = 0;
  const replaced = fixture({
    runService: async () => undefined,
    createBridge: () => {
      generationBridgeCreates += 1;
      return {} as TerminalAgentBridge;
    }
  });
  const replacedOptions: Record<string, unknown> = {
    terminalBridge: true,
    state: "/store/turn-1/state.json"
  };
  Object.defineProperty(replacedOptions, "agentHardTimeoutMinutes", {
    enumerable: true,
    get: () => { timeoutReads += 1; return 723; }
  });
  await replaced.facade.runMonitor(replacedOptions);
  assert.equal(timeoutReads, 0, "generation exit must precede timeout validation");
  assert.equal(generationBridgeCreates, 0, "bridge construction must stay lazy");

  const callback = fixture();
  await callback.facade.runMonitor({
    callbackRetry: true,
    state: "/store/turn-1/state.json",
    callbackRetryDelayMs: 17
  });
  assert.deepEqual(callback.callbacks, [{
    statePath: "/store/turn-1/state.json",
    initialDelayMs: 17
  }]);
  await callback.facade.runMonitor({
    callbackRetry: true,
    state: "/store/turn-1/state.json",
    callbackRetryDelayMs: 19,
    callbackOutboxLane: "notification"
  });
  assert.deepEqual(callback.callbacks[1], {
    statePath: "/store/turn-1/state.json",
    initialDelayMs: 19,
    callbackOutboxLane: "notification"
  });

  const notificationMonitor = callback.facade.startCallbackRetryMonitor({
    statePath: "/store/turn-1/state.json",
    delayMs: 23,
    callbackOutboxLane: "notification"
  });
  assert.equal(notificationMonitor.pid, 80);
  assert.deepEqual(callback.spawned[0]?.args, [
    "/dist/cli.js",
    "monitor",
    "--callback-retry",
    "--state",
    "/store/turn-1/state.json",
    "--callback-retry-delay-ms",
    "23",
    "--callback-outbox-lane",
    "notification"
  ]);
  await assert.rejects(
    callback.facade.runMonitor({
      callbackRetry: true,
      state: "/store/turn-1/state.json",
      callbackOutboxLane: "unknown"
    }),
    /--callback-outbox-lane must be lifecycle or notification/u
  );

  const locked = fixture({
    acquire: () => {
      throw Object.assign(new Error("busy"), { code: "LOCK_TIMEOUT" });
    },
    owner: () => ({ pid: 99 })
  });
  await locked.facade.runMonitor({
    terminalBridge: true,
    state: "/store/turn-1/state.json"
  });
  assert.equal(locked.prints[0]?.already_running, true);
  assert.equal(locked.prints[0]?.monitor_owner_pid, 99);
});

test("handoff watchdog reloads every generation and retries fresh owner state", async () => {
  const loads = [
    conversation("waiting_for_openclaw"),
    conversation("waiting_for_openclaw"),
    conversation(),
    conversation(),
    conversation()
  ];
  const exists = [true, false, false];
  let prepareCalls = 0;
  const handoff = fixture({
    loadState: () => {
      const next = loads.shift();
      assert.ok(next, "handoff must not reuse a cached generation");
      return next;
    },
    exists: () => exists.shift() ?? false,
    stale: () => false,
    owner: () => ({ pid: 44 }),
    eligibility: () => eligible(1),
    prepareLaunch: () => {
      prepareCalls += 1;
      if (prepareCalls === 1) {
        return {
          prepared: false,
          alreadyRunning: true,
          reason: "monitor_lock_owner_alive",
          ownerPid: 44
        };
      }
      return {
        prepared: true,
        conversation: conversation(),
        terminalControl: control,
        inactivityTimeoutMinutes: 61,
        hardTimeoutMinutes: 721
      };
    }
  });
  await handoff.facade.runMonitor({
    terminalBridgeHandoff: true,
    state: "/store/turn-1/state.json",
    expectedTerminalMessageId: "message-1",
    monitorHandoffPollIntervalMs: 50
  });
  assert.equal(loads.length, 0);
  assert.equal(prepareCalls, 2);
  assert.equal(handoff.order.filter((item) => item === "sleep").length, 3);
  assert.deepEqual(
    handoff.events.map((event) => event.event),
    [
      "terminal_bridge_monitor_handoff_watchdog_started",
      "terminal_bridge_monitor_launch"
    ]
  );
  assert.equal(handoff.prints.at(-1)?.launched, true);
});

function approximateComplexity(
  root: FunctionLikeDeclaration,
  sourceFile: SourceFile
): number {
  let value = 1;
  const visit = (node: Node): void => {
    if (node !== root && isFunctionLikeDeclaration(node)) return;
    if (
      isIfStatement(node) || isConditionalExpression(node) ||
      isCatchClause(node) || isForStatement(node) ||
      isForInStatement(node) || isForOfStatement(node) ||
      isWhileStatement(node) || isDoStatement(node) || isCaseClause(node)
    ) value += 1;
    if (
      isBinaryExpression(node) &&
      ["&&", "||", "??"].includes(node.operatorToken.getText(sourceFile))
    ) value += 1;
    node.forEachChild(visit);
  };
  root.body?.forEachChild(visit);
  return value;
}

test("compiled declaration and AST expose one bounded supervision factory", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const sourcePath = path.join(
    root,
    "src/terminal-monitor-supervision-cli-adapter.ts"
  );
  const declaration = fs.readFileSync(
    path.join(root, "dist/src/terminal-monitor-supervision-cli-adapter.d.ts"),
    "utf8"
  );
  assert.match(declaration, /createTerminalMonitorSupervisionCliAdapter/u);
  assert.match(declaration, /TerminalMonitorSupervisionCliFacade/u);
  assert.match(declaration, /activeTerminalBridgeMonitorOwner/u);
  assert.match(declaration, /startTerminalBridgeMonitorForConversation/u);
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.doesNotMatch(source, /\b(?:saveState|writeFileSync|JSON\.parse)\b/u);
  assert.match(source, /this\.#dependencies\.state\.reconcileState\(/u);
  assert.match(source, /this\.#dependencies\.callbacks\.runRetryMonitor\(/u);

  const api = new TypeScriptApi({ cwd: root });
  const configPath = path.join(root, "tsconfig.json");
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] })
      .getProject(configPath);
    assert.ok(project, "TypeScript project is available");
    const sourceFile = project.program.getSourceFile(sourcePath);
    assert.ok(sourceFile, "monitor supervision adapter AST is available");
    const metrics: Array<{ span: number; complexity: number }> = [];
    const visit = (node: Node): void => {
      if (isFunctionLikeDeclaration(node) && node.body) {
        const start = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        ).line;
        const end = sourceFile.getLineAndCharacterOfPosition(node.end).line;
        metrics.push({
          span: end - start + 1,
          complexity: approximateComplexity(node, sourceFile)
        });
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    assert.equal(Math.max(...metrics.map((entry) => entry.span)), 59);
    assert.equal(Math.max(...metrics.map((entry) => entry.complexity)), 8);
    assert.ok(metrics.every((entry) =>
      entry.span < 100 && entry.complexity < 20
    ));
  } finally {
    api.close();
  }
});

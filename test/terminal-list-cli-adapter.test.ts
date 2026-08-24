import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { createCodexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import { TerminalAgentAdapterRegistry } from
  "../src/terminal-agent-adapter.js";
import * as terminalListCliAdapter from "../src/terminal-list-cli-adapter.js";
import { createTerminalWatchCliAdapter } from
  "../src/terminal-watch-cli-adapter.js";
import { terminalWatchesDir } from "../src/terminal-watch-store.js";
import type {
  TerminalListAuthorityPorts,
  TerminalListCliDependencies,
  TerminalListDiscoveryPorts,
  TerminalListStoreObservationPorts
} from "../src/terminal-list-cli-adapter.js";

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
}

function deferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => release?.()
  };
}

function facadeDependencies(
  marker: "A" | "B",
  events: string[],
  monitorGate: DeferredGate,
  diagnosticsGate: DeferredGate
): TerminalListCliDependencies {
  const discovery = {
    createRuntimeTerminalAgentRegistry: () => ({
      get: () => undefined,
      list: () => []
    }),
    createTerminalControlProvider: () => ({
      diagnostics: async () => {
        events.push(`${marker}:diagnostics:before`);
        await diagnosticsGate.promise;
        events.push(`${marker}:diagnostics:after`);
        return {};
      }
    }),
    createTerminalAgentBridge: () => ({
      listProcesses: async () => []
    }),
    createTerminalProcessSource: () => {
      events.push(`${marker}:process-source`);
      return {
        listProcessSnapshots: async () => []
      };
    }
  } as unknown as TerminalListDiscoveryPorts;

  return {
    reconciliation: {
      reconcileMonitors: async () => {
        events.push(`${marker}:monitor:before`);
        await monitorGate.promise;
        events.push(`${marker}:monitor:after`);
        return {
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
      reconcileIdleConversations: () => {
        events.push(`${marker}:idle`);
        return {
          checked: 0,
          closed: 0,
          skipped: 0,
          idle_timeout_minutes: 60
        };
      }
    },
    discovery,
    store: {
      isDiscoverableTmuxConversation: () => true,
      storeDirFromOptions: (options: { storeDir?: string }) =>
        String(options.storeDir)
    } as unknown as TerminalListStoreObservationPorts,
    authority: {} as TerminalListAuthorityPorts,
    policy: {
      approvalTtlMs: 60_000,
      selectorCommands: new Set(["status", "send"]),
      rememberOriginalExpectedTerminalSelector: () => {
        events.push(`${marker}:selector`);
      }
    }
  };
}

test("terminal list facade isolates concurrent async runtimes and exports only its factory", async (t) => {
  assert.deepEqual(
    Object.keys(terminalListCliAdapter).sort(),
    ["createTerminalListCliFacade"]
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-facade-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storeA = path.join(tempDir, "store-a");
  const storeB = path.join(tempDir, "store-b");
  const events: string[] = [];
  const monitorA = deferredGate();
  const monitorB = deferredGate();
  const diagnosticsA = deferredGate();
  const diagnosticsB = deferredGate();
  t.after(() => {
    monitorA.release();
    monitorB.release();
    diagnosticsA.release();
    diagnosticsB.release();
  });
  diagnosticsA.release();
  monitorB.release();

  const facadeA = terminalListCliAdapter.createTerminalListCliFacade(
    facadeDependencies("A", events, monitorA, diagnosticsA)
  );
  const facadeB = terminalListCliAdapter.createTerminalListCliFacade(
    facadeDependencies("B", events, monitorB, diagnosticsB)
  );

  const listPromise = runCliCommandExecution(
    "list",
    {},
    { runtimeLog: () => undefined },
    () => facadeA.runList({
      storeDir: storeA,
      reconcile: true,
      managedOnly: true
    })
  );
  const selectorPromise = runCliCommandExecution(
    "status",
    {},
    { runtimeLog: () => undefined },
    async () => {
      await assert.rejects(
        facadeB.resolveConversationSelectorOption("status", {
          storeDir: storeB,
          turn: "only",
          terminalDebug: true
        }),
        /no actionable/iu
      );
    }
  );

  for (let attempt = 0; attempt < 10 && events.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.deepEqual(events, ["A:monitor:before", "B:diagnostics:before"]);
  diagnosticsB.release();
  await selectorPromise;
  monitorA.release();
  await listPromise;

  assert.deepEqual(events, [
    "A:monitor:before",
    "B:diagnostics:before",
    "B:diagnostics:after",
    "B:process-source",
    "A:monitor:after",
    "A:idle"
  ]);

  await facadeA.resolveConversationSelectorOption("status", {
    state: "already-resolved",
    expectedTerminalToken: "token-a"
  });
  await facadeB.resolveConversationSelectorOption("status", {
    state: "already-resolved",
    expectedTerminalToken: "token-b"
  });
  assert.deepEqual(events.slice(-2), ["A:selector", "B:selector"]);

  const retryOptions = { turn: "turn-exact-retry" };
  const beforeRetry = [...events];
  await facadeA.resolveConversationSelectorOption("send", retryOptions);
  assert.deepEqual(retryOptions, { turn: "turn-exact-retry" });
  assert.deepEqual(
    events,
    beforeRetry,
    "send --turn must bypass ordinary-send selector discovery"
  );
});

test("list promotes an exact unfinished Codex rollout over an idle-looking screen", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-durable-activity-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const pending = await listCodexRolloutState(root, "pending");
  assert.equal(pending.activity_state, "working");
  assert.match(
    String(pending.activity_reason),
    /exact unfinished human-started task/u
  );
  assert.ok(pending.available_actions.watch);
  for (const idleInputAction of ["send", "new_thread", "native_inspect"]) {
    assert.equal(
      pending.available_actions[idleInputAction],
      undefined,
      idleInputAction
    );
  }

  for (const settled of ["completed", "aborted"] as const) {
    const listed = await listCodexRolloutState(root, settled);
    assert.equal(listed.activity_state, "idle", settled);
    assert.equal(listed.available_actions.watch, undefined, settled);
    assert.ok(listed.available_actions.send, settled);
  }

  const unavailable = await listCodexRolloutState(root, "malformed");
  assert.equal(unavailable.activity_state, "unknown");
  assert.match(
    String(unavailable.activity_reason),
    /durable Codex activity evidence is unavailable/iu
  );
  for (const unsafeAction of ["send", "new_thread", "native_inspect", "watch"]) {
    assert.equal(
      unavailable.available_actions[unsafeAction],
      undefined,
      unsafeAction
    );
  }
  const partial = await listCodexRolloutState(root, "partial");
  assert.equal(partial.activity_state, "unknown");
  assert.equal(partial.available_actions.send, undefined);
  assert.equal(partial.available_actions.watch, undefined);

  const afterBrokenSibling = await listCodexRolloutState(
    root,
    "pending",
    true
  );
  assert.equal(afterBrokenSibling.id, "terminal:v2:tmux:codex:durable:0.0:4242");
  assert.equal(afterBrokenSibling.activity_state, "working");
});

test("list keeps a Codex task working and watchable beside a same-turn synthetic context row", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-list-durable-synthetic-context-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const rootUserRowOrder of [
    "synthetic-first",
    "human-first"
  ] as const) {
    const listed = await listCodexRolloutState(
      root,
      "pending",
      false,
      rootUserRowOrder
    );
    assert.equal(listed.activity_state, "working", rootUserRowOrder);
    assert.match(
      String(listed.activity_reason),
      /exact unfinished human-started task/u,
      rootUserRowOrder
    );
    assert.ok(listed.available_actions.watch, rootUserRowOrder);
    for (const idleInputAction of ["send", "new_thread", "native_inspect"]) {
      assert.equal(
        listed.available_actions[idleInputAction],
        undefined,
        `${rootUserRowOrder}:${idleInputAction}`
      );
    }
  }
});

test("exact terminal observation keeps native facts when a Watch record is corrupt", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-watch-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let watchFacade: ReturnType<typeof createTerminalWatchCliAdapter>;
  const fixture = await createCodexRolloutListFixture(
    root,
    "pending",
    false,
    {
      listTerminalWatches: (selectedStoreDir, options) =>
        watchFacade.listPublicWatches(selectedStoreDir, options),
      scanTerminalWatchesForExactObservation: (selectedStoreDir, options) =>
        watchFacade.scanPublicWatchesForExactObservation(
          selectedStoreDir,
          options
        )
    }
  );
  const callbacks: string[] = [];
  const printed: Array<Record<string, any>> = [];
  let now = new Date("2026-08-21T01:00:01.500Z");
  watchFacade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: (request) => fixture.facade.observeExactTerminal({
      options: request.options,
      terminalId: request.terminalId
    }),
    loadClaudeAgentRows: () => [],
    now: () => now,
    randomUUID: () => "00000000-0000-4000-8000-000000000777",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value as Record<string, any>),
    callback: {
      deliver(input) {
        callbacks.push(input.event);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  await watchFacade.runWatch({
    terminal: fixture.terminalId,
    openclawSession: "agent:main:main",
    storeDir: fixture.storeDir
  });

  const watchesDir = terminalWatchesDir(fixture.storeDir);
  fs.writeFileSync(
    path.join(watchesDir, "terminal-watch-corrupt.json"),
    "{not-json}\n",
    { mode: 0o600 }
  );
  assert.throws(
    () => watchFacade.listPublicWatches(fixture.storeDir),
    SyntaxError,
    "the public AKK list path remains strict"
  );

  const observation = await fixture.facade.observeExactTerminal({
    options: { storeDir: fixture.storeDir },
    terminalId: fixture.terminalId
  });
  assert.equal(observation.state, "available");
  if (observation.state !== "available") return;
  assert.equal(observation.rawTerminal.activity_state, "working");
  assert.equal(observation.terminal.activity_state, "working");
  assert.equal(
    observation.terminal.native_agent_session_id,
    "019f0000-0000-7000-8000-000000000777"
  );
  assert.equal(
    (observation.terminal.available_actions as Record<string, unknown>).watch,
    undefined,
    "an untrusted active-Watch overlay must suppress Watch authority"
  );
  assert.equal(observation.terminal.terminal_watch_hint, undefined);

  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: fixture.nativeTurnId,
        last_agent_message: "Healthy Watch survived corrupt sibling"
      }
    })}\n`
  );
  now = new Date("2026-08-21T01:00:03.000Z");
  await watchFacade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.deepEqual(callbacks, ["completed"]);
  const summary = printed.at(-1)!;
  assert.equal(summary.checked, 2);
  assert.equal(summary.errors, 1);
  assert.equal(
    summary.items.some((item: Record<string, unknown>) =>
      item.status === "completed"
    ),
    true
  );
});

async function listCodexRolloutState(
  root: string,
  outcome: "pending" | "completed" | "aborted" | "malformed" | "partial",
  includeBrokenSibling = false,
  rootUserRowOrder: "human-only" | "synthetic-first" | "human-first" =
    "human-only"
): Promise<Record<string, any>> {
  const fixture = await createCodexRolloutListFixture(
    root,
    outcome,
    includeBrokenSibling,
    {},
    rootUserRowOrder
  );
  if (includeBrokenSibling) {
    assert.match(
      String(fixture.scan.summary.error),
      /broken sibling identity probe/u
    );
  } else {
    assert.equal(
      fixture.scan.summary.error,
      undefined,
      String(fixture.scan.summary.error)
    );
  }
  assert.equal(fixture.scan.terminalControlled.length, 1);
  return fixture.scan.terminalControlled[0] as Record<string, any>;
}

async function createCodexRolloutListFixture(
  root: string,
  outcome: "pending" | "completed" | "aborted" | "malformed" | "partial",
  includeBrokenSibling = false,
  storeOverrides: Partial<TerminalListStoreObservationPorts> = {},
  rootUserRowOrder: "human-only" | "synthetic-first" | "human-first" =
    "human-only"
) {
  const nativeThreadId = "019f0000-0000-7000-8000-000000000777";
  const nativeTurnId = "019f0000-0000-7000-8000-000000000778";
  const workspace = path.join(
    root,
    rootUserRowOrder === "human-only"
      ? outcome
      : `${outcome}-${rootUserRowOrder}`
  );
  const rolloutPath = path.join(workspace, "rollout.jsonl");
  fs.mkdirSync(workspace, { recursive: true });
  const humanRootUserRow = {
    timestamp: "2026-08-21T01:00:01.010Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "Human-started durable task" }],
      internal_chat_message_metadata_passthrough: {
        turn_id: nativeTurnId
      }
    }
  };
  const syntheticContextRow = {
    timestamp: rootUserRowOrder === "synthetic-first"
      ? "2026-08-21T01:00:01.009Z"
      : "2026-08-21T01:00:01.012Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context>\n  <cwd>${workspace}</cwd>\n</environment_context>`
      }],
      internal_chat_message_metadata_passthrough: {
        turn_id: nativeTurnId
      }
    }
  };
  const humanUserMessageEvent = {
    timestamp: "2026-08-21T01:00:01.011Z",
    type: "event_msg",
    payload: { type: "user_message", message: "Human-started durable task" }
  };
  const rootTaskRecords = rootUserRowOrder === "human-only"
    ? [humanRootUserRow, humanUserMessageEvent]
    : rootUserRowOrder === "synthetic-first"
      ? [syntheticContextRow, humanRootUserRow, humanUserMessageEvent]
      : [humanRootUserRow, humanUserMessageEvent, syntheticContextRow];
  const records: unknown[] = [
    {
      timestamp: "2026-08-21T01:00:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        timestamp: "2026-08-21T01:00:00.000Z",
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.149.1"
      }
    },
    {
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: nativeTurnId }
    },
    ...rootTaskRecords
  ];
  if (outcome === "completed" || outcome === "aborted") {
    records.push({
      timestamp: "2026-08-21T01:00:02.000Z",
      type: "event_msg",
      payload: {
        type: outcome === "completed" ? "task_complete" : "turn_aborted",
        turn_id: nativeTurnId,
        ...(outcome === "completed"
          ? { last_agent_message: "Done" }
          : { reason: "Interrupted" })
      }
    });
  }
  fs.writeFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n` +
      (outcome === "malformed"
        ? "{not-valid-json}\n"
        : outcome === "partial"
          ? "{\"timestamp\":"
          : ""),
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  const processBirth = "fixture-process-birth";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const terminalControl = {
    kind: "tmux" as const,
    target: "durable:0.0",
    session: "durable",
    window: 0,
    pane: 0,
    panePid: 9000,
    currentCommand: "codex",
    currentPath: workspace,
    capabilities: ["screen_status" as const, "send_keys" as const]
  };
  const terminalId = "terminal:v2:tmux:codex:durable:0.0:4242";
  const session = {
    pid: 4242,
    ppid: 9000,
    command: "codex",
    cwd: workspace,
    elapsed: "00:30",
    agent: "codex" as const,
    kind: "codex_cli",
    confidence: "high" as const,
    reason: "fixture",
    terminalControl
  };
  const brokenSession = {
    ...session,
    pid: 4241,
    ppid: 9001,
    terminalControl: {
      ...terminalControl,
      target: "durable:0.1",
      pane: 1,
      panePid: 9001
    }
  };
  const registry = new TerminalAgentAdapterRegistry([
    createCodexTerminalAgentAdapter()
  ]);
  const provider = {
    diagnostics: async () => ({}),
    endpoint: (value: unknown) => value,
    resolve: async (value: unknown) => value,
    capture: async () => "› "
  };
  const bridge = {
    registry,
    listProcesses: async () => includeBrokenSibling
      ? [brokenSession, session]
      : [session],
    terminalConversationId: (value: { pid: number }) => value.pid === 4241
      ? "terminal:v2:tmux:codex:durable:0.1:4241"
      : terminalId,
    status: async () => ({
      approval_state: {
        scanned: true,
        blocked: false,
        approvable: false,
        reason: "no approval prompt"
      },
      activity_state: "idle",
      activity_reason: "idle-looking fixture screen",
      screen: { excerpt: "› " }
    })
  };
  const unusedGate = deferredGate();
  unusedGate.release();
  const base = facadeDependencies("A", [], unusedGate, unusedGate);
  const dependencies: TerminalListCliDependencies = {
    ...base,
    discovery: {
      createRuntimeTerminalAgentRegistry: () => registry,
      createTerminalControlProvider: () => provider,
      createTerminalAgentBridge: () => bridge,
      createTerminalProcessSource: () => ({
        listProcessSnapshots: async () => []
      }),
      agentVersionForRunningProcess: () => "0.149.1",
      codexLatentClearResumeObservation: () => undefined,
      codexManagedIdentityResolutionContext: () => ({
        companions: { primary: undefined, additional: [] }
      }),
      codexProcessIncarnationForPid: () => ({
        processUuid,
        processBirth,
        evidence: "codex_process_birth"
      }),
      inspectCodexOpenRootRolloutInventory: async () => ({ roots: [] }),
      nativeInspectionComposerEmpty: () => true,
      observeCurrentNativeAgentSessionIdentity: async (
        request: { pid: number }
      ) => {
        if (request.pid === 4241) {
          throw new Error("broken sibling identity probe");
        }
        return {
          status: "resolved",
          identity: {
            sessionId: nativeThreadId,
            processUuid,
            processBirth,
            rollout: {
              fd: "12r",
              device: String(stat.dev),
              inode: String(stat.ino),
              path: rolloutPath
            },
            evidence: "codex_rollout_fd+process_birth"
          }
        };
      }
    } as unknown as TerminalListDiscoveryPorts,
    store: {
      ...base.store,
      callbackRetryDisposition: () => ({ state: "not_retryable" }),
      codexLingeringBeforeIdentityMatchesSession: () => false,
      isDiscoverableTmuxConversation: () => true,
      isVerifiedDeadTerminalAgentProcess: () => false,
      loadTerminalBridgeDispatchLedger: () => undefined,
      loadTerminalDispatchLedgerOwner: () => undefined,
      managedSessionStoreDirForConversation: () => undefined,
      managedTurnsForSession: () => [],
      matchesConfiguredWorkspace: () => true,
      orphanedTerminalDispatchForRecovery: () => undefined,
      storeDirFromOptions: () => path.join(workspace, "store"),
      summarizeConversation: () => ({}),
      terminalBridgeEnabled: () => false,
      terminalBridgeSubmission: () => undefined,
      terminalControlFromTakeover: () => undefined,
      terminalDispatchRecordMatchesControl: () => false,
      ...storeOverrides
    } as unknown as TerminalListStoreObservationPorts,
    authority: {
      activeTurnHandoffDecisionToken: () => "unused",
      assertManagedTerminalDispatchOwner: () => {},
      observeDeferredCodexAuthority: () => undefined,
      observedHandoffTargetResolution: () => ({
        status: "blocked",
        reason: "unused"
      })
    } as TerminalListAuthorityPorts
  };
  const facade = terminalListCliAdapter.createTerminalListCliFacade(dependencies);
  const storeDir = path.join(workspace, "store");
  const scan = await facade.buildTerminalListGroup({
    options: { storeDir }
  });
  return {
    facade,
    scan,
    storeDir,
    terminalId,
    rolloutPath,
    nativeTurnId
  };
}

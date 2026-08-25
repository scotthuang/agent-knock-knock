import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { createCodexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import { terminalBindingFrom } from "../src/managed-session.js";
import { saveManagedSession } from "../src/session-store.js";
import {
  ensureStoreWritable,
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import {
  TerminalAgentAdapterRegistry,
  type TerminalControlRef
} from
  "../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  hasCanonicalTerminalEndpoint,
  terminalEndpointFromControlRef,
  tmuxTerminalRouteKey
} from "../src/terminal-control-ref.js";
import * as terminalCommandCliAdapter from
  "../src/terminal-command-cli-adapter.js";
import { terminalSubmissionPayload } from
  "../src/terminal-dispatch-execution.js";
import { createTerminalUserSendIntentRepository } from
  "../src/terminal-user-send-intent.js";
import type { TerminalCommandCliDependencies } from
  "../src/terminal-command-cli-adapter.js";
import * as terminalListCliAdapter from "../src/terminal-list-cli-adapter.js";
import { summarizeConversation as summarizeTerminalConversation } from
  "../src/terminal-status-facts.js";
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

type TerminalCommandPorts = TerminalCommandCliDependencies["ports"];

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

test("list token falls back to one unmanaged send and replays by message id", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-list-user-send-fallback-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const listFixture = await createCodexRolloutListFixture(
    root,
    "completed",
    false,
    {},
    "human-only",
    true
  );
  const { terminalControl, workspace, storeDir } = listFixture;
  ensureStoreWritable(storeDir);
  const runtimeDir = path.join(root, "runtime");
  const stalledAt = "2026-08-25T01:00:00.000Z";
  const stalledPaths = pathsForConversation(
    "turn-user-send-fallback-stalled",
    storeDir
  );
  const stalled: Conversation = {
    ...createConversation({
      userRequest: "This stale AKK Turn must not veto explicit Send.",
      sessionId: "session-user-send-fallback-stalled",
      turnId: "turn-user-send-fallback-stalled",
      executorKind: "codex",
      now: new Date(stalledAt)
    }),
    status: "stalled",
    stalled_at: stalledAt,
    stalled_reason: "test-only managed preparation blocker",
    store_dir: stalledPaths.storeDir,
    conversation_dir: stalledPaths.conversationDir,
    event_log_path: stalledPaths.logPath,
    state_path: stalledPaths.statePath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-stalled-owner",
      terminal_control: terminalControl
    },
    updated_at: stalledAt
  };
  saveState(stalledPaths.statePath, stalled);

  const observed = await listFixture.facade.observeExactTerminal({
    options: { storeDir },
    terminalId: listFixture.terminalId
  });
  assert.equal(observed.state, "available");
  if (observed.state !== "available") return;
  const listed = observed.terminal;
  assert.equal(
    hasCanonicalTerminalEndpoint(
      listed.terminal_control as unknown as TerminalControlRef
    ),
    true,
    "the list fixture must retain its provider-issued endpoint identity"
  );
  const listedActions = listed.available_actions as Record<string, any>;
  const sendAction = listedActions.send as Record<string, any> | undefined;
  assert.ok(sendAction, JSON.stringify(listed, null, 2));
  assert.equal(
    sendAction.scope,
    "terminal_user_explicit",
    JSON.stringify(listed, null, 2)
  );
  const sendArguments = sendAction.arguments as Record<string, unknown>;
  assert.equal(sendArguments.selector, listed.id);
  assert.equal(typeof sendArguments.expected_terminal_token, "string");
  const terminal = {
    conversationId: String(listed.id),
    agent: "codex",
    pid: Number(listed.pid),
    legacy: false,
    adapter: {} as ResolvedTerminalConversation["adapter"],
    terminalControl
  } satisfies ResolvedTerminalConversation;

  const transportCalls: string[][] = [];
  let fallbackPreflightAvailable = false;
  let terminalLockAcquisitions = 0;
  let terminalLockMode: "normal" | "storage_error" | "release_error" =
    "normal";
  const bridge = {
    async resolveConversationId(conversationId) {
      return fallbackPreflightAvailable &&
        conversationId === terminal.conversationId
        ? terminal
        : undefined;
    },
    async status() {
      return {
        provider: "tmux",
        target: terminalControl.target,
        agent: "codex",
        reachable: true,
        capabilities: {},
        activity_state: "idle",
        activity_reason: "exact empty composer",
        approval_state: {
          scanned: true,
          blocked: false,
          approvable: false
        },
        screen: { excerpt: "› " }
      } as Awaited<ReturnType<TerminalAgentBridge["status"]>>;
    },
    async send(agent, control, text, options = {}) {
      const multiline = false;
      await options.beforeText?.({
        agent,
        terminalControl: control,
        multiline,
        text
      });
      transportCalls.push(["text", text]);
      await options.onTransportStage?.({
        stage: "text_injected",
        agent,
        terminalControl: control,
        multiline
      });
      await options.beforeEnter?.({
        agent,
        terminalControl: control,
        multiline,
        text
      });
      transportCalls.push(["enter", "C-m"]);
      await options.onTransportStage?.({
        stage: "enter_dispatched",
        agent,
        terminalControl: control,
        multiline
      });
      return {
        stage: "enter_dispatched" as const,
        agent,
        terminalControl: control,
        multiline
      };
    }
  } satisfies Partial<TerminalAgentBridge>;

  let managedPreparationAttempts = 0;
  const managedLockOptions: unknown[] = [];
  const implemented = {
    required<Value>(
      value: Value | null | undefined,
      label: string
    ): Value {
      if (value === undefined || value === null) throw new Error(label);
      return value;
    },
    async resolveTerminalConversationFromOptions() {
      return terminal;
    },
    assertExpectedHandoffTokenUsesExactTerminalSelector() {},
    terminalWriterMutationLocks(_storeDir, _terminalControl, options) {
      managedPreparationAttempts += 1;
      managedLockOptions.push(options);
      throw new Error("managed preparation blocked by the stalled AKK Turn");
    },
    storeDirFromOptions() {
      return storeDir;
    },
    acquireTerminalBridgeSendLock() {
      terminalLockAcquisitions += 1;
      if (terminalLockAcquisitions === 1) {
        throw Object.assign(
          new Error("test-only fallback terminal lock unavailable"),
          { code: "LOCK_TIMEOUT" }
        );
      }
      if (terminalLockMode === "storage_error") {
        throw new Error("test-only terminal lock runtime is read-only");
      }
      return terminalLockMode === "release_error"
        ? () => { throw new Error("test-only terminal lock unlink failed"); }
        : () => {};
    },
    acquireFileLock() {
      return () => {};
    },
    createTerminalAgentBridge() {
      return bridge as unknown as TerminalAgentBridge;
    },
    terminalRuntimeForLiveIdentity() {
      return {};
    },
    terminalBridgeRuntimeKey() {
      return "tmux:durable:0.0:9000";
    },
    terminalBridgeRequestFingerprint() {
      return undefined;
    },
    assertSafeTerminalSend() {},
    async assertCodexComposerReadyForAutomatedInput() {},
    terminalControlFromTakeover(value: unknown) {
      if (typeof value !== "object" || value === null) return undefined;
      return (value as { terminal_control?: TerminalControlRef })
        .terminal_control;
    },
    textSummary(value: unknown) {
      const text = String(value);
      return { length: text.length, preview: text };
    }
  } satisfies Partial<TerminalCommandPorts>;
  const ports = new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`unexpected explicit Send port ${String(property)}`);
    }
  }) as unknown as TerminalCommandPorts;
  const facade = terminalCommandCliAdapter.createTerminalCommandCliFacade({
    ports
  });
  const message = "Continue even though the old AKK Turn is stalled.";
  const messageId = "message-user-send-fallback-once";
  const options = {
    conversation: terminal.conversationId,
    message,
    messageId,
    background: true,
    storeDir,
    expectedTerminalToken: String(
      sendArguments.expected_terminal_token
    )
  };
  const dependencies = {
    cwd: workspace,
    env: {
      ...process.env,
      AKK_RUNTIME_DIR: runtimeDir
    },
    now: () => new Date("2026-08-25T01:01:00.000Z"),
    runtimeLog: () => {}
  };

  await assert.rejects(
    runCliCommandExecution(
      "send",
      options,
      dependencies,
      () => facade.runSend(options)
    ),
    /fallback terminal lock unavailable/u
  );
  assert.deepEqual(
    transportCalls,
    [],
    "a failed fallback lock must not inject terminal input"
  );

  await assert.rejects(
    runCliCommandExecution(
      "send",
      options,
      dependencies,
      () => facade.runSend(options)
    ),
    /no longer the same live process/u
  );
  assert.deepEqual(
    transportCalls,
    [],
    "a failed fallback preflight must not inject terminal input"
  );
  fallbackPreflightAvailable = true;

  const first = await runCliCommandExecution(
    "send",
    options,
    dependencies,
    () => facade.runSend(options)
  );
  const firstOutput = JSON.parse(first.stdout);
  assert.equal(firstOutput.delivered, true);
  assert.equal(firstOutput.delivered_unmanaged, true);
  assert.notEqual(firstOutput.replayed, true);
  assert.equal(firstOutput.management_mode, "unmanaged_fallback");
  assert.equal(firstOutput.message_id, messageId);
  assert.deepEqual(transportCalls, [
    ["text", message],
    ["enter", "C-m"]
  ]);
  const released = loadState(stalledPaths.statePath);
  assert.equal(released.status, "closed");
  assert.equal(released.disposition, "user_abandoned_management");

  const replay = await runCliCommandExecution(
    "send",
    options,
    dependencies,
    () => facade.runSend(options)
  );
  const replayOutput = JSON.parse(replay.stdout);
  assert.equal(replayOutput.delivered, true);
  assert.equal(replayOutput.delivered_unmanaged, true);
  assert.equal(replayOutput.replayed, true);
  assert.equal(replayOutput.message_id, messageId);
  assert.deepEqual(
    transportCalls,
    [["text", message], ["enter", "C-m"]],
    "a replayed explicit Send must not inject terminal input again"
  );
  assert.equal(
    managedPreparationAttempts,
    3,
    "a completed fallback intent must replay before managed preparation"
  );
  assert.deepEqual(
    managedLockOptions,
    [{ timeoutMs: 0 }, { timeoutMs: 0 }, { timeoutMs: 0 }],
    "user-priority Send must never wait for management locks"
  );

  const intentRoot = path.join(runtimeDir, "terminal-user-send-intents");
  const intentFiles = fs.readdirSync(intentRoot)
    .filter((file) => file.endsWith(".json"))
    .map((file) => path.join(intentRoot, file));
  assert.equal(intentFiles.length, 1);
  fs.writeFileSync(intentFiles[0] as string, "{damaged-same-id-receipt\n");
  await assert.rejects(
    runCliCommandExecution(
      "send",
      options,
      dependencies,
      () => facade.runSend(options)
    ),
    /existing same-id terminal user-Send intent cannot be verified/u
  );
  assert.deepEqual(
    transportCalls,
    [["text", message], ["enter", "C-m"]],
    "an unverifiable existing same-id receipt must never duplicate input"
  );
  assert.equal(managedPreparationAttempts, 3);

  const managedReplayMessage = "Managed Enter was already dispatched.";
  const managedReplayMessageId = "message-user-send-managed-replay";
  const managedIntent = createTerminalUserSendIntentRepository({ runtimeDir });
  const managedBoundary = {
    terminalRuntimeKey: "tmux:durable:0.0:9000",
    physicalToken: String(sendArguments.expected_terminal_token),
    messageId: managedReplayMessageId,
    requestHash: createHash("sha256")
      .update(terminalSubmissionPayload(managedReplayMessage))
      .digest("hex")
  };
  managedIntent.reserve(managedBoundary);
  managedIntent.complete(managedBoundary, "managed");
  const managedReplayOptions = {
    ...options,
    message: managedReplayMessage,
    messageId: managedReplayMessageId
  };
  const managedReplay = await runCliCommandExecution(
    "send",
    managedReplayOptions,
    dependencies,
    () => facade.runSend(managedReplayOptions)
  );
  const managedReplayOutput = JSON.parse(managedReplay.stdout);
  assert.equal(managedReplayOutput.delivered, false);
  assert.equal(managedReplayOutput.replayed, true);
  assert.equal(
    managedReplayOutput.submission_outcome,
    "pending_acceptance"
  );
  assert.equal(managedReplayOutput.delivery_receipt, "enter_dispatched");
  assert.equal(managedReplayOutput.do_not_retry, true);
  assert.equal(managedPreparationAttempts, 3);

  terminalLockMode = "release_error";
  const releaseFailureMessage = "Send even if physical lock cleanup fails.";
  const releaseFailureOptions = {
    ...options,
    message: releaseFailureMessage,
    messageId: "message-user-send-lock-release-failure"
  };
  const releaseFailure = await runCliCommandExecution(
    "send",
    releaseFailureOptions,
    dependencies,
    () => facade.runSend(releaseFailureOptions)
  );
  const releaseFailureOutput = JSON.parse(releaseFailure.stdout);
  assert.equal(releaseFailureOutput.delivered, true);
  assert.match(
    JSON.stringify(releaseFailureOutput.intent_warnings),
    /terminal serialization cleanup failed.*unlink failed/u
  );

  terminalLockMode = "storage_error";
  const storageFailureMessage = "Send even if primary lock storage is broken.";
  const storageFailureOptions = {
    ...options,
    message: storageFailureMessage,
    messageId: "message-user-send-lock-storage-failure"
  };
  const storageFailure = await runCliCommandExecution(
    "send",
    storageFailureOptions,
    dependencies,
    () => facade.runSend(storageFailureOptions)
  );
  const storageFailureOutput = JSON.parse(storageFailure.stdout);
  assert.equal(storageFailureOutput.delivered, true);
  assert.match(
    JSON.stringify(storageFailureOutput.intent_warnings),
    /primary terminal serialization was unavailable.*read-only/u
  );
  assert.deepEqual(transportCalls, [
    ["text", message],
    ["enter", "C-m"],
    ["text", releaseFailureMessage],
    ["enter", "C-m"],
    ["text", storageFailureMessage],
    ["enter", "C-m"]
  ]);

  terminalLockMode = "normal";
  const brokenRuntimePath = path.join(root, "runtime-is-a-file");
  fs.writeFileSync(brokenRuntimePath, "not a runtime directory\n");
  const intentStorageFailureMessage =
    "Send even if fresh intent storage is broken.";
  const intentStorageFailureOptions = {
    ...options,
    message: intentStorageFailureMessage,
    messageId: "message-user-send-intent-storage-failure"
  };
  const intentStorageFailure = await runCliCommandExecution(
    "send",
    intentStorageFailureOptions,
    {
      ...dependencies,
      env: {
        ...dependencies.env,
        AKK_RUNTIME_DIR: brokenRuntimePath
      }
    },
    () => facade.runSend(intentStorageFailureOptions)
  );
  const intentStorageFailureOutput = JSON.parse(intentStorageFailure.stdout);
  assert.equal(intentStorageFailureOutput.delivered, true);
  assert.match(
    JSON.stringify(intentStorageFailureOutput.intent_warnings),
    /durable user-Send intent unavailable/u
  );
  assert.deepEqual(transportCalls.slice(-2), [
    ["text", intentStorageFailureMessage],
    ["enter", "C-m"]
  ]);
});

test("healthy managed terminal keeps physical Send separate from its fast path", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-list-managed-user-send-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixture = await createCodexRolloutListFixture(
    root,
    "completed",
    false,
    {},
    "human-only",
    true,
    false
  );
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-25T02:00:00.000Z");
  saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-managed-user-send",
    agent: "codex",
    workspace: fixture.workspace,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: 4242,
      nativeThreadId: fixture.nativeThreadId,
      processUuid: fixture.processUuid,
      processBirth: fixture.processBirth,
      evidence: "codex_process_birth",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });

  const observed = await fixture.facade.observeExactTerminal({
    options: { storeDir: fixture.storeDir },
    terminalId: fixture.terminalId
  });
  assert.equal(observed.state, "available");
  if (observed.state !== "available") return;
  assert.equal(observed.terminal.management_state, "managed");
  assert.equal(
    Object.hasOwn(observed.terminal, "_terminal_user_explicit_send_action"),
    false
  );
  const send = (observed.terminal.available_actions as Record<string, any>)
    .send as Record<string, any>;
  assert.equal(send.scope, "terminal_user_explicit");
  assert.equal(send.arguments.selector, fixture.terminalId);
  assert.equal(typeof send.arguments.expected_terminal_token, "string");
  assert.equal(
    send.arguments.expected_managed_terminal_token,
    undefined,
    "physical Send authority must not be recycled as managed authority"
  );

  const selectorOptions: Record<string, unknown> = {
    conversation: fixture.terminalId,
    storeDir: fixture.storeDir,
    expectedTerminalToken: send.arguments.expected_terminal_token
  };
  await fixture.facade.resolveConversationSelectorOption(
    "send",
    selectorOptions
  );
  assert.equal(selectorOptions.expectedManagedTerminalToken, undefined);
});

test("corrupt managed inventory cannot hide exact terminal user Send", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-list-corrupt-management-user-send-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixture = await createCodexRolloutListFixture(
    root,
    "completed",
    false,
    {},
    "human-only",
    true
  );
  ensureStoreWritable(fixture.storeDir);
  const corrupt = pathsForConversation(
    "turn-corrupt-management-inventory",
    fixture.storeDir
  );
  fs.mkdirSync(corrupt.conversationDir, { recursive: true });
  fs.writeFileSync(corrupt.statePath, "{not-valid-managed-state\n");

  const observed = await fixture.facade.observeExactTerminal({
    options: { storeDir: fixture.storeDir },
    terminalId: fixture.terminalId
  });
  assert.equal(observed.state, "available");
  if (observed.state !== "available") return;
  const terminal = observed.terminal;
  assert.equal(terminal.management_state, "unavailable");
  assert.match(
    String((terminal.management_unavailable as Record<string, unknown>).reason),
    /managed Turn inventory is unavailable/iu
  );
  const actions = terminal.available_actions as Record<string, any>;
  assert.equal(actions.send?.scope, "terminal_user_explicit");
  assert.equal(actions.send?.arguments?.selector, fixture.terminalId);
  assert.equal(
    typeof actions.send?.arguments?.expected_terminal_token,
    "string"
  );
});

test("corrupt Store metadata cannot hide exact terminal user Send", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-list-corrupt-store-user-send-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fixture = await createCodexRolloutListFixture(
    root,
    "completed",
    false,
    {},
    "human-only",
    true
  );
  ensureStoreWritable(fixture.storeDir);
  fs.writeFileSync(
    path.join(fixture.storeDir, "manifest.json"),
    "{not-valid-store-metadata\n"
  );

  const observed = await fixture.facade.observeExactTerminal({
    options: { storeDir: fixture.storeDir },
    terminalId: fixture.terminalId
  });
  assert.equal(observed.state, "available");
  if (observed.state !== "available") return;
  const terminal = observed.terminal;
  assert.equal(terminal.management_state, "unavailable");
  assert.match(
    String((terminal.management_unavailable as Record<string, unknown>).reason),
    /Store|managed Turn inventory/iu
  );
  const actions = terminal.available_actions as Record<string, any>;
  assert.equal(actions.send?.scope, "terminal_user_explicit");
  assert.equal(actions.send?.arguments?.selector, fixture.terminalId);
  assert.equal(
    typeof actions.send?.arguments?.expected_terminal_token,
    "string"
  );

  const selectorOptions: Record<string, unknown> = {
    conversation: "codex",
    storeDir: fixture.storeDir
  };
  await fixture.facade.resolveConversationSelectorOption(
    "send",
    selectorOptions
  );
  assert.equal(selectorOptions.session, fixture.terminalId);
  assert.equal(selectorOptions.conversation, fixture.terminalId);
  assert.equal(typeof selectorOptions.expectedTerminalToken, "string");
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
    assert.equal(fixture.scan.summary.error, undefined);
    const broken = fixture.scan.terminalControlled.find((terminal) =>
      terminal.pid === 4241
    );
    assert.equal(
      (broken?.native_agent_identity_observation as Record<string, unknown>)
        ?.status,
      "unavailable"
    );
    assert.match(
      String(
        (broken?.native_agent_identity_observation as Record<string, unknown>)
          ?.reason
      ),
      /broken sibling identity probe/u
    );
    const healthy = fixture.scan.terminalControlled.find((terminal) =>
      terminal.pid === 4242
    );
    assert.ok(healthy);
    return healthy as Record<string, any>;
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
    "human-only",
  canonicalTerminal = false,
  nativeIdentityHasRollout = true
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
    socketPath: path.join(workspace, "tmux.sock"),
    session: "durable",
    window: 0,
    pane: 0,
    panePid: 9000,
    currentCommand: "codex",
    currentPath: workspace,
    capabilities: ["screen_status" as const, "send_keys" as const]
  };
  if (canonicalTerminal) {
    const endpointKey = `socket:${terminalControl.socketPath}`;
    createTerminalEndpointRef({
      identity: {
        providerKind: "tmux",
        endpointKey,
        resourceKey: "pane-id:%42"
      },
      route: {
        routeKey: tmuxTerminalRouteKey(
          endpointKey,
          terminalControl.target,
          terminalControl.socketPath
        ),
        label: terminalControl.target,
        currentCommand: terminalControl.currentCommand,
        currentPath: terminalControl.currentPath
      },
      processAnchorPid: terminalControl.panePid,
      capabilities: terminalControl.capabilities,
      providerRef: terminalControl
    });
  }
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
    endpoint: (value: unknown) =>
      terminalEndpointFromControlRef(value as TerminalControlRef),
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
            ...(nativeIdentityHasRollout
              ? {
                  rollout: {
                    fd: "12r",
                    device: String(stat.dev),
                    inode: String(stat.ino),
                    path: rolloutPath
                  }
                }
              : {}),
            evidence: "codex_rollout_fd+process_birth"
          }
        };
      }
    } as unknown as TerminalListDiscoveryPorts,
    store: {
      ...base.store,
      callbackRetryDisposition: () => ({ state: "not_retryable" }),
      codexLingeringBeforeIdentityMatchesSession: () => false,
      isActiveStatus: (status: string) =>
        ["waiting_for_agent", "idle", "stalled"].includes(status),
      isDiscoverableTmuxConversation: () => true,
      isVerifiedDeadTerminalAgentProcess: () => false,
      loadTerminalBridgeDispatchLedger: () => undefined,
      loadTerminalDispatchLedgerOwner: () => undefined,
      managedSessionStoreDirForConversation: () => undefined,
      managedTurnsForSession: () => [],
      matchesConfiguredWorkspace: () => true,
      orphanedTerminalDispatchForRecovery: () => undefined,
      storeDirFromOptions: () => path.join(workspace, "store"),
      summarizeConversation: (conversation: Conversation) =>
        summarizeTerminalConversation(conversation, {
          callbackRetryDisposition: () => ({ state: "not_retryable" }),
          textSummary: (value) => String(value)
        }),
      terminalBridgeEnabled: () => false,
      terminalBridgeSubmission: () => undefined,
      terminalControlFromTakeover: (value: unknown) =>
        typeof value === "object" && value !== null
          ? (value as { terminal_control?: TerminalControlRef })
              .terminal_control
          : undefined,
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
    terminalControl,
    workspace,
    nativeThreadId,
    processUuid,
    processBirth,
    rolloutPath,
    nativeTurnId
  };
}

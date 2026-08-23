import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTerminalAcceptanceCliFacade,
  type TerminalAcceptanceBridge,
  type TerminalAcceptanceCliDependencies
} from "../src/terminal-acceptance-cli-adapter.js";
import { callbackRouteFingerprintForConversation } from
  "../src/callback-route-authority.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { terminalBindingFrom, type ManagedSessionState } from
  "../src/managed-session.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import { createConversation, resolveExecutor } from "../src/protocol.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import type { TerminalDispatchLedgerDocument } from
  "../src/terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "../src/terminal-dispatch-receipt.js";
import {
  ensureStoreWritable,
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";

function compiledSource(): string {
  return fs.readFileSync(
    new URL("../src/terminal-acceptance-cli-adapter.js", import.meta.url),
    "utf8"
  );
}

function compiledCoreComposition(): string {
  const source = fs.readFileSync(
    new URL("../src/cli-core.js", import.meta.url),
    "utf8"
  );
  const from = source.indexOf("const terminalAcceptanceCliFacade =");
  const to = source.indexOf("const terminalDispatchExecution =", from);
  assert.notEqual(from, -1, "missing acceptance composition");
  assert.notEqual(to, -1, "missing acceptance facade aliases");
  return source.slice(from, to);
}

function sourceBetween(start: string, end: string): string {
  const source = compiledSource();
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered token ${token}`);
    cursor = found + token.length;
  }
}

test("acceptance adapter exposes one factory and keeps exact lock/write order", () => {
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  assert.deepEqual(Object.keys(facade), [
    "execution",
    "recoverVirgin",
    "reconcileMonitor",
    "markUncertain",
    "inspectCodexOpenRoots",
    "resolveNativeIdentity",
    "observeNativeIdentity",
    "assertTurnIdentity",
    "withNativeIdentity",
    "storeDirForConversation",
    "refineSessionIdentity",
    "persistSessionIdentity",
    "quarantineSession",
    "turnsForSession",
    "assertSessionCanStartTurn",
    "turnMatchesTerminal",
    "createManagedTurn"
  ]);
  assertOrdered(sourceBetween("async recoverVirgin(", "async #recoverVirginWithWriter"), [
    "acquireTerminalLock(",
    "#recoverVirginWithWriter({",
    "finally",
    "releaseTerminal()"
  ]);
  assertOrdered(sourceBetween(
    "async #recoverVirginWithWriter",
    "async #recoverVirginLocked"
  ), [
    "withStoreWriterLeaseAsync",
    "acquireStateLock(",
    "#recoverVirginLocked(input)",
    "finally",
    "releaseState()"
  ]);
  assertOrdered(sourceBetween(
    "#commitAcceptanceLocked(",
    "\n    #persistResolvedAcceptanceLedger("
  ), [
    "assertAcceptanceGeneration(",
    "resolvedAcceptanceConversation(",
    "reconcileLedger(",
    "saveState(",
    "#persistResolvedAcceptanceLedger(",
    "#appendResolvedAcceptanceEvent("
  ]);
  assertOrdered(sourceBetween(
    "#markUncertainLocked(",
    "\n    #persistUncertainLedger("
  ), [
    "loadState(",
    "isExplicitUserAbandonedManagementTurn(current)",
    "terminalBridgeSubmission(current)",
    "applyTerminalBridgeSubmission({",
    "#persistUncertainLedger(",
    "saveState(",
    "appendEvent("
  ]);
  assertOrdered(sourceBetween("assertTurn: (identity)", "persistence:"), [
    "recoveredAt ??= cliNow().toISOString()",
    "this.assertTurnIdentity("
  ]);
  assertOrdered(sourceBetween(
    "    execution(options, bridge) {",
    "    async inspectCodexOpenRoots"
  ), [
    "let currentRuntime",
    "this.#dependencies.terminal.runtime(options)",
    "runtime().loadClaudeAgentRows",
    "runtime().createBridge()"
  ]);
  const composition = compiledCoreComposition();
  assertOrdered(composition, [
    "runtime: (options) => terminalRuntime(options)",
    "acquireTerminalLock: terminalDispatchRepository.acquire",
    "loadLedger: terminalDispatchRepository.load",
    "saveLedger: terminalDispatchRepository.save",
    "reconcileLedger: terminalDispatchRecovery.reconcilePrepared",
    "bindingFields: terminalDispatchRecovery.bindingFields"
  ]);
  assert.doesNotMatch(
    composition,
    /claudeRows:|bridge: createTerminalAgentBridge|loadTerminalBridgeDispatchLedger|reconcilePreparedTerminalDispatchLedger/u
  );
});

test("managed Turn creation preserves storage and binding JSON keys", () => {
  const control = {
    kind: "tmux" as const,
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const binding = terminalBindingFrom({
    terminalId: "terminal:tmux:akk:0.0:42",
    terminalControl: control,
    pid: 42,
    nativeThreadId: "00000000-0000-4000-8000-000000000001",
    processUuid: "codex-pid:42:birth:1",
    processBirth: "1",
    rollout: {
      fd: "7",
      device: "1",
      inode: "2",
      path: "/tmp/rollout.jsonl"
    },
    evidence: "codex_rollout_fd",
    generation: 7,
    now: new Date("2026-08-15T00:00:00.000Z")
  });
  const session: ManagedSessionState = {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-1",
    revision: 11,
    agent: "codex",
    workspace: "/workspace/project",
    status: "bound",
    binding,
    lineage: { created_by: "attach" },
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z"
  };
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const created = facade.createManagedTurn({
    options: { storeDir: "/tmp/akk-acceptance-shape", messageId: "msg-1" },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control,
    managedSession: session
  });
  assert.deepEqual(Object.keys(created), [
    "conversation",
    "nextConversation",
    "statePath",
    "logPath",
    "executor",
    "message"
  ]);
  assert.equal(created.conversation.terminal_binding_id, binding.binding_id);
  assert.equal(created.conversation.terminal_binding_generation, 7);
  assert.equal(created.conversation.native_thread_id, binding.native_thread_id);
  assert.deepEqual(Object.keys(created.conversation).slice(-4), [
    "store_dir",
    "conversation_dir",
    "event_log_path",
    "state_path"
  ]);
  assert.equal(created.conversation.store_dir, "/tmp/akk-acceptance-shape");
  assert.equal(
    created.conversation.conversation_dir,
    `/tmp/akk-acceptance-shape/conversations/${created.conversation.turn_id}`
  );
  assert.equal(
    created.logPath,
    `${created.conversation.conversation_dir}/events.ndjson`
  );
  assert.equal(
    created.statePath,
    `${created.conversation.conversation_dir}/state.json`
  );
  const takeover = created.conversation.native_session_takeover as
    Record<string, unknown>;
  const normalized = { ...takeover, attached_at: "<time>" };
  assert.equal(JSON.stringify(normalized), JSON.stringify({
    agent: "codex",
    terminal_agent_identity_protocol: 1,
    native_session_id: "terminal:tmux:akk:0.0:42",
    terminal_agent_pid: 42,
    terminal_agent_expected_session_id: binding.native_thread_id,
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: 7,
    terminal_agent_process_uuid: binding.native_process.process_uuid,
    terminal_agent_process_birth: binding.native_process.process_birth,
    terminal_agent_rollout: binding.native_process.rollout,
    terminal_agent_identity_evidence: binding.native_process.evidence,
    source_cwd: "/workspace/project",
    source_title: "Terminal-controlled Codex akk:0.0",
    strategy: "terminal_control",
    attached_at: "<time>",
    takeover_match_kind: "raw_terminal_send",
    terminal_control: control,
    needs_bootstrap: false,
    terminal_bridge: true
  }));
  assert.equal(created.message.id, "msg-1");
  assert.equal(created.message.session_id, "session-1");
  assert.equal(created.message.turn_id, created.conversation.turn_id);
});

test("managed Turn creation writes and inherits a generic callback route", () => {
  const control = {
    kind: "tmux" as const,
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const created = facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-route",
      messageId: "msg-route-1",
      gatewayMethod: "agent-knock-knock.callback",
      gatewaySession: "agent:controller:one",
      openclawSession: "agent:controller:one",
      openclawBin: "/opt/openclaw"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control
  });

  assert.deepEqual(created.conversation.callback_route, {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: "openclaw_gateway_v1",
    profile_id: "legacy-openclaw-cli",
    profile_revision: created.conversation.callback_route?.profile_revision,
    controller_session_id: "agent:controller:one",
    capabilities: { wake: true, respond: true }
  });
  assert.equal(created.conversation.gateway_method, "agent-knock-knock.callback");
  assert.equal(created.conversation.gateway_session, "agent:controller:one");

  const inherited = facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-route",
      messageId: "msg-route-2"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "continue",
    terminalControl: control,
    previousTurn: created.conversation
  });
  assert.deepEqual(
    inherited.conversation.callback_route,
    created.conversation.callback_route
  );
  assert.equal(inherited.conversation.gateway_method, "agent-knock-knock.callback");
  assert.equal(inherited.conversation.gateway_session, "agent:controller:one");
});

test("trusted managed Turn options give an explicit generic route precedence", () => {
  const control = {
    kind: "tmux" as const,
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const callbackRoute: CallbackRouteV1 = {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: "local_ipc_v1",
    profile_id: "trusted-local-controller",
    profile_revision: "revision-1",
    controller_session_id: "controller-local-one",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const create = (route: CallbackRouteV1) => facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-generic-route",
      messageId: "msg-generic-route",
      callbackRoute: route,
      gatewayMethod: "legacy.callback",
      gatewaySession: "agent:legacy:controller"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control
  });

  assert.deepEqual(create(callbackRoute).conversation.callback_route, callbackRoute);
  assert.throws(
    () => create({ ...callbackRoute, version: 99 } as unknown as CallbackRouteV1),
    /unsupported callback_route version 99/u
  );
});

test("user-abandoned deferred acceptance is neutral without terminal I/O", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-accepted-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const conversationDir = path.join(storeDir, "conversations", "turn-closed");
  const statePath = path.join(conversationDir, "state.json");
  const logPath = path.join(conversationDir, "events.ndjson");
  const conversation = {
    ...createConversation({
      userRequest: "closed by user",
      sessionId: "session-closed",
      turnId: "turn-closed",
      executorKind: "codex",
      now: new Date("2026-08-15T00:00:00.000Z")
    }),
    status: "closed" as const,
    native_session_takeover: {
      deferred_foreground_transfer_id: "transfer-user-abandoned"
    }
  };
  let terminalReads = 0;
  const facade = createTerminalAcceptanceCliFacade({
    deferred: {
      loadTransfer: () => ({ status: "user_abandoned" })
    }
  } as unknown as TerminalAcceptanceCliDependencies);
  const result = await facade.reconcileMonitor({
    options: {},
    conversation,
    statePath,
    logPath,
    terminalControl: {
      kind: "tmux",
      target: "closed:0.0",
      session: "closed",
      window: 0,
      pane: 0,
      panePid: 42,
      capabilities: []
    },
    executor: resolveExecutor({ kind: "codex" }),
    terminalBridge: {
      async resolveStoredTerminal() {
        terminalReads += 1;
        throw new Error("user-abandoned acceptance must not read terminal");
      }
    } as unknown as TerminalAcceptanceBridge
  });
  assert.equal(result.outcome, "not_accepted");
  assert.equal("conversation" in result && result.conversation, conversation);
  assert.equal(terminalReads, 0);
});

test("acceptance uncertainty cannot revive an explicit Close that wins the Store lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-acceptance-close-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const paths = pathsForConversation("turn-close-race", storeDir);
  const submission = {
    message_id: "message-close-race",
    status: "enter_dispatched",
    prepared_at: "2026-08-24T00:00:00.000Z",
    text_injected_at: "2026-08-24T00:00:01.000Z",
    enter_dispatched_at: "2026-08-24T00:00:02.000Z",
    last_proven_stage: "enter_dispatched"
  };
  const stale = {
    ...createConversation({
      userRequest: "finish the task",
      sessionId: "session-close-race",
      turnId: "turn-close-race",
      executorKind: "codex",
      now: new Date("2026-08-24T00:00:00.000Z")
    }),
    status: "waiting_for_agent" as const,
    store_dir: path.resolve(storeDir),
    conversation_dir: path.resolve(paths.conversationDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-close-race",
      terminal_bridge_request_text: "finish the task",
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    }
  };
  const closed = {
    ...stale,
    status: "closed" as const,
    disposition: "user_abandoned_management",
    callback_expected: false,
    closed_at: "2026-08-24T00:00:03.000Z",
    close_reason: "closed by request",
    updated_at: "2026-08-24T00:00:03.000Z"
  };
  saveState(paths.statePath, closed);
  const before = fs.readFileSync(paths.statePath);
  let stateLocks = 0;
  let ledgerReads = 0;
  let ledgerWrites = 0;
  let terminalAuthorityReads = 0;
  const facade = createTerminalAcceptanceCliFacade({
    repository: {
      acquireStateLock: () => {
        stateLocks += 1;
        return () => undefined;
      },
      loadLedger: () => {
        ledgerReads += 1;
        return undefined;
      },
      saveLedger: () => { ledgerWrites += 1; }
    },
    authority: {
      terminalControl: () => {
        terminalAuthorityReads += 1;
        return undefined;
      }
    }
  } as unknown as TerminalAcceptanceCliDependencies);

  const raced = facade.markUncertain({
    conversation: stale,
    statePath: paths.statePath,
    logPath: paths.logPath,
    terminalControl: {
      kind: "tmux",
      target: "close-race:0.0",
      session: "close-race",
      window: 0,
      pane: 0,
      panePid: 4242,
      capabilities: []
    },
    reason: "stale acceptance observation"
  });

  assert.deepEqual(raced, loadState(paths.statePath));
  assert.equal(raced.status, "closed");
  assert.equal(raced.disposition, "user_abandoned_management");
  assert.equal(stateLocks, 1);
  assert.equal(ledgerReads, 0);
  assert.equal(ledgerWrites, 0);
  assert.equal(terminalAuthorityReads, 0);
  assert.deepEqual(fs.readFileSync(paths.statePath), before);
  assert.equal(fs.existsSync(paths.logPath), false);

  const outer = facade.markUncertain({
    conversation: raced,
    statePath: paths.statePath,
    logPath: paths.logPath,
    terminalControl: {
      kind: "tmux",
      target: "close-race:0.0",
      session: "close-race",
      window: 0,
      pane: 0,
      panePid: 4242,
      capabilities: []
    },
    reason: "already closed"
  });
  assert.strictEqual(outer, raced);
  assert.equal(stateLocks, 1);
});

test("legacy in-flight acceptance synchronizes callback route authority", async (t) => {
  const control: TerminalControlRef = {
    kind: "tmux",
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const requestText = "accept the exact legacy in-flight request";
  const requestHash = terminalBridgeRequestFingerprint(requestText) as string;
  const bridge = {
    proveExactDraftStillPresent: async () => false,
    resolveStoredTerminal: async () => {
      throw new Error("deferred resolution is not expected");
    }
  } as TerminalAcceptanceBridge;

  async function runCase(input: {
    name: string;
    routed: boolean;
    ledgerAuthority?: string | null;
    rejects?: boolean;
  }): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `akk-${input.name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const storeDir = path.join(root, "store");
    ensureStoreWritable(storeDir);
    const conversationDir = path.join(storeDir, "conversations", "turn-1");
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    fs.mkdirSync(conversationDir, { recursive: true });
    const legacySubmission = {
      status: "enter_dispatched",
      message_id: "message-1",
      prepared_at: "2026-08-15T00:00:00.000Z",
      text_injected_at: "2026-08-15T00:00:01.000Z",
      enter_dispatched_at: "2026-08-15T00:00:02.000Z",
      last_proven_stage: "enter_dispatched"
    };
    const conversation = {
      ...createConversation({
        userRequest: requestText,
        sessionId: "session-1",
        turnId: "turn-1",
        executorKind: "claude",
        now: new Date("2026-08-15T00:00:00.000Z")
      }),
      status: "waiting_for_agent" as const,
      store_dir: storeDir,
      conversation_dir: conversationDir,
      state_path: statePath,
      event_log_path: logPath,
      ...(input.routed
        ? {
            gateway_method: "agent-knock-knock.callback",
            gateway_session: "agent:controller:one"
          }
        : {}),
      native_session_takeover: {
        terminal_bridge: true,
        terminal_bridge_message_id: "message-1",
        terminal_bridge_request_text: requestText,
        terminal_bridge_request_hash: requestHash,
        terminal_agent_expected_session_id: "session-1",
        terminal_bridge_submission: legacySubmission,
        terminal_bridge_submission_receipts: [legacySubmission]
      }
    };
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(conversation, null, 2)}\n`,
      { mode: 0o600 }
    );
    const ledger: TerminalDispatchLedgerDocument = {
      status: "enter_dispatched",
      message_id: "message-1",
      ...(input.ledgerAuthority !== undefined
        ? { callback_route_fingerprint: input.ledgerAuthority }
        : {})
    };
    let savedLedger: TerminalDispatchLedgerDocument | undefined;
    const facade = createTerminalAcceptanceCliFacade({
      native: {
        codexProvider: () => ({}),
        codexProcessIncarnation: () => {
          throw new Error("Codex identity is not expected");
        },
        assertExclusive: async () => undefined
      },
      terminal: {
        runtime: () => ({
          loadClaudeAgentRows: () => [],
          createBridge: () => bridge
        }),
        durableRequest: () => {
          throw new Error("synthetic acceptance must not inspect transcripts");
        },
        runtimeIdentity: () => ({})
      },
      authority: {
        assertTurnCurrent: () => undefined,
        terminalControl: () => control,
        isDiscoverableTurn: () => true,
        workspaceMatches: () => true
      },
      repository: {
        acquireStateLock: () => () => undefined,
        acquireTerminalLock: () => () => undefined,
        loadLedger: () => ledger,
        saveLedger: (_terminalControl, next) => {
          savedLedger = next;
        },
        reconcileLedger: (_terminalControl, current) => current,
        bindingFields: () => ({})
      },
      deferred: {
        recover: async () => {
          throw new Error("deferred recovery is not expected");
        },
        loadAuthority: () => {
          throw new Error("deferred authority is not expected");
        },
        assertLedgerAuthority: () => {
          throw new Error("deferred authority is not expected");
        },
        loadTransfer: () => {
          throw new Error("deferred transfer is not expected");
        }
      }
    } as unknown as TerminalAcceptanceCliDependencies);
    const reconcile = () => facade.reconcileMonitor({
      options: {},
      conversation,
      statePath,
      logPath,
      terminalControl: control,
      executor: resolveExecutor({ kind: "claude" }),
      terminalBridge: bridge
    });
    await runCliCommandExecution(input.name, {}, {
      env: {
        ...process.env,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
        AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
      },
      now: () => new Date("2026-08-15T00:00:03.000Z"),
      pid: process.pid,
      runtimeLog: () => undefined
    }, async () => {
      if (input.rejects) {
        await assert.rejects(
          reconcile,
          /callback route conflicts with its dispatch ledger/u
        );
        assert.equal(
          terminalBridgeSubmission(loadState(statePath))?.status,
          "enter_dispatched"
        );
        assert.equal(savedLedger, undefined);
        return;
      }
      const result = await reconcile();
      assert.equal(result.outcome, "accepted");
      const authority = callbackRouteFingerprintForConversation(conversation) ??
        null;
      assert.equal(
        terminalBridgeSubmission(loadState(statePath))
          ?.callback_route_fingerprint,
        authority
      );
      assert.equal(savedLedger?.callback_route_fingerprint, authority);
    });
  }

  await runCase({ name: "legacy-acceptance-routed", routed: true });
  await runCase({ name: "legacy-acceptance-no-route", routed: false });
  await runCase({
    name: "legacy-acceptance-route-mismatch",
    routed: true,
    ledgerAuthority: `sha256:${"f".repeat(64)}`,
    rejects: true
  });
});

test("service declarations remain data-only and the facade exposes no raw any", () => {
  const declaration = fs.readFileSync(
    new URL("../src/terminal-acceptance-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    declaration,
    /\bany\b|Record<[^>]*any|ResolvedTerminalConversation/u
  );
  for (const file of [
    "terminal-acceptance-application-service.js",
    "managed-turn-recovery-service.js"
  ]) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /node:fs|node:path|\.\/store\.js|\.\/session-store\.js|Record<[^>]*any|ResolvedTerminalConversation/u
    );
  }
});

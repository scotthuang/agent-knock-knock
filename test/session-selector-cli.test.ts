import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  applyMessageToConversation,
  createConversation,
  createMessage,
  type ExecutorKind
} from "../src/protocol.js";
import {
  appendEvent,
  loadState,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";
import {
  managedSessionStatesFromConversations
} from "../src/managed-session.js";
import {
  pathsForManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import type {
  ActiveAgentSessionIdentity,
  CodexOpenRootRolloutInventory
} from "../src/agent-session-provider.js";
import type {
  CodexLocalSessionAdapter
} from "../src/codex-local-session-provider.js";
import {
  createTerminalEndpointRef,
  terminalControlEvidence,
  tmuxTerminalRouteKey,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";
import { runInProcessCli } from "./in-process-cli-fixtures.js";

const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-selector-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("CLI omission and short refs resolve one actionable managed session", async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-only-"));

  try {
    const created = storeConversationFixture({
      storeDir,
      request: "Review the selector",
      agent: "codex"
    });
    const listed = await runCli([
      "list",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.deepEqual(listed.terminals, []);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    const managedTurn = listed.unavailable_managed_turns[0];
    assert.equal(managedTurn.source, "managed_turn");
    assert.match(managedTurn.short_ref, /^@[0-9a-f]{10}$/u);
    assert.equal(
      managedTurn.conversation_id,
      created.conversation.conversation_id
    );
    assert.deepEqual(
      Object.keys(managedTurn.available_actions),
      ["status", "close"]
    );

    const implicit = await runCli([
      "status",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      implicit.summary.conversation_id,
      created.conversation.conversation_id
    );

    const short = await runCli([
      "status",
      "--conversation",
      managedTurn.short_ref,
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      short.summary.conversation_id,
      created.conversation.conversation_id
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("unavailable managed turns expose only pane-independent actions", async () => {
  const cases = [
    {
      status: "waiting_for_agent",
      actions: ["status", "close"]
    },
    {
      status: "idle",
      actions: ["status", "close"]
    },
    {
      status: "stalled",
      actions: ["status", "close"]
    },
    {
      status: "callback_failed",
      actions: ["status", "retry_callback", "close"]
    },
    {
      status: "waiting_for_agent",
      callbackRetry: true,
      actions: ["status", "retry_callback", "close"]
    },
    {
      status: "closed",
      actions: ["status"]
    }
  ];

  for (const testCase of cases) {
    const storeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `akk-list-actions-${testCase.status}-`)
    );
    try {
      const created = storeConversationFixture({
        storeDir,
        request: `Exercise ${testCase.status} actions`,
        agent: "codex"
      });
      const state = JSON.parse(
        fs.readFileSync(created.paths.statePath, "utf8")
      );
      state.status = testCase.status;
      if (["waiting_for_agent", "idle", "stalled"].includes(testCase.status)) {
        state.native_session_takeover = terminalBridgeTakeover(
          created.conversation.conversation_id,
          created.conversation.workspace
        );
      }
      if (
        testCase.status === "callback_failed" ||
        ("callbackRetry" in testCase && testCase.callbackRetry)
      ) {
        state.callback_delivery = {
          status: "failed",
          attempts: 1,
          final_status: testCase.status === "callback_failed"
            ? "idle"
            : testCase.status,
          ...("callbackRetry" in testCase && testCase.callbackRetry
            ? { preserve_conversation_status: true }
            : {}),
          message: callbackMessage(
            created.conversation.conversation_id,
            "codex"
          )
        };
      }
      saveState(created.paths.statePath, state);

      const listed = await runCli([
        "list",
        "--all",
        "--managed-only",
        "--store-dir",
        storeDir
      ]);
      assert.equal(
        listed.unavailable_managed_turns.length,
        1,
        testCase.status
      );
      const entry = listed.unavailable_managed_turns[0];
      assert.equal(entry.source, "managed_turn", testCase.status);
      assert.deepEqual(
        Object.keys(entry.available_actions),
        testCase.actions,
        testCase.status
      );
      for (const action of testCase.actions) {
        const argumentsValue = entry.available_actions[action].arguments;
        const targetKey = "turn_id";
        assert.deepEqual(
          Object.keys(argumentsValue),
          [targetKey],
          `${testCase.status}:${action}:argument keys`
        );
        assert.equal(
          argumentsValue[targetKey],
          entry.id,
          `${testCase.status}:${action}`
        );
      }
      assert.equal(entry.available_actions.follow_up, undefined);
      assert.equal(entry.available_actions.approve, undefined);
      assert.equal(entry.available_actions.cancel, undefined);
      assert.equal(entry.available_actions.renew, undefined);
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  }
});

test("unavailable managed Claude turns never advertise terminal approval", async () => {
  const cases = [
    {
      name: "waiting for agent",
      status: "waiting_for_agent",
      decisionMode: "keys",
      available: false
    },
    {
      name: "missing keys decision",
      status: "waiting_for_openclaw",
      decisionMode: undefined,
      available: false
    },
    {
      name: "ready for explicit approval",
      status: "waiting_for_openclaw",
      decisionMode: "keys",
      available: true
    },
    {
      name: "expired approval record",
      status: "waiting_for_openclaw",
      decisionMode: "keys",
      expired: true,
      hideCancel: true,
      available: false
    },
    {
      name: "missing approval fingerprint",
      status: "waiting_for_openclaw",
      decisionMode: "keys",
      missingFingerprint: true,
      hideCancel: true,
      available: false
    },
    {
      name: "missing approval timestamp",
      status: "waiting_for_openclaw",
      decisionMode: "keys",
      missingTimestamp: true,
      hideCancel: true,
      available: false
    }
  ];

  for (const testCase of cases) {
    const storeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "akk-list-managed-approval-")
    );
    try {
      const created = storeConversationFixture({
        storeDir,
        request: `Exercise managed approval: ${testCase.name}`,
        agent: "claude"
      });
      const state = JSON.parse(
        fs.readFileSync(created.paths.statePath, "utf8")
      );
      state.status = testCase.status;
      state.native_session_takeover = {
        ...terminalBridgeTakeover(
          created.conversation.conversation_id,
          created.conversation.workspace
        ),
        terminal_bridge_approval: {
          ...("missingFingerprint" in testCase
            ? {}
            : { fingerprint: "fresh-managed-approval" }),
          ...("missingTimestamp" in testCase
            ? {}
            : {
                notified_at: "expired" in testCase
                  ? "2020-01-01T00:00:00.000Z"
                  : new Date().toISOString()
              }),
          approval_state: {
            scanned: true,
            blocked: true,
            approvable: true,
            ...(testCase.decisionMode
              ? { decision_mode: testCase.decisionMode }
              : {}),
            reason: "current visible prompt"
          }
        }
      };
      saveState(created.paths.statePath, state);

      const listed = await runCli([
        "list",
        "--managed-only",
        "--store-dir",
        storeDir
      ]);
      const entry = listed.unavailable_managed_turns[0];
      assert.deepEqual(
        Object.keys(entry.available_actions),
        ["status", "close"],
        testCase.name
      );
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  }
});

test("CLI latest is deterministic and omission fails closed on ambiguity", async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-latest-"));

  try {
    const older = storeConversationFixture({
      storeDir,
      request: "Older task",
      agent: "claude"
    });
    const newer = storeConversationFixture({
      storeDir,
      request: "Newer task",
      agent: "codex"
    });
    updateTimestamp(older.conversation.state_path, "2026-07-28T01:00:00.000Z");
    updateTimestamp(newer.conversation.state_path, "2026-07-28T02:00:00.000Z");

    const latest = await runCli([
      "status",
      "--conversation",
      "latest",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      latest.summary.conversation_id,
      newer.conversation.conversation_id
    );

    const ambiguous = await runCliResult([
      "status",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /omitted session selector is ambiguous/u);
    assert.match(ambiguous.stderr, /@[\da-f]{10}/u);
    assert.match(ambiguous.stderr, /Older task/u);
    assert.match(ambiguous.stderr, /Newer task/u);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("legacy unsupported executors do not break live terminal short refs", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-legacy-"));
  const storeDir = path.join(tempDir, "store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-live:0.0";
  const codexPid = 2222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› \u001b[2mReady for the next task\u001b[22m\n\ngpt-5.6-sol high · /repo"
  });
  const legacyPaths = pathsForConversation("task-legacy-cursor", storeDir);
  const idleLegacyPaths = pathsForConversation(
    "task-legacy-cursor-idle",
    storeDir
  );
  const acpxCodexPaths = pathsForConversation(
    "task-legacy-codex-acpx",
    storeDir
  );

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const nativeIdentity = materializeIdleCodexIdentity({
      workspace,
      codexPid
    });
    saveState(legacyPaths.statePath, {
      conversation_id: "task-legacy-cursor",
      user_request: "Historical Cursor task",
      openclaw_session: "agent:test:legacy",
      claude_session: "claude",
      executor: {
        kind: "cursor",
        actor: "cursor",
        session: "cursor",
        transport: "acpx"
      },
      workspace,
      status: "closed",
      response_rounds_used: 0,
      soft_limit: 50,
      hard_limit: 100,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:01:00.000Z",
      closed_at: "2026-06-20T00:01:00.000Z",
      store_dir: legacyPaths.storeDir,
      conversation_dir: legacyPaths.conversationDir,
      state_path: legacyPaths.statePath,
      event_log_path: legacyPaths.logPath
    } as any);
    saveState(idleLegacyPaths.statePath, {
      conversation_id: "task-legacy-cursor-idle",
      user_request: "Idle historical Cursor task",
      openclaw_session: "agent:test:legacy",
      claude_session: "claude",
      executor: {
        kind: "cursor",
        actor: "cursor",
        session: "cursor",
        transport: "acpx"
      },
      workspace,
      status: "idle",
      idle_since: "2026-06-20T00:00:00.000Z",
      response_rounds_used: 0,
      soft_limit: 50,
      hard_limit: 100,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:01:00.000Z",
      store_dir: idleLegacyPaths.storeDir,
      conversation_dir: idleLegacyPaths.conversationDir,
      state_path: idleLegacyPaths.statePath,
      event_log_path: idleLegacyPaths.logPath
    } as any);
    saveState(acpxCodexPaths.statePath, {
      conversation_id: "task-legacy-codex-acpx",
      user_request: "Historical ACPX Codex task",
      openclaw_session: "agent:test:legacy",
      claude_session: "claude",
      executor: {
        kind: "codex",
        actor: "codex",
        session: "codex",
        transport: "acpx"
      },
      workspace,
      status: "done",
      response_rounds_used: 0,
      soft_limit: 50,
      hard_limit: 100,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: "2026-06-20T00:01:00.000Z",
      store_dir: acpxCodexPaths.storeDir,
      conversation_dir: acpxCodexPaths.conversationDir,
      state_path: acpxCodexPaths.statePath,
      event_log_path: acpxCodexPaths.logPath
    } as any);

    const managedOnly = await runCli([
      "list",
      "--reconcile",
      "--all",
      "--managed-only",
      "--idle-timeout-minutes",
      "1",
      "--store-dir",
      storeDir
    ]);
    assert.equal(managedOnly.reconciliation.closed, 1);
    assert.deepEqual(managedOnly.terminals, []);
    assert.deepEqual(managedOnly.unavailable_managed_turns, []);
    assert.equal("delegated" in managedOnly, false);
    assert.equal("tasks" in managedOnly, false);

    const listed = await runCliWithCodexInventory([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ], { codexPid, nativeIdentity, workspace });
    assert.deepEqual(listed.unavailable_managed_turns, []);
    assert.equal(listed.terminals.length, 1);
    assert.match(listed.terminals[0].short_ref, /^@[0-9a-f]{10}$/u);
    const sendAction = listed.terminals[0].available_actions.send;
    assert.equal(sendAction.scope, "terminal_user_explicit");
    assert.equal(sendAction.arguments.selector, listed.terminals[0].id);
    assert.equal(
      typeof sendAction.arguments.expected_terminal_token,
      "string"
    );
    assert.equal(sendAction.arguments.session_id, undefined);

    const sent = await runCliWithCodexInventory([
      "send",
      "--conversation",
      listed.terminals[0].short_ref,
      "--message",
      "Inspect the current git status",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:legacy",
      "--openclaw-session",
      "agent:test:legacy",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ], { codexPid, nativeIdentity, workspace });
    assert.equal(
      sent.conversation.native_session_takeover.native_session_id,
      listed.terminals[0].id
    );
    assert.equal(sent.conversation.executor.kind, "codex");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an unsupported legacy record without a dispatch ledger does not hide its tmux pane", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-legacy-owner-")
  );
  const storeDir = path.join(tempDir, "store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "legacy-owned:0.0";
  const codexPid = 2222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› \u001b[2mReady for the next task\u001b[22m\n\ngpt-5.6-sol high · /repo"
  });
  const legacyPaths = pathsForConversation(
    "task-active-legacy-cursor",
    storeDir
  );

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const nativeIdentity = materializeIdleCodexIdentity({
      workspace,
      codexPid
    });
    saveState(legacyPaths.statePath, {
      conversation_id: "task-active-legacy-cursor",
      user_request: "Active historical Cursor task",
      openclaw_session: "agent:test:legacy-owner",
      claude_session: "claude",
      executor: {
        kind: "cursor",
        actor: "cursor",
        session: "cursor",
        transport: "acpx"
      },
      workspace,
      status: "waiting_for_agent",
      response_rounds_used: 0,
      soft_limit: 50,
      hard_limit: 100,
      created_at: "2026-06-20T00:00:00.000Z",
      updated_at: new Date().toISOString(),
      native_session_takeover: {
        terminal_bridge: true,
        terminal_bridge_message_id: "legacy-message",
        terminal_control: {
          ...terminalPane(terminalTarget, workspace),
          capabilities: [
            "screen_status",
            "send_keys",
            "terminal_cancel"
          ]
        }
      },
      store_dir: legacyPaths.storeDir,
      conversation_dir: legacyPaths.conversationDir,
      state_path: legacyPaths.statePath,
      event_log_path: legacyPaths.logPath
    } as any);

    const listed = await runCliWithCodexInventory([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ], { codexPid, nativeIdentity, workspace });
    assert.equal(listed.terminals.length, 1);
    assert.equal(listed.terminals[0].management_state, "unmanaged");
    assert.deepEqual(listed.terminals[0].managed, {
      session_id: null,
      session_short_ref: null,
      current_turn: null,
      recent_turn: null,
      turn_count: 0,
      hidden_turn_count: 0,
      session_count: 0,
      history: []
    });
    const sendAction = listed.terminals[0].available_actions.send;
    assert.equal(sendAction.scope, "terminal_user_explicit");
    assert.equal(sendAction.arguments.selector, listed.terminals[0].id);
    assert.equal(
      typeof sendAction.arguments.expected_terminal_token,
      "string"
    );
    assert.equal(sendAction.arguments.session_id, undefined);
    assert.deepEqual(listed.unavailable_managed_turns, []);

    const sent = await runCliWithCodexInventory([
      "send",
      "--conversation",
      "only",
      "--message",
      "Do not double-dispatch this task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:legacy-owner",
      "--openclaw-session",
      "agent:test:legacy-owner",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ], { codexPid, nativeIdentity, workspace });
    assert.equal(
      sent.conversation.native_session_takeover.native_session_id,
      listed.terminals[0].id
    );
    assert.notEqual(
      sent.conversation.conversation_id,
      "task-active-legacy-cursor"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI keeps an owned terminal visible and routes its canonical actions to the ledger owner", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-managed-pane-"));
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-managed:0.0";
  const codexPid = 2222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = await runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`,
      "--message",
      "Continue the managed task",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:selector",
      "--openclaw-session",
      "agent:test:selector",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ]);
    const managedId = sent.conversation.conversation_id;
    assert.notEqual(managedId, sent.conversation.native_session_takeover.native_session_id);

    const listed = await runCli([
      "list",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.equal(listed.terminals.length, 1);
    const terminal = listed.terminals[0];
    assert.equal(terminal.source, "terminal");
    assert.equal(terminal.management_state, "managed");
    assert.equal(terminal.managed.current_turn.id, managedId);
    assert.equal(terminal.managed.current_turn.source, "managed_turn");
    assert.equal(terminal.managed.recent_turn, null);
    assert.equal(terminal.managed.turn_count, 1);
    assert.equal(terminal.managed.hidden_turn_count, 0);
    assert.equal(terminal.available_actions.send, undefined);
    assert.deepEqual(
      terminal.available_actions.status.arguments,
      { turn_id: managedId }
    );
    assert.deepEqual(
      terminal.available_actions.cancel.arguments,
      { turn_id: managedId }
    );
    assert.deepEqual(listed.unavailable_managed_turns, []);

    const approvalListed = await runCli([
      "list",
      "--store-dir",
      storeDir,
      ...codexTerminalStaticArgs({
        workspace,
        terminalTarget,
        codexPid,
        screen: [
          "Would you like to run the following command?",
          "",
          "› 1. Yes, allow (y)",
          "  2. No (n)"
        ].join("\n")
      })
    ]);
    const approvalTerminal = approvalListed.terminals[0];
    assert.equal(approvalTerminal.management_state, "managed");
    assert.equal(
      approvalTerminal.managed.current_turn.approval_state.approvable,
      true
    );
    assert.deepEqual(
      approvalTerminal.available_actions.approve.arguments,
      { turn_id: managedId }
    );
    assert.deepEqual(
      approvalTerminal.available_actions.approve.before_call.arguments,
      { turn_id: managedId }
    );
    assert.deepEqual(
      approvalTerminal.managed.current_turn.available_actions.approve.arguments,
      { turn_id: managedId }
    );

    const restartedListed = await runCli([
      "list",
      "--store-dir",
      storeDir,
      ...codexTerminalStaticArgs({
        workspace,
        terminalTarget,
        codexPid: codexPid + 1,
        screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
      })
    ]);
    const restartedTerminal = restartedListed.terminals[0];
    assert.equal(restartedTerminal.management_state, "conflict");
    assert.equal(
      restartedTerminal.management_conflict.owner_conversation_id,
      managedId
    );
    assert.equal(restartedTerminal.managed.current_turn, null);
    assert.deepEqual(
      Object.keys(restartedTerminal.available_actions),
      ["status"]
    );

    const status = await runCli([
      "status",
      "--conversation",
      "only",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);

    assert.equal(status.summary.conversation_id, managedId);
    assert.equal(status.conversation.conversation_id, managedId);
    assert.equal(status.terminal_status.target, terminalTarget);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a canonical managed owner survives a tmux route rename without rebinding", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-managed-route-rename-")
  );
  const storeDir = path.join(tempDir, "conversations");
  const workspace = path.join(tempDir, "workspace");
  const originalTarget = "codex-before-rename:0.0";
  const renamedTarget = "codex-after-rename:4.2";
  const serverSocketPath = path.join(tempDir, "tmux-server.sock");
  const paneId = "%42";
  const codexPid = 2422;
  const originalRuntimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget: originalTarget,
    codexPid,
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo",
    serverSocketPath,
    paneId
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = await runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${originalTarget}:${codexPid}`,
      "--message",
      "Keep ownership across a route rename",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:route-rename",
      "--openclaw-session",
      "agent:test:route-rename",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...originalRuntimeArgs
    ]);
    const managedId = sent.conversation.conversation_id;
    const persistedEndpoint =
      sent.conversation.native_session_takeover.terminal_endpoint;
    assert.equal(persistedEndpoint.pane_id, paneId);
    assert.equal(persistedEndpoint.server_socket_path, serverSocketPath);

    // Simulate a v0.11.x Turn, Session, and resolved dispatch ledger. The next
    // verified response must refine both Store records and promote the ledger
    // before a later route rename can hide its owner fence.
    const statePath = String(sent.conversation.state_path);
    const legacyTurn = JSON.parse(fs.readFileSync(statePath, "utf8"));
    delete legacyTurn.native_session_takeover.terminal_endpoint;
    legacyTurn.status = "waiting_for_openclaw";
    saveState(statePath, legacyTurn);

    const sessionId = String(sent.conversation.session_id);
    const sessionPath = pathsForManagedSession(sessionId, storeDir).statePath;
    const legacySession = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    delete legacySession.binding.terminal_endpoint;
    fs.writeFileSync(sessionPath, `${JSON.stringify(legacySession, null, 2)}\n`);

    const canonicalLedgerKey = createHash("sha256")
      .update(JSON.stringify({
        version: 1,
        provider_kind: persistedEndpoint.kind,
        endpoint_key: persistedEndpoint.endpoint_key,
        resource_key: persistedEndpoint.resource_key
      }))
      .digest("hex")
      .slice(0, 20);
    const legacyLedgerKey = createHash("sha256")
      .update(JSON.stringify({ target: originalTarget, socket_path: null }))
      .digest("hex")
      .slice(0, 20);
    const ledgerDir = path.join(testRuntimeDir, "terminal-dispatch");
    const canonicalLedgerPath = path.join(
      ledgerDir,
      `terminal-dispatch-${canonicalLedgerKey}.json`
    );
    const legacyLedgerPath = path.join(
      ledgerDir,
      `terminal-dispatch-${legacyLedgerKey}.json`
    );
    const legacyLedger = JSON.parse(
      fs.readFileSync(canonicalLedgerPath, "utf8")
    );
    legacyLedger.version = 1;
    legacyLedger.terminal_key = legacyLedgerKey;
    delete legacyLedger.terminal_endpoint;
    for (const receipt of legacyLedger.terminal_submission_receipts ?? []) {
      delete receipt.terminal_endpoint;
    }
    fs.renameSync(canonicalLedgerPath, legacyLedgerPath);
    fs.writeFileSync(
      legacyLedgerPath,
      `${JSON.stringify(legacyLedger, null, 2)}\n`
    );

    const responded = await runCli([
      "respond",
      "--turn",
      managedId,
      "--message",
      "Refine the legacy endpoint before continuing",
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor",
      ...originalRuntimeArgs
    ]);
    assert.equal(responded.conversation.status, "waiting_for_agent");
    const refinedTurn = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const refinedSession = JSON.parse(fs.readFileSync(sessionPath, "utf8"));
    assert.equal(refinedTurn.native_session_takeover.terminal_endpoint.pane_id, paneId);
    assert.equal(refinedSession.binding.terminal_endpoint.pane_id, paneId);
    assert.equal(fs.existsSync(legacyLedgerPath), false);
    assert.equal(fs.existsSync(canonicalLedgerPath), true);
    assert.equal(
      JSON.parse(fs.readFileSync(canonicalLedgerPath, "utf8")).version,
      2
    );

    const renamedRuntimeArgs = codexTerminalStaticArgs({
      workspace,
      terminalTarget: renamedTarget,
      codexPid,
      screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo",
      serverSocketPath,
      paneId
    });
    const listed = await runCli([
      "list",
      "--store-dir",
      storeDir,
      ...renamedRuntimeArgs
    ]);

    assert.equal(listed.terminals.length, 1);
    assert.equal(listed.unavailable_managed_turns.length, 0);
    const terminal = listed.terminals[0];
    assert.equal(terminal.id, `terminal:v2:tmux:codex:${renamedTarget}:${codexPid}`);
    assert.equal(terminal.management_state, "managed");
    assert.equal(terminal.managed.current_turn.id, managedId);
    assert.equal(terminal.management_conflict, undefined);
    assert.deepEqual(
      terminal.available_actions.status.arguments,
      { turn_id: managedId }
    );

    const status = await runCli([
      "status",
      "--conversation",
      "only",
      "--store-dir",
      storeDir,
      ...renamedRuntimeArgs
    ]);
    assert.equal(status.summary.conversation_id, managedId);
    assert.equal(status.terminal_status.target, renamedTarget);

    assert.equal(terminal.managed.turn_count, 1);
    assert.equal(terminal.managed.hidden_turn_count, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a cross-store terminal owner is visible but never advertised as locally actionable", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-cross-store-owner-")
  );
  const ownerStoreDir = path.join(tempDir, "owner-store");
  const observerStoreDir = path.join(tempDir, "observer-store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = `codex-cross-store-${process.pid}:0.0`;
  const codexPid = 3222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
    const sent = await runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`,
      "--message",
      "Own this terminal from another store",
      "--background",
      "--store-dir",
      ownerStoreDir,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ]);
    const ownerId = sent.conversation.conversation_id;

    const listed = await runCli([
      "list",
      "--store-dir",
      observerStoreDir,
      ...runtimeArgs
    ]);
    assert.equal(listed.terminals.length, 1);
    const terminal = listed.terminals[0];
    assert.equal(terminal.management_state, "conflict");
    assert.equal(
      terminal.management_conflict.owner_conversation_id,
      ownerId
    );
    assert.equal(terminal.managed.current_turn, null);
    assert.deepEqual(Object.keys(terminal.available_actions), ["status"]);
    assert.deepEqual(
      terminal.available_actions.status.arguments,
      { conversation_id: terminal.id }
    );

    const status = await runCli([
      "status",
      "--conversation",
      "only",
      "--store-dir",
      observerStoreDir,
      ...runtimeArgs
    ]);
    assert.equal(status.source, "terminal_control");
    assert.equal(status.conversation_id, terminal.id);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("multiple idle turns stay terminal history while user-priority Send keeps its managed fast path", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-terminal-history-")
  );
  const storeDir = path.join(tempDir, "store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-history:0.0";
  const codexPid = 2222;
  const managedSessionId = "session-selector-history";
  const stableTerminalIdentity = {
    serverSocketPath: path.join(tempDir, "tmux-server.sock"),
    paneId: "%42"
  };
  const nativeIdentity = codexNativeIdentityFixture({
    workspace,
    codexPid
  });
  nativeIdentity.processUuid =
    `codex-pid:${codexPid}:birth:${nativeIdentity.processBirth}`;
  nativeIdentity.rollout.device = "16777231";
  nativeIdentity.rollout.inode = String(100_000 + codexPid);
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› \u001b[2mReady for the next task\u001b[22m\n\ngpt-5.6-sol high · /repo",
    ...stableTerminalIdentity
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(path.dirname(nativeIdentity.rollout.path), {
      recursive: true
    });
    fs.writeFileSync(
      nativeIdentity.rollout.path,
      `${JSON.stringify({
        timestamp: "2026-07-28T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: nativeIdentity.sessionId,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli"
        }
      })}\n`
    );
    const rolloutStat = fs.statSync(nativeIdentity.rollout.path);
    nativeIdentity.rollout.device = String(rolloutStat.dev);
    nativeIdentity.rollout.inode = String(rolloutStat.ino);
    const older = storeConversationFixture({
      storeDir,
      request: "Older completed turn",
      agent: "codex",
      sessionId: managedSessionId
    });
    const newer = storeConversationFixture({
      storeDir,
      request: "Newer completed turn",
      agent: "codex",
      sessionId: managedSessionId
    });
    for (const [fixture, timestamp] of [
      [older, "2026-07-28T01:00:00.000Z"],
      [newer, "2026-07-28T02:00:00.000Z"]
    ] as const) {
      const state = JSON.parse(
        fs.readFileSync(fixture.paths.statePath, "utf8")
      );
      const takeover = terminalBridgeTakeover(
        fixture.conversation.conversation_id,
        workspace
      );
      state.status = "idle";
      state.gateway_method = undefined;
      state.gateway_session = undefined;
      delete state.callback_delivery;
      state.workspace = workspace;
      state.idle_since = timestamp;
      state.updated_at = timestamp;
      const terminalControl = {
        ...takeover.terminal_control,
        ...terminalPane(terminalTarget, workspace)
      } as TerminalControlRef;
      state.native_session_takeover = {
        ...takeover,
        terminal_agent_pid: codexPid,
        terminal_agent_session_id: nativeIdentity.sessionId,
        terminal_agent_process_uuid: nativeIdentity.processUuid,
        terminal_agent_process_birth: nativeIdentity.processBirth,
        terminal_agent_rollout: nativeIdentity.rollout,
        terminal_agent_identity_evidence: nativeIdentity.evidence,
        native_session_id:
          `terminal:v2:tmux:codex:${terminalTarget}:${codexPid}`,
        terminal_control: terminalControl,
        terminal_endpoint: canonicalTmuxTerminalEndpointEvidence(
          terminalControl,
          stableTerminalIdentity
        )
      };
      saveState(fixture.paths.statePath, state);
    }
    const [managedSession] = managedSessionStatesFromConversations([
      loadState(older.paths.statePath),
      loadState(newer.paths.statePath)
    ]);
    saveManagedSession(storeDir, managedSession, { expectedRevision: null });
    for (const fixture of [older, newer]) {
      const state = loadState(fixture.paths.statePath);
      saveState(fixture.paths.statePath, {
        ...state,
        terminal_binding_id: managedSession.binding?.binding_id,
        terminal_binding_generation: managedSession.binding?.generation,
        native_thread_id: managedSession.binding?.native_thread_id
      });
    }

    const listed = await runCliWithCodexInventory([
      "list",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ], {
      codexPid,
      nativeIdentity,
      workspace
    });
    assert.equal(listed.terminals.length, 1);
    assert.deepEqual(listed.unavailable_managed_turns, []);
    const terminal = listed.terminals[0];
    assert.equal(terminal.management_state, "managed");
    assert.equal(terminal.managed.current_turn, null);
    assert.equal(
      terminal.managed.recent_turn.conversation_id,
      newer.conversation.conversation_id
    );
    assert.equal(terminal.managed.recent_turn.source, "managed_turn");
    assert.equal(terminal.managed.session_id, managedSessionId);
    assert.equal(
      terminal.managed.recent_turn.available_actions.follow_up,
      undefined
    );
    assert.equal(terminal.managed.turn_count, 2);
    assert.equal(terminal.managed.hidden_turn_count, 1);
    assert.equal("history" in terminal.managed, false);
    assert.equal(
      terminal.available_actions.send.arguments.selector,
      terminal.id
    );
    assert.equal(
      typeof terminal.available_actions.send.arguments
        .expected_terminal_token,
      "string"
    );
    assert.equal(
      typeof terminal.available_actions.send.arguments
        .expected_managed_terminal_token,
      "string"
    );
    assert.equal(
      terminal.available_actions.send.scope,
      "terminal_user_explicit"
    );
    assert.equal(
      terminal.available_actions.send.arguments.session_id,
      undefined
    );

    const restartedPid = codexPid + 1;
    const restartedNativeIdentity = materializeIdleCodexIdentity({
      workspace,
      codexPid: restartedPid
    });

    const restarted = await runCliWithCodexInventory([
      "list",
      "--store-dir",
      storeDir,
      ...codexTerminalStaticArgs({
        workspace,
        terminalTarget,
        codexPid: restartedPid,
        screen: "› \u001b[2mReady for the next task\u001b[22m\n\ngpt-5.6-sol high · /repo",
        ...stableTerminalIdentity
      })
    ], {
      codexPid: restartedPid,
      nativeIdentity: restartedNativeIdentity,
      workspace
    });
    assert.equal(
      restarted.terminals[0].managed.recent_turn.conversation_id,
      newer.conversation.conversation_id
    );
    assert.equal(
      restarted.terminals[0].managed.recent_turn.available_actions.follow_up,
      undefined
    );
    assert.notEqual(
      restarted.terminals[0].available_actions.send,
      undefined,
      JSON.stringify(restarted.terminals[0], null, 2)
    );
    assert.equal(
      restarted.terminals[0].available_actions.send.arguments.selector,
      restarted.terminals[0].id
    );
    assert.equal(
      typeof restarted.terminals[0].available_actions.send.arguments
        .expected_terminal_token,
      "string"
    );
    assert.equal(
      restarted.terminals[0].available_actions.send.scope,
      "terminal_user_explicit"
    );

    const listedAll = await runCliWithCodexInventory([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ], {
      codexPid,
      nativeIdentity,
      workspace
    });
    const terminalAll = listedAll.terminals[0];
    assert.equal(terminalAll.managed.hidden_turn_count, 0);
    assert.deepEqual(
      terminalAll.managed.history.map((turn: any) => turn.conversation_id),
      [older.conversation.conversation_id]
    );
    assert.equal(
      terminalAll.managed.history[0].available_actions.follow_up,
      undefined
    );

    const rejectedTurnTarget = await runCliResult([
      "send",
      "--session",
      newer.conversation.turn_id,
      "--message",
      "Do not target an execution turn",
      "--background",
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ]);
    assert.notEqual(rejectedTurnTarget.status, 0);
    assert.match(
      rejectedTurnTarget.stderr,
      /not an ordinary send target/u
    );

    const followCurrentAction = terminalAll.available_actions.send;
    assert.equal(followCurrentAction.arguments.selector, terminalAll.id);
    assert.equal(
      typeof followCurrentAction.arguments.expected_terminal_token,
      "string"
    );
    assert.equal(
      typeof followCurrentAction.arguments.expected_managed_terminal_token,
      "string"
    );
    assert.equal(followCurrentAction.scope, "terminal_user_explicit");
    const sent = await runCliWithCodexInventory([
      "send",
      "--conversation",
      String(followCurrentAction.arguments.selector),
      "--expected-terminal-token",
      String(followCurrentAction.arguments.expected_terminal_token),
      "--message",
      "Start a new independent turn",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:history",
      "--openclaw-session",
      "agent:test:history",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      ...runtimeArgs
    ], {
      codexPid,
      nativeIdentity,
      workspace
    });
    assert.equal(
      sent.conversation.native_session_takeover.native_session_id,
      terminal.id
    );
    assert.notEqual(sent.session_id, managedSessionId);
    assert.equal(sent.turn_id, sent.conversation.turn_id);
    assert.notEqual(
      sent.conversation.conversation_id,
      older.conversation.conversation_id
    );
    assert.notEqual(
      sent.conversation.conversation_id,
      newer.conversation.conversation_id
    );

    const canonicalStatus = await runCli([
      "status",
      "--conversation",
      sent.conversation.conversation_id,
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.equal(
      canonicalStatus.summary.conversation_id,
      sent.conversation.conversation_id
    );

    const historicalStatus = await runCli([
      "status",
      "--conversation",
      terminalAll.managed.history[0].short_ref,
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(
      historicalStatus.summary.conversation_id,
      older.conversation.conversation_id
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI approve only and short refs stay on the managed Claude approval path", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-managed-approve-"));
  const storeDir = path.join(tempDir, "conversations");
  const claudeHome = path.join(tempDir, ".claude");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "claude-managed:0.0";
  const claudePid = 42300;
  const claudeSessionId = "44444444-4444-4444-8444-444444444444";
  const approvalScreen = [
    " Bash command",
    "",
    "   npm test",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. No"
  ].join("\n");
  const sendRuntimeArgs = claudeTerminalStaticArgs({
    workspace,
    terminalTarget,
    claudePid,
    claudeSessionId,
    screen: "❯ "
  });
  const approvalRuntimeArgs = claudeTerminalStaticArgs({
    workspace,
    terminalTarget,
    claudePid,
    claudeSessionId,
    screen: approvalScreen
  });

  try {
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true });
    const sent = await runCli([
      "send",
      "--conversation",
      `terminal:v2:tmux:claude:${terminalTarget}:${claudePid}`,
      "--message",
      "Run the focused tests",
      "--background",
      "--store-dir",
      storeDir,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:test:selector",
      "--openclaw-session",
      "agent:test:selector",
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor",
      "--claude-home",
      claudeHome,
      ...sendRuntimeArgs
    ]);
    const managedId = sent.conversation.conversation_id;
    const listed = await runCli([
      "list",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    const managedTurn = listed.unavailable_managed_turns[0];
    assert.equal(managedTurn.conversation_id, managedId);

    for (const selector of ["only", managedTurn.short_ref]) {
      const approved = await runCli([
        "approve",
        "--conversation",
        selector,
        "--store-dir",
        storeDir,
        "--disable-terminal-bridge-monitor",
        "--claude-home",
        claudeHome,
        ...approvalRuntimeArgs
      ]);

      assert.equal(approved.conversation.conversation_id, managedId, selector);
      assert.equal(approved.approved, false, selector);
      assert.equal(approved.blocked, true, selector);
      assert.match(
        approved.reason,
        /current managed-turn approval notification/u,
        selector
      );
      assert.doesNotMatch(approved.reason, /send --background/u, selector);
      assert.equal(approved.source, undefined, selector);
      assert.equal(approved.conversation_id, undefined, selector);
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function updateTimestamp(statePath: string, timestamp: string): void {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.updated_at = timestamp;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function storeConversationFixture(options: {
  storeDir: string;
  request: string;
  agent: ExecutorKind;
  sessionId?: string;
}) {
  const now = new Date("2026-07-28T00:00:00.000Z");
  const base = createConversation({
    userRequest: options.request,
    sessionId: options.sessionId,
    executorKind: options.agent,
    executorSession: `${options.agent}-selector`,
    now
  });
  const message = createMessage({
    conversation: base,
    from: "openclaw",
    to: base.executor.actor,
    type: "task",
    body: options.request,
    now
  });
  const paths = pathsForConversation(base.conversation_id, options.storeDir);
  const conversation = {
    ...applyMessageToConversation(base, message, now),
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  saveState(paths.statePath, conversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation
  });
  appendEvent(paths.logPath, messageEvent(message));
  return { conversation, paths };
}

async function runCli(args: string[]): Promise<Record<string, any>> {
  const result = await runCliResult(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

async function runCliWithCodexInventory(
  args: string[],
  options: {
    codexPid: number;
    nativeIdentity: Record<string, any>;
    workspace: string;
  }
): Promise<Record<string, any>> {
  const identity = options.nativeIdentity as ActiveAgentSessionIdentity;
  const root = {
    ...identity,
    processUuid: String(identity.processUuid),
    processBirth: String(identity.processBirth),
    rollout: identity.rollout!,
    evidence: "codex_open_root_rollout" as const
  };
  const authority = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
    version: 1 as const,
    pid: options.codexPid,
    processUuid: root.processUuid,
    processBirth: root.processBirth,
    cwd: path.resolve(options.workspace),
    roots: [root] as [typeof root]
  };
  const inventory: CodexOpenRootRolloutInventory = {
    ...authority,
    status: "resolved",
    inventoryFingerprint: createHash("sha256")
      .update(JSON.stringify(authority))
      .digest("hex")
  };
  const adapter: CodexLocalSessionAdapter = {
    listThreadRows: async () => [],
    readRollout: async () => undefined,
    listProcessSnapshots: async () => [],
    resolveActiveSessionIdentityForPid: async (pid) =>
      pid === options.codexPid ? identity : undefined,
    inspectOpenRootRolloutInventoryForPid: async (pid, cwd) => {
      assert.equal(pid, options.codexPid);
      assert.equal(path.resolve(cwd ?? options.workspace), authority.cwd);
      return inventory;
    }
  };
  const result = await runInProcessCli(args, {
    codexLocalSessionAdapter: adapter,
    codexProcessBirthForPid: (pid) => {
      assert.equal(pid, options.codexPid);
      return String(identity.processBirth);
    },
    env: {
      ...process.env,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runCliResult(args: string[]) {
  return runInProcessCli(args, {
    env: {
      ...process.env,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    }
  });
}

function codexTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  codexPid: number;
  screen: string;
  serverSocketPath?: string;
  paneId?: string;
}): string[] {
  const nativeIdentity = codexNativeIdentityFixture(options);
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.codexPid,
      ppid: 999,
      elapsed: "00:30",
      command: "codex",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([terminalPane(options.terminalTarget, options.workspace, {
      serverSocketPath: options.serverSocketPath,
      paneId: options.paneId
    })]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen }),
    "--codex-active-session-identities-json",
    JSON.stringify({ [options.codexPid]: nativeIdentity })
  ];
}

function codexNativeIdentityFixture(options: {
  workspace: string;
  codexPid: number;
}): Record<string, any> {
  const sessionId =
    `00000000-0000-4000-8000-${String(options.codexPid).padStart(12, "0")}`;
  return {
    sessionId,
    processUuid: `codex-process-${options.codexPid}`,
    processBirth: `fixture-process-birth-${options.codexPid}`,
    rollout: {
      fd: "17",
      device: `fixture-device-${options.codexPid}`,
      inode: String(100_000 + options.codexPid),
      path: path.join(
        options.workspace,
        ".codex",
        "sessions",
        `${sessionId}.jsonl`
      )
    },
    evidence: "static_exact_fixture"
  };
}

function materializeIdleCodexIdentity(options: {
  workspace: string;
  codexPid: number;
}): Record<string, any> {
  const identity = codexNativeIdentityFixture(options);
  fs.mkdirSync(path.dirname(identity.rollout.path), { recursive: true });
  fs.writeFileSync(identity.rollout.path, `${JSON.stringify({
    timestamp: "2026-07-28T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: identity.sessionId,
      cwd: options.workspace,
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.147.0"
    }
  })}\n`, { mode: 0o600 });
  const stat = fs.statSync(identity.rollout.path);
  identity.rollout.device = String(stat.dev);
  identity.rollout.inode = String(stat.ino);
  return identity;
}

function claudeTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  screen: string;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.claudePid,
      ppid: 999,
      elapsed: "00:30",
      command: "claude",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([terminalPane(options.terminalTarget, options.workspace)]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen }),
    "--claude-agents-json",
    JSON.stringify([{
      kind: "interactive",
      pid: options.claudePid,
      sessionId: options.claudeSessionId,
      startedAt: 1784870000000,
      cwd: options.workspace,
      status: "idle"
    }])
  ];
}

function terminalPane(
  target: string,
  workspace: string,
  stableIdentity: { serverSocketPath?: string; paneId?: string } = {}
) {
  const match = /^([^:]+):(\d+)\.(\d+)$/u.exec(target);
  assert.ok(match, `invalid test terminal target: ${target}`);
  return {
    kind: "tmux",
    target,
    session: match[1],
    window: Number(match[2]),
    pane: Number(match[3]),
    panePid: 999,
    currentCommand: "node",
    currentPath: workspace,
    ...(stableIdentity.serverSocketPath
      ? { serverSocketPath: stableIdentity.serverSocketPath }
      : {}),
    ...(stableIdentity.paneId ? { paneId: stableIdentity.paneId } : {})
  };
}

function canonicalTmuxTerminalEndpointEvidence(
  terminalControl: TerminalControlRef,
  stableIdentity: { serverSocketPath: string; paneId: string }
): Record<string, unknown> {
  assert.equal(terminalControl.kind, "tmux");
  const endpointKey = `socket:${stableIdentity.serverSocketPath}`;
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey: `pane-id:${stableIdentity.paneId}`
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
  return terminalControlEvidence(terminalControl) as unknown as
    Record<string, unknown>;
}

function terminalBridgeTakeover(
  conversationId: string,
  workspace: string
): Record<string, any> {
  return {
    terminal_bridge: true,
    terminal_bridge_message_id: `message-${conversationId}`,
    terminal_bridge_started_at: new Date().toISOString(),
    terminal_control: {
      kind: "tmux",
      target: "managed-actions:0.0",
      session: "managed-actions",
      window: 0,
      pane: 0,
      panePid: 999,
      currentCommand: "codex",
      currentPath: workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    }
  };
}

function callbackMessage(
  conversationId: string,
  from: "claude-code" | "codex"
): Record<string, any> {
  return {
    id: `callback-${conversationId}`,
    ts: new Date().toISOString(),
    conversation_id: conversationId,
    from,
    to: "openclaw",
    type: "done",
    requires_response: false,
    round: 1,
    max_rounds: 50,
    body: "Done",
    metadata: {}
  };
}

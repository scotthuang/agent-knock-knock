import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
import { saveManagedSession } from "../src/session-store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-selector-cli-runtime-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
});

test("CLI omission and short refs resolve one actionable managed session", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-only-"));

  try {
    const created = storeConversationFixture({
      storeDir,
      request: "Review the selector",
      agent: "codex"
    });
    const listed = runCli(["list", "--managed-only", "--store-dir", storeDir]);
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

    const implicit = runCli(["status", "--managed-only", "--store-dir", storeDir]);
    assert.equal(
      implicit.summary.conversation_id,
      created.conversation.conversation_id
    );

    const short = runCli([
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

test("unavailable managed turns expose only pane-independent actions", () => {
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

      const listed = runCli([
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

test("unavailable managed Claude turns never advertise terminal approval", () => {
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

      const listed = runCli([
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

test("CLI latest is deterministic and omission fails closed on ambiguity", () => {
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

    const latest = runCli([
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

    const ambiguous = spawnCli([
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

test("legacy unsupported executors do not break live terminal short refs", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-selector-cli-legacy-"));
  const storeDir = path.join(tempDir, "store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-live:0.0";
  const codexPid = 2222;
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
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

    const managedOnly = runCli([
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

    const listed = runCli([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.deepEqual(listed.unavailable_managed_turns, []);
    assert.equal(listed.terminals.length, 1);
    assert.match(listed.terminals[0].short_ref, /^@[0-9a-f]{10}$/u);

    const sent = runCli([
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
    ]);
    assert.equal(
      sent.conversation.native_session_takeover.native_session_id,
      listed.terminals[0].id
    );
    assert.equal(sent.conversation.executor.kind, "codex");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an unsupported legacy record without a dispatch ledger does not hide its tmux pane", () => {
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
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
  });
  const legacyPaths = pathsForConversation(
    "task-active-legacy-cursor",
    storeDir
  );

  try {
    fs.mkdirSync(workspace, { recursive: true });
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

    const listed = runCli([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
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
    assert.deepEqual(
      listed.terminals[0].available_actions.send.arguments,
      { selector: listed.terminals[0].id }
    );
    assert.deepEqual(listed.unavailable_managed_turns, []);

    const sent = runCli([
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
    ]);
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

test("CLI keeps an owned terminal visible and routes its canonical actions to the ledger owner", () => {
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
    const sent = runCli([
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

    const listed = runCli([
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

    const approvalListed = runCli([
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

    const restartedListed = runCli([
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

    const status = runCli([
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

test("a cross-store terminal owner is visible but never advertised as locally actionable", () => {
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
    const sent = runCli([
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

    const listed = runCli([
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

    const status = runCli([
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

test("multiple idle turns stay terminal history while the pane short ref routes to its managed session", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-terminal-history-")
  );
  const storeDir = path.join(tempDir, "store");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "codex-history:0.0";
  const codexPid = 2222;
  const managedSessionId = "session-selector-history";
  const nativeIdentity = codexNativeIdentityFixture({
    workspace,
    codexPid
  });
  const runtimeArgs = codexTerminalStaticArgs({
    workspace,
    terminalTarget,
    codexPid,
    screen: "› Ready for the next task\n\ngpt-5.6-sol high · /repo"
  });

  try {
    fs.mkdirSync(workspace, { recursive: true });
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
      state.workspace = workspace;
      state.idle_since = timestamp;
      state.updated_at = timestamp;
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
        terminal_control: {
          ...takeover.terminal_control,
          ...terminalPane(terminalTarget, workspace)
        }
      };
      saveState(fixture.paths.statePath, state);
    }
    const [managedSession] = managedSessionStatesFromConversations([
      loadState(older.paths.statePath),
      loadState(newer.paths.statePath)
    ]);
    saveManagedSession(storeDir, managedSession, { expectedRevision: null });

    const listed = runCli([
      "list",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
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
    assert.deepEqual(
      terminal.available_actions.send.arguments,
      { session_id: managedSessionId }
    );

    const restarted = runCli([
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
      undefined
    );
    assert.deepEqual(
      restarted.terminals[0].available_actions.send.arguments,
      { selector: restarted.terminals[0].id }
    );

    const listedAll = runCli([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
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

    const rejectedTurnTarget = spawnCli([
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

    const sent = runCli([
      "send",
      "--conversation",
      terminal.short_ref,
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
    ]);
    assert.equal(
      sent.conversation.native_session_takeover.native_session_id,
      terminal.id
    );
    assert.equal(sent.session_id, managedSessionId);
    assert.equal(sent.turn_id, sent.conversation.turn_id);
    assert.notEqual(
      sent.conversation.conversation_id,
      older.conversation.conversation_id
    );
    assert.notEqual(
      sent.conversation.conversation_id,
      newer.conversation.conversation_id
    );

    const canonicalStatus = runCli([
      "status",
      "--conversation",
      "only",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.equal(
      canonicalStatus.summary.conversation_id,
      sent.conversation.conversation_id
    );

    const historicalStatus = runCli([
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

test("CLI approve only and short refs stay on the managed Claude approval path", () => {
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
    const sent = runCli([
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
    const listed = runCli([
      "list",
      "--managed-only",
      "--store-dir",
      storeDir
    ]);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    const managedTurn = listed.unavailable_managed_turns[0];
    assert.equal(managedTurn.conversation_id, managedId);

    for (const selector of ["only", managedTurn.short_ref]) {
      const approved = runCli([
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

function runCli(args: string[]): Record<string, any> {
  const result = spawnCli(args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function spawnCli(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8"
  });
}

function codexTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  codexPid: number;
  screen: string;
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
    JSON.stringify([terminalPane(options.terminalTarget, options.workspace)]),
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

function terminalPane(target: string, workspace: string) {
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
    currentPath: workspace
  };
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

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
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";

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
    assert.equal(listed.delegated.length, 1);
    assert.match(listed.delegated[0].short_ref, /^@[0-9a-f]{10}$/u);
    assert.equal(
      listed.delegated[0].conversation_id,
      created.conversation.conversation_id
    );
    assert.deepEqual(
      Object.keys(listed.delegated[0].available_actions),
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
      listed.delegated[0].short_ref,
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

test("list action hints cover managed send, cancel, renew, retry, and close states", () => {
  const cases = [
    {
      status: "waiting_for_agent",
      actions: ["status", "cancel", "close"]
    },
    {
      status: "idle",
      actions: ["status", "send", "close"]
    },
    {
      status: "stalled",
      actions: ["status", "renew", "close"]
    },
    {
      status: "callback_failed",
      actions: ["status", "retry_callback", "close"]
    },
    {
      status: "waiting_for_agent",
      callbackRetry: true,
      actions: ["status", "cancel", "retry_callback", "close"]
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
      assert.equal(listed.delegated.length, 1, testCase.status);
      const entry = listed.delegated[0];
      assert.deepEqual(
        Object.keys(entry.available_actions),
        testCase.actions,
        testCase.status
      );
      for (const action of testCase.actions) {
        const argumentsValue = entry.available_actions[action].arguments;
        const targetKey = action === "send" ? "selector" : "conversation_id";
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
      if (testCase.status === "idle") {
        assert.deepEqual(
          entry.available_actions.send.missing_required,
          ["request"]
        );
      }
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
    }
  }
});

test("managed Claude approval hints require the executable state", () => {
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
      const entry = listed.delegated[0];
      assert.equal(entry.available_actions.send, undefined, testCase.name);
      if ("hideCancel" in testCase && testCase.hideCancel) {
        assert.equal(
          entry.available_actions.cancel,
          undefined,
          testCase.name
        );
      }
      if (!testCase.available) {
        assert.equal(
          entry.available_actions.approve,
          undefined,
          testCase.name
        );
        continue;
      }
      assert.deepEqual(
        entry.available_actions.approve.arguments,
        { conversation_id: entry.id }
      );
      assert.deepEqual(
        entry.available_actions.approve.missing_required,
        ["expected_approval_fingerprint"]
      );
      assert.deepEqual(
        entry.available_actions.approve.before_call.arguments,
        { conversation_id: entry.id }
      );
      assert.equal(
        entry.available_actions.approve.requires_fresh_status,
        true
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
  const storeDir = path.join(tempDir, "conversations");
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
      state_path: acpxCodexPaths.statePath,
      event_log_path: acpxCodexPaths.logPath
    } as any);

    const managedOnly = runCli([
      "list",
      "--all",
      "--managed-only",
      "--idle-timeout-minutes",
      "1",
      "--store-dir",
      storeDir
    ]);
    assert.equal(managedOnly.cleanup.closed, 1);
    assert.deepEqual(managedOnly.delegated, []);
    assert.deepEqual(managedOnly.tasks, []);

    const listed = runCli([
      "list",
      "--all",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.deepEqual(listed.delegated, []);
    assert.equal(listed.terminal_controlled.length, 1);
    assert.match(listed.terminal_controlled[0].short_ref, /^@[0-9a-f]{10}$/u);

    const sent = runCli([
      "send",
      "--conversation",
      listed.terminal_controlled[0].short_ref,
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
      listed.terminal_controlled[0].id
    );
    assert.equal(sent.conversation.executor.kind, "codex");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an active unsupported legacy owner still fences its tmux pane", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-selector-cli-legacy-owner-")
  );
  const storeDir = path.join(tempDir, "conversations");
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
    assert.deepEqual(listed.delegated, []);
    assert.deepEqual(listed.terminal_controlled, []);

    const send = spawnCli([
      "send",
      "--conversation",
      "only",
      "--message",
      "Do not double-dispatch this task",
      "--background",
      "--store-dir",
      storeDir,
      ...runtimeArgs
    ]);
    assert.equal(send.status, 1);
    assert.match(send.stderr, /no actionable sessions for send/u);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI only prefers an active managed terminal bridge over its raw tmux pane", () => {
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
    assert.equal(listed.delegated.length, 1);
    assert.equal(listed.delegated[0].id, managedId);
    assert.deepEqual(listed.terminal_controlled, []);

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
    assert.equal(listed.delegated.length, 1);
    assert.equal(listed.delegated[0].conversation_id, managedId);

    for (const selector of ["only", listed.delegated[0].short_ref]) {
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
}) {
  const now = new Date("2026-07-28T00:00:00.000Z");
  const base = createConversation({
    userRequest: options.request,
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
    JSON.stringify({ [options.terminalTarget]: options.screen })
  ];
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

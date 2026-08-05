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
  type Conversation
} from "../src/protocol.js";
import {
  terminalBindingFrom,
  type ManagedSessionStatus
} from "../src/managed-session.js";
import { saveManagedSession } from "../src/session-store.js";
import {
  pathsForConversation,
  saveState,
  storeManifestPath,
  storeSessionsDir
} from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const nativeThreadId = "11111111-1111-4111-8111-111111111111";
const processUuid = "codex-pid:42001:birth:fixture";
const rollout = {
  fd: "12r",
  device: "1",
  inode: "2",
  path: "/tmp/akk-turn-session-binding-rollout.jsonl"
};

test("protocol-3 terminal callback fails closed when its Session state is missing", () => {
  const fixture = createCallbackTurnFixture({ terminal: true });
  try {
    const result = runCallback(fixture.conversation);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /protocol 3 requires authoritative state for managed Session/u
    );
    assert.equal(
      JSON.parse(fs.readFileSync(fixture.conversation.state_path!, "utf8")).status,
      "waiting_for_agent"
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a quarantined migrated terminal Session cannot authorize its legacy Turn", () => {
  const fixture = createCallbackTurnFixture({
    terminal: true,
    sessionStatus: "quarantined"
  });
  try {
    const result = runCallback(fixture.conversation);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Session binding generation is no longer current/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a migrated terminal Session cannot authorize a Turn with different process evidence", () => {
  const fixture = createCallbackTurnFixture({
    terminal: true,
    sessionStatus: "bound",
    bindingProcessUuid: "codex-pid:42001:birth:different"
  });
  try {
    const result = runCallback(fixture.conversation);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Session binding generation is no longer current/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an exact protocol-2 terminal Turn is materialized before its callback", () => {
  const fixture = createCallbackTurnFixture({
    terminal: true,
    predecessorStore: true
  });
  try {
    const result = runCallback(fixture.conversation);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.conversation.status, "idle");
    assert.equal(parsed.conversation.session_id, fixture.conversation.session_id);
    assert.equal(parsed.conversation.turn_id, fixture.conversation.turn_id);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a non-terminal delegated Turn keeps callback compatibility without Session state", () => {
  const fixture = createCallbackTurnFixture({ terminal: false });
  try {
    const result = runCallback(fixture.conversation);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).conversation.status, "idle");
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createCallbackTurnFixture({
  terminal,
  sessionStatus,
  predecessorStore = false,
  bindingProcessUuid = processUuid
}: {
  terminal: boolean;
  sessionStatus?: ManagedSessionStatus;
  predecessorStore?: boolean;
  bindingProcessUuid?: string;
}): {
  root: string;
  conversation: Conversation;
} {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-turn-session-binding-")
  );
  const storeDir = path.join(root, "store");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target: "akk-binding-fixture:0.0",
    session: "akk-binding-fixture",
    window: 0,
    pane: 0,
    panePid: 42000,
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
  };
  const terminalId =
    `terminal:v2:tmux:codex:${terminalControl.target}:42001`;
  const created = createConversation({
    userRequest: "Exercise the Session binding guard",
    workspace,
    executorKind: "codex"
  });
  const task = createMessage({
    conversation: created,
    from: "openclaw",
    to: created.executor.actor,
    type: "task",
    body: created.user_request
  });
  const active = applyMessageToConversation(created, task);
  const paths = pathsForConversation(active.conversation_id, storeDir);
  const conversation: Conversation = {
    ...active,
    ...(terminal
      ? {
          native_session_takeover: {
            agent: "codex",
            terminal_agent_identity_protocol: 1,
            native_session_id: terminalId,
            terminal_agent_pid: 42001,
            terminal_agent_session_id: nativeThreadId,
            terminal_agent_process_uuid: processUuid,
            terminal_agent_process_birth: processUuid,
            terminal_agent_rollout: rollout,
            terminal_agent_identity_evidence: "fixture",
            source_cwd: workspace,
            strategy: "terminal_control",
            terminal_control: terminalControl,
            terminal_bridge: true
          }
        }
      : {}),
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  saveState(paths.statePath, conversation);

  if (predecessorStore) {
    fs.rmSync(storeSessionsDir(storeDir), { recursive: true, force: true });
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      writer_protocol: 2
    }, null, 2)}\n`);
  }

  if (terminal && sessionStatus) {
    const now = new Date();
    const binding = terminalBindingFrom({
      terminalId,
      terminalControl,
      pid: 42001,
      nativeThreadId,
      processUuid: bindingProcessUuid,
      processBirth: processUuid,
      rollout,
      evidence: "fixture",
      generation: 1,
      now
    });
    saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: conversation.session_id,
      agent: "codex",
      workspace,
      status: sessionStatus,
      binding,
      lineage: { created_by: "migration" },
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      ...(sessionStatus === "quarantined"
        ? { quarantine_reason: "ambiguous migrated binding fixture" }
        : {})
    }, { expectedRevision: null });
  }
  return { root, conversation };
}

function runCallback(conversation: Conversation) {
  return spawnSync(process.execPath, [
    binPath,
    "callback",
    "--state",
    conversation.state_path!,
    "--record-only",
    "--message-json",
    JSON.stringify({
      from: conversation.executor.actor,
      to: "openclaw",
      type: "done",
      body: "Binding guard callback"
    })
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      AKK_RUNTIME_DIR: path.join(
        path.dirname(conversation.store_dir!),
        ".akk-runtime"
      )
    }
  });
}

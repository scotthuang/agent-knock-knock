import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTerminalWatchCliAdapter } from
  "../src/terminal-watch-cli-adapter.js";
import type { TerminalWatchCallbackInput } from
  "../src/terminal-watch-callback-cli-adapter.js";

const THREAD_ID = "019f0000-0000-7000-8000-000000000206";
const TASK_ID = "019f0000-0000-7000-8000-000000000207";
const TOKEN = "a".repeat(64);

test("Terminal Watch CLI observes one exact human-started Codex task and delivers its completion", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let terminals = [{
    ...fixture.terminal,
    activity_state: "awaiting_approval",
    approval_state: {
      blocked: true,
      approvable: true,
      fingerprint: "b".repeat(64)
    }
  }];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    buildTerminalListGroup: async () => ({
      terminalControlled: terminals
    }),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    expectedBindingToken: TOKEN,
    openclawSession: "agent:main:main",
    openclawBin: "/usr/local/bin/openclaw",
    hardTimeoutMinutes: 10
  });
  const created = record(record(printed.at(-1)).watch);
  const watchId = String(created.watch_id);
  assert.match(watchId, /^terminal-watch-/u);
  assert.equal(created.status, "active");
  assert.equal(record(created.callback).pending, 1);
  assert.equal(callbacks.length, 0);
  assert.equal(facade.listPublicWatches(fixture.storeDir).length, 1);

  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "Terminal Watch verified completion"
      }
    })}\n`
  );
  // The exact durable completion must still win when the TUI process exits
  // before the next reconciliation discovers it.
  terminals = [];
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(
    callbacks[0].completionText,
    "Terminal Watch verified completion"
  );
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  const settled = record(record(printed.at(-1)).watch);
  assert.equal(settled.status, "completed");
  assert.equal(record(settled.callback).superseded, 1);
  assert.deepEqual(facade.listPublicWatches(fixture.storeDir), []);
  assert.equal(
    facade.listPublicWatches(fixture.storeDir, { includeAll: true }).length,
    1
  );
});

test("exact durable completion wins when the terminal switches before reconciliation", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let terminals = [fixture.terminal];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    buildTerminalListGroup: async () => ({ terminalControlled: terminals }),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000208",
    storeDirFromOptions: () => fixture.storeDir,
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    expectedBindingToken: TOKEN,
    openclawSession: "agent:main:main"
  });
  fs.appendFileSync(
    fixture.rolloutPath,
    `${JSON.stringify({
      timestamp: "2026-08-21T01:00:01.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: TASK_ID,
        last_agent_message: "Completion survived terminal drift"
      }
    })}\n`
  );
  terminals = [{
    ...fixture.terminal,
    lifecycle_binding_token: "c".repeat(64),
    native_agent_process_uuid: "codex-pid:9999:birth:replacement"
  }];
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });

  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "completed");
  assert.equal(callbacks[0].completionText, "Completion survived terminal drift");
  const watchId = String(record(record(printed[0]).watch).watch_id);
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  assert.equal(record(record(printed.at(-1)).watch).status, "completed");
});

test("unwatch persists cancellation and leaves callback delivery to supervision", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    buildTerminalListGroup: async () => ({
      terminalControlled: [fixture.terminal]
    }),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000209",
    storeDirFromOptions: () => fixture.storeDir,
    printJson: (value) => printed.push(value),
    callback: {
      deliver(input) {
        callbacks.push(input);
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    expectedBindingToken: TOKEN,
    openclawSession: "agent:main:main"
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  await facade.runUnwatch({ storeDir: fixture.storeDir, watch: watchId });
  const cancelled = record(record(printed.at(-1)).watch);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(record(cancelled.callback).pending, 1);
  assert.equal(callbacks.length, 0);

  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].event, "cancelled");
});

test("Terminal Watch CLI rejects stale binding authority before persistence", async (t) => {
  const fixture = createFixture(t);
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    buildTerminalListGroup: async () => ({
      terminalControlled: [fixture.terminal]
    }),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    printJson: () => {},
    callback: {
      deliver(input) {
        return { runId: input.idempotencyKey, status: "started" };
      }
    }
  });
  await assert.rejects(
    facade.runWatch({
      terminal: fixture.terminal.id as string,
      expectedBindingToken: "b".repeat(64),
      openclawSession: "agent:main:main"
    }),
    /binding changed/u
  );
  assert.equal(fs.existsSync(path.join(fixture.storeDir, "terminal-watches")), false);
});

function createFixture(t: test.TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-watch-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolloutPath = path.join(root, "rollout.jsonl");
  const request = "Human-started task";
  fs.writeFileSync(
    rolloutPath,
    [
      {
        timestamp: "2026-08-21T00:59:59.000Z",
        type: "session_meta",
        payload: {
          id: THREAD_ID,
          timestamp: "2026-08-21T00:00:00.000Z",
          cwd: root,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.148.0"
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.000Z",
        type: "event_msg",
        payload: { type: "task_started", turn_id: TASK_ID }
      },
      {
        timestamp: "2026-08-21T01:00:00.010Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
        }
      },
      {
        timestamp: "2026-08-21T01:00:00.011Z",
        type: "event_msg",
        payload: { type: "user_message", message: request }
      }
    ].map((value) => JSON.stringify(value)).join("\n") + "\n",
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  let now = new Date("2026-08-21T01:00:00.100Z");
  const processBirth = "Fri Aug 21 08:59:00 2026";
  return {
    rolloutPath,
    storeDir: path.join(root, "store"),
    now: () => new Date(now),
    advance: () => {
      now = new Date("2026-08-21T01:00:02.000Z");
    },
    terminal: {
      id: "terminal:v2:watch-fixture",
      source: "terminal",
      agent: "codex",
      pid: 6206,
      workspace: root,
      cwd: root,
      native_agent_session_id: THREAD_ID,
      native_agent_process_uuid: `codex-pid:6206:birth:${processBirth}`,
      native_agent_process_birth: processBirth,
      native_agent_rollout: {
        fd: "12r",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: rolloutPath
      },
      agent_version: "0.148.0",
      native_thread_lifecycle: {
        status: "supported",
        behaviorProfile: "codex-tui-0.148.0"
      },
      lifecycle_binding_token: TOKEN,
      activity_state: "working",
      approval_state: { blocked: false, approvable: false },
      terminal_control: {
        kind: "tmux",
        target: "watch-session:0.0",
        session: "watch-session",
        window: 0,
        pane: 0,
        panePid: 6200,
        currentCommand: "codex",
        currentPath: root,
        capabilities: ["screen_status", "durable_completion"]
      },
      commands: { watch: true }
    }
  };
}

function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTerminalWatchCliAdapter } from
  "../src/terminal-watch-cli-adapter.js";
import type { TerminalWatchCallbackInput } from
  "../src/terminal-watch-callback-cli-adapter.js";
import type { Conversation } from "../src/protocol.js";

const THREAD_ID = "019f0000-0000-7000-8000-000000000206";
const TASK_ID = "019f0000-0000-7000-8000-000000000207";
const TOKEN = "a".repeat(64);
type RootUserRowOrder = "human-only" | "synthetic-first" | "human-first";

test("Terminal Watch CLI observes one exact human-started Codex task and delivers its completion", async (t) => {
  const fixture = createFixture(t);
  assert.equal("commands" in fixture.terminal, false);
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
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
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
    openclawSession: "agent:main:main",
    openclawBin: "/usr/local/bin/openclaw",
    hardTimeoutMinutes: 10
  });
  const created = record(record(printed.at(-1)).watch);
  const watchId = String(created.watch_id);
  assert.match(watchId, /^terminal-watch-/u);
  assert.equal(created.status, "active");
  assert.equal("observation_checkpoint" in created, false);
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

test("Terminal Watch accepts a paired human prompt beside a same-turn synthetic Codex context row", async (t) => {
  for (const rootUserRowOrder of [
    "synthetic-first",
    "human-first"
  ] as const) {
    const fixture = createFixture(t, rootUserRowOrder);
    const printed: unknown[] = [];
    const callbacks: TerminalWatchCallbackInput[] = [];
    const facade = createTerminalWatchCliAdapter({
      acquireFileLock: () => () => {},
      acquireTerminalLock: () => () => {},
      observeExactTerminal: async ({ terminalId }) =>
        exactTerminalObservation([fixture.terminal], terminalId),
      loadClaudeAgentRows: () => [],
      now: fixture.now,
      randomUUID: () => rootUserRowOrder === "synthetic-first"
        ? "00000000-0000-4000-8000-000000000214"
        : "00000000-0000-4000-8000-000000000215",
      storeDirFromOptions: () => fixture.storeDir,
      terminalDispatchOwnership: () => ({ state: "none" }),
      terminalIncarnationBlockingTurns: () => [],
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
      openclawSession: "agent:main:main"
    });
    const created = record(record(printed.at(-1)).watch);
    assert.equal(created.status, "active", rootUserRowOrder);
    assert.equal(record(created.callback).pending, 0, rootUserRowOrder);
    assert.equal(callbacks.length, 0, rootUserRowOrder);

    fs.appendFileSync(
      fixture.rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-08-21T01:00:01.000Z",
        type: "event_msg",
        payload: {
          type: "task_complete",
          turn_id: TASK_ID,
          last_agent_message: `Completed with ${rootUserRowOrder} context`
        }
      })}\n`
    );
    fixture.advance();
    await facade.runReconcileWatches({ storeDir: fixture.storeDir });

    assert.equal(callbacks.length, 1, rootUserRowOrder);
    assert.equal(callbacks[0].event, "completed", rootUserRowOrder);
    assert.equal(
      callbacks[0].completionText,
      `Completed with ${rootUserRowOrder} context`,
      rootUserRowOrder
    );
    facade.runWatchStatus({
      storeDir: fixture.storeDir,
      watch: String(created.watch_id)
    });
    assert.equal(
      record(record(printed.at(-1)).watch).status,
      "completed",
      rootUserRowOrder
    );
  }
});

test("exact durable completion wins when the terminal switches before reconciliation", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  let terminals = [fixture.terminal];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(terminals, terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000208",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
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

test("an unavailable exact terminal observation is retryable", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  let unavailable = false;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => unavailable
      ? {
          state: "unavailable" as const,
          reason: "process discovery failed",
          summary: { error: "process discovery failed" }
        }
      : exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000213",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: (value) => printed.push(value)
  });

  await facade.runWatch({
    terminal: fixture.terminal.id as string,
    openclawSession: "agent:main:main"
  });
  const watchId = String(record(record(printed.at(-1)).watch).watch_id);
  unavailable = true;
  fixture.advance();
  await facade.runReconcileWatches({ storeDir: fixture.storeDir });
  facade.runWatchStatus({ storeDir: fixture.storeDir, watch: watchId });
  assert.equal(record(record(printed.at(-1)).watch).status, "active");
});

test("unwatch persists cancellation and leaves callback delivery to supervision", async (t) => {
  const fixture = createFixture(t);
  const printed: unknown[] = [];
  const callbacks: TerminalWatchCallbackInput[] = [];
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation([fixture.terminal], terminalId),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000209",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
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
  let scans = 0;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      return exactTerminalObservation([{
          ...fixture.terminal,
          lifecycle_binding_token:
            scans === 1 ? TOKEN : "b".repeat(64)
        }], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000206",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
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
      openclawSession: "agent:main:main"
    }),
    /binding changed/u
  );
  assert.equal(scans, 2);
  assert.equal(fs.existsSync(path.join(fixture.storeDir, "terminal-watches")), false);
});

test("Terminal Watch CLI rejects a malformed internally resolved binding token", async (t) => {
  const fixture = createFixture(t);
  const abbreviatedToken = "a".repeat(6) + "…" + "b".repeat(6);
  let scans = 0;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      return exactTerminalObservation([{
          ...fixture.terminal,
          lifecycle_binding_token: abbreviatedToken
        }], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000212",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {}
  });

  await assert.rejects(
    facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: "agent:main:main"
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /current terminal binding token/u);
      assert.match(error.message, /exactly 64 lowercase ASCII hexadecimal/u);
      assert.equal(error.message.includes(abbreviatedToken), false);
      return true;
    }
  );
  assert.equal(scans, 1);
  assert.equal(
    fs.existsSync(path.join(fixture.storeDir, "terminal-watches")),
    false
  );
});

test("Terminal Watch rechecks managed Turn authority while holding the terminal lock", async (t) => {
  const fixture = createFixture(t);
  const events: string[] = [];
  let scans = 0;
  let ownershipReads = 0;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => {
      events.push("terminal-lock:acquired");
      return () => events.push("terminal-lock:released");
    },
    observeExactTerminal: async ({ terminalId }) => {
      scans += 1;
      events.push(`scan:${scans}`);
      return exactTerminalObservation([fixture.terminal], terminalId);
    },
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000210",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => {
      ownershipReads += 1;
      return { state: "none" };
    },
    terminalIncarnationBlockingTurns: () => {
      events.push("managed-authority:checked");
      return scans >= 2 ? [managedTurn()] : [];
    },
    printJson: () => {}
  });

  await assert.rejects(
    facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: "agent:main:main"
    }),
    /already belongs to AKK Turn turn-managed-206 \(running\).*managed Turn monitor\/callback.*AKK status/u
  );
  assert.deepEqual(events, [
    "scan:1",
    "terminal-lock:acquired",
    "scan:2",
    "managed-authority:checked",
    "terminal-lock:released"
  ]);
  assert.equal(ownershipReads, 0);
  assert.equal(
    fs.existsSync(path.join(fixture.storeDir, "terminal-watches")),
    false
  );
});

test("Terminal Watch rejects a stale or forged public Watch action", async (t) => {
  const fixture = createFixture(t);
  const projectedTerminal = structuredClone(fixture.terminal);
  record(record(projectedTerminal.available_actions).watch).arguments = {
    terminal_id: projectedTerminal.id,
    expected_binding_token: "b".repeat(64)
  };
  let released = false;
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {},
    acquireTerminalLock: () => () => {
      released = true;
    },
    observeExactTerminal: async ({ terminalId }) =>
      exactTerminalObservation(
        [fixture.terminal],
        terminalId,
        projectedTerminal
      ),
    loadClaudeAgentRows: () => [],
    now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000211",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [],
    printJson: () => {}
  });

  await assert.rejects(
    facade.runWatch({
      terminal: fixture.terminal.id as string,
      openclawSession: "agent:main:main"
    }),
    /current available_actions\.watch/u
  );
  assert.equal(released, true);
  assert.equal(
    fs.existsSync(path.join(fixture.storeDir, "terminal-watches")),
    false
  );
});

function exactTerminalObservation(
  terminals: Array<Record<string, unknown>>,
  terminalId: string,
  projectedTerminal?: Record<string, unknown>
) {
  const matches = terminals.filter((terminal) => terminal.id === terminalId);
  return matches.length === 1
    ? {
        state: "available" as const,
        rawTerminal: matches[0],
        terminal: projectedTerminal ?? matches[0],
        summary: {}
      }
    : { state: "absent" as const, summary: {} };
}

function createFixture(
  t: test.TestContext,
  rootUserRowOrder: RootUserRowOrder = "human-only"
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-terminal-watch-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rolloutPath = path.join(root, "rollout.jsonl");
  const request = "Human-started task";
  const humanRootUserRow = {
    timestamp: "2026-08-21T01:00:00.010Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: request }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const syntheticContextRow = {
    timestamp: rootUserRowOrder === "synthetic-first"
      ? "2026-08-21T01:00:00.009Z"
      : "2026-08-21T01:00:00.012Z",
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: `<environment_context>\n  <cwd>${root}</cwd>\n</environment_context>`
      }],
      internal_chat_message_metadata_passthrough: { turn_id: TASK_ID }
    }
  };
  const humanUserMessageEvent = {
    timestamp: "2026-08-21T01:00:00.011Z",
    type: "event_msg",
    payload: { type: "user_message", message: request }
  };
  const rootTaskRecords = rootUserRowOrder === "human-only"
    ? [humanRootUserRow, humanUserMessageEvent]
    : rootUserRowOrder === "synthetic-first"
      ? [syntheticContextRow, humanRootUserRow, humanUserMessageEvent]
      : [humanRootUserRow, humanUserMessageEvent, syntheticContextRow];
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
      ...rootTaskRecords
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
      available_actions: {
        watch: {
          tool: "agent_knock_knock_watch",
          arguments: {
            terminal_id: "terminal:v2:watch-fixture"
          },
          requires_user_intent: true,
          use: "Monitor this human-started external task."
        }
      }
    }
  };
}

function managedTurn(): Conversation {
  return {
    session_id: "session-managed-206",
    turn_id: "turn-managed-206",
    conversation_id: "turn-managed-206",
    user_request: "managed request",
    openclaw_session: "agent:main:main",
    claude_session: "",
    executor: { kind: "codex" },
    workspace: "/tmp/managed-watch",
    status: "running",
    response_rounds_used: 0,
    soft_limit: 10,
    hard_limit: 20,
    created_at: "2026-08-21T00:00:00.000Z",
    updated_at: "2026-08-21T00:00:01.000Z"
  } as Conversation;
}

function record(value: unknown): Record<string, any> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, any>;
}

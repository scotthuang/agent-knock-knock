import test from "node:test";
import assert from "node:assert/strict";
import { CodexLocalSessionProvider, type CodexLocalSessionAdapter } from "../src/codex-local-session-provider.js";
import type { CodexProcessSnapshot, CodexThreadRow } from "../src/codex-session-provider.js";

const SESSION_ID = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";

test("Codex local session provider exposes a stable full-capability facade", async () => {
  const provider = new CodexLocalSessionProvider(new FakeCodexAdapter({
    rows: [{
      id: SESSION_ID,
      cwd: "/repo/acpx",
      rollout_path: "/rollout.jsonl",
      title: "inspect ACPX changes",
      updated_at_ms: 20
    }],
    rollouts: new Map([
      ["/rollout.jsonl", JSON.stringify({
        timestamp: "2026-06-20T14:05:25.758Z",
        type: "turn_context",
        payload: {
          model: "gpt-5.5"
        }
      }) + "\n" + JSON.stringify({
        timestamp: "2026-06-20T14:05:25.759Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "review the latest ACPX changes"
        }
      })]
    ]),
    processes: [{
      pid: 100,
      cwd: "/repo/acpx",
      command: `codex resume ${SESSION_ID}`
    }]
  }));

  assert.deepEqual(await provider.getCapabilities(), {
    historicalSessions: "full",
    forkContext: "full",
    activeSessions: "process_scan",
    takeover: "plan_only",
    reasons: []
  });

  assert.equal((await provider.listHistoricalSessions())[0].id, SESSION_ID);
  assert.equal((await provider.listActiveSessions())[0].sessionId, SESSION_ID);
  assert.deepEqual(await provider.getSessionModel(SESSION_ID), {
    model: "gpt-5.5",
    acpxModel: "gpt-5.5[medium]",
    source: "turn_context"
  });

  const forkContext = await provider.getForkContext({
    sessionId: SESSION_ID,
    maxMessages: 1
  });
  assert.equal(forkContext?.source.sessionId, SESSION_ID);
  assert.deepEqual(forkContext?.messages.map((message) => message.text), [
    "review the latest ACPX changes"
  ]);
});

test("Codex local session provider degrades when rollout content is unavailable", async () => {
  const provider = new CodexLocalSessionProvider(new FakeCodexAdapter({
    rows: [{
      id: SESSION_ID,
      cwd: "/repo/acpx",
      title: "metadata only"
    }],
    rollouts: new Map(),
    processes: []
  }));

  assert.deepEqual(await provider.getCapabilities(), {
    historicalSessions: "metadata_only",
    forkContext: "partial",
    activeSessions: "process_scan",
    takeover: "plan_only",
    reasons: []
  });

  const forkContext = await provider.getForkContext({ sessionId: SESSION_ID });
  assert.equal(forkContext?.source.sessionId, SESSION_ID);
  assert.deepEqual(forkContext?.messages, []);
});

test("Codex local session provider reports unavailable capabilities without leaking adapter errors", async () => {
  const provider = new CodexLocalSessionProvider(new FailingCodexAdapter());

  const capabilities = await provider.getCapabilities();

  assert.equal(capabilities.historicalSessions, "unavailable");
  assert.equal(capabilities.forkContext, "unavailable");
  assert.equal(capabilities.activeSessions, "unavailable");
  assert.equal(capabilities.takeover, "unavailable");
  assert.equal(capabilities.reasons.length, 2);
  assert.match(capabilities.reasons[0], /historical session discovery unavailable/);
  assert.match(capabilities.reasons[1], /active session discovery unavailable/);
});

test("Codex local session provider finds sessions through the facade only", async () => {
  const provider = new CodexLocalSessionProvider(new FakeCodexAdapter({
    rows: [{
      id: SESSION_ID,
      cwd: "/repo/acpx"
    }],
    rollouts: new Map(),
    processes: []
  }));

  assert.equal((await provider.getSession(SESSION_ID))?.cwd, "/repo/acpx");
  assert.equal(await provider.getSession("missing"), undefined);
  assert.equal(await provider.getForkContext({ sessionId: "missing" }), undefined);
});

class FakeCodexAdapter implements CodexLocalSessionAdapter {
  private readonly rows: CodexThreadRow[];
  private readonly rollouts: Map<string, string>;
  private readonly processes: CodexProcessSnapshot[];

  constructor({
    rows,
    rollouts,
    processes
  }: {
    rows: CodexThreadRow[];
    rollouts: Map<string, string>;
    processes: CodexProcessSnapshot[];
  }) {
    this.rows = rows;
    this.rollouts = rollouts;
    this.processes = processes;
  }

  async listThreadRows(): Promise<CodexThreadRow[]> {
    return this.rows;
  }

  async readRollout(path: string): Promise<string | undefined> {
    return this.rollouts.get(path);
  }

  async listProcessSnapshots(): Promise<CodexProcessSnapshot[]> {
    return this.processes;
  }
}

class FailingCodexAdapter implements CodexLocalSessionAdapter {
  async listThreadRows(): Promise<CodexThreadRow[]> {
    throw new Error("threads table missing");
  }

  async readRollout(): Promise<string | undefined> {
    throw new Error("rollout unavailable");
  }

  async listProcessSnapshots(): Promise<CodexProcessSnapshot[]> {
    throw new Error("process scan unavailable");
  }
}

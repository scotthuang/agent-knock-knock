import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalWatchCallbackCliAdapter
} from "../src/terminal-watch-callback-cli-adapter.js";

test("Terminal Watch callback uses one deterministic chat.send delivery", () => {
  const calls: Array<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const adapter = createTerminalWatchCallbackCliAdapter({
    environment: () => ({ PATH: "/test/bin", OPENCLAW_GATEWAY_TOKEN: "secret" }),
    spawnSync(command, args, options) {
      calls.push({ command, args, env: options.env });
      const params = JSON.parse(String(args[4]));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "started"
        }),
        stderr: ""
      };
    }
  });

  adapter.deliver({
    watchId: "watch:v1:00000000-0000-4000-8000-000000000001",
    idempotencyKey: "agent-knock-knock:terminal-watch:watch-1:completion-1",
    event: "completed",
    agent: "codex",
    terminalId: "terminal:v1:tmux:%1",
    openclawSession: "agent:main:main",
    openclawBin: "/opt/openclaw",
    detail: "exact Codex task_complete observed",
    completionText: "Implemented the requested change."
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.command, "/opt/openclaw");
  assert.deepEqual(calls[0]?.args.slice(0, 3), [
    "gateway",
    "call",
    "chat.send"
  ]);
  const params = JSON.parse(String(calls[0]?.args[4]));
  assert.equal(params.sessionKey, "agent:main:main");
  assert.equal(params.deliver, true);
  assert.match(params.message, /human directly in Codex or Claude Code/u);
  assert.match(params.message, /Implemented the requested change/u);
  assert.equal(calls[0]?.env.OPENCLAW_GATEWAY_TOKEN, "secret");
});

test("Terminal Watch approval callback forbids automatic approval", () => {
  let message = "";
  const adapter = createTerminalWatchCallbackCliAdapter({
    spawnSync(_command, args) {
      const params = JSON.parse(String(args[4]));
      message = params.message;
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "in_flight"
        }),
        stderr: ""
      };
    }
  });
  adapter.deliver({
    watchId: "watch:v1:00000000-0000-4000-8000-000000000002",
    idempotencyKey: "agent-knock-knock:terminal-watch:watch-2:approval-1",
    event: "approval_required",
    agent: "claude",
    terminalId: "terminal:v1:tmux:%2",
    openclawSession: "agent:main:main"
  });
  assert.match(message, /human to inspect and decide in the named live TUI/u);
  assert.match(message, /Do not call any AKK approval tool or action/u);
  assert.match(message, /do not send approval keys/u);
  assert.doesNotMatch(message, /use only the terminal row's current AKK approval action/u);
});

test("Terminal Watch callback rejects malformed or mismatched acknowledgements", () => {
  const malformed = createTerminalWatchCallbackCliAdapter({
    spawnSync: () => ({ status: 0, stdout: "not-json", stderr: "" })
  });
  assert.throws(
    () => malformed.deliver({
      watchId: "watch:v1:00000000-0000-4000-8000-000000000003",
      idempotencyKey: "agent-knock-knock:terminal-watch:watch-3:failure-1",
      event: "failed",
      agent: "codex",
      terminalId: "terminal:v1:tmux:%3",
      openclawSession: "agent:main:main"
    }),
    /malformed JSON/u
  );

  const mismatch = createTerminalWatchCallbackCliAdapter({
    spawnSync: () => ({
      status: 0,
      stdout: JSON.stringify({ runId: "wrong", status: "started" }),
      stderr: ""
    })
  });
  assert.throws(
    () => mismatch.deliver({
      watchId: "watch:v1:00000000-0000-4000-8000-000000000004",
      idempotencyKey: "agent-knock-knock:terminal-watch:watch-4:timeout-1",
      event: "timed_out",
      agent: "claude",
      terminalId: "terminal:v1:tmux:%4",
      openclawSession: "agent:main:main"
    }),
    /does not match/u
  );

  const rejected = createTerminalWatchCallbackCliAdapter({
    spawnSync: (_command, args) => {
      const params = JSON.parse(String(args[4]));
      return {
        status: 0,
        stdout: JSON.stringify({
          runId: params.idempotencyKey,
          status: "error"
        }),
        stderr: ""
      };
    }
  });
  assert.throws(
    () => rejected.deliver({
      watchId: "terminal-watch-00000000-0000-4000-8000-000000000005",
      idempotencyKey:
        "agent-knock-knock:terminal-watch:watch-5:cancelled-1",
      event: "cancelled",
      agent: "codex",
      terminalId: "terminal:v1:tmux:%5",
      openclawSession: "agent:main:main"
    }),
    /was not accepted: error/u
  );
});

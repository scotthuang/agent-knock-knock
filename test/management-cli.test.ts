import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("list status send and close manage agent delegations", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-management-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const acpxCallsPath = path.join(tempDir, "acpx-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const claude = runCli([
      "new",
      "--agent",
      "claude",
      "--session",
      "claude-work",
      "--request",
      "Claude task",
      "--store-dir",
      storeDir
    ]);
    const codex = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-work",
      "--request",
      "Codex task",
      "--store-dir",
      storeDir
    ]);

    const listed = runCli(["list", "--store-dir", storeDir]);
    assert.deepEqual(
      listed.tasks.map((task) => [task.agent, task.session, task.status]).sort(),
      [
        ["claude", "claude-work", "waiting_for_agent"],
        ["codex", "codex-work", "waiting_for_agent"]
      ]
    );

    const status = runCli(["status", "--conversation", codex.conversation.conversation_id, "--store-dir", storeDir]);
    assert.equal(status.summary.agent, "codex");
    assert.equal(status.summary.session, "codex-work");
    assert.equal(status.recent_events.at(-1).type, "task");

    const sent = runCli([
      "send",
      "--conversation",
      codex.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Continue with the smaller implementation.",
      "--type",
      "answer",
      "--all-proxy",
      "socks5h://127.0.0.1:1082",
      "--model",
      "gpt-5.5/medium"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.delivered, true);
    assert.equal(sent.executor.kind, "codex");
    assert.equal(sent.message.to, "codex");

    const acpxCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(acpxCalls[0].args, ["codex", "sessions", "ensure", "--name", "codex-work"]);
    assert.equal(acpxCalls[0].allProxy, "socks5h://127.0.0.1:1082");
    assert.deepEqual(acpxCalls[1].args.slice(0, 6), ["--approve-all", "--model", "gpt-5.5/medium", "codex", "-s", "codex-work"]);
    assert.equal(acpxCalls[1].allProxy, "socks5h://127.0.0.1:1082");

    const closed = runCli([
      "close",
      "--conversation",
      claude.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--reason",
      "No longer needed"
    ]);
    assert.equal(closed.closed, true);
    assert.equal(closed.conversation.status, "closed");

    const activeAfterClose = runCli(["list", "--store-dir", storeDir]);
    assert.deepEqual(activeAfterClose.tasks.map((task) => task.conversation_id), [codex.conversation.conversation_id]);

    const allAfterClose = runCli(["list", "--store-dir", storeDir, "--all"]);
    assert.equal(allAfterClose.tasks.length, 2);
    assert.equal(allAfterClose.tasks.some((task) => task.status === "closed"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cancel requests cooperative ACPX cancellation for Codex and Claude sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cancel-management-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const acpxCallsPath = path.join(tempDir, "acpx-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const codex = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-cancellable",
      "--request",
      "Codex long task",
      "--store-dir",
      storeDir
    ]);
    const claude = runCli([
      "new",
      "--agent",
      "claude",
      "--session",
      "claude-cancellable",
      "--request",
      "Claude long task",
      "--store-dir",
      storeDir
    ]);

    const cancelledCodex = runCli([
      "cancel",
      "--conversation",
      codex.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--all-proxy",
      "socks5h://127.0.0.1:1082"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelledCodex.cancel_requested, true);
    assert.equal(cancelledCodex.conversation.status, "cancelling");
    assert.equal(cancelledCodex.executor.kind, "codex");

    const cancelledClaude = runCli([
      "cancel",
      "--conversation",
      claude.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelledClaude.cancel_requested, true);
    assert.equal(cancelledClaude.conversation.status, "cancelling");
    assert.equal(cancelledClaude.executor.kind, "claude");

    const acpxCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(acpxCalls.map((call) => call.args), [
      ["codex", "cancel", "-s", "codex-cancellable"],
      ["claude", "cancel", "-s", "claude-cancellable"]
    ]);
    assert.equal(acpxCalls[0].allProxy, "socks5h://127.0.0.1:1082");

    const codexStatus = runCli(["status", "--conversation", codex.conversation.conversation_id, "--store-dir", storeDir]);
    assert.equal(codexStatus.summary.status, "cancelling");
    assert.equal(codexStatus.recent_events.at(-1).event, "executor_cancel_requested");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("done conversations become idle, accept follow-up sends, and lazily time out", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-idle-management-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const acpxCallsPath = path.join(tempDir, "acpx-calls.ndjson");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2)
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-idle",
      "--request",
      "Initial task",
      "--store-dir",
      storeDir
    ]);

    const callback = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "done",
        body: "Completed first round."
      })
    ]);
    assert.equal(callback.conversation.status, "idle");

    const listed = runCli(["list", "--store-dir", storeDir]);
    assert.deepEqual(listed.tasks.map((task) => [task.conversation_id, task.status]), [
      [created.conversation.conversation_id, "idle"]
    ]);

    const sent = runCli([
      "send",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Second task in same session."
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.delivered, true);
    assert.equal(sent.conversation.status, "waiting_for_agent");

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    const stale = {
      ...state,
      status: "idle",
      idle_since: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    const afterTimeout = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1"
    ]);
    assert.equal(afterTimeout.cleanup.closed, 1);
    assert.deepEqual(afterTimeout.tasks, []);

    const closedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "idle timeout after 1 minutes");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor marks waiting conversations stalled when the executor process is gone", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-exit-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-stalled",
      "--request",
      "Long task",
      "--store-dir",
      storeDir
    ]);

    runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--pid",
      "999999",
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60"
    ]);

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.status, "stalled");
    assert.match(state.stalled_reason, /executor process 999999 exited before callback/);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "executor_monitor_started"), true);
    assert.equal(events.some((event) => event.event === "conversation_stalled"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor marks waiting conversations stalled after callback timeout", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-timeout-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "claude",
      "--session",
      "claude-stalled",
      "--request",
      "Long task",
      "--store-dir",
      storeDir
    ]);

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify({
      ...state,
      updated_at: "2026-01-01T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");

    runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001"
    ]);

    const stalled = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(stalled.status, "stalled");
    assert.match(stalled.stalled_reason, /no callback after 0.001 minutes/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status trace summarizes executor output without exposing thinking text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-trace-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-trace",
      "--request",
      "Trace task",
      "--store-dir",
      storeDir
    ]);
    const outputPath = path.join(path.dirname(created.paths.logPath), "codex-output.log");
    fs.writeFileSync(outputPath, [
      "[acpx] session codex-trace (abc) · /tmp/workspace · agent needs reconnect",
      "[client] initialize (running)",
      "[thinking] private chain of thought that must not be exposed",
      "[client] session/request_permission (running)",
      "[tool] pwd (running)",
      "  input: {\"command\":[\"pwd\"]}",
      "[tool] pwd (completed)",
      "  output:",
      "    /tmp/workspace",
      "[tool] /usr/local/bin/node callback --message-json '{\"body\":\"secret callback\"}' (completed)",
      "  output:",
      "    callback ok",
      "Agent visible progress message.",
      "[done] end_turn"
    ].join("\n"), "utf8");
    fs.appendFileSync(created.paths.logPath, `${JSON.stringify({
      ts: "2026-06-20T00:00:01.000Z",
      conversation_id: created.conversation.conversation_id,
      event: "executor_launch",
      output_path: outputPath
    })}\n`, "utf8");

    const status = runCli([
      "status",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--trace"
    ]);

    assert.equal(status.trace.source, "executor_output_log");
    assert.equal(status.trace.thinking_redacted_count, 1);
    assert.deepEqual(status.trace.agent_messages.some((message) => message.body.includes("private chain")), false);
    assert.equal(status.trace.permission_requests.length, 1);
    assert.equal(status.trace.tool_calls.some((tool) => tool.name === "pwd" && tool.status === "completed"), true);
    assert.equal(status.trace.tool_calls.some((tool) => String(tool.name).includes("secret callback")), false);
    assert.equal(status.trace.done_events.at(-1).status, "end_turn");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

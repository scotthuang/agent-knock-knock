import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../dist/src/cli.js", import.meta.url).pathname;

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

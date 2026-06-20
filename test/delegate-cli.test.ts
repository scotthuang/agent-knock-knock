import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("delegate background launches acpx without returning raw Claude output", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-delegate-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const launchedPath = path.join(tempDir, "acpx-args.json");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchedPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const result = spawnSync(process.execPath, [
      binPath,
      "delegate",
      "--request",
      "Implement a controlled plugin test",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--gateway-method",
      "agent-knock-knock.callback",
      "--background"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.launched, true);
    assert.equal(parsed.background, true);
    assert.equal(parsed.acpx_command, undefined);

    const acpxCalls = await waitForCalls(launchedPath, 2);
    const generatedSession = acpxCalls[0][4];
    assert.match(generatedSession, /^akk-claude-\d{14}-[0-9a-f]{8}$/);
    assert.deepEqual(acpxCalls[0], ["claude", "sessions", "ensure", "--name", generatedSession]);
    const acpxArgs = acpxCalls.at(-1);
    assert.deepEqual(acpxArgs.slice(0, 4), ["--approve-all", "claude", "-s", generatedSession]);
    assert.match(acpxArgs[4], /Initial task message:/);

    const state = JSON.parse(fs.readFileSync(parsed.paths.statePath, "utf8"));
    assert.doesNotMatch(state.callback_command, /--record-only/);
    assert.match(state.callback_command, /--gateway-method/);
    assert.match(state.callback_command, /--openclaw-bin/);
    assert.doesNotMatch(state.callback_command, /<token>/);

    const events = fs.readFileSync(parsed.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "claude_session_ensure" && event.status === 0), true);
    assert.equal(events.some((event) => event.event === "claude_launch" && event.mode === "background"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate background generates a unique Codex session when no session is provided", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-unique-delegate-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const launchedPath = path.join(tempDir, "acpx-args.json");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchedPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const result = spawnSync(process.execPath, [
      binPath,
      "delegate",
      "--agent",
      "codex",
      "--request",
      "Run an isolated Codex task",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--background"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.match(parsed.conversation.executor.session, /^akk-codex-\d{14}-[0-9a-f]{8}$/);

    const acpxCalls = await waitForCalls(launchedPath, 2);
    assert.deepEqual(acpxCalls[0], ["codex", "sessions", "ensure", "--name", parsed.conversation.executor.session]);
    assert.deepEqual(acpxCalls.at(-1).slice(0, 4), ["--approve-all", "codex", "-s", parsed.conversation.executor.session]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("delegate background can launch Codex through acpx", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-delegate-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const launchedPath = path.join(tempDir, "acpx-args.json");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    const fakeAcpx = path.join(fakeBinDir, "acpx");
    fs.writeFileSync(
      fakeAcpx,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launchedPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const result = spawnSync(process.execPath, [
      binPath,
      "delegate",
      "--agent",
      "codex",
      "--session",
      "codex-task",
      "--request",
      "Implement a Codex-backed task",
      "--workspace",
      workspace,
      "--store-dir",
      path.join(tempDir, "conversations"),
      "--all-proxy",
      "socks5h://127.0.0.1:1082",
      "--model",
      "gpt-5.5/medium",
      "--background"
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.conversation.executor.kind, "codex");
    assert.equal(parsed.conversation.executor.session, "codex-task");
    assert.equal(parsed.conversation.executor_all_proxy, "socks5h://127.0.0.1:1082");
    assert.equal(parsed.conversation.executor_model, "gpt-5.5/medium");

    const acpxCalls = await waitForCalls(launchedPath, 2);
    assert.deepEqual(acpxCalls[0].args, ["codex", "sessions", "ensure", "--name", "codex-task"]);
    assert.equal(acpxCalls[0].allProxy, "socks5h://127.0.0.1:1082");
    assert.deepEqual(acpxCalls.at(-1).args.slice(0, 6), ["--approve-all", "--model", "gpt-5.5/medium", "codex", "-s", "codex-task"]);
    assert.equal(acpxCalls.at(-1).allProxy, "socks5h://127.0.0.1:1082");

    const events = fs.readFileSync(parsed.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) =>
      event.event === "executor_launch" &&
      event.executor.kind === "codex"
    ), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function waitForCalls(filePath, minCount, timeoutMs = 2000): Promise<any[]> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (fs.existsSync(filePath)) {
        const calls = fs.readFileSync(filePath, "utf8")
          .trim()
          .split(/\r?\n/)
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (calls.length >= minCount) {
          resolve(calls);
          return;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out waiting for ${filePath}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../bin/agent-knock-knock.js", import.meta.url).pathname;

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
    assert.deepEqual(acpxCalls[0], ["claude", "sessions", "ensure", "--name", "bidirectional"]);
    const acpxArgs = acpxCalls.at(-1);
    assert.deepEqual(acpxArgs.slice(0, 4), ["--approve-all", "claude", "-s", "bidirectional"]);
    assert.match(acpxArgs[4], /Initial task message:/);

    const state = JSON.parse(fs.readFileSync(parsed.paths.statePath, "utf8"));
    assert.match(state.callback_command, /--record-only/);
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

function waitForCalls(filePath, minCount, timeoutMs = 2000) {
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

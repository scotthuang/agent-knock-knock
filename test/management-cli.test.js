import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../bin/agent-knock-knock.js", import.meta.url).pathname;

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
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
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
      "answer"
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
    assert.deepEqual(acpxCalls[0], ["codex", "sessions", "ensure", "--name", "codex-work"]);
    assert.deepEqual(acpxCalls[1].slice(0, 4), ["--approve-all", "codex", "-s", "codex-work"]);

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

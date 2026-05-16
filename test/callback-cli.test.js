import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../bin/agent-knock-knock.js", import.meta.url).pathname;

test("callback records a structured Claude message before delivery", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));

  try {
    const created = runCli([
      "new",
      "--request",
      "Callback test",
      "--store-dir",
      storeDir
    ]);
    const statePath = created.paths.statePath;

    const callback = runCli([
      "callback",
      "--state",
      statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "claude-code",
        to: "openclaw",
        type: "done",
        body: "Implemented callback recording."
      })
    ]);

    assert.equal(callback.delivered, false);
    assert.equal(callback.message.type, "done");
    assert.equal(callback.conversation.status, "done");

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.status, "done");

    const log = fs.readFileSync(created.paths.logPath, "utf8");
    assert.match(log, /Implemented callback recording/);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

function runCli(args) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

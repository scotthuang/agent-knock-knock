import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/cli.js", import.meta.url));

function temporaryDirectory(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-hook-cli-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("install-claude-hooks is disabled and never modifies Claude settings", (t) => {
  const directory = temporaryDirectory(t);
  const settingsPath = path.join(directory, "settings.json");
  const result = spawnSync(process.execPath, [
    cliPath,
    "install-claude-hooks",
    "--settings-path",
    settingsPath,
    "--executable-path",
    cliPath
  ], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /no longer supported/u);
  assert.equal(fs.existsSync(settingsPath), false);
});

test("claude-hook ignores unmanaged events without persistence or permission decisions", (t) => {
  const storeDir = temporaryDirectory(t);
  const input = {
    session_id: "unmanaged-session",
    transcript_path: path.join(storeDir, "transcript.jsonl"),
    cwd: "/workspace/unmanaged",
    hook_event_name: "PermissionRequest",
    prompt_id: "prompt-unmanaged",
    tool_name: "Bash",
    tool_input: { command: "pwd" }
  };
  const result = spawnSync(process.execPath, [
    cliPath,
    "claude-hook",
    "--claude-hook-store-dir",
    storeDir,
    "--claude-agents-json",
    "[]",
    "--permission-wait-timeout-ms",
    "0"
  ], {
    encoding: "utf8",
    input: JSON.stringify(input)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readdirSync(storeDir), []);
});

test("claude-hook rejects malformed input without writing a hook decision", () => {
  const result = spawnSync(process.execPath, [cliPath, "claude-hook"], {
    encoding: "utf8",
    input: "not-json"
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /valid JSON/u);
});

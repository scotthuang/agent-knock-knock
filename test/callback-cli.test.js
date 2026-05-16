import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

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

test("callback does not record duplicate structured messages", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));

  try {
    const created = runCli([
      "new",
      "--request",
      "Callback duplicate test",
      "--store-dir",
      storeDir
    ]);
    const statePath = created.paths.statePath;
    const messageJson = JSON.stringify({
      from: "claude-code",
      to: "openclaw",
      type: "done",
      body: "Duplicate-safe completion."
    });

    const first = runCli([
      "callback",
      "--state",
      statePath,
      "--record-only",
      "--message-json",
      messageJson
    ]);
    const second = runCli([
      "callback",
      "--state",
      statePath,
      "--record-only",
      "--message-json",
      messageJson
    ]);

    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const doneEvents = events.filter((event) =>
      event.event === "message" &&
      event.type === "done" &&
      event.body === "Duplicate-safe completion."
    );
    assert.equal(doneEvents.length, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("callback refuses to write to a corrupted event log", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));

  try {
    const created = runCli([
      "new",
      "--request",
      "Callback corrupted log test",
      "--store-dir",
      storeDir
    ]);
    fs.writeFileSync(created.paths.logPath, JSON.stringify({ event: "conversation_created" }, null, 2), "utf8");

    const result = spawnSync(process.execPath, [
      binPath,
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "claude-code",
        to: "openclaw",
        type: "progress",
        body: "This should fail."
      })
    ], {
      encoding: "utf8"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid NDJSON at line 1|event log is not valid NDJSON at line 1/);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("callback serializes concurrent duplicate messages", async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));

  try {
    const created = runCli([
      "new",
      "--request",
      "Callback concurrent duplicate test",
      "--store-dir",
      storeDir
    ]);
    const messageJson = JSON.stringify({
      from: "claude-code",
      to: "openclaw",
      type: "done",
      body: "Concurrent duplicate-safe completion."
    });
    const args = [
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      messageJson
    ];

    const [first, second] = await Promise.all([
      runCliAsync(args),
      runCliAsync(args)
    ]);

    assert.equal(first.status, 0, first.stderr || first.stdout);
    assert.equal(second.status, 0, second.stderr || second.stdout);

    const outputs = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
    assert.deepEqual(outputs.map((output) => output.duplicate).sort(), [false, true]);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    const doneEvents = events.filter((event) =>
      event.event === "message" &&
      event.type === "done" &&
      event.body === "Concurrent duplicate-safe completion."
    );
    assert.equal(doneEvents.length, 1);
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

function runCliAsync(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

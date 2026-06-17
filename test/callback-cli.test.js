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

test("callback can deliver recorded messages through a plugin gateway method", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-"));
  const gatewayCallPath = path.join(fakeBinDir, "gateway-call.json");

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(gatewayCallPath)}, JSON.stringify(process.argv.slice(2)), "utf8");
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-callback",
      "--request",
      "Callback gateway method test",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:main"
    ]);

    const callback = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "question",
        body: "Should the export include CSV?"
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(callback.delivered, true);
    assert.equal(callback.delivery, "gateway_method");

    const gatewayArgs = JSON.parse(fs.readFileSync(gatewayCallPath, "utf8"));
    assert.deepEqual(gatewayArgs.slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    const params = JSON.parse(gatewayArgs[gatewayArgs.indexOf("--params") + 1]);
    assert.equal(params.sessionKey, "agent:main:main");
    assert.equal(params.message.type, "question");
    assert.equal(params.message.body, "Should the export include CSV?");
    assert.equal(params.statePath, created.paths.statePath);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) =>
      event.event === "callback_gateway_method_delivery" &&
      event.from === "codex" &&
      event.method === "agent-knock-knock.callback" &&
      event.status === 0
    ), true);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback delivers session_send requested by plugin gateway method", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-session-send-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  const gatewayCallPath = path.join(fakeBinDir, "calls.ndjson");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(gatewayCallPath)}, JSON.stringify(args) + "\\n", "utf8");
const method = args[2];
if (method === "agent-knock-knock.callback") {
  console.log(JSON.stringify({
    ok: true,
    session_send: {
      key: "agent:main:main",
      message: "structured callback payload",
      idempotencyKey: "akk-test-session-send"
    }
  }));
} else if (method === "sessions.send") {
  console.log(JSON.stringify({ runId: "akk-test-session-send", status: "started", messageSeq: 2 }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = runCli([
      "new",
      "--request",
      "Callback session send test",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:main"
    ]);

    const callback = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--message-json",
      JSON.stringify({
        from: "claude-code",
        to: "openclaw",
        type: "done",
        body: "Implemented"
      })
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(callback.delivered, true);
    assert.equal(callback.delivery, "gateway_method+sessions_send");

    const calls = fs.readFileSync(gatewayCallPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.deepEqual(calls[1].slice(0, 3), ["gateway", "call", "sessions.send"]);
    const sessionSendParams = JSON.parse(calls[1][calls[1].indexOf("--params") + 1]);
    assert.equal(sessionSendParams.idempotencyKey, "akk-test-session-send");
    assert.equal(sessionSendParams.message, "structured callback payload");

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) =>
      event.event === "callback_session_send_delivery" &&
      event.status === 0
    ), true);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
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

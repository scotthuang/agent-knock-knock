import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

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
    assert.equal(callback.conversation.status, "idle");

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.status, "idle");
    assert.match(state.idle_since, /^\d{4}-\d{2}-\d{2}T/);

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
  const gatewayToken = "gateway-token-via-environment-only";

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (process.env.OPENCLAW_GATEWAY_TOKEN !== ${JSON.stringify(gatewayToken)}) {
  process.stderr.write("gateway token was not delivered through the environment");
  process.exit(98);
}
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
      "--token",
      gatewayToken,
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
    assert.equal(gatewayArgs.includes("--token"), false);
    assert.doesNotMatch(JSON.stringify(gatewayArgs), new RegExp(gatewayToken));
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

test("terminal bridge callback stays retryable until gateway delivery succeeds", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-retry-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-retry-"));
  const allowDeliveryPath = path.join(fakeBinDir, "allow-delivery");
  const callsPath = path.join(fakeBinDir, "calls.ndjson");

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (!fs.existsSync(${JSON.stringify(allowDeliveryPath)})) {
  console.error("gateway temporarily unavailable");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--request",
      "Retry terminal callback",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:main"
    ]);
    const message = {
      id: "msg-stable-retry-id",
      ts: "2026-07-20T00:00:00.000Z",
      conversation_id: created.conversation.conversation_id,
      from: "codex",
      to: "openclaw",
      type: "done",
      requires_response: false,
      round: 1,
      max_rounds: 50,
      body: "Finished exactly once.",
      metadata: {}
    };
    const failed = spawnSync(process.execPath, [
      binPath,
      "callback",
      "--state",
      created.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--openclaw-bin",
      fakeOpenClaw,
      "--disable-callback-retry",
      "--close-terminal-bridge-on-done",
      "--message-json",
      JSON.stringify(message)
    ], { encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /gateway temporarily unavailable/);

    const failedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(failedState.status, "callback_failed");
    assert.equal(failedState.closed_at, undefined);
    assert.equal(failedState.callback_delivery.status, "failed");
    assert.equal(failedState.callback_delivery.attempts, 1);
    const persistedMessageId = failedState.callback_delivery.message.id;
    assert.match(persistedMessageId, /^msg-/);

    fs.writeFileSync(allowDeliveryPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    assert.equal(retried.delivered, true);
    assert.equal(retried.conversation.status, "closed");
    assert.equal(retried.conversation.close_reason, "terminal bridge task completed");
    assert.equal(retried.conversation.callback_delivery.status, "delivered");
    assert.equal(retried.conversation.callback_delivery.attempts, 2);
    assert.equal(retried.message.id, persistedMessageId);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) =>
      event.event === "message" && (event.message?.id ?? event.id) === persistedMessageId
    ).length, 1);
    assert.equal(events.some((event) => event.event === "callback_delivery_failed"), true);
    assert.equal(events.some((event) => event.event === "callback_delivery_retry_started"), true);
    assert.equal(events.some((event) => event.event === "callback_delivery_succeeded"), true);
    assert.equal(fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("terminal bridge callback retries transient gateway failure automatically", async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-auto-retry-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-auto-retry-"));
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = ${JSON.stringify(callsPath)};
const calls = fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim().split(/\\r?\\n/).filter(Boolean) : [];
fs.appendFileSync(path, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
if (calls.length === 0) {
  console.error("temporary gateway failure");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--request",
      "Automatic retry",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:main"
    ]);
    const failed = spawnSync(process.execPath, [
      binPath,
      "callback",
      "--state",
      created.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--openclaw-bin",
      fakeOpenClaw,
      "--close-terminal-bridge-on-done",
      "--message-json",
      JSON.stringify({ from: "codex", to: "openclaw", type: "done", body: "Auto retry result." })
    ], { encoding: "utf8" });
    assert.notEqual(failed.status, 0);

    const closed = await waitForConversationState(created.paths.statePath, "closed", 10000);
    assert.equal(closed.callback_delivery.status, "delivered");
    assert.equal(closed.callback_delivery.attempts, 2);
    assert.equal(fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/).length, 2);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback delivers chat_send requested by plugin gateway method", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-chat-send-"));
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
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  console.log(JSON.stringify({
    ok: true,
    chat_send: {
      sessionKey: params.sessionKey,
      message: [
        "[Agent Knock Knock callback]",
        \`Conversation: \${params.message.conversation_id}\`,
        "Message type: done",
        "",
        params.message.body,
        "",
        "[AKK convenience commands]",
        "When summarizing this result to the user, include these short next-step commands:",
        "- \`AKK list\` lists open AKK sessions.",
        \`- \\\`AKK send \${params.message.conversation_id}: <message>\\\` sends a follow-up to this same AKK session.\`,
        \`- \\\`AKK status \${params.message.conversation_id}\\\` shows this session status.\`,
        \`- \\\`AKK close \${params.message.conversation_id}\\\` closes this AKK session.\`
      ].join("\\n"),
      idempotencyKey: "akk-test-chat-send",
      deliver: true
    }
  }));
} else if (method === "chat.send") {
  console.log(JSON.stringify({ runId: "akk-test-chat-send", status: "started", messageSeq: 2 }));
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
    assert.equal(callback.delivery, "gateway_method+chat_send");

    const calls = fs.readFileSync(gatewayCallPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.deepEqual(calls[1].slice(0, 3), ["gateway", "call", "chat.send"]);
    const chatSendParams = JSON.parse(calls[1][calls[1].indexOf("--params") + 1]);
    assert.equal(chatSendParams.sessionKey, "agent:main:main");
    assert.equal(chatSendParams.idempotencyKey, "akk-test-chat-send");
    assert.match(chatSendParams.message, /AKK convenience commands/);
    assert.match(chatSendParams.message, /AKK list/);
    assert.match(chatSendParams.message, new RegExp(`AKK send ${created.conversation.conversation_id}: <message>`));
    assert.equal(chatSendParams.deliver, true);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) =>
      event.event === "callback_chat_send_delivery" &&
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

async function waitForConversationState(statePath: string, status: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.status === status) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${status}`);
}

interface CliAsyncResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCliAsync(args): Promise<CliAsyncResult> {
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

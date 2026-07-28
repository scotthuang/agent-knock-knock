import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  applyMessageToConversation,
  createConversation,
  createMessage,
  type ExecutorKind
} from "../src/protocol.js";
import {
  appendEvent,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("callback records a structured Claude message before delivery", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-"));

  try {
    const created = createCallbackConversation(storeDir, "Callback test");
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
    const created = createCallbackConversation(
      storeDir,
      "Callback duplicate test"
    );
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
    const created = createCallbackConversation(
      storeDir,
      "Callback corrupted log test"
    );
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
    const created = createCallbackConversation(
      storeDir,
      "Callback concurrent duplicate test"
    );
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

    const created = createCallbackConversation(
      storeDir,
      "Callback gateway method test",
      {
        agent: "codex",
        session: "codex-callback",
        openclawSession: "agent:main:main"
      }
    );

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
const params = JSON.parse(args[args.indexOf("--params") + 1]);
if (fs.existsSync(params.statePath + ".lock")) {
  console.error("state lock held during gateway delivery");
  process.exit(97);
}
if (!fs.existsSync(${JSON.stringify(allowDeliveryPath)})) {
  console.error("gateway temporarily unavailable");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = createCallbackConversation(
      storeDir,
      "Retry terminal callback",
      {
        agent: "codex",
        openclawSession: "agent:main:main"
      }
    );
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

test("startup reconciliation recovers a persisted pending callback without duplicating it", async () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-pending-recovery-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-pending-recovery-"));
  const callsPath = path.join(fakeBinDir, "calls.ndjson");

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + "\\n", "utf8");
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = createCallbackConversation(
      storeDir,
      "Recover callback_pending after a crash",
      {
        agent: "codex",
        openclawSession: "agent:main:main"
      }
    );
    const message = {
      id: "msg-pending-crash-recovery",
      ts: "2026-07-24T00:00:00.000Z",
      conversation_id: created.conversation.conversation_id,
      from: "codex",
      to: "openclaw",
      type: "done",
      requires_response: false,
      round: 1,
      max_rounds: 50,
      body: "Recovered from persisted pending delivery.",
      metadata: {}
    };
    fs.appendFileSync(created.paths.logPath, `${JSON.stringify({
      ts: message.ts,
      conversation_id: message.conversation_id,
      event: "message",
      from: message.from,
      to: message.to,
      type: message.type,
      requires_response: message.requires_response,
      round: message.round,
      body: message.body,
      message
    })}\n`, "utf8");

    const seededAt = new Date().toISOString();
    const seededState = {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      status: "callback_pending",
      callback_delivery: {
        status: "pending",
        message,
        attempts: 1,
        created_at: seededAt,
        last_attempt_at: seededAt,
        gateway_method: "agent-knock-knock.callback",
        gateway_session: "agent:main:main",
        openclaw_bin: fakeOpenClaw,
        close_terminal_bridge_on_done: true,
        track_delivery: true,
        final_status: "idle"
      },
      updated_at: seededAt
    };
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify(seededState, null, 2)}\n`, "utf8");

    const reconciliation = runCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--callback-retry-delay-ms",
      "25"
    ]);
    assert.equal(reconciliation.launched, 1);
    assert.equal(reconciliation.items[0].reason, "callback_delivery_reconciliation");
    const recovered = await waitForConversationState(
      created.paths.statePath,
      "closed",
      5_000
    );
    assert.equal(recovered.callback_delivery.message.id, message.id);
    assert.equal(recovered.callback_delivery.status, "delivered");
    assert.equal(recovered.callback_delivery.attempts, 2);

    const redundantReconciliation = runCli([
      "reconcile-monitors",
      "--store-dir",
      storeDir,
      "--callback-retry-delay-ms",
      "0"
    ]);
    assert.equal(redundantReconciliation.launched, 0);
    assert.equal(fs.readFileSync(callsPath, "utf8").trim().split(/\r?\n/).length, 1);
    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.filter((event) =>
      event.event === "message" && (event.message?.id ?? event.id) === message.id
    ).length, 1);
    assert.equal(events.filter((event) =>
      event.event === "callback_delivery_succeeded" && event.message_id === message.id
    ).length, 1);
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
    const created = createCallbackConversation(storeDir, "Automatic retry", {
      agent: "codex",
      openclawSession: "agent:main:main"
    });
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
    delivery_required: true,
    delivery_mode: "chat.send",
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
} else if (method === "agent.wait") {
  console.log(JSON.stringify({
    runId: "akk-test-chat-send",
    status: "ok",
    endedAt: Date.now()
  }));
} else {
  console.log(JSON.stringify({ ok: true }));
}
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = createCallbackConversation(
      storeDir,
      "Callback session send test",
      { openclawSession: "agent:main:main" }
    );

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
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[0].slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.deepEqual(calls[1].slice(0, 3), ["gateway", "call", "chat.send"]);
    assert.deepEqual(calls[2].slice(0, 3), ["gateway", "call", "agent.wait"]);
    const chatSendParams = JSON.parse(calls[1][calls[1].indexOf("--params") + 1]);
    assert.equal(chatSendParams.sessionKey, "agent:main:main");
    assert.equal(chatSendParams.idempotencyKey, "akk-test-chat-send");
    assert.match(chatSendParams.message, /AKK convenience commands/);
    assert.match(chatSendParams.message, /AKK list/);
    assert.match(chatSendParams.message, new RegExp(`AKK send ${created.conversation.conversation_id}: <message>`));
    assert.equal(chatSendParams.deliver, true);
    const agentWaitParams = JSON.parse(calls[2][calls[2].indexOf("--params") + 1]);
    assert.equal(agentWaitParams.runId, "akk-test-chat-send");
    assert.equal(agentWaitParams.timeoutMs, 20_000);
    assert.equal(calls[2][calls[2].indexOf("--timeout") + 1], "25000");

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) =>
      event.event === "callback_chat_send_delivery" &&
      event.status === 0
    ), true);
    assert.equal(events.some((event) =>
      event.event === "callback_agent_wait_delivery" &&
      event.run_id === "akk-test-chat-send" &&
      event.run_status === "ok" &&
      event.status === 0
    ), true);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback keeps chat_send retryable until agent.wait reports success", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-chat-wait-retry-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  const allowWaitPath = path.join(fakeBinDir, "allow-wait");
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
const method = args[2];
if (method === "agent-knock-knock.callback") {
  const params = JSON.parse(args[args.indexOf("--params") + 1]);
  console.log(JSON.stringify({
    ok: true,
    delivery_required: true,
    chat_send: {
      sessionKey: params.sessionKey,
      message: "Retry this callback safely.",
      idempotencyKey: "akk-wait-retry",
      deliver: true
    }
  }));
} else if (method === "chat.send") {
  console.log(JSON.stringify({ runId: "akk-wait-retry", status: "in_flight" }));
} else if (method === "agent.wait") {
  console.log(JSON.stringify(fs.existsSync(${JSON.stringify(allowWaitPath)})
    ? { runId: "akk-wait-retry", status: "ok", endedAt: Date.now() }
    : { runId: "akk-wait-retry", status: "timeout" }));
}
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = createCallbackConversation(
      storeDir,
      "Wait for callback run completion",
      {
        agent: "codex",
        openclawSession: "agent:main:main"
      }
    );
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
      JSON.stringify({ from: "codex", to: "openclaw", type: "done", body: "Finished." })
    ], { encoding: "utf8" });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /agent\.wait returned timeout/);

    const failedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(failedState.status, "callback_failed");
    assert.equal(failedState.callback_delivery.status, "failed");
    assert.equal(failedState.closed_at, undefined);

    fs.writeFileSync(allowWaitPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    assert.equal(retried.delivered, true);
    assert.equal(retried.delivery, "gateway_method+chat_send");
    assert.equal(retried.conversation.status, "closed");
    assert.equal(retried.conversation.callback_delivery.status, "delivered");

    const calls = readJsonLines(callsPath);
    const chatSendCalls = calls.filter((args) => args[2] === "chat.send");
    assert.equal(chatSendCalls.length, 2);
    const idempotencyKeys = chatSendCalls.map((args) => {
      const params = JSON.parse(args[args.indexOf("--params") + 1]);
      return params.idempotencyKey;
    });
    assert.deepEqual(idempotencyKeys, ["akk-wait-retry", "akk-wait-retry"]);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback treats agent.wait timeout as a retryable delivery failure", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-chat-wait-timeout-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  try {
    const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        chat_send: {
          sessionKey: "agent:main:main",
          message: "Wait for this run.",
          idempotencyKey: "akk-wait-timeout",
          deliver: true
        }
      },
      chatSendPayload: { runId: "akk-wait-timeout", status: "started" },
      agentWaitPayload: { runId: "akk-wait-timeout", status: "timeout" }
    });
    const created = createCallbackConversation(
      storeDir,
      "Timeout callback run",
      { openclawSession: "agent:main:main" }
    );
    const result = runCallbackExpectFailure(created.paths.statePath, fakeOpenClaw);
    assert.match(result.stderr, /agent\.wait returned timeout/);
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.callback_delivery.status, "failed");
    assert.equal(state.status, "callback_failed");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback does not mark an agent.wait error as delivered", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-chat-wait-error-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  try {
    const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        delivery_mode: "chat.send",
        chat_send: {
          sessionKey: "agent:main:main",
          message: "This delivery will fail.",
          idempotencyKey: "akk-wait-error",
          deliver: true
        }
      },
      chatSendPayload: { runId: "akk-wait-error", status: "started" },
      agentWaitPayload: {
        runId: "akk-wait-error",
        status: "error",
        error: "channel delivery failed"
      }
    });
    const created = createCallbackConversation(
      storeDir,
      "Failed callback run",
      { openclawSession: "agent:main:main" }
    );
    const result = runCallbackExpectFailure(created.paths.statePath, fakeOpenClaw);
    assert.match(result.stderr, /channel delivery failed/);
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.callback_delivery.status, "failed");
    assert.equal(state.status, "callback_failed");
    assert.equal(state.closed_at, undefined);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback rejects mismatched Gateway run identities", () => {
  const cases = [
    {
      name: "chat.send runId",
      chatSendPayload: { runId: "different-run", status: "started" },
      agentWaitPayload: { runId: "akk-expected-run", status: "ok" },
      error: /runId does not match its idempotencyKey/
    },
    {
      name: "agent.wait runId",
      chatSendPayload: { runId: "akk-expected-run", status: "started" },
      agentWaitPayload: { runId: "different-run", status: "ok" },
      error: /result for a different runId/
    }
  ];

  for (const testCase of cases) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-run-id-"));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
    try {
      const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
        gatewayPayload: {
          ok: true,
          delivery_required: true,
          delivery_mode: "chat.send",
          chat_send: {
            sessionKey: "agent:main:main",
            message: "Verify the Gateway run identity.",
            idempotencyKey: "akk-expected-run",
            deliver: true
          }
        },
        chatSendPayload: testCase.chatSendPayload,
        agentWaitPayload: testCase.agentWaitPayload
      });
      const created = createCallbackConversation(
        storeDir,
        `Reject mismatched ${testCase.name}`,
        { openclawSession: "agent:main:main" }
      );
      const result = runCallbackExpectFailure(created.paths.statePath, fakeOpenClaw);
      assert.match(result.stderr, testCase.error);
      const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
      assert.equal(state.callback_delivery.status, "failed");
      assert.equal(state.status, "callback_failed");
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }
});

test("callback keeps legacy delivery plans compatible while confirming sessions.send", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-legacy-plan-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  try {
    const legacyOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
      gatewayPayload: {
        ok: true,
        chat_send: {
          sessionKey: "agent:main:main",
          message: "Legacy plan without delivery_required.",
          idempotencyKey: "akk-legacy-run",
          deliver: true
        }
      },
      chatSendPayload: { runId: "akk-legacy-run", status: "ok" }
    });
    const legacy = createCallbackConversation(
      storeDir,
      "Accept legacy callback plan",
      { openclawSession: "agent:main:main" }
    );
    const legacyResult = runCli([
      "callback",
      "--state",
      legacy.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--openclaw-bin",
      legacyOpenClaw,
      "--message-json",
      JSON.stringify({
        from: "claude-code",
        to: "openclaw",
        type: "done",
        body: "Legacy delivery finished."
      })
    ]);
    assert.equal(legacyResult.delivered, true);
    assert.equal(legacyResult.delivery, "gateway_method+chat_send");

    const sessionOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        delivery_mode: "sessions.send",
        session_send: {
          key: "agent:main:main",
          message: "Confirm this session delivery.",
          idempotencyKey: "akk-session-run"
        }
      },
      sessionSendPayload: { runId: "akk-session-run", status: "started" },
      agentWaitPayload: { runId: "akk-session-run", status: "ok" }
    });
    const session = createCallbackConversation(
      storeDir,
      "Confirm sessions.send callback",
      { openclawSession: "agent:main:main" }
    );
    const sessionResult = runCli([
      "callback",
      "--state",
      session.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--openclaw-bin",
      sessionOpenClaw,
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "done",
        body: "Session delivery finished."
      })
    ]);
    assert.equal(sessionResult.delivered, true);
    assert.equal(sessionResult.delivery, "gateway_method+sessions_send");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback fails closed for malformed or incomplete gateway delivery plans", () => {
  const cases = [
    {
      name: "malformed JSON",
      stdout: "not-json",
      error: /malformed JSON/
    },
    {
      name: "explicit rejection",
      gatewayPayload: { ok: false, error: "callback rejected" },
      error: /callback rejected/
    },
    {
      name: "missing required plan",
      gatewayPayload: { ok: true, delivery_required: true },
      error: /requires delivery but returned no supported/
    },
    {
      name: "invalid chat plan",
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        delivery_mode: "chat.send",
        chat_send: {}
      },
      error: /invalid chat_send delivery plan/
    },
    {
      name: "invalid session plan",
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        delivery_mode: "sessions.send",
        session_send: {}
      },
      error: /invalid session_send delivery plan/
    },
    {
      name: "mismatched mode",
      gatewayPayload: {
        ok: true,
        delivery_required: true,
        delivery_mode: "sessions.send",
        chat_send: {
          sessionKey: "agent:main:main",
          message: "Mismatch",
          idempotencyKey: "akk-mismatch",
          deliver: true
        }
      },
      error: /delivery_mode does not match/
    }
  ];

  for (const testCase of cases) {
    const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-plan-invalid-"));
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
    try {
      const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
        gatewayPayload: testCase.gatewayPayload,
        gatewayStdout: testCase.stdout
      });
      const created = createCallbackConversation(
        storeDir,
        `Reject ${testCase.name}`,
        { openclawSession: "agent:main:main" }
      );
      const result = runCallbackExpectFailure(created.paths.statePath, fakeOpenClaw);
      assert.match(result.stderr, testCase.error);
      const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
      assert.equal(state.callback_delivery.status, "failed");
      assert.equal(state.status, "callback_failed");
    } finally {
      fs.rmSync(storeDir, { recursive: true, force: true });
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  }
});

function createCallbackConversation(
  storeDir: string,
  request: string,
  {
    agent = "claude",
    session,
    openclawSession = "agent:main:main"
  }: {
    agent?: ExecutorKind;
    session?: string;
    openclawSession?: string;
  } = {}
) {
  const conversation = createConversation({
    userRequest: request,
    workspace: process.cwd(),
    openclawSession,
    executorKind: agent,
    executorSession: session
  });
  const taskMessage = createMessage({
    conversation,
    from: "openclaw",
    to: conversation.executor.actor,
    type: "task",
    body: request,
    metadata: {
      executor_kind: conversation.executor.kind,
      executor_session: conversation.executor.session
    }
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const storedConversation = {
    ...applyMessageToConversation(conversation, taskMessage),
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };

  saveState(paths.statePath, storedConversation);
  appendEvent(paths.logPath, {
    ts: conversation.created_at,
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation: storedConversation
  });
  appendEvent(paths.logPath, messageEvent(taskMessage));

  return {
    conversation: storedConversation,
    paths,
    task_message: taskMessage
  };
}

function writeCallbackPlanOpenClaw(fakeBinDir, options) {
  const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
const method = args[2];
if (method === "agent-knock-knock.callback") {
  process.stdout.write(${JSON.stringify(
    options.gatewayStdout ?? JSON.stringify(options.gatewayPayload ?? { ok: true })
  )});
} else if (method === "chat.send") {
  console.log(JSON.stringify(${JSON.stringify(options.chatSendPayload ?? {
    runId: "akk-test-run",
    status: "started"
  })}));
} else if (method === "sessions.send") {
  console.log(JSON.stringify(${JSON.stringify(options.sessionSendPayload ?? {
    runId: "akk-test-run",
    status: "started"
  })}));
} else if (method === "agent.wait") {
  console.log(JSON.stringify(${JSON.stringify(options.agentWaitPayload ?? {
    runId: "akk-test-run",
    status: "ok"
  })}));
}
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

function runCallbackExpectFailure(statePath, fakeOpenClaw) {
  const result = spawnSync(process.execPath, [
    binPath,
    "callback",
    "--state",
    statePath,
    "--gateway-method",
    "agent-knock-knock.callback",
    "--gateway-session",
    "agent:main:main",
    "--openclaw-bin",
    fakeOpenClaw,
    "--disable-callback-retry",
    "--close-terminal-bridge-on-done",
    "--message-json",
    JSON.stringify({ from: "codex", to: "openclaw", type: "done", body: "Finished." })
  ], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  return result;
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

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

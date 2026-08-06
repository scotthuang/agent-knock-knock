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
import { terminalBindingFrom } from "../src/managed-session.js";
import { saveManagedSession } from "../src/session-store.js";
import {
  appendEvent,
  messageEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

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
      "--gateway-method",
      "must.not.be.delivered",
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
    assert.equal(callback.message.session_id, created.conversation.session_id);
    assert.equal(callback.message.turn_id, created.conversation.turn_id);
    assert.equal(callback.conversation.session_id, created.conversation.session_id);
    assert.equal(callback.conversation.turn_id, created.conversation.turn_id);

    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(state.status, "idle");
    assert.match(state.idle_since, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(state.callback_delivery, undefined);

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

test("a unique late callback cannot reopen a released turn", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-late-"));

  try {
    const created = createCallbackConversation(
      storeDir,
      "Released turn callback test"
    );
    const releasedAt = new Date().toISOString();
    saveState(created.paths.statePath, {
      ...created.conversation,
      status: "closed",
      closed_at: releasedAt,
      close_reason: "closed before the agent callback arrived",
      updated_at: releasedAt
    });
    const stateBefore = fs.readFileSync(created.paths.statePath, "utf8");
    const logBefore = fs.readFileSync(created.paths.logPath, "utf8");

    const result = spawnSync(process.execPath, [
      binPath,
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        id: "msg-late-after-close",
        conversation_id: created.conversation.conversation_id,
        session_id: created.conversation.session_id,
        turn_id: created.conversation.turn_id,
        from: "claude-code",
        to: "openclaw",
        type: "done",
        requires_response: false,
        round: 1,
        max_rounds: 50,
        body: "Late completion must not reopen the Turn.",
        metadata: {}
      })
    ], { encoding: "utf8" });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /refusing late callback .* released Turn/u);
    assert.equal(fs.readFileSync(created.paths.statePath, "utf8"), stateBefore);
    assert.equal(fs.readFileSync(created.paths.logPath, "utf8"), logBefore);
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
  const gatewayUrl = "ws://127.0.0.1:29871";

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
      "--gateway-url",
      gatewayUrl,
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
    assert.equal(callback.conversation.status, "waiting_for_openclaw");
    assert.equal(callback.conversation.callback_delivery.status, "delivered");

    const gatewayArgs = JSON.parse(fs.readFileSync(gatewayCallPath, "utf8"));
    assert.deepEqual(gatewayArgs.slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.equal(gatewayArgs.includes("--token"), false);
    assert.doesNotMatch(JSON.stringify(gatewayArgs), new RegExp(gatewayToken));
    assert.equal(gatewayArgs[gatewayArgs.indexOf("--url") + 1], gatewayUrl);
    const params = JSON.parse(gatewayArgs[gatewayArgs.indexOf("--params") + 1]);
    assert.equal(params.sessionKey, "agent:main:main");
    assert.equal(params.message.type, "question");
    assert.equal(params.message.body, "Should the export include CSV?");
    assert.equal(params.message.session_id, created.conversation.session_id);
    assert.equal(params.message.turn_id, created.conversation.turn_id);
    assert.equal(params.conversation.session_id, created.conversation.session_id);
    assert.equal(params.conversation.turn_id, created.conversation.turn_id);
    assert.equal(params.message.session_id, params.conversation.session_id);
    assert.equal(params.message.turn_id, params.conversation.turn_id);
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

test("a failed question notification keeps the Turn waiting_for_openclaw", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-question-failed-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-question-failed-")
  );
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
console.error("question callback channel unavailable");
process.exit(1);
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = createCallbackConversation(
      storeDir,
      "Keep question phase independent from transport",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const result = spawnSync(process.execPath, [
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
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "question",
        body: "Which release channel should I use?"
      })
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /question callback channel unavailable/u);

    const state = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(state.status, "waiting_for_openclaw");
    assert.equal(state.callback_delivery.status, "failed");
    assert.equal(state.callback_delivery.final_status, "waiting_for_openclaw");
    assert.equal(state.idle_since, undefined);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback Gateway delivery derives session and turn identities for legacy state", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-legacy-identity-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-legacy-identity-"));
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

    const created = createCallbackConversation(storeDir, "Legacy callback identity");
    const persisted = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    delete persisted.session_id;
    delete persisted.turn_id;
    saveState(created.paths.statePath, persisted);

    const callback = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--gateway-method",
      "agent-knock-knock.callback",
      "--gateway-session",
      "agent:main:main",
      "--openclaw-bin",
      fakeOpenClaw,
      "--message-json",
      JSON.stringify({
        from: "claude-code",
        to: "openclaw",
        type: "done",
        body: "Legacy state still correlates this callback."
      })
    ]);

    const legacyId = created.conversation.conversation_id;
    assert.equal(callback.conversation.session_id, legacyId);
    assert.equal(callback.conversation.turn_id, legacyId);
    assert.equal(callback.message.session_id, legacyId);
    assert.equal(callback.message.turn_id, legacyId);

    const gatewayArgs = JSON.parse(fs.readFileSync(gatewayCallPath, "utf8"));
    const params = JSON.parse(gatewayArgs[gatewayArgs.indexOf("--params") + 1]);
    assert.equal(params.conversation.session_id, legacyId);
    assert.equal(params.conversation.turn_id, legacyId);
    assert.equal(params.message.session_id, legacyId);
    assert.equal(params.message.turn_id, legacyId);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("closing a Turn does not abandon its failed callback outbox", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-retry-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-retry-"));
  const allowDeliveryPath = path.join(fakeBinDir, "allow-delivery");
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  const configuredGatewayUrl = "ws://127.0.0.1:29872";

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (args.includes("--url")) {
  console.error("config-routed callback must not pass --url without a token");
  process.exit(96);
}
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
    saveState(created.paths.statePath, {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      gateway_url: configuredGatewayUrl
    });
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
      "--message-json",
      JSON.stringify(message)
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_TOKEN: ""
      }
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /gateway temporarily unavailable/);

    const failedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(failedState.status, "idle");
    assert.match(failedState.idle_since, /^\d{4}-\d{2}-\d{2}T/u);
    assert.equal(failedState.closed_at, undefined);
    assert.equal(failedState.callback_delivery.status, "failed");
    assert.equal(failedState.callback_delivery.attempts, 1);
    assert.equal(failedState.callback_delivery.gateway_url, undefined);
    const persistedMessageId = failedState.callback_delivery.message.id;
    assert.match(persistedMessageId, /^msg-/);
    saveState(created.paths.statePath, {
      ...failedState,
      callback_delivery: {
        ...failedState.callback_delivery,
        gateway_url: configuredGatewayUrl
      }
    });

    const closed = runCli([
      "close",
      "--state",
      created.paths.statePath,
      "--reason",
      "close while callback delivery is failed"
    ]);
    assert.equal(closed.conversation.status, "closed");
    assert.equal(
      closed.conversation.callback_delivery.status,
      "failed"
    );
    const closedAt = closed.conversation.closed_at;
    const closeReason = closed.conversation.close_reason;
    const turnUpdatedAt = closed.conversation.updated_at;

    fs.writeFileSync(allowDeliveryPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ], {
      AKK_GATEWAY_TOKEN: "",
      OPENCLAW_GATEWAY_TOKEN: ""
    });
    assert.equal(retried.delivered, true);
    assert.equal(retried.conversation.status, "closed");
    assert.equal(retried.conversation.closed_at, closedAt);
    assert.equal(retried.conversation.close_reason, closeReason);
    assert.equal(retried.conversation.updated_at, turnUpdatedAt);
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
    const calls = readJsonLines(callsPath);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((args) => !args.includes("--url")), true);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("closing during callback delivery preserves a later failure and retry", async () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-close-pending-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-close-pending-")
  );
  const startedPath = path.join(fakeBinDir, "gateway-started");
  const releasePath = path.join(fakeBinDir, "gateway-release");
  const allowSuccessPath = path.join(fakeBinDir, "allow-success");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (fs.existsSync(${JSON.stringify(allowSuccessPath)})) {
  console.log(JSON.stringify({ ok: true }));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
console.error("gateway failed after the Turn was closed");
process.exit(1);
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = createCallbackConversation(
      storeDir,
      "Close while callback delivery is pending",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const callbackPromise = runCliAsync(
      callbackDeliveryArgs(created.paths.statePath, fakeOpenClaw)
    );
    await waitForFile(startedPath, 2_000);
    const pending = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(pending.status, "idle");
    assert.equal(pending.callback_delivery.status, "pending");

    const closed = runCli([
      "close",
      "--state",
      created.paths.statePath,
      "--reason",
      "closed while callback attempt was in flight"
    ]);
    assert.equal(closed.conversation.status, "closed");
    assert.equal(closed.conversation.callback_delivery.status, "pending");
    const closedAt = closed.conversation.closed_at;
    const closeReason = closed.conversation.close_reason;
    const turnUpdatedAt = closed.conversation.updated_at;

    fs.writeFileSync(releasePath, "release", "utf8");
    const callback = await callbackPromise;
    assert.notEqual(callback.status, 0);
    assert.match(callback.stderr, /failed after the Turn was closed/u);
    const failed = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(failed.status, "closed");
    assert.equal(failed.closed_at, closedAt);
    assert.equal(failed.close_reason, closeReason);
    assert.equal(failed.updated_at, turnUpdatedAt);
    assert.equal(failed.callback_delivery.status, "failed");

    fs.writeFileSync(allowSuccessPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    assert.equal(retried.delivered, true);
    assert.equal(retried.conversation.status, "closed");
    assert.equal(retried.conversation.closed_at, closedAt);
    assert.equal(retried.conversation.close_reason, closeReason);
    assert.equal(retried.conversation.updated_at, turnUpdatedAt);
    assert.equal(retried.conversation.callback_delivery.status, "delivered");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("a claimed callback message id cannot be reused with a different payload", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-immutable-outbox-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-immutable-outbox-")
  );
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
console.error("gateway unavailable while claiming immutable callback");
process.exit(1);
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = createCallbackConversation(
      storeDir,
      "Reject payload substitution after callback claim",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const initial = runCallbackExpectFailure(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.match(initial.stderr, /gateway unavailable/u);
    const claimed = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(claimed.status, "idle");
    assert.equal(claimed.callback_delivery.status, "failed");
    const stateBefore = fs.readFileSync(created.paths.statePath, "utf8");
    const logBefore = fs.readFileSync(created.paths.logPath, "utf8");
    const tamperedMessage = {
      ...claimed.callback_delivery.message,
      body: "A different payload must not inherit the old callback claim."
    };

    const tampered = spawnSync(process.execPath, [
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
      "--preserve-message-id",
      "--message-json",
      JSON.stringify(tamperedMessage)
    ], { encoding: "utf8" });
    assert.notEqual(tampered.status, 0);
    assert.match(
      tampered.stderr,
      /conflicts with its persisted immutable outbox payload/u
    );
    assert.equal(fs.readFileSync(created.paths.statePath, "utf8"), stateBefore);
    assert.equal(fs.readFileSync(created.paths.logPath, "utf8"), logBefore);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("an immutable callback retry survives a later Session binding generation", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-binding-retry-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-binding-retry-")
  );
  const allowDeliveryPath = path.join(fakeBinDir, "allow-delivery");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
if (!fs.existsSync(${JSON.stringify(allowDeliveryPath)})) {
  console.error("binding callback gateway unavailable");
  process.exit(1);
}
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);

    const created = createCallbackConversation(
      storeDir,
      "Retry an already-claimed callback after Session rebinding",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const nativeThreadId = "22222222-2222-4222-8222-222222222222";
    const processUuid = "codex-pid:52001:birth:callback-fixture";
    const terminalControl: TerminalControlRef = {
      kind: "tmux",
      target: "akk-callback-binding:0.0",
      session: "akk-callback-binding",
      window: 0,
      pane: 0,
      panePid: 52000,
      currentCommand: "codex",
      currentPath: created.conversation.workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    };
    const terminalId =
      `terminal:v2:tmux:codex:${terminalControl.target}:52001`;
    const firstBinding = terminalBindingFrom({
      terminalId,
      terminalControl,
      pid: 52001,
      nativeThreadId,
      processUuid,
      processBirth: processUuid,
      evidence: "callback_binding_fixture",
      generation: 1
    });
    const now = new Date().toISOString();
    const managedSession = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: created.conversation.session_id,
      agent: "codex",
      workspace: created.conversation.workspace,
      status: "bound",
      binding: firstBinding,
      lineage: { created_by: "attach" },
      created_at: now,
      updated_at: now
    }, { expectedRevision: null });
    saveState(created.paths.statePath, {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      terminal_binding_id: firstBinding.binding_id,
      terminal_binding_generation: firstBinding.generation,
      native_thread_id: nativeThreadId,
      native_session_takeover: {
        agent: "codex",
        terminal_agent_identity_protocol: 1,
        native_session_id: terminalId,
        terminal_agent_pid: 52001,
        terminal_agent_session_id: nativeThreadId,
        terminal_agent_process_uuid: processUuid,
        terminal_agent_process_birth: processUuid,
        terminal_agent_identity_evidence: "callback_binding_fixture",
        source_cwd: created.conversation.workspace,
        strategy: "terminal_control",
        terminal_control: terminalControl,
        terminal_bridge: true
      }
    });

    const initial = runCallbackExpectFailure(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.match(initial.stderr, /binding callback gateway unavailable/u);
    const claimed = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(claimed.status, "idle");
    assert.equal(claimed.callback_delivery.status, "failed");
    const callbackMessageId = claimed.callback_delivery.message.id;

    const secondBinding = terminalBindingFrom({
      terminalId,
      terminalControl,
      pid: 52001,
      nativeThreadId,
      processUuid,
      processBirth: processUuid,
      evidence: "callback_binding_fixture",
      generation: 2
    });
    saveManagedSession(storeDir, {
      ...managedSession,
      binding: secondBinding,
      updated_at: new Date().toISOString()
    }, { expectedRevision: managedSession.revision! });

    fs.writeFileSync(allowDeliveryPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    assert.equal(retried.delivered, true);
    assert.equal(retried.message.id, callbackMessageId);
    assert.equal(retried.conversation.status, "idle");
    assert.equal(retried.conversation.callback_delivery.status, "delivered");
    assert.equal(retried.conversation.callback_delivery.attempts, 2);
    assert.equal(retried.conversation.terminal_binding_generation, 1);
    const duplicate = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--preserve-message-id",
      "--message-json",
      JSON.stringify(retried.message)
    ]);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.conversation.status, "idle");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback retry preserves a persisted explicit Gateway URL and token pair", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-authenticated-retry-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-openclaw-authenticated-retry-"));
  const allowDeliveryPath = path.join(fakeBinDir, "allow-delivery");
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  const gatewayUrl = "ws://127.0.0.1:29874";
  const gatewayToken = "persisted-retry-token";

  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (process.env.OPENCLAW_GATEWAY_TOKEN !== ${JSON.stringify(gatewayToken)}) {
  console.error("expected persisted Gateway token");
  process.exit(98);
}
if (args[args.indexOf("--url") + 1] !== ${JSON.stringify(gatewayUrl)}) {
  console.error("expected persisted Gateway URL");
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
      "Retry an explicitly authenticated callback",
      {
        agent: "codex",
        openclawSession: "agent:main:main"
      }
    );
    saveState(created.paths.statePath, {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      gateway_url: gatewayUrl,
      gateway_token: gatewayToken
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
      "--gateway-url",
      gatewayUrl,
      "--token",
      gatewayToken,
      "--openclaw-bin",
      fakeOpenClaw,
      "--disable-callback-retry",
      "--close-terminal-bridge-on-done",
      "--message-json",
      JSON.stringify({ from: "codex", to: "openclaw", type: "done", body: "Finished." })
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_TOKEN: ""
      }
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /gateway temporarily unavailable/);
    const failedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(failedState.callback_delivery.gateway_url, gatewayUrl);
    assert.equal(failedState.callback_delivery.gateway_token, undefined);

    fs.writeFileSync(allowDeliveryPath, "yes", "utf8");
    const retried = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ], {
      AKK_GATEWAY_TOKEN: "",
      OPENCLAW_GATEWAY_TOKEN: ""
    });
    assert.equal(retried.delivered, true);
    assert.equal(retried.conversation.status, "closed");
    assert.equal(retried.conversation.callback_delivery.attempts, 2);
    const calls = readJsonLines(callsPath);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((args) =>
      args[args.indexOf("--url") + 1] === gatewayUrl
    ), true);
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
    const recovered = await waitForCallbackDeliveryState(
      created.paths.statePath,
      "delivered",
      5_000
    );
    assert.equal(recovered.status, "closed");
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
  const configuredGatewayUrl = "ws://127.0.0.1:29873";
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const path = ${JSON.stringify(callsPath)};
const calls = fs.existsSync(path) ? fs.readFileSync(path, "utf8").trim().split(/\\r?\\n/).filter(Boolean) : [];
const args = process.argv.slice(2);
fs.appendFileSync(path, JSON.stringify(args) + "\\n", "utf8");
if (args.includes("--url")) {
  console.error("config-routed retry must not pass --url without a token");
  process.exit(96);
}
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
    saveState(created.paths.statePath, {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      gateway_url: configuredGatewayUrl
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
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_GATEWAY_TOKEN: "",
        OPENCLAW_GATEWAY_TOKEN: ""
      }
    });
    assert.notEqual(failed.status, 0);

    const failedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(failedState.callback_delivery.gateway_url, undefined);
    saveState(created.paths.statePath, {
      ...failedState,
      callback_delivery: {
        ...failedState.callback_delivery,
        gateway_url: configuredGatewayUrl
      }
    });

    const closed = await waitForCallbackDeliveryState(
      created.paths.statePath,
      "delivered",
      20_000
    );
    assert.equal(closed.status, "closed");
    assert.equal(closed.callback_delivery.status, "delivered");
    assert.equal(closed.callback_delivery.attempts, 2);
    assert.equal(closed.callback_delivery.gateway_url, undefined);
    const calls = readJsonLines(callsPath);
    assert.equal(calls.length, 2);
    assert.equal(calls.every((args) => !args.includes("--url")), true);
  } finally {
    fs.rmSync(storeDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
    fs.rmSync(fakeBinDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100
    });
  }
});

test("manual callback retry reports the exact automatic attempt in flight", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-retry-in-flight-")
  );
  try {
    const created = createCallbackConversation(
      storeDir,
      "Report the callback claim instead of a generic retry error",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const message = createMessage({
      conversation: created.conversation,
      id: "msg-callback-attempt-in-flight",
      from: "codex",
      to: "openclaw",
      type: "done",
      body: "The immutable completion payload is already being delivered."
    });
    const claimedAt = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + 120_000).toISOString();
    const nextAttemptAt = new Date(Date.now() + 15_000).toISOString();
    const semanticState = applyMessageToConversation(
      JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      message
    );
    saveState(created.paths.statePath, {
      ...semanticState,
      callback_delivery: {
        status: "pending",
        message,
        attempts: 2,
        attempt_id: "callback-attempt-2",
        attempt_pid: process.pid,
        attempt_lease_expires_at: leaseExpiresAt,
        created_at: claimedAt,
        last_attempt_at: claimedAt,
        updated_at: claimedAt,
        gateway_method: "agent-knock-knock.callback",
        gateway_session: "agent:main:main",
        openclaw_bin: "openclaw",
        close_terminal_bridge_on_done: false,
        track_delivery: true,
        final_status: "idle",
        preserve_conversation_status: true,
        retry_monitor_pid: process.pid,
        next_attempt_at: nextAttemptAt
      }
    });
    appendEvent(created.paths.logPath, messageEvent(message));
    const stateBefore = fs.readFileSync(created.paths.statePath, "utf8");

    const result = spawnSync(process.execPath, [
      binPath,
      "retry-callback",
      "--state",
      created.paths.statePath
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /attempt 2[^\n]*in flight/iu);
    assert.match(result.stderr, new RegExp(escapeRegExp(nextAttemptAt), "u"));
    assert.equal(fs.readFileSync(created.paths.statePath, "utf8"), stateBefore);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
  }
});

test("concurrent callback retries claim one attempt and report the winner in flight", async () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-retry-cas-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-retry-cas-")
  );
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  const releasePath = path.join(fakeBinDir, "release");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(
  ${JSON.stringify(callsPath)},
  JSON.stringify({ method: "gateway" }) + "\\n"
);
const deadline = Date.now() + 5000;
while (!fs.existsSync(${JSON.stringify(releasePath)}) && Date.now() < deadline) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
}
if (!fs.existsSync(${JSON.stringify(releasePath)})) {
  console.error("test gate timed out");
  process.exit(2);
}
console.log(JSON.stringify({ ok: true }));
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = createCallbackConversation(
      storeDir,
      "Serialize callback retry claims",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const message = createMessage({
      conversation: created.conversation,
      id: "msg-callback-retry-cas",
      from: "codex",
      to: "openclaw",
      type: "done",
      body: "Retry this immutable callback once."
    });
    const failedAt = new Date().toISOString();
    const semanticState = applyMessageToConversation(
      JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      message
    );
    saveState(created.paths.statePath, {
      ...semanticState,
      callback_delivery: {
        status: "failed",
        message,
        attempts: 1,
        attempt_id: "callback-attempt-1",
        created_at: failedAt,
        last_attempt_at: failedAt,
        failed_at: failedAt,
        last_error: "seeded transient failure",
        gateway_method: "agent-knock-knock.callback",
        gateway_session: "agent:main:main",
        openclaw_bin: fakeOpenClaw,
        close_terminal_bridge_on_done: false,
        track_delivery: true,
        final_status: "idle",
        preserve_conversation_status: true
      }
    });
    appendEvent(created.paths.logPath, messageEvent(message));

    const winnerPromise = runCliAsync([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    const claimed = await waitForCallbackDeliveryState(
      created.paths.statePath,
      "pending",
      2_000
    );
    assert.equal(claimed.callback_delivery.attempts, 2);
    assert.equal(typeof claimed.callback_delivery.attempt_id, "string");
    assert.equal(typeof claimed.callback_delivery.attempt_pid, "number");

    const loser = spawnSync(process.execPath, [
      binPath,
      "retry-callback",
      "--state",
      created.paths.statePath
    ], { encoding: "utf8" });
    assert.notEqual(loser.status, 0);
    assert.match(loser.stderr, /attempt 2[^\n]*in flight/iu);

    fs.writeFileSync(releasePath, "release", "utf8");
    const winner = await winnerPromise;
    assert.equal(winner.status, 0, winner.stderr || winner.stdout);
    const finalState = JSON.parse(
      fs.readFileSync(created.paths.statePath, "utf8")
    );
    assert.equal(finalState.status, "idle");
    assert.equal(finalState.callback_delivery.status, "delivered");
    assert.equal(finalState.callback_delivery.attempts, 2);
    assert.equal(readJsonLines(callsPath).length, 1);
    const events = readJsonLines(created.paths.logPath);
    assert.equal(events.filter((event) =>
      event.event === "message" && event.message?.id === message.id
    ).length, 1);
    assert.equal(events.filter((event) =>
      event.event === "callback_delivery_succeeded" &&
      event.message_id === message.id
    ).length, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("retry settles persisted accepted wake evidence without redelivery", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-accepted-recovery-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-openclaw-accepted-recovery-")
  );
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
require("node:fs").appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
process.exit(99);
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const created = createCallbackConversation(
      storeDir,
      "Recover a wake accepted before process interruption",
      { agent: "codex", openclawSession: "agent:main:main" }
    );
    const message = createMessage({
      conversation: created.conversation,
      id: "msg-callback-accepted-before-crash",
      from: "codex",
      to: "openclaw",
      type: "done",
      body: "The callback wake was already accepted."
    });
    const acceptedAt = new Date().toISOString();
    const semanticState = applyMessageToConversation(
      JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      message
    );
    saveState(created.paths.statePath, {
      ...semanticState,
      callback_delivery: {
        status: "pending",
        message,
        attempts: 2,
        attempt_id: "callback-attempt-interrupted-after-wake",
        created_at: acceptedAt,
        last_attempt_at: acceptedAt,
        updated_at: acceptedAt,
        gateway_method: "agent-knock-knock.callback",
        gateway_session: "agent:main:main",
        openclaw_bin: fakeOpenClaw,
        close_terminal_bridge_on_done: false,
        track_delivery: true,
        final_status: "idle",
        preserve_conversation_status: true,
        injection: {
          status: "accepted",
          enqueued: true,
          accepted_at: acceptedAt
        },
        wake: {
          status: "accepted",
          mode: "chat.send",
          run_id: "accepted-callback-run",
          acknowledgement_status: "started",
          idempotency_key: "accepted-callback-run",
          accepted_at: acceptedAt
        }
      }
    });
    appendEvent(created.paths.logPath, messageEvent(message));
    const turnUpdatedAt = semanticState.updated_at;

    const recovered = runCli([
      "retry-callback",
      "--state",
      created.paths.statePath
    ]);
    assert.equal(recovered.delivered, true);
    assert.equal(recovered.delivery, "accepted_transport_recovered");
    assert.equal(recovered.conversation.status, "idle");
    assert.equal(recovered.conversation.updated_at, turnUpdatedAt);
    assert.equal(recovered.conversation.callback_delivery.status, "delivered");
    assert.equal(recovered.conversation.callback_delivery.attempts, 2);
    assert.equal(
      recovered.conversation.callback_delivery.accepted_at,
      acceptedAt
    );
    assert.equal(fs.existsSync(callsPath), false);
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
        \`Session: \${params.message.session_id}\`,
        \`Turn: \${params.message.turn_id}\`,
        "Message type: done",
        "",
        params.message.body,
        "",
        "[AKK convenience commands]",
        "When summarizing this result to the user, include these short next-step commands:",
        "- \`AKK list\` lists open AKK sessions.",
        \`- \\\`AKK send \${params.message.session_id}: <message>\\\` starts a new turn in this AKK session.\`,
        \`- \\\`AKK status \${params.message.turn_id}\\\` shows this turn status.\`,
        \`- \\\`AKK close \${params.message.turn_id}\\\` closes this turn.\`
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
    assert.match(chatSendParams.message, new RegExp(`Session: ${created.conversation.session_id}`));
    assert.match(chatSendParams.message, new RegExp(`Turn: ${created.conversation.turn_id}`));
    assert.match(chatSendParams.message, new RegExp(`AKK send ${created.conversation.session_id}: <message>`));
    assert.match(chatSendParams.message, new RegExp(`AKK status ${created.conversation.turn_id}`));
    assert.match(chatSendParams.message, new RegExp(`AKK close ${created.conversation.turn_id}`));
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

test("in_flight chat.send is delivered even when agent.wait times out", () => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-chat-wait-accepted-"));
  const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-fake-openclaw-"));
  const callsPath = path.join(fakeBinDir, "calls.ndjson");
  const configuredGatewayUrl = "ws://127.0.0.1:29875";
  try {
    const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n", "utf8");
if (args.includes("--url")) {
  console.error("config-routed callback retry must not pass --url");
  process.exit(96);
}
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
  console.log(JSON.stringify({ runId: "akk-wait-retry", status: "timeout" }));
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
    saveState(created.paths.statePath, {
      ...JSON.parse(fs.readFileSync(created.paths.statePath, "utf8")),
      gateway_url: configuredGatewayUrl
    });
    const callback = runCli([
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
      "--message-json",
      JSON.stringify({ from: "codex", to: "openclaw", type: "done", body: "Finished." })
    ], {
      AKK_GATEWAY_TOKEN: "",
      OPENCLAW_GATEWAY_TOKEN: ""
    });
    assert.equal(callback.delivered, true);
    assert.equal(callback.delivery, "gateway_method+chat_send");
    assert.equal(callback.conversation.status, "idle");
    assert.equal(callback.conversation.closed_at, undefined);
    assert.equal(callback.conversation.callback_delivery.status, "delivered");
    assert.equal(callback.conversation.callback_delivery.attempts, 1);
    assert.equal(
      callback.conversation.callback_delivery.wake.acknowledgement_status,
      "in_flight"
    );
    assert.equal(
      callback.conversation.callback_delivery.run_observation.status,
      "timeout"
    );

    const calls = readJsonLines(callsPath);
    assert.equal(calls.every((args) => !args.includes("--url")), true);
    const chatSendCalls = calls.filter((args) => args[2] === "chat.send");
    assert.equal(chatSendCalls.length, 1);
    assert.equal(
      calls.filter((args) => args[2] === "agent.wait").length,
      1
    );
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("started chat.send stays delivered when agent.wait reports timeout", () => {
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
    const result = runCallbackExpectSuccess(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.equal(result.delivered, true);
    assert.equal(result.conversation.status, "idle");
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.callback_delivery.status, "delivered");
    assert.equal(state.callback_delivery.wake.acknowledgement_status, "started");
    assert.equal(state.callback_delivery.run_observation.status, "timeout");
    assert.equal(state.status, "idle");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("agent.wait error cannot roll back an accepted callback wake", () => {
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
    const result = runCallbackExpectSuccess(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.equal(result.delivered, true);
    assert.equal(result.conversation.status, "idle");
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.callback_delivery.status, "delivered");
    assert.equal(state.callback_delivery.wake.acknowledgement_status, "started");
    assert.equal(state.callback_delivery.run_observation.status, "error");
    assert.equal(
      state.callback_delivery.run_observation.error,
      "channel delivery failed"
    );
    assert.equal(state.status, "idle");
    assert.equal(state.closed_at, undefined);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("callback rejects a mismatched chat.send acknowledgement before acceptance", () => {
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
      chatSendPayload: { runId: "different-run", status: "started" },
      agentWaitPayload: { runId: "akk-expected-run", status: "ok" }
    });
    const created = createCallbackConversation(
      storeDir,
      "Reject mismatched chat.send runId",
      { openclawSession: "agent:main:main" }
    );
    const result = runCallbackExpectFailure(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.match(result.stderr, /runId does not match its idempotencyKey/u);
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.callback_delivery.status, "failed");
    assert.equal(state.status, "idle");
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("durably enqueued injection stays delivered when wake acknowledgement is invalid", () => {
  const storeDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-callback-injection-accepted-")
  );
  const fakeBinDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-fake-openclaw-")
  );
  try {
    const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
      gatewayPayload: {
        ok: true,
        enqueued: true,
        injection_id: "durable-injection-1",
        delivery_required: true,
        delivery_mode: "chat.send",
        chat_send: {
          sessionKey: "agent:main:main",
          message: "Wake the already-enqueued callback.",
          idempotencyKey: "akk-enqueued-run",
          deliver: true
        }
      },
      chatSendPayload: { runId: "different-run", status: "started" }
    });
    const created = createCallbackConversation(
      storeDir,
      "Keep durable injection accepted",
      { openclawSession: "agent:main:main" }
    );
    const result = runCallbackExpectSuccess(
      created.paths.statePath,
      fakeOpenClaw
    );
    assert.equal(result.delivered, true);
    assert.equal(result.conversation.status, "idle");
    const delivery = result.conversation.callback_delivery;
    assert.equal(delivery.status, "delivered");
    assert.equal(delivery.injection.status, "accepted");
    assert.equal(delivery.injection.injection_id, "durable-injection-1");
    assert.equal(delivery.wake.status, "uncertain");
    assert.match(delivery.wake.error, /runId does not match/u);
    assert.equal(delivery.attempts, 1);
  } finally {
    fs.rmSync(storeDir, { recursive: true, force: true });
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }
});

test("invalid agent.wait observations cannot roll back an accepted wake", async (t) => {
  const cases = [
    {
      name: "mismatched run id",
      agentWaitPayload: { runId: "different-run", status: "ok" },
      error: /different runId/u
    },
    {
      name: "non-object payload",
      agentWaitPayload: "not-an-object",
      error: /malformed JSON/u
    },
    {
      name: "unexpected status",
      agentWaitPayload: { runId: "akk-expected-run", status: "mystery" },
      error: /unexpected status/u
    }
  ];

  for (const testCase of cases) {
    await t.test(testCase.name, () => {
      const storeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "akk-callback-wait-invalid-")
      );
      const fakeBinDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "akk-fake-openclaw-")
      );
      try {
        const fakeOpenClaw = writeCallbackPlanOpenClaw(fakeBinDir, {
          gatewayPayload: {
            ok: true,
            delivery_required: true,
            delivery_mode: "chat.send",
            chat_send: {
              sessionKey: "agent:main:main",
              message: "Observe this accepted callback run.",
              idempotencyKey: "akk-expected-run",
              deliver: true
            }
          },
          chatSendPayload: { runId: "akk-expected-run", status: "started" },
          agentWaitPayload: testCase.agentWaitPayload
        });
        const created = createCallbackConversation(
          storeDir,
          `Ignore invalid agent.wait ${testCase.name}`,
          { openclawSession: "agent:main:main" }
        );
        const result = runCallbackExpectSuccess(
          created.paths.statePath,
          fakeOpenClaw
        );
        assert.equal(result.delivered, true);
        assert.equal(result.conversation.status, "idle");
        const delivery = result.conversation.callback_delivery;
        assert.equal(delivery.status, "delivered");
        assert.equal(delivery.wake.acknowledgement_status, "started");
        assert.equal(delivery.run_observation.status, "invalid");
        assert.match(delivery.run_observation.error, testCase.error);
      } finally {
        fs.rmSync(storeDir, { recursive: true, force: true });
        fs.rmSync(fakeBinDir, { recursive: true, force: true });
      }
    });
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
      assert.equal(state.status, "idle");
      assert.match(state.idle_since, /^\d{4}-\d{2}-\d{2}T/u);
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
  const result = spawnSync(
    process.execPath,
    [binPath, ...callbackDeliveryArgs(statePath, fakeOpenClaw)],
    { encoding: "utf8" }
  );
  assert.notEqual(result.status, 0);
  return result;
}

function runCallbackExpectSuccess(statePath, fakeOpenClaw) {
  const result = spawnSync(
    process.execPath,
    [binPath, ...callbackDeliveryArgs(statePath, fakeOpenClaw)],
    { encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function callbackDeliveryArgs(statePath, fakeOpenClaw) {
  return [
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
    "--message-json",
    JSON.stringify({
      from: "codex",
      to: "openclaw",
      type: "done",
      body: "Finished."
    })
  ];
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

async function waitForFile(filePath: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for file ${filePath}`);
}

async function waitForCallbackDeliveryState(
  statePath: string,
  status: string,
  timeoutMs: number
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (state.callback_delivery?.status === status) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for callback delivery ${status}`);
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

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
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
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
    const cursor = runCli([
      "new",
      "--agent",
      "cursor",
      "--session",
      "cursor-work",
      "--request",
      "Cursor task",
      "--store-dir",
      storeDir
    ]);

    const listed = runCli(["list", "--store-dir", storeDir]);
    assert.deepEqual(
      listed.tasks.map((task) => [task.agent, task.session, task.status]).sort(),
      [
        ["claude", "claude-work", "waiting_for_agent"],
        ["codex", "codex-work", "waiting_for_agent"],
        ["cursor", "cursor-work", "waiting_for_agent"]
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
      "answer",
      "--all-proxy",
      "socks5h://127.0.0.1:1082",
      "--model",
      "gpt-5.5/medium"
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
    assert.deepEqual(acpxCalls[0].args, ["codex", "sessions", "ensure", "--name", "codex-work"]);
    assert.equal(acpxCalls[0].allProxy, "socks5h://127.0.0.1:1082");
    assert.deepEqual(acpxCalls[1].args.slice(0, 6), ["--approve-all", "--model", "gpt-5.5[medium]", "codex", "-s", "codex-work"]);
    assert.equal(acpxCalls[1].allProxy, "socks5h://127.0.0.1:1082");

    const cursorSent = runCli([
      "send",
      "--conversation",
      cursor.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Continue in Cursor.",
      "--type",
      "task",
      "--all-proxy",
      "socks5h://127.0.0.1:1083",
      "--model",
      "cursor-model"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cursorSent.delivered, true);
    assert.equal(cursorSent.executor.kind, "cursor");
    assert.equal(cursorSent.message.to, "cursor");

    const cursorAcpxCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .slice(2);
    assert.deepEqual(cursorAcpxCalls[0].args, ["cursor", "sessions", "ensure", "--name", "cursor-work"]);
    assert.equal(cursorAcpxCalls[0].allProxy, "socks5h://127.0.0.1:1083");
    assert.deepEqual(cursorAcpxCalls[1].args.slice(0, 6), ["--approve-all", "--model", "cursor-model", "cursor", "-s", "cursor-work"]);
    assert.equal(cursorAcpxCalls[1].allProxy, "socks5h://127.0.0.1:1083");

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
    assert.deepEqual(activeAfterClose.tasks.map((task) => task.conversation_id).sort(), [
      codex.conversation.conversation_id,
      cursor.conversation.conversation_id
    ].sort());

    const allAfterClose = runCli(["list", "--store-dir", storeDir, "--all"]);
    assert.equal(allAfterClose.tasks.length, 3);
    assert.equal(allAfterClose.tasks.some((task) => task.status === "closed"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("cancel requests cooperative ACPX cancellation for Codex, Claude, and Cursor sessions", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cancel-management-"));
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
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2),
  allProxy: process.env.ALL_PROXY
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const codex = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-cancellable",
      "--request",
      "Codex long task",
      "--store-dir",
      storeDir
    ]);
    const claude = runCli([
      "new",
      "--agent",
      "claude",
      "--session",
      "claude-cancellable",
      "--request",
      "Claude long task",
      "--store-dir",
      storeDir
    ]);
    const cursor = runCli([
      "new",
      "--agent",
      "cursor",
      "--session",
      "cursor-cancellable",
      "--request",
      "Cursor long task",
      "--store-dir",
      storeDir
    ]);

    const cancelledCodex = runCli([
      "cancel",
      "--conversation",
      codex.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--all-proxy",
      "socks5h://127.0.0.1:1082"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelledCodex.cancel_requested, true);
    assert.equal(cancelledCodex.conversation.status, "cancelling");
    assert.equal(cancelledCodex.executor.kind, "codex");

    const cancelledClaude = runCli([
      "cancel",
      "--conversation",
      claude.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelledClaude.cancel_requested, true);
    assert.equal(cancelledClaude.conversation.status, "cancelling");
    assert.equal(cancelledClaude.executor.kind, "claude");

    const cancelledCursor = runCli([
      "cancel",
      "--conversation",
      cursor.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(cancelledCursor.cancel_requested, true);
    assert.equal(cancelledCursor.conversation.status, "cancelling");
    assert.equal(cancelledCursor.executor.kind, "cursor");

    const acpxCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(acpxCalls.map((call) => call.args), [
      ["codex", "cancel", "-s", "codex-cancellable"],
      ["claude", "cancel", "-s", "claude-cancellable"],
      ["cursor", "cancel", "-s", "cursor-cancellable"]
    ]);
    assert.equal(acpxCalls[0].allProxy, "socks5h://127.0.0.1:1082");

    const codexStatus = runCli(["status", "--conversation", codex.conversation.conversation_id, "--store-dir", storeDir]);
    assert.equal(codexStatus.summary.status, "cancelling");
    assert.equal(codexStatus.recent_events.at(-1).event, "executor_cancel_requested");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("done conversations become idle, accept follow-up sends, and lazily time out", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-idle-management-"));
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
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify({
  args: process.argv.slice(2)
}) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-idle",
      "--request",
      "Initial task",
      "--store-dir",
      storeDir
    ]);

    const callback = runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "done",
        body: "Completed first round."
      })
    ]);
    assert.equal(callback.conversation.status, "idle");

    const listed = runCli(["list", "--store-dir", storeDir]);
    assert.deepEqual(listed.tasks.map((task) => [task.conversation_id, task.status]), [
      [created.conversation.conversation_id, "idle"]
    ]);

    const sent = runCli([
      "send",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Second task in same session."
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(sent.delivered, true);
    assert.equal(sent.conversation.status, "waiting_for_agent");

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    const stale = {
      ...state,
      status: "idle",
      idle_since: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    };
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify(stale, null, 2)}\n`, "utf8");

    const afterTimeout = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--idle-timeout-minutes",
      "1"
    ]);
    assert.equal(afterTimeout.cleanup.closed, 1);
    assert.deepEqual(afterTimeout.tasks, []);

    const closedState = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(closedState.status, "closed");
    assert.equal(closedState.close_reason, "idle timeout after 1 minutes");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit recovery policy asks for a recovery decision before replaying history", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-needs-recovery-"));
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
const args = process.argv.slice(2);
if (process.env.FAIL_ENSURE === "1" && args.includes("sessions") && args.includes("ensure")) {
  console.error("Cursor session unavailable");
  process.exit(9);
}
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify(args) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-recovery",
      "--request",
      "Initial recovery task",
      "--store-dir",
      storeDir
    ]);
    runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "done",
        body: "Initial work completed."
      })
    ]);

    const needsRecovery = runCli([
      "send",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Pending follow-up that cannot reach the old session.",
      "--recovery-policy",
      "explicit"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAIL_ENSURE: "1"
    });
    assert.equal(needsRecovery.delivered, false);
    assert.equal(needsRecovery.requires_recovery_decision, true);
    assert.equal(needsRecovery.conversation.status, "needs_recovery");
    assert.equal(needsRecovery.recovery.failed_stage, "session_ensure");
    assert.equal(needsRecovery.recovery.pending_message.body, "Pending follow-up that cannot reach the old session.");

    const blockedSend = runCliFailure([
      "send",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Do not send until the user chooses."
    ]);
    assert.match(blockedSend.stderr, /choose recover, restart, or close first/);

    const recovered = runCli([
      "recover",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.delivered, true);
    assert.equal(recovered.conversation.status, "waiting_for_agent");
    assert.match(recovered.executor.session, /^akk-codex-\d{14}-[0-9a-f]{8}$/);
    assert.equal(recovered.conversation.recovery.resolution, "recover");
    assert.equal(recovered.conversation.recovery.previous_session, "codex-recovery");

    const acpxCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(acpxCalls[0], ["codex", "sessions", "ensure", "--name", recovered.executor.session]);
    assert.deepEqual(acpxCalls[1].slice(0, 4), ["--approve-all", "codex", "-s", recovered.executor.session]);
    assert.match(acpxCalls[1][4], /AKK replay recovery/);
    assert.match(acpxCalls[1][4], /Initial work completed/);
    assert.match(acpxCalls[1][4], /Pending follow-up that cannot reach the old session/);

    fs.writeFileSync(acpxCallsPath, "", "utf8");
    const restartCreated = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-restart",
      "--request",
      "Initial restart task",
      "--store-dir",
      storeDir
    ]);
    runCli([
      "callback",
      "--state",
      restartCreated.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "codex",
        to: "openclaw",
        type: "done",
        body: "History that restart should not replay."
      })
    ]);
    runCli([
      "send",
      "--conversation",
      restartCreated.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Restart-only pending instruction.",
      "--recovery-policy",
      "explicit"
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      FAIL_ENSURE: "1"
    });
    const restarted = runCli([
      "restart",
      "--conversation",
      restartCreated.conversation.conversation_id,
      "--store-dir",
      storeDir
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });
    assert.equal(restarted.restarted, true);
    assert.equal(restarted.conversation.recovery.resolution, "restart");
    const restartCalls = fs.readFileSync(acpxCallsPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.match(restartCalls[1][4], /Restart this Agent Knock Knock task/);
    assert.match(restartCalls[1][4], /Restart-only pending instruction/);
    assert.doesNotMatch(restartCalls[1][4], /History that restart should not replay/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Cursor send requires recovery decision when its ACPX session is unavailable", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cursor-recovery-"));
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
const args = process.argv.slice(2);
if (args[0] === "cursor" && args.includes("sessions") && args.includes("ensure")) {
  console.error("Cursor session unavailable");
  process.exit(9);
}
fs.appendFileSync(${JSON.stringify(acpxCallsPath)}, JSON.stringify(args) + "\\n", "utf8");
`,
      "utf8"
    );
    fs.chmodSync(fakeAcpx, 0o755);

    const created = runCli([
      "new",
      "--agent",
      "cursor",
      "--session",
      "cursor-recovery",
      "--request",
      "Cursor recovery task",
      "--store-dir",
      storeDir
    ]);
    runCli([
      "callback",
      "--state",
      created.paths.statePath,
      "--record-only",
      "--message-json",
      JSON.stringify({
        from: "cursor",
        to: "openclaw",
        type: "done",
        body: "Cursor first round completed."
      })
    ]);

    const result = runCli([
      "send",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--message",
      "Follow up after Cursor session disappeared."
    ], {
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
    });

    assert.equal(result.delivered, false);
    assert.equal(result.requires_recovery_decision, true);
    assert.equal(result.executor.kind, "cursor");
    assert.equal(result.conversation.status, "needs_recovery");
    assert.equal(result.recovery.previous_executor.kind, "cursor");
    assert.equal(result.recovery.pending_message.to, "cursor");

    const status = runCli([
      "status",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir
    ]);
    assert.equal(status.summary.status, "needs_recovery");
    assert.deepEqual(status.summary.recovery.options, ["recover", "restart", "close"]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor marks waiting conversations stalled when the executor process is gone", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-exit-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-stalled",
      "--request",
      "Long task",
      "--store-dir",
      storeDir
    ]);

    runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--pid",
      "999999",
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60"
    ]);

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(state.status, "stalled");
    assert.match(state.stalled_reason, /executor process 999999 exited before callback/);

    const events = fs.readFileSync(created.paths.logPath, "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "executor_monitor_started"), true);
    assert.equal(events.some((event) => event.event === "conversation_stalled"), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor stalled notification uses default gateway credentials when no token is stored", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-notify-"));
  const storeDir = path.join(tempDir, "conversations");
  const fakeBinDir = path.join(tempDir, "bin");
  const gatewayCallPath = path.join(tempDir, "gateway-call.json");

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
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
      "codex-stalled-notify",
      "--request",
      "Long task",
      "--store-dir",
      storeDir,
      "--openclaw-session",
      "agent:main:main"
    ]);
    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify({
      ...state,
      gateway_url: "ws://127.0.0.1:18789",
      gateway_method: "agent-knock-knock.callback",
      gateway_session: "agent:main:main",
      openclaw_bin: fakeOpenClaw
    }, null, 2)}\n`, "utf8");
    fs.writeFileSync(
      path.join(path.dirname(created.paths.logPath), "codex-output.log"),
      [
        "[client] session/request_permission (running)",
        "Reconnecting... 5/5",
        "stream disconnected before completion: Transport error: network error"
      ].join("\n"),
      "utf8"
    );

    runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--pid",
      "999999",
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "60"
    ]);

    const gatewayArgs = JSON.parse(fs.readFileSync(gatewayCallPath, "utf8"));
    assert.deepEqual(gatewayArgs.slice(0, 3), ["gateway", "call", "agent-knock-knock.callback"]);
    assert.equal(gatewayArgs.includes("--url"), false);
    assert.equal(gatewayArgs.includes("--token"), false);
    const params = JSON.parse(gatewayArgs[gatewayArgs.indexOf("--params") + 1]);
    assert.equal(params.sessionKey, "agent:main:main");
    assert.equal(params.message.type, "error");
    assert.match(params.message.body, /executor process 999999 exited before callback/);
    assert.match(params.message.body, /stream disconnected before completion/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor marks waiting conversations stalled after callback timeout", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-timeout-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "claude",
      "--session",
      "claude-stalled",
      "--request",
      "Long task",
      "--store-dir",
      storeDir
    ]);

    const state = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    fs.writeFileSync(created.paths.statePath, `${JSON.stringify({
      ...state,
      updated_at: "2026-01-01T00:00:00.000Z"
    }, null, 2)}\n`, "utf8");

    runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--poll-interval-ms",
      "50",
      "--agent-timeout-minutes",
      "0.001"
    ]);

    const stalled = JSON.parse(fs.readFileSync(created.paths.statePath, "utf8"));
    assert.equal(stalled.status, "stalled");
    assert.match(stalled.stalled_reason, /no callback after 0.001 minutes/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("status trace summarizes executor output without exposing thinking text", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-status-trace-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-trace",
      "--request",
      "Trace task",
      "--store-dir",
      storeDir
    ]);
    const outputPath = path.join(path.dirname(created.paths.logPath), "codex-output.log");
    fs.writeFileSync(outputPath, [
      "[acpx] session codex-trace (abc) · /tmp/workspace · agent needs reconnect",
      "[client] initialize (running)",
      "[thinking] private chain of thought that must not be exposed",
      "[client] session/request_permission (running)",
      "[tool] pwd (running)",
      "  input: {\"command\":[\"pwd\"]}",
      "[tool] pwd (completed)",
      "  output:",
      "    /tmp/workspace",
      "[tool] /usr/local/bin/node callback --message-json '{\"body\":\"secret callback\"}' (completed)",
      "  output:",
      "    callback ok",
      "Agent visible progress message.",
      "[done] end_turn"
    ].join("\n"), "utf8");
    fs.appendFileSync(created.paths.logPath, `${JSON.stringify({
      ts: "2026-06-20T00:00:01.000Z",
      conversation_id: created.conversation.conversation_id,
      event: "executor_launch",
      output_path: outputPath
    })}\n`, "utf8");

    const status = runCli([
      "status",
      "--conversation",
      created.conversation.conversation_id,
      "--store-dir",
      storeDir,
      "--trace"
    ]);

    assert.equal(status.trace.source, "executor_output_log");
    assert.equal(status.trace.thinking_redacted_count, 1);
    assert.deepEqual(status.trace.agent_messages.some((message) => message.body.includes("private chain")), false);
    assert.equal(status.trace.permission_requests.length, 1);
    assert.equal(status.trace.tool_calls.some((tool) => tool.name === "pwd" && tool.status === "completed"), true);
    assert.equal(status.trace.tool_calls.some((tool) => String(tool.name).includes("secret callback")), false);
    assert.equal(status.trace.done_events.at(-1).status, "end_turn");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("monitor marks Codex model failures as needing model selection", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-model-selection-"));
  const storeDir = path.join(tempDir, "conversations");

  try {
    const created = runCli([
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-model-selection",
      "--request",
      "Codex task",
      "--store-dir",
      storeDir
    ]);
    const outputPath = path.join(path.dirname(created.paths.logPath), "codex-output.log");
    fs.writeFileSync(outputPath, [
      "[error] Cannot apply --model \"gpt-5\": the ACP agent did not advertise that model. Available models: gpt-5.5[low], gpt-5.5[medium], gpt-5.5[high]"
    ].join("\n"), "utf8");

    const monitored = runCli([
      "monitor",
      "--state",
      created.paths.statePath,
      "--log",
      created.paths.logPath,
      "--pid",
      "999999",
      "--output-path",
      outputPath,
      "--poll-interval-ms",
      "50"
    ]);

    assert.equal(monitored.needs_model_selection, true);
    assert.equal(monitored.stalled, false);
    assert.equal(monitored.conversation.status, "needs_model_selection");
    assert.equal(monitored.conversation.model_selection.attempted_model, "gpt-5");
    assert.deepEqual(monitored.conversation.model_selection.available_models, [
      "gpt-5.5[low]",
      "gpt-5.5[medium]",
      "gpt-5.5[high]"
    ]);
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

function runCliFailure(args, env = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env
    }
  });

  assert.notEqual(result.status, 0, result.stdout);
  return result;
}

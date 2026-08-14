import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Conversation } from "../src/protocol.js";
import * as launch from "../src/terminal-monitor-launch-plan.js";
import * as owner from "../src/terminal-monitor-ownership-policy.js";
function conversation(nativeSessionTakeover: Record<string, unknown>): Conversation {
  return {
    conversation_id: "turn-1",
    native_session_takeover: nativeSessionTakeover
  } as unknown as Conversation;
}

const environment = {
  PATH: "/bin",
  AKK_GATEWAY_TOKEN: "akk-secret",
  OPENCLAW_GATEWAY_TOKEN: "openclaw-secret"
};
test("normal monitor plan preserves exact argv, timeout precedence, and safe env", () => {
  const plan = launch.planLaunch({
    conversation: conversation({
      terminal_bridge: true,
      terminal_bridge_inactivity_timeout_minutes: 61,
      terminal_bridge_hard_timeout_minutes: 721,
      claude_home: "/stored-claude"
    }),
    statePath: "/store/state.json",
    logPath: "/store/events.ndjson",
    options: { monitorPollIntervalMs: 51, codexHome: "/codex" },
    entryPath: "/dist/cli.js",
    environment
  });

  assert.deepEqual(plan, {
    args: [
      "/dist/cli.js", "monitor", "--terminal-bridge",
      "--state", "/store/state.json", "--log", "/store/events.ndjson",
      "--agent-timeout-minutes", "61",
      "--agent-hard-timeout-minutes", "721",
      "--poll-interval-ms", "51",
      "--codex-home", "/codex", "--claude-home", "/stored-claude"
    ],
    environment: { PATH: "/bin" },
    agentTimeoutMinutes: 61,
    agentHardTimeoutMinutes: 721,
    pollIntervalMs: 51
  });
  assert.equal(environment.AKK_GATEWAY_TOKEN, "akk-secret");
});

test("handoff plan preserves optional argument order and active launch choice", () => {
  const input = {
    conversation: conversation({
      terminal_bridge: true,
      terminal_bridge_message_id: "message-1"
    }),
    statePath: "state",
    logPath: "log",
    options: {
      monitorPollIntervalMs: 20,
      monitorHandoffPollIntervalMs: 0,
      codexHome: "/codex",
      claudeHome: "/claude"
    },
    entryPath: "cli",
    environment
  };
  const plan = launch.planHandoffLaunch(input);
  assert.deepEqual(plan?.args, [
    "cli", "monitor", "--terminal-bridge-handoff",
    "--state", "state", "--log", "log",
    "--expected-terminal-message-id", "message-1",
    "--monitor-poll-interval-ms", "20",
    "--codex-home", "/codex", "--claude-home", "/claude"
  ]);
  const afterApproval = launch.planAfterApproval({
    ...input,
    activeMonitorPresent: true
  });
  assert.equal(afterApproval.monitor, undefined);
  assert.deepEqual(afterApproval.handoff, plan);
});

test("ownership policy preserves paths, newest event, and current-before-legacy precedence", () => {
  const key = createHash("sha256").update("message-1").digest("hex").slice(0, 20);
  assert.equal(owner.lockPath("state", "message-1"),
    `state.terminal-bridge-monitor-${key}.lock`);
  assert.equal(owner.handoffLockPath("state", "message-1"),
    `state.terminal-bridge-monitor-handoff-${key}.lock`);
  assert.equal(owner.latestLaunchPid([
    { event: "terminal_bridge_monitor_launch", pid: 41 },
    { event: "terminal_bridge_monitor_started", monitor_pid: 42 }
  ]), 42);
  assert.deepEqual(owner.decideCurrent({
    currentOwnerPresent: true,
    monitorLockVersion: 99
  }), {
    action: "stop",
    item: {
      status: "already_running",
      reason: "monitor_lock_owner_alive",
      monitor_owner_pid: null
    }
  });
  assert.deepEqual(owner.decideCurrent({
    currentOwnerPresent: false,
    monitorLockVersion: undefined
  }), { action: "inspect_legacy" });
  assert.deepEqual(owner.decideLegacy({
    latestLaunchPid: 42,
    launchProcessAlive: true
  }), {
    action: "stop",
    item: {
      status: "already_running",
      reason: "legacy_monitor_launch_pid_alive",
      monitor_owner_pid: 42
    }
  });
});

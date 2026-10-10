import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MONITOR_HARD_TIMEOUT_MINUTES, monitorMinutesToMs, resolveMonitorHardTimeoutMinutes,
  resolveMonitorHardTimeoutMs } from "../src/monitor-deadline-policy.js";
import { terminalMonitorTimeoutPlan } from "../src/terminal-monitor-launch-plan.js";
import type { Conversation } from "../src/protocol.js";

test("shared monitoring defaults preserve explicit and configured durations and unit boundaries", () => {
  assert.equal(DEFAULT_MONITOR_HARD_TIMEOUT_MINUTES, 720);
  assert.equal(resolveMonitorHardTimeoutMinutes(), 720);
  assert.equal(resolveMonitorHardTimeoutMinutes(undefined, 30), 30);
  assert.equal(resolveMonitorHardTimeoutMinutes(5, 30), 5);
  assert.equal(resolveMonitorHardTimeoutMinutes("2.5", 30), 2.5);
  assert.equal(resolveMonitorHardTimeoutMinutes(0, 30), 0, "invalid explicit values must reach caller validation, not silently default");
  assert.equal(monitorMinutesToMs(2.5), 150_000);
  assert.equal(resolveMonitorHardTimeoutMs(), 43_200_000);
  assert.equal(resolveMonitorHardTimeoutMs(1), 1);
  assert.equal(resolveMonitorHardTimeoutMs(0), 0);
});

test("terminal launch keeps its inactivity clock, poll interval and persisted hard duration independent", () => {
  const conversation = { native_session_takeover: {} } as unknown as Conversation;
  assert.deepEqual(terminalMonitorTimeoutPlan({ conversation, options: {} }), {
    agentTimeoutMinutes: 60, agentHardTimeoutMinutes: 720, pollIntervalMs: 5000
  });
  conversation.native_session_takeover = { terminal_bridge_inactivity_timeout_minutes: 17, terminal_bridge_hard_timeout_minutes: 45 };
  assert.deepEqual(terminalMonitorTimeoutPlan({ conversation, options: {}, defaultAgentHardTimeoutMinutes: 900 }), {
    agentTimeoutMinutes: 17, agentHardTimeoutMinutes: 45, pollIntervalMs: 5000
  });
  assert.deepEqual(terminalMonitorTimeoutPlan({ conversation, options: { agentHardTimeoutMinutes: 20 } }), {
    agentTimeoutMinutes: 17, agentHardTimeoutMinutes: 20, pollIntervalMs: 5000
  });
});

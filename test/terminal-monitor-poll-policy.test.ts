import test from "node:test";
import assert from "node:assert/strict";
import {
  decideTerminalMonitorTimeout,
  reduceTerminalMonitorActivityPoll,
  reduceTerminalMonitorCompletionPoll,
  type TerminalMonitorPollState
} from "../src/terminal-monitor-poll-policy.js";

const EMPTY_STATE: TerminalMonitorPollState = {
  previousScreenFingerprint: undefined
};

test("activity polling retains fingerprint memory and orders reasons", () => {
  const state: TerminalMonitorPollState = {
    previousScreenFingerprint: "screen-before",
    previousDurableFingerprint: "durable-before",
    previousCompletionFingerprint: "completion-before"
  };
  const decision = reduceTerminalMonitorActivityPoll({
    state,
    activityState: "working",
    activityReason: "agent is working",
    screenFingerprint: "screen-after",
    durableFingerprint: "durable-after"
  });

  assert.deepEqual(decision, {
    state: {
      previousScreenFingerprint: "screen-after",
      previousDurableFingerprint: "durable-after",
      previousCompletionFingerprint: "completion-before"
    },
    screenChanged: true,
    durableChanged: true,
    activityReasons: [
      "agent is working",
      "terminal screen changed",
      "durable completion evidence changed"
    ],
    activityReason:
      "agent is working; terminal screen changed; durable completion evidence changed"
  });
  assert.deepEqual(state, {
    previousScreenFingerprint: "screen-before",
    previousDurableFingerprint: "durable-before",
    previousCompletionFingerprint: "completion-before"
  });
});

test("screen and durable fingerprint transitions preserve their asymmetric activity rules", () => {
  const cases: Array<{
    name: string;
    state: TerminalMonitorPollState;
    screenFingerprint?: string;
    durableFingerprint?: string;
    screenChanged: boolean;
    durableChanged: boolean;
  }> = [
    {
      name: "first observations",
      state: EMPTY_STATE,
      screenFingerprint: "screen-1",
      durableFingerprint: "durable-1",
      screenChanged: false,
      durableChanged: true
    },
    {
      name: "unchanged observations",
      state: {
        previousScreenFingerprint: "screen-1",
        previousDurableFingerprint: "durable-1"
      },
      screenFingerprint: "screen-1",
      durableFingerprint: "durable-1",
      screenChanged: false,
      durableChanged: false
    },
    {
      name: "missing observations clear memory without activity",
      state: {
        previousScreenFingerprint: "screen-1",
        previousDurableFingerprint: "durable-1"
      },
      screenChanged: false,
      durableChanged: false
    },
    {
      name: "observations after missing memory",
      state: EMPTY_STATE,
      screenFingerprint: "screen-2",
      durableFingerprint: "durable-2",
      screenChanged: false,
      durableChanged: true
    }
  ];

  for (const expected of cases) {
    const decision = reduceTerminalMonitorActivityPoll({
      state: expected.state,
      screenFingerprint: expected.screenFingerprint,
      durableFingerprint: expected.durableFingerprint
    });
    assert.equal(decision.screenChanged, expected.screenChanged, expected.name);
    assert.equal(decision.durableChanged, expected.durableChanged, expected.name);
  }
});

test("activity polling omits empty working reasons and non-working status reasons", () => {
  for (const input of [
    { activityState: "working", activityReason: "" },
    { activityState: "idle", activityReason: "not activity" }
  ]) {
    assert.deepEqual(reduceTerminalMonitorActivityPoll({
      state: EMPTY_STATE,
      ...input
    }), {
      state: {
        previousScreenFingerprint: undefined,
        previousDurableFingerprint: undefined
      },
      screenChanged: false,
      durableChanged: false,
      activityReasons: []
    });
  }
});

test("completion polling requires two consecutive fingerprints and probes death only when absent", () => {
  let state: TerminalMonitorPollState = EMPTY_STATE;

  const first = reduceTerminalMonitorCompletionPoll({
    state,
    completionPresent: true,
    completionFingerprint: "completion-1"
  });
  assert.equal(first.completionStable, false);
  assert.equal(first.checkVerifiedDeadAgent, false);
  state = first.state;

  const stable = reduceTerminalMonitorCompletionPoll({
    state,
    completionPresent: true,
    completionFingerprint: "completion-1"
  });
  assert.equal(stable.completionStable, true);
  assert.equal(stable.checkVerifiedDeadAgent, false);

  const absent = reduceTerminalMonitorCompletionPoll({
    state: stable.state,
    completionPresent: false
  });
  assert.equal(absent.completionStable, false);
  assert.equal(absent.checkVerifiedDeadAgent, true);
  assert.equal(absent.state.previousCompletionFingerprint, undefined);

  const unidentifiable = reduceTerminalMonitorCompletionPoll({
    state: absent.state,
    completionPresent: true
  });
  assert.equal(unidentifiable.completionStable, false);
  assert.equal(unidentifiable.checkVerifiedDeadAgent, false);
});

test("timeout policy uses exact boundaries and hard timeout precedence", () => {
  const taskStartedAtMs = 1_000_000;
  const lastActivityAtMs = 2_000_000;
  assert.deepEqual(decideTerminalMonitorTimeout({
    nowMs: taskStartedAtMs + 10 * 60 * 1000,
    taskStartedAtMs,
    lastActivityAtMs: taskStartedAtMs,
    hardTimeoutMinutes: 10,
    inactivityTimeoutMinutes: 1
  }), {
    kind: "hard",
    deadlineAtMs: taskStartedAtMs + 10 * 60 * 1000
  });
  assert.deepEqual(decideTerminalMonitorTimeout({
    nowMs: lastActivityAtMs + 60 * 1000,
    taskStartedAtMs,
    lastActivityAtMs,
    hardTimeoutMinutes: 60,
    inactivityTimeoutMinutes: 1
  }), {
    kind: "inactivity",
    deadlineAtMs: lastActivityAtMs + 60 * 1000
  });
  assert.deepEqual(decideTerminalMonitorTimeout({
    nowMs: lastActivityAtMs + 60 * 1000 - 1,
    taskStartedAtMs,
    lastActivityAtMs,
    hardTimeoutMinutes: 60,
    inactivityTimeoutMinutes: 1
  }), { kind: "none" });
});

test("timeout policy disables non-finite and non-positive limits", () => {
  const disabledLimits = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1];
  for (const limit of disabledLimits) {
    assert.deepEqual(decideTerminalMonitorTimeout({
      nowMs: 9_000_000,
      taskStartedAtMs: 0,
      lastActivityAtMs: 0,
      hardTimeoutMinutes: limit,
      inactivityTimeoutMinutes: limit
    }), { kind: "none" }, String(limit));
  }
});

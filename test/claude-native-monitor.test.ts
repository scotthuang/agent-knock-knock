import test from "node:test";
import assert from "node:assert/strict";
import { pollClaudeNativeMonitor } from "../src/claude-native-monitor.js";

const ID = "claude-cli-watch:11111111-1111-4111-8111-111111111111";
test("Claude monitor continues after native completion until its persisted callback is accepted", async () => {
  let task = "working", callback = "not_enqueued", reconciliations = 0;
  const sleeps: number[] = [], ids: string[] = [];
  await pollClaudeNativeMonitor(ID, {
    shouldMonitor: id => { assert.equal(id, ID); return task === "working" || callback === "pending"; },
    reconcile: async id => {
      ids.push(id); reconciliations++;
      if (reconciliations === 1) { task = "completed"; callback = "pending"; }
      else callback = "accepted";
    }
  }, { sleep: async ms => { sleeps.push(ms); } });
  assert.deepEqual(ids, [ID, ID]); assert.deepEqual(sleeps, [2000]); assert.equal(callback, "accepted");
});
test("Claude monitor resumes a saved pending outbox and does not re-observe accepted completion", async () => {
  let pending = true, calls = 0;
  const tasks = { shouldMonitor: () => pending, reconcile: async () => { calls++; pending = false; } };
  const sleep = async () => { assert.fail("accepted callback must stop the monitor"); };
  await pollClaudeNativeMonitor(ID, tasks, { sleep }); await pollClaudeNativeMonitor(ID, tasks, { sleep });
  assert.equal(calls, 1);
});
test("Claude monitor retries read failures without creating a different target or resending input", async () => {
  let active = true, calls = 0, errors = 0;
  const sleeps: number[] = [];
  await pollClaudeNativeMonitor(ID, {
    shouldMonitor: () => active,
    reconcile: async id => { assert.equal(id, ID); if (++calls === 1) throw new Error("temporary read failure"); active = false; }
  }, { onError: () => { errors++; }, sleep: async ms => { sleeps.push(ms); } });
  assert.equal(calls, 2); assert.equal(errors, 1); assert.deepEqual(sleeps, [2000]);
});
test("unwatch/expiry during a failed read stops polling without renewing the durable record", async () => {
  let active = true, calls = 0;
  await pollClaudeNativeMonitor(ID, {
    shouldMonitor: () => active,
    reconcile: async () => { calls++; active = false; throw new Error("read failed as observation stopped"); }
  }, { sleep: async () => { assert.fail("stopped observation must not sleep or renew"); } });
  assert.equal(calls, 1);
});
test("Claude monitor rejects wrong Watch namespaces before touching persisted state", async () => {
  await assert.rejects(pollClaudeNativeMonitor("codex-cli-watch:11111111", {
    shouldMonitor: () => { assert.fail("wrong namespace must not reach task state"); },
    reconcile: async () => { assert.fail("wrong namespace must not reconcile"); }
  }), /Invalid Claude CLI Watch/u);
});

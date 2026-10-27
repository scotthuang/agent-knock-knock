import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createTerminalWatchCliAdapter } from "../../src/terminal-watch-cli-adapter.js";
import { createTerminalWatchOpenClawCallbackRoute } from "../../src/callback-transport.js";
import { loadTerminalWatch } from "../../src/terminal-watch-store.js";
import { terminalMatchesUserExplicitFallbackWatch } from "../../src/terminal-watch-terminal-identity.js";
import type { TerminalWatchCallbackInput } from "../../src/terminal-watch-callback-cli-adapter.js";
import { createFixture, exactTerminalObservation, fallbackAcceptedTurnRecords } from "./fixtures.js";

function harness(t: test.TestContext) {
  const fixture = createFixture(t);
  let terminal: Record<string, any> = { ...fixture.terminal };
  const callbacks: TerminalWatchCallbackInput[] = [];
  const options = { storeDir: fixture.storeDir,
    callbackRoute: createTerminalWatchOpenClawCallbackRoute({
      controllerSessionId: "agent:main:degraded-identity", respond: true
    }) };
  const request = "Observe this request across temporary discovery gaps";
  const facade = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => {}, acquireTerminalLock: () => () => {},
    observeExactTerminal: async ({ terminalId }) => exactTerminalObservation([terminal], terminalId),
    loadClaudeAgentRows: () => [], now: fixture.now,
    randomUUID: () => "00000000-0000-4000-8000-000000000430",
    storeDirFromOptions: () => fixture.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () => [], printJson: () => {},
    callback: { deliver(input) {
      callbacks.push(input); return { runId: input.idempotencyKey, status: "started" };
    } }
  });
  return { fixture, facade, callbacks, options, request,
    terminal: () => terminal,
    observe: (row: Record<string, any>) => { terminal = row; },
    prepare: () => facade.prepareUserExplicitFallbackWatch({ options,
      terminal: { conversationId: fixture.terminal.id, agent: "codex",
        pid: fixture.terminal.pid, terminalControl: fixture.terminal.terminal_control as never },
      requestHash: createHash("sha256").update(request).digest("hex"),
      messageId: "message-degraded-identity", physicalToken: "c".repeat(64)
    })
  };
}

test("activity Watches reuse verified pane paths and retry temporarily missing identity or workspace", async (t) => {
  for (const [entry, missing] of [
    ["automatic", "native-process"], ["automatic", "cwd-with-pane-path"],
    ["manual", "cwd-with-pane-path"]
  ] as const) {
    await t.test(`${entry}/${missing}`, async (nested) => {
      const h = harness(nested);
      const initial: Record<string, any> = { ...h.terminal(), agent_version: undefined,
        native_agent_session_id: undefined, native_agent_rollout: undefined,
        activity_state: "idle" };
      if (missing === "native-process") {
        delete initial.native_agent_process_uuid;
        delete initial.native_agent_process_birth;
      } else {
        delete initial.workspace;
        delete initial.cwd;
      }
      h.observe(initial);
      let watchId: string;
      if (entry === "manual") {
        await h.facade.runWatch({ ...h.options, terminal: h.fixture.terminal.id });
        watchId = String(h.facade.listPublicWatches(h.fixture.storeDir)[0].watch_id);
      } else {
        const prepared = await h.prepare();
        assert.ok(prepared);
        assert.equal(prepared.anchor.schema, "agent-knock-knock/terminal-activity-watch-anchor");
        const receipt = await h.facade.attachUserExplicitFallbackWatch({ options: h.options, prepared });
        assert.equal(receipt.callback_expected, true);
        assert.equal(receipt.confidence, "best_effort");
        watchId = prepared.watchId;
      }
      const saved = loadTerminalWatch(h.fixture.storeDir, watchId);
      assert.equal(saved.status, "active", "missing metadata must survive persistence and reload");
      assert.equal(saved.terminal.workspace, h.fixture.terminal.workspace,
        "persistence retains the verified target path, never the controller's cwd");
      await h.facade.runReconcileWatches(h.options);
      assert.equal(loadTerminalWatch(h.fixture.storeDir, watchId).status, "active");
      assert.equal(h.callbacks.length, 0, "initial idle cannot prove post-Send work");
      h.observe({ ...initial, cwd: undefined, workspace: undefined,
        terminal_control: { ...initial.terminal_control, currentPath: undefined } });
      await h.facade.runReconcileWatches(h.options);
      const temporarilyUnknown = loadTerminalWatch(h.fixture.storeDir, watchId);
      assert.equal(temporarilyUnknown.status, "active", "missing live workspace is not an identity change");
      assert.equal(temporarilyUnknown.settlement, undefined);
      assert.equal(h.callbacks.length, 0);
      h.observe({ ...h.fixture.terminal, activity_state: "working" });
      await h.facade.runReconcileWatches(h.options);
      h.observe({ ...h.fixture.terminal, activity_state: "idle" });
      for (let count = 0; count < 3; count += 1) await h.facade.runReconcileWatches(h.options);
      assert.equal(loadTerminalWatch(h.fixture.storeDir, watchId).status, "completed");
      assert.equal(h.callbacks.length, 1);
      assert.equal(h.callbacks[0].origin, "terminal_activity_fallback");
      assert.equal(h.callbacks[0].completionText, undefined, "activity is not exact completion proof");
    });
  }
});

test("creating an activity Watch without any verified workspace refuses actionably and can retry", async (t) => {
  for (const entry of ["automatic", "manual"] as const) {
    await t.test(entry, async (nested) => {
      const h = harness(nested);
      const initial = { ...h.terminal(), agent_version: undefined,
        native_agent_session_id: undefined, native_agent_rollout: undefined,
        workspace: undefined, cwd: undefined,
        terminal_control: { ...h.terminal().terminal_control, currentPath: undefined } };
      h.observe(initial);
      const create = () => entry === "manual"
        ? h.facade.runWatch({ ...h.options, terminal: h.fixture.terminal.id })
        : h.prepare();
      await assert.rejects(create, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /workspace.*unavailable/iu);
        assert.match(error.message, /refresh|retry/iu, "the error must explain how to retry");
        return true;
      });
      assert.deepEqual(h.facade.listPublicWatches(h.fixture.storeDir), []);
      h.observe({ ...initial,
        terminal_control: { ...initial.terminal_control, currentPath: h.fixture.terminal.workspace } });
      if (entry === "manual") {
        await h.facade.runWatch({ ...h.options, terminal: h.fixture.terminal.id });
      } else {
        const prepared = await h.prepare();
        assert.ok(prepared);
        await h.facade.attachUserExplicitFallbackWatch({ options: h.options, prepared });
      }
      const row = h.facade.listPublicWatches(h.fixture.storeDir)[0];
      const saved = loadTerminalWatch(h.fixture.storeDir, String(row.watch_id));
      assert.equal(saved.status, "active");
      assert.equal(saved.terminal.workspace, h.fixture.terminal.workspace);
    });
  }
});

test("activity fallback still rejects a supplied relative workspace", async (t) => {
  const h = harness(t);
  h.observe({ ...h.terminal(), agent_version: undefined, workspace: "relative/workspace" });
  await assert.rejects(h.prepare, /workspace must be absolute/u);
  assert.deepEqual(h.facade.listPublicWatches(h.fixture.storeDir), []);
});

test("exact fallback identity distinguishes missing or throwing observations from proven changes", async (t) => {
  const h = harness(t);
  const prepared = await h.prepare();
  assert.ok(prepared);
  assert.equal(prepared.anchor.schema, "agent-knock-knock/codex-user-explicit-fallback-watch-anchor");
  await h.facade.attachUserExplicitFallbackWatch({ options: h.options, prepared });
  const watch = loadTerminalWatch(h.fixture.storeDir, prepared.watchId);
  const original = h.terminal();
  const throwing = { ...original };
  Object.defineProperty(throwing, "native_agent_process_uuid", {
    get() { throw new Error("temporary process observation failure"); }
  });
  const missingWorkspace = { ...original, cwd: undefined, workspace: undefined,
    terminal_control: { ...original.terminal_control, currentPath: undefined } };
  const changedBirthThrowingUuid = { ...original, native_agent_process_birth: "another-birth" };
  Object.defineProperty(changedBirthThrowingUuid, "native_agent_process_uuid", {
    get() { throw new Error("temporary UUID observation failure"); }
  });
  const changedBirthUnreadableControl = { ...original, native_agent_process_birth: "another-birth" };
  Object.defineProperty(changedBirthUnreadableControl, "terminal_control", {
    get() { throw new Error("temporary endpoint observation failure"); }
  });
  const cases = [
    ["complete", original, "match"],
    ["missing UUID", { ...original, native_agent_process_uuid: undefined }, "unavailable"],
    ["missing birth", { ...original, native_agent_process_birth: undefined }, "unavailable"],
    ["missing workspace", missingWorkspace, "unavailable"],
    ["throwing read", throwing, "unavailable"],
    ["changed PID", { ...original, pid: original.pid + 1 }, "mismatch"],
    ["changed PID with missing native fields", { ...original, pid: original.pid + 1,
      native_agent_process_uuid: undefined, native_agent_process_birth: undefined }, "mismatch"],
    ["changed UUID", { ...original, native_agent_process_uuid: "another-process" }, "mismatch"],
    ["changed birth", { ...original, native_agent_process_birth: "another-birth" }, "mismatch"],
    ["changed birth with throwing UUID", changedBirthThrowingUuid, "mismatch"],
    ["changed birth with unreadable control", changedBirthUnreadableControl, "mismatch"],
    ["changed endpoint", { ...original, terminal_control: { ...original.terminal_control, panePid: 9999 } }, "mismatch"],
    ["changed workspace", { ...original, workspace: "/another-workspace" }, "mismatch"]
  ] as const;
  for (const [label, terminal, expected] of cases) {
    assert.equal(terminalMatchesUserExplicitFallbackWatch(terminal, watch), expected, label);
  }

  for (const terminal of [
    { ...original, native_agent_process_uuid: undefined, native_agent_process_birth: undefined },
    throwing, missingWorkspace
  ]) {
    h.observe(terminal);
    await h.facade.runReconcileWatches(h.options);
    const waiting = loadTerminalWatch(h.fixture.storeDir, prepared.watchId);
    assert.equal(waiting.status, "active", "unavailable must remain retryable");
    assert.equal(waiting.settlement, undefined);
    assert.equal(h.callbacks.length, 0, "unknown must not emit an identity-changed notification");
  }
  h.observe(original);
  await h.facade.runReconcileWatches(h.options);
  assert.equal(loadTerminalWatch(h.fixture.storeDir, prepared.watchId).status, "active");
  const turnId = "019f0000-0000-7000-8000-000000000430";
  fs.appendFileSync(h.fixture.rolloutPath, [
    ...fallbackAcceptedTurnRecords(h.request, turnId),
    { timestamp: "2026-08-21T01:00:01.100Z", type: "event_msg", payload: {
      type: "task_complete", turn_id: turnId, last_agent_message: "Observed after identity recovered"
    } }
  ].map(record => JSON.stringify(record)).join("\n") + "\n");
  h.fixture.advance();
  await h.facade.runReconcileWatches(h.options);
  const completed = loadTerminalWatch(h.fixture.storeDir, prepared.watchId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.settlement?.completion_id, turnId);
  assert.equal(h.callbacks.length, 1);
  assert.equal(h.callbacks[0].completionText, "Observed after identity recovered");
});

test("exact fallback Watch still terminates for proven PID, birth, or endpoint changes", async (t) => {
  for (const changed of ["pid", "pid-with-missing-native", "birth", "endpoint",
    "birth-with-unavailable-rollout", "birth-with-throwing-uuid", "birth-with-unreadable-control"] as const) {
    await t.test(changed, async (nested) => {
      const h = harness(nested);
      const prepared = await h.prepare();
      assert.ok(prepared);
      await h.facade.attachUserExplicitFallbackWatch({ options: h.options, prepared });
      const original = h.terminal();
      const observed = changed.startsWith("pid") ? { ...original, pid: original.pid + 1,
        ...(changed === "pid-with-missing-native"
          ? { native_agent_process_uuid: undefined, native_agent_process_birth: undefined } : {}) }
        : changed.startsWith("birth") ? { ...original, native_agent_process_birth: "another-birth" }
          : { ...original, terminal_control: { ...original.terminal_control, panePid: 9999 } };
      if (changed === "birth-with-throwing-uuid" || changed === "birth-with-unreadable-control") {
        Object.defineProperty(observed,
          changed === "birth-with-throwing-uuid" ? "native_agent_process_uuid" : "terminal_control", {
            get() { throw new Error("temporary independent observation failure"); }
          });
      }
      h.observe(observed);
      if (changed === "birth-with-unavailable-rollout") {
        fs.renameSync(h.fixture.rolloutPath, `${h.fixture.rolloutPath}.temporarily-unavailable`);
      }
      await h.facade.runReconcileWatches(h.options);
      const invalidated = loadTerminalWatch(h.fixture.storeDir, prepared.watchId);
      assert.equal(invalidated.status, "invalidated");
      assert.equal(invalidated.settlement?.reason_code, "terminal_identity_changed");
      assert.equal(h.callbacks.length, 1);
    });
  }
});

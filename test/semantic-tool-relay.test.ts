import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

import {
  bindSemanticToolAsyncRelay,
  bindSemanticToolRelayEnvironment,
  bindSemanticToolRelayPath,
  runCli,
  runHostAwareCli,
  withHostBridgeInvocationSignal
} from "../src/semantic-tool-relay.js";

test("semantic relay keeps executable and environment authority owner-local", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-semantic-relay-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const firstCli = path.join(tempDir, "first.cjs");
  const secondCli = path.join(tempDir, "second.cjs");
  writeFixtureCli(firstCli, "first");
  writeFixtureCli(secondCli, "second");

  const firstOwner = {};
  const secondOwner = {};
  bindSemanticToolRelayPath(firstOwner, firstCli);
  bindSemanticToolRelayEnvironment(firstOwner, relayEnvironment("alpha"));
  bindSemanticToolRelayPath(secondOwner, secondCli);
  bindSemanticToolRelayEnvironment(secondOwner, relayEnvironment("beta"));
  bindSemanticToolAsyncRelay(secondOwner);

  assert.deepEqual(runCli(firstOwner, ["probe"]), {
    script: "first",
    marker: "alpha",
    args: ["probe"]
  });
  assert.deepEqual(await runHostAwareCli(secondOwner, ["probe"]), {
    script: "second",
    marker: "beta",
    args: ["probe"]
  });
});

test("semantic relay preserves invocation-scoped AbortSignal semantics", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-semantic-abort-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const slowCli = path.join(tempDir, "slow.cjs");
  fs.writeFileSync(
    slowCli,
    'setTimeout(() => process.stdout.write("{}"), 10_000);\n',
    "utf8"
  );
  const owner = {};
  bindSemanticToolRelayPath(owner, slowCli);
  bindSemanticToolRelayEnvironment(owner, relayEnvironment("abort"));
  bindSemanticToolAsyncRelay(owner);
  const controller = new AbortController();

  const pending = withHostBridgeInvocationSignal(controller.signal, () =>
    runHostAwareCli(owner, ["probe"])
  );
  controller.abort();
  await assert.rejects(pending, (error: unknown) =>
    error instanceof Error && error.name === "AbortError" &&
      error.message === "agent-knock-knock Host invocation was aborted"
  );
});

test("semantic text submission relay preserves a slow dispatcher until its receipt or Host cancellation", async (t) => {
  const scenarios = ["send", "delegate", "respond"].flatMap(command =>
    (["receipt", "abort"] as const).map(completion => ({ command, completion }))
  );
  for (const { command, completion } of scenarios) {
    await t.test(`${command}: ${completion}`, async (t) => {
      const { owner, child } = mockedAsyncRelay(t);
      const controller = new AbortController();
      const pending = withHostBridgeInvocationSignal(controller.signal, () =>
        runHostAwareCli(owner, [command, "--conversation-id", "claude-fixture"])
      );
      // Capture rejection immediately so the pre-fix timeout is a clean
      // assertion failure rather than an unhandled rejection after teardown.
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      t.mock.timers.tick(90_001);
      assert.deepEqual(child.signals, [],
        "the generic read-command deadline must not kill an in-progress send");
      if (completion === "receipt") {
        const receipt = {
          delivered: true,
          terminal_input_dispatched: true,
          agent_acceptance: "proven"
        };
        child.complete(receipt);
        assert.deepEqual(await outcome, { value: receipt });
      } else {
        controller.abort();
        const result = await outcome;
        assert.deepEqual(child.signals, ["SIGKILL"]);
        assert.ok("error" in result && result.error instanceof Error);
        assert.equal(result.error.name, "AbortError");
      }
      t.mock.timers.tick(90_000);
      assert.deepEqual(child.signals, completion === "receipt" ? [] : ["SIGKILL"]);
    });
  }
});

test("semantic relay retains read-command deadlines and explicit submission timeout overrides", async (t) => {
  for (const scenario of [
    { command: "list", deadline: 90_000, options: {} },
    { command: "status", deadline: 90_000, options: {} },
    { command: "send", deadline: 250, options: { timeoutMs: 250 } },
    { command: "delegate", deadline: 250, options: { timeoutMs: 250 } },
    { command: "respond", deadline: 250, options: { timeoutMs: 250 } }
  ]) {
    await t.test(scenario.command, async (t) => {
      const { owner, child } = mockedAsyncRelay(t);
      const pending = runHostAwareCli(owner, [scenario.command], scenario.options);
      const rejected = assert.rejects(pending,
        new RegExp(`agent-knock-knock ${scenario.command} timed out`, "u"));
      t.mock.timers.tick(scenario.deadline - 1);
      assert.deepEqual(child.signals, []);
      t.mock.timers.tick(1);
      await rejected;
      assert.deepEqual(child.signals, ["SIGKILL"]);
    });
  }
});

class MockRelayChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly signals: string[] = [];

  kill(signal: string): boolean {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }

  complete(receipt: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify(receipt));
    this.emit("close", 0);
  }
}

function mockedAsyncRelay(t: TestContext): {
  owner: object;
  child: MockRelayChild;
} {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const child = new MockRelayChild();
  const spawn = t.mock.method(childProcess, "spawn", () =>
    child as unknown as ReturnType<typeof childProcess.spawn>
  );
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
    child.stdout.destroy();
    child.stderr.destroy();
  });
  const owner = {};
  bindSemanticToolAsyncRelay(owner);
  return { owner, child };
}

function writeFixtureCli(filePath: string, script: string): void {
  fs.writeFileSync(
    filePath,
    `process.stdout.write(JSON.stringify({script:${JSON.stringify(script)},marker:process.env.AKK_RELAY_TEST_MARKER,args:process.argv.slice(2)}));\n`,
    "utf8"
  );
}

function relayEnvironment(marker: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AKK_RELAY_TEST_MARKER: marker
  };
}

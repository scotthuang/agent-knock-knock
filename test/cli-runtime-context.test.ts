import test from "node:test";
import assert from "node:assert/strict";
import {
  cliCwd,
  cliEnv,
  cliExit,
  cliNow,
  cliPid,
  cliRuntimeLog,
  cliSleep,
  cliSleepSync,
  runCliCommandExecution,
  setCliExitCode,
  writeCliStdout
} from "../src/cli-runtime-context.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

test("CLI runtime contexts isolate interleaved command dependencies and output", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const firstForwarded: string[] = [];
  const secondForwarded: string[] = [];
  const firstLogs: string[] = [];
  const secondLogs: string[] = [];

  const first = runCliCommandExecution(
    "first",
    { marker: "first" },
    {
      cwd: "/virtual/first",
      env: { AKK_CONTEXT: "first" },
      pid: 101,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      stdout: (text) => firstForwarded.push(text),
      runtimeLog: (_level, event) => firstLogs.push(event)
    },
    async () => {
      writeCliStdout("first-before\n");
      firstStarted.resolve();
      await releaseFirst.promise;
      assert.equal(cliCwd(), "/virtual/first");
      assert.equal(cliEnv().AKK_CONTEXT, "first");
      assert.equal(cliPid(), 101);
      assert.equal(cliNow().toISOString(), "2026-01-01T00:00:00.000Z");
      writeCliStdout("first-after\n");
      setCliExitCode(7);
    }
  );

  await firstStarted.promise;
  const second = await runCliCommandExecution(
    "second",
    { marker: "second" },
    {
      cwd: "/virtual/second",
      env: { AKK_CONTEXT: "second" },
      pid: 202,
      stdout: (text) => secondForwarded.push(text),
      runtimeLog: (_level, event) => secondLogs.push(event)
    },
    async () => {
      assert.equal(cliCwd(), "/virtual/second");
      assert.equal(cliEnv().AKK_CONTEXT, "second");
      assert.equal(cliPid(), 202);
      writeCliStdout("second\n");
      setCliExitCode(2);
    }
  );
  releaseFirst.resolve();

  assert.deepEqual(await first, {
    exitCode: 7,
    stdout: "first-before\nfirst-after\n"
  });
  assert.deepEqual(second, { exitCode: 2, stdout: "second\n" });
  assert.deepEqual(firstForwarded, ["first-before\n", "first-after\n"]);
  assert.deepEqual(secondForwarded, ["second\n"]);
  assert.deepEqual(firstLogs, ["cli_start", "cli_finish"]);
  assert.deepEqual(secondLogs, ["cli_start", "cli_finish"]);
});

test("a nested CLI runtime restores its outer context", async () => {
  const outer = await runCliCommandExecution(
    "outer",
    {},
    { cwd: "/virtual/outer", runtimeLog: () => undefined },
    async () => {
      writeCliStdout("outer-before\n");
      const inner = await runCliCommandExecution(
        "inner",
        {},
        { cwd: "/virtual/inner", runtimeLog: () => undefined },
        async () => {
          assert.equal(cliCwd(), "/virtual/inner");
          writeCliStdout("inner\n");
          setCliExitCode(3);
        }
      );
      assert.deepEqual(inner, { exitCode: 3, stdout: "inner\n" });
      assert.equal(cliCwd(), "/virtual/outer");
      writeCliStdout("outer-after\n");
    }
  );

  assert.deepEqual(outer, {
    exitCode: 0,
    stdout: "outer-before\nouter-after\n"
  });
});

test("CLI sleep and exit seams remain scoped to the active execution", async () => {
  const sleeps: number[] = [];
  const exitError = new Error("expected injected exit");

  await assert.rejects(
    runCliCommandExecution(
      "exit",
      {},
      {
        runtimeLog: () => undefined,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
        sleepSync: (milliseconds) => sleeps.push(milliseconds),
        exit: () => {
          throw exitError;
        }
      },
      async () => {
        await cliSleep(4);
        cliSleepSync(5);
        cliExit(23);
      }
    ),
    (error) => error === exitError
  );
  assert.deepEqual(sleeps, [4, 5]);
});

test("CLI runtime log falls back safely when no logger is injected", async () => {
  await assert.doesNotReject(runCliCommandExecution(
    "fallback-log",
    {},
    {},
    async () => {
      cliRuntimeLog("info", "cli_runtime_context_fallback_test");
    }
  ));
});

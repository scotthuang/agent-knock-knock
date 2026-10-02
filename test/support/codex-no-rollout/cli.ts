import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  spawn,
  spawnSync
} from "node:child_process";
import {
  executeCliCommand,
  parseCliCommand,
  type CliCommandDependencies
} from "../../../src/cli-core.js";
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider
} from "../../../src/terminal-control-provider.js";
import {
  StaticTerminalProcessSource
} from "../../../src/terminal-process-source.js";
import {
  codexNoRolloutManagedStateMachineArgs
} from "../codex-no-rollout-cli-harness.js";
import {
  binPath,
  SIMULATED_DEAD_CLI_PID,
  type NoRolloutFixture,
  type CliTestResult,
  InProcessCliExit,
  type CapturedInProcessExit,
  inProcessFixtures,
  errorMessage
} from "./model.js";
import {
  rewriteSnapshotLockOwners,
  restoreDirectorySnapshot,
  fixtureMutableCheckpoint,
  restoreFixtureMutableCheckpoint
} from "./checkpoint.js";
import {
  createFixtureHerdrProvider
} from "./herdr.js";
import {
  fixtureProcessSnapshots,
  createFixtureCodexAdapter,
  createFixtureLifecycleProvider
} from "./codex.js";
import {
  runInProcessTmux
} from "./tmux.js";

export async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): Promise<CliTestResult> {
  args = codexNoRolloutManagedStateMachineArgs(args);
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  try {
    const result = await executeCliCommand(
      parsed.command,
      parsed.options,
      inProcessDependencies(fixture, env, onExit)
    );
    return {
      status: result.exitCode,
      stdout: result.stdout,
      stderr: ""
    };
  } catch (error) {
    return {
      status: error instanceof InProcessCliExit ? error.status : 1,
      stdout: "",
      stderr: error instanceof InProcessCliExit ? "" : errorMessage(error)
    };
  }
}

/**
 * Execute through the imported command and virtual clock, but freeze the exact
 * durable checkpoint observed by cliExit before ordinary exception unwinding
 * can compensate it. Restoring that snapshot after the command unwinds models
 * the state a hard process exit leaves for the next recovery invocation.
 */
export async function runCliCrashCheckpoint(
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<CliTestResult> {
  const parsed = parseCliCommand(args);
  const storeDir = String(parsed.options.storeDir ?? "");
  const fixture = inProcessFixtures.get(storeDir);
  assert.ok(fixture, `missing in-process fixture for ${storeDir}`);
  const mutableCheckpoint = fixtureMutableCheckpoint(fixture);
  const previousCliPid = fixture.cliPid;
  fixture.cliPid = SIMULATED_DEAD_CLI_PID;
  let captured: CapturedInProcessExit | undefined;
  try {
    const result = await runCli(args, env, (status) => {
      if (!captured) {
        const snapshotRoot = fs.mkdtempSync(
          path.join(os.tmpdir(), "akk-in-process-cli-exit-")
        );
        const snapshotPath = path.join(snapshotRoot, "fixture");
        try {
          fs.cpSync(fixture.tempDir, snapshotPath, {
            recursive: true,
            preserveTimestamps: true
          });
          rewriteSnapshotLockOwners(snapshotPath, SIMULATED_DEAD_CLI_PID);
          captured = { status, snapshotRoot, snapshotPath };
        } catch (error) {
          fs.rmSync(snapshotRoot, { recursive: true, force: true });
          throw error;
        }
      }
      throw new InProcessCliExit(status);
    });
    if (!captured) {
      return result;
    }
    restoreDirectorySnapshot(captured.snapshotPath, fixture.tempDir);
    restoreFixtureMutableCheckpoint(fixture, mutableCheckpoint);
    return { status: captured.status, stdout: "", stderr: "" };
  } finally {
    if (captured) {
      fs.rmSync(captured.snapshotRoot, { recursive: true, force: true });
    }
    if (previousCliPid === undefined) {
      delete fixture.cliPid;
    } else {
      fixture.cliPid = previousCliPid;
    }
  }
}

/** Deliberate crash/exit and detached child-lifecycle process goldens. */
export function runCliSubprocess(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [
    binPath,
    ...codexNoRolloutManagedStateMachineArgs(args)
  ], {
    encoding: "utf8",
    env,
    timeout: 60_000
  });
}

export function spawnFixtureNodeEval(source: string) {
  return spawn(process.execPath, ["-e", source], { stdio: "ignore" });
}

export function inProcessDependencies(
  fixture: NoRolloutFixture,
  env: NodeJS.ProcessEnv,
  onExit?: (status: number) => never
): CliCommandDependencies {
  // A fixture can invoke the CLI multiple times to simulate a restart. Keep its
  // virtual clock monotonic across those invocations: sleep advances virtual
  // time without blocking, so resetting to a faster wall clock can otherwise
  // make a later acceptance appear to precede the persisted Enter dispatch.
  let nowMs = Math.max(Date.now(), fixture.clockMs);
  fixture.clockMs = nowMs;
  const provider = fixture.terminalKind === "herdr"
    ? createFixtureHerdrProvider(fixture, env, () => nowMs)
    : new TmuxTerminalControlProvider({
        commands: ["tmux"],
        socketPaths: [],
        runCommand: (_command, args) =>
          runInProcessTmux(fixture, env, args, nowMs)
      });
  return {
    terminalControlProviderRegistry:
      createTerminalControlProviderRegistry([provider]),
    terminalProcessSource: new StaticTerminalProcessSource(
      fixtureProcessSnapshots(fixture)
    ),
    codexLocalSessionAdapter: createFixtureCodexAdapter(fixture),
    codexThreadLifecycleProvider: createFixtureLifecycleProvider(fixture),
    loadClaudeAgentRows: () => [],
    agentVersionForRunningProcess: () => fixture.codexVersion,
    codexProcessBirthForPid: () =>
      fs.readFileSync(fixture.processBirthPath, "utf8").trim(),
    ...(fixture.cliPid ? { pid: fixture.cliPid } : {}),
    cwd: fixture.terminalControl.currentPath,
    env,
    now: () => nowMs,
    monotonicNowMs: () => nowMs,
    sleep: async (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    sleepSync: (milliseconds) => {
      nowMs += milliseconds;
      fixture.clockMs = nowMs;
    },
    exit: onExit ?? ((status) => {
      throw new InProcessCliExit(status);
    }),
    runtimeLog: (level, event, fields) => {
      fixture.runtimeLogs.push({ level, event, fields });
    }
  };
}

export async function waitForFixtureConversation(
  statePath: string,
  predicate: (conversation: Record<string, any>) => boolean,
  timeoutMs: number
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let latest: Record<string, any> | undefined;
  while (Date.now() < deadline) {
    const current = JSON.parse(
      fs.readFileSync(statePath, "utf8")
    ) as Record<string, any>;
    latest = current;
    if (predicate(current)) {
      return current;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `fixture conversation did not settle before ${timeoutMs}ms: ` +
      JSON.stringify({
        status: latest?.status,
        stalled_reason: latest?.stalled_reason,
        native_session_takeover: latest?.native_session_takeover
      }, null, 2)
  );
}

export async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`fixture process ${pid} did not exit before ${timeoutMs}ms`);
}

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  pathsForManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("verified lifecycle target conflict preserves source and later rolls forward without duplicate command, Session, or Turn", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-native-thread-cli-")
  );
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const statusCountPath = path.join(tempDir, "status-count.txt");
  const materializedPath = path.join(tempDir, "materialized");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const spawnHookPath = path.join(tempDir, "lifecycle-spawn-hook.cjs");
  const target = "tmux-test-fixture:0.0";
  const panePid = 71_000;
  const codexPid = 71_001;
  const codexProcessBirth = "Thu Aug  6 10:00:00 2026";
  const oldNativeThreadId = "11111111-1111-4111-8111-111111111111";
  const newNativeThreadId = "22222222-2222-4222-8222-222222222222";
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${newNativeThreadId}.jsonl`
  );
  const executablePath =
    "/opt/akk-test/releases/0.147.0-aarch64-apple-darwin/bin/codex";

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "Ready\n› ");
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: newNativeThreadId,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.147.0"
      }
    })}\n`, { mode: 0o600 });
    writeLifecycleFakeTmux({
      fakeBinDir,
      callsPath: tmuxCallsPath,
      screenPath,
      statusCountPath,
      materializedPath,
      target,
      panePid,
      workspace,
      oldNativeThreadId,
      newNativeThreadId
    });
    writeLifecycleFakeProcessTools({
      fakeBinDir,
      materializedPath,
      rolloutPath,
      executablePath,
      workspace,
      panePid,
      codexPid,
      processBirth: codexProcessBirth
    });
    writeLifecycleSpawnHook({
      hookPath: spawnHookPath,
      callsPath: tmuxCallsPath,
      screenPath,
      statusCountPath,
      materializedPath,
      rolloutPath,
      executablePath,
      workspace,
      panePid,
      codexPid,
      processBirth: codexProcessBirth,
      oldNativeThreadId,
      newNativeThreadId
    });

    const terminalControl: TerminalControlRef = {
      kind: "tmux",
      target,
      session: "tmux-test-fixture",
      window: 0,
      pane: 0,
      panePid,
      currentCommand: "codex",
      currentPath: workspace,
      capabilities: [
        "screen_status",
        "send_keys",
        "terminal_approval",
        "screen_completion",
        "durable_completion",
        "terminal_cancel"
      ]
    };
    const environment = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--require=${spawnHookPath}`
      ].filter(Boolean).join(" "),
      AKK_RUNTIME_DIR: runtimeDir,
      AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
      AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
    };

    const ledgerKey = createHash("sha256")
      .update(JSON.stringify({ target, socket_path: null }))
      .digest("hex")
      .slice(0, 20);
    const malformedLedgerPath = path.join(
      runtimeDir,
      "terminal-dispatch",
      `terminal-dispatch-${ledgerKey}.json`
    );
    fs.mkdirSync(path.dirname(malformedLedgerPath), { recursive: true });
    fs.writeFileSync(malformedLedgerPath, `${JSON.stringify({
      version: 1,
      terminal_key: ledgerKey,
      status: "prepared",
      transition_id: "transition-malformed",
      generation_id: "transition-malformed",
      terminal_control: {
        kind: "tmux",
        target,
        socket_path: null,
        pane_pid: panePid,
        current_path: workspace
      }
    })}\n`, { mode: 0o600 });
    const malformedBlocked = runCli([
      "send",
      "--session",
      terminalId,
      "--managed-only",
      "--message",
      "This must never reach tmux.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(malformedBlocked.status, 1);
    assert.match(malformedBlocked.stderr, /malformed lifecycle dispatch fence/u);
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listManagedSessions(storeDir).length, 0);
    assert.equal(
      readJsonLines(tmuxCallsPath)
        .some((call) => call.args.at(-1) === "This must never reach tmux."),
      false
    );
    fs.unlinkSync(malformedLedgerPath);

    ensureStoreWritable(storeDir);
    const sourceSessionId = "session-source-before-lifecycle";
    const now = new Date("2026-08-06T02:00:00.000Z");
    const sourceSession = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: sourceSessionId,
      agent: "codex",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: codexPid,
        nativeThreadId: oldNativeThreadId,
        processBirth: codexProcessBirth,
        processUuid:
          `codex-pid:${codexPid}:birth:${codexProcessBirth}`,
        evidence: "codex_status_card",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    const expectedBindingToken = managedSessionBindingToken(sourceSession);

    const preparedCrash = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      expectedBindingToken,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], {
      ...environment,
      AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
    });
    assert.equal(
      preparedCrash.status,
      86,
      preparedCrash.stderr || preparedCrash.stdout
    );
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listManagedSessions(storeDir).length, 1);
    assert.equal(listManagedSessions(storeDir)[0].status, "bound");
    const preparedLedgerPath = currentTerminalDispatchLedgerPath(runtimeDir);
    const preparedLedger = JSON.parse(
      fs.readFileSync(preparedLedgerPath, "utf8")
    );
    fs.writeFileSync(preparedLedgerPath, `${JSON.stringify({
      ...preparedLedger,
      terminal_control: {
        ...preparedLedger.terminal_control,
        pane_pid: panePid + 999
      },
      ...(preparedLedger.terminal_endpoint
        ? {
            terminal_endpoint: {
              ...preparedLedger.terminal_endpoint,
              process_anchor_pid: panePid + 999,
              pane_pid: panePid + 999
            }
          }
        : {})
    })}\n`, { mode: 0o600 });
    const recoveryList = runCli([
      "list",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--no-approval-scan"
    ], environment);
    assert.equal(recoveryList.status, 0, recoveryList.stderr);
    const recoveryTerminal = JSON.parse(recoveryList.stdout).terminals[0];
    assert.equal(
      recoveryTerminal.orphaned_terminal_dispatch.kind,
      "lifecycle"
    );
    assert.match(
      recoveryTerminal.orphaned_terminal_dispatch.transition_id,
      /^transition-/u
    );
    const recoveryArguments = recoveryTerminal.available_actions.close.arguments;
    const preparedTransitionId = recoveryArguments.expected_transition_id;
    assert.match(preparedTransitionId, /^transition-/u);
    assert.equal(recoveryArguments.expected_message_id, undefined);
    fs.writeFileSync(
      preparedLedgerPath,
      `${JSON.stringify(preparedLedger)}\n`,
      { mode: 0o600 }
    );
    const staleRecovery = runCli([
      "close",
      "--conversation",
      terminalId,
      "--expected-transition-id",
      "transition-stale",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(staleRecovery.status, 1);
    assert.match(staleRecovery.stderr, /transition identity changed/u);
    const recoveredPrepared = runCli([
      "close",
      "--conversation",
      terminalId,
      "--expected-transition-id",
      preparedTransitionId,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], environment);
    assert.equal(
      recoveredPrepared.status,
      0,
      recoveredPrepared.stderr || recoveredPrepared.stdout
    );
    assert.equal(
      JSON.parse(recoveredPrepared.stdout).terminal_dispatch_resolved,
      true
    );
    fs.writeFileSync(statusCountPath, "0");
    fs.writeFileSync(screenPath, "Ready\n› ");

    const conflicted = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      expectedBindingToken,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ], {
      ...environment,
      AKK_TEST_INJECT_LIFECYCLE_TARGET_CONFLICT: "1"
    });
    assert.equal(
      conflicted.status,
      0,
      conflicted.stderr || conflicted.stdout
    );
    assert.equal(
      JSON.parse(conflicted.stdout).status,
      "verified_recovery_required"
    );
    assert.equal(listConversations(storeDir).length, 0);
    const sessionsAfterConflict = listManagedSessions(storeDir);
    assert.equal(sessionsAfterConflict.length, 2);
    const transitioningSource = sessionsAfterConflict.find((entry) =>
      entry.session_id === sourceSessionId
    );
    assert.equal(transitioningSource?.status, "transitioning");
    const conflictedTransitionId = transitioningSource?.last_transition_id;
    assert.ok(conflictedTransitionId);
    const conflictedTransition = loadNativeThreadTransition(
      storeDir,
      conflictedTransitionId
    );
    assert.equal(conflictedTransition.status, "verified");
    assert.ok(conflictedTransition.target_session_id);
    fs.rmSync(
      pathsForManagedSession(
        conflictedTransition.target_session_id,
        storeDir
      ).directory,
      { recursive: true, force: true }
    );

    const sourceSendAfterCrash = runCli([
      "send",
      "--session",
      sourceSessionId,
      "--message",
      "This source Session must not receive a task after roll-forward.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(sourceSendAfterCrash.status, 1);
    assert.match(sourceSendAfterCrash.stderr, /is no longer bound/u);
    assert.equal(listConversations(storeDir).length, 0);
    const sessionsAfterManagedRecovery = listManagedSessions(storeDir);
    assert.equal(sessionsAfterManagedRecovery.length, 2);
    assert.equal(
      sessionsAfterManagedRecovery.find((entry) =>
        entry.session_id === sourceSessionId
      )?.status,
      "detached"
    );
    const recoveredTarget = sessionsAfterManagedRecovery.find((entry) =>
      entry.status === "bound"
    );
    assert.ok(recoveredTarget);
    assert.equal(recoveredTarget.binding?.native_thread_id, newNativeThreadId);
    const recoveredTransitionId = recoveredTarget.last_transition_id;
    assert.ok(recoveredTransitionId);
    assert.equal(
      loadNativeThreadTransition(storeDir, recoveredTransitionId).status,
      "committed"
    );
    assert.equal(
      readJsonLines(tmuxCallsPath).some((call) =>
        call.args.at(-1) ===
          "This source Session must not receive a task after roll-forward."
      ),
      false
    );

    const sent = runCli([
      "send",
      "--session",
      terminalId,
      "--message",
      "Inspect the repository and report the current branch.",
      "--background",
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome,
      "--disable-terminal-bridge-monitor"
    ], environment);
    assert.equal(
      sent.status,
      0,
      `${sent.stderr}${sent.stdout}\n${JSON.stringify({
        runtime: debugJsonFiles(runtimeDir),
        store: debugJsonFiles(storeDir)
      }, null, 2)}`
    );
    const sentResult = JSON.parse(sent.stdout);
    assert.equal(sentResult.delivered, true, sent.stdout);
    assert.equal(sentResult.status, "async_pending", sent.stdout);
    assert.notEqual(sentResult.turn_id, sentResult.session_id);
    const turns = listConversations(storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, sentResult.session_id);
    assert.equal(turns[0].turn_id, sentResult.turn_id);
    const sessionsAfterRecovery = listManagedSessions(storeDir);
    assert.equal(sessionsAfterRecovery.length, 2);
    const currentSession = sessionsAfterRecovery.find((entry) =>
      entry.status === "bound"
    );
    assert.ok(currentSession);
    assert.equal(currentSession.binding?.binding_id, turns[0].terminal_binding_id);
    assert.equal(
      currentSession.binding?.generation,
      turns[0].terminal_binding_generation
    );
    assert.equal(currentSession.binding?.native_thread_id, newNativeThreadId);
    assert.equal(
      currentSession.binding?.native_process.rollout?.path,
      fs.realpathSync(rolloutPath)
    );
    assert.equal(
      (turns[0].native_session_takeover as Record<string, unknown>)
        ?.terminal_agent_session_id,
      newNativeThreadId
    );

    const sentText = readJsonLines(tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys" && call.args.includes("-l"))
      .map((call) => call.args.at(-1));
    assert.deepEqual(sentText.slice(-6), [
      "/status",
      "/clear",
      "/status",
      "/status",
      "/status",
      "Inspect the repository and report the current branch."
    ]);
    assert.equal(sentText.filter((text) => text === "/clear").length, 1);
    assert.equal(
      sentText.at(-1),
      "Inspect the repository and report the current branch."
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
}

function currentTerminalDispatchLedgerPath(runtimeDir: string): string {
  const ledgerDir = path.join(runtimeDir, "terminal-dispatch");
  const ledgers = fs.readdirSync(ledgerDir)
    .filter((name) => /^terminal-dispatch-[0-9a-f]{20}\.json$/u.test(name));
  assert.equal(
    ledgers.length,
    1,
    `expected one current terminal dispatch ledger, found ${ledgers.join(", ")}`
  );
  return path.join(ledgerDir, ledgers[0]);
}

function writeLifecycleFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  statusCountPath: string;
  materializedPath: string;
  target: string;
  panePid: number;
  workspace: string;
  oldNativeThreadId: string;
  newNativeThreadId: string;
}): void {
  const fakeTmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-test-fixture\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\t\t%42\n`
  )});
  process.exit(0);
}
if (args[0] === "display-message") {
  process.stdout.write("100\\t30\\n");
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const text = args[args.length - 1];
  if (text === "/status") {
    fs.writeFileSync(${JSON.stringify(options.screenPath)},
      "Ready\\n› /status\\n" +
      "  /status      show current session configuration and token usage\\n" +
      "  /statusline  configure which items appear in the status line");
  } else if (text === "/clear") {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Cleared\\n› ");
  } else {
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("C-m")) {
  const screen = fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8");
  if (screen.includes("› /status")) {
    const count = fs.existsSync(${JSON.stringify(options.statusCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.statusCountPath)}, "utf8"))
      : 0;
    const next = count + 1;
    fs.writeFileSync(${JSON.stringify(options.statusCountPath)}, String(next));
    const id = next === 1
      ? ${JSON.stringify(options.oldNativeThreadId)}
      : ${JSON.stringify(options.newNativeThreadId)};
    fs.writeFileSync(${JSON.stringify(options.screenPath)},
      "/status\\nprobe-" + next + "\\nSession: " + id + "\\n› ");
  }
  process.exit(0);
}
`, { mode: 0o755 });
}

function writeLifecycleFakeProcessTools(options: {
  fakeBinDir: string;
  materializedPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
  processBirth: string;
}): void {
  const fakePs = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(fakePs, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(${JSON.stringify(`${options.processBirth}\n`)});
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)});
}
`, { mode: 0o755 });

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  fs.writeFileSync(fakeLsof, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.codexPid}\\nftxt\\nn${options.executablePath}\\n");
} else if (fs.existsSync(${JSON.stringify(options.materializedPath)})) {
  const stat = fs.statSync(${JSON.stringify(options.rolloutPath)});
  process.stdout.write("p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
    "\\ni" + stat.ino + "\\nn${options.rolloutPath}\\n");
}
`, { mode: 0o755 });
}

function writeLifecycleSpawnHook(options: {
  hookPath: string;
  callsPath: string;
  screenPath: string;
  statusCountPath: string;
  materializedPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
  processBirth: string;
  oldNativeThreadId: string;
  newNativeThreadId: string;
}): void {
  fs.writeFileSync(options.hookPath, `
const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { syncBuiltinESMExports } = require("node:module");
const originalSpawnSync = childProcess.spawnSync;

function result(stdout = "", status = 0, stderr = "") {
  return {
    pid: 0,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status,
    signal: null
  };
}

function tmux(args) {
  fs.appendFileSync(
    ${JSON.stringify(options.callsPath)},
    JSON.stringify({ args }) + "\\n"
  );
  const offset = args[0] === "-S" ? 2 : 0;
  const operation = args[offset];
  if (operation === "list-panes") {
    return result(${JSON.stringify(
      `tmux-test-fixture\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\t\t%42\n`
    )});
  }
  if (operation === "display-message") {
    return result("100\\t30\\n");
  }
  if (operation === "capture-pane") {
    return result(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
  }
  if (operation === "send-keys") {
    const operationArgs = args.slice(offset);
    if (operationArgs.includes("-l")) {
      const text = operationArgs.at(-1);
      if (text === "/status") {
        fs.writeFileSync(
          ${JSON.stringify(options.screenPath)},
          "Ready\\n› /status\\n" +
          "  /status      show current session configuration and token usage\\n" +
          "  /statusline  configure which items appear in the status line"
        );
      } else if (text === "/clear") {
        fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Cleared\\n› ");
      } else {
        fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
        fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
      }
    } else if (operationArgs.includes("C-m")) {
      const screen = fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8");
      if (screen.includes("› /status")) {
        const count = fs.existsSync(${JSON.stringify(options.statusCountPath)})
          ? Number(fs.readFileSync(${JSON.stringify(options.statusCountPath)}, "utf8"))
          : 0;
        const next = count + 1;
        fs.writeFileSync(${JSON.stringify(options.statusCountPath)}, String(next));
        const id = next === 1
          ? ${JSON.stringify(options.oldNativeThreadId)}
          : ${JSON.stringify(options.newNativeThreadId)};
        fs.writeFileSync(
          ${JSON.stringify(options.screenPath)},
          "/status\\nprobe-" + next + "\\nSession: " + id + "\\n› "
        );
      }
    }
  }
  return result();
}

function ps(args) {
  if (args.includes("lstart=")) {
    return result(${JSON.stringify(`${options.processBirth}\n`)});
  }
  return result(
    "  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)}
  );
}

function lsof(args) {
  if (args.includes("cwd")) {
    return result(
      "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
      ${JSON.stringify(`codex ${options.codexPid} me cwd DIR 1,18 64 123 ${options.workspace}\n`)}
    );
  }
  if (args.includes("txt")) {
    return result(${JSON.stringify(
      `p${options.codexPid}\nftxt\nn${options.executablePath}\n`
    )});
  }
  if (fs.existsSync(${JSON.stringify(options.materializedPath)})) {
    const stat = fs.statSync(${JSON.stringify(options.rolloutPath)});
    return result(
      "p${options.codexPid}\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn${options.rolloutPath}\\n"
    );
  }
  return result();
}

childProcess.spawnSync = function patchedSpawnSync(command, args = [], options) {
  const basename = path.basename(String(command));
  if (basename === "tmux") return tmux(args.map(String));
  if (basename === "ps") return ps(args.map(String));
  if (basename === "lsof") return lsof(args.map(String));
  return originalSpawnSync.call(this, command, args, options);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
}

function readJsonLines(filePath: string): Array<{ args: string[] }> {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function debugJsonFiles(root: string): Record<string, unknown> {
  if (!fs.existsSync(root)) {
    return {};
  }
  return Object.fromEntries(
    fs.readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((entry) => String(entry).endsWith(".json"))
      .map((entry) => {
        const relative = String(entry);
        const filePath = path.join(root, relative);
        try {
          return [relative, JSON.parse(fs.readFileSync(filePath, "utf8"))];
        } catch {
          return [relative, "unreadable"];
        }
      })
  );
}

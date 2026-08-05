import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import {
  loadManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import {
  ensureStoreWritable,
  listConversations
} from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const LIVE_PROCESS_BIRTH = "Thu Aug  6 10:00:00 2026";
const STALE_PROCESS_BIRTH = "Wed Aug  5 10:00:00 2026";
const NATIVE_THREAD_ID = "11111111-1111-4111-8111-111111111111";

test("virgin raw Codex attach atomically refines the Session and Turn binding after send", () => {
  const fixture = createNoRolloutFixture();
  try {
    const sent = runCli([
      "send",
      "--conversation",
      fixture.terminalId,
      "--message",
      "Start the first native Codex thread.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], fixture.environment);

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true, sent.stdout);
    assert.equal(output.status, "async_pending");
    assert.equal(output.conversation.status, "waiting_for_agent");
    assert.equal(output.conversation.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      output.conversation.native_session_takeover.terminal_agent_session_id,
      NATIVE_THREAD_ID
    );

    const session = loadManagedSession(fixture.storeDir, output.session_id);
    assert.equal(session.status, "bound");
    assert.equal(session.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      session.binding?.binding_id,
      output.conversation.terminal_binding_id
    );
    assert.equal(
      session.binding?.generation,
      output.conversation.terminal_binding_generation
    );
    assert.equal(session.binding?.generation, 1);
    assert.equal(
      session.binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    assert.equal(
      session.binding?.native_process.process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(session.binding?.native_process.rollout?.path as string),
      fs.realpathSync(fixture.rolloutPath)
    );

    const turns = listConversations(fixture.storeDir);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].session_id, session.session_id);
    assert.equal(turns[0].turn_id, output.turn_id);
    assert.equal(turns[0].terminal_binding_id, session.binding?.binding_id);
    assert.equal(
      turns[0].terminal_binding_generation,
      session.binding?.generation
    );
    assert.equal(turns[0].native_thread_id, NATIVE_THREAD_ID);

    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.at(-2)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "-l",
      "Start the first native Codex thread."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("Codex status-card binding rejects the same PID with a different process birth", () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, STALE_PROCESS_BIRTH);
    const sent = runCli([
      "send",
      "--session",
      session.session_id,
      "--message",
      "This must not reach the reused Codex PID.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], fixture.environment);

    assert.equal(sent.status, 1, sent.stdout);
    assert.match(
      sent.stderr,
      /changed native thread outside AKK|identity changed/u
    );
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.equal(
      readTmuxCalls(fixture.tmuxCallsPath)
        .some((call) => call.args[0] === "send-keys"),
      false
    );
  } finally {
    fixture.cleanup();
  }
});

test("Codex status-card binding with the same process birth authorizes and refines the Turn", () => {
  const fixture = createNoRolloutFixture();
  try {
    const session = persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH);
    const sent = runCli([
      "send",
      "--session",
      session.session_id,
      "--message",
      "Inspect the repository without changing files.",
      "--background",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], fixture.environment);

    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const output = JSON.parse(sent.stdout);
    assert.equal(output.delivered, true);
    const takeover = output.conversation.native_session_takeover;
    assert.equal(takeover.terminal_agent_session_id, NATIVE_THREAD_ID);
    assert.equal(takeover.terminal_agent_process_birth, LIVE_PROCESS_BIRTH);
    assert.equal(
      takeover.terminal_agent_process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(takeover.terminal_agent_rollout.path),
      fs.realpathSync(fixture.rolloutPath)
    );

    const refined = loadManagedSession(fixture.storeDir, session.session_id);
    assert.equal(refined.status, "bound");
    assert.equal(refined.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      refined.binding?.native_process.process_birth,
      LIVE_PROCESS_BIRTH
    );
    assert.equal(
      refined.binding?.native_process.process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );
    assert.equal(
      fs.realpathSync(refined.binding?.native_process.rollout?.path as string),
      fs.realpathSync(fixture.rolloutPath)
    );

    const sends = readTmuxCalls(fixture.tmuxCallsPath)
      .filter((call) => call.args[0] === "send-keys");
    assert.deepEqual(sends.at(-2)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "-l",
      "Inspect the repository without changing files."
    ]);
    assert.deepEqual(sends.at(-1)?.args, [
      "send-keys",
      "-t",
      fixture.target,
      "C-m"
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("unmanaged Codex lifecycle token changes when a PID is reused", () => {
  const fixture = createNoRolloutFixture();
  try {
    const first = runCli([
      "list",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--no-approval-scan"
    ], fixture.environment);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const firstTerminal = JSON.parse(first.stdout).terminals[0];
    assert.equal(firstTerminal.native_agent_process_birth, LIVE_PROCESS_BIRTH);
    assert.equal(
      firstTerminal.native_agent_process_uuid,
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH)
    );

    fs.writeFileSync(fixture.processBirthPath, STALE_PROCESS_BIRTH);
    const second = runCli([
      "list",
      "--store-dir",
      fixture.storeDir,
      "--codex-home",
      fixture.codexHome,
      "--no-approval-scan"
    ], fixture.environment);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const secondTerminal = JSON.parse(second.stdout).terminals[0];
    assert.equal(secondTerminal.native_agent_process_birth, STALE_PROCESS_BIRTH);
    assert.notEqual(
      secondTerminal.lifecycle_binding_token,
      firstTerminal.lifecycle_binding_token
    );
  } finally {
    fixture.cleanup();
  }
});

interface NoRolloutFixture {
  tempDir: string;
  storeDir: string;
  codexHome: string;
  rolloutPath: string;
  processBirthPath: string;
  tmuxCallsPath: string;
  target: string;
  terminalId: string;
  terminalControl: TerminalControlRef;
  codexPid: number;
  environment: NodeJS.ProcessEnv;
  cleanup(): void;
}

function createNoRolloutFixture(): NoRolloutFixture {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-birth-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const pendingInputPath = path.join(tempDir, "pending-input.txt");
  const materializedPath = path.join(tempDir, "materialized");
  const processBirthPath = path.join(tempDir, "process-birth.txt");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");
  const target = "tmux-birth:0.0";
  const panePid = 72_000;
  const codexPid = 72_001;
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${NATIVE_THREAD_ID}.jsonl`
  );
  const executablePath =
    "/opt/akk-test/releases/0.146.0-aarch64-apple-darwin/bin/codex";

  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(screenPath, "Ready\n› ");
  fs.writeFileSync(processBirthPath, LIVE_PROCESS_BIRTH);
  fs.writeFileSync(rolloutPath, `${JSON.stringify({
    timestamp: "2026-08-06T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: NATIVE_THREAD_ID,
      cwd: workspace,
      originator: "codex-tui",
      source: "cli",
      cli_version: "0.146.0"
    }
  })}\n`, { mode: 0o600 });
  writeFakeTmux({
    fakeBinDir,
    callsPath: tmuxCallsPath,
    screenPath,
    pendingInputPath,
    materializedPath,
    target,
    panePid,
    workspace
  });
  writeFakeProcessTools({
    fakeBinDir,
    materializedPath,
    processBirthPath,
    rolloutPath,
    executablePath,
    workspace,
    panePid,
    codexPid
  });

  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: "tmux-birth",
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
  return {
    tempDir,
    storeDir,
    codexHome,
    rolloutPath,
    processBirthPath,
    tmuxCallsPath,
    target,
    terminalId,
    terminalControl,
    codexPid,
    environment: {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir
    },
    cleanup() {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

function persistStatusCardSession(
  fixture: NoRolloutFixture,
  processBirth: string
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T02:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-codex-status-card",
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: fixture.terminalId,
      terminalControl: fixture.terminalControl,
      pid: fixture.codexPid,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: processUuid(fixture.codexPid, processBirth),
      processBirth,
      evidence: "codex_status_card",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  }, { expectedRevision: null });
}

function processUuid(pid: number, processBirth: string): string {
  return `codex-pid:${pid}:birth:${processBirth}`;
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
}

function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  pendingInputPath: string;
  materializedPath: string;
  target: string;
  panePid: number;
  workspace: string;
}): void {
  const fakeTmux = path.join(options.fakeBinDir, "tmux");
  fs.writeFileSync(fakeTmux, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `tmux-birth\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\n`
  )});
} else if (args[0] === "capture-pane") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
} else if (args[0] === "send-keys" && args.includes("-l")) {
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, args.at(-1));
} else if (args[0] === "send-keys" && args.at(-1) === "C-m") {
  const pendingInput = fs.existsSync(${JSON.stringify(options.pendingInputPath)})
    ? fs.readFileSync(${JSON.stringify(options.pendingInputPath)}, "utf8")
    : "";
  fs.writeFileSync(${JSON.stringify(options.pendingInputPath)}, "");
  if (pendingInput === "/status") {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, ${JSON.stringify(
      `/status\nSession: ${NATIVE_THREAD_ID}\n› `
    )});
  } else {
    fs.writeFileSync(${JSON.stringify(options.materializedPath)}, "ready");
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
}
`, { mode: 0o755 });
}

function writeFakeProcessTools(options: {
  fakeBinDir: string;
  materializedPath: string;
  processBirthPath: string;
  rolloutPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
}): void {
  const fakePs = path.join(options.fakeBinDir, "ps");
  fs.writeFileSync(fakePs, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.processBirthPath)}, "utf8") + "\\n");
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

function readTmuxCalls(filePath: string): Array<{ args: string[] }> {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

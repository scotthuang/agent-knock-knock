import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  ensureStoreWritable,
  pathsForConversation
} from "../src/store.js";
import {
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "../src/session-store.js";
import type { ClaudeAgentRow } from "../src/claude-terminal-agent-adapter.js";
import { CodexStoreAdapter } from "../src/codex-store-adapter.js";
import {
  createTerminalControlProviderRegistry,
  TmuxTerminalControlProvider
} from "../src/terminal-control-provider.js";
import {
  SystemTerminalProcessSource,
  type ProcessCommandResult
} from "../src/terminal-process-source.js";
import { runInProcessCli } from "./in-process-cli-fixtures.js";

export const binPath = new URL("../src/cli.js", import.meta.url).pathname;
export const testRuntimeDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-agent-cli-runtime-")
);
export const cwd = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-agent-cli-workspace-")
);
process.env.AKK_RUNTIME_DIR = testRuntimeDir;
process.on("exit", () => {
  fs.rmSync(testRuntimeDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});
export const sessionId = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";
export const rolloutPath = "/tmp/codex-rollout.jsonl";

export interface ManagedClaudeTerminalTask {
  conversation: any;
  statePath: string;
  logPath: string;
}

type AgentCliCommandRunner = (
  command: string,
  args: string[]
) => ProcessCommandResult;

export async function startManagedClaudeTerminalTask(options: {
  fakeBinDir: string;
  workspace: string;
  storeDir: string;
  claudeHome?: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  message: string;
}): Promise<ManagedClaudeTerminalTask> {
  writeFakeProcessTools(options.fakeBinDir, [{
    pid: options.claudePid,
    ppid: 999,
    command: "claude",
    cwd: options.workspace
  }]);
  const openclawBin = path.join(options.fakeBinDir, "openclaw");
  const rawConversationId = `terminal:v2:tmux:claude:${options.terminalTarget}:${options.claudePid}`;
  const sent = await runAgentCliInProcess([
    "send",
    "--conversation",
    rawConversationId,
    "--message",
    options.message,
    "--background",
    "--store-dir",
    options.storeDir,
    "--gateway-method",
    "agent-knock-knock.callback",
    "--gateway-session",
    "agent:channel:original",
    "--openclaw-session",
    "agent:channel:original",
    "--openclaw-bin",
    openclawBin,
    ...(options.claudeHome
      ? ["--claude-home", options.claudeHome]
      : []),
    "--claude-agents-json",
    JSON.stringify([claudeAgentRow(options.claudePid, options.claudeSessionId, options.workspace)]),
    "--disable-terminal-bridge-monitor"
  ], {
    PATH: `${options.fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
  });
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const parsed = JSON.parse(sent.stdout);
  assert.equal(parsed.delivered, true);
  assert.equal(parsed.status, "async_pending");
  assert.equal(parsed.background, true);
  assert.equal(parsed.executor.kind, "claude");
  assert.equal(parsed.terminal_control.target, options.terminalTarget);
  return {
    conversation: parsed.conversation,
    statePath: parsed.conversation.state_path,
    logPath: parsed.conversation.event_log_path
  };
}

export function claudeTerminalStaticArgs(options: {
  workspace: string;
  terminalTarget: string;
  claudePid: number;
  claudeSessionId: string;
  screen: string;
}): string[] {
  return [
    "--processes-json",
    JSON.stringify([{
      pid: options.claudePid,
      ppid: 999,
      elapsed: "00:30",
      command: "claude",
      cwd: options.workspace
    }]),
    "--terminals-json",
    JSON.stringify([{
      kind: "tmux",
      target: options.terminalTarget,
      session: "claude-work",
      window: 0,
      pane: 0,
      panePid: 999,
      currentCommand: "node",
      currentPath: options.workspace
    }]),
    "--terminal-screens-json",
    JSON.stringify({ [options.terminalTarget]: options.screen }),
    "--claude-agents-json",
    JSON.stringify([claudeAgentRow(options.claudePid, options.claudeSessionId, options.workspace)])
  ];
}

export function claudeAgentRow(pid: number, sessionId: string, workspace: string) {
  return {
    kind: "interactive",
    pid,
    sessionId,
    startedAt: 1784870000000,
    cwd: workspace,
    status: "idle"
  };
}

export function codexNativeIdentityArgs(options: {
  pid: number;
  sessionId: string;
  processUuid: string;
  rolloutPath: string;
}): string[] {
  return [
    "--codex-active-session-identities-json",
    JSON.stringify({
      [options.pid]: {
        sessionId: options.sessionId,
        processUuid: options.processUuid,
        processBirth: options.processUuid,
        rollout: {
          fd: "12r",
          device: "1",
          inode: "2",
          path: options.rolloutPath
        }
      }
    })
  ];
}

export function agentCliTestEnv(
  args: string[],
  env: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  let inferredRuntimeDir: string | undefined;
  const storeIndex = args.indexOf("--store-dir");
  if (storeIndex >= 0 && args[storeIndex + 1]) {
    inferredRuntimeDir = path.join(
      path.dirname(path.resolve(args[storeIndex + 1])),
      ".akk-cli-test-runtime"
    );
  } else {
    const stateIndex = args.indexOf("--state");
    if (stateIndex >= 0 && args[stateIndex + 1]) {
      const statePath = path.resolve(args[stateIndex + 1]);
      const inferredStoreDir = path.dirname(
        path.dirname(path.dirname(statePath))
      );
      inferredRuntimeDir = path.join(
        path.dirname(inferredStoreDir),
        ".akk-cli-test-runtime"
      );
    }
  }
  return {
    ...process.env,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
    AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted",
    ...(inferredRuntimeDir && env.AKK_RUNTIME_DIR === undefined
      ? { AKK_RUNTIME_DIR: inferredRuntimeDir }
      : {}),
    ...env
  };
}

export function runAgentCliInProcess(
  args: string[],
  env: NodeJS.ProcessEnv = {}
) {
  const commandEnvironment = agentCliTestEnv(args, env);
  const usesStaticTerminalAdapters = [
    "--processes-json",
    "--terminals-json",
    "--terminal-screens-json"
  ].some((option) => args.includes(option));
  const usesStaticClaudeAgentAdapter = args.includes("--claude-agents-json");
  const usesStaticAgentVersionAdapter = args.includes("--agent-versions-json");
  const usesStaticCodexSessionAdapter = [
    "--threads-json",
    "--processes-json",
    "--rollouts-json",
    "--codex-active-session-identities-json"
  ].some((option) => args.includes(option));
  const runCommand = (command: string, commandArgs: string[]) => {
    const completed = spawnSync(command, commandArgs, {
      encoding: "utf8",
      env: commandEnvironment
    });
    return {
      status: completed.status,
      stdout: completed.stdout ?? "",
      stderr: completed.stderr ?? "",
      ...(completed.error ? { error: completed.error } : {})
    };
  };
  return runInProcessCli(args, {
    env: commandEnvironment,
    cwd: process.cwd(),
    pid: process.pid,
    now: () => new Date(),
    monotonicNowMs: () => performance.now(),
    sleep: (milliseconds) => new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
    sleepSync: (milliseconds) => {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds
      );
    },
    runtimeLog() {},
    ...(env.PATH !== undefined
      ? {
          codexProcessBirthForPid: (pid: number) =>
            codexProcessBirthWithRunner(runCommand, pid)
        }
      : {}),
    ...(!usesStaticAgentVersionAdapter && env.PATH !== undefined
      ? {
          agentVersionForRunningProcess: (
            agent: "codex" | "claude",
            pid: number
          ) => agentVersionWithRunner(runCommand, agent, pid)
        }
      : {}),
    ...(!usesStaticCodexSessionAdapter && env.PATH !== undefined
      ? {
          codexLocalSessionAdapter: (options: Record<string, unknown>) =>
            new CodexStoreAdapter({
              codexHome: expandedTestPath(options.codexHome),
              runCommand
            })
        }
      : {}),
    ...(!usesStaticClaudeAgentAdapter &&
      !usesStaticTerminalAdapters &&
      env.PATH !== undefined
      ? {
          loadClaudeAgentRows: (
            _options: Record<string, unknown>,
            observation: { required?: boolean }
          ) => loadClaudeAgentRowsWithRunner(runCommand, observation)
        }
      : {}),
    ...(!usesStaticTerminalAdapters && env.PATH !== undefined
      ? {
          terminalControlProviderRegistry:
            createTerminalControlProviderRegistry([
              new TmuxTerminalControlProvider({
                commands: ["tmux"],
                runCommand,
                socketPaths: []
              })
            ]),
          terminalProcessSource: new SystemTerminalProcessSource({ runCommand })
        }
      : {})
  });
}

function loadClaudeAgentRowsWithRunner(
  runCommand: AgentCliCommandRunner,
  observation: { required?: boolean }
): ClaudeAgentRow[] {
  const result = runCommand("claude", ["agents", "--json", "--all"]);
  if (result.error || result.status !== 0) {
    if (observation.required) {
      throw new Error(
        (result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
          ? "Claude agent session observation is unavailable because the Claude CLI could not be resolved"
          : "Claude agent session observation failed; refusing to treat the process as a virgin session"
      );
    }
    return [];
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    if (observation.required) {
      throw new Error(
        "Claude agent session observation returned invalid JSON; refusing to treat the process as a virgin session"
      );
    }
    return [];
  }
  const rows = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.agents)
      ? value.agents
      : undefined;
  if (!rows) {
    if (observation.required) {
      throw new Error(
        "Claude agent session observation returned an unsupported result shape; refusing to treat the process as a virgin session"
      );
    }
    return [];
  }
  return rows.flatMap((row): ClaudeAgentRow[] => {
    if (!isRecord(row) || !Number.isInteger(Number(row.pid))) {
      return [];
    }
    return [{
      pid: Number(row.pid),
      ...(typeof row.cwd === "string" && row.cwd
        ? { cwd: row.cwd }
        : {}),
      ...(typeof row.kind === "string" && row.kind
        ? { kind: row.kind }
        : {}),
      ...(typeof row.sessionId === "string" && row.sessionId
        ? { sessionId: row.sessionId }
        : {}),
      ...(Number.isSafeInteger(Number(row.startedAt)) && Number(row.startedAt) > 0
        ? { startedAt: Number(row.startedAt) }
        : {}),
      ...(typeof row.status === "string" && row.status
        ? { status: row.status }
        : {}),
      ...(typeof row.waitingFor === "string" && row.waitingFor
        ? { waitingFor: row.waitingFor }
        : {})
    }];
  });
}

function codexProcessBirthWithRunner(
  runCommand: AgentCliCommandRunner,
  pid: number
): string {
  const result = runCommand("ps", ["-o", "lstart=", "-p", String(pid)]);
  const processBirth = result.stdout.trim();
  if (result.error || result.status !== 0 || !processBirth) {
    throw new Error(
      result.stderr.trim() ||
      result.error?.message ||
      `cannot verify Codex process incarnation for pid ${pid}`
    );
  }
  return processBirth;
}

function agentVersionWithRunner(
  runCommand: AgentCliCommandRunner,
  agent: "codex" | "claude",
  pid: number
): string | undefined {
  const result = runCommand("lsof", [
    "-a",
    "-p",
    String(pid),
    "-d",
    "txt",
    "-Fn"
  ]);
  if (result.error || result.status !== 0) {
    return undefined;
  }
  const pattern = agent === "codex"
    ? /\/releases\/(\d+\.\d+\.\d+)(?:-[^/]*)?\/bin\/codex$/u
    : /\/claude\/versions\/(\d+\.\d+\.\d+)$/u;
  const versions = [...new Set(
    result.stdout
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("n"))
      .flatMap((line): string[] => {
        const match = pattern.exec(line.slice(1));
        return match ? [match[1]] : [];
      })
  )];
  return versions.length === 1 ? versions[0] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandedTestPath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return undefined;
  }
  return value === "~"
    ? os.homedir()
    : value.startsWith("~/")
      ? path.join(os.homedir(), value.slice(2))
      : value;
}

export function runAgentCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  timeoutMs = 30_000
) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      env: agentCliTestEnv(args, env)
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`agent CLI child exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (status) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({ status, stdout, stderr });
    });
  });
}

export function spawnAgentCliCaptured(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: agentCliTestEnv(args, env)
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const result = new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
  return { child, result };
}

export function spawnAgentCliProcess(args: string[], env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, [binPath, ...args], {
    env: agentCliTestEnv(args, env)
  });
  child.stdout.resume();
  child.stderr.resume();
  return child;
}

export async function waitForCondition(
  condition: () => boolean,
  description: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

export async function waitForChildExit(
  child: ReturnType<typeof spawn>,
  timeoutMs = 5000
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`timed out waiting for child ${child.pid} to exit`)),
      timeoutMs
    );
    child.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

export async function waitForPidExit(pid: number | undefined, timeoutMs = 5000): Promise<void> {
  if (!pid) {
    return;
  }
  await waitForCondition(() => !pidIsAlive(pid), `pid ${pid} to exit`, timeoutMs);
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    const status = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8"
    });
    return status.status === 0 && !status.stdout.trim().startsWith("Z");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function killPidBestEffort(pid: number | undefined): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The monitor already exited.
  }
}

export function eventCount(logPath: string, eventName: string): number {
  if (!fs.existsSync(logPath)) {
    return 0;
  }
  const snapshot = fs.readFileSync(logPath, "utf8");
  // The monitor may still be appending the final record while this polling
  // reader runs. Ignore only that unterminated tail; malformed completed
  // records must still fail the test.
  const completeSnapshot = snapshot.endsWith("\n")
    ? snapshot
    : snapshot.slice(0, snapshot.lastIndexOf("\n") + 1);
  return completeSnapshot
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((event) => event.event === eventName)
    .length;
}

export function writeConversationClone(
  storeDir: string,
  sourceState: any,
  conversationId: string,
  mutate: (state: any) => any
): string {
  ensureStoreWritable(storeDir);
  copyManagedSessionForConversationClone(storeDir, sourceState);
  const paths = pathsForConversation(conversationId, storeDir);
  const conversationDir = paths.conversationDir;
  const statePath = paths.statePath;
  const eventLogPath = paths.logPath;
  fs.mkdirSync(conversationDir, { recursive: true });
  const cloned = mutate({
    ...sourceState,
    conversation_id: conversationId,
    ...(sourceState.session_id && sourceState.turn_id
      ? { turn_id: conversationId }
      : {}),
    store_dir: storeDir,
    conversation_dir: conversationDir,
    state_path: statePath,
    event_log_path: eventLogPath
  });
  fs.writeFileSync(statePath, `${JSON.stringify(cloned, null, 2)}\n`);
  return statePath;
}

export function copyManagedSessionForConversationClone(
  targetStoreDir: string,
  sourceState: any
): void {
  const sessionId = typeof sourceState?.session_id === "string"
    ? sourceState.session_id
    : undefined;
  const nativeTakeover = sourceState?.native_session_takeover;
  if (!sessionId || nativeTakeover?.terminal_bridge !== true) {
    return;
  }

  const sourceStoreDir = typeof sourceState.store_dir === "string"
    ? sourceState.store_dir
    : undefined;
  assert.ok(
    sourceStoreDir,
    `managed Turn clone ${sourceState.conversation_id} has no source Store`
  );
  const sourceSession = loadManagedSession(sourceStoreDir, sessionId);
  const existingTarget = tryLoadManagedSession(targetStoreDir, sessionId);
  const withoutRevision = (state: typeof sourceSession) => {
    const { revision: _revision, ...rest } = state;
    return rest;
  };
  if (existingTarget) {
    assert.deepEqual(
      withoutRevision(existingTarget),
      withoutRevision(sourceSession),
      `managed Session ${sessionId} differs in cloned Store`
    );
    return;
  }

  saveManagedSession(
    targetStoreDir,
    withoutRevision(sourceSession),
    { expectedRevision: null }
  );
}

export function threadRow(overrides: Record<string, unknown> = {}) {
  return {
    id: sessionId,
    cwd,
    rollout_path: rolloutPath,
    title: "review current branch",
    updated_at_ms: 1000,
    archived: false,
    ...overrides
  };
}

export function tmuxPane(overrides: Record<string, unknown> = {}) {
  return {
    kind: "tmux",
    target: "codex-work:0.0",
    session: "codex-work",
    window: 0,
    pane: 0,
    panePid: 999,
    currentCommand: "node",
    currentPath: cwd,
    ...overrides
  };
}

export function writeFakeTmux(
  fakeBinDir: string,
  callsPath: string,
  screenPath?: string,
  listPanesOutput = "",
  failSendText = "",
  failSendOutcomeUncertain = false
) {
  const fakeTmux = path.join(fakeBinDir, "tmux");
  fs.writeFileSync(
    fakeTmux,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
if (${JSON.stringify(failSendText)} && args.includes(${JSON.stringify(failSendText)})) {
  if (${JSON.stringify(failSendOutcomeUncertain)}) {
    process.kill(process.pid, "SIGKILL");
  }
  process.exit(1);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const rolloutPath = process.env.AKK_TEST_CODEX_ACCEPTANCE_ROLLOUT_PATH;
  if (rolloutPath) {
    fs.writeFileSync(rolloutPath + ".pending-input", args[args.length - 1]);
  }
  if (process.env.AKK_TEST_TMUX_COMPOSER_FROM_LITERAL === "1") {
    fs.writeFileSync(
      ${JSON.stringify(screenPath ?? "")},
      "› " + args[args.length - 1]
    );
  }
  const gatePath = process.env.AKK_TEST_TMUX_SEND_GATE_PATH;
  if (gatePath) {
    fs.writeFileSync(gatePath + ".entered", "");
    while (!fs.existsSync(gatePath + ".release")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  const delayMs = Number(process.env.AKK_TEST_TMUX_SEND_DELAY_MS || 0);
  if (delayMs > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  }
}
if (args[0] === "paste-buffer" && process.env.AKK_TEST_TMUX_COMPOSER_AFTER_PASTE) {
  fs.writeFileSync(${JSON.stringify(screenPath ?? "")}, process.env.AKK_TEST_TMUX_COMPOSER_AFTER_PASTE);
}
if (
  args[0] === "send-keys" &&
  args[args.length - 1] === "C-m" &&
  process.env.AKK_TEST_TMUX_COMPOSER_AFTER_ENTER
) {
  fs.writeFileSync(${JSON.stringify(screenPath ?? "")}, process.env.AKK_TEST_TMUX_COMPOSER_AFTER_ENTER);
}
if (
  args[0] === "send-keys" &&
  args[args.length - 1] === "C-m" &&
  process.env.AKK_TEST_CODEX_ACCEPTANCE_ROLLOUT_PATH
) {
  const rolloutPath = process.env.AKK_TEST_CODEX_ACCEPTANCE_ROLLOUT_PATH;
  const pendingPath = rolloutPath + ".pending-input";
  if (fs.existsSync(pendingPath)) {
    const request = fs.readFileSync(pendingPath, "utf8");
    const turnId = require("node:crypto").randomUUID();
    const timestamp = new Date().toISOString();
    const records = [
      {
        timestamp,
        type: "event_msg",
        payload: { type: "task_started", turn_id: turnId }
      },
      {
        timestamp,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: request }],
          internal_chat_message_metadata_passthrough: { turn_id: turnId }
        }
      }
    ];
    fs.appendFileSync(
      rolloutPath,
      records.map((record) => JSON.stringify(record)).join("\\n") + "\\n"
    );
    fs.rmSync(pendingPath, { force: true });
  }
}
if (args[0] === "capture-pane") {
  if (process.env.AKK_TEST_TMUX_CAPTURE_FAIL === "1") {
    process.stderr.write("capture failed\\n");
    process.exit(1);
  }
  process.stdout.write(fs.existsSync(${JSON.stringify(screenPath ?? "")}) ? fs.readFileSync(${JSON.stringify(screenPath ?? "")}, "utf8") : "");
} else if (args[0] === "list-panes") {
  const gatePath = process.env.AKK_TEST_TMUX_LIST_GATE_PATH;
  if (gatePath) {
    fs.writeFileSync(gatePath + ".entered", "");
    while (!fs.existsSync(gatePath + ".release")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  process.stdout.write(${JSON.stringify(listPanesOutput)});
}
`,
    "utf8"
  );
  fs.chmodSync(fakeTmux, 0o755);

  const paneProcesses = listPanesOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split("\t");
      const pid = Number(fields[3]);
      return Number.isInteger(pid)
        ? [{
            pid,
            ppid: 1,
            command: "codex",
            cwd: fields.slice(5).join("\t")
          }]
        : [];
    });
  if (paneProcesses.length > 0) {
    writeFakeProcessTools(fakeBinDir, paneProcesses);
  }
}

export function writeFakeProcessTools(
  fakeBinDir: string,
  processes: Array<{ pid: number; ppid: number; command: string; cwd: string }>
) {
  const fakePs = path.join(fakeBinDir, "ps");
  const psOutput = [
    "  PID  PPID ELAPSED COMMAND",
    ...processes.map((entry) =>
      `${entry.pid} ${entry.ppid} 00:01 ${entry.command}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakePs,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("lstart=")) {
  process.stdout.write("Thu Aug  6 10:00:00 2026\\n");
} else {
  process.stdout.write(${JSON.stringify(psOutput)});
}
`,
    "utf8"
  );
  fs.chmodSync(fakePs, 0o755);

  const fakeLsof = path.join(fakeBinDir, "lsof");
  const lsofOutput = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    ...processes.map((entry) =>
      `${path.basename(entry.command.split(/\s+/u)[0] || "agent")} ${entry.pid} me cwd DIR 1,18 64 123 ${entry.cwd}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakeLsof,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(lsofOutput)});
`,
    "utf8"
  );
  fs.chmodSync(fakeLsof, 0o755);
}

export function writeTrackedFakeProcessTools(options: {
  fakeBinDir: string;
  callsPath: string;
  processes: Array<{
    pid: number;
    ppid: number;
    command: string;
    cwd: string;
  }>;
  lsofStatus: number;
  lsofRows: Array<{ command: string; pid: number; cwd: string }>;
}) {
  const fakePs = path.join(options.fakeBinDir, "ps");
  const psOutput = [
    "  PID  PPID ELAPSED COMMAND",
    ...options.processes.map((entry) =>
      `${entry.pid} ${entry.ppid} 00:01 ${entry.command}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakePs,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ command: "ps", args }) + "\\n",
  "utf8"
);
process.stdout.write(${JSON.stringify(psOutput)});
`,
    "utf8"
  );
  fs.chmodSync(fakePs, 0o755);

  const fakeLsof = path.join(options.fakeBinDir, "lsof");
  const lsofOutput = [
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    ...options.lsofRows.map((entry) =>
      `${entry.command} ${entry.pid} me cwd DIR 1,18 64 123 ${entry.cwd}`
    )
  ].join("\n") + "\n";
  fs.writeFileSync(
    fakeLsof,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ command: "lsof", args }) + "\\n",
  "utf8"
);
process.stdout.write(${JSON.stringify(lsofOutput)});
process.exit(${options.lsofStatus});
`,
    "utf8"
  );
  fs.chmodSync(fakeLsof, 0o755);
}

export function writeFakeOpenClaw(fakeBinDir: string, callsPath: string) {
  const fakeOpenClaw = path.join(fakeBinDir, "openclaw");
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n", "utf8");
const gatePath = process.env.AKK_TEST_OPENCLAW_GATE_PATH;
if (gatePath) {
  fs.writeFileSync(gatePath + ".entered", "");
  while (!fs.existsSync(gatePath + ".release")) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

export function writeFakeClaudeAgents(fakeBinDir: string, agents: unknown[]) {
  const fakeClaude = path.join(fakeBinDir, "claude");
  fs.writeFileSync(
    fakeClaude,
    `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(JSON.stringify(agents))});
`,
    "utf8"
  );
  fs.chmodSync(fakeClaude, 0o755);
  return fakeClaude;
}

export function currentClaudeApprovalScreenForTest(command: string): string {
  return [
    " Bash command",
    "",
    `   ${command}`,
    "   Remove the exact handoff fixture",
    "",
    " This command requires approval",
    "",
    " Do you want to proceed?",
    " ❯ 1. Yes",
    "   2. Yes, and don’t ask again for this command",
    "   3. No",
    "",
    " Esc to cancel · Tab to amend · ctrl+e to explain"
  ].join("\n");
}

export function writeAutoApprovingFakeOpenClaw(options: {
  fakeBinDir: string;
  callsPath: string;
  statePath: string;
  cliPath: string;
  claudeHome: string;
  claudeAgents: unknown[];
  policy: unknown;
  screenPath: string;
  transcriptPath: string;
  toolResultAppend: string;
  completionAppend: string;
}): string {
  const fakeOpenClaw = path.join(options.fakeBinDir, "openclaw");
  const cliCoreUrl = new URL(
    "./cli-core.js",
    pathToFileURL(options.cliPath)
  ).href;
  const updaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.toolResultAppend)},
  { mode: 0o600 }
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Claude is working after approval.\\n");
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.completionAppend)},
  { mode: 0o600 }
);
`;
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
class ImportedCliExit extends Error {
  constructor(code) {
    super("CLI requested exit " + code);
    this.code = code;
  }
}
async function runImportedCli(argv) {
  const { executeCliCommand, parseCliCommand } = await import(
    ${JSON.stringify(cliCoreUrl)}
  );
  const { command, options } = parseCliCommand(argv);
  try {
    const result = await executeCliCommand(command, options, {
      env: process.env,
      exit: (code) => { throw new ImportedCliExit(code); }
    });
    return { status: result.exitCode, stdout: result.stdout, stderr: "" };
  } catch (error) {
    if (error instanceof ImportedCliExit) {
      return { status: error.code, stdout: "", stderr: "" };
    }
    return {
      status: 1,
      stdout: "",
      stderr: String(error && error.message || error) + "\\n"
    };
  }
}
async function main() {
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ kind: "gateway", args }) + "\\n",
  "utf8"
);
const paramsIndex = args.indexOf("--params");
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
const message = params.message || {};
if (
  message.metadata &&
  message.metadata.reason === "approval_required"
) {
  if (params.statePath !== ${JSON.stringify(options.statePath)}) {
    process.stderr.write("unexpected callback state path\\n");
    process.exit(2);
  }
  const fingerprint = message.metadata.approval_fingerprint;
  const approved = await runImportedCli([
    "approve",
    "--state",
    params.statePath,
    "--expected-approval-fingerprint",
    fingerprint,
    "--auto-approved",
    "--monitor-poll-interval-ms",
    "50",
    "--auto-approval-policy-json",
    ${JSON.stringify(JSON.stringify(options.policy))},
    "--claude-home",
    ${JSON.stringify(options.claudeHome)},
    "--claude-agents-json",
    ${JSON.stringify(JSON.stringify(options.claudeAgents))}
  ]);
  fs.appendFileSync(
    ${JSON.stringify(options.callsPath)},
    JSON.stringify({
      kind: "nested_approve",
      status: approved.status,
      stdout: approved.stdout,
      stderr: approved.stderr
    }) + "\\n",
    "utf8"
  );
  if (approved.status !== 0) {
    process.stderr.write(approved.stderr || approved.stdout);
    process.exit(approved.status || 2);
  }
  const approval = JSON.parse(approved.stdout);
  if (approval.approved !== true && approval.already_approved !== true) {
    process.stderr.write("nested auto approval was rejected: " + approved.stdout);
    process.exit(2);
  }
  const updater = spawn(
    process.execPath,
    ["-e", ${JSON.stringify(updaterSource)}],
    { detached: true, stdio: "ignore", env: process.env }
  );
  updater.unref();
  process.stdout.write(JSON.stringify({ ok: true, auto_approved: true }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
}
main().catch((error) => {
  process.stderr.write(String(error && error.message || error) + "\\n");
  process.exitCode = 2;
});
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

export function writeSequentialAutoApprovingFakeOpenClaw(options: {
  fakeBinDir: string;
  callsPath: string;
  statePath: string;
  cliPath: string;
  claudeHome: string;
  claudeAgents: unknown[];
  policy: unknown;
  screenPath: string;
  transcriptPath: string;
  firstRequestId: string;
  secondRequestId: string;
  firstSchedulePath: string;
  secondSchedulePath: string;
  promptClearedLogPath: string;
  redrawnFirstScreen: string;
  clearedScreen: string;
  repeatedApprovalScreen: string;
  firstResultAppend: string;
  secondRequestAppend: string;
  secondResultAppend: string;
  completionAppend: string;
}): string {
  const fakeOpenClaw = path.join(options.fakeBinDir, "openclaw");
  const firstUpdaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.redrawnFirstScreen)}
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.firstResultAppend)},
  { mode: 0o600 }
);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.clearedScreen)}
);
const promptClearedDeadline = Date.now() + 5000;
while (
  !(
    fs.existsSync(${JSON.stringify(options.promptClearedLogPath)}) &&
    fs.readFileSync(
      ${JSON.stringify(options.promptClearedLogPath)},
      "utf8"
    ).includes('"event":"terminal_bridge_approval_prompt_cleared"')
  )
) {
  if (Date.now() >= promptClearedDeadline) {
    process.exit(3);
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.secondRequestAppend)},
  { mode: 0o600 }
);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.repeatedApprovalScreen)}
);
`;
  const secondUpdaterSource = `
const fs = require("node:fs");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.secondResultAppend)},
  { mode: 0o600 }
);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
fs.writeFileSync(
  ${JSON.stringify(options.screenPath)},
  ${JSON.stringify(options.clearedScreen)}
);
fs.appendFileSync(
  ${JSON.stringify(options.transcriptPath)},
  ${JSON.stringify(options.completionAppend)},
  { mode: 0o600 }
);
`;
  fs.writeFileSync(
    fakeOpenClaw,
    `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(
  ${JSON.stringify(options.callsPath)},
  JSON.stringify({ kind: "gateway", args }) + "\\n",
  "utf8"
);
const paramsIndex = args.indexOf("--params");
const params = paramsIndex >= 0 ? JSON.parse(args[paramsIndex + 1]) : {};
const message = params.message || {};
if (
  message.metadata &&
  message.metadata.reason === "approval_required"
) {
  if (params.statePath !== ${JSON.stringify(options.statePath)}) {
    process.stderr.write("unexpected callback state path\\n");
    process.exit(2);
  }
  const fingerprint = message.metadata.approval_fingerprint;
  const requestId =
    message.metadata.approval_candidate &&
    message.metadata.approval_candidate.policy_evidence &&
    message.metadata.approval_candidate.policy_evidence.request_id;
  const approved = spawnSync(process.execPath, [
    ${JSON.stringify(options.cliPath)},
    "approve",
    "--state",
    params.statePath,
    "--expected-approval-fingerprint",
    fingerprint,
    "--auto-approved",
    "--monitor-poll-interval-ms",
    "50",
    "--auto-approval-policy-json",
    ${JSON.stringify(JSON.stringify(options.policy))},
    "--claude-home",
    ${JSON.stringify(options.claudeHome)},
    "--claude-agents-json",
    ${JSON.stringify(JSON.stringify(options.claudeAgents))}
  ], {
    encoding: "utf8",
    env: process.env
  });
  fs.appendFileSync(
    ${JSON.stringify(options.callsPath)},
    JSON.stringify({
      kind: "nested_approve",
      request_id: requestId,
      status: approved.status,
      stdout: approved.stdout,
      stderr: approved.stderr
    }) + "\\n",
    "utf8"
  );
  if (approved.status !== 0) {
    process.stderr.write(approved.stderr || approved.stdout);
    process.exit(approved.status || 2);
  }
  const approval = JSON.parse(approved.stdout);
  if (approval.approved !== true && approval.already_approved !== true) {
    process.stderr.write("nested auto approval was rejected: " + approved.stdout);
    process.exit(2);
  }
  const scheduleOnce = (markerPath, source) => {
    try {
      const fd = fs.openSync(markerPath, "wx", 0o600);
      fs.closeSync(fd);
    } catch (error) {
      if (!error || error.code !== "EEXIST") {
        throw error;
      }
      return;
    }
    const updater = spawn(
      process.execPath,
      ["-e", source],
      { detached: true, stdio: "ignore", env: process.env }
    );
    updater.unref();
  };
  if (requestId === ${JSON.stringify(options.firstRequestId)}) {
    scheduleOnce(
      ${JSON.stringify(options.firstSchedulePath)},
      ${JSON.stringify(firstUpdaterSource)}
    );
  } else if (requestId === ${JSON.stringify(options.secondRequestId)}) {
    scheduleOnce(
      ${JSON.stringify(options.secondSchedulePath)},
      ${JSON.stringify(secondUpdaterSource)}
    );
  } else {
    process.stderr.write("unexpected approval request id: " + String(requestId) + "\\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ ok: true, auto_approved: true }) + "\\n");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }) + "\\n");
`,
    "utf8"
  );
  fs.chmodSync(fakeOpenClaw, 0o755);
  return fakeOpenClaw;
}

export function findTerminalDispatchLedgerPath(
  conversationId: string,
  runtimeDir: string
): string {
  const ledgerDir = path.join(
    runtimeDir,
    "terminal-dispatch"
  );
  const match = fs.readdirSync(ledgerDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(ledgerDir, name))
    .find((ledgerPath) => {
      try {
        return JSON.parse(
          fs.readFileSync(ledgerPath, "utf8")
        ).conversation_id === conversationId;
      } catch {
        return false;
      }
    });
  assert.ok(match, `terminal dispatch ledger for ${conversationId}`);
  return match;
}

export function readJsonLines(filePath: string) {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

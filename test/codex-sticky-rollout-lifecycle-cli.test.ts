import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  listManagedSessions,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

test("emitted CLI keeps the tmux/process/sqlite-adapter A -> B -> A contract", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-sticky-bin-"));
  const fakeBinDir = path.join(tempDir, "bin");
  const workspace = path.join(tempDir, "workspace");
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const codexHome = path.join(tempDir, ".codex");
  const sessionsDir = path.join(codexHome, "sessions", "2026", "08", "06");
  const screenPath = path.join(tempDir, "screen.txt");
  const activePath = path.join(tempDir, "active.txt");
  const literalPath = path.join(tempDir, "literal.txt");
  const statusCountPath = path.join(tempDir, "status-count.txt");
  const pendingInputPath = path.join(tempDir, "pending-input.txt");
  const preloadPath = path.join(tempDir, "isolate-tmux-discovery.mjs");
  const threadA = "11111111-1111-4111-8111-111111111111";
  const threadB = "22222222-2222-4222-8222-222222222222";
  const target = "tmux-sticky-bin:0.0";
  const panePid = 74_000;
  const codexPid = 74_001;
  const processBirth = "Thu Aug  6 11:00:00 2026";
  const executable =
    "/opt/akk-test/releases/0.146.0-aarch64-apple-darwin/bin/codex";
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const rolloutPath = path.join(
    sessionsDir,
    `rollout-2026-08-06T00-00-00-${threadA}.jsonl`
  );
  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(screenPath, "Ready\n› ");
    fs.writeFileSync(activePath, threadA);
    fs.writeFileSync(statusCountPath, "0");
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      timestamp: "2026-08-06T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: threadA,
        cwd: workspace,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.140.0"
      }
    })}\n`, { mode: 0o600 });
    const stateDbPath = path.join(codexHome, "state_1.sqlite");
    fs.writeFileSync(stateDbPath, "", { mode: 0o600 });
    const rolloutStat = fs.statSync(rolloutPath);
    fs.writeFileSync(preloadPath, `
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const readDirectory = fs.readdirSync.bind(fs);
fs.readdirSync = (directory, ...args) =>
  directory === "/private/tmp" || directory === "/tmp"
    ? []
    : readDirectory(directory, ...args);
const spawnSync = childProcess.spawnSync.bind(childProcess);
const successful = (stdout) => ({
  pid: process.pid,
  output: [null, stdout, ""],
  stdout,
  stderr: "",
  status: 0,
  signal: null
});
childProcess.spawnSync = (command, args = [], options) => {
  const commandName = String(command).slice(String(command).lastIndexOf("/") + 1);
  if (commandName === "tmux" && args[0] === "list-panes") {
    return successful(${JSON.stringify(
      `tmux-sticky-bin\t0\t0\t${panePid}\tcodex\t${workspace}\t\t%42\n`
    )});
  }
  if (commandName === "tmux" && args[0] === "display-message") {
    return successful("100\\t40\\n");
  }
  if (commandName === "tmux" && args[0] === "capture-pane") {
    return successful(fs.readFileSync(${JSON.stringify(screenPath)}, "utf8"));
  }
  if (commandName === "ps") {
    return successful(args.includes("lstart=")
      ? ${JSON.stringify(`${processBirth}\n`)}
      : ${JSON.stringify(
          "PID PPID ELAPSED COMMAND\n" +
          `${panePid} 1 00:10 zsh\n` +
          `${codexPid} ${panePid} 00:09 ${executable}\n`
        )});
  }
  if (commandName === "lsof") {
    if (args.includes("cwd")) {
      return successful(${JSON.stringify(
        "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\n" +
        `codex ${codexPid} me cwd DIR 1,18 64 123 ${workspace}\n`
      )});
    }
    if (args.includes("txt")) {
      return successful(${JSON.stringify(
        `p${codexPid}\nftxt\nn${executable}\n`
      )});
    }
    return successful(${JSON.stringify(
      `p${codexPid}\nf12u\ntREG\nD${rolloutStat.dev}\n` +
      `i${rolloutStat.ino}\nn${rolloutPath}\n`
    )});
  }
  return spawnSync(command, args, options);
};
process.getuid = undefined;
delete process.env.AKK_TMUX_SOCKET;
delete process.env.TMUX;
syncBuiltinESMExports();
`);
    writeExecutable(path.join(fakeBinDir, "tmux"), `#!/bin/sh
if [ "$1" = "-S" ]; then shift 2; fi
command="$1"
if [ "$command" = "list-panes" ]; then
  printf '%s\\n' ${sh(
    `tmux-sticky-bin\t0\t0\t${panePid}\tcodex\t${workspace}\t\t%42`
  )}
elif [ "$command" = "display-message" ]; then
  printf '100\\t40\\n'
elif [ "$command" = "capture-pane" ]; then
  cat ${sh(screenPath)}
elif [ "$command" = "send-keys" ]; then
  literal=0
  last=""
  for value in "$@"; do
    [ "$value" = "-l" ] && literal=1
    last="$value"
  done
  if [ "$literal" = "1" ]; then
    printf '%s\\n' "$last" >> ${sh(literalPath)}
    printf '%s' "$last" > ${sh(pendingInputPath)}
    if [ "$last" = "/status" ]; then
      printf 'Ready\\n› /status\\n\\n  /status  show current session configuration and token usage\\n' > ${sh(screenPath)}
    else
      printf 'Ready\\n› %s\\n' "$last" > ${sh(screenPath)}
    fi
  elif [ "$last" = "C-m" ] && [ -f ${sh(pendingInputPath)} ]; then
    pending=$(cat ${sh(pendingInputPath)})
    rm ${sh(pendingInputPath)}
    case "$pending" in
      '/status')
        count=$(( $(cat ${sh(statusCountPath)}) + 1 ))
        printf '%s' "$count" > ${sh(statusCountPath)}
        active=$(cat ${sh(activePath)})
        printf '/status\\nprobe-%s\\nSession: %s\\n› ' "$count" "$active" > ${sh(screenPath)}
        ;;
      '/clear')
        printf '%s' ${sh(threadB)} > ${sh(activePath)}
        printf 'Cleared\\n› ' > ${sh(screenPath)}
        ;;
      '/resume '*)
        requested=$(printf '%s' "$pending" | sed 's#^/resume ##')
        printf '%s' "$requested" > ${sh(activePath)}
        printf 'Resumed\\n› ' > ${sh(screenPath)}
        ;;
    esac
  fi
fi
`);
    writeExecutable(path.join(fakeBinDir, "ps"), `#!/bin/sh
case " $* " in
  *' lstart= '*) printf '%s\\n' ${sh(processBirth)} ;;
  *)
    printf 'PID PPID ELAPSED COMMAND\\n'
    printf '%s\\n' ${sh(`${panePid} 1 00:10 zsh`)}
    printf '%s\\n' ${sh(`${codexPid} ${panePid} 00:09 ${executable}`)}
    ;;
esac
`);
    writeExecutable(path.join(fakeBinDir, "lsof"), `#!/bin/sh
case " $* " in
  *' cwd '*)
    printf 'COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n'
    printf '%s\\n' ${sh(`codex ${codexPid} me cwd DIR 1,18 64 123 ${workspace}`)}
    ;;
  *' txt '*) printf 'p%s\\nftxt\\nn%s\\n' ${sh(String(codexPid))} ${sh(executable)} ;;
  *)
    printf 'p%s\\nf12u\\ntREG\\nD%s\\ni%s\\nn%s\\n' \
      ${sh(String(codexPid))} ${sh(String(rolloutStat.dev))} \
      ${sh(String(rolloutStat.ino))} ${sh(rolloutPath)}
    ;;
esac
`);
    writeFakeSqlite({
      fakeBinDir,
      threadId: threadA,
      rolloutPath,
      workspace
    });

    const terminalControl: TerminalControlRef = {
      kind: "tmux",
      target,
      session: "tmux-sticky-bin",
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
    ensureStoreWritable(storeDir);
    const now = new Date("2026-08-06T03:00:00.000Z");
    const source = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-sticky-bin-a",
      agent: "codex",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: codexPid,
        nativeThreadId: threadA,
        processUuid: `codex-pid:${codexPid}:birth:${processBirth}`,
        processBirth,
        rollout: {
          fd: "12u",
          device: String(rolloutStat.dev),
          inode: String(rolloutStat.ino),
          path: fs.realpathSync(rolloutPath)
        },
        evidence: "codex_rollout_fd",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      NODE_OPTIONS: [
        process.env.NODE_OPTIONS,
        `--import=${pathToFileURL(preloadPath).href}`
      ].filter(Boolean).join(" ")
    };
    const common = ["--store-dir", storeDir, "--codex-home", codexHome];
    const created = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      managedSessionBindingToken(source),
      ...common
    ], env);
    assert.equal(created.status, 0, created.stderr || created.stdout);
    assert.equal(JSON.parse(created.stdout).native_thread_id, threadB);
    assert.equal(listConversations(storeDir).length, 0);

    const choices = runCli([
      "list-resumable-threads",
      "--terminal",
      terminalId,
      ...common
    ], env);
    assert.equal(choices.status, 0, choices.stderr || choices.stdout);
    const previous = JSON.parse(choices.stdout).previous;
    assert.equal(previous.native_thread_id, threadA);
    const args = previous.available_actions.resume_thread.arguments;
    const resumed = runCli([
      "resume-thread",
      "--terminal",
      args.terminal_id,
      "--native-thread",
      args.native_thread_id,
      "--expected-binding-token",
      args.expected_binding_token,
      "--candidate-token",
      args.candidate_token,
      ...common
    ], env);
    assert.equal(resumed.status, 0, resumed.stderr || resumed.stdout);
    assert.equal(JSON.parse(resumed.stdout).native_thread_id, threadA);
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(
      listManagedSessions(storeDir).find((entry) => entry.status === "bound")
        ?.binding?.native_thread_id,
      threadA
    );
    const literals = fs.readFileSync(literalPath, "utf8")
      .trim()
      .split(/\r?\n/u);
    assert.deepEqual(
      literals.filter((text) => text !== "/status"),
      ["/clear", `/resume ${threadA}`]
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [new URL("../src/cli.js", import.meta.url).pathname, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
}

function writeExecutable(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o755 });
}

function sh(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeFakeSqlite(options: {
  fakeBinDir: string;
  threadId: string;
  rolloutPath: string;
  workspace: string;
}): void {
  const columns = [
    "id",
    "cwd",
    "rollout_path",
    "updated_at_ms",
    "archived",
    "source",
    "cli_version"
  ].map((name) => ({ name }));
  const rows = [{
    id: options.threadId,
    cwd: options.workspace,
    rollout_path: options.rolloutPath,
    updated_at_ms: 1_786_000_000_000,
    archived: 0,
    source: "cli",
    cli_version: "0.140.0"
  }];
  writeExecutable(path.join(options.fakeBinDir, "sqlite3"), `#!/usr/bin/env node
const rows = ${JSON.stringify(rows)};
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\\n")) >= 0) {
    const sql = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (!sql || sql === "BEGIN;" || sql === "COMMIT;" || sql === ".quit") {
      continue;
    }
    if (sql === "pragma table_info(threads);") {
      process.stdout.write(${JSON.stringify(JSON.stringify(columns) + "\n")});
      continue;
    }
    const control = /^select '([^']+)' as "__akk_sqlite_control";$/u.exec(sql);
    if (control) {
      process.stdout.write(JSON.stringify([{
        __akk_sqlite_control: control[1]
      }]) + "\\n");
      continue;
    }
    if (sql.startsWith("select id")) {
      const exact = /where id = '([0-9a-f-]+)'/u.exec(sql)?.[1];
      process.stdout.write(JSON.stringify(
        exact ? rows.filter((row) => row.id === exact) : rows
      ) + "\\n");
    }
  }
});
process.stdin.resume();
`);
}

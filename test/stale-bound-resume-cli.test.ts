import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir,
  pathsForManagedSession,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("resume lists a conclusively dead bound Session read-only, then CAS-detaches it before prepared input", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-stale-bound-resume-")
  );
  const fakeBinDir = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const claudeHome = path.join(root, ".claude");
  const tmuxCallsPath = path.join(root, "tmux-calls.ndjson");
  const target = "stale-bound-resume:0.0";
  const panePid = 76_100;
  const claudePid = 76_001;
  // Above the platform PID range in supported environments, but still a valid
  // positive pid_t value for process.kill(pid, 0).
  const stalePid = 9_000_001;
  const startedAt = 1_786_000_000_001;
  const currentNativeThreadId =
    "11111111-1111-4111-8111-111111111111";
  const resumeNativeThreadId =
    "22222222-2222-4222-8222-222222222222";
  const terminalId = `terminal:v2:tmux:claude:${target}:${claudePid}`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    writeFakeTmux({
      fakeBinDir,
      callsPath: tmuxCallsPath,
      target,
      panePid,
      workspace
    });
    writeFakeProcessTools({
      fakeBinDir,
      panePid,
      claudePid,
      workspace
    });
    const resumeTranscriptPath = writeClaudeTranscript({
      claudeHome,
      workspace,
      nativeThreadId: resumeNativeThreadId
    });

    assert.throws(
      () => process.kill(stalePid, 0),
      (error: NodeJS.ErrnoException) => error.code === "ESRCH"
    );

    const terminalControl: TerminalControlRef = {
      kind: "tmux",
      target,
      session: "stale-bound-resume",
      window: 0,
      pane: 0,
      panePid,
      currentCommand: "claude",
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
    const staleTerminalControl: TerminalControlRef = {
      ...terminalControl,
      target: "closed-claude-pane:0.0",
      session: "closed-claude-pane",
      panePid: 76_900
    };
    const now = new Date("2026-08-06T06:00:00.000Z");
    ensureStoreWritable(storeDir);
    const source = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-current-claude-thread",
      agent: "claude",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: claudePid,
        nativeThreadId: currentNativeThreadId,
        processUuid: `claude-pid:${claudePid}:started:${startedAt}`,
        evidence: "claude_agents_exact_pid",
        generation: 1,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });
    const staleTarget = saveManagedSession(storeDir, {
      schema: "agent-knock-knock/session",
      version: 1,
      session_id: "session-stale-bound-resume-target",
      agent: "claude",
      workspace,
      status: "bound",
      binding: terminalBindingFrom({
        terminalId:
          `terminal:v2:tmux:claude:${staleTerminalControl.target}:${stalePid}`,
        terminalControl: staleTerminalControl,
        pid: stalePid,
        nativeThreadId: resumeNativeThreadId,
        processUuid: `claude-pid:${stalePid}:started:1785000000000`,
        evidence: "claude_agents_exact_pid",
        generation: 3,
        now
      }),
      lineage: { created_by: "attach" },
      created_at: now.toISOString(),
      updated_at: now.toISOString()
    }, { expectedRevision: null });

    const commonArgs = [
      "--store-dir",
      storeDir,
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([{
        pid: claudePid,
        cwd: workspace,
        kind: "interactive",
        sessionId: currentNativeThreadId,
        startedAt,
        status: "idle"
      }]),
      "--agent-versions-json",
      JSON.stringify({ claude: "2.1.218" })
    ];
    const environment = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      // Avoid allowing a developer's real tmux socket to affect this fixture.
      TMUX: ""
    };
    const sourceStatePath = pathsForManagedSession(
      source.session_id,
      storeDir
    ).statePath;
    const targetStatePath = pathsForManagedSession(
      staleTarget.session_id,
      storeDir
    ).statePath;
    const sourceBeforeList = fs.readFileSync(sourceStatePath, "utf8");
    const targetBeforeList = fs.readFileSync(targetStatePath, "utf8");

    const listed = runCli([
      "list-resumable-threads",
      "--terminal",
      terminalId,
      ...commonArgs
    ], environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listOutput = JSON.parse(listed.stdout);
    assert.equal(listOutput.current_session_id, source.session_id);
    assert.equal(
      listOutput.expected_binding_token,
      managedSessionBindingToken(source)
    );
    const candidate = listOutput.threads.find(
      (entry: Record<string, unknown>) =>
        entry.native_thread_id === resumeNativeThreadId
    );
    assert.ok(candidate, listed.stdout);
    assert.equal(candidate.managed_session_id, staleTarget.session_id);
    assert.equal(candidate.resumable, true);
    assert.equal(candidate.unavailable_reason, undefined);
    assert.equal(typeof candidate.candidate_token, "string");
    assert.equal(
      candidate.available_actions.resume_thread.arguments.candidate_token,
      candidate.candidate_token
    );

    // Discovery is strictly read-only: even a conclusively dead binding is
    // still authoritative until a resume mutation performs its CAS update.
    assert.equal(fs.readFileSync(sourceStatePath, "utf8"), sourceBeforeList);
    assert.equal(fs.readFileSync(targetStatePath, "utf8"), targetBeforeList);
    assert.equal(
      listManagedSessions(storeDir).find((entry) =>
        entry.session_id === staleTarget.session_id
      )?.status,
      "bound"
    );
    assert.equal(listConversations(storeDir).length, 0);
    assert.equal(listOutput.previous, undefined);

    const snapshotPath = findResumeSnapshot(
      runtimeDir,
      listOutput.selection_snapshot.snapshot_id
    );
    const originalSnapshot = fs.readFileSync(snapshotPath, "utf8");
    const terminalInputsBeforeSnapshotFailures = readTmuxCalls(
      tmuxCallsPath
    ).filter((call) =>
      call.args.includes("send-keys") || call.args.includes("paste-buffer")
    ).length;

    const wrongScope = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-snapshot",
      listOutput.selection_snapshot.snapshot_id,
      "--selection-number",
      String(candidate.selection_number),
      "--selection-scope",
      "openclaw:another-session",
      ...commonArgs
    ], environment);
    assert.equal(wrongScope.status, 1);
    assert.match(wrongScope.stderr, /another terminal or OpenClaw session/u);

    const expiredSnapshot = JSON.parse(originalSnapshot);
    const expiredAt = Date.now();
    expiredSnapshot.created_at = new Date(expiredAt - 600_000).toISOString();
    expiredSnapshot.expires_at = new Date(expiredAt - 300_000).toISOString();
    fs.writeFileSync(
      snapshotPath,
      `${JSON.stringify(expiredSnapshot, null, 2)}\n`,
      "utf8"
    );
    const expired = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-handle",
      candidate.selection_handle,
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], environment);
    assert.equal(expired.status, 1);
    assert.match(expired.stderr, /snapshot expired/u);
    fs.writeFileSync(snapshotPath, originalSnapshot, "utf8");

    const differentPaneSnapshot = JSON.parse(originalSnapshot);
    differentPaneSnapshot.terminal_control.pane_pid = panePid + 1;
    differentPaneSnapshot.terminal_endpoint.process_anchor_pid = panePid + 1;
    differentPaneSnapshot.terminal_endpoint.pane_pid = panePid + 1;
    differentPaneSnapshot.terminal_endpoint.resource_key =
      `legacy:${differentPaneSnapshot.terminal_endpoint.route_key}:pane-pid:${panePid + 1}`;
    for (const changedSnapshot of [
      differentPaneSnapshot,
      {
        ...JSON.parse(originalSnapshot),
        workspace: path.join(root, "different-workspace")
      }
    ]) {
      fs.writeFileSync(
        snapshotPath,
        `${JSON.stringify(changedSnapshot, null, 2)}\n`,
        "utf8"
      );
      const terminalChanged = runCli([
        "resume-thread",
        "--terminal",
        terminalId,
        "--selection-handle",
        candidate.selection_handle,
        "--selection-scope",
        "cli:unscoped",
        ...commonArgs
      ], environment);
      assert.equal(terminalChanged.status, 1);
      assert.match(
        terminalChanged.stderr,
        /terminal, process, or workspace changed/u
      );
    }
    fs.writeFileSync(snapshotPath, originalSnapshot, "utf8");

    const changedBinding = JSON.parse(sourceBeforeList);
    changedBinding.binding.generation += 1;
    fs.writeFileSync(
      sourceStatePath,
      `${JSON.stringify(changedBinding, null, 2)}\n`,
      "utf8"
    );
    const bindingChanged = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-handle",
      candidate.selection_handle,
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], environment);
    assert.equal(bindingChanged.status, 1);
    assert.match(bindingChanged.stderr, /binding changed/u);
    fs.writeFileSync(sourceStatePath, sourceBeforeList, "utf8");

    assert.equal(
      readTmuxCalls(tmuxCallsPath).filter((call) =>
        call.args.includes("send-keys") || call.args.includes("paste-buffer")
      ).length,
      terminalInputsBeforeSnapshotFailures,
      "stale snapshot failures must happen before terminal input"
    );
    assert.equal(listConversations(storeDir).length, 0);

    const missingSelectionNumber = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-snapshot",
      listOutput.selection_snapshot.snapshot_id,
      "--selection-number",
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], environment);
    assert.equal(missingSelectionNumber.status, 1);
    assert.match(missingSelectionNumber.stderr, /positive integer/u);

    const ledgerKey = createHash("sha256")
      .update(JSON.stringify({ target, socket_path: null }))
      .digest("hex")
      .slice(0, 20);
    const ledgerDir = path.join(runtimeDir, "terminal-dispatch");
    const ledgerPath = path.join(
      ledgerDir,
      `terminal-dispatch-${ledgerKey}.json`
    );
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      terminal_key: ledgerKey,
      status: "resolved",
      generation_id: "message-after-snapshot",
      message_id: "message-after-snapshot",
      terminal_control: {
        kind: "tmux",
        target,
        socket_path: null,
        pane_pid: panePid,
        current_path: workspace
      }
    }));
    const invalidated = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-snapshot",
      listOutput.selection_snapshot.snapshot_id,
      "--selection-number",
      String(candidate.selection_number),
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], environment);
    assert.equal(invalidated.status, 1);
    assert.match(invalidated.stderr, /terminal action history changed/u);
    fs.rmSync(ledgerPath);

    const originalTranscript = fs.readFileSync(resumeTranscriptPath, "utf8");
    fs.appendFileSync(resumeTranscriptPath, `${JSON.stringify({
      type: "assistant",
      uuid: "44444444-4444-4444-8444-444444444444",
      parentUuid: "33333333-3333-4333-8333-333333333333",
      sessionId: resumeNativeThreadId,
      cwd: workspace,
      version: "2.1.218",
      message: { role: "assistant", content: "Changed after listing" }
    })}\n`);
    const changedCandidate = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-snapshot",
      listOutput.selection_snapshot.snapshot_id,
      "--selection-short-id",
      candidate.short_id,
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], environment);
    assert.equal(changedCandidate.status, 1);
    assert.match(changedCandidate.stderr, /candidates changed or reordered/u);
    assert.equal(
      readTmuxCalls(tmuxCallsPath).some((call) =>
        call.args.includes(`/resume ${resumeNativeThreadId}`)
      ),
      false
    );
    fs.writeFileSync(resumeTranscriptPath, originalTranscript, "utf8");

    const relisted = runCli([
      "list-resumable-threads",
      "--terminal",
      terminalId,
      ...commonArgs
    ], environment);
    assert.equal(relisted.status, 0, relisted.stderr || relisted.stdout);
    const relistedOutput = JSON.parse(relisted.stdout);
    const relistedCandidate = relistedOutput.threads.find(
      (entry: Record<string, unknown>) =>
        entry.native_thread_id === resumeNativeThreadId
    );
    assert.ok(relistedCandidate);

    const resumed = runCli([
      "resume-thread",
      "--terminal",
      terminalId,
      "--selection-handle",
      relistedCandidate.selection_handle,
      "--selection-scope",
      "cli:unscoped",
      ...commonArgs
    ], {
      ...environment,
      AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
    });
    assert.equal(
      resumed.status,
      86,
      resumed.stderr || resumed.stdout
    );

    const sessionsAfterCrash = listManagedSessions(storeDir);
    const sourceAfterCrash = sessionsAfterCrash.find((entry) =>
      entry.session_id === source.session_id
    );
    const targetAfterCrash = sessionsAfterCrash.find((entry) =>
      entry.session_id === staleTarget.session_id
    );
    assert.equal(sourceAfterCrash?.status, "bound");
    // The first exclusive lifecycle mutation is also the compatibility
    // upgrade point for a legacy binding. It may persist the freshly resolved
    // canonical endpoint, but must not change the logical owner/generation.
    assert.equal(
      sourceAfterCrash?.revision,
      (source.revision as number) + 1
    );
    assert.equal(
      sourceAfterCrash?.binding?.binding_id,
      source.binding?.binding_id
    );
    assert.equal(
      sourceAfterCrash?.binding?.generation,
      source.binding?.generation
    );
    assert.equal(
      sourceAfterCrash?.binding?.native_thread_id,
      source.binding?.native_thread_id
    );
    assert.equal(
      sourceAfterCrash?.binding?.terminal_endpoint?.kind,
      "tmux"
    );
    assert.equal(targetAfterCrash?.status, "detached");
    assert.equal(
      targetAfterCrash?.revision,
      (staleTarget.revision as number) + 1
    );
    assert.deepEqual(
      targetAfterCrash?.binding,
      JSON.parse(JSON.stringify(staleTarget.binding))
    );
    assert.match(targetAfterCrash?.detached_at ?? "", /^\d{4}-\d{2}-\d{2}T/u);

    const transitionIds = fs.readdirSync(
      nativeThreadTransitionsDir(storeDir),
      { withFileTypes: true }
    ).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.equal(transitionIds.length, 1);
    const transition = loadNativeThreadTransition(
      storeDir,
      transitionIds[0]
    );
    assert.equal(transition.status, "prepared");
    assert.equal(transition.operation, "resume_thread");
    assert.equal(transition.source_session_id, source.session_id);
    assert.equal(transition.target_session_id, staleTarget.session_id);
    assert.equal(
      transition.target_native_thread_id,
      resumeNativeThreadId
    );
    assert.equal(
      transition.target_expected_revision,
      targetAfterCrash?.revision
    );

    // The prepared crash hook runs at the last durable boundary before
    // terminal dispatch. No /resume text or Enter may have reached tmux, and
    // lifecycle operations must not create an ordinary Turn.
    assert.equal(
      readTmuxCalls(tmuxCallsPath).some((call) =>
        call.args.includes("send-keys") ||
        call.args.includes("paste-buffer")
      ),
      false
    );
    assert.equal(listConversations(storeDir).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("live-gate New requires a persisted unmanaged Claude origin before preparing input", () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-claude-restorable-origin-")
  );
  const fakeBinDir = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const claudeHome = path.join(root, ".claude");
  const tmuxCallsPath = path.join(root, "tmux-calls.ndjson");
  const target = "stale-bound-resume:0.0";
  const panePid = 76_200;
  const claudePid = 76_201;
  const startedAt = 1_786_000_000_002;
  const nativeThreadId = "44444444-4444-4444-8444-444444444444";
  const terminalId = `terminal:v2:tmux:claude:${target}:${claudePid}`;

  try {
    fs.mkdirSync(fakeBinDir, { recursive: true });
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(claudeHome, { recursive: true, mode: 0o700 });
    writeFakeTmux({
      fakeBinDir,
      callsPath: tmuxCallsPath,
      target,
      panePid,
      workspace
    });
    writeFakeProcessTools({
      fakeBinDir,
      panePid,
      claudePid,
      workspace
    });

    const commonArgs = [
      "--store-dir",
      storeDir,
      "--claude-home",
      claudeHome,
      "--claude-agents-json",
      JSON.stringify([{
        pid: claudePid,
        cwd: workspace,
        kind: "interactive",
        sessionId: nativeThreadId,
        startedAt,
        status: "idle"
      }]),
      "--agent-versions-json",
      JSON.stringify({ claude: "2.1.218" })
    ];
    const environment = {
      ...process.env,
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
      AKK_RUNTIME_DIR: runtimeDir,
      TMUX: ""
    };
    const listed = runCli([
      "list",
      "--all",
      "--terminal-debug",
      "--no-approval-scan",
      ...commonArgs
    ], environment);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const terminal = JSON.parse(listed.stdout).terminals.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(terminal, listed.stdout);
    assert.equal(terminal.management_state, "unmanaged");
    assert.equal(typeof terminal.lifecycle_binding_token, "string");

    const rejected = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      terminal.lifecycle_binding_token,
      "--require-restorable-origin",
      ...commonArgs
    ], environment);
    assert.equal(rejected.status, 1, rejected.stdout);
    assert.match(
      rejected.stderr,
      /--require-restorable-origin could not prove that the current native thread is a unique persisted resume candidate/u
    );
    assert.equal(
      readTmuxCalls(tmuxCallsPath).some((call) =>
        call.args.includes("send-keys") || call.args.includes("paste-buffer")
      ),
      false
    );
    const transitionsDir = nativeThreadTransitionsDir(storeDir);
    assert.equal(
      fs.existsSync(transitionsDir)
        ? fs.readdirSync(transitionsDir).length
        : 0,
      0
    );
    assert.equal(listManagedSessions(storeDir).length, 0);
    assert.equal(listConversations(storeDir).length, 0);

    writeClaudeTranscript({
      claudeHome,
      workspace,
      nativeThreadId
    });
    const prepared = runCli([
      "new-thread",
      "--terminal",
      terminalId,
      "--expected-binding-token",
      terminal.lifecycle_binding_token,
      "--require-restorable-origin",
      ...commonArgs
    ], {
      ...environment,
      AKK_TEST_EXIT_AFTER_LIFECYCLE_PREPARED: "1"
    });
    assert.equal(prepared.status, 86, prepared.stderr || prepared.stdout);

    const transitionIds = fs.readdirSync(transitionsDir, {
      withFileTypes: true
    }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    assert.equal(transitionIds.length, 1);
    const transition = loadNativeThreadTransition(
      storeDir,
      transitionIds[0]
    );
    assert.equal(transition.status, "prepared");
    assert.equal(transition.operation, "new_thread");
    assert.equal(transition.source_session_id, undefined);
    assert.equal(transition.before_native_thread_id, nativeThreadId);
    assert.equal(
      readTmuxCalls(tmuxCallsPath).some((call) =>
        call.args.includes("send-keys") || call.args.includes("paste-buffer")
      ),
      false
    );
    assert.equal(listManagedSessions(storeDir).length, 0);
    assert.equal(listConversations(storeDir).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env,
    timeout: 30_000
  });
}

function findResumeSnapshot(runtimeDir: string, snapshotId: string): string {
  const root = path.join(runtimeDir, "resume-snapshots");
  const storeKey = fs.readdirSync(root)[0];
  return path.join(root, storeKey, `${snapshotId}.json`);
}

function writeFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  target: string;
  panePid: number;
  workspace: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
const offset = args[0] === "-S" ? 2 : 0;
if (args[offset] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `stale-bound-resume\t0\t0\t${options.panePid}\tclaude\t${options.workspace}\n`
  )});
  process.exit(0);
}
if (args[offset] === "capture-pane") {
  process.stdout.write("Ready\\n❯ ");
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
}

function writeFakeProcessTools(options: {
  fakeBinDir: string;
  panePid: number;
  claudePid: number;
  workspace: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "ps"), `#!/usr/bin/env node
process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
  ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
  ${JSON.stringify(`${options.claudePid} ${options.panePid} 00:09 claude\n`)});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(options.fakeBinDir, "lsof"), `#!/usr/bin/env node
process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
  ${JSON.stringify(
    `claude ${options.claudePid} me cwd DIR 1,18 64 123 ${options.workspace}\n`
  )});
`, { mode: 0o755 });
}

function writeClaudeTranscript(options: {
  claudeHome: string;
  workspace: string;
  nativeThreadId: string;
}): string {
  const projectDirectory = path.join(
    options.claudeHome,
    "projects",
    options.workspace.replace(/[^A-Za-z0-9]/gu, "-")
  );
  fs.mkdirSync(projectDirectory, { recursive: true, mode: 0o700 });
  const transcriptPath = path.join(
    projectDirectory,
    `${options.nativeThreadId}.jsonl`
  );
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      uuid: "33333333-3333-4333-8333-333333333333",
      parentUuid: null,
      sessionId: options.nativeThreadId,
      cwd: options.workspace,
      version: "2.1.218",
      isSidechain: false,
      entrypoint: "cli",
      message: { role: "user", content: "Historical task" }
    })}\n`,
    { mode: 0o600 }
  );
  return transcriptPath;
}

function readTmuxCalls(filePath: string): Array<{ args: string[] }> {
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  TerminalWatchConflictError,
  activeTaskAnchorForTerminalWatch,
  assertTerminalWatch,
  claudeActiveTaskAnchorForTerminalWatch,
  createTerminalWatchStore,
  listTerminalWatches,
  loadTerminalWatch,
  pathsForTerminalWatch,
  saveTerminalWatch,
  terminalWatchRevision,
  type ClaudeTerminalWatchAnchor,
  type CodexTerminalWatchAnchor,
  type TerminalWatch,
  type TerminalWatchTerminalIdentity
} from "../src/terminal-watch-store.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const PROMPT_ID = "33333333-3333-4333-8333-333333333333";
const CREATED_AT = "2026-08-21T00:00:00.000Z";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function terminal(
  agent: "codex" | "claude" = "codex"
): TerminalWatchTerminalIdentity {
  const endpoint = terminalControlEvidence({
    kind: "herdr",
    target: "workspace-1/tab-1/pane-1",
    socketPath: "/tmp/herdr-test.sock",
    session: "herdr-session",
    panePid: 700,
    currentCommand: agent,
    currentPath: "/workspace/project",
    capabilities: ["screen_status", "durable_completion"],
    sessionDir: "/tmp/herdr-session",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "terminal-resource-1"
  });
  return {
    terminal_id: "terminal:v2:fixture",
    terminal_endpoint: endpoint,
    agent_pid: 701,
    process_uuid: `${agent}-process-uuid`,
    process_birth: `${agent}-process-birth`,
    ...(agent === "claude" ? { process_started_at_ms: 1_777_000_000_000 } : {}),
    native_thread_id: THREAD_ID,
    workspace: "/workspace/project",
    binding_token: SHA_A,
    agent_version: agent === "codex" ? "0.148.0" : "2.1.237",
    behavior_profile: agent === "codex"
      ? "codex-0.148.0-exact"
      : "claude-2.1.237-exact"
  };
}

function codexAnchor(
  identity: TerminalWatchTerminalIdentity = terminal()
): CodexTerminalWatchAnchor {
  const rollout = {
    fd: "7",
    device: "12",
    inode: "34",
    path: "/workspace/project/rollout.jsonl"
  };
  const base = {
    schema: "agent-knock-knock/codex-human-started-active-task-anchor",
    version: 1,
    native_thread_id: identity.native_thread_id,
    process_uuid: identity.process_uuid,
    process_birth: identity.process_birth,
    captured_at: CREATED_AT,
    rollout,
    turn_id: TASK_ID,
    request_hash: SHA_B,
    codex_version: identity.agent_version,
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30
  };
  return {
    kind: "codex_rollout",
    native_task_id: TASK_ID,
    captured_at: CREATED_AT,
    request_hash: SHA_B,
    codex_version: identity.agent_version,
    rollout,
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30,
    evidence_fingerprint: digest(base)
  };
}

function watch(watchId = "terminal-watch-store-fixture"): TerminalWatch {
  const identity = terminal();
  return {
    schema: TERMINAL_WATCH_SCHEMA,
    version: TERMINAL_WATCH_VERSION,
    watch_id: watchId,
    agent: "codex",
    terminal: identity,
    anchor: codexAnchor(identity),
    openclaw_session: "openclaw-session-1",
    openclaw_bin: "/usr/local/bin/openclaw",
    created_at: CREATED_AT,
    deadline_at: "2026-08-21T01:00:00.000Z",
    updated_at: CREATED_AT,
    status: "active",
    last_activity_at: "2026-08-20T23:59:59.000Z",
    notification_outbox: []
  };
}

function tempStore(t: test.TestContext): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-watch-store-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return path.join(directory, "store");
}

test("terminal Watch Store persists private atomic records and lists them", (t) => {
  const storeDir = tempStore(t);
  const saved = saveTerminalWatch(storeDir, watch(), { expectedRevision: null });
  assert.equal(saved.revision, 1);
  assert.deepEqual(loadTerminalWatch(storeDir, saved.watch_id), saved);
  assert.deepEqual(listTerminalWatches(storeDir), [saved]);

  const paths = pathsForTerminalWatch(saved.watch_id, storeDir);
  assert.equal(fs.statSync(paths.root).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.statePath).mode & 0o777, 0o600);
  assert.equal(
    activeTaskAnchorForTerminalWatch(saved).anchor_fingerprint,
    saved.anchor.evidence_fingerprint
  );
});

test("terminal Watch listing ignores only exact owner-private atomic temporaries", (t) => {
  const storeDir = tempStore(t);
  const saved = saveTerminalWatch(storeDir, watch(), { expectedRevision: null });
  const root = pathsForTerminalWatch(saved.watch_id, storeDir).root;
  const temporaryPath = path.join(
    root,
    `.${saved.watch_id}.json.123.00000000-0000-4000-8000-000000000206.tmp`
  );
  fs.writeFileSync(temporaryPath, "partial", { mode: 0o600 });
  assert.deepEqual(listTerminalWatches(storeDir), [saved]);
  fs.chmodSync(temporaryPath, 0o644);
  assert.throws(
    () => listTerminalWatches(storeDir),
    /owner-private 0600/u
  );
});

test("terminal Watch Store enforces compare-and-swap revisions", (t) => {
  const storeDir = tempStore(t);
  const first = saveTerminalWatch(storeDir, watch(), { expectedRevision: null });
  const second = saveTerminalWatch(storeDir, {
    ...first,
    updated_at: "2026-08-21T00:00:01.000Z",
    last_activity_at: "2026-08-21T00:00:01.000Z"
  }, { expectedRevision: terminalWatchRevision(first) });
  assert.equal(second.revision, 2);
  assert.throws(
    () => saveTerminalWatch(storeDir, {
      ...first,
      updated_at: "2026-08-21T00:00:02.000Z",
      last_activity_at: "2026-08-21T00:00:02.000Z"
    }, { expectedRevision: 1 }),
    (error) => error instanceof TerminalWatchConflictError &&
      error.actualRevision === 2
  );
});

test("terminal Watch Store validates every listed record and unknown root entry", (t) => {
  const storeDir = tempStore(t);
  const saved = saveTerminalWatch(storeDir, watch(), { expectedRevision: null });
  const paths = pathsForTerminalWatch(saved.watch_id, storeDir);
  fs.writeFileSync(
    paths.statePath,
    `${JSON.stringify({ ...saved, raw_prompt: "must-not-persist" })}\n`,
    { mode: 0o600 }
  );
  assert.throws(
    () => loadTerminalWatch(storeDir, saved.watch_id),
    /unsupported field raw_prompt/u
  );

  fs.writeFileSync(paths.statePath, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.root, "unknown.txt"), "unknown\n", {
    mode: 0o600
  });
  assert.throws(() => listTerminalWatches(storeDir), /unknown file/u);
});

test("terminal Watch Store exposes writer-before-watch lock transactions", (t) => {
  const storeDir = tempStore(t);
  const events: string[] = [];
  const repository = createTerminalWatchStore(storeDir, {
    acquire(lockPath) {
      assert.equal(fs.existsSync(path.join(storeDir, "manifest.json")), true);
      assert.equal(fs.existsSync(path.dirname(lockPath)), true);
      events.push(`acquire:${path.basename(lockPath)}`);
      return () => events.push(`release:${path.basename(lockPath)}`);
    }
  });
  repository.withWatchLock("terminal-watch-lock-fixture", () => {
    events.push("operation");
    assert.deepEqual(repository.list(), []);
  });
  assert.deepEqual(events, [
    "acquire:terminal-watch-lock-fixture.json.lock",
    "operation",
    "release:terminal-watch-lock-fixture.json.lock"
  ]);
});

test("Claude terminal Watch anchor round-trips the exact provider anchor", () => {
  const identity = terminal("claude");
  const transcript = {
    relative_path: `${THREAD_ID}.jsonl`,
    device: "56",
    inode: "78"
  };
  const transcriptFileId = createHash("sha256")
    .update(`${THREAD_ID}\0${transcript.device}:${transcript.inode}`)
    .digest("hex")
    .slice(0, 24);
  const base = {
    schema: "agent-knock-knock/claude-human-started-active-task-anchor",
    version: 1,
    session_id: THREAD_ID,
    cwd: identity.workspace,
    pid: identity.agent_pid,
    agent_started_at_ms: identity.process_started_at_ms!,
    captured_at: CREATED_AT,
    relative_path: transcript.relative_path,
    device: transcript.device,
    inode: transcript.inode,
    prompt_uuid: PROMPT_ID,
    request_hash: SHA_B,
    claude_version: "2.1.237",
    transcript_file_id: transcriptFileId,
    turn_start_offset_bytes: 15,
    observed_end_offset_bytes: 40
  };
  const anchor: ClaudeTerminalWatchAnchor = {
    kind: "claude_transcript",
    root_prompt_uuid: PROMPT_ID,
    captured_at: CREATED_AT,
    request_hash: SHA_B,
    claude_version: "2.1.237",
    transcript_file_id: transcriptFileId,
    turn_start_offset_bytes: 15,
    transcript,
    observed_end_offset_bytes: 40,
    evidence_fingerprint: digest(base)
  };
  const value: TerminalWatch = {
    ...watch("terminal-watch-claude-fixture"),
    agent: "claude",
    terminal: identity,
    anchor
  };
  assert.doesNotThrow(() =>
    assertTerminalWatch(value, value.watch_id, { allowMissingRevision: true })
  );
  assert.deepEqual(claudeActiveTaskAnchorForTerminalWatch(value), {
    ...base,
    anchor_fingerprint: anchor.evidence_fingerprint
  });
});

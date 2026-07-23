import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConversation } from "../src/protocol.js";
import {
  appendEvent,
  assertAppendableEventLog,
  defaultStoreDir,
  loadState,
  logPathForStatePath,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  statePathForConversationId
} from "../src/store.js";

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function storedConversation(storeDir: string, conversationId = "task-1") {
  const paths = pathsForConversation(conversationId, storeDir);
  const conversation = {
    ...createConversation({
      userRequest: "secure the store",
      now: new Date("2026-07-23T00:00:00.000Z")
    }),
    conversation_id: conversationId,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  return { conversation, paths };
}

test("defaults store under user home .agent-knock-knock conversations", () => {
  assert.equal(
    defaultStoreDir("/workspace/project"),
    path.join(os.homedir(), ".agent-knock-knock", "conversations")
  );
});

test("appendEvent refuses to append to a corrupted event log", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const logPath = path.join(dir, "events.ndjson");

  try {
    fs.writeFileSync(logPath, JSON.stringify({ event: "conversation_created" }, null, 2), "utf8");

    assert.throws(
      () => appendEvent(logPath, { event: "message", conversation_id: "task-1" }),
      /event log is not valid NDJSON at line 1/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("appendEvent completes a valid final line before appending", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const logPath = path.join(dir, "events.ndjson");

  try {
    fs.writeFileSync(logPath, '{"event":"conversation_created"}', "utf8");
    appendEvent(logPath, { event: "message", conversation_id: "task-1" });

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).event), [
      "conversation_created",
      "message"
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("assertAppendableEventLog accepts valid NDJSON events", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const logPath = path.join(dir, "events.ndjson");

  try {
    fs.writeFileSync(logPath, '{"event":"conversation_created"}\n{"event":"message"}\n', "utf8");
    assert.equal(assertAppendableEventLog(logPath), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("uses one directory per conversation", () => {
  const paths = pathsForConversation("task-1", "/workspace/project/.agent-knock-knock/conversations");

  assert.equal(paths.conversationDir, path.join("/workspace/project/.agent-knock-knock/conversations", "task-1"));
  assert.equal(paths.statePath, path.join(paths.conversationDir, "state.json"));
  assert.equal(paths.logPath, path.join(paths.conversationDir, "events.ndjson"));
});

test("rejects conversation ids that are not a single contained basename", () => {
  const storeDir = "/workspace/project/.agent-knock-knock/conversations";
  for (const conversationId of [
    "",
    ".",
    "..",
    "../escape",
    "nested/task-1",
    "nested\\task-1",
    "/tmp/task-1",
    "C:\\temp\\task-1"
  ]) {
    assert.throws(
      () => pathsForConversation(conversationId, storeDir),
      /invalid conversation id|escapes the store directory/
    );
    assert.throws(
      () => statePathForConversationId(conversationId, storeDir),
      /invalid conversation id|escapes the store directory/
    );
  }
});

test("resolves paths from a conversation directory", () => {
  const paths = pathsForConversationDir("/workspace/project/.agent-knock-knock/conversations/task-1");

  assert.equal(paths.statePath, "/workspace/project/.agent-knock-knock/conversations/task-1/state.json");
  assert.equal(paths.logPath, "/workspace/project/.agent-knock-knock/conversations/task-1/events.ndjson");
});

test("derives log path from new and legacy state paths", () => {
  assert.equal(
    logPathForStatePath("/workspace/project/.agent-knock-knock/conversations/task-1/state.json"),
    "/workspace/project/.agent-knock-knock/conversations/task-1/events.ndjson"
  );
  assert.equal(
    logPathForStatePath("/tmp/task-1.state.json"),
    "/tmp/task-1.ndjson"
  );
});

test("stores directories as 0700 and state and events as 0600", {
  skip: process.platform === "win32"
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const storeDir = path.join(sandbox, "custom-store");
  const { conversation, paths } = storedConversation(storeDir);

  try {
    appendEvent(paths.logPath, {
      event: "conversation_created",
      conversation_id: conversation.conversation_id
    });
    saveState(paths.statePath, conversation);

    assert.equal(mode(paths.storeDir), 0o700);
    assert.equal(mode(paths.conversationDir), 0o700);
    assert.equal(mode(paths.statePath), 0o600);
    assert.equal(mode(paths.logPath), 0o600);
    assert.deepEqual(loadState(paths.statePath), conversation);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("repairs insecure modes and atomically replaces state without temp remnants", {
  skip: process.platform === "win32"
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const storeDir = path.join(sandbox, "custom-store");
  const { conversation, paths } = storedConversation(storeDir);

  try {
    fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(paths.storeDir, 0o755);
    fs.chmodSync(paths.conversationDir, 0o755);
    fs.writeFileSync(paths.statePath, '{"old":true}\n', { encoding: "utf8", mode: 0o644 });
    fs.writeFileSync(paths.logPath, '{"event":"existing"}\n', { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(paths.statePath, 0o644);
    fs.chmodSync(paths.logPath, 0o644);
    const previousInode = fs.statSync(paths.statePath).ino;

    saveState(paths.statePath, conversation);
    appendEvent(paths.logPath, { event: "message" });

    assert.equal(mode(paths.storeDir), 0o700);
    assert.equal(mode(paths.conversationDir), 0o700);
    assert.equal(mode(paths.statePath), 0o600);
    assert.equal(mode(paths.logPath), 0o600);
    assert.notEqual(fs.statSync(paths.statePath).ino, previousInode);
    assert.deepEqual(
      fs.readdirSync(paths.conversationDir).sort(),
      ["events.ndjson", "state.json"]
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("concurrent appenders serialize complete NDJSON records", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const logPath = path.join(sandbox, "task-1", "events.ndjson");
  const storeModuleUrl = new URL("../src/store.js", import.meta.url).href;
  const writerCount = 4;
  const eventsPerWriter = 20;
  const childScript = `
    import { appendEvent } from ${JSON.stringify(storeModuleUrl)};
    const logPath = process.argv[1];
    const writer = Number(process.argv[2]);
    const count = Number(process.argv[3]);
    for (let index = 0; index < count; index += 1) {
      appendEvent(logPath, { event: "message", writer, index });
    }
  `;

  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(path.dirname(logPath), ".akk-store.lock"),
      `${JSON.stringify({
        pid: 2_147_483_647,
        token: "stale-lock",
        created_at: "2000-01-01T00:00:00.000Z"
      })}\n`,
      { mode: 0o600 }
    );
    await Promise.all(Array.from({ length: writerCount }, (_, writer) => new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          childScript,
          logPath,
          String(writer),
          String(eventsPerWriter)
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`append worker ${writer} exited ${code}: ${stderr}`));
        }
      });
    })));

    assert.equal(assertAppendableEventLog(logPath), true);
    const events = fs.readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { writer: number; index: number });
    assert.equal(events.length, writerCount * eventsPerWriter);
    assert.equal(
      new Set(events.map((event) => `${event.writer}:${event.index}`)).size,
      writerCount * eventsPerWriter
    );
    assert.equal(fs.existsSync(path.join(path.dirname(logPath), ".akk-store.lock")), false);
    assert.equal(
      fs.existsSync(path.join(path.dirname(logPath), ".akk-store.lock.reclaim")),
      false
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("rejects symlinked store, conversation, state, and event paths", {
  skip: process.platform === "win32"
}, () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));

  try {
    const realStore = path.join(sandbox, "real-store");
    const linkedStore = path.join(sandbox, "linked-store");
    fs.mkdirSync(realStore, { mode: 0o700 });
    fs.symlinkSync(realStore, linkedStore, "dir");
    assert.throws(
      () => pathsForConversation("task-1", linkedStore),
      /store directory must not be a symlink/
    );

    const outsideConversation = path.join(sandbox, "outside-conversation");
    fs.mkdirSync(outsideConversation, { mode: 0o700 });
    fs.symlinkSync(outsideConversation, path.join(realStore, "task-symlink"), "dir");
    assert.throws(
      () => pathsForConversation("task-symlink", realStore),
      /conversation directory must not be a symlink/
    );

    const { conversation, paths } = storedConversation(realStore, "task-files");
    fs.mkdirSync(paths.conversationDir, { mode: 0o700 });
    const outsideState = path.join(sandbox, "outside-state.json");
    const outsideEvents = path.join(sandbox, "outside-events.ndjson");
    fs.writeFileSync(outsideState, "private-state\n", "utf8");
    fs.writeFileSync(outsideEvents, '{"event":"outside"}\n', "utf8");
    fs.symlinkSync(outsideState, paths.statePath);
    fs.symlinkSync(outsideEvents, paths.logPath);

    assert.throws(
      () => saveState(paths.statePath, conversation),
      /state file must not be a symlink/
    );
    assert.throws(
      () => appendEvent(paths.logPath, { event: "message" }),
      /event log must not be a symlink/
    );
    assert.equal(fs.readFileSync(outsideState, "utf8"), "private-state\n");
    assert.equal(fs.readFileSync(outsideEvents, "utf8"), '{"event":"outside"}\n');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

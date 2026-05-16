import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendEvent,
  assertAppendableEventLog,
  defaultStoreDir,
  logPathForStatePath,
  pathsForConversation,
  pathsForConversationDir
} from "../src/store.js";

test("defaults store under workspace .agent-knock-knock conversations", () => {
  assert.equal(
    defaultStoreDir("/workspace/project"),
    path.join("/workspace/project", ".agent-knock-knock", "conversations")
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

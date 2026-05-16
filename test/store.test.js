import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
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

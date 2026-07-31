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
  assertStoreWriterCompatible,
  defaultStoreDir,
  ensureStoreWritable,
  inspectStoreCompatibility,
  listConversations,
  loadConversationById,
  loadState,
  logPathForStatePath,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  statePathForConversationId,
  storeManifestPath,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
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

test("defaults to one stable store root under user home", () => {
  assert.equal(
    defaultStoreDir("/workspace/project"),
    path.join(os.homedir(), ".agent-knock-knock", "store")
  );
});

test("reading an absent store does not initialize it", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-read-"));
  const storeDir = path.join(sandbox, "store");
  try {
    assert.deepEqual(listConversations(storeDir), []);
    assert.equal(fs.existsSync(storeDir), false);
    assert.equal(inspectStoreCompatibility(storeDir).status, "uninitialized");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("writer preflight permits an absent store without initializing it", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-preflight-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const compatibility = assertStoreWriterCompatible(storeDir);
    assert.equal(compatibility.status, "uninitialized");
    assert.equal(compatibility.writable, true);
    assert.equal(fs.existsSync(storeDir), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("the first write creates a stable manifest and canonical layout", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-manifest-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir);
  try {
    saveState(paths.statePath, conversation);
    const manifest = JSON.parse(fs.readFileSync(storeManifestPath(storeDir), "utf8"));
    assert.equal(manifest.schema, "agent-knock-knock/store");
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.writer_protocol, 1);
    assert.equal(typeof manifest.created_at, "string");
    assert.equal(paths.conversationDir, path.join(storeDir, "conversations", "task-1"));
    assert.equal(inspectStoreCompatibility(storeDir).status, "compatible");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("concurrent first writers publish one complete manifest", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-first-writers-"));
  const storeDir = path.join(sandbox, "store");
  const storeModuleUrl = new URL("../src/store.js", import.meta.url).href;
  const childScript = `
    import { ensureStoreWritable } from ${JSON.stringify(storeModuleUrl)};
    ensureStoreWritable(process.argv[1]);
  `;
  try {
    await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--input-type=module", "--eval", childScript, storeDir],
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
          reject(new Error(`first writer ${worker} exited ${code}: ${stderr}`));
        }
      });
    })));

    const manifest = JSON.parse(fs.readFileSync(storeManifestPath(storeDir), "utf8"));
    assert.equal(manifest.schema, "agent-knock-knock/store");
    assert.equal(manifest.format_version, 1);
    assert.equal(manifest.writer_protocol, 1);
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
    assert.equal(
      fs.readdirSync(storeDir).some((entry) =>
        entry.startsWith(".manifest.json.") && entry.endsWith(".tmp")
      ),
      false
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("nested sync and async writer leases reuse the root lock", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-lease-"));
  const storeDir = path.join(sandbox, "store");
  const first = storedConversation(storeDir, "task-sync");
  const second = storedConversation(storeDir, "task-async");
  try {
    withStoreWriterLease(storeDir, (lease) => {
      assert.equal(lease.storeDir, path.resolve(storeDir));
      assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), true);
      saveState(first.paths.statePath, first.conversation);
      appendEvent(first.paths.logPath, {
        event: "conversation_created",
        conversation_id: first.conversation.conversation_id
      });
      ensureStoreWritable(storeDir);
    });
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);

    await withStoreWriterLeaseAsync(storeDir, async () => {
      await Promise.resolve();
      saveState(second.paths.statePath, second.conversation);
      appendEvent(second.paths.logPath, {
        event: "conversation_created",
        conversation_id: second.conversation.conversation_id
      });
    });
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
    assert.deepEqual(
      listConversations(storeDir).map((conversation) => conversation.conversation_id).sort(),
      ["task-async", "task-sync"]
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("listing replaces persisted storage locations with canonical store paths", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-canonical-list-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir);
  try {
    saveState(paths.statePath, conversation);
    fs.writeFileSync(
      paths.statePath,
      `${JSON.stringify({
        ...conversation,
        store_dir: "/tmp/foreign-store",
        conversation_dir: "/tmp/foreign-store/conversations/task-1",
        state_path: "/tmp/foreign-store/conversations/task-1/state.json",
        event_log_path: "/tmp/foreign-store/conversations/task-1/events.ndjson"
      }, null, 2)}\n`,
      "utf8"
    );

    const [listed] = listConversations(storeDir);
    assert.equal(listed.store_dir, path.resolve(storeDir));
    assert.equal(listed.conversation_dir, paths.conversationDir);
    assert.equal(listed.state_path, paths.statePath);
    assert.equal(listed.event_log_path, paths.logPath);

    const loaded = loadConversationById(conversation.conversation_id, storeDir);
    assert.equal(loaded.store_dir, path.resolve(storeDir));
    assert.equal(loaded.conversation_dir, paths.conversationDir);
    assert.equal(loaded.state_path, paths.statePath);
    assert.equal(loaded.event_log_path, paths.logPath);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a readable future writer protocol blocks every write without changing data", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-writer-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir);
  try {
    saveState(paths.statePath, conversation);
    appendEvent(paths.logPath, {
      event: "conversation_created",
      conversation_id: conversation.conversation_id
    });
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, writer_protocol: 2 }, null, 2)}\n`,
      "utf8"
    );
    const stateBefore = fs.readFileSync(paths.statePath, "utf8");
    const eventsBefore = fs.readFileSync(paths.logPath, "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(storeDir, 0o755);
    }
    const compatibility = inspectStoreCompatibility(storeDir);
    assert.equal(compatibility.readable, true);
    assert.equal(compatibility.writable, false);
    assert.equal(listConversations(storeDir).length, 1);
    assert.throws(
      () => saveState(paths.statePath, { ...conversation, status: "closed" }),
      /writer protocol 2|refusing to mutate/u
    );
    assert.throws(
      () => appendEvent(paths.logPath, {
        event: "message",
        conversation_id: conversation.conversation_id
      }),
      /writer protocol 2|refusing to mutate/u
    );
    assert.equal(fs.readFileSync(paths.statePath, "utf8"), stateBefore);
    assert.equal(fs.readFileSync(paths.logPath, "utf8"), eventsBefore);
    if (process.platform !== "win32") {
      assert.equal(mode(storeDir), 0o755);
    }
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a future store format is neither read nor written", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-format-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir);
  try {
    saveState(paths.statePath, conversation);
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, format_version: 2 }, null, 2)}\n`,
      "utf8"
    );
    assert.throws(() => listConversations(storeDir), /format 2/u);
    assert.throws(() => saveState(paths.statePath, conversation), /format 2/u);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a non-empty manifestless store fails closed without adoption", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-legacy-"));
  const storeDir = path.join(sandbox, "store");
  const legacyState = path.join(storeDir, "conversations", "legacy", "state.json");
  try {
    fs.mkdirSync(path.dirname(legacyState), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyState, '{"conversation_id":"legacy"}\n', { mode: 0o600 });
    if (process.platform !== "win32") {
      fs.chmodSync(storeDir, 0o755);
    }
    const before = fs.readFileSync(legacyState, "utf8");
    const entriesBefore = fs.readdirSync(storeDir).sort();
    assert.throws(
      () => ensureStoreWritable(storeDir),
      /non-empty manifestless|has no AKK manifest/u
    );
    assert.equal(fs.readFileSync(legacyState, "utf8"), before);
    assert.deepEqual(fs.readdirSync(storeDir).sort(), entriesBefore);
    assert.equal(fs.existsSync(storeManifestPath(storeDir)), false);
    if (process.platform !== "win32") {
      assert.equal(mode(storeDir), 0o755);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("appendEvent refuses to append to a corrupted event log", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const storeDir = path.join(sandbox, "store");
  const paths = pathsForConversation("task-1", storeDir);

  try {
    ensureStoreWritable(storeDir);
    fs.mkdirSync(paths.conversationDir, { recursive: true });
    fs.writeFileSync(paths.logPath, JSON.stringify({ event: "conversation_created" }, null, 2), "utf8");

    assert.throws(
      () => appendEvent(paths.logPath, { event: "message", conversation_id: "task-1" }),
      /event log is not valid NDJSON at line 1/
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("appendEvent completes a valid final line before appending", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-"));
  const storeDir = path.join(sandbox, "store");
  const paths = pathsForConversation("task-1", storeDir);

  try {
    ensureStoreWritable(storeDir);
    fs.mkdirSync(paths.conversationDir, { recursive: true });
    fs.writeFileSync(paths.logPath, '{"event":"conversation_created"}', "utf8");
    appendEvent(paths.logPath, { event: "message", conversation_id: "task-1" });

    const lines = fs.readFileSync(paths.logPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((line) => JSON.parse(line).event), [
      "conversation_created",
      "message"
    ]);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
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

test("uses one conversations directory inside the stable store root", () => {
  const storeDir = "/workspace/project/.agent-knock-knock/store";
  const paths = pathsForConversation("task-1", storeDir);

  assert.equal(paths.conversationDir, path.join(storeDir, "conversations", "task-1"));
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
  const paths = pathsForConversationDir("/workspace/project/.agent-knock-knock/store/conversations/task-1");

  assert.equal(paths.storeDir, "/workspace/project/.agent-knock-knock/store");
  assert.equal(paths.statePath, "/workspace/project/.agent-knock-knock/store/conversations/task-1/state.json");
  assert.equal(paths.logPath, "/workspace/project/.agent-knock-knock/store/conversations/task-1/events.ndjson");
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
    ensureStoreWritable(storeDir);
    fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o755 });
    fs.chmodSync(paths.storeDir, 0o755);
    fs.chmodSync(paths.conversationDir, 0o755);
    fs.writeFileSync(paths.statePath, '{"old":true}\n', { encoding: "utf8", mode: 0o644 });
    fs.writeFileSync(paths.logPath, '{"event":"existing"}\n', { encoding: "utf8", mode: 0o644 });
    fs.chmodSync(paths.statePath, 0o644);
    fs.chmodSync(paths.logPath, 0o644);
    const previousInode = fs.statSync(paths.statePath).ino;

    saveState(paths.statePath, conversation);
    appendEvent(paths.logPath, {
      event: "message",
      conversation_id: conversation.conversation_id
    });

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
  const storeDir = path.join(sandbox, "store");
  const logPath = pathsForConversation("task-1", storeDir).logPath;
  const storeModuleUrl = new URL("../src/store.js", import.meta.url).href;
  const writerCount = 4;
  const eventsPerWriter = 20;
  const childScript = `
    import { appendEvent } from ${JSON.stringify(storeModuleUrl)};
    const logPath = process.argv[1];
    const writer = Number(process.argv[2]);
    const count = Number(process.argv[3]);
    for (let index = 0; index < count; index += 1) {
      appendEvent(logPath, { event: "message", conversation_id: "task-1", writer, index });
    }
  `;

  try {
    ensureStoreWritable(storeDir);
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
    ensureStoreWritable(realStore);
    fs.symlinkSync(realStore, linkedStore, "dir");
    assert.throws(
      () => pathsForConversation("task-1", linkedStore),
      /store directory must not be a symlink/
    );

    const outsideConversation = path.join(sandbox, "outside-conversation");
    fs.mkdirSync(outsideConversation, { mode: 0o700 });
    fs.symlinkSync(
      outsideConversation,
      path.join(realStore, "conversations", "task-symlink"),
      "dir"
    );
    assert.throws(
      () => pathsForConversation("task-symlink", realStore),
      /conversation directory must not be a symlink/
    );
    fs.unlinkSync(path.join(realStore, "conversations", "task-symlink"));

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
      () => appendEvent(paths.logPath, {
        event: "message",
        conversation_id: conversation.conversation_id
      }),
      /event log must not be a symlink/
    );
    assert.equal(fs.readFileSync(outsideState, "utf8"), "private-state\n");
    assert.equal(fs.readFileSync(outsideEvents, "utf8"), '{"event":"outside"}\n');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

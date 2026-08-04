import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createConversation, createMessage } from "../src/protocol.js";
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
  messageEvent,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  STORE_WRITER_PROTOCOL,
  statePathForConversationId,
  storeManifestPath,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "../src/store.js";

function mode(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777;
}

function fileSnapshot(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    contents: fs.readFileSync(filePath, "utf8"),
    inode: stat.ino,
    mtimeMs: stat.mtimeMs,
    mode: process.platform === "win32" ? undefined : stat.mode & 0o777
  };
}

function storedConversation(storeDir: string, conversationId = "task-1") {
  const paths = pathsForConversation(conversationId, storeDir);
  const conversation = {
    ...createConversation({
      userRequest: "secure the store",
      now: new Date("2026-07-23T00:00:00.000Z")
    }),
    conversation_id: conversationId,
    turn_id: conversationId,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  return { conversation, paths };
}

function writeStoreManifest(
  storeDir: string,
  {
    writerProtocol = 1,
    formatVersion = 1,
    createdAt = "2026-07-01T02:03:04.000Z"
  }: {
    writerProtocol?: number;
    formatVersion?: number;
    createdAt?: string;
  } = {}
): string {
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  const manifestPath = storeManifestPath(storeDir);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify({
      schema: "agent-knock-knock/store",
      format_version: formatVersion,
      writer_protocol: writerProtocol,
      created_at: createdAt
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return manifestPath;
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

test("legacy states gain session and turn ids in memory without rewriting disk", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-identity-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir, "task-legacy-identity");
  try {
    saveState(paths.statePath, conversation);
    const legacy: any = { ...conversation };
    delete legacy.session_id;
    delete legacy.turn_id;
    fs.writeFileSync(paths.statePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");
    const persistedBefore = fs.readFileSync(paths.statePath, "utf8");

    const loaded = loadState(paths.statePath);
    assert.equal(loaded.session_id, legacy.conversation_id);
    assert.equal(loaded.turn_id, legacy.conversation_id);
    assert.equal(fs.readFileSync(paths.statePath, "utf8"), persistedBefore);

    const [listed] = listConversations(storeDir);
    assert.equal(listed.session_id, legacy.conversation_id);
    assert.equal(listed.turn_id, legacy.conversation_id);
    assert.equal(fs.readFileSync(paths.statePath, "utf8"), persistedBefore);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("modern states reject a turn id that differs from the store identity", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-identity-mismatch-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir, "turn-canonical");
  try {
    saveState(paths.statePath, conversation);
    fs.writeFileSync(
      paths.statePath,
      `${JSON.stringify({ ...conversation, turn_id: "turn-spoofed" }, null, 2)}\n`,
      "utf8"
    );

    assert.throws(
      () => loadState(paths.statePath),
      /conversation_id must equal turn_id|turn_id turn-spoofed does not match/u
    );
    assert.throws(
      () => loadConversationById("turn-canonical", storeDir),
      /conversation_id must equal turn_id|turn_id turn-spoofed does not match/u
    );
    assert.throws(
      () => listConversations(storeDir),
      /conversation_id must equal turn_id|turn_id turn-spoofed does not match/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("partially modern stored identities fail closed", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-partial-identity-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir, "turn-partial");
  try {
    saveState(paths.statePath, conversation);
    for (const missing of ["session_id", "turn_id"] as const) {
      const partial: any = { ...conversation };
      delete partial[missing];
      fs.writeFileSync(
        paths.statePath,
        `${JSON.stringify(partial, null, 2)}\n`,
        "utf8"
      );
      assert.throws(
        () => loadState(paths.statePath),
        /session_id and turn_id must either both be present or both be absent/u
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("message events expose new identities and fall back for legacy messages", () => {
  const conversation = createConversation({
    userRequest: "Correlate the event",
    sessionId: "session-event",
    turnId: "turn-event"
  });
  const message = createMessage({
    conversation,
    from: "openclaw",
    to: "claude-code",
    type: "task",
    body: "Correlate the event"
  });

  const event = messageEvent(message);
  assert.equal(event.session_id, "session-event");
  assert.equal(event.turn_id, "turn-event");

  const legacyMessage: any = { ...message, conversation_id: "task-legacy-event" };
  delete legacyMessage.session_id;
  delete legacyMessage.turn_id;
  const legacyEvent = messageEvent(legacyMessage);
  assert.equal(legacyEvent.session_id, "task-legacy-event");
  assert.equal(legacyEvent.turn_id, "task-legacy-event");

  const partialMessage: any = { ...message };
  delete partialMessage.turn_id;
  assert.throws(
    () => messageEvent(partialMessage),
    /message\.session_id and message\.turn_id must either both be present or both be absent/u
  );
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
    assert.equal(manifest.writer_protocol, STORE_WRITER_PROTOCOL);
    assert.equal(typeof manifest.created_at, "string");
    assert.equal(paths.conversationDir, path.join(storeDir, "conversations", "task-1"));
    assert.equal(inspectStoreCompatibility(storeDir).status, "compatible");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("an empty protocol 1 Store is reported upgradeable and upgrades in place", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-empty-"));
  const storeDir = path.join(sandbox, "store");
  const createdAt = "2025-12-31T23:59:58.000Z";
  try {
    const manifestPath = writeStoreManifest(storeDir, { createdAt });
    const before = inspectStoreCompatibility(storeDir);
    assert.equal(before.status, "upgradeable");
    assert.equal(before.readable, true);
    assert.equal(before.writable, true);
    assert.equal(before.upgradeable, true);
    assert.equal(before.writer_protocol, 1);

    const manifest = ensureStoreWritable(storeDir);
    assert.equal(manifest.writer_protocol, STORE_WRITER_PROTOCOL);
    assert.equal(manifest.created_at, createdAt);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")),
      manifest
    );
    assert.equal(inspectStoreCompatibility(storeDir).status, "compatible");
    assert.equal(fs.existsSync(path.join(storeDir, "conversations")), true);
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

test("a non-empty protocol 1 Store preserves state, events, and created_at while upgrading", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-data-"));
  const storeDir = path.join(sandbox, "store");
  const modern = storedConversation(storeDir, "turn-modern-upgrade");
  const legacy = storedConversation(storeDir, "turn-legacy-upgrade");
  try {
    saveState(modern.paths.statePath, modern.conversation);
    appendEvent(modern.paths.logPath, {
      event: "conversation_created",
      conversation_id: modern.conversation.conversation_id
    });
    saveState(legacy.paths.statePath, legacy.conversation);
    appendEvent(legacy.paths.logPath, {
      event: "conversation_created",
      conversation_id: legacy.conversation.conversation_id
    });

    const legacyState: any = { ...legacy.conversation };
    delete legacyState.session_id;
    delete legacyState.turn_id;
    fs.writeFileSync(
      legacy.paths.statePath,
      `${JSON.stringify(legacyState, null, 2)}\n`,
      "utf8"
    );

    const manifestPath = storeManifestPath(storeDir);
    const oldManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const createdAt = oldManifest.created_at;
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...oldManifest, writer_protocol: 1 }, null, 2)}\n`,
      "utf8"
    );
    const before = {
      modernState: fileSnapshot(modern.paths.statePath),
      modernEvents: fileSnapshot(modern.paths.logPath),
      legacyState: fileSnapshot(legacy.paths.statePath),
      legacyEvents: fileSnapshot(legacy.paths.logPath)
    };

    ensureStoreWritable(storeDir);

    const upgraded = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(upgraded.writer_protocol, STORE_WRITER_PROTOCOL);
    assert.equal(upgraded.created_at, createdAt);
    assert.deepEqual({
      modernState: fileSnapshot(modern.paths.statePath),
      modernEvents: fileSnapshot(modern.paths.logPath),
      legacyState: fileSnapshot(legacy.paths.statePath),
      legacyEvents: fileSnapshot(legacy.paths.logPath)
    }, before);
    assert.equal(loadState(legacy.paths.statePath).session_id, "turn-legacy-upgrade");
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("protocol 1 upgrade rejects partial stored identities without replacing its manifest", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-partial-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir, "turn-partial-upgrade");
  try {
    saveState(paths.statePath, conversation);
    const partial: any = { ...conversation };
    delete partial.turn_id;
    fs.writeFileSync(paths.statePath, `${JSON.stringify(partial, null, 2)}\n`, "utf8");

    const manifestPath = storeManifestPath(storeDir);
    const current = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...current, writer_protocol: 1 }, null, 2)}\n`,
      "utf8"
    );
    const manifestBefore = fs.readFileSync(manifestPath, "utf8");
    const manifestInodeBefore = fs.statSync(manifestPath).ino;
    const stateBefore = fs.readFileSync(paths.statePath, "utf8");

    assert.throws(
      () => ensureStoreWritable(storeDir),
      /session_id and turn_id must either both be present or both be absent/u
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
    assert.equal(fs.statSync(manifestPath).ino, manifestInodeBefore);
    assert.equal(fs.readFileSync(paths.statePath, "utf8"), stateBefore);
    assert.equal(inspectStoreCompatibility(storeDir).status, "upgradeable");
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("protocol 1 upgrade rejects a modern turn identity that is not its Store key", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-mismatch-"));
  const storeDir = path.join(sandbox, "store");
  const { conversation, paths } = storedConversation(storeDir, "turn-upgrade-key");
  try {
    saveState(paths.statePath, conversation);
    fs.writeFileSync(
      paths.statePath,
      `${JSON.stringify({ ...conversation, turn_id: "turn-other" }, null, 2)}\n`,
      "utf8"
    );
    const manifestPath = storeManifestPath(storeDir);
    const current = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...current, writer_protocol: 1 }, null, 2)}\n`,
      "utf8"
    );
    const manifestBefore = fs.readFileSync(manifestPath, "utf8");

    assert.throws(
      () => ensureStoreWritable(storeDir),
      /conversation_id must equal turn_id|turn_id turn-other does not match/u
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("saveState rejects a partial identity before creating or upgrading a manifest", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-save-partial-"));
  const absentStoreDir = path.join(sandbox, "absent-store");
  const protocolOneStoreDir = path.join(sandbox, "protocol-one-store");
  try {
    for (const storeDir of [absentStoreDir, protocolOneStoreDir]) {
      if (storeDir === protocolOneStoreDir) {
        writeStoreManifest(storeDir);
      }
      const { conversation, paths } = storedConversation(storeDir, "turn-invalid-save");
      const partial: any = { ...conversation };
      delete partial.session_id;
      const manifestPath = storeManifestPath(storeDir);
      const manifestBefore = fs.existsSync(manifestPath)
        ? fs.readFileSync(manifestPath, "utf8")
        : undefined;

      assert.throws(
        () => saveState(paths.statePath, partial),
        /session_id and turn_id must either both be present or both be absent/u
      );
      assert.equal(fs.existsSync(paths.statePath), false);
      assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
      assert.equal(
        fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, "utf8") : undefined,
        manifestBefore
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("saveState validates its Store key and storage metadata before a protocol upgrade", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-save-preflight-"));
  try {
    const cases = ["wrong-key", "missing-metadata"] as const;
    for (const scenario of cases) {
      const storeDir = path.join(sandbox, scenario);
      const manifestPath = writeStoreManifest(storeDir);
      const target = storedConversation(storeDir, "turn-target");
      const candidate: any = scenario === "wrong-key"
        ? {
            ...target.conversation,
            conversation_id: "turn-other",
            turn_id: "turn-other"
          }
        : { ...target.conversation };
      if (scenario === "missing-metadata") {
        delete candidate.state_path;
      }
      const manifestBefore = fs.readFileSync(manifestPath, "utf8");

      assert.throws(
        () => saveState(target.paths.statePath, candidate),
        /does not match its store directory|storage metadata is required/u
      );
      assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
      assert.equal(inspectStoreCompatibility(storeDir).status, "upgradeable");
      assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
    }
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
    assert.equal(manifest.writer_protocol, STORE_WRITER_PROTOCOL);
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

test("concurrent writers serialize one protocol 1 manifest upgrade", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-writers-"));
  const storeDir = path.join(sandbox, "store");
  const storeModuleUrl = new URL("../src/store.js", import.meta.url).href;
  const childScript = `
    import { ensureStoreWritable } from ${JSON.stringify(storeModuleUrl)};
    ensureStoreWritable(process.argv[1]);
  `;
  const createdAt = "2024-03-02T01:00:00.000Z";
  try {
    writeStoreManifest(storeDir, { createdAt });
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
          reject(new Error(`upgrade writer ${worker} exited ${code}: ${stderr}`));
        }
      });
    })));

    const manifest = JSON.parse(fs.readFileSync(storeManifestPath(storeDir), "utf8"));
    assert.equal(manifest.writer_protocol, STORE_WRITER_PROTOCOL);
    assert.equal(manifest.created_at, createdAt);
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
      `${JSON.stringify({ ...manifest, writer_protocol: STORE_WRITER_PROTOCOL + 1 }, null, 2)}\n`,
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
      /writer protocol 3|refusing to mutate/u
    );
    assert.throws(
      () => appendEvent(paths.logPath, {
        event: "message",
        conversation_id: conversation.conversation_id
      }),
      /writer protocol 3|refusing to mutate/u
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

test("an unknown older writer protocol is not treated as upgradeable", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-old-writer-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const manifestPath = writeStoreManifest(storeDir, { writerProtocol: 0 });
    const before = fs.readFileSync(manifestPath, "utf8");
    const compatibility = inspectStoreCompatibility(storeDir);
    assert.equal(compatibility.status, "incompatible");
    assert.equal(compatibility.readable, true);
    assert.equal(compatibility.writable, false);
    assert.equal(compatibility.upgradeable, false);
    assert.throws(
      () => ensureStoreWritable(storeDir),
      /writer protocol 0|refusing to mutate/u
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), before);
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

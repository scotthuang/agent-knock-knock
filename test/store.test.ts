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
  ensureDir,
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
import {
  loadManagedSession,
  pathsForManagedSession
} from "../src/session-store.js";

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

test("durable directory creation fsyncs every newly created parent entry", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-durable-dir-"));
  const first = path.join(sandbox, "first");
  const nested = path.join(first, "second");
  const opened = new Map<number, string>();
  const fsynced: string[] = [];
  const originalOpenSync = fs.openSync;
  const originalFsyncSync = fs.fsyncSync;
  const mutableFs = fs as unknown as {
    openSync: (...args: unknown[]) => number;
    fsyncSync: (fd: number) => void;
  };
  try {
    mutableFs.openSync = (...args: unknown[]): number => {
      const fd = Reflect.apply(originalOpenSync, fs, args) as number;
      opened.set(fd, path.resolve(String(args[0])));
      return fd;
    };
    mutableFs.fsyncSync = (fd: number): void => {
      const openedPath = opened.get(fd);
      if (openedPath) {
        fsynced.push(openedPath);
      }
      originalFsyncSync(fd);
    };

    ensureDir(nested);

    assert.equal(fs.statSync(nested).isDirectory(), true);
    assert.ok(
      fsynced.includes(path.resolve(sandbox)),
      "creating first/ must fsync its parent"
    );
    assert.ok(
      fsynced.includes(path.resolve(first)),
      "creating first/second/ must fsync first/"
    );
  } finally {
    mutableFs.openSync = originalOpenSync as unknown as (...args: unknown[]) => number;
    mutableFs.fsyncSync = originalFsyncSync;
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

test("legacy callback statuses normalize in memory without rewriting Store state", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-callback-status-"));
  const storeDir = path.join(sandbox, "store");
  const cases = [
    {
      conversationId: "turn-legacy-callback-pending",
      status: "callback_pending",
      deliveryStatus: "pending",
      finalStatus: "idle"
    },
    {
      conversationId: "turn-legacy-callback-failed",
      status: "callback_failed",
      deliveryStatus: "failed",
      finalStatus: "waiting_for_openclaw"
    }
  ] as const;

  try {
    const persisted = new Map<string, string>();
    for (const testCase of cases) {
      const { conversation, paths } = storedConversation(
        storeDir,
        testCase.conversationId
      );
      saveState(paths.statePath, conversation);
      const legacy = {
        ...conversation,
        status: testCase.status,
        callback_delivery: {
          status: testCase.deliveryStatus,
          final_status: testCase.finalStatus,
          created_at: "2026-08-06T04:04:17.650Z",
          message: {
            id: `message-${testCase.conversationId}`,
            type: testCase.finalStatus === "idle" ? "done" : "blocked"
          }
        }
      };
      const serialized = `${JSON.stringify(legacy, null, 2)}\n`;
      fs.writeFileSync(paths.statePath, serialized, "utf8");
      persisted.set(paths.statePath, serialized);

      const first = loadState(paths.statePath);
      const second = loadState(paths.statePath);
      assert.equal(first.status, testCase.finalStatus);
      assert.deepEqual(second, first);
      assert.equal(first.legacy_callback_status_error, undefined);
      assert.equal(fs.readFileSync(paths.statePath, "utf8"), serialized);

      const byId = loadConversationById(testCase.conversationId, storeDir);
      assert.equal(byId.status, testCase.finalStatus);
      assert.equal(fs.readFileSync(paths.statePath, "utf8"), serialized);
    }

    const listed = listConversations(storeDir);
    assert.deepEqual(
      new Map(listed.map((conversation) => [conversation.conversation_id, conversation.status])),
      new Map(cases.map((testCase) => [testCase.conversationId, testCase.finalStatus]))
    );
    for (const [statePath, serialized] of persisted) {
      assert.equal(fs.readFileSync(statePath, "utf8"), serialized);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("malformed legacy callback phases remain fail-closed and do not poison Store listing", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-callback-status-invalid-"));
  const storeDir = path.join(sandbox, "store");
  const cases = [
    {
      conversationId: "turn-legacy-callback-missing-final",
      callbackDelivery: { status: "failed" }
    },
    {
      conversationId: "turn-legacy-callback-invalid-final",
      callbackDelivery: {
        status: "failed",
        final_status: "callback_pending"
      }
    },
    {
      conversationId: "turn-legacy-callback-invalid-close-shortcut",
      callbackDelivery: {
        status: "failed",
        close_terminal_bridge_on_done: true,
        message: { id: "message-invalid-close-shortcut", type: "done" }
      }
    },
    {
      conversationId: "turn-legacy-callback-mismatched-transport",
      callbackDelivery: {
        status: "delivered",
        final_status: "idle",
        message: { id: "message-mismatched-transport", type: "done" }
      }
    }
  ];

  try {
    const persisted = new Map<string, string>();
    for (const testCase of cases) {
      const { conversation, paths } = storedConversation(
        storeDir,
        testCase.conversationId
      );
      saveState(paths.statePath, conversation);
      const legacy = {
        ...conversation,
        status: "callback_failed",
        callback_delivery: testCase.callbackDelivery
      };
      const serialized = `${JSON.stringify(legacy, null, 2)}\n`;
      fs.writeFileSync(paths.statePath, serialized, "utf8");
      persisted.set(paths.statePath, serialized);

      const first = loadState(paths.statePath);
      const second = loadState(paths.statePath);
      assert.equal(first.status, "callback_failed");
      assert.match(
        String(first.legacy_callback_status_error),
        /missing a valid callback_delivery\.final_status Turn phase/u
      );
      assert.deepEqual(second, first);
      assert.equal(fs.readFileSync(paths.statePath, "utf8"), serialized);
    }

    const listed = listConversations(storeDir);
    assert.equal(listed.length, cases.length);
    assert.equal(
      listed.every((conversation) =>
        conversation.status === "callback_failed" &&
        /missing a valid callback_delivery\.final_status Turn phase/u.test(
          String(conversation.legacy_callback_status_error)
        )
      ),
      true
    );
    for (const [statePath, serialized] of persisted) {
      assert.equal(fs.readFileSync(statePath, "utf8"), serialized);
    }
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

test("protocol 3 upgrades to protocol 4 by atomically publishing only the manifest", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-upgrade-p3-"));
  const storeDir = path.join(sandbox, "store");
  const createdAt = "2026-08-12T00:00:00.000Z";
  try {
    const turn = storedConversation(storeDir, "turn-protocol-3-nonempty");
    writeStoreManifest(storeDir, {
      writerProtocol: 2,
      createdAt
    });
    fs.mkdirSync(turn.paths.conversationDir, {
      recursive: true,
      mode: 0o700
    });
    fs.writeFileSync(
      turn.paths.statePath,
      `${JSON.stringify(turn.conversation, null, 2)}\n`,
      { mode: 0o600 }
    );
    // Materialize the exact protocol-3 data shape using the supported p2
    // migration, then put back its predecessor manifest for this upgrade test.
    ensureStoreWritable(storeDir);
    const sessionPath = pathsForManagedSession(
      String(turn.conversation.session_id),
      storeDir
    ).statePath;
    const manifestPath = writeStoreManifest(storeDir, {
      writerProtocol: 3,
      createdAt
    });
    const conversationsDir = path.join(storeDir, "conversations");
    const sessionsDir = path.join(storeDir, "sessions");
    fs.mkdirSync(conversationsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
    const conversationSentinel = path.join(conversationsDir, "sentinel");
    const sessionSentinel = path.join(sessionsDir, "sentinel");
    fs.writeFileSync(conversationSentinel, "conversation-bytes\n", { mode: 0o600 });
    fs.writeFileSync(sessionSentinel, "session-bytes\n", { mode: 0o600 });
    const before = {
      conversation: fileSnapshot(conversationSentinel),
      session: fileSnapshot(sessionSentinel),
      turnState: fileSnapshot(turn.paths.statePath),
      sessionState: fileSnapshot(sessionPath),
      manifestInode: fs.statSync(manifestPath).ino
    };

    const compatibility = inspectStoreCompatibility(storeDir);
    assert.equal(compatibility.status, "upgradeable");
    assert.equal(compatibility.writer_protocol, 3);
    const upgraded = ensureStoreWritable(storeDir);

    assert.equal(upgraded.writer_protocol, STORE_WRITER_PROTOCOL);
    assert.equal(upgraded.created_at, createdAt);
    assert.notEqual(fs.statSync(manifestPath).ino, before.manifestInode);
    assert.deepEqual(fileSnapshot(conversationSentinel), before.conversation);
    assert.deepEqual(fileSnapshot(sessionSentinel), before.session);
    assert.deepEqual(fileSnapshot(turn.paths.statePath), before.turnState);
    assert.deepEqual(fileSnapshot(sessionPath), before.sessionState);
    assert.equal(loadState(turn.paths.statePath).conversation_id, turn.conversation.conversation_id);
    assert.equal(
      loadManagedSession(storeDir, String(turn.conversation.session_id)).session_id,
      turn.conversation.session_id
    );
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

test("protocol 2 migration materializes one hashed Session before publishing the current protocol", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-session-migration-"));
  const storeDir = path.join(sandbox, "store");
  const sessionId = "session/legacy/path/会话";
  const nativeThreadId = "00000000-0000-4000-8000-000000000301";
  try {
    writeStoreManifest(storeDir, { writerProtocol: 2 });
    const stateSnapshots: Array<{ path: string; contents: string }> = [];
    for (const [index, turnId] of ["turn-migrate-1", "turn-migrate-2"].entries()) {
      const paths = pathsForConversation(turnId, storeDir);
      const now = new Date(Date.parse("2026-08-06T03:00:00.000Z") + index * 1000);
      const conversation = {
        ...createConversation({
          userRequest: `migration turn ${index + 1}`,
          sessionId,
          turnId,
          executorKind: "codex",
          executorSession: "codex",
          workspace: "/workspace/project",
          now
        }),
        terminal_binding_id: "binding-existing",
        terminal_binding_generation: 4,
        native_thread_id: nativeThreadId,
        native_session_takeover: {
          agent: "codex",
          native_session_id: "tmux:codex:akk:0.0:101",
          terminal_agent_pid: 202,
          terminal_agent_session_id: nativeThreadId,
          terminal_agent_expected_session_id: nativeThreadId,
          terminal_agent_process_birth: "process-birth-202",
          terminal_agent_rollout: {
            fd: "9",
            device: "1",
            inode: "303",
            path: "/tmp/codex-rollout.jsonl"
          },
          terminal_agent_identity_evidence: "codex_rollout_fd",
          terminal_control: {
            kind: "tmux",
            target: "akk:0.0",
            session: "akk",
            window: 0,
            pane: 0,
            panePid: 101,
            currentCommand: "codex",
            currentPath: "/workspace/project",
            capabilities: ["screen_status", "send_keys", "durable_completion"]
          }
        },
        store_dir: paths.storeDir,
        conversation_dir: paths.conversationDir,
        event_log_path: paths.logPath,
        state_path: paths.statePath
      };
      fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o700 });
      const contents = `${JSON.stringify(conversation, null, 2)}\n`;
      fs.writeFileSync(paths.statePath, contents, { mode: 0o600 });
      stateSnapshots.push({ path: paths.statePath, contents });
    }

    ensureStoreWritable(storeDir);

    const manifest = JSON.parse(fs.readFileSync(storeManifestPath(storeDir), "utf8"));
    assert.equal(manifest.writer_protocol, STORE_WRITER_PROTOCOL);
    const sessionPaths = pathsForManagedSession(sessionId, storeDir);
    assert.match(path.basename(sessionPaths.directory), /^[0-9a-f]{64}$/u);
    const session = loadManagedSession(storeDir, sessionId);
    assert.equal(session.revision, 1);
    assert.equal(session.status, "bound");
    assert.equal(session.binding?.binding_id, "binding-existing");
    assert.equal(session.binding?.generation, 4);
    assert.equal(session.binding?.native_thread_id, nativeThreadId);
    for (const snapshot of stateSnapshots) {
      assert.equal(fs.readFileSync(snapshot.path, "utf8"), snapshot.contents);
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("migration quarantines native threads referenced by multiple Sessions", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-native-owner-conflict-"));
  const storeDir = path.join(sandbox, "store");
  const nativeThreadId = "00000000-0000-4000-8000-000000000399";
  const sessionIds = ["session-native-owner-a", "session-native-owner-b"];
  try {
    writeStoreManifest(storeDir, { writerProtocol: 2 });
    for (const [index, sessionId] of sessionIds.entries()) {
      const turnId = `turn-native-owner-${index + 1}`;
      const paths = pathsForConversation(turnId, storeDir);
      const target = `owner-${index + 1}:0.0`;
      const conversation = {
        ...createConversation({
          userRequest: `native owner ${index + 1}`,
          sessionId,
          turnId,
          executorKind: "claude",
          workspace: "/workspace/project",
          now: new Date(`2026-08-06T03:10:0${index}.000Z`)
        }),
        terminal_binding_id: `binding-native-owner-${index + 1}`,
        terminal_binding_generation: 1,
        native_thread_id: nativeThreadId,
        native_session_takeover: {
          native_session_id: `tmux:claude:${target}:${101 + index}`,
          terminal_agent_pid: 201 + index,
          terminal_agent_session_id: nativeThreadId,
          terminal_agent_process_uuid: `process-native-owner-${index + 1}`,
          terminal_agent_identity_evidence: "claude_process_uuid",
          terminal_control: {
            kind: "tmux",
            target,
            session: `owner-${index + 1}`,
            window: 0,
            pane: 0,
            panePid: 101 + index,
            currentCommand: "claude",
            currentPath: "/workspace/project",
            capabilities: ["screen_status", "send_keys", "durable_completion"]
          }
        },
        store_dir: paths.storeDir,
        conversation_dir: paths.conversationDir,
        event_log_path: paths.logPath,
        state_path: paths.statePath
      };
      fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        paths.statePath,
        `${JSON.stringify(conversation, null, 2)}\n`,
        { mode: 0o600 }
      );
    }

    ensureStoreWritable(storeDir);

    for (const [index, sessionId] of sessionIds.entries()) {
      const session = loadManagedSession(storeDir, sessionId);
      assert.equal(session.status, "quarantined");
      assert.match(
        session.quarantine_reason ?? "",
        new RegExp(sessionIds[1 - index], "u")
      );
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("protocol 1 legacy Turn migration uses its storage id and never rewrites the Turn", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-legacy-session-migration-"));
  const storeDir = path.join(sandbox, "store");
  const turn = storedConversation(storeDir, "task-legacy-session");
  try {
    writeStoreManifest(storeDir, { writerProtocol: 1 });
    const legacy: any = { ...turn.conversation };
    delete legacy.session_id;
    delete legacy.turn_id;
    fs.mkdirSync(turn.paths.conversationDir, { recursive: true, mode: 0o700 });
    const before = `${JSON.stringify(legacy, null, 2)}\n`;
    fs.writeFileSync(turn.paths.statePath, before, { mode: 0o600 });

    ensureStoreWritable(storeDir);

    const session = loadManagedSession(storeDir, "task-legacy-session");
    assert.equal(session.session_id, "task-legacy-session");
    assert.equal(session.status, "detached");
    assert.equal(session.lineage.created_by, "migration");
    assert.equal(fs.readFileSync(turn.paths.statePath, "utf8"), before);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("migration quarantines conflicting binding evidence instead of choosing the newest Turn", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-binding-conflict-"));
  const storeDir = path.join(sandbox, "store");
  const sessionId = "session-conflicting-bindings";
  try {
    writeStoreManifest(storeDir, { writerProtocol: 2 });
    for (const [index, target] of ["first:0.0", "second:0.0"].entries()) {
      const turnId = `turn-conflict-${index + 1}`;
      const paths = pathsForConversation(turnId, storeDir);
      const now = new Date(Date.parse("2026-08-06T04:00:00.000Z") + index * 60_000);
      const conversation = {
        ...createConversation({
          userRequest: `conflict ${index + 1}`,
          sessionId,
          turnId,
          executorKind: "claude",
          workspace: "/workspace/project",
          now
        }),
        terminal_binding_id: `binding-conflict-${index + 1}`,
        terminal_binding_generation: 1,
        native_thread_id: "00000000-0000-4000-8000-000000000302",
        native_session_takeover: {
          native_session_id: `tmux:claude:${target}:111`,
          terminal_agent_pid: 222,
          terminal_agent_session_id: "00000000-0000-4000-8000-000000000302",
          terminal_agent_process_uuid: "process-conflict",
          terminal_agent_identity_evidence: "claude_process_uuid",
          terminal_control: {
            kind: "tmux",
            target,
            session: target.split(":")[0],
            window: 0,
            pane: 0,
            panePid: 111,
            capabilities: ["screen_status", "send_keys"]
          }
        },
        store_dir: paths.storeDir,
        conversation_dir: paths.conversationDir,
        event_log_path: paths.logPath,
        state_path: paths.statePath
      };
      fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(paths.statePath, `${JSON.stringify(conversation, null, 2)}\n`, {
        mode: 0o600
      });
    }

    ensureStoreWritable(storeDir);

    const session = loadManagedSession(storeDir, sessionId);
    assert.equal(session.status, "quarantined");
    assert.equal(session.binding, undefined);
    assert.match(session.quarantine_reason ?? "", /conflicting binding generation 1/u);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("failed Session derivation leaves the predecessor manifest unpublished", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-session-upgrade-fail-"));
  const storeDir = path.join(sandbox, "store");
  const sessionId = "session-workspace-conflict";
  try {
    const manifestPath = writeStoreManifest(storeDir, { writerProtocol: 2 });
    const manifestBefore = fs.readFileSync(manifestPath, "utf8");
    for (const [index, workspace] of ["/workspace/one", "/workspace/two"].entries()) {
      const turnId = `turn-workspace-${index + 1}`;
      const paths = pathsForConversation(turnId, storeDir);
      const conversation = {
        ...createConversation({
          userRequest: "workspace conflict",
          sessionId,
          turnId,
          executorKind: "codex",
          workspace
        }),
        store_dir: paths.storeDir,
        conversation_dir: paths.conversationDir,
        event_log_path: paths.logPath,
        state_path: paths.statePath
      };
      fs.mkdirSync(paths.conversationDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(paths.statePath, `${JSON.stringify(conversation, null, 2)}\n`, {
        mode: 0o600
      });
    }

    assert.throws(
      () => ensureStoreWritable(storeDir),
      /Turns disagree on agent or workspace/u
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
    assert.equal(
      fs.existsSync(pathsForManagedSession(sessionId, storeDir).statePath),
      false
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("upgrade refuses an unexpected predecessor Session tree before publishing protocol 3", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-unexpected-session-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const manifestPath = writeStoreManifest(storeDir, { writerProtocol: 2 });
    const manifestBefore = fs.readFileSync(manifestPath, "utf8");
    fs.mkdirSync(path.join(storeDir, "sessions", "not-a-sha256-key"), {
      recursive: true,
      mode: 0o700
    });

    assert.throws(
      () => ensureStoreWritable(storeDir),
      /invalid managed Session entry/u
    );
    assert.equal(fs.readFileSync(manifestPath, "utf8"), manifestBefore);
    assert.equal(inspectStoreCompatibility(storeDir).writer_protocol, 2);
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
      new RegExp(`writer protocol ${STORE_WRITER_PROTOCOL}|refusing to mutate`, "u")
    );
    assert.throws(
      () => appendEvent(paths.logPath, {
        event: "message",
        conversation_id: conversation.conversation_id
      }),
      new RegExp(`writer protocol ${STORE_WRITER_PROTOCOL}|refusing to mutate`, "u")
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

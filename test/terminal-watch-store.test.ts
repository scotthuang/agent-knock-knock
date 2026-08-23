import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  type CallbackEnvelopeV1,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import {
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_VERSION,
  TerminalWatchConflictError,
  assertTerminalWatch,
  createTerminalWatchStore,
  initialTerminalWatchObservationCheckpoint,
  listTerminalWatches,
  loadTerminalWatch,
  pathsForTerminalWatch,
  saveTerminalWatch,
  scanTerminalWatchesForReconciliation,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchCallbackEnvelope,
  terminalWatchNotificationCallbackSnapshot,
  terminalWatchRevision,
  type TerminalWatch,
  type TerminalWatchNotification,
  type TerminalWatchTerminalIdentity
} from "../src/terminal-watch-store.js";
import type { ClaudeHumanStartedActiveTaskAnchor } from
  "../src/claude-local-transcript-provider.js";
import type { CodexHumanStartedActiveTaskAnchor } from
  "../src/terminal-submission-acceptance.js";
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
    workspace: "/workspace/project",
    binding_token: SHA_A
  };
}

function codexAnchor(): CodexHumanStartedActiveTaskAnchor {
  const rollout = {
    fd: "7",
    device: "12",
    inode: "34",
    path: "/workspace/project/rollout.jsonl"
  };
  const base = {
    schema: "agent-knock-knock/codex-human-started-active-task-anchor" as const,
    version: 1 as const,
    native_thread_id: THREAD_ID,
    process_uuid: "codex-process-uuid",
    process_birth: "codex-process-birth",
    captured_at: CREATED_AT,
    rollout,
    turn_id: TASK_ID,
    request_hash: SHA_B,
    codex_version: "0.148.0",
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30
  };
  return {
    ...base,
    anchor_fingerprint: digest(base)
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
    anchor: codexAnchor(),
    observation_checkpoint: { safe_resume_offset_bytes: 30 },
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

function approvalNotification(
  owner: TerminalWatch,
  route: CallbackRouteV1 = createLegacyOpenClawCallbackRoute({
    controllerSessionId: owner.openclaw_session,
    gatewayMethod: "chat.send",
    openclawBin: owner.openclaw_bin
  })
): TerminalWatchNotification {
  const notificationId = terminalWatchNotificationId(
    owner.watch_id,
    "approval",
    SHA_B
  );
  const idempotencyKey = terminalWatchNotificationIdempotencyKey(
    owner.watch_id,
    notificationId
  );
  const notification: TerminalWatchNotification = {
    notification_id: notificationId,
    idempotency_key: idempotencyKey,
    kind: "approval",
    evidence_fingerprint: SHA_B,
    reason_code: "approval_required",
    callback_route: route,
    status: "pending",
    attempts: 0,
    created_at: CREATED_AT
  };
  notification.callback_envelope = terminalWatchCallbackEnvelope(
    owner,
    notification,
    route
  );
  return notification;
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
  assert.equal(saved.anchor.anchor_fingerprint, codexAnchor().anchor_fingerprint);
});

test("legacy v1 Watch records without a checkpoint remain readable and upgrade on save", (t) => {
  const storeDir = tempStore(t);
  const watchId = "terminal-watch-legacy-v1";
  const evidence = "c".repeat(64);
  const notificationId = terminalWatchNotificationId(
    watchId,
    "completed",
    evidence
  );
  const created = saveTerminalWatch(
    storeDir,
    watch(watchId),
    { expectedRevision: null }
  );
  const canonical = saveTerminalWatch(storeDir, {
    ...created,
    status: "completed",
    settlement: {
      kind: "completed",
      evidence_fingerprint: evidence,
      observed_at: CREATED_AT,
      reason_code: "anchored_task_completed",
      completion_text: "done"
    },
    notification_outbox: [{
      notification_id: notificationId,
      idempotency_key: terminalWatchNotificationIdempotencyKey(
        watchId,
        notificationId
      ),
      kind: "completed",
      evidence_fingerprint: evidence,
      reason_code: "anchored_task_completed",
      status: "pending",
      attempts: 0,
      created_at: CREATED_AT
    }]
  }, { expectedRevision: terminalWatchRevision(created) });
  const legacy = structuredClone(canonical) as Partial<TerminalWatch>;
  delete legacy.observation_checkpoint;
  const statePath = pathsForTerminalWatch(watchId, storeDir).statePath;
  fs.writeFileSync(statePath, `${JSON.stringify(legacy)}\n`, { mode: 0o600 });

  const loaded = loadTerminalWatch(storeDir, watchId);
  assert.deepEqual(loaded.observation_checkpoint, {
    safe_resume_offset_bytes: loaded.anchor.observed_end_offset_bytes
  });
  const upgraded = saveTerminalWatch(storeDir, loaded, {
    expectedRevision: terminalWatchRevision(loaded)
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(statePath, "utf8")).observation_checkpoint,
    upgraded.observation_checkpoint
  );
});

test("legacy v1 notifications may omit both callback snapshot fields", (t) => {
  const storeDir = tempStore(t);
  const candidate = watch("terminal-watch-legacy-notification");
  const notification = approvalNotification(candidate);
  delete notification.callback_route;
  delete notification.callback_envelope;
  candidate.notification_outbox = [notification];

  const saved = saveTerminalWatch(storeDir, candidate, {
    expectedRevision: null
  });
  assert.equal(
    terminalWatchNotificationCallbackSnapshot(
      saved,
      saved.notification_outbox[0]
    ),
    undefined
  );
  assert.deepEqual(loadTerminalWatch(storeDir, saved.watch_id), saved);
});

test("partial or malformed callback snapshots fail closed on v1 read", (t) => {
  const storeDir = tempStore(t);
  const candidate = watch("terminal-watch-invalid-callback-snapshot");
  candidate.notification_outbox = [approvalNotification(candidate)];
  const saved = saveTerminalWatch(storeDir, candidate, {
    expectedRevision: null
  });
  const statePath = pathsForTerminalWatch(saved.watch_id, storeDir).statePath;
  const fixtures: Array<{
    name: string;
    mutate(notification: Record<string, unknown>): void;
  }> = [
    {
      name: "route only",
      mutate(notification) {
        delete notification.callback_envelope;
      }
    },
    {
      name: "envelope only",
      mutate(notification) {
        delete notification.callback_route;
      }
    },
    {
      name: "malformed route",
      mutate(notification) {
        notification.callback_route = { version: 99 };
      }
    },
    {
      name: "malformed envelope",
      mutate(notification) {
        notification.callback_envelope = {
          ...(notification.callback_envelope as CallbackEnvelopeV1),
          delivery_id: "redirected-delivery"
        };
      }
    },
    {
      name: "redirected controller",
      mutate(notification) {
        const route = {
          ...(notification.callback_route as CallbackRouteV1),
          controller_session_id: "redirected-controller-session"
        };
        const envelope = notification.callback_envelope as CallbackEnvelopeV1;
        notification.callback_route = route;
        notification.callback_envelope = {
          ...envelope,
          route: {
            ...envelope.route,
            controller_session_id: route.controller_session_id
          }
        };
      }
    }
  ];

  for (const fixture of fixtures) {
    const corrupt = structuredClone(saved) as unknown as Record<string, unknown>;
    const notifications = corrupt.notification_outbox as Array<
      Record<string, unknown>
    >;
    fixture.mutate(notifications[0]);
    fs.writeFileSync(statePath, `${JSON.stringify(corrupt)}\n`, { mode: 0o600 });
    assert.throws(
      () => loadTerminalWatch(storeDir, saved.watch_id),
      Error,
      fixture.name
    );
  }
});

test("legacy callback snapshot backfill is legal only while claiming", (t) => {
  const storeDir = tempStore(t);
  const candidate = watch("terminal-watch-backfill-transition");
  const snapshotted = approvalNotification(candidate);
  const legacy = { ...snapshotted };
  delete legacy.callback_route;
  delete legacy.callback_envelope;
  candidate.notification_outbox = [legacy];
  const saved = saveTerminalWatch(storeDir, candidate, {
    expectedRevision: null
  });

  for (const status of ["pending", "delivered"] as const) {
    assert.throws(
      () => saveTerminalWatch(storeDir, {
        ...saved,
        updated_at: "2026-08-21T00:00:01.000Z",
        notification_outbox: [{
          ...snapshotted,
          status,
          ...(status === "delivered"
            ? {
                attempts: 1,
                last_attempt_at: "2026-08-21T00:00:01.000Z",
                delivered_at: "2026-08-21T00:00:01.000Z"
              }
            : {})
        }]
      }, { expectedRevision: terminalWatchRevision(saved) }),
      /backfilled only while claiming/u,
      status
    );
  }
});

test("parsed callback snapshot deep-clones envelope metadata", () => {
  const owner = watch("terminal-watch-callback-clone");
  const notification = approvalNotification(owner);
  owner.notification_outbox = [notification];
  const snapshot = terminalWatchNotificationCallbackSnapshot(
    owner,
    notification
  );
  assert.ok(snapshot);
  assert.notEqual(snapshot.envelope, notification.callback_envelope);
  assert.notEqual(
    snapshot.envelope.event.metadata,
    notification.callback_envelope?.event.metadata
  );
  snapshot.envelope.event.metadata!.agent = "mutated-after-parse";
  assert.equal(notification.callback_envelope?.event.metadata?.agent, "codex");
});

test("callback route, profile, and envelope body are immutable after snapshot", (t) => {
  const storeDir = tempStore(t);
  const candidate = watch("terminal-watch-immutable-callback-snapshot");
  candidate.notification_outbox = [approvalNotification(candidate)];
  const saved = saveTerminalWatch(storeDir, candidate, {
    expectedRevision: null
  });
  const original = saved.notification_outbox[0];
  const changedRoute = {
    ...original.callback_route!,
    profile_revision: "sha256:changed-profile"
  };
  const changedEnvelope = createCallbackEnvelope({
    route: changedRoute,
    deliveryId: original.notification_id,
    idempotencyKey: original.idempotency_key,
    source: original.callback_envelope!.source,
    event: original.callback_envelope!.event
  });

  assert.throws(
    () => saveTerminalWatch(storeDir, {
      ...saved,
      updated_at: "2026-08-21T00:00:01.000Z",
      notification_outbox: [{
        ...original,
        callback_route: changedRoute,
        callback_envelope: changedEnvelope,
        status: "delivering",
        attempts: 1,
        last_attempt_at: "2026-08-21T00:00:01.000Z",
        attempt_id: "attempt-route-drift",
        attempt_lease_expires_at: "2026-08-21T00:00:31.000Z"
      }]
    }, { expectedRevision: terminalWatchRevision(saved) }),
    /immutable callback_route/u
  );

  assert.throws(
    () => saveTerminalWatch(storeDir, {
      ...saved,
      updated_at: "2026-08-21T00:00:01.000Z",
      notification_outbox: [{
        ...original,
        callback_envelope: {
          ...original.callback_envelope!,
          event: {
            ...original.callback_envelope!.event,
            body: "drifted callback body"
          }
        },
        status: "delivering",
        attempts: 1,
        last_attempt_at: "2026-08-21T00:00:01.000Z",
        attempt_id: "attempt-body-drift",
        attempt_lease_expires_at: "2026-08-21T00:00:31.000Z"
      }]
    }, { expectedRevision: terminalWatchRevision(saved) }),
    /(?:immutable callback_envelope|snapshot does not match)/u
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

  const nestedUnknown = watch();
  nestedUnknown.terminal = {
    ...nestedUnknown.terminal,
    toString: "must-not-pass-via-Object-prototype"
  } as unknown as TerminalWatchTerminalIdentity;
  assert.throws(
    () => assertTerminalWatch(nestedUnknown, undefined, {
      allowMissingRevision: true
    }),
    /unsupported field toString/u
  );

  fs.writeFileSync(paths.statePath, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(paths.root, "unknown.txt"), "unknown\n", {
    mode: 0o600
  });
  assert.throws(() => listTerminalWatches(storeDir), /unknown file/u);
  assert.throws(
    () => scanTerminalWatchesForReconciliation(storeDir),
    /unknown file/u
  );
});

test("reconciliation scan isolates one malformed named JSON record", (t) => {
  const storeDir = tempStore(t);
  const invalid = saveTerminalWatch(
    storeDir,
    watch("terminal-watch-invalid-record"),
    { expectedRevision: null }
  );
  const healthy = saveTerminalWatch(
    storeDir,
    watch("terminal-watch-healthy-record"),
    { expectedRevision: null }
  );
  fs.writeFileSync(
    pathsForTerminalWatch(invalid.watch_id, storeDir).statePath,
    "{not-json}\n",
    { mode: 0o600 }
  );

  assert.throws(() => listTerminalWatches(storeDir), SyntaxError);
  assert.deepEqual(scanTerminalWatchesForReconciliation(storeDir), {
    watches: [healthy],
    errors: [{
      watch_id: invalid.watch_id,
      error_code: "terminal_watch_record_invalid"
    }]
  });
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

test("Claude terminal Watch anchor and legacy checkpoint round-trip", (t) => {
  const identity = terminal("claude");
  const transcript = {
    relative_path: `project/${THREAD_ID}.jsonl`,
    device: "56",
    inode: "78"
  };
  const transcriptFileId = createHash("sha256")
    .update(`${THREAD_ID}\0${transcript.device}:${transcript.inode}`)
    .digest("hex")
    .slice(0, 24);
  const base = {
    schema: "agent-knock-knock/claude-human-started-active-task-anchor" as const,
    version: 1 as const,
    session_id: THREAD_ID,
    cwd: identity.workspace,
    pid: 701,
    agent_started_at_ms: 1_777_000_000_000,
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
  const anchor: ClaudeHumanStartedActiveTaskAnchor = {
    ...base,
    anchor_fingerprint: digest(base)
  };
  const value: TerminalWatch = {
    ...watch("terminal-watch-claude-fixture"),
    agent: "claude",
    terminal: identity,
    anchor,
    observation_checkpoint: initialTerminalWatchObservationCheckpoint(anchor)
  };
  assert.doesNotThrow(() =>
    assertTerminalWatch(value, value.watch_id, { allowMissingRevision: true })
  );
  assert.deepEqual(value.anchor, anchor);
  const storeDir = tempStore(t);
  const saved = saveTerminalWatch(storeDir, value, { expectedRevision: null });
  const legacy = structuredClone(saved) as Partial<TerminalWatch>;
  delete legacy.observation_checkpoint;
  fs.writeFileSync(
    pathsForTerminalWatch(saved.watch_id, storeDir).statePath,
    `${JSON.stringify(legacy)}\n`,
    { mode: 0o600 }
  );
  const loaded = loadTerminalWatch(storeDir, saved.watch_id);
  assert.equal(
    loaded.observation_checkpoint.safe_resume_offset_bytes,
    anchor.turn_start_offset_bytes
  );
  assert.equal(
    "schema" in loaded.observation_checkpoint
      ? loaded.observation_checkpoint.schema
      : undefined,
    "agent-knock-knock/claude-human-started-active-task-checkpoint"
  );
});

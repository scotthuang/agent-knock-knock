import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTerminalWatchStore,
  terminalWatchRevision,
  type CodexTerminalWatchAnchor,
  type TerminalWatch,
  type TerminalWatchTerminalIdentity
} from "../src/terminal-watch-store.js";
import {
  ActiveTerminalWatchConflictError,
  createTerminalWatchService,
  terminalWatchObservationFence,
  type CreateTerminalWatchInput,
  type TerminalWatchObservation,
  type TerminalWatchService
} from "../src/terminal-watch-service.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const START = "2026-08-21T00:00:00.000Z";
const REQUEST_HASH = "a".repeat(64);
const APPROVAL_FINGERPRINT = "b".repeat(64);
const COMPLETION_FINGERPRINT = "c".repeat(64);

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactInput(
  overrides: Partial<CreateTerminalWatchInput> = {}
): CreateTerminalWatchInput {
  const terminal: TerminalWatchTerminalIdentity = {
    terminal_id: "terminal:v2:service-fixture",
    terminal_endpoint: terminalControlEvidence({
      kind: "herdr",
      target: "workspace-1/tab-1/pane-1",
      socketPath: "/tmp/herdr-watch-service.sock",
      session: "herdr-session",
      panePid: 800,
      currentCommand: "codex",
      currentPath: "/workspace/project",
      capabilities: ["screen_status", "durable_completion"],
      sessionDir: "/tmp/herdr-session",
      workspaceId: "workspace-1",
      tabId: "tab-1",
      paneId: "pane-1",
      terminalId: "terminal-resource-service"
    }),
    agent_pid: 801,
    process_uuid: "codex-process-service",
    process_birth: "codex-birth-service",
    native_thread_id: THREAD_ID,
    workspace: "/workspace/project",
    binding_token: "d".repeat(64),
    agent_version: "0.148.0",
    behavior_profile: "codex-0.148.0-exact"
  };
  const rollout = {
    fd: "9",
    device: "90",
    inode: "91",
    path: "/workspace/project/rollout.jsonl"
  };
  const providerAnchor = {
    schema: "agent-knock-knock/codex-human-started-active-task-anchor",
    version: 1,
    native_thread_id: terminal.native_thread_id,
    process_uuid: terminal.process_uuid,
    process_birth: terminal.process_birth,
    captured_at: START,
    rollout,
    turn_id: TASK_ID,
    request_hash: REQUEST_HASH,
    codex_version: terminal.agent_version,
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30
  };
  const anchor: CodexTerminalWatchAnchor = {
    kind: "codex_rollout",
    native_task_id: TASK_ID,
    captured_at: START,
    request_hash: REQUEST_HASH,
    codex_version: terminal.agent_version,
    rollout,
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30,
    evidence_fingerprint: digest(providerAnchor)
  };
  return {
    watch_id: "terminal-watch-service-fixture",
    agent: "codex",
    terminal,
    anchor,
    openclaw_session: "openclaw-service-session",
    openclaw_bin: "/usr/local/bin/openclaw",
    timeout_ms: 60_000,
    ...overrides
  };
}

interface Harness {
  service: TerminalWatchService;
  restart(): TerminalWatchService;
  advance(milliseconds: number): void;
  observations: Array<(watch: TerminalWatch) => TerminalWatchObservation>;
  deliveries: Array<{
    id: string;
    key: string;
    kind: string;
    settlementText?: string;
  }>;
  deliveryOutcomes: Array<"success" | "failure">;
  observeCalls(): number;
}

function harness(t: test.TestContext): Harness {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-watch-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const storeDir = path.join(directory, "store");
  const repository = createTerminalWatchStore(storeDir, {
    acquire: () => () => {}
  });
  let nowMs = Date.parse(START);
  let nonce = 0;
  let observeCalls = 0;
  const observations: Harness["observations"] = [];
  const deliveries: Harness["deliveries"] = [];
  const deliveryOutcomes: Harness["deliveryOutcomes"] = [];
  const makeService = () => createTerminalWatchService({
    repository,
    now: () => new Date(nowMs),
    randomUUID: () => `nonce-${++nonce}`,
    observe: async (watch) => {
      observeCalls += 1;
      const next = observations.shift();
      return next
        ? next(watch)
        : {
            ...terminalWatchObservationFence(watch),
            kind: "pending",
            observed_at: new Date(nowMs).toISOString()
          };
    },
    deliver: async ({ watch, notification, idempotencyKey }) => {
      deliveries.push({
        id: notification.notification_id,
        key: idempotencyKey,
        kind: notification.kind,
        settlementText: watch.settlement?.completion_text
      });
      if (deliveryOutcomes.shift() === "failure") {
        throw new Error("sensitive transport failure detail");
      }
    },
    notificationLeaseMs: 1_000,
    notificationRetryDelayMs: 500,
    classifyDeliveryError: () => "transport_failed"
  });
  let service = makeService();
  return {
    get service() {
      return service;
    },
    restart() {
      service = makeService();
      return service;
    },
    advance(milliseconds) {
      nowMs += milliseconds;
    },
    observations,
    deliveries,
    deliveryOutcomes,
    observeCalls: () => observeCalls
  };
}

function observed(
  watch: TerminalWatch,
  kind: TerminalWatchObservation["kind"],
  timestamp: string,
  detail: Record<string, unknown> = {}
): TerminalWatchObservation {
  return {
    ...terminalWatchObservationFence(watch),
    kind,
    observed_at: timestamp,
    ...detail
  } as TerminalWatchObservation;
}

test("service create/list survives restart and rejects a duplicate active task", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  assert.equal(created.revision, 1);
  assert.deepEqual(state.service.list(), [created]);

  const restarted = state.restart();
  assert.deepEqual(restarted.get(created.watch_id), created);
  const summary = await restarted.reconcileAll();
  assert.deepEqual(summary, {
    checked: 1,
    changed: 0,
    callbacks_delivered: 0,
    errors: 0,
    items: [{
      watch_id: created.watch_id,
      status: "active",
      changed: false,
      callbacks_delivered: 0,
      error_code: undefined
    }]
  });
  assert.throws(
    () => restarted.create(exactInput({ watch_id: "terminal-watch-duplicate" })),
    ActiveTerminalWatchConflictError
  );
});

test("approval remains active and enqueues once per exact fingerprint", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const at = "2026-08-21T00:00:01.000Z";
  state.observations.push(
    (watch) => observed(watch, "approval", at, {
      evidence_fingerprint: APPROVAL_FINGERPRINT,
      reason_code: "approval_required"
    }),
    (watch) => observed(watch, "approval", at, {
      evidence_fingerprint: APPROVAL_FINGERPRINT,
      reason_code: "approval_required"
    })
  );
  const approval = await state.service.reconcile(created.watch_id);
  assert.equal(approval.status, "active");
  assert.equal(approval.notification_outbox.length, 1);
  const duplicate = await state.service.reconcile(created.watch_id);
  assert.equal(terminalWatchRevision(duplicate), terminalWatchRevision(approval));
  assert.equal(duplicate.notification_outbox.length, 1);

  const delivered = await state.service.deliverNextNotification(created.watch_id);
  assert.equal(delivered.status, "delivered");
  assert.equal(state.deliveries.length, 1);
  assert.equal(
    (await state.service.deliverNextNotification(created.watch_id)).status,
    "none"
  );
});

test("completion settles once, retains bounded result, and callback reads settlement", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(2_000);
  const at = "2026-08-21T00:00:02.000Z";
  state.observations.push((watch) => observed(watch, "completed", at, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    reason_code: "native_task_completed",
    completion_text: "redacted completion",
    completion_id: TASK_ID,
    completion_timestamp: at
  }));
  const completed = await state.service.reconcile(created.watch_id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.settlement?.completion_text, "redacted completion");
  assert.equal(completed.notification_outbox.length, 1);
  assert.equal(
    terminalWatchRevision(await state.service.reconcile(created.watch_id)),
    terminalWatchRevision(completed)
  );
  assert.equal(
    (await state.service.deliverNextNotification(created.watch_id)).status,
    "delivered"
  );
  assert.equal(state.deliveries[0].settlementText, "redacted completion");
});

test("terminal settlement supersedes every undelivered approval before callback delivery", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const approvalAt = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "approval", approvalAt, {
    evidence_fingerprint: APPROVAL_FINGERPRINT,
    reason_code: "approval_required"
  }));
  const approval = await state.service.reconcile(created.watch_id);
  assert.equal(approval.notification_outbox[0].status, "pending");

  state.advance(500);
  const completedAt = "2026-08-21T00:00:01.500Z";
  state.observations.push((watch) => observed(watch, "completed", completedAt, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    reason_code: "native_task_completed",
    completion_text: "completion wins over stale approval",
    completion_id: TASK_ID,
    completion_timestamp: completedAt
  }));
  const completed = await state.service.reconcile(created.watch_id);
  assert.deepEqual(
    completed.notification_outbox.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "approval", status: "superseded" },
      { kind: "completed", status: "pending" }
    ]
  );

  assert.equal(
    (await state.service.deliverNextNotification(created.watch_id)).status,
    "delivered"
  );
  assert.deepEqual(state.deliveries.map(({ kind }) => kind), ["completed"]);
  assert.equal(
    state.deliveries[0].settlementText,
    "completion wins over stale approval"
  );
  assert.equal(
    (await state.service.deliverNextNotification(created.watch_id)).status,
    "none"
  );
});

test("a claimed approval serializes terminal settlement callback delivery", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const approvalAt = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "approval", approvalAt, {
    evidence_fingerprint: APPROVAL_FINGERPRINT,
    reason_code: "approval_required"
  }));
  await state.service.reconcile(created.watch_id);
  const approvalClaim = state.service.claimNextNotification(created.watch_id);
  assert.ok(approvalClaim);

  state.advance(500);
  const completedAt = "2026-08-21T00:00:01.500Z";
  state.observations.push((watch) => observed(watch, "completed", completedAt, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    reason_code: "native_task_completed",
    completion_text: "serialized completion",
    completion_id: TASK_ID,
    completion_timestamp: completedAt
  }));
  const completed = await state.service.reconcile(created.watch_id);
  assert.deepEqual(
    completed.notification_outbox.map(({ kind, status }) => ({ kind, status })),
    [
      { kind: "approval", status: "delivering" },
      { kind: "completed", status: "pending" }
    ]
  );
  assert.equal(
    state.service.claimNextNotification(created.watch_id),
    undefined,
    "a later completion cannot overtake an in-flight approval"
  );
  assert.equal(
    state.service.finishNotification(
      created.watch_id,
      approvalClaim.notification.notification_id,
      approvalClaim.attempt_id,
      { delivered: true }
    ).settled,
    true
  );
  assert.equal(
    (await state.service.deliverNextNotification(created.watch_id)).status,
    "delivered"
  );
  assert.deepEqual(state.deliveries.map(({ kind }) => kind), ["completed"]);
});

test("settlement supersedes an expired approval claim before crash recovery", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const approvalAt = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "approval", approvalAt, {
    evidence_fingerprint: APPROVAL_FINGERPRINT,
    reason_code: "approval_required"
  }));
  await state.service.reconcile(created.watch_id);
  assert.ok(state.service.claimNextNotification(created.watch_id));

  state.advance(500);
  const completedAt = "2026-08-21T00:00:01.500Z";
  state.observations.push((watch) => observed(watch, "completed", completedAt, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    reason_code: "native_task_completed",
    completion_text: "completion after crashed approval sender",
    completion_id: TASK_ID,
    completion_timestamp: completedAt
  }));
  await state.service.reconcile(created.watch_id);
  state.advance(600);

  const recovered = state.restart().claimNextNotification(created.watch_id);
  assert.ok(recovered);
  assert.equal(recovered.notification.kind, "completed");
  assert.deepEqual(
    recovered.watch.notification_outbox.map(({ kind, status }) => ({
      kind,
      status
    })),
    [
      { kind: "approval", status: "superseded" },
      { kind: "completed", status: "delivering" }
    ]
  );
});

test("deadline wins without observing the terminal", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({ timeout_ms: 1_000 }));
  state.advance(1_000);
  const timedOut = await state.service.reconcile(created.watch_id);
  assert.equal(timedOut.status, "timed_out");
  assert.equal(timedOut.settlement?.reason_code, "deadline_elapsed");
  assert.equal(state.observeCalls(), 0);
  assert.equal(timedOut.notification_outbox.length, 1);
});

test("cancel is idempotent and has no terminal mutation effect port", (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  const cancelled = state.service.cancel(created.watch_id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.settlement?.reason_code, "manual_cancel");
  assert.equal(state.observeCalls(), 0);
  assert.equal(
    terminalWatchRevision(state.service.cancel(created.watch_id)),
    terminalWatchRevision(cancelled)
  );
});

test("expired delivery claim retries with one deterministic notification identity", (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  const first = state.service.claimNextNotification(created.watch_id);
  assert.ok(first);
  assert.equal(first.notification.attempts, 1);
  assert.equal(state.restart().claimNextNotification(created.watch_id), undefined);

  state.advance(1_001);
  const second = state.restart().claimNextNotification(created.watch_id);
  assert.ok(second);
  assert.equal(second.notification.attempts, 2);
  assert.equal(second.notification.notification_id, first.notification.notification_id);
  assert.equal(second.notification.idempotency_key, first.notification.idempotency_key);
  assert.notEqual(second.attempt_id, first.attempt_id);
});

test("failed callback persists retry and reuses the same idempotency key", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  state.deliveryOutcomes.push("failure", "success");
  const failed = await state.service.deliverNextNotification(created.watch_id);
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.watch.notification_outbox[0].last_error_code,
    "transport_failed"
  );
  assert.equal(
    (await state.restart().deliverNextNotification(created.watch_id)).status,
    "none"
  );

  state.advance(500);
  const delivered = await state.restart().deliverNextNotification(created.watch_id);
  assert.equal(delivered.status, "delivered");
  assert.equal(state.deliveries.length, 2);
  assert.equal(state.deliveries[0].key, state.deliveries[1].key);
  assert.equal(delivered.watch.notification_outbox[0].attempts, 2);
});

test("reconcileAll reports settlement and delivered callback after restart", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(3_000);
  const at = "2026-08-21T00:00:03.000Z";
  state.observations.push((watch) => observed(watch, "failed", at, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    reason_code: "native_task_failed",
    completion_text: "redacted failure",
    completion_id: TASK_ID,
    completion_timestamp: at
  }));
  const summary = await state.restart().reconcileAll();
  assert.equal(summary.checked, 1);
  assert.equal(summary.changed, 1);
  assert.equal(summary.callbacks_delivered, 1);
  assert.equal(summary.errors, 0);
  assert.deepEqual(summary.items[0], {
    watch_id: created.watch_id,
    status: "failed",
    changed: true,
    callbacks_delivered: 1,
    error_code: undefined
  });
});

test("restart drains a durable callback even when live observation fails", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  state.observations.push(() => {
    throw new Error("terminal temporarily unavailable");
  });
  const summary = await state.restart().reconcileAll();
  assert.equal(summary.checked, 1);
  assert.equal(summary.changed, 1);
  assert.equal(summary.callbacks_delivered, 1);
  assert.equal(summary.errors, 1);
  assert.equal(summary.items[0].status, "active");
  assert.equal(
    state.service.get(created.watch_id).notification_outbox[0].status,
    "delivered"
  );
});

test("completion text over 4k fails before durable settlement", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const at = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "completed", at, {
    evidence_fingerprint: COMPLETION_FINGERPRINT,
    completion_text: "x".repeat(4001)
  }));
  await assert.rejects(
    () => state.service.reconcile(created.watch_id),
    /completion text exceeds/u
  );
  assert.equal(state.service.get(created.watch_id).status, "active");
});

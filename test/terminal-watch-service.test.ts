import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CallbackAttemptOutcome,
  CallbackEnvelopeV1,
  CallbackRouteV1,
  CallbackTransportAttemptV1
} from "../src/callback-transport.js";
import {
  createTerminalWatchStore,
  pathsForTerminalWatch,
  terminalWatchNotificationCallbackSnapshot,
  terminalWatchRevision,
  type TerminalWatch,
  type TerminalWatchTerminalIdentity
} from "../src/terminal-watch-store.js";
import {
  resolveTerminalWatchOpenClawCallback
} from "../src/terminal-watch-callback-cli-adapter.js";
import type { CodexHumanStartedActiveTaskAnchor } from
  "../src/terminal-submission-acceptance.js";
import {
  ActiveTerminalWatchConflictError,
  createTerminalWatchService,
  terminalWatchObservationFence,
  type CreateTerminalWatchInput,
  type TerminalWatchCallbackResolution,
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
    workspace: "/workspace/project",
    binding_token: "d".repeat(64)
  };
  const rollout = {
    fd: "9",
    device: "90",
    inode: "91",
    path: "/workspace/project/rollout.jsonl"
  };
  const providerAnchor = {
    schema: "agent-knock-knock/codex-human-started-active-task-anchor" as const,
    version: 1 as const,
    native_thread_id: THREAD_ID,
    process_uuid: "codex-process-service",
    process_birth: "codex-birth-service",
    captured_at: START,
    rollout,
    turn_id: TASK_ID,
    request_hash: REQUEST_HASH,
    codex_version: "0.148.0",
    task_started_offset_bytes: 10,
    user_message_offset_bytes: 20,
    observed_end_offset_bytes: 30
  };
  const anchor: CodexHumanStartedActiveTaskAnchor = {
    ...providerAnchor,
    anchor_fingerprint: digest(providerAnchor)
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
  storeDir: string;
  restart(): TerminalWatchService;
  advance(milliseconds: number): void;
  observations: Array<(watch: TerminalWatch) => TerminalWatchObservation>;
  deliveries: Array<{
    id: string;
    key: string;
    kind: string;
    watchId: string;
    settlementText?: string;
    route: CallbackRouteV1;
    envelope: CallbackEnvelopeV1;
    attempt: CallbackTransportAttemptV1;
  }>;
  deliveryOutcomes: Array<
    | "success"
    | "failure"
    | "permanent"
    | "uncertain"
    | "throw"
    | "malformed"
    | ((
        reportCheckpoint?: (outcome: CallbackAttemptOutcome) => void
      ) => Promise<void>)
  >;
  observeCalls(): number;
}

function harness(
  t: test.TestContext,
  policy: {
    notificationMaxRetryDelayMs?: number;
    resolveCallback?: (watch: TerminalWatch) =>
      TerminalWatchCallbackResolution;
  } = {}
): Harness {
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
    resolveCallback:
      policy.resolveCallback ?? resolveTerminalWatchOpenClawCallback,
    deliver: async ({
      route,
      envelope,
      attempt,
      reportCheckpoint
    }): Promise<CallbackAttemptOutcome> => {
      assert.equal(envelope.source.kind, "terminal_watch");
      const eventKind = envelope.event.type === "approval_required"
        ? "approval"
        : envelope.event.type;
      deliveries.push({
        id: envelope.delivery_id,
        key: envelope.idempotency_key,
        kind: eventKind,
        watchId: envelope.source.watch_id,
        settlementText: boundedCompletionText(envelope.event.body),
        route,
        envelope,
        attempt
      });
      const outcome = deliveryOutcomes.shift();
      if (typeof outcome === "function") await outcome(reportCheckpoint);
      if (outcome === "throw") {
        throw new Error("transport crashed after invocation");
      }
      if (outcome === "malformed") {
        return undefined as unknown as CallbackAttemptOutcome;
      }
      if (outcome === "failure") {
        return {
          disposition: "retryable_failure",
          error_code: "transport_failed"
        };
      }
      if (outcome === "permanent") {
        return {
          disposition: "permanent_failure",
          error_code: "profile_removed"
        };
      }
      if (outcome === "uncertain") {
        return {
          disposition: "uncertain",
          error_code: "acknowledgement_malformed",
          observed_at: new Date(nowMs).toISOString()
        };
      }
      return {
        disposition: "accepted",
        accepted_at: new Date(nowMs).toISOString(),
        acceptance_id: envelope.delivery_id
      };
    },
    notificationLeaseMs: 1_000,
    notificationRetryDelayMs: 500,
    notificationMaxRetryDelayMs: policy.notificationMaxRetryDelayMs,
    classifyDeliveryError: () => "transport_failed"
  });
  let service = makeService();
  return {
    get service() {
      return service;
    },
    storeDir,
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

function boundedCompletionText(body: string): string | undefined {
  return body.split("\nBounded completion text:\n")[1];
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

  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal(
    state.deliveries[0].route.transport,
    "openclaw_gateway_v1"
  );
  assert.equal(
    state.deliveries[0].route.controller_session_id,
    created.openclaw_session
  );
  assert.equal(
    state.deliveries[0].route.profile_id,
    "legacy-openclaw-cli"
  );
  assert.match(
    state.deliveries[0].route.profile_revision,
    /^sha256:[0-9a-f]{64}$/u
  );
  assert.deepEqual(state.deliveries[0].route.capabilities, {
    wake: true,
    respond: false
  });
  assert.equal(state.deliveries[0].envelope.source.kind, "terminal_watch");
  assert.equal(state.deliveries[0].envelope.event.type, "approval_required");
  assert.equal(
    state.deliveries[0].envelope.idempotency_key,
    approval.notification_outbox[0].idempotency_key
  );
  assert.match(
    state.deliveries[0].envelope.event.body,
    /Do not call any AKK approval tool or action/u
  );
  assert.deepEqual(state.deliveries[0].attempt, {
    number: 1,
    id: "nonce-1"
  });
  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 0);
});

test("pending observations advance only the durable provider checkpoint", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const observedAt = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "pending", observedAt, {
    safe_resume_offset_bytes: 48
  }));
  const advanced = await state.service.reconcile(created.watch_id);
  assert.deepEqual(advanced.observation_checkpoint, {
    safe_resume_offset_bytes: 48
  });
  assert.equal(advanced.last_activity_at, observedAt);

  const revision = terminalWatchRevision(advanced);
  state.advance(1_000);
  state.observations.push((watch) => observed(watch, "unavailable",
    "2026-08-21T00:00:02.000Z", {
      reason_code: "provider_temporarily_unavailable"
    }));
  const unavailable = await state.service.reconcile(created.watch_id);
  assert.equal(unavailable.status, "active");
  assert.equal(terminalWatchRevision(unavailable), revision);
  assert.deepEqual(unavailable.observation_checkpoint,
    advanced.observation_checkpoint);

  state.advance(1_000);
  state.observations.push((watch) => observed(watch, "unavailable",
    "2026-08-21T00:00:03.000Z", {
      reason_code: "terminal_observation_unavailable",
      safe_resume_offset_bytes: 64
    }));
  const progressedWhileUnavailable = await state.service.reconcile(
    created.watch_id
  );
  assert.equal(progressedWhileUnavailable.status, "active");
  assert.deepEqual(progressedWhileUnavailable.observation_checkpoint, {
    safe_resume_offset_bytes: 64
  });
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
  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 1);
  assert.equal(state.deliveries[0].settlementText, "redacted completion");
  const cold = await state.service.reconcileAll();
  assert.equal(cold.checked, 0);
  assert.deepEqual(cold.items, []);
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

  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 1);
  assert.deepEqual(state.deliveries.map(({ kind }) => kind), ["completed"]);
  assert.equal(
    state.deliveries[0].settlementText,
    "completion wins over stale approval"
  );
  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 0);
});

test("claimed approval without reason survives later settlement and serializes delivery", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput());
  state.advance(1_000);
  const approvalAt = "2026-08-21T00:00:01.000Z";
  state.observations.push((watch) => observed(watch, "approval", approvalAt, {
    evidence_fingerprint: APPROVAL_FINGERPRINT
  }));
  await state.service.reconcile(created.watch_id);
  let releaseDelivery = () => {};
  let deliveryStarted = () => {};
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  state.deliveryOutcomes.push(async () => {
    deliveryStarted();
    await blocked;
  });
  const draining = state.service.reconcileAll();
  await started;

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
    (await state.restart().reconcileAll()).callbacks_delivered,
    0,
    "a later completion cannot overtake an in-flight approval"
  );
  releaseDelivery();
  assert.equal((await draining).callbacks_delivered, 1);
  assert.equal(
    (await state.restart().reconcileAll()).callbacks_delivered,
    1,
    "one Watch delivers at most one notification in each reconciliation"
  );
  assert.deepEqual(
    state.deliveries.map(({ kind }) => kind),
    ["approval", "completed"]
  );
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
  let releaseDelivery = () => {};
  let deliveryStarted = () => {};
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  state.deliveryOutcomes.push(async () => {
    deliveryStarted();
    await blocked;
  });
  const staleWorker = state.service.reconcileAll();
  await started;

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

  const recovery = await state.restart().reconcileAll();
  assert.equal(recovery.callbacks_delivered, 1);
  const recovered = state.service.get(created.watch_id);
  assert.deepEqual(
    recovered.notification_outbox.map(({ kind, status }) => ({
      kind,
      status
    })),
    [
      { kind: "approval", status: "superseded" },
      { kind: "completed", status: "delivered" }
    ]
  );
  releaseDelivery();
  await staleWorker;
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

test("expired delivery claim retries with one deterministic notification identity", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  let releaseDelivery = () => {};
  let deliveryStarted = () => {};
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  state.deliveryOutcomes.push(async () => {
    deliveryStarted();
    await blocked;
  });
  const staleWorker = state.service.reconcileAll();
  await started;
  const first = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(first.attempts, 1);
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);

  state.advance(1_001);
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 1);
  const second = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(second.attempts, 2);
  assert.equal(second.notification_id, first.notification_id);
  assert.equal(second.idempotency_key, first.idempotency_key);
  assert.notEqual(second.attempt_id, first.attempt_id);
  releaseDelivery();
  await staleWorker;
});

test("legacy pending notification atomically backfills its snapshot before transport", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  const legacy = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(Object.hasOwn(legacy, "callback_route"), false);
  assert.equal(Object.hasOwn(legacy, "callback_envelope"), false);

  let releaseDelivery = () => {};
  let deliveryStarted = () => {};
  const started = new Promise<void>((resolve) => {
    deliveryStarted = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDelivery = resolve;
  });
  state.deliveryOutcomes.push(async () => {
    deliveryStarted();
    await blocked;
  });

  const draining = state.service.reconcileAll();
  await started;
  const claimed = state.service.get(created.watch_id);
  const notification = claimed.notification_outbox[0];
  assert.equal(notification.status, "delivering");
  assert.ok(terminalWatchNotificationCallbackSnapshot(claimed, notification));
  assert.deepEqual(notification.callback_route, state.deliveries[0].route);
  assert.deepEqual(notification.callback_envelope, state.deliveries[0].envelope);

  releaseDelivery();
  await draining;
});

test("native Host Watch keeps its creation route across restart before first delivery", async (t) => {
  let resolverCalls = 0;
  const state = harness(t, {
    resolveCallback(watch) {
      resolverCalls += 1;
      return {
        ...resolveTerminalWatchOpenClawCallback(watch),
        route: {
          ...resolveTerminalWatchOpenClawCallback(watch).route,
          profile_id: "replacement-host",
          profile_revision: "replacement-instance"
        }
      };
    }
  });
  const creationRoute: CallbackRouteV1 = {
    schema: "agent-knock-knock/callback-route",
    version: 1,
    transport: "command_json_v1",
    profile_id: "deepseek-harness-native",
    profile_revision: "initiating-host-instance",
    controller_session_id: "openclaw-service-session",
    capabilities: { wake: true, respond: true }
  };
  const created = state.service.create(exactInput({
    callback_route: creationRoute,
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));

  assert.deepEqual(created.callback_route, creationRoute);
  state.deliveryOutcomes.push("success");
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 1);
  assert.equal(resolverCalls, 0);
  assert.deepEqual(state.deliveries[0]?.route, creationRoute);
  assert.deepEqual(
    state.service.get(created.watch_id).notification_outbox[0]?.callback_route,
    creationRoute
  );
});

test("retry after restart ignores resolver route and profile drift and reuses body", async (t) => {
  let resolverCalls = 0;
  let profileRevision = "profile-before-restart";
  const state = harness(t, {
    resolveCallback(watch) {
      resolverCalls += 1;
      const callback = resolveTerminalWatchOpenClawCallback(watch);
      return {
        ...callback,
        route: {
          ...callback.route,
          profile_revision: profileRevision
        }
      };
    }
  });
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  state.deliveryOutcomes.push("failure");
  await state.service.reconcileAll();

  const failedWatch = state.service.get(created.watch_id);
  const failed = failedWatch.notification_outbox[0];
  const snapshot = terminalWatchNotificationCallbackSnapshot(
    failedWatch,
    failed
  );
  assert.ok(snapshot);
  assert.equal(snapshot.route.profile_revision, "profile-before-restart");
  assert.equal(resolverCalls, 1);

  profileRevision = "profile-after-restart";
  state.advance(500);
  state.deliveryOutcomes.push("success");
  const retried = await state.restart().reconcileAll();
  assert.equal(retried.callbacks_delivered, 1);
  assert.equal(resolverCalls, 1, "a durable snapshot must bypass the resolver");
  assert.equal(state.deliveries.length, 2);
  assert.deepEqual(state.deliveries[1].route, snapshot.route);
  assert.deepEqual(state.deliveries[1].envelope, snapshot.envelope);
  assert.equal(
    state.deliveries[1].envelope.event.body,
    state.deliveries[0].envelope.event.body
  );
});

test("failed callback persists retry and reuses the same idempotency key", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  state.deliveryOutcomes.push("failure", "success");
  const failed = await state.service.reconcileAll();
  assert.equal(failed.errors, 1);
  assert.equal(
    state.service.get(created.watch_id).notification_outbox[0].last_error_code,
    "transport_failed"
  );
  assert.equal(
    (await state.restart().reconcileAll()).callbacks_delivered,
    0
  );

  state.advance(500);
  const delivered = await state.restart().reconcileAll();
  assert.equal(delivered.callbacks_delivered, 1);
  assert.equal(state.deliveries.length, 2);
  assert.equal(state.deliveries[0].key, state.deliveries[1].key);
  assert.equal(state.service.get(created.watch_id).notification_outbox[0].attempts, 2);
});

test("permanent and uncertain callback outcomes fail closed without redelivery", async (t) => {
  for (const [outcome, prefix] of [
    ["permanent", "callback_permanent_"],
    ["uncertain", "callback_uncertain_"]
  ] as const) {
    const state = harness(t);
    const created = state.service.create(exactInput({
      watch_id: `terminal-watch-${outcome}`,
      approval_fingerprint: APPROVAL_FINGERPRINT,
      approval_reason_code: "approval_required"
    }));
    state.deliveryOutcomes.push(outcome);

    const first = await state.service.reconcileAll();
    assert.equal(first.callbacks_delivered, 0);
    assert.equal(first.errors, 1);
    const failed = state.service.get(created.watch_id).notification_outbox[0];
    assert.equal(failed.status, "failed");
    assert.match(failed.last_error_code ?? "", new RegExp(`^${prefix}`, "u"));

    state.advance(5_000);
    assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);
    assert.equal(state.deliveries.length, 1);
    assert.equal(
      state.service.get(created.watch_id).notification_outbox[0].attempts,
      1
    );
  }
});

test("nonretryable approval failure does not starve a distinct later approval", async (t) => {
  for (const [outcome, prefix, nextFingerprint] of [
    ["permanent", "callback_permanent_", "e".repeat(64)],
    ["uncertain", "callback_uncertain_", "f".repeat(64)]
  ] as const) {
    const state = harness(t);
    const created = state.service.create(exactInput({
      watch_id: `terminal-watch-nonretryable-head-${outcome}`,
      approval_fingerprint: APPROVAL_FINGERPRINT,
      approval_reason_code: "approval_required"
    }));
    state.deliveryOutcomes.push(outcome);
    await state.service.reconcileAll();

    const failed = state.service.get(created.watch_id).notification_outbox[0];
    assert.equal(failed.status, "failed");
    assert.equal(failed.attempts, 1);
    assert.match(failed.last_error_code ?? "", new RegExp(`^${prefix}`, "u"));

    state.advance(1_000);
    const approvalAt = "2026-08-21T00:00:01.000Z";
    state.observations.push((watch) => observed(watch, "approval", approvalAt, {
      evidence_fingerprint: nextFingerprint,
      reason_code: "approval_required_again"
    }));
    const queued = await state.service.reconcile(created.watch_id);
    assert.deepEqual(
      queued.notification_outbox.map(({ status, evidence_fingerprint }) => ({
        status,
        evidence_fingerprint
      })),
      [
        { status: "failed", evidence_fingerprint: APPROVAL_FINGERPRINT },
        { status: "pending", evidence_fingerprint: nextFingerprint }
      ]
    );

    state.deliveryOutcomes.push("success");
    const resumed = await state.restart().reconcileAll();
    assert.equal(resumed.callbacks_delivered, 1);
    const settled = state.service.get(created.watch_id).notification_outbox;
    assert.deepEqual(settled[0], failed, "old failure evidence must be retained");
    assert.equal(settled[1].status, "delivered");
    assert.equal(settled[1].attempts, 1);
    assert.deepEqual(
      state.deliveries.map(({ id }) => id),
      [failed.notification_id, settled[1].notification_id]
    );

    state.advance(5_000);
    await state.restart().reconcileAll();
    assert.equal(state.deliveries.length, 2, "the old failure must not retry");
    assert.deepEqual(
      state.service.get(created.watch_id).notification_outbox[0],
      failed
    );
  }
});

test("route resolution fails permanently before callback transport", async (t) => {
  const state = harness(t, {
    resolveCallback() {
      throw new Error("route profile no longer exists");
    }
  });
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));

  const first = await state.service.reconcileAll();
  assert.equal(first.callbacks_delivered, 0);
  assert.equal(first.errors, 1);
  const failed = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.last_error_code,
    "callback_permanent_callback_route_resolution_failed"
  );
  assert.equal(state.deliveries.length, 0);

  state.advance(5_000);
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);
  assert.equal(state.deliveries.length, 0);
  assert.equal(
    state.service.get(created.watch_id).notification_outbox[0].attempts,
    1
  );
});

test("callback request construction fails permanently before transport", async (t) => {
  const state = harness(t, {
    resolveCallback(watch) {
      const callback = resolveTerminalWatchOpenClawCallback(watch);
      return {
        ...callback,
        route: {
          ...callback.route,
          version: 99
        } as unknown as CallbackRouteV1
      };
    }
  });
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));

  const first = await state.service.reconcileAll();
  assert.equal(first.callbacks_delivered, 0);
  assert.equal(first.errors, 1);
  const failed = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.last_error_code,
    "callback_permanent_callback_request_construction_failed"
  );
  assert.equal(state.deliveries.length, 0);

  state.advance(5_000);
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);
  assert.equal(state.deliveries.length, 0);
  assert.equal(
    state.service.get(created.watch_id).notification_outbox[0].attempts,
    1
  );
});

test("transport throws and malformed outcomes are uncertain without retry", async (t) => {
  for (const transportOutcome of ["throw", "malformed"] as const) {
    const state = harness(t);
    const created = state.service.create(exactInput({
      watch_id: `terminal-watch-${transportOutcome}`,
      approval_fingerprint: APPROVAL_FINGERPRINT,
      approval_reason_code: "approval_required"
    }));
    state.deliveryOutcomes.push(transportOutcome);

    const first = await state.service.reconcileAll();
    assert.equal(first.callbacks_delivered, 0);
    assert.equal(first.errors, 1);
    const failed = state.service.get(created.watch_id).notification_outbox[0];
    assert.equal(failed.status, "failed");
    assert.match(failed.last_error_code ?? "", /^callback_uncertain_/u);

    state.advance(5_000);
    assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);
    assert.equal(state.deliveries.length, 1);
    assert.equal(
      state.service.get(created.watch_id).notification_outbox[0].attempts,
      1
    );
  }
});

test("accepted checkpoint durably settles before transport returns", async (t) => {
  const state = harness(t);
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  let reportObserved = () => {};
  const reported = new Promise<void>((resolve) => {
    reportObserved = resolve;
  });
  let releaseTransport = () => {};
  const blocked = new Promise<void>((resolve) => {
    releaseTransport = resolve;
  });
  state.deliveryOutcomes.push(async (reportCheckpoint) => {
    assert.ok(reportCheckpoint);
    reportCheckpoint({
      disposition: "accepted",
      accepted_at: START,
      acceptance_id: "transport-acceptance-1"
    });
    reportObserved();
    await blocked;
    throw new Error("transport crashed after accepted checkpoint");
  });

  const draining = state.service.reconcileAll();
  await reported;
  const checkpointed = state.service.get(created.watch_id)
    .notification_outbox[0];
  assert.equal(checkpointed.status, "delivered");
  assert.equal(checkpointed.attempts, 1);
  assert.equal((await state.restart().reconcileAll()).callbacks_delivered, 0);

  releaseTransport();
  assert.equal((await draining).callbacks_delivered, 1);
  assert.equal(state.deliveries.length, 1);
  assert.equal(
    state.service.get(created.watch_id).notification_outbox[0].status,
    "delivered"
  );
});

test("callback retries back off with a cap and remain recoverable", async (t) => {
  const state = harness(t, {
    notificationMaxRetryDelayMs: 600
  });
  const created = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  state.deliveryOutcomes.push("failure", "failure", "failure", "success");

  await state.service.reconcileAll();
  let notification = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(notification.next_attempt_at, "2026-08-21T00:00:00.500Z");
  state.advance(500);
  await state.service.reconcileAll();
  notification = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(notification.next_attempt_at, "2026-08-21T00:00:01.100Z");
  state.advance(600);
  await state.service.reconcileAll();
  notification = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(notification.status, "failed");
  assert.equal(notification.attempts, 3);
  assert.equal(notification.next_attempt_at, "2026-08-21T00:00:01.700Z");

  state.advance(600);
  assert.equal((await state.service.reconcileAll()).callbacks_delivered, 1);
  notification = state.service.get(created.watch_id).notification_outbox[0];
  assert.equal(notification.status, "delivered");
  assert.equal(state.deliveries.length, 4);
});

test("callback scheduling is fair after one Watch fails", async (t) => {
  const state = harness(t);
  const first = state.service.create(exactInput({
    approval_fingerprint: APPROVAL_FINGERPRINT,
    approval_reason_code: "approval_required"
  }));
  const secondInput = exactInput({
    watch_id: "terminal-watch-service-second",
    approval_fingerprint: "e".repeat(64),
    approval_reason_code: "approval_required"
  });
  const second = state.service.create({
    ...secondInput,
    terminal: {
      ...secondInput.terminal,
      terminal_id: "terminal:v2:service-fixture-second",
      binding_token: "f".repeat(64)
    }
  });
  state.deliveryOutcomes.push("failure", "success");

  await state.service.reconcileAll();
  assert.equal(state.deliveries[0].watchId, first.watch_id);
  await state.service.reconcileAll();
  assert.equal(state.deliveries[1].watchId, second.watch_id);
});

test("reconcile isolates one malformed named Watch while checking healthy work", async (t) => {
  const state = harness(t);
  const healthy = state.service.create(exactInput());
  const corruptId = "terminal-watch-corrupt-record";
  const corruptPath = pathsForTerminalWatch(corruptId, state.storeDir).statePath;
  fs.writeFileSync(corruptPath, "{bad-json}\n", { mode: 0o600 });

  const summary = await state.service.reconcileAll();
  assert.equal(summary.checked, 2);
  assert.equal(summary.errors, 1);
  assert.equal(summary.items.some((item) =>
    item.watch_id === healthy.watch_id && item.status === "active"
  ), true);
  assert.deepEqual(summary.items.find((item) =>
    item.watch_id === corruptId
  ), {
    watch_id: corruptId,
    status: "error",
    changed: false,
    callbacks_delivered: 0,
    error_code: "terminal_watch_record_invalid"
  });
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

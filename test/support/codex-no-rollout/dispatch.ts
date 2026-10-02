import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../../../src/managed-session.js";
import {
  listDeferredForegroundTransfers,
  type DeferredForegroundTransfer
} from "../../../src/deferred-foreground-transfer.js";
import {
  listManagedSessions,
  loadManagedSession,
  saveManagedSession
} from "../../../src/session-store.js";
import {
  listConversations
} from "../../../src/store.js";
import {
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey
} from "../../../src/terminal-control-ref.js";
import {
  codexNativeAcceptanceEnv,
  codexNoRolloutStoreArgs
} from "../codex-no-rollout-cli-harness.js";
import {
  LIVE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  codexTestComposerScreen,
  type NoRolloutFixture,
  processUuid
} from "./model.js";
import {
  test
} from "./test-registration.js";
import {
  persistStatusCardSession
} from "./sessions.js";
import {
  runCli
} from "./cli.js";

export function readSoleTerminalDispatchLedger(
  fixture: NoRolloutFixture
): Record<string, any> {
  return JSON.parse(
    fs.readFileSync(soleTerminalDispatchLedgerPath(fixture), "utf8")
  );
}

export function soleTerminalDispatchLedgerPath(
  fixture: NoRolloutFixture
): string {
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const paths = fs.existsSync(ledgerDir)
    ? fs.readdirSync(ledgerDir)
        .filter((name) => name.endsWith(".json"))
        .map((name) => path.join(ledgerDir, name))
    : [];
  assert.equal(paths.length, 1, JSON.stringify(paths));
  return paths[0];
}

export async function seedResolvedHistoricalDispatchAndStatusCard(
  fixture: NoRolloutFixture
): Promise<{ source: ManagedSessionState; historicalTurnId: string }> {
  const historicalMessage = "Create one exact resolved historical dispatch.";
  const sent = await runCli([
    "send",
    "--conversation",
    fixture.terminalId,
    "--message",
    historicalMessage,
    "--background",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ], codexNativeAcceptanceEnv(fixture.environment));
  assert.equal(sent.status, 0, sent.stderr || sent.stdout);
  const output = JSON.parse(sent.stdout);
  assert.equal(output.delivered, true, sent.stdout);
  const historicalTurnId = String(output.turn_id);
  const closed = await runCli([
    "close",
    "--turn",
    historicalTurnId,
    "--reason",
    "test-only resolved dispatch history fixture",
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fs.realpathSync(fixture.codexHome)
  ], fixture.environment);
  assert.equal(closed.status, 0, closed.stderr || closed.stdout);
  assert.equal(JSON.parse(closed.stdout).terminal_dispatch_resolved, true);

  const previousSession = loadManagedSession(
    fixture.storeDir,
    String(output.session_id)
  );
  const detachedAt = new Date().toISOString();
  assert.ok(previousSession.binding);
  const retiredBinding = terminalBindingFrom({
    terminalId: previousSession.binding.terminal_id,
    terminalControl: previousSession.binding.terminal_control,
    pid: previousSession.binding.native_process.pid,
    processUuid: previousSession.binding.native_process.process_uuid,
    processBirth: previousSession.binding.native_process.process_birth,
    evidence: "test_resolved_history_retired",
    generation: previousSession.binding.generation + 1,
    now: new Date(detachedAt)
  });
  saveManagedSession(fixture.storeDir, {
    ...previousSession,
    status: "detached",
    binding: retiredBinding,
    detached_at: detachedAt,
    updated_at: detachedAt
  }, { expectedRevision: previousSession.revision as number });
  fs.rmSync(fixture.rolloutPath, { force: true });
  fs.rmSync(fixture.materializedPath, { force: true });
  fs.writeFileSync(fixture.screenPath, codexTestComposerScreen());
  return {
    source: persistStatusCardSession(fixture, LIVE_PROCESS_BIRTH),
    historicalTurnId
  };
}

export function materializePreparedDeferredLedgerWithoutTurnState({
  fixture,
  transfer,
  message
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  message: string;
}): void {
  const binding = transfer.target_before_binding;
  const preparedAt = transfer.target_prepared_at;
  const messageId = transfer.message_id;
  const turnId = transfer.turn_id;
  const statePath = transfer.state_path;
  assert.ok(binding);
  assert.ok(preparedAt);
  assert.ok(messageId);
  assert.ok(turnId);
  assert.ok(statePath);
  saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: transfer.target_session_id,
    agent: "codex",
    workspace: transfer.workspace,
    status: "transitioning",
    binding,
    lineage: {
      created_by: "attach",
      previous_session_id: transfer.source_session_id,
      transition_id: transfer.transfer_id
    },
    last_transition_id: transfer.transfer_id,
    created_at: preparedAt,
    updated_at: preparedAt
  }, { expectedRevision: null });

  const identity = terminalEndpointIdentityFromEvidence(
    transfer.terminal_endpoint
  );
  assert.ok(identity);
  const terminalKey = createHash("sha256")
    .update(terminalEndpointIdentityKey(identity))
    .digest("hex")
    .slice(0, 20);
  const ledgerDir = path.join(
    String(fixture.environment.AKK_RUNTIME_DIR),
    "terminal-dispatch"
  );
  const ledgerPath = path.join(
    ledgerDir,
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(ledgerDir, { recursive: true });
  const control = binding.terminal_control;
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: control.kind,
      target: control.target,
      socket_path: control.socketPath ?? null,
      pane_pid: control.panePid ?? null,
      current_path: control.currentPath ?? null
    },
    terminal_endpoint: transfer.terminal_endpoint,
    status: "prepared",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: transfer.target_session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: createHash("sha256").update(message).digest("hex"),
    request_hash: transfer.request_hash,
    executor_kind: "codex",
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(statePath),
    event_log_path: path.join(path.dirname(statePath), "events.ndjson"),
    deferred_foreground_transfer_id: transfer.transfer_id,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    prepared_at: preparedAt,
    dispatcher_pid: transfer.dispatcher_pid,
    callback_expected: false
  }, null, 2)}\n`, { mode: 0o600 });
}

export function assertExactDeferredZeroInputAbortLedger({
  fixture,
  transfer,
  ledger
}: {
  fixture: NoRolloutFixture;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
}): void {
  const binding = transfer.target_before_binding;
  assert.ok(binding);
  assert.equal(ledger.status, "resolved");
  assert.equal(ledger.safe_to_retry, true);
  assert.equal(ledger.dispatcher_pid, null);
  assert.equal(ledger.deferred_foreground_transfer_id, transfer.transfer_id);
  assert.equal(ledger.generation_id, transfer.message_id);
  assert.equal(ledger.conversation_id, transfer.turn_id);
  assert.equal(ledger.session_id, transfer.target_session_id);
  assert.equal(ledger.turn_id, transfer.turn_id);
  assert.equal(ledger.message_id, transfer.message_id);
  assert.equal(ledger.message_type, "task");
  assert.equal(ledger.request_hash, transfer.request_hash);
  assert.equal(ledger.executor_kind, "codex");
  assert.equal(ledger.binding_id, binding.binding_id);
  assert.equal(ledger.binding_generation, binding.generation);
  assert.equal(ledger.native_thread_id, undefined);
  assert.equal(path.resolve(ledger.store_dir), path.resolve(fixture.storeDir));
  assert.equal(path.resolve(ledger.state_path), path.resolve(String(
    transfer.state_path
  )));
  assert.ok(ledger.aborted_at);
  assert.ok(ledger.resolved_at);
  assert.equal(ledger.aborted_at, ledger.resolved_at);

  const forbiddenInputFields = [
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "submitted_at",
    "agent_accepted_at",
    "not_accepted_at",
    "uncertain_at",
    "acceptance_evidence"
  ];
  for (const field of forbiddenInputFields) {
    assert.equal(ledger[field], undefined, field);
  }
  const receipts = ledger.terminal_submission_receipts;
  assert.ok(Array.isArray(receipts));
  const ownReceipts = receipts.filter(
    (receipt: Record<string, any>) => receipt.message_id === transfer.message_id
  );
  assert.equal(ownReceipts.length, 1, JSON.stringify(receipts, null, 2));
  const receipt = ownReceipts[0];
  assert.equal(receipt.status, "aborted");
  assert.equal(receipt.safe_to_retry, true);
  assert.equal(receipt.aborted_at, ledger.aborted_at);
  assert.equal(receipt.resolved_at, ledger.resolved_at);
  for (const field of [
    "terminal_control",
    "terminal_endpoint",
    "generation_id",
    "conversation_id",
    "session_id",
    "turn_id",
    "message_id",
    "message_type",
    "message_body_hash",
    "request_hash",
    "executor_kind",
    "store_dir",
    "state_path",
    "event_log_path",
    "deferred_foreground_transfer_id",
    "binding_id",
    "binding_generation",
    "native_thread_id",
    "callback_expected",
    "dispatcher_pid"
  ]) {
    assert.deepEqual(receipt[field], ledger[field], field);
  }
  for (const field of forbiddenInputFields) {
    assert.equal(receipt[field], undefined, `receipt ${field}`);
  }
}

export function assertResolvedSameUuidDeferredTransfer({
  fixture,
  sourceSessionId,
  originalBindingId,
  originalGeneration
}: {
  fixture: NoRolloutFixture;
  sourceSessionId: string;
  originalBindingId: string;
  originalGeneration: number;
}): void {
  const transfers = listDeferredForegroundTransfers(fixture.storeDir);
  const transfer = transfers.find((candidate) =>
    candidate.status === "resolved"
  );
  assert.ok(transfer, JSON.stringify(transfers, null, 2));
  assert.equal(transfer.source_retirement, "binding_scrubbed_same_native_thread");
  assert.equal(transfer.target_native_thread_id, NATIVE_THREAD_ID);

  const source = loadManagedSession(fixture.storeDir, sourceSessionId);
  const target = loadManagedSession(
    fixture.storeDir,
    transfer.target_session_id
  );
  assert.equal(source.status, "detached");
  assert.equal(source.binding?.native_thread_id, undefined);
  assert.equal(source.binding?.native_process.rollout, undefined);
  assert.notEqual(source.binding?.binding_id, originalBindingId);
  assert.equal(source.binding?.generation, originalGeneration + 1);
  assert.equal(target.status, "bound");
  assert.equal(target.binding?.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    listManagedSessions(fixture.storeDir).filter(
      (session) => session.binding?.native_thread_id === NATIVE_THREAD_ID
    ).map((session) => session.session_id).join(","),
    target.session_id,
    "the accepted native UUID must have exactly one Store owner"
  );
  const turn = listConversations(fixture.storeDir).find(
    (candidate) => candidate.session_id === target.session_id
  );
  assert.ok(turn);
  assert.equal(turn.native_thread_id, NATIVE_THREAD_ID);
  assert.equal(
    (turn.native_session_takeover as Record<string, any>)
      .terminal_bridge_submission?.status,
    "agent_accepted"
  );
}

export function reconcileArguments(
  fixture: NoRolloutFixture,
  argumentsValue: Record<string, unknown>
): string[] {
  return [
    "reconcile-binding",
    "--terminal",
    String(argumentsValue.terminal_id),
    "--conflicting-session",
    String(argumentsValue.conflicting_session_id),
    "--expected-session-revision",
    String(argumentsValue.expected_session_revision),
    "--expected-binding-token",
    String(argumentsValue.expected_binding_token),
    "--expected-terminal-token",
    String(argumentsValue.expected_terminal_token),
    ...codexNoRolloutStoreArgs(fixture)
  ];
}

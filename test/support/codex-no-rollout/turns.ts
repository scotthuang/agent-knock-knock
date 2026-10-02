import assert from "node:assert/strict";
import {
  createHash
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ManagedSessionState,
  type NativeThreadTransition
} from "../../../src/managed-session.js";
import {
  saveNativeThreadTransition
} from "../../../src/session-store.js";
import {
  pathsForConversation,
  saveState
} from "../../../src/store.js";
import {
  createConversation
} from "../../../src/protocol.js";
import {
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey
} from "../../../src/terminal-control-ref.js";
import {
  LIVE_PROCESS_BIRTH,
  NATIVE_THREAD_ID,
  EXTERNAL_THREAD_ID,
  type NoRolloutFixture,
  processUuid
} from "./model.js";
import {
  test
} from "./test-registration.js";

export function persistBlockingTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  status: "waiting_for_agent" | "stalled" = "waiting_for_agent"
): void {
  const now = new Date("2026-08-06T02:31:00.000Z");
  const base = createConversation({
    userRequest: "This unresolved Turn must block binding reconciliation.",
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-reconcile-blocker",
    now
  });
  const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
  saveState(paths.statePath, {
    ...base,
    status,
    ...(status === "stalled"
      ? {
          stalled_at: now.toISOString(),
          stalled_reason: "test-only unresolved Codex dispatch"
        }
      : {}),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: `message-${base.conversation_id}`,
      terminal_bridge_started_at: now.toISOString(),
      terminal_agent_session_id: NATIVE_THREAD_ID,
      terminal_control: fixture.terminalControl
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: now.toISOString()
  });
}

export function persistLegacyV1UncertainTurn(
  fixture: NoRolloutFixture,
  session: ManagedSessionState,
  message: string
): string {
  const binding = session.binding;
  assert.ok(binding);
  assert.ok(binding.native_thread_id);
  assert.ok(binding.terminal_endpoint);
  const preparedAt = "2026-08-12T01:33:47.000Z";
  const textInjectedAt = "2026-08-12T01:33:47.010Z";
  const enterDispatchedAt = "2026-08-12T01:33:47.020Z";
  const uncertainAt = "2026-08-12T01:33:47.030Z";
  const base = createConversation({
    userRequest: message,
    sessionId: session.session_id,
    executorKind: "codex",
    executorSession: "codex-legacy-v1-uncertain",
    workspace: session.workspace,
    now: new Date(preparedAt)
  });
  const turnId = base.turn_id;
  const messageId = `message-${turnId}`;
  const requestHash = createHash("sha256").update(message).digest("hex");
  const messageBodyHash = createHash("sha256").update(message).digest("hex");
  const paths = pathsForConversation(turnId, fixture.storeDir);
  const submission = {
    status: "uncertain",
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    native_thread_id: binding.native_thread_id,
    terminal_target: fixture.terminalControl.target,
    terminal_socket_path: fixture.terminalControl.socketPath ?? null,
    terminal_pane_pid: fixture.terminalControl.panePid,
    terminal_endpoint: binding.terminal_endpoint,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    last_proven_stage: "enter_dispatched",
    error: "legacy v1 acceptance could not attribute the post-clear rollout"
  };
  saveState(paths.statePath, {
    ...base,
    status: "stalled",
    stalled_at: uncertainAt,
    stalled_reason:
      "terminal submission outcome is uncertain; inspect the shared terminal pane before continuing",
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    native_session_takeover: {
      agent: "codex",
      terminal_agent_identity_protocol: 1,
      native_session_id: fixture.terminalId,
      terminal_agent_pid: fixture.codexPid,
      terminal_agent_session_id: binding.native_thread_id,
      terminal_agent_process_uuid: binding.native_process.process_uuid,
      terminal_agent_process_birth: binding.native_process.process_birth,
      terminal_agent_rollout: binding.native_process.rollout,
      terminal_agent_identity_evidence: binding.native_process.evidence,
      source_cwd: session.workspace,
      strategy: "terminal_control",
      terminal_control: fixture.terminalControl,
      terminal_endpoint: binding.terminal_endpoint,
      terminal_bridge: true,
      terminal_bridge_started_at: preparedAt,
      terminal_bridge_message_id: messageId,
      terminal_bridge_request_text: message,
      terminal_bridge_request_hash: requestHash,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    updated_at: uncertainAt
  });

  const identity = terminalEndpointIdentityFromEvidence(
    binding.terminal_endpoint
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
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 2,
    terminal_key: terminalKey,
    terminal_control: {
      kind: fixture.terminalControl.kind,
      target: fixture.terminalControl.target,
      socket_path: fixture.terminalControl.socketPath ?? null,
      pane_pid: fixture.terminalControl.panePid ?? null,
      current_path: fixture.terminalControl.currentPath ?? null
    },
    terminal_endpoint: binding.terminal_endpoint,
    status: "uncertain",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: session.session_id,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    message_body_hash: messageBodyHash,
    request_hash: requestHash,
    executor_kind: "codex",
    openclaw_session: base.openclaw_session,
    store_dir: path.resolve(fixture.storeDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id,
    prepared_at: preparedAt,
    text_injected_at: textInjectedAt,
    enter_dispatched_at: enterDispatchedAt,
    uncertain_at: uncertainAt,
    dispatcher_pid: process.pid,
    callback_expected: false,
    error: submission.error
  }, null, 2)}\n`, { mode: 0o600 });
  return turnId;
}

export function persistReleasedCandidateSourceTurns(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const statuses = ["idle", "closed", "cancelled", "failed"] as const;
  statuses.forEach((status, index) => {
    const now = new Date(Date.UTC(2026, 7, 12, 1, index, 0));
    const base = createConversation({
      userRequest: `Released candidate history ${status}.`,
      sessionId: session.session_id,
      executorKind: "codex",
      executorSession: `codex-candidate-history-${status}`,
      workspace: session.workspace,
      now
    });
    const paths = pathsForConversation(base.conversation_id, fixture.storeDir);
    saveState(paths.statePath, {
      ...base,
      status,
      ...(status === "idle" ? { idle_since: now.toISOString() } : {}),
      ...(status === "closed"
        ? {
            closed_at: now.toISOString(),
            close_reason: "test-only released candidate history"
          }
        : {}),
      terminal_binding_id: session.binding?.binding_id,
      terminal_binding_generation: session.binding?.generation,
      native_thread_id: session.binding?.native_thread_id,
      native_session_takeover: {
        agent: "codex",
        terminal_agent_identity_protocol: 1,
        native_session_id: fixture.terminalId,
        terminal_agent_pid: fixture.codexPid,
        terminal_agent_session_id: session.binding?.native_thread_id,
        terminal_agent_process_uuid:
          session.binding?.native_process.process_uuid,
        terminal_agent_process_birth:
          session.binding?.native_process.process_birth,
        terminal_agent_rollout: session.binding?.native_process.rollout,
        terminal_agent_identity_evidence:
          session.binding?.native_process.evidence,
        source_cwd: session.workspace,
        strategy: "terminal_control",
        terminal_control: fixture.terminalControl,
        terminal_bridge: true
      },
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath,
      updated_at: now.toISOString()
    });
  });
}

export function persistUnresolvedTransition(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): NativeThreadTransition {
  const preparedAt = new Date("2026-08-06T02:32:00.000Z");
  return saveNativeThreadTransition(fixture.storeDir, {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: "transition-reconcile-blocker",
    operation: "new_thread",
    status: "prepared",
    terminal_id: fixture.terminalId,
    agent: "codex",
    workspace: fixture.terminalControl.currentPath as string,
    source_session_id: session.session_id,
    source_expected_revision: session.revision,
    target_session_id: "session-reconcile-transition-target",
    target_expected_revision: null,
    before_native_thread_id:
      session.binding?.native_thread_id ?? EXTERNAL_THREAD_ID,
    before_process_uuid:
      session.binding?.native_process.process_uuid ??
      processUuid(fixture.codexPid, LIVE_PROCESS_BIRTH),
    before_process_birth:
      session.binding?.native_process.process_birth ?? LIVE_PROCESS_BIRTH,
    before_binding: session.binding,
    adapter_version: "0.146.1",
    command_fingerprint: createHash("sha256")
      .update("fixture-reconcile-transition")
      .digest("hex"),
    dispatcher_pid: process.pid,
    prepared_at: preparedAt.toISOString()
  }, { expectedRevision: null });
}

export function persistUnresolvedDispatchLedger(
  fixture: NoRolloutFixture,
  session: ManagedSessionState
): void {
  const terminalKey = createHash("sha256")
    .update(JSON.stringify({
      target: fixture.terminalControl.target,
      socket_path: null
    }))
    .digest("hex")
    .slice(0, 20);
  const runtimeDir = String(fixture.environment.AKK_RUNTIME_DIR);
  const ledgerPath = path.join(
    runtimeDir,
    "terminal-dispatch",
    `terminal-dispatch-${terminalKey}.json`
  );
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, `${JSON.stringify({
    version: 1,
    terminal_key: terminalKey,
    terminal_control: {
      kind: "tmux",
      target: fixture.terminalControl.target,
      socket_path: null,
      pane_pid: fixture.terminalControl.panePid,
      current_path: fixture.terminalControl.currentPath
    },
    kind: "turn",
    generation_id: "message-reconcile-ledger-blocker",
    conversation_id: `turn-for-${session.session_id}`,
    message_id: "message-reconcile-ledger-blocker",
    status: "uncertain",
    prepared_at: "2026-08-06T02:33:00.000Z",
    uncertain_at: "2026-08-06T02:33:01.000Z"
  })}\n`, { mode: 0o600 });
}

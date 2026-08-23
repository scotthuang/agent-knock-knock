import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { callbackRouteFingerprintForConversation } from
  "../src/callback-route-authority.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import type { DeferredForegroundApplicationScope } from
  "../src/deferred-foreground-boundary.js";
import {
  persistCommittedDeferredForegroundTurnAcceptance,
  recoverAcceptedDeferredForegroundDispatch,
  type DeferredForegroundRecoveryAdapterPorts
} from "../src/deferred-foreground-recovery-cli-adapter.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import {
  MANAGED_SESSION_SCHEMA,
  MANAGED_SESSION_VERSION,
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState,
  type ManagedTerminalBinding
} from "../src/managed-session.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import { pathsForManagedSession } from "../src/session-store.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal
} from "../src/terminal-dispatch-composition.js";
import { terminalSubmissionPayload } from
  "../src/terminal-dispatch-execution.js";
import {
  applyTerminalBridgeSubmission,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "../src/terminal-dispatch-receipt.js";
import { fingerprint } from "../src/terminal-submission-facts.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";
import { ensureStoreWritable, loadState, pathsForConversation } from
  "../src/store.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const PROCESS_UUID = "codex-pid:4242:birth:fixture";
const PROCESS_BIRTH = "fixture";
const T0 = "2026-08-15T00:59:58.000Z";
const T1 = "2026-08-15T01:00:00.000Z";
const T2 = "2026-08-15T01:00:01.000Z";
const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.1",
  socketPath: "/private/tmp/tmux-501/default",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4242,
  currentPath: "/workspace/project",
  capabilities: ["send_keys", "screen_status"]
};

type RecoveryKind = "observed" | "committed";

interface Fixture {
  root: string;
  storeDir: string;
  statePath: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
  scope: DeferredForegroundApplicationScope;
  boundary: DeferredCodexForegroundBindingBoundary;
  ports: DeferredForegroundRecoveryAdapterPorts;
  savedLedger(): Record<string, unknown> | undefined;
}

function createFixture(input: {
  kind: RecoveryKind;
  routed: boolean;
  ledgerAuthority?: string | null;
}): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-deferred-route-"));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const requestBody = "recover this exact deferred Turn";
  const requestText = terminalSubmissionPayload(requestBody);
  const requestHash = terminalBridgeRequestFingerprint(requestText) as string;
  const rollout = createAcceptedRollout(root, requestText);
  const anchorBase = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 2 as const,
    process_uuid: PROCESS_UUID,
    process_birth: PROCESS_BIRTH,
    captured_at: T0,
    mode: "pre_materialization" as const,
    native_thread_binding: "post_submission" as const,
    file_existed: false as const,
    offset_bytes: 0 as const,
    expected_empty_native_session: true as const
  };
  const anchor = {
    ...anchorBase,
    anchor_fingerprint: fingerprint(anchorBase)
  };
  const terminalId = "terminal:v2:tmux:codex:akk:0.1:4242";
  const before = terminalBindingFrom({
    terminalId,
    terminalControl: CONTROL,
    pid: 4242,
    processUuid: PROCESS_UUID,
    processBirth: PROCESS_BIRTH,
    evidence: "codex_process_birth",
    generation: 1,
    now: new Date(T0)
  });
  const accepted: ManagedTerminalBinding = {
    ...before,
    native_thread_id: THREAD_ID,
    native_process: {
      ...before.native_process,
      rollout,
      evidence: "codex_rollout_fd"
    },
    last_verified_at: T2
  };
  const transferId = "deferred-transfer-1";
  const targetSessionId = "session-target";
  const turnId = "turn-deferred";
  const messageId = "message-deferred";
  const conversationPaths = pathsForConversation(turnId, storeDir);
  fs.mkdirSync(conversationPaths.conversationDir, { recursive: true });
  const callbackFields = input.routed
    ? {
        gateway_method: "agent-knock-knock.callback",
        gateway_session: "agent:controller:deferred"
      }
    : {};
  const messageBodyHash = createHash("sha256").update(requestBody).digest("hex");
  const submission = {
    status: "enter_dispatched",
    session_id: targetSessionId,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    executor_kind: "codex",
    binding_id: before.binding_id,
    binding_generation: before.generation,
    request_hash: requestHash,
    message_body_hash: messageBodyHash,
    store_dir: storeDir,
    prepared_at: T0,
    text_injected_at: T1,
    enter_dispatched_at: T1,
    last_proven_stage: "enter_dispatched"
  };
  const conversation: Conversation = {
    ...createConversation({
      userRequest: requestBody,
      sessionId: targetSessionId,
      turnId,
      executorKind: "codex",
      now: new Date(T0)
    }),
    status: "waiting_for_agent",
    store_dir: storeDir,
    conversation_dir: conversationPaths.conversationDir,
    state_path: conversationPaths.statePath,
    event_log_path: conversationPaths.logPath,
    terminal_binding_id: before.binding_id,
    terminal_binding_generation: before.generation,
    ...callbackFields,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: messageId,
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash: requestHash,
      deferred_foreground_transfer_id: transferId,
      terminal_agent_pid: 4242,
      terminal_agent_process_uuid: PROCESS_UUID,
      terminal_agent_process_birth: PROCESS_BIRTH,
      codex_rollout_acceptance_anchor: anchor,
      terminal_binding_id: before.binding_id,
      terminal_binding_generation: before.generation,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    }
  };
  fs.writeFileSync(
    conversationPaths.statePath,
    `${JSON.stringify(conversation, null, 2)}\n`,
    { mode: 0o600 }
  );

  const baseTransfer: DeferredForegroundTransfer = {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 2,
    transfer_id: transferId,
    status: "dispatch_started",
    input_stage: "enter_dispatched",
    terminal_id: terminalId,
    terminal_endpoint: before.terminal_endpoint!,
    process_pid: 4242,
    process_uuid: PROCESS_UUID,
    process_birth: PROCESS_BIRTH,
    workspace: CONTROL.currentPath!,
    source_session_id: "session-source",
    source_expected_revision: 1,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-source",
      status: "bound",
      binding: before
    }),
    source_before_binding: before,
    source_kind: "status_card_only",
    target_session_id: targetSessionId,
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: "e".repeat(64),
    target_prepared_revision: 1,
    target_prepared_status: "transitioning",
    target_prepared_last_transition_id: transferId,
    target_prepared_binding_token: managedSessionBindingToken({
      session_id: targetSessionId,
      status: "transitioning",
      binding: before
    }),
    target_before_binding: before,
    request_hash: requestHash,
    dispatcher_pid: 7331,
    prepared_at: T0,
    dispatch_started_at: T1,
    text_injected_at: T1,
    enter_dispatched_at: T1,
    message_id: messageId,
    turn_id: turnId,
    state_path: conversationPaths.statePath
  };
  const transfer: DeferredForegroundTransfer = input.kind === "committed"
    ? {
        ...baseTransfer,
        status: "committed",
        input_stage: "agent_accepted",
        agent_accepted_at: T2,
        target_native_thread_id: THREAD_ID,
        target_accepted_revision: 2,
        target_accepted_status: "transitioning",
        target_accepted_binding_token: managedSessionBindingToken({
          session_id: targetSessionId,
          status: "transitioning",
          binding: accepted
        }),
        target_accepted_binding: accepted,
        committed_at: T2
      }
    : baseTransfer;
  writeTargetSession(
    storeDir,
    targetSessionId,
    transferId,
    input.kind === "committed" ? accepted : before,
    input.kind === "committed" ? 2 : 1
  );

  let ledger: Record<string, unknown> = {
    status: "enter_dispatched",
    generation_id: messageId,
    conversation_id: turnId,
    session_id: targetSessionId,
    turn_id: turnId,
    message_id: messageId,
    message_type: "task",
    executor_kind: "codex",
    deferred_foreground_transfer_id: transferId,
    binding_id: before.binding_id,
    binding_generation: before.generation,
    request_hash: requestHash,
    message_body_hash: messageBodyHash,
    store_dir: storeDir,
    state_path: conversationPaths.statePath,
    event_log_path: conversationPaths.logPath,
    prepared_at: T0,
    text_injected_at: T1,
    enter_dispatched_at: T1,
    dispatcher_pid: input.kind === "committed" ? 7331 : null,
    ...(input.ledgerAuthority !== undefined
      ? { callback_route_fingerprint: input.ledgerAuthority }
      : {})
  };
  let savedLedger: Record<string, unknown> | undefined;
  const identity = {
    sessionId: THREAD_ID,
    processUuid: PROCESS_UUID,
    processBirth: PROCESS_BIRTH,
    rollout,
    evidence: "codex_rollout_fd"
  };
  const terminal: TerminalDispatchTerminal = {
    conversationId: terminalId,
    agent: "codex",
    pid: 4242,
    terminalControl: CONTROL
  };
  const scope = {
    loadTransfer: () => transfer,
    transferBelongsToTurn: () => true
  } as unknown as DeferredForegroundApplicationScope;
  const boundary = { transferId } as DeferredCodexForegroundBindingBoundary;
  const ports: DeferredForegroundRecoveryAdapterPorts = {
    native: {
      processIncarnation: () => ({
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH
      }),
      inventory: async () => {
        throw new Error("version-2 recovery must not inspect an inventory");
      },
      identity: async () => identity
    },
    turn: {
      terminalControl: () => CONTROL,
      storeDir: () => storeDir,
      withIdentity: (current, nextIdentity) => ({
        ...current,
        native_thread_id: nextIdentity.sessionId,
        native_session_takeover: {
          ...(current.native_session_takeover as Record<string, unknown>),
          terminal_agent_session_id: nextIdentity.sessionId,
          terminal_agent_process_uuid: nextIdentity.processUuid,
          terminal_agent_process_birth: nextIdentity.processBirth,
          terminal_agent_rollout: nextIdentity.rollout
        }
      }),
      withSubmission: (mutation) => applyTerminalBridgeSubmission(mutation, {
        dispatcherPid: process.pid,
        storeDir,
        terminalControl: CONTROL
      })
    },
    ledger: {
      load: () => ledger,
      save: (_control, next) => {
        ledger = next;
        savedLedger = next;
      },
      matchesControl: () => true,
      bindingFields: (current) => ({
        binding_id: current.terminal_binding_id,
        binding_generation: current.terminal_binding_generation,
        native_thread_id: current.native_thread_id,
        store_dir: storeDir,
        executor_kind: "codex"
      }),
      previousSnapshotMatches: () => true
    },
    authority: {
      assertFrozen: () => undefined,
      assertTurnIdentity: () => undefined
    },
    application: {
      abortBeforeInput: () => undefined,
      commit: async () => targetSessionState(
        targetSessionId,
        transferId,
        accepted,
        2
      )
    }
  };
  return {
    root,
    storeDir,
    statePath: conversationPaths.statePath,
    terminal,
    transfer,
    scope,
    boundary,
    ports,
    savedLedger: () => savedLedger
  };
}

function targetSessionState(
  sessionId: string,
  transferId: string,
  binding: ManagedTerminalBinding,
  revision: number
): ManagedSessionState {
  return {
    schema: MANAGED_SESSION_SCHEMA,
    version: MANAGED_SESSION_VERSION,
    revision,
    session_id: sessionId,
    agent: "codex",
    workspace: CONTROL.currentPath!,
    status: "transitioning",
    binding,
    lineage: {
      created_by: "new_thread",
      previous_session_id: "session-source",
      transition_id: transferId
    },
    created_at: T0,
    updated_at: T1,
    last_transition_id: transferId
  };
}

function writeTargetSession(
  storeDir: string,
  sessionId: string,
  transferId: string,
  binding: ManagedTerminalBinding,
  revision: number
): void {
  const target = pathsForManagedSession(sessionId, storeDir);
  fs.mkdirSync(target.directory, { recursive: true });
  fs.writeFileSync(
    target.statePath,
    `${JSON.stringify(targetSessionState(
      sessionId,
      transferId,
      binding,
      revision
    ), null, 2)}\n`,
    { mode: 0o600 }
  );
}

function createAcceptedRollout(root: string, requestText: string) {
  const rolloutPath = path.join(root, `rollout-${THREAD_ID}.jsonl`);
  const nativeTurnId = "019f0000-0000-7000-8000-000000000001";
  const records = [
    {
      timestamp: "2026-08-15T00:59:59.000Z",
      type: "session_meta",
      payload: {
        id: THREAD_ID,
        timestamp: "2026-08-15T00:59:59.000Z",
        cwd: CONTROL.currentPath,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.147.0"
      }
    },
    {
      timestamp: T2,
      type: "event_msg",
      payload: { type: "task_started", turn_id: nativeTurnId }
    },
    {
      timestamp: T2,
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: requestText }],
        internal_chat_message_metadata_passthrough: { turn_id: nativeTurnId }
      }
    },
    {
      timestamp: T2,
      type: "event_msg",
      payload: { type: "user_message", message: requestText }
    }
  ];
  fs.writeFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 }
  );
  const stat = fs.statSync(rolloutPath);
  return {
    fd: "12r",
    device: String(stat.dev),
    inode: String(stat.ino),
    path: rolloutPath
  };
}

async function executeFixture(fixture: Fixture): Promise<void> {
  await runCliCommandExecution("deferred-route-recovery-test", {}, {
    now: () => new Date(T2),
    pid: process.pid,
    runtimeLog: () => undefined
  }, async () => {
    if (fixture.transfer.status === "committed") {
      await persistCommittedDeferredForegroundTurnAcceptance(
        fixture.ports,
        {
          options: {},
          scope: fixture.scope,
          storeDir: fixture.storeDir,
          terminal: fixture.terminal,
          transfer: fixture.transfer
        }
      );
      return;
    }
    assert.equal(await recoverAcceptedDeferredForegroundDispatch(
      fixture.ports,
      {
        options: {},
        scope: fixture.scope,
        storeDir: fixture.storeDir,
        terminal: fixture.terminal,
        transfer: fixture.transfer,
        boundary: fixture.boundary
      }
    ), true);
  });
}

test("deferred accepted recovery upgrades legacy route authority on both paths", async (t) => {
  for (const kind of ["observed", "committed"] as const) {
    for (const routed of [true, false]) {
      const fixture = createFixture({ kind, routed });
      t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      await executeFixture(fixture);
      const authority = callbackRouteFingerprintForConversation(
        loadState(fixture.statePath)
      ) ?? null;
      assert.equal(
        terminalBridgeSubmission(loadState(fixture.statePath))
          ?.callback_route_fingerprint,
        authority,
        `${kind}/${routed ? "hash" : "null"} state authority`
      );
      assert.equal(
        fixture.savedLedger()?.callback_route_fingerprint,
        authority,
        `${kind}/${routed ? "hash" : "null"} ledger authority`
      );
    }
  }
});

test("deferred accepted recovery rejects a route redirect before state save", async (t) => {
  for (const kind of ["observed", "committed"] as const) {
    const fixture = createFixture({
      kind,
      routed: true,
      ledgerAuthority: `sha256:${"f".repeat(64)}`
    });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
    await assert.rejects(
      executeFixture(fixture),
      /callback route conflicts with its dispatch ledger/u
    );
    assert.equal(
      terminalBridgeSubmission(loadState(fixture.statePath))?.status,
      "enter_dispatched"
    );
    assert.equal(fixture.savedLedger(), undefined);
  }
});

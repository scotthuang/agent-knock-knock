import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  managedSessionBindingToken,
  unmanagedTerminalBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";
import type { Conversation } from "../src/protocol.js";
import { terminalActionFingerprint } from "../src/native-thread-resume-snapshot-policy.js";
import {
  decideTerminalScopedCodexApprovalAuthority,
  terminalScopedCodexApprovalPromptSnapshot
} from "../src/terminal-scoped-approval-authority.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";

const THREAD_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0101";
const PROCESS_UUID = "codex-pid:4100:birth:12345";
const PROCESS_BIRTH = "12345";
const STORE_DIR = "/tmp/akk-terminal-approval-store";
const WORKSPACE = "/repo";
const TERMINAL_ID = "terminal:v2:herdr:codex:work:tab:pane:4100";
const ROLLOUT = {
  fd: "12",
  device: "1,18",
  inode: "42",
  path: "/safe/sessions/rollout.jsonl"
};

function terminalControl(): TerminalControlRef {
  return {
    kind: "herdr",
    target: "work/tab/pane",
    socketPath: "/tmp/herdr.sock",
    session: "work",
    workspaceId: "workspace-1",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "terminal-resource-1",
    panePid: 4_000,
    currentCommand: "codex",
    currentPath: WORKSPACE,
    capabilities: ["screen_status", "send_keys", "terminal_approval"]
  };
}

function managedSession(control: TerminalControlRef): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-approval-authority",
    revision: 1,
    agent: "codex",
    workspace: WORKSPACE,
    status: "bound",
    binding: {
      binding_id: "binding-approval-authority",
      generation: 1,
      terminal_id: TERMINAL_ID,
      terminal_control: control,
      native_thread_id: THREAD_ID,
      native_process: {
        pid: 4_100,
        process_uuid: PROCESS_UUID,
        process_birth: PROCESS_BIRTH,
        rollout: ROLLOUT,
        evidence: "codex_rollout_fd"
      },
      bound_at: "2026-08-14T00:00:00.000Z",
      last_verified_at: "2026-08-14T00:00:00.000Z"
    },
    lineage: { created_by: "attach" },
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z"
  };
}

function managedOwner(session: ManagedSessionState): Conversation {
  return {
    session_id: session.session_id,
    turn_id: "turn-approval-authority",
    conversation_id: "turn-approval-authority",
    user_request: "approve the current prompt",
    openclaw_session: "agent:test:approval",
    claude_session: "codex",
    executor: {
      kind: "codex",
      actor: "codex",
      session: "codex",
      display_name: "Codex",
      transport: "tmux"
    },
    workspace: WORKSPACE,
    status: "waiting_for_agent",
    response_rounds_used: 0,
    soft_limit: 50,
    hard_limit: 100,
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:01:00.000Z",
    native_session_takeover: {
      terminal_bridge_message_id: "message-approval-authority"
    }
  };
}

function terminalSnapshot(control: TerminalControlRef): Record<string, unknown> {
  return {
    id: TERMINAL_ID,
    source: "terminal",
    agent: "codex",
    pid: 4_100,
    cwd: WORKSPACE,
    workspace: WORKSPACE,
    terminal_control: control,
    native_agent_session_id: THREAD_ID,
    native_agent_status_card_session_id: THREAD_ID,
    native_agent_process_uuid: PROCESS_UUID,
    native_agent_process_birth: PROCESS_BIRTH,
    native_agent_rollout: ROLLOUT,
    native_agent_identity_observation: { status: "resolved" }
  };
}

function prompt(fingerprint = "a".repeat(64)) {
  const snapshot = terminalScopedCodexApprovalPromptSnapshot({
    approvable: true,
    fingerprint,
    keys: ["y"],
    decision_mode: "keys",
    request_id: "request-1"
  });
  assert.ok(snapshot);
  return snapshot;
}

test("no-owner authority preserves lazy check order and the public v2 token", () => {
  const control = terminalControl();
  const session = managedSession(control);
  const terminal = terminalSnapshot(control);
  const approval = prompt();
  const calls: string[] = [];
  const boundary = decideTerminalScopedCodexApprovalAuthority({
    kind: "managed_session_no_dispatch_owner",
    storeDir: STORE_DIR,
    terminal,
    session,
    approval,
    checks: {
      relatedBoundSessionIds: () => (calls.push("sessions"), [session.session_id]),
      dispatchOwnershipIsNone: () => (calls.push("ownership"), true),
      ledgerMatchesTerminal: () => (calls.push("ledger"), true),
      blockingTurnIds: () => (calls.push("turns"), []),
      hasNativeTransition: () => (calls.push("transition"), false),
      hasOrphanedDispatch: () => (calls.push("orphan"), false),
      hasDeferredRecovery: () => (calls.push("deferred"), false)
    }
  });

  assert.equal(boundary.authority.kind, "managed_session_no_dispatch_owner");
  assert.deepEqual(calls, [
    "sessions", "ownership", "turns", "transition", "orphan", "deferred"
  ]);
  const expectedTerminalToken = unmanagedTerminalBindingToken({
    terminalId: TERMINAL_ID,
    terminalControl: control,
    agent: "codex",
    pid: 4_100,
    workspace: WORKSPACE,
    processUuid: PROCESS_UUID,
    processBirth: PROCESS_BIRTH
  });
  const expectedToken = createHash("sha256").update(JSON.stringify({
    version: 2,
    kind: "terminal_scoped_codex_manual_approval",
    store_dir: path.resolve(STORE_DIR),
    terminal_token: expectedTerminalToken,
    observation: {
      status: "resolved",
      session_id: THREAD_ID,
      process_uuid: PROCESS_UUID,
      process_birth: PROCESS_BIRTH,
      rollout: ROLLOUT
    },
    authority: "managed_session_no_dispatch_owner",
    owner_session_id: session.session_id,
    owner_session_revision: 1,
    owner_binding_token: managedSessionBindingToken(session),
    owner_turn_id: null,
    owner_turn_status: null,
    owner_turn_updated_at: null,
    owner_message_id: null,
    dispatch_snapshot: { status: "none", fingerprint: null },
    approval_snapshot_digest: terminalActionFingerprint({
      version: 1,
      kind: "terminal_scoped_codex_approval_prompt",
      fingerprint: approval.fingerprint,
      keys: approval.keys,
      request_id: approval.requestId
    }),
    approval_fingerprint: approval.fingerprint,
    approval_keys: approval.keys,
    approval_request_id: approval.requestId
  })).digest("hex");
  assert.equal(boundary.token, expectedToken);
});

test("current-owner and no-owner paths share one authority without cached decisions", () => {
  const control = terminalControl();
  const session = managedSession(control);
  const owner = managedOwner(session);
  const terminal = terminalSnapshot(control);
  const approval = prompt();
  const ledger = { status: "submitted", generation_id: "generation-1" };
  const calls: string[] = [];
  const decide = (freshApproval = approval) =>
    decideTerminalScopedCodexApprovalAuthority({
      kind: "current_dispatch_owner",
      storeDir: STORE_DIR,
      terminal,
      session,
      owner,
      ledger,
      approval: freshApproval,
      checks: {
        relatedBoundSessionIds: () => (calls.push("sessions"), [session.session_id]),
        blockingTurnIds: () => (calls.push("turns"), [owner.turn_id]),
        hasNativeTransition: () => (calls.push("transition"), false),
        hasDeferredRecovery: () => (calls.push("deferred"), false),
        assertDispatchOwner: () => calls.push("assert-owner"),
        ledgerMatchesTerminal: () => (calls.push("ledger"), true),
        ownerMatchesNativeIdentity: () => (calls.push("identity"), false)
      }
    });

  const first = decide();
  const second = decide(prompt("b".repeat(64)));
  assert.equal(first.authority.kind, "current_dispatch_owner");
  assert.notEqual(first.token, second.token);
  assert.deepEqual(calls, [
    "sessions", "turns", "transition", "deferred", "assert-owner", "ledger", "identity",
    "sessions", "turns", "transition", "deferred", "assert-owner", "ledger", "identity"
  ]);
});

test("recovery rejection short-circuits later authority I/O", () => {
  const control = terminalControl();
  const session = managedSession(control);
  const calls: string[] = [];
  assert.throws(() => decideTerminalScopedCodexApprovalAuthority({
    kind: "managed_session_no_dispatch_owner",
    storeDir: STORE_DIR,
    terminal: terminalSnapshot(control),
    session,
    approval: prompt(),
    checks: {
      relatedBoundSessionIds: () => [session.session_id],
      dispatchOwnershipIsNone: () => true,
      ledgerMatchesTerminal: () => true,
      blockingTurnIds: () => [],
      hasNativeTransition: () => (calls.push("transition"), true),
      hasOrphanedDispatch: () => (calls.push("orphan"), false),
      hasDeferredRecovery: () => (calls.push("deferred"), false)
    }
  }), /blocked by managed recovery state/u);
  assert.deepEqual(calls, ["transition"]);
});

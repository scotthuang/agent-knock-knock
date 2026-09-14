import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import {
  createTerminalListOwnershipService,
  type TerminalListOwnershipServicePorts
} from "../src/terminal-list-ownership-service.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";

const nativeSessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0201";
const terminalId = "terminal:v2:herdr:codex:default:w1:p4:42";
const control: TerminalControlRef = {
  kind: "herdr",
  target: "default:w1:p4",
  socketPath: "/tmp/herdr.sock",
  session: "default",
  sessionDir: "/tmp/herdr-session",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-4",
  terminalId: "pty-4",
  panePid: 41,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys", "terminal_approval"]
};

function boundSession(): ManagedSessionState {
  const now = new Date("2026-09-15T00:00:00.000Z");
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-list-ownership",
    revision: 1,
    agent: "codex",
    workspace: "/workspace/project",
    status: "bound",
    binding: terminalBindingFrom({
      terminalId,
      terminalControl: control,
      pid: 42,
      nativeThreadId: nativeSessionId,
      processUuid: "process-uuid",
      processBirth: "process-birth",
      evidence: "fixture",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

function terminalRow(): Record<string, any> {
  return {
    id: terminalId,
    source: "terminal",
    agent: "codex",
    pid: 42,
    cwd: "/workspace/project",
    workspace: "/workspace/project",
    process_state: "active",
    terminal_control: control,
    native_agent_session_id: nativeSessionId,
    native_agent_process_uuid: "process-uuid",
    native_agent_process_birth: "process-birth",
    native_agent_identity_observation: {
      status: "resolved",
      identity: {
        sessionId: nativeSessionId,
        processUuid: "process-uuid",
        processBirth: "process-birth",
        evidence: "fixture"
      }
    },
    activity_state: "idle",
    approval_state: { scanned: true, blocked: false, approvable: false },
    _automated_input_composer_ready: true,
    available_actions: {
      send: {
        tool: "agent_knock_knock_send",
        arguments: { selector: terminalId },
        missing_required: ["request"]
      }
    }
  };
}

function ownerConversation(): Conversation {
  const owner = createConversation({
    userRequest: "Characterize current dispatch ownership.",
    sessionId: "session-list-ownership",
    turnId: "turn-list-ownership",
    executorKind: "codex",
    workspace: "/workspace/project",
    now: new Date("2026-09-15T00:00:00.000Z")
  });
  return {
    ...owner,
    status: "waiting_for_agent",
    state_path: "/tmp/store/conversations/turn-list-ownership/state.json",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-list-ownership",
      terminal_agent_pid: 42,
      terminal_control: control
    }
  };
}

function ports(overrides: Partial<TerminalListOwnershipServicePorts> = {}) {
  return {
    activeTurnHandoffDecisionToken: () => "handoff-token",
    assertManagedTerminalDispatchOwner: () => undefined,
    codexLingeringBeforeIdentityMatchesSession: () => false,
    codexProcessIncarnationForPid: () => ({
      processUuid: "process-uuid",
      processBirth: "process-birth"
    }),
    currentWorkingDirectory: () => "/workspace/project",
    isDiscoverableTmuxConversation: () => true,
    loadTerminalBridgeDispatchLedger: () => undefined,
    loadTerminalDispatchLedgerOwner: () => undefined,
    managedTurnsForSession: () => [],
    matchesConfiguredWorkspace: (left, right) => left === right,
    observeDeferredCodexAuthority: () => undefined,
    observedHandoffTargetResolution: () => ({
      status: "blocked" as const,
      reason: "fixture"
    }),
    orphanedTerminalDispatchForRecovery: () => undefined,
    runtimeLog: () => undefined,
    terminalControlFromTakeover: (value) => {
      const takeover = value as { terminal_control?: TerminalControlRef };
      return takeover?.terminal_control;
    },
    terminalDispatchRecordMatchesControl: () => true,
    ...overrides
  } satisfies TerminalListOwnershipServicePorts;
}

test("ownership service is read-only and has no terminal-input dependency", () => {
  const source = fs.readFileSync(
    "src/terminal-list-ownership-service.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /\b(?:sendKeys|sendText|writeFile|saveState|saveManagedSession)\b/u
  );
  assert.doesNotMatch(source, /terminal-control-provider/u);
});

test("exact managed Session claim is projected as ownership facts", () => {
  const session = boundSession();
  const service = createTerminalListOwnershipService(ports());
  const observation = service.observeBindingAuthority(terminalRow(), {
    storeDir: "/tmp/store",
    terminals: [terminalRow()],
    managedSessions: [session],
    allConversations: [],
    displayedConversations: [],
    mutationsAllowed: true,
    nonterminalDeferredTransfers: [],
    conversationHasNonterminalDeferredTransfer: () => false
  });
  assert.equal(observation.authoritativeSession, session);
  assert.deepEqual(observation.matchingSessions, [session]);
  assert.deepEqual(observation.conflictingBoundSessionClaims, []);
  assert.equal(observation.ownership.state, "none");
  assert.equal(observation.sessionAwareRawActions.send.tool,
    "agent_knock_knock_send");
});

test("active dispatch owner reads ledger before owner and remains current", () => {
  const events: string[] = [];
  const owner = ownerConversation();
  const service = createTerminalListOwnershipService(ports({
    loadTerminalBridgeDispatchLedger: () => {
      events.push("ledger");
      return {
        status: "enter_dispatched",
        conversation_id: owner.conversation_id,
        message_id: "message-list-ownership"
      };
    },
    terminalDispatchRecordMatchesControl: (_ledger, _control, options) => {
      events.push(options?.requireProcessAnchor === false
        ? "match-incarnation"
        : "match-exact");
      return true;
    },
    loadTerminalDispatchLedgerOwner: () => {
      events.push("owner");
      return owner;
    }
  }));
  const ownership = service.terminalDispatchOwnership(control);
  assert.deepEqual(ownership, { state: "current", conversation: owner });
  assert.deepEqual(events, [
    "ledger",
    "match-incarnation",
    "match-exact",
    "owner"
  ]);
});

test("unreadable dispatch ledger preserves the fail-closed conflict", () => {
  const service = createTerminalListOwnershipService(ports({
    loadTerminalBridgeDispatchLedger: () => {
      throw new Error("fixture ledger unreadable");
    }
  }));
  assert.deepEqual(service.terminalDispatchOwnership(control), {
    state: "conflict",
    conflict: {
      reason: "fixture ledger unreadable",
      recovery:
        "inspect the shared terminal pane before performing a side effect"
    }
  });
});

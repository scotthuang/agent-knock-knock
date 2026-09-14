import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type { Conversation } from "../src/protocol.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";
import type { TerminalListOwnershipService } from
  "../src/terminal-list-ownership-service.js";
import {
  createTerminalListProjectionService,
  type TerminalListProjectionPorts
} from "../src/terminal-list-projection-service.js";

const terminalId = "terminal:v2:herdr:codex:default:w1:p4:42";
const statusAction = {
  tool: "agent_knock_knock_status",
  arguments: { terminal_id: terminalId }
};

function projectionService(input: {
  events?: string[];
  ownershipService?: TerminalListOwnershipService;
  nowMs?: number;
} = {}) {
  const events = input.events ?? [];
  const ownershipService = input.ownershipService ?? ({
    observeBindingAuthority: (terminal: Record<string, any>) => {
      events.push("binding");
      return { authorityTerminal: terminal };
    },
    observeActionAuthority: () => {
      events.push("action");
      return {
        automatedInputComposerReady: true,
        publicTerminal: {
          id: terminalId,
          source: "terminal",
          agent: "codex",
          pid: 42
        },
        allRelated: [],
        displayedRelated: [],
        relatedSessions: [],
        ownership: { state: "none" },
        rawSendAction: {},
        sessionAwareRawActions: { status: statusAction },
        externalHandoffDetected: false,
        handoffSourceBlockingTurns: [],
        externalHandoffAdoptable: false,
        blockingHandoffTurnIds: new Set<string>(),
        terminalRecoveryBlockingTurns: [],
        rolloutBackedCodexSession: false
      };
    },
    managedTurnMatchesLiveTerminal: () => false,
    managedTurnNeedsAttention: () => true,
    terminalControlForManagedConversation: () => undefined
  } as unknown as TerminalListOwnershipService);
  const ports = {
    approvalTtlMs: 60_000,
    callbackRetryDisposition: () => ({ state: "settled" }),
    isVerifiedDeadTerminalAgentProcess: () => false,
    listDeferredForegroundTransfers: () => {
      events.push("deferred");
      return [];
    },
    nowMs: () => input.nowMs ?? Date.parse("2026-09-15T00:00:30.000Z"),
    ownershipService,
    summarizeConversation: (conversation: Conversation) => ({
      conversation_id: conversation.conversation_id,
      session_id: conversation.session_id,
      turn_id: conversation.turn_id,
      status: conversation.status
    }),
    terminalBridgeEnabled: () => false,
    terminalBridgeSubmission: () => undefined,
    terminalControlFromTakeover: () => undefined
  } satisfies TerminalListProjectionPorts;
  return createTerminalListProjectionService(ports);
}

test("public projection is read-only and does not mint action authority", () => {
  const source = fs.readFileSync(
    "src/terminal-list-projection-service.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /(?:unmanagedTerminalBindingToken|humanObservedHandoffBindingToken|deferredCodexForegroundBindingToken|verifiedEmptyCodexHandoffToken)/u
  );
  assert.doesNotMatch(
    source,
    /\b(?:sendKeys|sendText|writeFile|saveState|saveManagedSession)\b/u
  );
  assert.doesNotMatch(source, /terminal-control-provider/u);
});

test("terminal-first projection samples ownership once and preserves public order", () => {
  const events: string[] = [];
  const service = projectionService({ events });
  const terminal = {
    id: terminalId,
    terminal_control: {
      kind: "herdr",
      target: "default:w1:p4"
    } as TerminalControlRef
  };
  const result = service.projectTerminalFirstList({
    storeDir: "/tmp/store",
    terminals: [terminal],
    managedSessions: [],
    sessionAuthorityRequired: true,
    allConversations: [],
    displayedConversations: [],
    includeAll: false,
    managedOnly: false,
    mutationsAllowed: true
  });

  assert.deepEqual(events, ["deferred", "binding", "action"]);
  assert.deepEqual(result.unavailableManagedTurns, []);
  assert.equal(JSON.stringify(result.terminals[0]), JSON.stringify({
    id: terminalId,
    source: "terminal",
    agent: "codex",
    pid: 42,
    management_state: "unmanaged",
    managed: {
      session_id: null,
      session_short_ref: null,
      current_turn: null,
      recent_turn: null,
      turn_count: 0,
      hidden_turn_count: 0,
      session_count: 0
    },
    available_actions: { status: statusAction }
  }));
});

test("unavailable managed Turn keeps its exact public recovery envelope", () => {
  const service = projectionService();
  const conversation = {
    conversation_id: "turn-list-projection",
    session_id: "session-list-projection",
    turn_id: "turn-list-projection",
    status: "stalled",
    executor: { kind: "codex" },
    workspace: "/workspace/project"
  } as unknown as Conversation;
  const result = service.projectTerminalFirstList({
    storeDir: "/tmp/store",
    terminals: [],
    managedSessions: [],
    sessionAuthorityRequired: true,
    allConversations: [conversation],
    displayedConversations: [conversation],
    includeAll: false,
    managedOnly: true,
    mutationsAllowed: true
  });

  assert.equal(result.unavailableManagedTurns.length, 1);
  const entry = result.unavailableManagedTurns[0];
  assert.equal(entry.source, "managed_turn");
  assert.equal(entry.id, "turn-list-projection");
  assert.deepEqual(entry.terminal_availability, {
    available: false,
    reason: "terminal discovery was disabled by --managed-only"
  });
  assert.deepEqual(
    Object.keys(entry.available_actions as Record<string, any>),
    ["status", "close"]
  );
});

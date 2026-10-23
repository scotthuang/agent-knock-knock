import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createConversation, type Conversation } from "../src/protocol.js";
import { normalizeTerminalInteractionProjectionV2 } from "../src/terminal-interaction-protocol.js";
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
  bridgeEnabled?: boolean;
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
    terminalBridgeEnabled: () => input.bridgeEnabled === true,
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

test("current Claude questionnaire discovery preserves its managed Turn and withdraws stale or consumed responses", () => {
  const now = new Date("2026-10-23T00:00:00.000Z");
  const terminalId = "terminal:v2:tmux:claude:claude:0.0:42";
  const control = { kind: "tmux", target: "claude:0.0", panePid: 42, capabilities: ["screen_status", "send_keys"] };
  const fingerprint = "a".repeat(64);
  const original = {
    ...createConversation({ userRequest: "ask a question", sessionId: "session_question", turnId: "turn_question",
      executorKind: "claude", executorSession: "claude_question", openclawSession: "controller_question",
      workspace: "/workspace", now }),
    status: "waiting_for_agent" as const,
    native_session_takeover: {
      terminal_bridge: true, terminal_bridge_message_id: "message_question", terminal_control: control,
      terminal_bridge_interaction_notification: {
        terminal_bridge_message_id: "message_question", interaction_id: "interaction_question",
        prompt_fingerprint: fingerprint, terminal_control: { ...control },
        interaction_state: {
          schema: "agent-knock-knock/terminal-interaction", version: 1, interaction_id: "interaction_question",
          turn_id: "turn_question", agent: "claude", kind: "questionnaire", state: "pending",
          step: { index: 1, total: 1 }, expires_at: "2026-10-23T00:10:00.000Z",
          questions: [{ question_id: "question_target", header: "Target", prompt: "Choose a target", required: true,
            response_kind: "single_select", options: [
              { option_id: "local", label: "Local" }, { option_id: "remote", label: "Remote" }
            ] }],
          capabilities: { respond: true, batch_response: false, free_text: false, multi_select: false }
        }
      }
    }
  };
  const project = (conversation: Conversation, mutationAllowed = true, current = true) => {
    const terminal = { id: terminalId, source: "terminal", agent: "claude", pid: 42, terminal_control: control };
    const ownershipService = {
      observeBindingAuthority: () => ({ authorityTerminal: terminal }),
      observeActionAuthority: () => ({ automatedInputComposerReady: false, publicTerminal: terminal,
        allRelated: [conversation], displayedRelated: [conversation], relatedSessions: [],
        ownership: current ? { state: "current", conversation } : { state: "none" },
        rawSendAction: {}, sessionAwareRawActions: { status: { tool: "agent_knock_knock_status", arguments: { terminal_id: terminalId } } }, externalHandoffDetected: false,
        handoffSourceBlockingTurns: [], externalHandoffAdoptable: false, blockingHandoffTurnIds: new Set(),
        terminalRecoveryBlockingTurns: [], rolloutBackedCodexSession: false }),
      managedTurnMatchesLiveTerminal: () => true, managedTurnNeedsAttention: () => true,
      terminalControlForManagedConversation: () => control
    } as unknown as TerminalListOwnershipService;
    return projectionService({ ownershipService, nowMs: now.getTime(), bridgeEnabled: true }).projectTerminalFirstList({
      storeDir: "/tmp/store", terminals: [terminal], managedSessions: [], sessionAuthorityRequired: false,
      allConversations: [conversation], displayedConversations: [conversation], includeAll: true,
      managedOnly: false, mutationsAllowed: mutationAllowed
    }).terminals[0];
  };
  for (const version of [1, 2]) {
    const conversation = structuredClone(original);
    if (version === 2) conversation.native_session_takeover.terminal_bridge_interaction_notification.interaction_state =
      normalizeTerminalInteractionProjectionV2(conversation.native_session_takeover.terminal_bridge_interaction_notification.interaction_state, {
        subject: { kind: "managed_turn", turn_id: "turn_question", message_id: "message_question" },
        surfaceId: `tis_${"b".repeat(40)}`, promptFingerprint: fingerprint, responseAuthority: "executable"
      }) as any;
    const terminal = project(conversation);
    const action = terminal.available_actions.respond_interaction;
    assert.equal(action.tool, "agent_knock_knock_respond_interaction");
    assert.deepEqual(action.arguments, { turn_id: "turn_question" });
    assert.deepEqual(action.before_call.arguments, { turn_id: "turn_question" });
    assert.equal(action.requires_fresh_status, true);
    assert.equal(JSON.stringify(action).includes(fingerprint), false);
    assert.deepEqual(terminal.managed.current_turn.available_actions.respond_interaction, action);
  }
  const blocked = [
    ["different message", (turn: any) => { turn.native_session_takeover.terminal_bridge_message_id = "message_other"; }],
    ["different Turn", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_notification.interaction_state.turn_id = "turn_other"; }],
    ["different terminal", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_notification.terminal_control.target = "other:0.0"; }],
    ["expired", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_notification.interaction_state.expires_at = now.toISOString(); }],
    ["manual only", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_notification.interaction_state.capabilities.respond = false; }],
    ["consumed", (turn: any) => { turn.native_session_takeover.terminal_bridge_last_interaction_fingerprint = fingerprint; }],
    ["uncertain", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_dispatch = { state: "uncertain" }; }],
    ["reserved", (turn: any) => { turn.native_session_takeover.terminal_bridge_interaction_dispatch = { state: "reserved" }; }]
  ] as const;
  for (const [reason, mutate] of blocked) {
    const conversation = structuredClone(original);
    mutate(conversation);
    assert.equal(project(conversation).available_actions.respond_interaction, undefined, reason);
  }
  assert.equal(project(original, false).available_actions.respond_interaction, undefined, "read-only Store");
  assert.equal(project(original, true, false).available_actions.respond_interaction, undefined, "historical Turn");
});

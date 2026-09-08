import {
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation,
  type Executor
} from "./protocol.js";
import { callbackExpectedForConversation } from
  "./callback-route-authority.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  RecordedTerminalZeroInputAbort,
  TerminalDispatchAcceptance
} from "./terminal-dispatch-application.js";
import type { terminalSubmissionReplayReceipt } from
  "./terminal-dispatch-receipt.js";
import { isRecord } from "./value-guards.js";

type ReplayReceipt = ReturnType<typeof terminalSubmissionReplayReceipt>;

export type TerminalSendAgentAcceptance = "proven" | "unproven";
export type TerminalSendManagementMode = "managed" | "unmanaged";
export type TerminalSendObservationMode =
  | "managed_monitor"
  | "terminal_watch"
  | "none";

export interface TerminalSendResultCapabilities {
  callback: boolean;
  interaction_notify: boolean;
  interaction_respond: boolean;
}

export interface TerminalSendResultContract {
  terminal_input_dispatched: boolean;
  agent_acceptance: TerminalSendAgentAcceptance;
  management_mode: TerminalSendManagementMode;
  observation_mode: TerminalSendObservationMode;
  capabilities: TerminalSendResultCapabilities;
  /** Compatibility value used by 0.12.x readers. */
  legacy_management_mode: "managed" | "unmanaged_fallback";
}

export interface NormalizedTerminalSendResultContract
  extends TerminalSendResultContract {
  /** Compatibility alias: true only when Enter dispatch is proven. */
  delivered: boolean;
}

/** Keep transport, native acceptance, management, and observation orthogonal. */
export function terminalSendResultContract(input: Readonly<{
  terminalInputDispatched: boolean;
  agentAcceptance: TerminalSendAgentAcceptance;
  managementMode: TerminalSendManagementMode;
  observationMode: TerminalSendObservationMode;
  callbackAvailable: boolean;
  interactionNotificationAvailable?: boolean;
  interactionResponseAvailable?: boolean;
}>): TerminalSendResultContract {
  const callbackAvailable = input.callbackAvailable &&
    input.observationMode !== "none";
  return {
    terminal_input_dispatched: input.terminalInputDispatched,
    agent_acceptance: input.agentAcceptance,
    management_mode: input.managementMode,
    observation_mode: input.observationMode,
    capabilities: {
      callback: callbackAvailable,
      interaction_notify:
        callbackAvailable &&
        (input.interactionNotificationAvailable ?? false),
      interaction_respond:
        callbackAvailable &&
        input.managementMode === "managed" &&
        input.agentAcceptance === "proven" &&
        (input.interactionResponseAvailable ?? false)
    },
    legacy_management_mode: input.managementMode === "managed"
      ? "managed"
      : "unmanaged_fallback"
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

/**
 * Compatibility predicate for the one legacy `delivered` fact. Text
 * injection is terminal input, but delivery is not complete until Enter has
 * durable proof. Older presenters encoded post-Enter rejection/uncertainty as
 * `delivered: false`, so retain those stronger receipt facts while excluding
 * retry refusals which explicitly sent no input.
 */
export function terminalSendEnterDispatched(
  value: unknown
): boolean {
  const result = record(value);
  if (!result) return false;
  if (result.delivered === true) return true;
  const receipt = String(result.delivery_receipt ?? "");
  const outcome = String(result.submission_outcome ?? "");
  const status = String(result.status ?? "");
  const lastProvenStage = String(result.last_proven_stage ?? "");
  const retryState = String(result.submission_retry_state ?? "");
  if (
    (typeof result.enter_dispatched_at === "string" &&
      result.enter_dispatched_at.trim() !== "") ||
    (typeof result.agent_accepted_at === "string" &&
      result.agent_accepted_at.trim() !== "") ||
    ["enter_dispatched", "agent_accepted"].includes(lastProvenStage) ||
    ["enter_dispatched", "agent_accepted"].includes(retryState)
  ) {
    return true;
  }
  if ([
    "submitted",
    "enter_dispatched",
    "agent_accepted",
    "not_accepted"
  ].includes(receipt)) {
    return true;
  }
  if ([
    "submitted",
    "agent_accepted",
    "pending_acceptance",
    "not_accepted"
  ].includes(outcome)) {
    return true;
  }
  if ([
    "submitted",
    "enter_dispatched",
    "agent_accepted",
    "not_accepted"
  ].includes(status) || status === "delivered_unfenced") {
    return true;
  }
  if (
    receipt === "uncertain" &&
    outcome === "uncertain" &&
    result.terminal_input_sent !== false
  ) {
    return true;
  }
  return false;
}

/** Normalize Send output from an older CLI without weakening error policy. */
export function normalizedTerminalSendResultContract(
  value: Readonly<Record<string, unknown>>
): NormalizedTerminalSendResultContract {
  const receipt = String(value.delivery_receipt ?? "");
  const outcome = String(value.submission_outcome ?? "");
  const enterDispatched = terminalSendEnterDispatched(value);
  const terminalInputDispatched =
    typeof value.terminal_input_dispatched === "boolean"
      ? value.terminal_input_dispatched
      : enterDispatched
        ? true
        : ["text_injected", "submitted", "enter_dispatched", "agent_accepted"]
            .includes(receipt) ||
          ["text_injected"].includes(String(value.status ?? ""));
  const agentAcceptance = value.agent_acceptance === "proven" ||
      (outcome === "agent_accepted" && receipt === "agent_accepted" &&
        value.delivered === true)
    ? "proven"
    : "unproven";
  const managementMode = value.management_mode === "unmanaged" ||
      value.management_mode === "unmanaged_fallback" ||
      value.legacy_management_mode === "unmanaged_fallback" ||
      value.delivered_unmanaged === true
    ? "unmanaged"
    : "managed";
  const existingCapabilities = record(value.capabilities);
  const legacyCallbackAvailable = value.callback_expected === true;
  const callbackAvailable = typeof existingCapabilities?.callback === "boolean"
    ? existingCapabilities.callback
    : legacyCallbackAvailable;
  const explicitObservation = value.observation_mode;
  const observationMode: TerminalSendObservationMode =
    explicitObservation === "managed_monitor" ||
      explicitObservation === "terminal_watch" ||
      explicitObservation === "none"
      ? explicitObservation
      : value.callback_mode === "terminal_watch" && callbackAvailable
        ? "terminal_watch"
        : callbackAvailable && managementMode === "managed"
          ? "managed_monitor"
          : "none";
  return {
    delivered: enterDispatched,
    ...terminalSendResultContract({
      terminalInputDispatched,
      agentAcceptance,
      managementMode,
      observationMode,
      callbackAvailable,
      interactionNotificationAvailable:
        typeof existingCapabilities?.interaction_notify === "boolean"
          ? existingCapabilities.interaction_notify
          : callbackAvailable && managementMode === "managed",
      interactionResponseAvailable:
        typeof existingCapabilities?.interaction_respond === "boolean"
          ? existingCapabilities.interaction_respond
          : agentAcceptance === "proven"
    })
  };
}

export interface TerminalDispatchPresentationContext {
  message: AgentMessage;
  executor: Executor;
  terminalControl: TerminalControlRef;
}

export interface TerminalDispatchPresentationPorts {
  write(value: Record<string, unknown>): void;
  budget(conversation: Conversation): unknown;
  nextAction(input: Readonly<{
    conversationId: string;
    sessionId: string;
    turnId: string;
    source: "terminal_control";
    callbackExpected: boolean;
  }>): unknown;
  summarize(value: unknown): unknown;
}

export interface OpenClawYieldNextActionInput {
  conversationId: string;
  sessionId: string;
  turnId: string;
  source: "terminal_control";
  callbackExpected: boolean;
}

export function openClawYieldNextAction({
  conversationId,
  sessionId,
  turnId,
  source,
  callbackExpected
}: OpenClawYieldNextActionInput) {
  const callbackText = callbackExpected
    ? "The coding agent should report completion, questions, or errors through the existing Agent Knock Knock callback for this conversation."
    : "No AKK-managed callback is registered for this raw terminal-controlled id; do not wait synchronously. Use AKK status/list later or attach/create an AKK conversation when callback delivery is required.";
  return {
    action: "yield" as const,
    reason:
      "The requested agent work was handed off asynchronously. End this controller turn now instead of waiting, polling, or treating the send as a synchronous agent result.",
    source,
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: turnId,
    callback_expected: callbackExpected,
    do_not:
      "Do not inspect event logs, process lists, terminal screens, files, stdout, or stderr while waiting unless the user explicitly asks for status.",
    expected_callback: callbackText
  };
}

export function presentTerminalDispatchReplay(
  input: Readonly<{
    owner: Conversation;
    receipt: ReplayReceipt;
    accepted: boolean;
    acceptanceInvalid: boolean;
    receiptConversationId: string;
    receiptMessageId: string;
    callbackExpected: boolean;
    userExplicit?: Readonly<{
      terminalId: string;
      messageId: string;
    }>;
  }>,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts
): void {
  const sessionId = sessionIdForConversation(input.owner);
  const turnId = turnIdForConversation(input.owner);
  const ownerReleased = isTerminalDispatchOwnerReleasedStatus(
    input.owner.status
  );
  const callbackAvailable = input.callbackExpected &&
    !input.acceptanceInvalid &&
    !ownerReleased;
  const enterDispatched = terminalSendEnterDispatched(input.receipt);
  ports.write({
    session_id: sessionId,
    turn_id: turnId,
    conversation: input.owner,
    message: {
      ...context.message,
      id: input.receiptMessageId,
      conversation_id: input.receiptConversationId,
      session_id: sessionId,
      turn_id: turnId,
      metadata: {
        ...(isRecord(context.message.metadata)
          ? context.message.metadata
          : {}),
        task_id: input.receiptConversationId,
        session_id: sessionId,
        turn_id: turnId
      }
    },
    delivered: enterDispatched,
    status: input.receipt.status,
    submission_outcome: input.receipt.submission_outcome,
    background: true,
    callback_expected: callbackAvailable,
    terminal_control: context.terminalControl,
    executor: context.executor,
    ...(input.userExplicit
      ? {
          scope: "terminal_user_explicit",
          terminal_id: input.userExplicit.terminalId,
          message_id: input.userExplicit.messageId
        }
      : {}),
    ...terminalSendResultContract({
      terminalInputDispatched: enterDispatched,
      agentAcceptance: input.accepted ? "proven" : "unproven",
      managementMode: "managed",
      observationMode: callbackAvailable ? "managed_monitor" : "none",
      callbackAvailable,
      interactionNotificationAvailable: input.accepted,
      interactionResponseAvailable: input.accepted
    }),
    replayed: input.receipt.replayed,
    delivery_receipt: input.receipt.delivery_receipt,
    ...(input.receipt.do_not_retry
      ? { do_not_retry: input.receipt.do_not_retry }
      : {}),
    reason: ownerReleased
      ? "AKK replayed a durable terminal receipt owned by a released Turn; no additional terminal input was sent and no callback remains."
      : input.accepted
      ? "AKK replayed the durable native acceptance receipt for an identical active terminal request and did not send terminal input again."
      : input.acceptanceInvalid
        ? `AKK refused to replay an invalid native acceptance receipt (${input.receipt.evidence_error ?? "evidence validation failed"}); no additional terminal input was sent.`
        : "AKK replayed the original transport-level receipt without upgrading it to native acceptance and did not send terminal input again.",
    openclaw_next_action: input.accepted && !ownerReleased
      ? ports.nextAction({
          conversationId: input.receiptConversationId,
          sessionId,
          turnId,
          source: "terminal_control",
          callbackExpected: callbackAvailable
        })
      : {
          action: "inspect",
          conversation_id: input.receiptConversationId,
          session_id: sessionId,
          turn_id: turnId,
          do_not_retry: true,
          reason: ownerReleased
            ? "The durable receipt belongs to a released Turn; no callback remains. Inspect current terminal state before starting new work."
            : input.acceptanceInvalid
            ? "The stored native acceptance evidence is invalid; inspect and explicitly close this Turn."
            : "Only terminal transport is proven; wait for native acceptance or inspect the shared pane."
        }
  });
}

function zeroInputText(
  failure: RecordedTerminalZeroInputAbort
): { reason: string; nextReason: string } {
  const setup = failure.outcome.failureKind === "setup";
  const blocker = failure.outcome.disposition === "inspect"
    ? failure.outcome.blocker
    : undefined;
  if (failure.outcome.safeToRetry) {
    return setup
      ? {
          reason: "AKK failed before terminal input; this terminal submission was not sent and may be retried.",
          nextReason: "The failure occurred before any terminal input."
        }
      : {
          reason: "AKK proved that terminal input never started; this submission may be retried.",
          nextReason:
            "The terminal transport failed before any input operation succeeded."
        };
  }
  if (!setup) {
    return {
      reason: "AKK proved terminal input never started but could not make every abort receipt and Session rollback durable; inspect before retrying.",
      nextReason:
        "The pre-input failure could not be fully reconciled in durable state."
    };
  }
  return blocker === "dispatch_ledger_restore"
    ? {
        reason: "AKK failed before terminal input but could not restore the terminal dispatch ledger; inspect and close the conversation before retrying.",
        nextReason: "The terminal ledger could not be restored automatically."
      }
    : blocker === "raw_attach_rollback"
      ? {
          reason: "AKK failed before terminal input but could not detach the provisional raw-attach Session; inspect its exact binding before retrying.",
          nextReason:
            "The provisional raw-attach Session could not be detached automatically."
        }
      : {
          reason: "AKK failed before terminal input but could not persist the aborted receipt; inspect the conversation before retrying.",
          nextReason: "The aborted receipt could not be made durable."
        };
}

export function presentTerminalZeroInputAbort(
  failure: RecordedTerminalZeroInputAbort,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts,
  monitorPid?: number | null
): void {
  const { reportedConversation, receiptConversation } = failure;
  const text = zeroInputText(failure);
  ports.write({
    session_id: sessionIdForConversation(receiptConversation),
    turn_id: turnIdForConversation(receiptConversation),
    conversation: reportedConversation,
    message: context.message,
    delivered: false,
    status: "submission_aborted",
    submission_outcome: "aborted",
    background: true,
    callback_expected: false,
    terminal_control: context.terminalControl,
    monitor_pid: monitorPid ?? null,
    executor: context.executor,
    ...terminalSendResultContract({
      terminalInputDispatched: false,
      agentAcceptance: "unproven",
      managementMode: "managed",
      observationMode: "none",
      callbackAvailable: false
    }),
    safe_to_retry: failure.outcome.safeToRetry,
    do_not_retry: !failure.outcome.safeToRetry,
    reason: text.reason,
    openclaw_next_action: {
      action: failure.outcome.safeToRetry ? "retry" : "inspect",
      conversation_id: receiptConversation.conversation_id,
      session_id: sessionIdForConversation(reportedConversation),
      turn_id: turnIdForConversation(reportedConversation),
      safe_to_retry: failure.outcome.safeToRetry,
      do_not_retry: !failure.outcome.safeToRetry,
      reason: text.nextReason
    }
  });
}

export function presentTerminalIdentityFailure(
  conversation: Conversation,
  reason: string,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts,
  monitorPid?: number | null
): void {
  ports.write({
    session_id: sessionIdForConversation(conversation),
    turn_id: turnIdForConversation(conversation),
    conversation,
    message: context.message,
    delivered: true,
    status: "submission_uncertain",
    submission_outcome: "uncertain",
    background: true,
    callback_expected: false,
    terminal_control: context.terminalControl,
    monitor_pid: monitorPid ?? null,
    executor: context.executor,
    delivery_receipt: "enter_dispatched",
    do_not_retry: true,
    ...terminalSendResultContract({
      terminalInputDispatched: true,
      agentAcceptance: "unproven",
      managementMode: "managed",
      observationMode: "none",
      callbackAvailable: false
    }),
    reason,
    openclaw_next_action: {
      action: "inspect",
      conversation_id: conversation.conversation_id,
      session_id: sessionIdForConversation(conversation),
      turn_id: turnIdForConversation(conversation),
      do_not_retry: true,
      reason:
        "The input was submitted, but AKK could not fence later side effects to an exact native session. Inspect the pane and close this Turn before continuing."
    }
  });
}

export function presentTerminalUncertain(
  input: Readonly<{
    conversation: Conversation;
    stalledConversationIds: readonly string[];
    textInjected: boolean;
    enterDispatched: boolean;
    monitorPid?: number | null;
  }>,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts
): void {
  // Transport uncertainty is not monitor-eligible. A configured callback
  // route alone does not prove that an observation sidecar exists.
  const callbackExpected = false;
  ports.write({
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    conversation: input.conversation,
    message: context.message,
    delivered: input.enterDispatched,
    status: "submission_uncertain",
    submission_outcome: "uncertain",
    background: true,
    callback_expected: callbackExpected,
    terminal_control: context.terminalControl,
    monitor_pid: input.monitorPid ?? null,
    executor: context.executor,
    delivery_receipt: input.enterDispatched
      ? "enter_dispatched"
      : input.textInjected
        ? "text_injected"
        : undefined,
    do_not_retry: true,
    ...terminalSendResultContract({
      terminalInputDispatched: input.textInjected || input.enterDispatched,
      agentAcceptance: "unproven",
      managementMode: "managed",
      observationMode: callbackExpected ? "managed_monitor" : "none",
      callbackAvailable: callbackExpected
    }),
    stalled_conversation_ids: input.stalledConversationIds,
    reason: input.enterDispatched
      ? "AKK dispatched Enter but native acceptance or its exact identity became uncertain. Do not retry automatically; inspect this conversation and pane."
      : input.textInjected
        ? "AKK injected text but could not prove that Enter was dispatched. Do not retry automatically; inspect this conversation and pane."
        : "AKK could not prove that terminal input remained untouched. Inspect this conversation before retrying.",
    openclaw_next_action: {
      action: "inspect",
      conversation_id: input.conversation.conversation_id,
      session_id: sessionIdForConversation(input.conversation),
      turn_id: turnIdForConversation(input.conversation),
      do_not_retry: true,
      reason:
        "The terminal submission outcome is uncertain. Inspect AKK status and the shared terminal pane before deciding whether to close or continue."
    }
  });
}

export function presentTerminalCompleted(
  input: Readonly<{
    conversation: Conversation;
    acceptance?: TerminalDispatchAcceptance;
    monitorPid?: number | null;
    bookkeepingWarning?: string;
  }>,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts
): void {
  const outcome = input.acceptance?.outcome;
  const accepted = outcome === "agent_accepted";
  const pending = outcome === "pending_acceptance";
  const callbackExpected = callbackExpectedForConversation(input.conversation);
  const callbackAvailable = callbackExpected && (accepted || pending);
  ports.write({
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    conversation: input.conversation,
    message: context.message,
    delivered: true,
    status: accepted
      ? "async_pending"
      : pending
        ? "submission_pending_acceptance"
        : outcome === "not_accepted"
          ? "submission_not_accepted"
          : "submission_uncertain",
    submission_outcome: outcome,
    background: true,
    callback_expected: callbackAvailable,
    terminal_control: context.terminalControl,
    monitor_pid: input.monitorPid ?? null,
    executor: context.executor,
    budget: ports.budget(input.conversation),
    ...terminalSendResultContract({
      terminalInputDispatched: true,
      agentAcceptance: accepted ? "proven" : "unproven",
      managementMode: "managed",
      observationMode: callbackAvailable ? "managed_monitor" : "none",
      callbackAvailable,
      interactionNotificationAvailable: accepted,
      interactionResponseAvailable: accepted
    }),
    delivery_receipt: accepted
      ? "agent_accepted"
      : pending
        ? "enter_dispatched"
        : outcome,
    ...(!accepted ? { do_not_retry: true } : {}),
    ...(input.bookkeepingWarning
      ? { bookkeeping_warning: ports.summarize(input.bookkeepingWarning) }
      : {}),
    openclaw_next_action: accepted
      ? ports.nextAction({
          conversationId: input.conversation.conversation_id,
          sessionId: sessionIdForConversation(input.conversation),
          turnId: turnIdForConversation(input.conversation),
          source: "terminal_control",
          callbackExpected
        })
      : {
          action: pending ? "wait_for_acceptance" : "inspect",
          conversation_id: input.conversation.conversation_id,
          session_id: sessionIdForConversation(input.conversation),
          turn_id: turnIdForConversation(input.conversation),
          do_not_retry: true,
          reason: pending
            ? "Terminal transport is proven and the background monitor is still waiting for native acceptance."
            : outcome === "not_accepted"
              ? "The exact draft is still present; inspect the composer and do not send a duplicate."
              : "Native acceptance evidence became uncertain; inspect the shared pane."
        }
  });
}

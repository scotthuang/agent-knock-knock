import {
  sessionIdForConversation,
  turnIdForConversation,
  type AgentMessage,
  type Conversation,
  type Executor
} from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  RecordedTerminalZeroInputAbort,
  TerminalDispatchAcceptance
} from "./terminal-dispatch-application.js";
import type { terminalSubmissionReplayReceipt } from
  "./terminal-dispatch-receipt.js";
import { isRecord } from "./value-guards.js";

type ReplayReceipt = ReturnType<typeof terminalSubmissionReplayReceipt>;

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

export function presentTerminalDispatchReplay(
  input: Readonly<{
    owner: Conversation;
    receipt: ReplayReceipt;
    accepted: boolean;
    acceptanceInvalid: boolean;
    receiptConversationId: string;
    receiptMessageId: string;
    callbackExpected: boolean;
  }>,
  context: TerminalDispatchPresentationContext,
  ports: TerminalDispatchPresentationPorts
): void {
  const sessionId = sessionIdForConversation(input.owner);
  const turnId = turnIdForConversation(input.owner);
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
    delivered: input.receipt.delivered,
    status: input.receipt.status,
    submission_outcome: input.receipt.submission_outcome,
    background: true,
    callback_expected: input.callbackExpected,
    terminal_control: context.terminalControl,
    executor: context.executor,
    replayed: input.receipt.replayed,
    delivery_receipt: input.receipt.delivery_receipt,
    ...(input.receipt.do_not_retry
      ? { do_not_retry: input.receipt.do_not_retry }
      : {}),
    reason: input.accepted
      ? "AKK replayed the durable native acceptance receipt for an identical active terminal request and did not send terminal input again."
      : input.acceptanceInvalid
        ? `AKK refused to replay an invalid native acceptance receipt (${input.receipt.evidence_error ?? "evidence validation failed"}); no terminal input was sent.`
        : "AKK replayed the original transport-level receipt without upgrading it to native acceptance and did not send terminal input again.",
    openclaw_next_action: input.accepted
      ? ports.nextAction({
          conversationId: input.receiptConversationId,
          sessionId,
          turnId,
          source: "terminal_control",
          callbackExpected: input.callbackExpected
        })
      : {
          action: "inspect",
          conversation_id: input.receiptConversationId,
          session_id: sessionId,
          turn_id: turnId,
          do_not_retry: true,
          reason: input.acceptanceInvalid
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
    delivered: false,
    status: "submission_uncertain",
    submission_outcome: "uncertain",
    background: true,
    callback_expected: false,
    terminal_control: context.terminalControl,
    monitor_pid: monitorPid ?? null,
    executor: context.executor,
    delivery_receipt: "enter_dispatched",
    do_not_retry: true,
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
  ports.write({
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    conversation: input.conversation,
    message: context.message,
    delivered: false,
    status: "submission_uncertain",
    submission_outcome: "uncertain",
    background: true,
    callback_expected: Boolean(input.conversation.gateway_method),
    terminal_control: context.terminalControl,
    monitor_pid: input.monitorPid ?? null,
    executor: context.executor,
    do_not_retry: true,
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
  ports.write({
    session_id: sessionIdForConversation(input.conversation),
    turn_id: turnIdForConversation(input.conversation),
    conversation: input.conversation,
    message: context.message,
    delivered: accepted,
    status: accepted
      ? "async_pending"
      : pending
        ? "submission_pending_acceptance"
        : outcome === "not_accepted"
          ? "submission_not_accepted"
          : "submission_uncertain",
    submission_outcome: outcome,
    background: true,
    callback_expected: Boolean(
      input.conversation.gateway_method && (accepted || pending)
    ),
    terminal_control: context.terminalControl,
    monitor_pid: input.monitorPid ?? null,
    executor: context.executor,
    budget: ports.budget(input.conversation),
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
          callbackExpected: Boolean(input.conversation.gateway_method)
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

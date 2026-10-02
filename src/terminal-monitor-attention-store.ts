/** Persist managed-Turn approval and interaction notifications under the original Store/state transaction. */
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  executorForConversation,
  isWaitingForAgentStatus,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { executorDefinitionForKind } from "./executors.js";
import {
  appendEvent,
  loadState,
  pathsForConversationDir,
  saveState,
  withStoreWriterLease
} from "./store.js";
import type { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { cliNow, cliNowMs } from "./cli-runtime-context.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import type { TerminalInteractionProjection } from "./terminal-interaction-protocol.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
import { validTerminalMonitorTimestampMs } from "./terminal-monitor-decision-policy.js";
import {
  validMonitorInteractionProjection as validInteractionProjection,
  type ApprovalNotificationAdapterPorts,
  type InteractionNotificationAdapterPorts
} from "./terminal-monitor-cli-adapter.js";
import type { TerminalMonitorStatePaths } from "./terminal-monitor-state-reconciliation-service.js";
import { isRecord, nonBlankString } from "./value-guards.js";
import {
  type TerminalMonitorStateCliDependencies,
  takeoverFor
} from "./terminal-monitor-state-contract.js";

type ApprovalRecordRequest = Parameters<
  ApprovalNotificationAdapterPorts["record"]
>[0];

type InteractionRecordRequest = Parameters<
  InteractionNotificationAdapterPorts["record"]
>[0];

interface ApprovalPersistenceContext {
  input: ApprovalRecordRequest & TerminalMonitorStatePaths;
  conversation: Conversation;
  nativeTakeover: Record<string, unknown>;
  approvalScreenDigest?: string;
  previousApproval?: Record<string, unknown>;
  previousNotifiedAt?: number;
  previousCallbackMessageId?: string;
  matchingApprovalOutbox: boolean;
  conflictingActiveOutbox: boolean;
}

interface InteractionPersistenceContext {
  input: InteractionRecordRequest & TerminalMonitorStatePaths;
  conversation: Conversation;
  nativeTakeover: Record<string, unknown>;
  interactionScreenDigest?: string;
  previousNotification?: Record<string, unknown>;
  previousInteractionState?: TerminalInteractionProjection;
  previousCallbackMessageId?: string;
  matchingInteractionOutbox: boolean;
  activeOutbox: boolean;
  conflictingActiveOutbox: boolean;
}

type AttentionStoreDependencies = {
  runtime: Pick<TerminalMonitorStateCliDependencies["runtime"], "callbackRetryLimit" | "approvalTtlMs">;
};

export class TerminalMonitorAttentionStore {
  readonly #dependencies: AttentionStoreDependencies;
  readonly #stateFileLock: ReturnType<typeof createFileLockCliAdapter>;

  constructor(
    dependencies: AttentionStoreDependencies,
    stateFileLock: ReturnType<typeof createFileLockCliAdapter>
  ) {
    this.#dependencies = dependencies;
    this.#stateFileLock = stateFileLock;
  }

  recordApprovalNotification(
    input: ApprovalRecordRequest & TerminalMonitorStatePaths
  ) {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        if (!this.#approvalSnapshotMatches(conversation, input)) {
          return {
            conversation,
            duplicate: false,
            stale: true,
            recorded: undefined
          };
        }
        return this.#recordMatchingApproval(
          this.#approvalPersistenceContext(conversation, input)
        );
      } finally {
        release();
      }
    });
  }

  #approvalSnapshotMatches(
    conversation: Conversation,
    input: ApprovalRecordRequest
  ): boolean {
    const takeover = takeoverFor(conversation);
    const currentControl = terminalControlFromTakeover(takeover);
    return isWaitingForAgentStatus(conversation.status) &&
      conversation.conversation_id === input.expectedConversation.conversationId &&
      conversation.status === input.expectedConversation.status &&
      conversation.updated_at === input.expectedConversation.updatedAt &&
      takeover?.terminal_bridge === true &&
      nonBlankString(takeover.terminal_bridge_message_id) ===
        input.expectedConversation.messageId &&
      currentControl !== undefined &&
      terminalControlsShareIncarnation(currentControl, input.terminalControl);
  }

  #approvalPersistenceContext(
    conversation: Conversation,
    input: ApprovalRecordRequest & TerminalMonitorStatePaths
  ): ApprovalPersistenceContext {
    const nativeTakeover = { ...takeoverFor(conversation) };
    const screen = isRecord(input.terminalStatus.screen)
      ? input.terminalStatus.screen
      : undefined;
    const approvalScreenDigest = nonBlankString(screen?.digest);
    const previousApproval = isRecord(nativeTakeover.terminal_bridge_approval)
      ? nativeTakeover.terminal_bridge_approval
      : undefined;
    const previousNotifiedAt = validTerminalMonitorTimestampMs(
      previousApproval?.notified_at
    );
    const callbackDelivery = isRecord(conversation.callback_delivery)
      ? conversation.callback_delivery
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const previousCallbackMessageId = nonBlankString(
      previousApproval?.callback_message_id
    );
    const matchingApprovalOutbox =
      callbackDelivery?.kind === "approval_notification" &&
      previousCallbackMessageId !== undefined &&
      callbackMessage?.id === previousCallbackMessageId;
    const deliveryStatus = nonBlankString(callbackDelivery?.status);
    const deliveryAttempts = Number(callbackDelivery?.attempts ?? 0);
    const conflictingActiveOutbox = !matchingApprovalOutbox && (
      deliveryStatus === "pending" ||
      (
        deliveryStatus === "failed" &&
        Number.isFinite(deliveryAttempts) &&
        deliveryAttempts <= this.#dependencies.runtime.callbackRetryLimit
      )
    );
    return {
      input,
      conversation,
      nativeTakeover,
      approvalScreenDigest,
      previousApproval,
      previousNotifiedAt,
      previousCallbackMessageId,
      matchingApprovalOutbox,
      conflictingActiveOutbox
    };
  }

  #recordMatchingApproval(context: ApprovalPersistenceContext) {
    const duplicate =
      context.previousApproval?.fingerprint === context.input.fingerprint &&
      context.previousNotifiedAt !== undefined &&
      cliNowMs() - context.previousNotifiedAt <=
        this.#dependencies.runtime.approvalTtlMs;
    if (!duplicate) {
      return this.#recordNewApproval(context);
    }
    if (context.conflictingActiveOutbox) {
      return {
        conversation: context.conversation,
        duplicate: false,
        stale: true,
        deferred: true,
        previousApproval: context.previousApproval,
        recorded: undefined
      };
    }
    if (!context.matchingApprovalOutbox) {
      return this.#recoverApprovalOutbox(context);
    }
    return {
      conversation: context.conversation,
      duplicate: true,
      stale: false,
      previousApproval: context.previousApproval,
      recorded: undefined
    };
  }

  #recoverApprovalOutbox(context: ApprovalPersistenceContext) {
    const messageId = context.previousCallbackMessageId ?? `msg-${randomUUID()}`;
    const messageTs = nonBlankString(
      context.previousApproval?.callback_message_ts
    ) ?? nonBlankString(context.previousApproval?.notified_at) ??
      cliNow().toISOString();
    const conversation = context.previousCallbackMessageId
      ? context.conversation
      : {
          ...context.conversation,
          native_session_takeover: {
            ...context.nativeTakeover,
            terminal_bridge_approval: {
              ...context.previousApproval,
              callback_message_id: messageId,
              callback_message_ts: messageTs
            }
          }
        };
    if (!context.previousCallbackMessageId) {
      saveState(context.input.statePath, conversation);
    }
    const recorded = context.input.onRecorded(conversation, {
      recoverMissingOutbox: true
    });
    appendEvent(context.input.logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_approval_notification_outbox_recovered",
      terminal_control: context.input.terminalControl,
      fingerprint: context.input.fingerprint,
      callback_message_id: messageId
    });
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      recovered: true,
      stale: false,
      previousApproval: context.previousApproval,
      recorded
    };
  }

  #recordNewApproval(context: ApprovalPersistenceContext) {
    const now = cliNow().toISOString();
    const callbackMessageId = `msg-${randomUUID()}`;
    const conversation: Conversation = {
      ...context.conversation,
      native_session_takeover: {
        ...context.nativeTakeover,
        terminal_bridge_approval: {
          fingerprint: context.input.fingerprint,
          screen_digest: context.approvalScreenDigest,
          notified_at: now,
          terminal_control: context.input.terminalControl,
          approval_state: context.input.terminalStatus.approval_state,
          callback_message_id: callbackMessageId,
          callback_message_ts: now
        }
      },
      updated_at: now
    };
    saveState(context.input.statePath, conversation);
    appendEvent(context.input.logPath, {
      ts: now,
      conversation_id: context.conversation.conversation_id,
      event: "terminal_bridge_approval_notification_recorded",
      terminal_control: context.input.terminalControl,
      fingerprint: context.input.fingerprint,
      screen_digest: context.approvalScreenDigest
    });
    const recorded = context.input.onRecorded(conversation);
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      stale: false,
      recorded
    };
  }

  recordInteractionNotification(
    input: InteractionRecordRequest & TerminalMonitorStatePaths
  ) {
    const storeDir = pathsForConversationDir(path.dirname(input.statePath))
      .storeDir;
    return withStoreWriterLease(storeDir, () => {
      const release = this.#stateFileLock.acquire(`${input.statePath}.lock`);
      try {
        const conversation = loadState(input.statePath);
        if (!this.#interactionSnapshotMatches(conversation, input)) {
          return {
            conversation,
            duplicate: false,
            stale: true,
            recorded: undefined
          };
        }
        return this.#recordMatchingInteraction(
          this.#interactionPersistenceContext(conversation, input)
        );
      } finally {
        release();
      }
    });
  }

  #interactionSnapshotMatches(
    conversation: Conversation,
    input: InteractionRecordRequest
  ): boolean {
    const takeover = takeoverFor(conversation);
    const currentControl = terminalControlFromTakeover(takeover);
    const projection = input.terminalStatus.interaction_state;
    return conversation.status === "waiting_for_agent" &&
      conversation.conversation_id === input.expectedConversation.conversationId &&
      conversation.status === input.expectedConversation.status &&
      conversation.updated_at === input.expectedConversation.updatedAt &&
      takeover?.terminal_bridge === true &&
      nonBlankString(takeover.terminal_bridge_message_id) ===
        input.expectedConversation.messageId &&
      currentControl !== undefined &&
      terminalControlsShareIncarnation(currentControl, input.terminalControl) &&
      projection?.interaction_id === input.interactionId &&
      projection.questions.length === 1 &&
      projection.questions[0]?.question_id === input.questionId &&
      input.terminalStatus.interaction_prompt_fingerprint === input.fingerprint &&
      input.terminalStatus.interaction_surface_id === input.surfaceId &&
      validTerminalInteractionSurfaceId(input.surfaceId);
  }

  #interactionPersistenceContext(
    conversation: Conversation,
    input: InteractionRecordRequest & TerminalMonitorStatePaths
  ): InteractionPersistenceContext {
    const nativeTakeover = { ...takeoverFor(conversation) };
    const screen = isRecord(input.terminalStatus.screen)
      ? input.terminalStatus.screen
      : undefined;
    const interactionScreenDigest = nonBlankString(screen?.digest);
    const previousNotification = isRecord(
      nativeTakeover.terminal_bridge_interaction_notification
    )
      ? nativeTakeover.terminal_bridge_interaction_notification
      : undefined;
    const previousInteractionState = validInteractionProjection(
      previousNotification?.interaction_state
    );
    const callbackField = input.terminalStatus.interaction_state?.kind ===
        "async_question"
      ? "callback_notification_delivery"
      : "callback_delivery";
    const callbackDelivery = isRecord(conversation[callbackField])
      ? conversation[callbackField]
      : undefined;
    const callbackMessage = isRecord(callbackDelivery?.message)
      ? callbackDelivery.message
      : undefined;
    const callbackMetadata = isRecord(callbackMessage?.metadata)
      ? callbackMessage.metadata
      : undefined;
    const callbackInteractionState = validInteractionProjection(
      callbackMetadata?.interaction_state
    );
    const callbackInteractionReason = callbackInteractionState?.state === "pending" &&
        callbackInteractionState.capabilities.respond === true &&
        callbackInteractionState.questions[0]?.response_kind !== "multi_select"
      ? "interaction_required"
      : "interaction_manual_required";
    const previousCallbackMessageId = nonBlankString(
      previousNotification?.callback_message_id
    );
    const matchingInteractionOutbox =
      callbackDelivery?.kind === "interaction_notification" &&
      previousCallbackMessageId !== undefined &&
      callbackMessage?.id === previousCallbackMessageId &&
      callbackMetadata?.source === "terminal_bridge" &&
      callbackMetadata?.reason === callbackInteractionReason &&
      callbackInteractionState !== undefined &&
      callbackInteractionState.interaction_id ===
        previousNotification?.interaction_id &&
      callbackInteractionState.questions.length === 1 &&
      callbackInteractionState.questions[0]?.question_id ===
        previousNotification?.question_id &&
      previousNotification?.surface_id === input.surfaceId &&
      callbackInteractionState.turn_id === turnIdForConversation(conversation);
    const deliveryStatus = nonBlankString(callbackDelivery?.status);
    const deliveryAttempts = Number(callbackDelivery?.attempts ?? 0);
    const activeOutbox =
      deliveryStatus === "pending" ||
      (
        deliveryStatus === "failed" &&
        Number.isFinite(deliveryAttempts) &&
        deliveryAttempts <= this.#dependencies.runtime.callbackRetryLimit
      );
    const conflictingActiveOutbox = activeOutbox && !matchingInteractionOutbox;
    return {
      input,
      conversation,
      nativeTakeover,
      interactionScreenDigest,
      previousNotification,
      previousInteractionState,
      previousCallbackMessageId,
      matchingInteractionOutbox,
      activeOutbox,
      conflictingActiveOutbox
    };
  }

  #recordMatchingInteraction(context: InteractionPersistenceContext) {
    const duplicate =
      context.previousNotification?.terminal_bridge_message_id ===
        context.input.expectedConversation.messageId &&
      context.previousNotification?.interaction_id ===
        context.input.interactionId &&
      context.previousNotification?.question_id === context.input.questionId &&
      context.previousNotification?.prompt_fingerprint ===
        context.input.fingerprint &&
      context.previousNotification?.surface_id === context.input.surfaceId &&
      context.previousInteractionState?.interaction_id ===
        context.input.interactionId &&
      context.previousInteractionState.questions.length === 1 &&
      context.previousInteractionState.questions[0]?.question_id ===
        context.input.questionId;
    if (
      context.conflictingActiveOutbox ||
      (context.activeOutbox && !duplicate)
    ) {
      return {
        conversation: context.conversation,
        duplicate: false,
        stale: true,
        deferred: true,
        recorded: undefined
      };
    }
    if (!duplicate) {
      return this.#recordNewInteraction(context);
    }
    if (!context.matchingInteractionOutbox) {
      return this.#recoverInteractionOutbox(context);
    }
    return {
      conversation: context.conversation,
      duplicate: true,
      stale: false,
      recorded: undefined
    };
  }

  #recoverInteractionOutbox(context: InteractionPersistenceContext) {
    const messageId = context.previousCallbackMessageId ?? `msg-${randomUUID()}`;
    const messageTs = nonBlankString(
      context.previousNotification?.callback_message_ts
    ) ?? nonBlankString(context.previousNotification?.notified_at) ??
      cliNow().toISOString();
    const conversation = context.previousCallbackMessageId
      ? context.conversation
      : {
          ...context.conversation,
          native_session_takeover: {
            ...context.nativeTakeover,
            terminal_bridge_interaction_notification: {
              ...context.previousNotification,
              callback_message_id: messageId,
              callback_message_ts: messageTs
            }
          }
        };
    if (!context.previousCallbackMessageId) {
      saveState(context.input.statePath, conversation);
    }
    const recorded = context.input.onRecorded(conversation, {
      recoverMissingOutbox: true
    });
    appendEvent(context.input.logPath, {
      ts: cliNow().toISOString(),
      conversation_id: conversation.conversation_id,
      event: "terminal_bridge_interaction_notification_outbox_recovered",
      terminal_control: context.input.terminalControl,
      interaction_id: context.input.interactionId,
      question_id: context.input.questionId,
      callback_message_id: messageId
    });
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      recovered: true,
      stale: false,
      recorded
    };
  }

  #recordNewInteraction(context: InteractionPersistenceContext) {
    const now = cliNow().toISOString();
    const callbackMessageId = `msg-${randomUUID()}`;
    const conversation: Conversation = {
      ...context.conversation,
      native_session_takeover: {
        ...context.nativeTakeover,
        terminal_bridge_interaction_notification: {
          terminal_bridge_message_id:
            context.input.expectedConversation.messageId,
          interaction_id: context.input.interactionId,
          question_id: context.input.questionId,
          prompt_fingerprint: context.input.fingerprint,
          surface_id: context.input.surfaceId,
          screen_digest: context.interactionScreenDigest,
          notified_at: now,
          terminal_control: context.input.terminalControl,
          interaction_state: context.input.terminalStatus.interaction_state,
          callback_message_id: callbackMessageId,
          callback_message_ts: now
        }
      },
      updated_at: now
    };
    saveState(context.input.statePath, conversation);
    appendEvent(context.input.logPath, {
      ts: now,
      conversation_id: context.conversation.conversation_id,
      event: "terminal_bridge_interaction_notification_recorded",
      terminal_control: context.input.terminalControl,
      interaction_id: context.input.interactionId,
      question_id: context.input.questionId,
      screen_digest: context.interactionScreenDigest
    });
    const recorded = context.input.onRecorded(conversation);
    return {
      conversation: recorded.prepared?.conversation ?? conversation,
      duplicate: false,
      stale: false,
      recorded
    };
  }
}

export function terminalBridgeApprovalInstructions(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
}): string {
  const approval: Record<string, unknown> =
    isRecord(input.terminalStatus.approval_state)
    ? input.terminalStatus.approval_state
    : {};
  const screen: Record<string, unknown> = isRecord(input.terminalStatus.screen)
    ? input.terminalStatus.screen
    : {};
  const executor = executorForConversation(input.conversation);
  const agentName = executorDefinitionForKind(executor.kind).displayName;
  const label = nonBlankString(approval.label) ??
    `the current ${agentName} approval prompt`;
  const keys = Array.isArray(approval.keys)
    ? approval.keys.filter((value): value is string => typeof value === "string")
    : [];
  const decisionMode = nonBlankString(approval.decision_mode);
  const keyDescription = keys.length > 0
    ? keys.join(" then ")
    : nonBlankString(approval.key) ?? "the detected approve key sequence";
  const promptKind = nonBlankString(approval.prompt_kind);
  const command = nonBlankString(approval.command);
  const toolName = nonBlankString(approval.tool_name);
  const requestDetail = nonBlankString(approval.request_detail);
  const requestId = nonBlankString(approval.request_id);
  const decisions = Array.isArray(approval.choices)
    ? approval.choices.flatMap((choice) =>
        isRecord(choice) &&
          (choice.decision === "approve_once" || choice.decision === "reject")
          ? [choice.decision]
          : []
      )
    : ["approve_once"];
  const excerpt = nonBlankString(screen.excerpt) ??
    "(No terminal excerpt was available.)";
  const directReview = executor.kind === "claude" && decisionMode === "keys";
  return approvalInstructionLines({
    ...input,
    approval,
    agentName,
    label,
    keyDescription,
    promptKind,
    command,
    toolName,
    requestDetail,
    requestId,
    decisions,
    excerpt,
    directReview
  }).filter((line): line is string => line !== undefined).join("\n");
}

function approvalInstructionLines(input: {
  conversation: Conversation;
  terminalControl: TerminalControlRef;
  approval: Record<string, unknown>;
  agentName: string;
  label: string;
  keyDescription: string;
  promptKind?: string;
  command?: string;
  toolName?: string;
  requestDetail?: string;
  requestId?: string;
  decisions: string[];
  excerpt: string;
  directReview: boolean;
}): Array<string | undefined> {
  const turnId = turnIdForConversation(input.conversation);
  return [
    `${input.agentName} is waiting for approval in a terminal-controlled AKK session.`,
    "",
    `Turn: ${turnId}`,
    `Terminal: ${input.terminalControl.kind}:${input.terminalControl.target}`,
    `Approval option: ${input.label} (${input.keyDescription})`,
    input.promptKind ? `Request kind: ${input.promptKind}` : undefined,
    input.toolName ? `Tool: ${input.toolName}` : undefined,
    input.requestDetail ? `Request: ${input.requestDetail}` : undefined,
    input.command ? `Command: ${input.command}` : undefined,
    input.requestId ? `Request id: ${input.requestId}` : undefined,
    "",
    "Safe terminal excerpt:",
    "```text",
    input.excerpt,
    "```",
    "",
    input.directReview
      ? `Before asking for approval, have the user personally inspect the live ${input.terminalControl.kind} pane ${input.terminalControl.target}.`
      : undefined,
    input.directReview
      ? "This hookless callback intentionally omits raw command details; do not approve from the summary alone."
      : undefined,
    input.directReview ? "" : undefined,
    `Ask the user whether to approve or deny this ${input.agentName} request.`,
    "",
    "If the user approves, call `agent_knock_knock_approve` with only:",
    `- turn_id: ${turnId}`,
    "- decision: approve_once",
    "",
    input.decisions.includes("reject")
      ? "If the user rejects this permission but wants the Turn to continue, call `agent_knock_knock_approve` with only:"
      : "This exact prompt has no adapter-proven reject transport; denial requires manual terminal resolution.",
    input.decisions.includes("reject") ? `- turn_id: ${turnId}` : undefined,
    input.decisions.includes("reject") ? "- decision: reject" : undefined,
    input.decisions.includes("reject") ? "" : undefined,
    "If the user wants to stop the managed Turn, call `agent_knock_knock_cancel` with:",
    `- turn_id: ${turnId}`,
    "",
    "Do not use raw tmux, shell, or manual key presses for this approval. Do not approve without explicit user confirmation."
  ];
}

function validTerminalInteractionSurfaceId(value: unknown): value is string {
  return typeof value === "string" && /^tis_[0-9a-f]{40}$/u.test(value);
}

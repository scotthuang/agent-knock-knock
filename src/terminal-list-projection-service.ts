import type {
  DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import type { ManagedSessionState } from "./managed-session.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { sessionShortRef } from "./session-selector.js";
import {
  authoritativeTerminalIdentity,
  compareManagedConversationRecency,
  decideManagedTerminalAssociation,
  decideTerminalSendAuthority,
  nonOwnerTerminalActions,
  projectBlockingTurn,
  projectHandoffPresentation,
  projectPublicManagementConflict,
  projectTerminalManagement,
  selectManagedTerminalHistory,
  selectTerminalAvailableActions,
  type TerminalActionSet
} from "./terminal-action-projection.js";
import {
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import {
  currentTerminalActions,
  readOnlyListActions,
  readOnlyManagedTurn,
  userReleaseListActions,
  userReleasableManagedTurn,
  renderCurrentManagedTurn,
  renderHistoricalManagedTurn,
  renderManagedTurnListEntry,
  safeUnavailableManagedTurnActions,
  sendActionForManagedSession
} from "./terminal-list-renderer.js";
import {
  decideManagedTurnListActions,
  type ManagedTurnListRuntimeActionFacts
} from "./terminal-managed-turn-list-action-policy.js";
import {
  type TerminalListOwnershipContext,
  type TerminalListOwnershipService
} from "./terminal-list-ownership-service.js";
import { validTerminalMonitorTimestampMs as validTimestampMs } from
  "./terminal-monitor-decision-policy.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

export interface TerminalListProjectionPorts {
  approvalTtlMs: number;
  callbackRetryDisposition(delivery: unknown): { state: string };
  isVerifiedDeadTerminalAgentProcess(
    conversation: Conversation | Record<string, any>
  ): boolean;
  listDeferredForegroundTransfers(
    storeDir: string
  ): DeferredForegroundTransfer[];
  nowMs(): number;
  ownershipService: TerminalListOwnershipService;
  summarizeConversation(conversation: Conversation): Record<string, any>;
  terminalBridgeEnabled(
    conversation: Conversation | Record<string, any>
  ): boolean;
  terminalBridgeSubmission(
    conversation: Conversation | Record<string, any> | undefined
  ): {
    status?: string;
    message_id?: unknown;
    last_proven_stage?: unknown;
  } | undefined;
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
}

export interface TerminalFirstListProjectionRequest {
  storeDir: string;
  terminals: Record<string, any>[];
  managedSessions: ManagedSessionState[];
  sessionAuthorityRequired: boolean;
  allConversations: Conversation[];
  displayedConversations: Conversation[];
  includeAll: boolean;
  managedOnly: boolean;
  statusFilter?: string;
  mutationsAllowed: boolean;
}

export interface TerminalFirstListProjection {
  terminals: Record<string, any>[];
  unavailableManagedTurns: Record<string, any>[];
}

export interface ManagedTurnListEntryOptions {
  terminalBridge?: boolean;
  approvalState?: Record<string, any>;
  conversation?: Record<string, any>;
}

export interface TerminalListProjectionService {
  managedTurnListEntry(
    task: Record<string, any>,
    options?: ManagedTurnListEntryOptions
  ): Record<string, any>;
  projectTerminalFirstList(
    request: TerminalFirstListProjectionRequest
  ): TerminalFirstListProjection;
}

type TerminalFirstListContext = TerminalListOwnershipContext & {
  sessionAuthorityRequired: boolean;
  includeAll: boolean;
};

function managedTurnListActionFacts(
  ports: TerminalListProjectionPorts,
  task: Record<string, any>,
  conversation?: Record<string, any>
): ManagedTurnListRuntimeActionFacts {
  const nativeTakeover = isRecord(conversation?.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const managedApprovalPending = isRecord(
    nativeTakeover?.terminal_bridge_approval
  );
  const terminalBridgeReady = Boolean(
    conversation &&
    ports.terminalBridgeEnabled(conversation) &&
    ports.terminalControlFromTakeover(nativeTakeover) !== undefined
  );
  const submission = ports.terminalBridgeSubmission(conversation);
  const renewEligible = Boolean(
    terminalBridgeReady &&
    task.status === "stalled" &&
    submission?.status !== "uncertain" &&
    !ports.isVerifiedDeadTerminalAgentProcess(conversation ?? {})
  );
  const callbackDelivery = isRecord(conversation?.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const retryCallbackEligible = Boolean(
    conversation &&
    conversation.legacy_callback_status_error === undefined &&
    ports.callbackRetryDisposition(callbackDelivery).state === "retryable"
  );
  const retrySubmissionCandidate = Boolean(
    conversation &&
    executorForConversation(conversation as Conversation).kind === "codex" &&
    terminalBridgeReady &&
    task.status === "stalled" &&
    submission?.status === "uncertain" &&
    stringValue(submission.last_proven_stage) === "text_injected"
  );
  return {
    terminalBridgeReady,
    managedApprovalPending,
    renewEligible,
    retryCallbackEligible,
    retrySubmissionCandidate
  };
}

function managedListApprovalState(
  ports: TerminalListProjectionPorts,
  conversation: Record<string, any>
): Record<string, any> | undefined {
  if (
    !ports.terminalBridgeEnabled(conversation) ||
    !["waiting_for_agent", "waiting_for_openclaw"].includes(
      String(conversation.status)
    )
  ) {
    return undefined;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (
    !ports.terminalControlFromTakeover(nativeTakeover) ||
    !stringValue(nativeTakeover?.terminal_bridge_message_id)
  ) {
    return undefined;
  }
  const approval = isRecord(nativeTakeover?.terminal_bridge_approval)
    ? nativeTakeover.terminal_bridge_approval
    : undefined;
  const approvalState = isRecord(approval?.approval_state)
    ? approval.approval_state
    : undefined;
  const fingerprint = stringValue(approval?.fingerprint);
  const notifiedAt = stringValue(approval?.notified_at);
  const notifiedAtMs = validTimestampMs(notifiedAt);
  if (
    !approvalState ||
    !fingerprint ||
    notifiedAtMs === undefined ||
    ports.nowMs() - notifiedAtMs > ports.approvalTtlMs
  ) {
    return undefined;
  }
  return {
    ...approvalState,
    fingerprint,
    notified_at: notifiedAt
  };
}

function managedTurnListEntry(
  ports: TerminalListProjectionPorts,
  task: Record<string, any>,
  {
    terminalBridge = false,
    approvalState,
    conversation
  }: ManagedTurnListEntryOptions = {}
): Record<string, any> {
  const projectedApprovalState = approvalState ?? (conversation
    ? managedListApprovalState(ports, conversation)
    : undefined);
  const runtimeFacts = managedTurnListActionFacts(
    ports,
    task,
    conversation
  );
  const orphanedTerminalDispatch = isRecord(
    task.orphaned_terminal_dispatch
  )
    ? task.orphaned_terminal_dispatch
    : undefined;
  return renderManagedTurnListEntry(task, {
    approvalState: projectedApprovalState,
    actionDecision: decideManagedTurnListActions({
      status: task.status,
      agent: task.agent,
      terminalBridgeAdvertised: terminalBridge,
      approvalState: projectedApprovalState,
      orphanedTerminalDispatch,
      ...runtimeFacts
    })
  });
}

function historicalManagedTurnForTerminal(
  ports: TerminalListProjectionPorts,
  conversation: Conversation
): Record<string, any> {
  return renderHistoricalManagedTurn(managedTurnListEntry(
    ports,
    ports.summarizeConversation(conversation),
    {
      terminalBridge: ports.terminalBridgeEnabled(conversation),
      approvalState: managedListApprovalState(ports, conversation),
      conversation
    }
  ));
}

function currentManagedTurnForTerminal(
  ports: TerminalListProjectionPorts,
  conversation: Conversation,
  terminal: Record<string, any>,
  rawTerminalActions: Record<string, any>
): Record<string, any> {
  const managedTurn = managedTurnListEntry(
    ports,
    ports.summarizeConversation(conversation),
    {
      terminalBridge: ports.terminalBridgeEnabled(conversation),
      approvalState: managedListApprovalState(ports, conversation),
      conversation
    }
  );
  const rawApproval = isRecord(rawTerminalActions.approve)
    ? rawTerminalActions.approve
    : undefined;
  if (!rawApproval || executorForConversation(conversation).kind !== "codex") {
    return managedTurn;
  }
  return renderCurrentManagedTurn(managedTurn, {
    isCodex: true,
    ownerId: conversation.conversation_id,
    rawApproval,
    terminalApprovalState: () => isRecord(terminal.approval_state)
      ? terminal.approval_state
      : undefined
  });
}

function renderTerminalFirstListEntry(
  ports: TerminalListProjectionPorts,
  terminal: Record<string, any>,
  context: TerminalFirstListContext,
  observation: ReturnType<
    TerminalListOwnershipService["observeActionAuthority"]
  >
): Record<string, any> {
  const {
    sessionAuthorityRequired,
    includeAll,
    mutationsAllowed,
    conversationHasNonterminalDeferredTransfer
  } = context;
  const {
    automatedInputComposerReady,
    terminalUserExplicitSendAction,
    publicTerminal,
    allRelated,
    displayedRelated,
    relatedSessions,
    authoritativeSession,
    ownership,
    rawSendAction,
    sessionAwareRawActions,
    externalHandoffDetected,
    externalHandoffSnapshotToken,
    handoffSourceBlockingTurns,
    verifiedEmptyRawSendAction,
    verifiedEmptyCodexSnapshotToken,
    deferredCodexSourceRolloutAuthority,
    deferredCodexForegroundToken,
    reconcileBindingAction,
    externalHandoffAdoptable,
    handoffDecision,
    terminalRecoveryBlockingTurns,
    terminalScopedCodexApprovalAction,
    rolloutBackedCodexSession
  } = observation;
  const association = decideManagedTerminalAssociation({
    allRelated,
    displayedRelated,
    authoritativeSession,
    sessionAuthorityRequired,
    currentOwner: ownership.state === "current"
      ? ownership.conversation
      : undefined
  });
  const {
    managedSessionId,
    sessionIds,
    sessionAllRelated,
    sessionDisplayedRelated
  } = association;
  const sessionBindingMatchesLiveTerminal = authoritativeSession
    ? true
    : Boolean(
        !sessionAuthorityRequired &&
        sessionAllRelated.some((turn) =>
          ports.ownershipService.managedTurnMatchesLiveTerminal(turn, terminal)
        )
      );
  const currentTurnValue = ownership.state === "current"
    ? currentManagedTurnForTerminal(
        ports,
        ownership.conversation,
        terminal,
        sessionAwareRawActions
      )
    : undefined;
  const currentTurnProjection = currentTurnValue
    ? !mutationsAllowed
      ? readOnlyManagedTurn(currentTurnValue)
      : ownership.state === "current" &&
          conversationHasNonterminalDeferredTransfer(ownership.conversation)
        ? userReleasableManagedTurn(currentTurnValue)
        : currentTurnValue
    : undefined;
  const currentTurn = currentTurnProjection;
  const nonOwnerRawActions = nonOwnerTerminalActions(
    sessionAwareRawActions as TerminalActionSet<Record<string, any>>,
    {
      hasAuthoritativeSession: Boolean(authoritativeSession),
      rolloutBackedCodexSession
    }
  );
  const { recentConversation, historyConversations } =
    selectManagedTerminalHistory({
      displayedRelated: sessionDisplayedRelated,
      currentConversationId: stringValue(currentTurn?.conversation_id),
      hasCurrentTurn: Boolean(currentTurn),
      includeAll
    });
  const recentTurnValue = recentConversation
    ? historicalManagedTurnForTerminal(ports, recentConversation)
    : undefined;
  const recentTurnProjection = recentTurnValue
    ? !mutationsAllowed
      ? readOnlyManagedTurn(recentTurnValue)
      : recentConversation &&
          conversationHasNonterminalDeferredTransfer(recentConversation)
        ? userReleasableManagedTurn(recentTurnValue)
        : recentTurnValue
    : undefined;
  const recentTurn = recentTurnProjection;
  const history = historyConversations.map((conversation) => {
    const turn = historicalManagedTurnForTerminal(ports, conversation);
    return !mutationsAllowed
      ? readOnlyManagedTurn(turn)
      : conversationHasNonterminalDeferredTransfer(conversation)
        ? userReleasableManagedTurn(turn)
        : turn;
  });
  const visibleTurnIds = new Set(
    [currentTurn, recentTurn, ...history]
      .map((turn) => stringValue(turn?.conversation_id))
      .filter((id): id is string => id !== undefined)
  );
  const managedSessionShortReference = managedSessionId
    ? sessionShortRef(managedSessionId)
    : null;
  const management = projectTerminalManagement({
    managedSessionId,
    managedSessionShortRef: managedSessionShortReference,
    currentTurn,
    recentTurn,
    sessionAllRelatedCount: sessionAllRelated.length,
    hiddenTurnCount: sessionAllRelated.filter((conversation) =>
      !visibleTurnIds.has(conversation.conversation_id)
    ).length,
    sessionCount: new Set([
      ...sessionIds,
      ...relatedSessions.map((session) => session.session_id)
    ]).size,
    authoritativeSession,
    history: includeAll ? history : undefined
  });
  const sendAuthority = decideTerminalSendAuthority({
    ownership: ownership.state,
    verifiedEmptyToken: verifiedEmptyCodexSnapshotToken,
    externalToken: externalHandoffAdoptable
      ? externalHandoffSnapshotToken
      : undefined,
    deferredToken: ownership.state !== "conflict" ||
        deferredCodexSourceRolloutAuthority ===
          "explicitly_abandoned_predecessor"
      ? deferredCodexForegroundToken
      : undefined,
    managedSendSessionId:
      managedSessionId &&
        !rolloutBackedCodexSession &&
        sessionBindingMatchesLiveTerminal &&
        isRecord(sessionAwareRawActions.send)
        ? managedSessionId
        : undefined
  });
  const tokenSendAction = sendAuthority.mode === "external_handoff"
    ? rawSendAction
    : sendAuthority.mode === "verified_empty" ||
        sendAuthority.mode === "deferred"
      ? verifiedEmptyRawSendAction
      : undefined;
  const authoritativeSendAction =
    sendAuthority.mode === "managed" && isRecord(sessionAwareRawActions.send)
      ? sendActionForManagedSession(
          sessionAwareRawActions.send,
          sendAuthority.sessionId
        )
      : tokenSendAction && "token" in sendAuthority && sendAuthority.token
        ? {
            ...tokenSendAction,
            arguments: {
              ...(isRecord(tokenSendAction.arguments)
                ? tokenSendAction.arguments
                : {}),
              expected_terminal_token: sendAuthority.token
            }
          }
        : undefined;
  const managedFastPathToken = "token" in sendAuthority
    ? sendAuthority.token
    : undefined;
  const prioritizedTerminalUserExplicitSendAction =
    terminalUserExplicitSendAction && managedFastPathToken
      ? {
          ...terminalUserExplicitSendAction,
          arguments: {
            ...(isRecord(terminalUserExplicitSendAction.arguments)
              ? terminalUserExplicitSendAction.arguments
              : {}),
            expected_managed_terminal_token: managedFastPathToken
          }
        }
      : terminalUserExplicitSendAction;
  const availableActions = selectTerminalAvailableActions({
    ownership: ownership.state,
    currentActions: ownership.state === "current"
      ? currentTerminalActions(currentTurn)
      : {},
    sessionAwareRawActions:
      sessionAwareRawActions as TerminalActionSet<Record<string, any>>,
    nonOwnerRawActions,
    authoritativeSendAction,
    terminalUserExplicitSendAction:
      prioritizedTerminalUserExplicitSendAction,
    reconcileBindingAction,
    terminalScopedApprovalAction: terminalScopedCodexApprovalAction,
    isAction: isRecord
  });
  const authoritativeIdentity = authoritativeTerminalIdentity(
    authoritativeSession
  );
  const publicManagementConflict = ownership.state === "conflict"
    ? projectPublicManagementConflict({
        conflict: ownership.conflict,
        verifiedEmptyToken: verifiedEmptyCodexSnapshotToken,
        deferredToken: deferredCodexForegroundToken,
        explicitlyAbandonedPredecessor:
          deferredCodexSourceRolloutAuthority ===
            "explicitly_abandoned_predecessor"
      })
    : undefined;
  const handoffPresentation = projectHandoffPresentation({
    externalHandoffDetected,
    externalHandoffAdoptable,
    recoveryBlockingTurnCount: terminalRecoveryBlockingTurns.length,
    hasHandoffDecision: Boolean(handoffDecision),
    sourceBlockingTurnCount: handoffSourceBlockingTurns.length,
    automatedInputComposerReady: automatedInputComposerReady === true,
    verifiedEmptyToken: verifiedEmptyCodexSnapshotToken
  });
  return {
    ...publicTerminal,
    ...authoritativeIdentity,
    management_state: ownership.state === "conflict"
      ? "conflict"
      : ownership.state === "current" || Boolean(authoritativeSession)
        ? "managed"
        : "unmanaged",
    ...(ownership.state === "conflict"
      ? { management_conflict: publicManagementConflict }
      : {}),
    ...handoffPresentation,
    ...(handoffDecision ? { handoff_decision: handoffDecision } : {}),
    ...(terminalRecoveryBlockingTurns.length > 0
      ? {
          blocking_turns: terminalRecoveryBlockingTurns.map((turn) =>
            projectBlockingTurn({
              sessionId: sessionIdForConversation(turn),
              turnId: turnIdForConversation(turn),
              status: turn.status,
              recoveryTurnId: turnIdForConversation(turn)
            })
          )
        }
      : {}),
    managed: management,
    available_actions: availableActions
  };
}

function projectionContext(
  ports: TerminalListProjectionPorts,
  request: TerminalFirstListProjectionRequest
): TerminalFirstListContext {
  const nonterminalDeferredTransfers = ports.listDeferredForegroundTransfers(
    request.storeDir
  ).filter((transfer) =>
    !isFinalDeferredForegroundTransferStatus(transfer.status)
  );
  const transferIds = new Set(
    nonterminalDeferredTransfers.map((transfer) => transfer.transfer_id)
  );
  const sourceTurnIds = new Set(
    nonterminalDeferredTransfers.flatMap((transfer) =>
      transfer.version === 2 &&
        transfer.source_kind === "candidate_rollout_quiescent"
        ? (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
        : []
    )
  );
  const conversationHasNonterminalDeferredTransfer = (
    conversation: Conversation
  ): boolean => {
    if (sourceTurnIds.has(turnIdForConversation(conversation))) {
      return true;
    }
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const transferId = stringValue(takeover?.deferred_foreground_transfer_id);
    return Boolean(transferId && transferIds.has(transferId));
  };
  return {
    storeDir: request.storeDir,
    terminals: request.terminals,
    managedSessions: request.managedSessions,
    sessionAuthorityRequired: request.sessionAuthorityRequired,
    allConversations: request.allConversations,
    displayedConversations: request.displayedConversations,
    includeAll: request.includeAll,
    mutationsAllowed: request.mutationsAllowed,
    nonterminalDeferredTransfers,
    conversationHasNonterminalDeferredTransfer
  };
}

function unavailableManagedTurns(
  ports: TerminalListProjectionPorts,
  request: TerminalFirstListProjectionRequest,
  context: TerminalFirstListContext
): Record<string, any>[] {
  const discoveredTerminalControls = request.terminals.flatMap((terminal) => {
    const control = isRecord(terminal.terminal_control)
      ? terminal.terminal_control as unknown as TerminalControlRef
      : undefined;
    return control ? [control] : [];
  });
  return request.displayedConversations
    .filter((conversation) => {
      const managedControl =
        ports.ownershipService.terminalControlForManagedConversation(
          conversation
        );
      if (discoveredTerminalControls.some((control) =>
        terminalControlsShareIncarnation(managedControl, control)
      )) {
        return false;
      }
      return request.includeAll || request.managedOnly ||
        request.statusFilter !== undefined ||
        ports.ownershipService.managedTurnNeedsAttention(conversation);
    })
    .sort(compareManagedConversationRecency)
    .map((conversation) => {
      const managedTurn = managedTurnListEntry(
        ports,
        ports.summarizeConversation(conversation),
        {
          terminalBridge: ports.terminalBridgeEnabled(conversation),
          approvalState: managedListApprovalState(ports, conversation),
          conversation
        }
      );
      const availableActions = isRecord(managedTurn.available_actions)
        ? managedTurn.available_actions
        : {};
      return {
        ...managedTurn,
        available_actions: !request.mutationsAllowed
          ? readOnlyListActions(availableActions)
          : context.conversationHasNonterminalDeferredTransfer(conversation)
            ? userReleaseListActions(
                availableActions,
                turnIdForConversation(conversation)
              )
            : safeUnavailableManagedTurnActions(availableActions),
        terminal_availability: {
          available: false,
          reason: request.managedOnly
            ? "terminal discovery was disabled by --managed-only"
            : "the referenced terminal pane is not currently available"
        }
      };
    });
}

function projectTerminalFirstList(
  ports: TerminalListProjectionPorts,
  request: TerminalFirstListProjectionRequest
): TerminalFirstListProjection {
  const context = projectionContext(ports, request);
  return {
    terminals: request.terminals.map((terminal) => {
      const binding = ports.ownershipService.observeBindingAuthority(
        terminal,
        context
      );
      const authorityTerminal = binding.authorityTerminal;
      return renderTerminalFirstListEntry(
        ports,
        authorityTerminal,
        context,
        ports.ownershipService.observeActionAuthority(
          authorityTerminal,
          context,
          binding
        )
      );
    }),
    unavailableManagedTurns: unavailableManagedTurns(ports, request, context)
  };
}

export function createTerminalListProjectionService(
  ports: TerminalListProjectionPorts
): TerminalListProjectionService {
  return Object.freeze({
    managedTurnListEntry: (task, options) =>
      managedTurnListEntry(ports, task, options),
    projectTerminalFirstList: (request) =>
      projectTerminalFirstList(ports, request)
  });
}

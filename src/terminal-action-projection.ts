import {
  managedSessionBindingToken,
  unmanagedTerminalBindingToken,
  type ManagedSessionState
} from "./managed-session.js";
import type { ExecutorKind } from "./executors.js";
import {
  isSessionSendBlockingStatus,
  sessionIdForConversation,
  type Conversation
} from "./protocol.js";
import type { ManagedBindingConflictKind } from
  "./terminal-authority-policy.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalEndpointFromControlRef,
  type TerminalControlRef
} from "./terminal-control-ref.js";

export type TerminalActionName =
  | "status"
  | "send"
  | "new_thread"
  | "list_resumable_threads"
  | "native_inspect"
  | "resume_thread"
  | "reconcile_binding"
  | "respond"
  | "approve"
  | "cancel"
  | "renew"
  | "retry_callback"
  | "retry_submission"
  | "watch"
  | "close";

export type TerminalActionSet<Action> = Partial<{
  [Name in TerminalActionName]: Action;
}>;

export interface TerminalSendAuthorityFacts {
  readonly ownership: "none" | "current" | "conflict";
  readonly verifiedEmpty?: boolean;
  readonly externalHandoff?: boolean;
  readonly deferred?: boolean;
  readonly deferredToken?: string;
  readonly externalToken?: string;
  readonly verifiedEmptyToken?: string;
  readonly managedSendSessionId?: string;
}

export type TerminalSendAuthority =
  | { mode: "current" }
  | { mode: "verified_empty"; token?: string }
  | { mode: "external_handoff"; token?: string }
  | { mode: "deferred"; token?: string }
  | { mode: "managed"; sessionId: string }
  | { mode: "raw" }
  | { mode: "conflict" };

export interface TerminalUserExplicitSendFacts {
  readonly exactTerminalRow: boolean;
  readonly terminalId?: string;
  readonly processState?: string;
  readonly terminalControl?: TerminalControlRef;
  readonly agent?: ExecutorKind;
  readonly pid?: number;
  readonly processUuid?: string;
  readonly processBirth?: string;
  readonly approvalScanned: boolean;
  readonly approvalBlocked: boolean;
  readonly exactEmptyComposer: boolean;
}

export type TerminalUserExplicitSendAuthority =
  | { eligible: false }
  | {
      eligible: true;
      terminalId: string;
      expectedTerminalToken: string;
    };

/**
 * User-explicit terminal Send is physical terminal authority, not AKK Store
 * authority. Turn, Session, transfer, transition, ledger, ownership, and Store
 * writability facts are deliberately absent from this boundary.
 */
export function decideTerminalUserExplicitSendAuthority(
  facts: TerminalUserExplicitSendFacts
): TerminalUserExplicitSendAuthority {
  const terminalId = nonBlank(facts.terminalId);
  const control = facts.terminalControl;
  const workspace = control?.currentPath ?? "";
  const processUuid = nonBlank(facts.processUuid);
  const processBirth = nonBlank(facts.processBirth);
  if (
    !facts.exactTerminalRow ||
    !terminalId ||
    facts.processState !== "active" ||
    !control ||
    !hasCanonicalTerminalEndpoint(control) ||
    !control.capabilities.includes("send_keys") ||
    !control.capabilities.includes("screen_status") ||
    !facts.approvalScanned ||
    facts.approvalBlocked ||
    !facts.exactEmptyComposer ||
    !facts.agent ||
    !Number.isSafeInteger(facts.pid) ||
    Number(facts.pid) <= 1 ||
    !processUuid ||
    !processBirth
  ) {
    return { eligible: false };
  }
  const endpoint = terminalEndpointFromControlRef(control);
  if (
    !Number.isSafeInteger(endpoint.processAnchorPid) ||
    Number(endpoint.processAnchorPid) <= 1
  ) {
    return { eligible: false };
  }
  return {
    eligible: true,
    terminalId,
    expectedTerminalToken: unmanagedTerminalBindingToken({
      terminalId,
      terminalControl: control,
      agent: facts.agent,
      pid: Number(facts.pid),
      workspace,
      processUuid,
      processBirth
    })
  };
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

/** Canonical send authority used by list projection and fresh mutation prep. */
export function decideTerminalSendAuthority(
  facts: TerminalSendAuthorityFacts
): TerminalSendAuthority {
  if (facts.ownership === "current") return { mode: "current" };
  const verifiedEmpty = facts.verifiedEmpty ??
    facts.verifiedEmptyToken !== undefined;
  const externalHandoff = facts.externalHandoff ??
    facts.externalToken !== undefined;
  const deferred = facts.deferred ?? facts.deferredToken !== undefined;
  const conflictMode = verifiedEmpty
    ? { mode: "verified_empty" as const, token: facts.verifiedEmptyToken }
    : externalHandoff
      ? { mode: "external_handoff" as const, token: facts.externalToken }
      : deferred
        ? { mode: "deferred" as const, token: facts.deferredToken }
        : undefined;
  if (facts.ownership === "conflict") {
    return conflictMode ?? { mode: "conflict" };
  }
  if (deferred) return { mode: "deferred", token: facts.deferredToken };
  return facts.managedSendSessionId
    ? { mode: "managed", sessionId: facts.managedSendSessionId }
    : { mode: "raw" };
}

export interface ConflictingManagedSessionClaim {
  session: ManagedSessionState;
  kind: Exclude<ManagedBindingConflictKind, "stale_process_incarnation">;
}

export type TerminalSessionAuthorityConflict =
  | {
      reason: string;
      session_ids: string[];
      binding_statuses: string[];
      transition_ids: Array<string | null>;
      recovery: string;
    }
  | {
      kind: Exclude<ManagedBindingConflictKind, "stale_process_incarnation">;
      reason: string;
      session_ids: string[];
      binding_ids: Array<string | null>;
      session_revisions: Array<number | null>;
      recovery: string;
    }
  | {
      kind: "ambiguous_bound_claims";
      reason: string;
      session_ids: string[];
      recovery: string;
    }
  | {
      reason: string;
      session_ids: string[];
      recovery: string;
    };

export function decideTerminalSessionAuthorityConflict({
  unresolvedSessionClaims,
  conflictingBoundSessionClaims,
  matchingSessions
}: {
  unresolvedSessionClaims: readonly ManagedSessionState[];
  conflictingBoundSessionClaims: readonly ConflictingManagedSessionClaim[];
  matchingSessions: readonly ManagedSessionState[];
}): TerminalSessionAuthorityConflict | undefined {
  if (unresolvedSessionClaims.length > 0) {
    return {
      reason:
        "a first-class managed Session has an unresolved lifecycle binding on this terminal",
      session_ids: unresolvedSessionClaims.map((session) => session.session_id),
      binding_statuses: unresolvedSessionClaims.map((session) => session.status),
      transition_ids: unresolvedSessionClaims.map((session) =>
        session.last_transition_id ?? null
      ),
      recovery: "use only the lifecycle recovery action listed for this terminal"
    };
  }
  if (conflictingBoundSessionClaims.length === 1) {
    return singleBindingConflict(conflictingBoundSessionClaims[0]);
  }
  if (conflictingBoundSessionClaims.length > 1) {
    return {
      kind: "ambiguous_bound_claims",
      reason: "multiple non-exact bound managed Sessions claim the same live terminal",
      session_ids: conflictingBoundSessionClaims.map(
        ({ session }) => session.session_id
      ),
      recovery: "inspect Session state; AKK will not reconcile ambiguous claims"
    };
  }
  if (matchingSessions.length > 1) {
    return {
      reason: "multiple first-class managed Sessions claim the same live terminal binding",
      session_ids: matchingSessions.map((session) => session.session_id),
      recovery: "inspect Session state before performing a side effect"
    };
  }
  return undefined;
}

function singleBindingConflict(
  claim: ConflictingManagedSessionClaim
): TerminalSessionAuthorityConflict {
  const { session, kind } = claim;
  return {
    kind,
    reason: kind === "provisional_orphan"
      ? "a failed raw attach left a bound Session without an authoritative native-thread identity"
      : kind === "live_external_thread_change"
        ? "the live coding-agent thread changed outside AKK while its previous Session binding remained bound"
        : "the live terminal no longer matches a bound managed Session and the process relationship is unverifiable",
    session_ids: [session.session_id],
    binding_ids: [session.binding?.binding_id ?? null],
    session_revisions: [session.revision ?? null],
    recovery: kind === "unverifiable"
      ? "inspect the terminal and Session identity; AKK cannot safely reconcile an unverifiable binding"
      : "use only the exact reconcile_binding action listed for this terminal"
  };
}

export type TerminalDispatchOwnership<Turn, Conflict extends object> =
  | { state: "none" }
  | { state: "current"; conversation: Turn }
  | { state: "conflict"; conflict: Conflict };

export type TerminalWatchExternalTaskAuthority<Turn, Conflict extends object> =
  | { state: "external_task" }
  | { state: "managed_turn"; conversation: Turn }
  | { state: "dispatch_conflict"; conflict: Conflict };

/**
 * Terminal Watch is only for work started outside AKK. A durable blocking
 * Turn wins even when its dispatch ledger is temporarily absent, while a
 * current or conflicted dispatch owner must also fail closed.
 */
export function decideTerminalWatchExternalTaskAuthority<
  Turn,
  Conflict extends object
>({
  blockingTurn,
  dispatchOwnership
}: {
  blockingTurn?: Turn;
  dispatchOwnership: TerminalDispatchOwnership<Turn, Conflict>;
}): TerminalWatchExternalTaskAuthority<Turn, Conflict> {
  if (blockingTurn) {
    return { state: "managed_turn", conversation: blockingTurn };
  }
  if (dispatchOwnership.state === "current") {
    return {
      state: "managed_turn",
      conversation: dispatchOwnership.conversation
    };
  }
  if (dispatchOwnership.state === "conflict") {
    return {
      state: "dispatch_conflict",
      conflict: dispatchOwnership.conflict
    };
  }
  return { state: "external_task" };
}

interface TerminalSessionDispatchMismatchConflict {
  reason: string;
  owner_session_id?: string;
  bound_session_id: string;
  recovery: string;
}

export function applySessionAuthorityToDispatch<
  Turn,
  Conflict extends object
>({
  localOwnership,
  sessionAuthorityConflict,
  authoritativeSession,
  dispatchOwnerMismatch
}: {
  localOwnership: TerminalDispatchOwnership<Turn, Conflict>;
  sessionAuthorityConflict?: TerminalSessionAuthorityConflict;
  authoritativeSession?: ManagedSessionState;
  dispatchOwnerMismatch?: { ownerSessionId?: string };
}): TerminalDispatchOwnership<
  Turn,
  Conflict | TerminalSessionAuthorityConflict |
    TerminalSessionDispatchMismatchConflict
> {
  if (sessionAuthorityConflict) {
    return { state: "conflict", conflict: sessionAuthorityConflict };
  }
  if (
    localOwnership.state === "current" && authoritativeSession &&
    dispatchOwnerMismatch
  ) {
    return {
      state: "conflict",
      conflict: {
        reason: "the current dispatch Turn and first-class Session binding disagree",
        owner_session_id: dispatchOwnerMismatch.ownerSessionId,
        bound_session_id: authoritativeSession.session_id,
        recovery: "inspect Session and Turn state before performing a side effect"
      }
    };
  }
  return localOwnership;
}

export function compareManagedConversationRecency(
  left: Conversation,
  right: Conversation
): number {
  const leftTime = Date.parse(String(left.updated_at ?? left.created_at ?? ""));
  const rightTime = Date.parse(
    String(right.updated_at ?? right.created_at ?? "")
  );
  if (
    Number.isFinite(leftTime) && Number.isFinite(rightTime) &&
    leftTime !== rightTime
  ) return rightTime - leftTime;
  if (Number.isFinite(leftTime) !== Number.isFinite(rightTime)) {
    return Number.isFinite(leftTime) ? -1 : 1;
  }
  return left.conversation_id.localeCompare(right.conversation_id);
}

export interface ManagedTerminalAssociation {
  managedSessionId?: string;
  historySessionId?: string;
  sessionIds: Set<string>;
  sessionAllRelated: Conversation[];
  sessionDisplayedRelated: Conversation[];
}

export function decideManagedTerminalAssociation({
  allRelated,
  displayedRelated,
  authoritativeSession,
  sessionAuthorityRequired,
  currentOwner
}: {
  allRelated: Conversation[];
  displayedRelated: readonly Conversation[];
  authoritativeSession?: ManagedSessionState;
  sessionAuthorityRequired: boolean;
  currentOwner?: Conversation;
}): ManagedTerminalAssociation {
  if (
    currentOwner && !allRelated.some((conversation) =>
      conversation.conversation_id === currentOwner.conversation_id
    )
  ) allRelated.push(currentOwner);
  const sessionIds = new Set(
    allRelated.map((conversation) => sessionIdForConversation(conversation))
  );
  const legacySessionId = [...displayedRelated]
        .sort(compareManagedConversationRecency)
        .map((conversation) => sessionIdForConversation(conversation))[0] ??
      [...allRelated]
        .sort(compareManagedConversationRecency)
        .map((conversation) => sessionIdForConversation(conversation))[0];
  const managedSessionId = authoritativeSession?.session_id ??
    (!sessionAuthorityRequired
      ? currentOwner
        ? sessionIdForConversation(currentOwner)
        : legacySessionId
      : undefined);
  const historySessionId = managedSessionId ?? legacySessionId;
  return {
    managedSessionId,
    historySessionId,
    sessionIds,
    sessionAllRelated: historySessionId
      ? allRelated.filter((conversation) =>
          sessionIdForConversation(conversation) === historySessionId
        )
      : [],
    sessionDisplayedRelated: historySessionId
      ? displayedRelated.filter((conversation) =>
          sessionIdForConversation(conversation) === historySessionId
        )
      : []
  };
}

export function selectManagedTerminalHistory({
  displayedRelated,
  currentConversationId,
  hasCurrentTurn,
  includeAll
}: {
  displayedRelated: readonly Conversation[];
  currentConversationId?: string;
  hasCurrentTurn: boolean;
  includeAll: boolean;
}): {
  recentConversation?: Conversation;
  historyConversations: Conversation[];
} {
  const sorted = [...displayedRelated]
    .filter((conversation) =>
      conversation.conversation_id !== currentConversationId
    )
    .sort(compareManagedConversationRecency);
  const recentConversation = hasCurrentTurn ? undefined : sorted[0];
  return {
    recentConversation,
    historyConversations: includeAll
      ? sorted.filter((conversation) =>
          conversation.conversation_id !== recentConversation?.conversation_id
        )
      : []
  };
}

export function managedTurnNeedsAttention(facts: {
  status: string;
  callbackDeliveryStatus?: string;
}): boolean {
  return isSessionSendBlockingStatus(facts.status) ||
    ["pending", "failed"].includes(facts.callbackDeliveryStatus ?? "");
}

export interface TerminalDispatchConflictProjection {
  reason: string;
  dispatch_status?: string;
  owner_conversation_id?: string;
  message_id?: string;
  recovery: string;
}

export function projectTerminalDispatchConflict(facts: {
  reason: string;
  dispatchStatus?: string;
  ownerConversationId?: string;
  messageId?: string;
}): TerminalDispatchConflictProjection {
  return {
    reason: facts.reason,
    dispatch_status: facts.dispatchStatus,
    owner_conversation_id: facts.ownerConversationId,
    message_id: facts.messageId,
    recovery: "inspect the shared terminal pane and explicitly resolve the current dispatch before performing a side effect"
  };
}

export function decideLocalTerminalDispatchOwnership<Turn>(facts: {
  ledgerOwnerId: string;
  localOwner?: Turn;
  localOwnerMatchesLiveTerminal: boolean;
}):
  | { state: "current"; conversation: Turn }
  | {
      state: "conflict";
      conflict: {
        reason: string;
        owner_conversation_id: string;
        recovery: string;
      };
    } {
  if (facts.localOwner) {
    if (!facts.localOwnerMatchesLiveTerminal) {
      return {
        state: "conflict",
        conflict: {
          reason: "the terminal dispatch owner no longer matches the live coding-agent process identity or workspace",
          owner_conversation_id: facts.ledgerOwnerId,
          recovery: "inspect the shared terminal pane and explicitly resolve the stale dispatch before performing a side effect"
        }
      };
    }
    return { state: "current", conversation: facts.localOwner };
  }
  return {
    state: "conflict",
    conflict: {
      reason: "the terminal dispatch owner belongs to another AKK store or is not supported by this list view",
      owner_conversation_id: facts.ledgerOwnerId,
      recovery: "inspect the shared terminal pane and use the AKK store that owns the current dispatch"
    }
  };
}

export function selectTerminalAvailableActions<Action>({
  ownership,
  currentActions,
  sessionAwareRawActions,
  nonOwnerRawActions,
  authoritativeSendAction,
  terminalUserExplicitSendAction,
  reconcileBindingAction,
  terminalScopedApprovalAction,
  isAction = (value: unknown): value is Action => Boolean(value)
}: {
  ownership: "none" | "current" | "conflict";
  currentActions: TerminalActionSet<Action>;
  sessionAwareRawActions: TerminalActionSet<Action>;
  nonOwnerRawActions: TerminalActionSet<Action>;
  authoritativeSendAction?: Action;
  terminalUserExplicitSendAction?: Action;
  reconcileBindingAction?: Action;
  terminalScopedApprovalAction?: Action;
  isAction?: (value: unknown) => value is Action;
}): TerminalActionSet<Action> {
  const base = ownership === "current"
    ? currentActions
    : ownership === "conflict"
      ? {
          ...safeConflictActions(sessionAwareRawActions, isAction),
          ...(authoritativeSendAction ? { send: authoritativeSendAction } : {}),
          ...(reconcileBindingAction
            ? { reconcile_binding: reconcileBindingAction }
            : {})
        }
      : {
          ...nonOwnerRawActions,
          ...(authoritativeSendAction ? { send: authoritativeSendAction } : {})
        };
  const userSendFirst = terminalUserExplicitSendAction
    ? { ...base, send: terminalUserExplicitSendAction }
    : base;
  return terminalScopedApprovalAction
    ? { ...userSendFirst, approve: terminalScopedApprovalAction }
    : userSendFirst;
}

function safeConflictActions<Action>(
  actions: TerminalActionSet<Action>,
  isAction: (value: unknown) => value is Action
): TerminalActionSet<Action> {
  return {
    ...(isAction(actions.status) ? { status: actions.status } : {}),
    ...(isAction(actions.close) ? { close: actions.close } : {})
  };
}

export function nonOwnerTerminalActions<Action>(
  actions: TerminalActionSet<Action>,
  facts: { hasAuthoritativeSession: boolean; rolloutBackedCodexSession: boolean }
): TerminalActionSet<Action> {
  if (!facts.hasAuthoritativeSession) return actions;
  const next: TerminalActionSet<Action> = {};
  for (const name of Object.keys(actions) as TerminalActionName[]) {
    if (
      name !== "approve" &&
      !(facts.rolloutBackedCodexSession && name === "send")
    ) next[name] = actions[name];
  }
  return next;
}

export function projectTerminalManagement<Turn>({
  managedSessionId,
  managedSessionShortRef,
  currentTurn,
  recentTurn,
  sessionAllRelatedCount,
  hiddenTurnCount,
  sessionCount,
  authoritativeSession,
  history
}: {
  managedSessionId?: string;
  managedSessionShortRef: string | null;
  currentTurn?: Turn;
  recentTurn?: Turn;
  sessionAllRelatedCount: number;
  hiddenTurnCount: number;
  sessionCount: number;
  authoritativeSession?: ManagedSessionState;
  history?: Turn[];
}) {
  return {
    session_id: managedSessionId ?? null,
    session_short_ref: managedSessionShortRef,
    current_turn: currentTurn ?? null,
    recent_turn: recentTurn ?? null,
    turn_count: sessionAllRelatedCount,
    hidden_turn_count: hiddenTurnCount,
    session_count: sessionCount,
    ...(authoritativeSession ? managedBindingProjection(authoritativeSession) : {}),
    ...(history ? { history } : {})
  };
}

function managedBindingProjection(session: ManagedSessionState) {
  return {
    binding_status: session.status,
    binding_id: session.binding?.binding_id ?? null,
    binding_generation: session.binding?.generation ?? null,
    native_thread_id: session.binding?.native_thread_id ?? null,
    binding_token: managedSessionBindingToken(session)
  };
}

export function authoritativeTerminalIdentity(
  session: ManagedSessionState | undefined
) {
  const binding = session?.binding;
  return binding?.native_thread_id && session
    ? {
        native_agent_session_id: binding.native_thread_id,
        native_agent_process_uuid: binding.native_process.process_uuid,
        native_agent_process_birth: binding.native_process.process_birth,
        native_agent_rollout: binding.native_process.rollout,
        native_agent_identity_evidence: binding.native_process.evidence,
        lifecycle_binding_token: managedSessionBindingToken(session)
      }
    : {};
}

export function projectPublicManagementConflict<Conflict extends object>({
  conflict,
  verifiedEmptyToken,
  deferredToken,
  explicitlyAbandonedPredecessor
}: {
  conflict?: Conflict;
  verifiedEmptyToken?: string;
  deferredToken?: string;
  explicitlyAbandonedPredecessor: boolean;
}): Conflict | (Conflict & { kind: string; reason: string; recovery: string }) |
    undefined {
  if (!conflict) return undefined;
  if (verifiedEmptyToken) {
    return {
      ...conflict,
      kind: "verified_empty_native_session",
      reason: "the previously bound Codex rollout is conclusively closed while the same terminal process is at an exact empty prompt",
      recovery: "use only the exact snapshot-bound send action listed for this terminal"
    };
  }
  if (deferredToken && explicitlyAbandonedPredecessor) {
    return {
      ...conflict,
      kind: "explicitly_abandoned_predecessor_adoptable",
      reason: "the explicitly abandoned Codex predecessor rollout is no longer open and the current exact rollout inventory is unclaimed",
      recovery: "use only the exact snapshot-bound follow-current send action listed for this terminal"
    };
  }
  return conflict;
}

export function projectHandoffPresentation(facts: {
  externalHandoffDetected: boolean;
  externalHandoffAdoptable: boolean;
  recoveryBlockingTurnCount: number;
  hasHandoffDecision: boolean;
  sourceBlockingTurnCount: number;
  automatedInputComposerReady: boolean;
  verifiedEmptyToken?: string;
}) {
  const external = facts.externalHandoffDetected
    ? {
        handoff_state: facts.externalHandoffAdoptable
          ? "external_handoff_adoptable"
          : "external_handoff_blocked",
        ...(handoffBlockedReason(facts)
          ? { handoff_blocked_reason: handoffBlockedReason(facts) }
          : {})
      }
    : {};
  return facts.verifiedEmptyToken
    ? { ...external, handoff_state: "verified_empty_native_session_adoptable" }
    : external;
}

function handoffBlockedReason(facts: {
  recoveryBlockingTurnCount: number;
  hasHandoffDecision: boolean;
  sourceBlockingTurnCount: number;
  automatedInputComposerReady: boolean;
}): string | undefined {
  if (facts.recoveryBlockingTurnCount > 0) {
    return "the terminal has unresolved managed Turn state; input-producing actions remain blocked, but an exact listed Close can always release AKK management";
  }
  if (facts.hasHandoffDecision) {
    return "the source Session has one active Turn; input-producing handoff remains snapshot-bound, but an exact listed Close can always release AKK management";
  }
  if (facts.sourceBlockingTurnCount > 0) {
    return "the conflicting source Session has unresolved Turn state; automatic input remains unsafe, but an exact listed Close can always release AKK management";
  }
  return facts.automatedInputComposerReady
    ? undefined
    : "the current terminal composer is not an exact empty idle frame";
}

export function projectReconcileBindingAction(facts: {
  terminalId?: string;
  conflictingSession: ManagedSessionState;
  conflictingSessionRevision: number;
  expectedTerminalToken: string;
}) {
  return {
    tool: "agent_knock_knock_reconcile_binding",
    arguments: {
      terminal_id: facts.terminalId,
      conflicting_session_id: facts.conflictingSession.session_id,
      expected_session_revision: facts.conflictingSessionRevision,
      expected_binding_token: managedSessionBindingToken(
        facts.conflictingSession
      ),
      expected_terminal_token: facts.expectedTerminalToken
    },
    requires_user_intent: true
  };
}

export function projectHandoffDecision(facts: {
  sourceSessionId?: string;
  sourceTurnId: string;
  liveNativeThreadId: string;
  handoffDecisionToken: string;
  actionTurnId?: string;
}) {
  return {
    kind: "active_turn_requires_decision",
    source_session_id: facts.sourceSessionId,
    source_turn_id: facts.sourceTurnId,
    live_native_thread_id: facts.liveNativeThreadId,
    choices: {
      take_over_current: {
        action: {
          tool: "agent_knock_knock_close",
          arguments: {
            turn_id: facts.actionTurnId ?? facts.sourceTurnId,
            reason: "superseded_by_human_context_switch"
          },
          requires_explicit_user_confirmation: true
        },
        after: "refresh list and use its follow-current send"
      },
      keep_source: {
        effect: "no Store or terminal mutation",
        after: "restore source native thread in the Codex/Claude TUI, then refresh list"
      }
    }
  };
}

export function projectBlockingTurn(facts: {
  sessionId: string;
  turnId: string;
  status: string;
  recoveryTurnId?: string;
}) {
  return {
    session_id: facts.sessionId,
    turn_id: facts.turnId,
    status: facts.status,
    recovery_action: {
      tool: "agent_knock_knock_close",
      arguments: { turn_id: facts.recoveryTurnId ?? facts.turnId },
      requires_explicit_user_confirmation: true
    }
  };
}

import fs from "node:fs";

import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import {
  listDeferredForegroundTransfers,
  type DeferredForegroundTransferSourceRolloutAuthority,
  type DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import type { ExecutorKind } from "./executors.js";
import {
  humanObservedHandoffBindingToken,
  isExactNativeThreadId,
  managedSessionBindingToken,
  managedSessionRevision,
  unmanagedTerminalBindingToken,
  type HumanObservedHandoffTargetSnapshot,
  type ManagedSessionState,
  type NativeThreadTransition
} from "./managed-session.js";
import {
  executorForConversation,
  isSessionSendBlockingStatus,
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  nativeThreadTransitionsDir
} from "./session-store.js";
import { listConversations } from "./store.js";
import {
  applySessionAuthorityToDispatch,
  compareManagedConversationRecency,
  decideLocalTerminalDispatchOwnership,
  decideTerminalSessionAuthorityConflict,
  managedTurnNeedsAttention as terminalManagedTurnNeedsAttention,
  projectHandoffDecision,
  projectReconcileBindingAction,
  projectTerminalDispatchConflict,
  type ConflictingManagedSessionClaim
} from "./terminal-action-projection.js";
import {
  decideManagedBindingConflict,
  deferredCodexForegroundBindingToken,
  exactBoundCodexSendSource,
  isCompleteNativeRollout,
  nativeAgentIdentityMatchesTurn,
  processIncarnationRelationship,
  terminalControlAliasMatches,
  terminalControlsShareIncarnation,
  verifiedEmptyCodexHandoffToken,
  type CodexAllowedCompanionSet,
  type CodexSendAuthorityContext,
  type DeferredCodexForegroundDispatchSnapshot,
  type ManagedBindingConflictKind
} from "./terminal-authority-policy.js";
import {
  decideTerminalBindingMatch,
  terminalObservationFromListEntry,
  type TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import {
  decideTerminalScopedCodexApprovalAuthority,
  terminalScopedCodexApprovalPromptSnapshot,
  type TerminalScopedCodexApprovalBoundary
} from "./terminal-scoped-approval-authority.js";
import { sameCanonicalStatePath,
  type TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import * as dispatch from "./terminal-dispatch-policy.js";
import {
  actionsForManagedSessionBinding,
  readOnlyListActions,
  withoutInspectionActionsDuringNativeTransition
} from "./terminal-list-renderer.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidenceMatches,
  type TerminalControlRef
} from "./terminal-control-ref.js";
import { isRecord, nonBlankString as stringValue } from
  "./value-guards.js";

export interface DeferredCodexAuthorityObservation {
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
  sourceAbandonmentFingerprint?: string;
  exactSource: boolean;
}

export interface TerminalListOwnershipContext {
  storeDir: string;
  terminals: Record<string, any>[];
  managedSessions: ManagedSessionState[];
  allConversations: Conversation[];
  displayedConversations: Conversation[];
  mutationsAllowed: boolean;
  nonterminalDeferredTransfers: ReturnType<
    typeof listDeferredForegroundTransfers
  >;
  conversationHasNonterminalDeferredTransfer: (
    conversation: Conversation
  ) => boolean;
}

export interface TerminalListOwnershipServicePorts {
  activeTurnHandoffDecisionToken(request: {
    handoffToken: string;
    turn: Conversation;
    ledger?: TerminalDispatchLedgerDocument;
  }): string;
  assertManagedTerminalDispatchOwner(request: {
    storeDir: string;
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    action: "approve" | "cancel";
  }): void;
  codexLingeringBeforeIdentityMatchesSession(request: {
    storeDir: string;
    session: ManagedSessionState;
    identity: TerminalNativeIdentity;
  }): boolean;
  codexProcessIncarnationForPid(pid: number): {
    processUuid: string;
    processBirth: string;
  };
  currentWorkingDirectory(): string;
  isDiscoverableTmuxConversation(conversation: Conversation): boolean;
  loadTerminalBridgeDispatchLedger(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  loadTerminalDispatchLedgerOwner(
    ledger: TerminalDispatchLedgerDocument
  ): Conversation | undefined;
  managedTurnsForSession(
    storeDir: string,
    sessionId: string
  ): Conversation[];
  matchesConfiguredWorkspace(configured: unknown, observed: unknown): boolean;
  observeDeferredCodexAuthority(request: {
    mode: "list";
    storeDir: string;
    context: CodexSendAuthorityContext;
    sourceSession?: ManagedSessionState;
    candidateInventory?: CodexOpenRootRolloutInventory;
    abandonment: "never" | "missing_rollout";
    requireUnclaimedCandidate: true;
  }): DeferredCodexAuthorityObservation | undefined;
  observedHandoffTargetResolution(request: {
    storeDir: string;
    agent: ExecutorKind;
    workspace: string;
    nativeThreadId: string;
    sourceSessionId: string;
  }):
    | {
        status: "eligible";
        session?: ManagedSessionState;
        snapshot: HumanObservedHandoffTargetSnapshot;
      }
    | { status: "blocked"; reason: string };
  orphanedTerminalDispatchForRecovery(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  runtimeLog(
    level: "info" | "warn" | "error",
    event: string,
    details: Record<string, unknown>
  ): void;
  terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  terminalDispatchRecordMatchesControl(
    ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options?: { requireProcessAnchor?: boolean }
  ): boolean;
}

interface TerminalScopedBoundaryRequest {
  storeDir: string;
  terminal: unknown;
  session: ManagedSessionState;
  ledger?: TerminalDispatchLedgerDocument;
  approval?: ReturnType<typeof terminalScopedCodexApprovalPromptSnapshot>;
  owner?: Conversation;
}

type TerminalDispatchOwnershipResult =
  | { state: "none" }
  | { state: "current"; conversation: Conversation }
  | { state: "conflict"; conflict: Record<string, any> };

export interface TerminalListOwnershipService {
  assertTerminalIncarnationCanStartTurn(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): void;
  managedSessionHasAnyNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  managedSessionHasUnresolvedNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  managedSessionMatchesLiveTerminalEntry(
    session: ManagedSessionState,
    terminal: Record<string, any>,
    storeDir: string
  ): boolean;
  managedTurnMatchesLiveTerminal(
    conversation: Conversation,
    terminal: Record<string, any>
  ): boolean;
  managedTurnNeedsAttention(conversation: Conversation): boolean;
  observeActionAuthority(
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    binding: Record<string, any>
  ): Record<string, any>;
  observeBindingAuthority(
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext
  ): Record<string, any>;
  provisionalManagedBindingTurnCount(
    storeDir: string,
    session: ManagedSessionState
  ): number | undefined;
  terminalControlForManagedConversation(
    conversation: Conversation
  ): TerminalControlRef | undefined;
  terminalDispatchOwnership(
    terminalControl: TerminalControlRef
  ): TerminalDispatchOwnershipResult;
  terminalIncarnationBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef,
    conversations?: Conversation[]
  ): Conversation[];
  terminalScopedCodexApprovalBoundary(
    request: TerminalScopedBoundaryRequest
  ): TerminalScopedCodexApprovalBoundary;
}

function observeBindingAuthority(
    ports: TerminalListOwnershipServicePorts,
    listedTerminal: Record<string, any>,
    context: TerminalListOwnershipContext
  ) {
    const {
      storeDir,
      managedSessions,
      allConversations,
      displayedConversations,
      mutationsAllowed,
      nonterminalDeferredTransfers
    } = context;
    const {
      _automated_input_composer_ready: automatedInputComposerReady,
      _user_explicit_composer_ready: _userExplicitComposerReady,
      _codex_open_root_rollout_inventory: codexOpenRootRolloutInventoryValue,
      _codex_latent_clear_resume: codexLatentClearResumeValue,
      _terminal_user_explicit_send_action: terminalUserExplicitSendAction,
      _terminal_status_snapshot: _terminalStatusSnapshot,
      _native_identity_authority: nativeIdentityAuthorityValue,
      ...publicTerminal
    } = listedTerminal;
    const terminal = terminalIdentityAuthorityView(
      listedTerminal,
      nativeIdentityAuthorityValue
    );
    const codexOpenRootRolloutInventory = isRecord(
      codexOpenRootRolloutInventoryValue
    )
      ? codexOpenRootRolloutInventoryValue as unknown as
          CodexOpenRootRolloutInventory
      : undefined;
    const terminalControl = isRecord(terminal.terminal_control)
      ? terminal.terminal_control as unknown as TerminalControlRef
      : undefined;
    const terminalHasNonterminalDeferredTransfer = Boolean(
      terminalControl && nonterminalDeferredTransfers.some((transfer) =>
        transfer.terminal_id === String(terminal.id) &&
        transfer.process_pid === Number(terminal.pid) &&
        terminalControlEvidenceMatches(
          transfer.terminal_endpoint,
          terminalControl
        )
      )
    );
    const allRelated = terminalControl
      ? allConversations.filter((conversation) =>
          terminalControlsShareIncarnation(
            terminalControlForManagedConversation(ports, conversation),
            terminalControl
          )
        )
      : [];
    const displayedRelated = terminalControl
      ? displayedConversations.filter((conversation) =>
          terminalControlsShareIncarnation(
            terminalControlForManagedConversation(ports, conversation),
            terminalControl
          )
        )
      : [];
    const relatedSessions = terminalControl
      ? managedSessions.filter((session) =>
          terminalControlsShareIncarnation(
            session.binding?.terminal_control,
            terminalControl
          )
        )
      : [];
    const matchingSessions = relatedSessions.filter((session) =>
      managedSessionMatchesLiveTerminalEntry(
        ports,
        session,
        terminal,
        storeDir
      )
    );
    const conflictingBoundSessionClaims = relatedSessions.flatMap(
      (session): ConflictingManagedSessionClaim[] => {
        const kind = managedBindingConflictKindForLiveTerminalEntry(ports, {
          storeDir,
          session,
          terminal
        });
        return kind && kind !== "stale_process_incarnation"
          ? [{ session, kind }]
          : [];
      }
    );
    const unresolvedSessionClaims = relatedSessions.filter((session) =>
      ["transitioning", "quarantined"].includes(session.status) &&
      managedSessionClaimsLiveTerminalEntry(session, terminal)
    );
    const sessionAuthorityConflict = decideTerminalSessionAuthorityConflict({
      unresolvedSessionClaims,
      conflictingBoundSessionClaims,
      matchingSessions
    });
    const authoritativeSession = matchingSessions[0];
    const discoveredOwnership = terminalControl
      ? terminalDispatchOwnership(ports, terminalControl)
      : { state: "none" as const };
    const localOwnership = discoveredOwnership.state === "current"
      ? localTerminalDispatchOwnership(
          ports,
          discoveredOwnership.conversation,
          allRelated,
          terminal
        )
      : discoveredOwnership;
    const dispatchOwnerMismatch =
      !sessionAuthorityConflict &&
        localOwnership.state === "current" &&
        authoritativeSession &&
        sessionIdForConversation(localOwnership.conversation) !==
          authoritativeSession.session_id
        ? {
            ownerSessionId: sessionIdForConversation(
              discoveredOwnership.state === "current"
                ? discoveredOwnership.conversation
                : localOwnership.conversation
            )
          }
        : undefined;
    const ownership = applySessionAuthorityToDispatch({
      localOwnership,
      sessionAuthorityConflict,
      authoritativeSession,
      dispatchOwnerMismatch
    });
    const discoveredRawActions = isRecord(terminal.available_actions)
      ? terminal.available_actions
      : {};
    const rawActions = mutationsAllowed
      ? discoveredRawActions
      : readOnlyListActions(discoveredRawActions);
    const rawSendAction = isRecord(rawActions.send)
      ? rawActions.send
      : {};
    const bindingAwareRawActions = authoritativeSession
      ? actionsForManagedSessionBinding(rawActions, authoritativeSession)
      : rawActions;
    const sessionAwareRawActionsBase =
      authoritativeSession &&
        managedSessionHasUnresolvedNativeTransition(
          storeDir,
          authoritativeSession
        )
        ? withoutInspectionActionsDuringNativeTransition(bindingAwareRawActions)
        : bindingAwareRawActions;
    const sessionAwareRawActions = terminalHasNonterminalDeferredTransfer
      ? readOnlyListActions(sessionAwareRawActionsBase)
      : sessionAwareRawActionsBase;
    const soleBindingConflict = conflictingBoundSessionClaims.length === 1
      ? conflictingBoundSessionClaims[0]
      : undefined;
    const externalHandoffDetected = conflictingBoundSessionClaims.some(
      ({ kind }) => kind === "live_external_thread_change"
    );
    const conflictingSessionRevision = Number(
      soleBindingConflict?.session.revision
    );
    const conflictingSessionTurns = soleBindingConflict
      ? ports.managedTurnsForSession(
          storeDir,
          soleBindingConflict.session.session_id
        )
      : [];
    const expectedTerminalToken = stringValue(
      terminal.lifecycle_binding_token
    );
    const externalHandoffNativeThreadId = stringValue(
      terminal.native_agent_status_card_session_id
    ) ?? stringValue(terminal.native_agent_session_id);
    const resolvedNativeThreadId = stringValue(
      terminal.native_agent_session_id
    );
    const externalHandoffTerminalToken =
      terminalControl &&
      externalHandoffNativeThreadId &&
      isExactNativeThreadId(externalHandoffNativeThreadId)
        ? unmanagedTerminalBindingToken({
            terminalId: stringValue(terminal.id) as string,
            terminalControl,
            agent: terminal.agent,
            pid: Number(terminal.pid),
            workspace:
              terminal.workspace ?? terminal.cwd ??
              ports.currentWorkingDirectory(),
            nativeThreadId: externalHandoffNativeThreadId,
            processUuid: stringValue(terminal.native_agent_process_uuid),
            processBirth: stringValue(terminal.native_agent_process_birth),
            rollout:
              resolvedNativeThreadId === externalHandoffNativeThreadId &&
              isRecord(terminal.native_agent_rollout)
                ? terminal.native_agent_rollout as any
                : undefined
          })
        : undefined;
    const externalHandoffTarget =
      soleBindingConflict?.kind === "live_external_thread_change" &&
      externalHandoffNativeThreadId &&
      isExactNativeThreadId(externalHandoffNativeThreadId)
        ? ports.observedHandoffTargetResolution({
            storeDir,
            agent: terminal.agent,
            workspace:
              terminal.workspace ?? terminal.cwd ??
              ports.currentWorkingDirectory(),
            nativeThreadId: externalHandoffNativeThreadId.toLowerCase(),
            sourceSessionId: soleBindingConflict.session.session_id
          })
        : undefined;
    const externalHandoffSnapshotToken =
      externalHandoffTerminalToken &&
      soleBindingConflict?.kind === "live_external_thread_change" &&
      externalHandoffTarget?.status === "eligible"
        ? humanObservedHandoffBindingToken({
            terminal_token: externalHandoffTerminalToken,
            source_session_id: soleBindingConflict.session.session_id,
            source_revision: managedSessionRevision(
              soleBindingConflict.session
            ),
            source_binding_token: managedSessionBindingToken(
              soleBindingConflict.session
            ),
            target: externalHandoffTarget.snapshot
          })
        : undefined;
    const blockingHandoffTurns = conflictingSessionTurns.filter((turn) =>
      isSessionSendBlockingStatus(turn.status)
    );
    const terminalBlockingTurns = terminalControl
      ? terminalIncarnationBlockingTurns(
          ports,
          storeDir,
          terminalControl,
          allRelated
        )
      : [];
    const externalHandoffSourceSessionIds = new Set(
      conflictingBoundSessionClaims
        .filter(({ kind }) => kind === "live_external_thread_change")
        .map(({ session }) => session.session_id)
    );
    const handoffSourceBlockingTurns = terminalBlockingTurns.filter((turn) =>
      externalHandoffSourceSessionIds.has(sessionIdForConversation(turn))
    );
    const nativeIdentityObservation = isRecord(
      terminal.native_agent_identity_observation
    )
      ? terminal.native_agent_identity_observation
      : undefined;
    const codexProcessUuid = stringValue(
      terminal.native_agent_process_uuid
    );
    const codexProcessBirth = stringValue(
      terminal.native_agent_process_birth
    );
    const codexWorkspace = stringValue(terminal.workspace ?? terminal.cwd);
    const codexSendAuthorityContext = terminalControl
      ? {
          terminalId: String(terminal.id),
          terminalControl,
          pid: Number(terminal.pid),
          workspace: codexWorkspace,
          liveProcessUuid: codexProcessUuid,
          liveProcessBirth: codexProcessBirth
        }
      : undefined;
    return {
      authorityTerminal: terminal,
      automatedInputComposerReady,
      codexOpenRootRolloutInventory,
      codexLatentClearResumeValue,
      terminalUserExplicitSendAction,
      publicTerminal,
      terminalControl,
      terminalHasNonterminalDeferredTransfer,
      allRelated,
      displayedRelated,
      relatedSessions,
      matchingSessions,
      conflictingBoundSessionClaims,
      unresolvedSessionClaims,
      sessionAuthorityConflict,
      authoritativeSession,
      discoveredOwnership,
      ownership,
      rawActions,
      rawSendAction,
      sessionAwareRawActions,
      soleBindingConflict,
      externalHandoffDetected,
      conflictingSessionRevision,
      conflictingSessionTurns,
      expectedTerminalToken,
      externalHandoffNativeThreadId,
      externalHandoffTarget,
      externalHandoffSnapshotToken,
      blockingHandoffTurns,
      terminalBlockingTurns,
      handoffSourceBlockingTurns,
      nativeIdentityObservation,
      codexProcessUuid,
      codexProcessBirth,
      codexWorkspace,
      codexSendAuthorityContext
    };
  }

function terminalIdentityAuthorityView(
    terminal: Record<string, any>,
    authorityValue: unknown
  ): Record<string, any> {
    if (!isRecord(authorityValue)) {
      return terminal;
    }
    const observation = isRecord(authorityValue.observation)
      ? authorityValue.observation
      : { status: "not_observed" };
    const identity = isRecord(authorityValue.identity)
      ? authorityValue.identity
      : undefined;
    return {
      ...terminal,
      native_agent_session_id: stringValue(identity?.sessionId),
      native_agent_rollout: isRecord(identity?.rollout)
        ? identity.rollout
        : undefined,
      native_agent_identity_observation: observation,
      lifecycle_binding_token:
        stringValue(authorityValue.lifecycle_binding_token) ??
        terminal.lifecycle_binding_token
    };
  }

function observeVerifiedEmptyTerminalAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    binding: ReturnType<typeof observeBindingAuthority>
  ) {
    const { storeDir, terminals, mutationsAllowed } = context;
    const {
      automatedInputComposerReady,
      terminalControl,
      matchingSessions,
      unresolvedSessionClaims,
      discoveredOwnership,
      rawActions,
      soleBindingConflict,
      blockingHandoffTurns,
      terminalBlockingTurns,
      nativeIdentityObservation,
      codexProcessUuid,
      codexProcessBirth,
      codexWorkspace,
      codexSendAuthorityContext
    } = binding;
    const verifiedEmptySourceNativeThreadId = stringValue(
      soleBindingConflict?.session.binding?.native_thread_id
    )?.toLowerCase();
    const verifiedEmptySourceActiveElsewhere = Boolean(
      verifiedEmptySourceNativeThreadId &&
      terminals.some((candidate) =>
        stringValue(candidate.id) !== stringValue(terminal.id) &&
        candidate.agent === "codex" &&
        stringValue(candidate.native_agent_session_id)?.toLowerCase() ===
          verifiedEmptySourceNativeThreadId
      )
    );
    const verifiedEmptyRawSendAction = isRecord(rawActions.send)
      ? rawActions.send
      : {
          tool: "agent_knock_knock_send",
          arguments: { selector: stringValue(terminal.id) },
          missing_required: ["request"]
        };
    const verifiedEmptyCodexHandoffEligible = Boolean(
      mutationsAllowed &&
      terminal.agent === "codex" &&
      terminalControl &&
      discoveredOwnership.state === "none" &&
      unresolvedSessionClaims.length === 0 &&
      matchingSessions.length === 0 &&
      soleBindingConflict?.kind === "unverifiable" &&
      nativeIdentityObservation?.status === "verified_absent" &&
      codexSendAuthorityContext &&
      codexProcessUuid &&
      codexProcessBirth &&
      codexWorkspace &&
      exactBoundCodexSendSource({
        kind: "verified_empty",
        sourceSession: soleBindingConflict.session,
        context: codexSendAuthorityContext
      }) &&
      ["idle", "unknown"].includes(String(terminal.activity_state)) &&
      automatedInputComposerReady === true &&
      !(isRecord(terminal.approval_state) &&
        terminal.approval_state.blocked === true) &&
      blockingHandoffTurns.length === 0 &&
      terminalBlockingTurns.length === 0 &&
      !managedSessionHasUnresolvedNativeTransition(
        storeDir,
        soleBindingConflict.session
      ) &&
      !verifiedEmptySourceActiveElsewhere &&
      terminal.orphaned_terminal_dispatch === undefined &&
      terminalControl.capabilities.includes("send_keys") &&
      terminalControl.capabilities.includes("screen_status")
    );
    const verifiedEmptyCodexSnapshotToken =
      verifiedEmptyCodexHandoffEligible &&
      codexSendAuthorityContext &&
      soleBindingConflict &&
      codexProcessUuid &&
      codexProcessBirth &&
      codexWorkspace
        ? verifiedEmptyCodexHandoffToken({
            terminalId: String(terminal.id),
            terminalControl: codexSendAuthorityContext.terminalControl,
            pid: Number(terminal.pid),
            workspace: codexWorkspace,
            processUuid: codexProcessUuid,
            processBirth: codexProcessBirth,
            sourceSession: soleBindingConflict.session
          })
        : undefined;
    return {
      ...binding,
      verifiedEmptyRawSendAction,
      verifiedEmptyCodexSnapshotToken
    };
  }

function observeDeferredSourceAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    observation: ReturnType<typeof observeVerifiedEmptyTerminalAuthority>
  ) {
    const { terminals } = context;
    const {
      codexLatentClearResumeValue,
      codexOpenRootRolloutInventory,
      authoritativeSession,
      matchingSessions,
      conflictingBoundSessionClaims,
      unresolvedSessionClaims,
      soleBindingConflict,
      nativeIdentityObservation
    } = observation;
    const deferredCodexCandidateInventory =
      codexOpenRootRolloutInventory &&
        codexOpenRootRolloutInventory.roots.length > 0
        ? codexOpenRootRolloutInventory
        : undefined;
    const abandonedConflictSource =
      !authoritativeSession &&
      soleBindingConflict?.kind === "unverifiable" &&
      matchingSessions.length === 0 &&
      conflictingBoundSessionClaims.length === 1 &&
      unresolvedSessionClaims.length === 0 &&
      terminal.agent === "codex"
        ? soleBindingConflict.session
        : undefined;
    const deferredCodexSource = (authoritativeSession ??
        abandonedConflictSource) &&
        terminal.agent === "codex" &&
        (
          nativeIdentityObservation?.status === "verified_absent" ||
          deferredCodexCandidateInventory !== undefined
        )
      ? authoritativeSession ?? abandonedConflictSource
      : undefined;
    const deferredCodexSourceNativeThreadId = stringValue(
      deferredCodexSource?.binding?.native_thread_id
    )?.toLowerCase();
    const deferredCodexLatentClearResumeFingerprint =
      isRecord(codexLatentClearResumeValue) &&
      stringValue(
        codexLatentClearResumeValue.source_native_thread_id
      )?.toLowerCase() === deferredCodexSourceNativeThreadId
        ? stringValue(codexLatentClearResumeValue.fingerprint)
        : undefined;
    if (deferredCodexLatentClearResumeFingerprint) {
      ports.runtimeLog("info", "terminal_codex_latent_clear_hint_observed", {
        terminal_id: String(terminal.id),
        source_session_id: deferredCodexSource?.session_id,
        source_native_thread_id: deferredCodexSourceNativeThreadId
      });
    }
    const deferredCodexSourceActiveElsewhere = Boolean(
      deferredCodexSourceNativeThreadId &&
      terminals.some((candidate) =>
        stringValue(candidate.id) !== stringValue(terminal.id) &&
        candidate.agent === "codex" &&
        stringValue(candidate.native_agent_session_id)?.toLowerCase() ===
          deferredCodexSourceNativeThreadId
      )
    );
    return {
      ...observation,
      deferredCodexCandidateInventory,
      abandonedConflictSource,
      deferredCodexSource,
      deferredCodexSourceActiveElsewhere
    };
  }

function observeDeferredTerminalAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    observation: ReturnType<typeof observeDeferredSourceAuthority>
  ) {
    const { storeDir, mutationsAllowed } = context;
    const {
      automatedInputComposerReady,
      terminalControl,
      terminalHasNonterminalDeferredTransfer,
      matchingSessions,
      conflictingBoundSessionClaims,
      unresolvedSessionClaims,
      discoveredOwnership,
      terminalBlockingTurns,
      codexProcessUuid,
      codexProcessBirth,
      codexWorkspace,
      codexSendAuthorityContext,
      deferredCodexCandidateInventory,
      abandonedConflictSource,
      deferredCodexSource,
      deferredCodexSourceActiveElsewhere
    } = observation;
    const deferredCodexAuthority = codexSendAuthorityContext
      ? ports.observeDeferredCodexAuthority({
          mode: "list",
          storeDir,
          context: codexSendAuthorityContext,
          sourceSession: deferredCodexSource,
          candidateInventory: deferredCodexCandidateInventory,
          abandonment: abandonedConflictSource
            ? "missing_rollout"
            : "never",
          requireUnclaimedCandidate: true
        })
      : undefined;
    const deferredCodexSourceRolloutAuthority =
      deferredCodexAuthority?.sourceRolloutAuthority ?? "present";
    const deferredCodexDispatchSnapshot =
      deferredCodexAuthority?.dispatchSnapshot;
    const deferredCodexForegroundEligible = Boolean(
      mutationsAllowed &&
      !terminalHasNonterminalDeferredTransfer &&
      deferredCodexSource &&
      terminalControl &&
      hasCanonicalTerminalEndpoint(terminalControl) &&
      discoveredOwnership.state === "none" &&
      unresolvedSessionClaims.length === 0 &&
      (
        (matchingSessions.length === 1 &&
          conflictingBoundSessionClaims.length === 0) ||
        (deferredCodexSourceRolloutAuthority ===
            "explicitly_abandoned_predecessor" &&
          matchingSessions.length === 0 &&
          conflictingBoundSessionClaims.length === 1)
      ) &&
      codexProcessUuid &&
      codexProcessBirth &&
      codexWorkspace &&
      deferredCodexAuthority?.exactSource &&
      terminalBlockingTurns.length === 0 &&
      terminal.orphaned_terminal_dispatch === undefined &&
      deferredCodexDispatchSnapshot &&
      ["idle", "unknown"].includes(String(terminal.activity_state)) &&
      automatedInputComposerReady === true &&
      !(isRecord(terminal.approval_state) &&
        terminal.approval_state.blocked === true) &&
      !deferredCodexSourceActiveElsewhere &&
      terminalControl.capabilities.includes("send_keys") &&
      terminalControl.capabilities.includes("screen_status")
    );
    const deferredCodexForegroundToken =
      deferredCodexForegroundEligible &&
      deferredCodexSource &&
      terminalControl &&
      codexProcessUuid &&
      codexProcessBirth &&
      codexWorkspace &&
      deferredCodexDispatchSnapshot
        ? deferredCodexForegroundBindingToken({
            terminalId: String(terminal.id),
            terminalControl,
            pid: Number(terminal.pid),
            workspace: codexWorkspace,
            processUuid: codexProcessUuid,
            processBirth: codexProcessBirth,
            sourceSession: deferredCodexSource,
            dispatchSnapshot: deferredCodexDispatchSnapshot,
            sourceTurnHistory: deferredCodexAuthority?.sourceTurnHistory,
            sourceRolloutAuthority: deferredCodexSourceRolloutAuthority,
            sourceAbandonmentFingerprint:
              deferredCodexAuthority?.sourceAbandonmentFingerprint,
            ...(deferredCodexCandidateInventory
              ? { candidateInventory: deferredCodexCandidateInventory }
              : {})
          })
        : undefined;
    return {
      ...observation,
      deferredCodexSourceRolloutAuthority,
      deferredCodexForegroundToken
    };
  }

function observeTerminalHandoffAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    observation: ReturnType<typeof observeDeferredTerminalAuthority>
  ) {
    const { storeDir, mutationsAllowed } = context;
    const {
      automatedInputComposerReady,
      terminalControl,
      matchingSessions,
      unresolvedSessionClaims,
      discoveredOwnership,
      rawActions,
      soleBindingConflict,
      conflictingSessionRevision,
      conflictingSessionTurns,
      expectedTerminalToken,
      externalHandoffNativeThreadId,
      externalHandoffTarget,
      externalHandoffSnapshotToken,
      blockingHandoffTurns,
      terminalBlockingTurns,
      handoffSourceBlockingTurns
    } = observation;
    const reconcileBindingAction =
      mutationsAllowed &&
      discoveredOwnership.state === "none" &&
      unresolvedSessionClaims.length === 0 &&
      matchingSessions.length === 0 &&
      soleBindingConflict &&
      soleBindingConflict.kind !== "unverifiable" &&
      Number.isSafeInteger(conflictingSessionRevision) &&
      conflictingSessionRevision > 0 &&
      expectedTerminalToken &&
      terminal.activity_state === "idle" &&
      !(isRecord(terminal.approval_state) &&
        terminal.approval_state.blocked === true) &&
      !conflictingSessionTurns.some((turn) =>
        isSessionSendBlockingStatus(turn.status)
      ) &&
      terminalBlockingTurns.length === 0 &&
      !managedSessionHasUnresolvedNativeTransition(
        storeDir,
        soleBindingConflict.session
      )
        ? projectReconcileBindingAction({
            terminalId: stringValue(terminal.id),
            conflictingSession: soleBindingConflict.session,
            conflictingSessionRevision,
            expectedTerminalToken
          })
        : undefined;
    const externalHandoffAdoptable = Boolean(
      mutationsAllowed &&
      discoveredOwnership.state === "none" &&
      unresolvedSessionClaims.length === 0 &&
      soleBindingConflict?.kind === "live_external_thread_change" &&
      terminal.activity_state === "idle" &&
      automatedInputComposerReady === true &&
      !(isRecord(terminal.approval_state) &&
        terminal.approval_state.blocked === true) &&
      !conflictingSessionTurns.some((turn) =>
        isSessionSendBlockingStatus(turn.status)
      ) &&
      terminalBlockingTurns.length === 0 &&
      !managedSessionHasUnresolvedNativeTransition(
        storeDir,
        soleBindingConflict.session
      ) &&
      externalHandoffTarget?.status === "eligible" &&
      isRecord(rawActions.send) &&
      Boolean(externalHandoffSnapshotToken)
    );
    const handoffDecisionTurn =
      mutationsAllowed &&
      soleBindingConflict?.kind === "live_external_thread_change" &&
      externalHandoffTarget?.status === "eligible" &&
      terminal.activity_state === "idle" &&
      !(isRecord(terminal.approval_state) &&
        terminal.approval_state.blocked === true) &&
      !managedSessionHasUnresolvedNativeTransition(
        storeDir,
        soleBindingConflict.session
      ) &&
      blockingHandoffTurns.length === 1 &&
      terminalBlockingTurns.every((turn) =>
        turn.conversation_id === blockingHandoffTurns[0].conversation_id
      )
        ? blockingHandoffTurns[0]
        : undefined;
    const handoffDecisionToken =
      handoffDecisionTurn &&
      externalHandoffSnapshotToken &&
      terminalControl
        ? ports.activeTurnHandoffDecisionToken({
            handoffToken: externalHandoffSnapshotToken,
            turn: handoffDecisionTurn,
            ledger: ports.loadTerminalBridgeDispatchLedger(terminalControl)
          })
        : undefined;
    const handoffDecision =
      handoffDecisionTurn &&
      handoffDecisionToken &&
      externalHandoffNativeThreadId
        ? projectHandoffDecision({
            sourceSessionId: soleBindingConflict?.session.session_id,
            sourceTurnId: turnIdForConversation(handoffDecisionTurn),
            liveNativeThreadId: externalHandoffNativeThreadId,
            handoffDecisionToken,
            actionTurnId: turnIdForConversation(handoffDecisionTurn)
          })
        : undefined;
    const blockingHandoffTurnIds = new Set(
      handoffSourceBlockingTurns.map((turn) => turn.conversation_id)
    );
    const terminalRecoveryBlockingTurns = terminalBlockingTurns;
    return {
      ...observation,
      reconcileBindingAction,
      externalHandoffAdoptable,
      handoffDecision,
      blockingHandoffTurnIds,
      terminalRecoveryBlockingTurns
    };
  }

function observeTerminalScopedApprovalAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    observation: ReturnType<typeof observeTerminalHandoffAuthority>
  ) {
    const { storeDir, mutationsAllowed } = context;
    const {
      terminalControl,
      terminalHasNonterminalDeferredTransfer,
      conflictingBoundSessionClaims,
      unresolvedSessionClaims,
      sessionAuthorityConflict,
      authoritativeSession,
      discoveredOwnership,
      ownership,
      rawActions
    } = observation;
    let terminalScopedCodexApprovalAction: Record<string, any> | undefined;
    const terminalScopedCodexApprovalPrompt =
      terminalScopedCodexApprovalPromptSnapshot(terminal.approval_state);
    if (
      mutationsAllowed &&
      terminal.agent === "codex" &&
      terminalControl &&
      hasCanonicalTerminalEndpoint(terminalControl) &&
      authoritativeSession &&
      !sessionAuthorityConflict &&
      !terminalHasNonterminalDeferredTransfer &&
      unresolvedSessionClaims.length === 0 &&
      conflictingBoundSessionClaims.length === 0 &&
      terminalScopedCodexApprovalPrompt &&
      isRecord(rawActions.approve)
    ) {
      try {
        const ledger = ports.loadTerminalBridgeDispatchLedger(terminalControl);
        const boundary =
          ownership.state === "conflict" &&
            discoveredOwnership.state === "current" &&
            ledger
            ? terminalScopedCodexApprovalBoundary(ports, {
                storeDir,
                terminal,
                owner: discoveredOwnership.conversation,
                session: authoritativeSession,
                ledger,
                approval: terminalScopedCodexApprovalPrompt
              })
            : ownership.state === "none" &&
                discoveredOwnership.state === "none"
              ? terminalScopedCodexApprovalBoundary(ports, {
                  storeDir,
                  terminal,
                  session: authoritativeSession,
                  ledger,
                  approval: terminalScopedCodexApprovalPrompt
                })
              : undefined;
        if (!boundary) {
          throw new Error(
            "terminal-scoped Codex approval has no eligible managed authority"
          );
        }
        terminalScopedCodexApprovalAction = {
          ...rawActions.approve,
          arguments: {
            conversation_id: String(terminal.id),
            expected_terminal_token: boundary.token
          },
          scope: "terminal_current_prompt",
          authority: boundary.authority.kind,
          managed_state_unchanged: true,
          automatic_approval_eligible: false,
          durable_dispatch_receipt: false,
          uncertain_outcome_recovery:
            "refresh status and inspect the live prompt; do not retry blindly"
        };
      } catch (error) {
        ports.runtimeLog(
          "info",
          "terminal_scoped_codex_approval_not_advertised",
          {
            terminal_id: String(terminal.id),
            terminal_target: terminalControl.target,
            reason: error instanceof Error ? error.message : String(error)
          }
        );
      }
    }
    const rolloutBackedCodexSession = Boolean(
      authoritativeSession?.agent === "codex" &&
      isCompleteNativeRollout(
        authoritativeSession.binding?.native_process.rollout
      )
    );
    return {
      ...observation,
      terminalScopedCodexApprovalAction,
      rolloutBackedCodexSession
    };
  }

function observeActionAuthority(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>,
    context: TerminalListOwnershipContext,
    binding: ReturnType<typeof observeBindingAuthority>
  ) {
    return observeTerminalScopedApprovalAuthority(
      ports,
      terminal,
      context,
      observeTerminalHandoffAuthority(
        ports,
        terminal,
        context,
        observeDeferredTerminalAuthority(
          ports,
          terminal,
          context,
          observeDeferredSourceAuthority(
            ports,
            terminal,
            context,
            observeVerifiedEmptyTerminalAuthority(
              ports,
              terminal,
              context,
              binding
            )
          )
        )
      )
    );
  }

function managedSessionMatchesLiveTerminalEntry(
    ports: TerminalListOwnershipServicePorts,
    session: ManagedSessionState,
    terminal: Record<string, any>,
    storeDir: string
  ): boolean {
    const binding = session.binding;
    const liveControl = isRecord(terminal.terminal_control)
      ? terminal.terminal_control as unknown as TerminalControlRef
      : undefined;
    if (
      session.status !== "bound" ||
      !binding ||
      session.agent !== terminal.agent ||
      binding.native_process.pid !== Number(terminal.pid)
    ) {
      return false;
    }
    const terminalAliasMatches = terminalControlAliasMatches(
      binding.terminal_id,
      binding.terminal_control,
      terminal.id,
      liveControl
    );
    if (!terminalAliasMatches) {
      return false;
    }
    const workspaceMatches = ports.matchesConfiguredWorkspace(
      session.workspace,
      terminal.workspace ?? terminal.cwd
    );
    if (!workspaceMatches) {
      return false;
    }
    const observation = terminalObservationFromListEntry(
      terminal,
      session.agent
    );
    const evidence = { terminalAliasMatches, workspaceMatches };
    let decision = decideTerminalBindingMatch(session, observation, evidence);
    if (
      decision.state === "not_exact" &&
      decision.reason === "native_identity_mismatch" &&
      session.agent === "codex" &&
      observation.nativeIdentity.status === "resolved"
    ) {
      decision = decideTerminalBindingMatch(session, observation, {
        ...evidence,
        codexLingeringBeforeMatches:
          ports.codexLingeringBeforeIdentityMatchesSession({
            storeDir,
            session,
            identity: observation.nativeIdentity.identity
          })
      });
    }
    return decision.state === "exact";
  }

function managedSessionClaimsLiveTerminalEntry(
    session: ManagedSessionState,
    terminal: Record<string, any>
  ): boolean {
    const binding = session.binding;
    const liveControl = isRecord(terminal.terminal_control)
      ? terminal.terminal_control as unknown as TerminalControlRef
      : undefined;
    return Boolean(
      binding &&
      session.agent === terminal.agent &&
      binding.native_process.pid === Number(terminal.pid) &&
      terminalControlsShareIncarnation(binding.terminal_control, liveControl)
    );
  }

function listedTerminalProcessIncarnation(
    ports: TerminalListOwnershipServicePorts,
    terminal: Record<string, any>
  ): { processUuid?: string; processBirth?: string } {
    const processUuid = stringValue(terminal.native_agent_process_uuid);
    const processBirth = stringValue(terminal.native_agent_process_birth);
    if (terminal.agent !== "codex" || (processUuid && processBirth)) {
      return { processUuid, processBirth };
    }
    const pid = Number(terminal.pid);
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      return { processUuid, processBirth };
    }
    try {
      const incarnation = ports.codexProcessIncarnationForPid(pid);
      return {
        processUuid: processUuid ?? incarnation.processUuid,
        processBirth: processBirth ?? incarnation.processBirth
      };
    } catch {
      return { processUuid, processBirth };
    }
  }

function managedBindingConflictKindForLiveTerminalEntry(
  ports: TerminalListOwnershipServicePorts,
  {
    storeDir,
    session,
    terminal
  }: {
    storeDir: string;
    session: ManagedSessionState;
    terminal: Record<string, any>;
  }): ManagedBindingConflictKind | undefined {
    const binding = session.binding;
    if (
      session.status !== "bound" ||
      !binding ||
      !managedSessionClaimsLiveTerminalEntry(session, terminal) ||
      managedSessionMatchesLiveTerminalEntry(
        ports,
        session,
        terminal,
        storeDir
      )
    ) {
      return undefined;
    }
    const livePid = Number(terminal.pid);
    const incarnation = listedTerminalProcessIncarnation(ports, terminal);
    const relationship = processIncarnationRelationship({
      binding,
      livePid,
      liveProcessUuid: incarnation.processUuid,
      liveProcessBirth: incarnation.processBirth
    });
    if (relationship === "different") {
      return "stale_process_incarnation";
    }
    if (
      !terminalControlAliasMatches(
        binding.terminal_id,
        binding.terminal_control,
        terminal.id,
        isRecord(terminal.terminal_control)
          ? terminal.terminal_control
          : undefined
      ) ||
      !ports.matchesConfiguredWorkspace(
        session.workspace,
        terminal.workspace ?? terminal.cwd
      )
    ) {
      return "unverifiable";
    }
    return decideManagedBindingConflict({
      session,
      claimsTerminal: true,
      exactBinding: false,
      ownerConclusivelyInactive: false,
      processRelationship: relationship,
      liveNativeThreadId: stringValue(terminal.native_agent_session_id),
      statusCardNativeThreadId: stringValue(
        terminal.native_agent_status_card_session_id
      ),
      managedTurnCount: provisionalManagedBindingTurnCount(
        ports,
        storeDir,
        session
      )
    });
  }

function provisionalManagedBindingTurnCount(
    ports: TerminalListOwnershipServicePorts,
    storeDir: string,
    session: ManagedSessionState
  ): number | undefined {
    const binding = session.binding;
    return binding && session.lineage.created_by === "attach" &&
        !session.last_transition_id &&
        !binding.native_thread_id &&
        !binding.native_process.rollout
      ? ports.managedTurnsForSession(storeDir, session.session_id).length
      : undefined;
  }

function managedSessionHasUnresolvedNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean {
    const root = nativeThreadTransitionsDir(storeDir);
    if (!fs.existsSync(root)) {
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      let transition: NativeThreadTransition;
      try {
        transition = loadNativeThreadTransition(storeDir, entry.name);
      } catch {
        return true;
      }
      if (
        transition.source_session_id !== session.session_id &&
        transition.target_session_id !== session.session_id
      ) {
        continue;
      }
      if (!["committed", "aborted"].includes(transition.status)) {
        return true;
      }
    }
    return false;
  }

function managedSessionHasAnyNativeTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean {
    const root = nativeThreadTransitionsDir(storeDir);
    if (!fs.existsSync(root)) {
      return false;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      let transition: NativeThreadTransition;
      try {
        transition = loadNativeThreadTransition(storeDir, entry.name);
      } catch {
        return true;
      }
      if (
        transition.source_session_id === session.session_id ||
        transition.target_session_id === session.session_id
      ) {
        return true;
      }
    }
    return false;
  }

function terminalControlForManagedConversation(
    ports: TerminalListOwnershipServicePorts,
    conversation: Conversation
  ): TerminalControlRef | undefined {
    return ports.terminalControlFromTakeover(
      isRecord(conversation.native_session_takeover)
        ? conversation.native_session_takeover
        : undefined
    );
  }

function terminalIncarnationBlockingTurns(
    ports: TerminalListOwnershipServicePorts,
    storeDir: string,
    terminalControl: TerminalControlRef,
    conversations: Conversation[] = listConversations(storeDir)
  ): Conversation[] {
    return conversations
      .filter(ports.isDiscoverableTmuxConversation)
      .filter((turn) =>
        terminalControlsShareIncarnation(
          terminalControlForManagedConversation(ports, turn),
          terminalControl
        ) && isSessionSendBlockingStatus(turn.status)
      )
      .sort(compareManagedConversationRecency);
  }

function managedTurnNeedsAttention(conversation: Conversation): boolean {
    return terminalManagedTurnNeedsAttention({
      status: conversation.status,
      get callbackDeliveryStatus() {
        const delivery = isRecord(conversation.callback_delivery)
          ? conversation.callback_delivery
          : undefined;
        return String(delivery?.status ?? "");
      }
    });
  }

function assertTerminalIncarnationCanStartTurn(
    ports: TerminalListOwnershipServicePorts,
    storeDir: string,
    terminalControl: TerminalControlRef
  ): void {
    const blocker = terminalIncarnationBlockingTurns(
      ports,
      storeDir,
      terminalControl
    )[0];
    if (!blocker) {
      return;
    }
    throw new Error(
      `terminal ${terminalControl.target} still has unresolved Turn ` +
      `${turnIdForConversation(blocker)} (${blocker.status})`
    );
  }

function terminalDispatchOwnership(
    ports: TerminalListOwnershipServicePorts,
    terminalControl: TerminalControlRef
  ): TerminalDispatchOwnershipResult {
    let ledger: TerminalDispatchLedgerDocument | undefined;
    try {
      ledger = ports.loadTerminalBridgeDispatchLedger(terminalControl);
    } catch (error) {
      const decision = dispatch.decideTerminalDispatchOwnership("unreadable");
      return {
        state: "conflict",
        conflict: {
          reason: decision.code === "ledger_unreadable"
            ? error instanceof Error ? error.message : String(error)
            : "terminal dispatch ledger is unreadable",
          recovery:
            "inspect the shared terminal pane before performing a side effect"
        }
      };
    }
    const ledgerAuthority: dispatch.TerminalDispatchLedgerAuthority = !ledger
      ? "absent"
      : ledger.status === "resolved"
        ? "resolved"
        : ports.terminalDispatchRecordMatchesControl(
            ledger,
            terminalControl,
            { requireProcessAnchor: false }
          ) && !ports.terminalDispatchRecordMatchesControl(
            ledger,
            terminalControl
          )
          ? "stale_process_incarnation"
          : dispatch.isActiveTerminalDispatchStatus(String(ledger.status))
            ? "active"
            : "inactive_status";
    let decision = dispatch.decideTerminalDispatchOwnership(ledgerAuthority);
    if (decision.state === "none" || !ledger) {
      return { state: "none" };
    }
    const owner = ports.loadTerminalDispatchLedgerOwner(ledger);
    const ledgerMessageId = stringValue(ledger.message_id);
    const ownerAuthority: dispatch.TerminalDispatchOwnerAuthority = !owner
      ? "unavailable"
      : isTerminalDispatchOwnerReleasedStatus(owner.status)
        ? "released"
        : !terminalControlsShareIncarnation(
            terminalControlForManagedConversation(ports, owner),
            terminalControl
          )
          ? "terminal_mismatch"
          : ledgerMessageId && stringValue(
              isRecord(owner.native_session_takeover)
                ? owner.native_session_takeover.terminal_bridge_message_id
                : undefined
            ) !== ledgerMessageId
            ? "generation_mismatch"
            : "current";
    decision = dispatch.decideTerminalDispatchOwnership(
      ledgerAuthority,
      ownerAuthority
    );
    if (decision.state === "none") {
      return { state: "none" };
    }
    if (decision.state === "current" && owner) {
      return { state: "current", conversation: owner };
    }
    const reason = decision.state === "conflict" &&
        decision.code === "owner_terminal_mismatch"
      ? "dispatch owner does not reference this terminal pane incarnation"
      : decision.state === "conflict" &&
          decision.code === "owner_generation_mismatch"
        ? "dispatch generation does not match the owner state"
        : "dispatch owner state is unavailable";
    return {
      state: "conflict",
      conflict: projectTerminalDispatchConflict({
        reason,
        dispatchStatus: stringValue(ledger.status),
        ownerConversationId: stringValue(ledger.conversation_id),
        messageId: stringValue(ledger.message_id)
      })
    };
  }

function localTerminalDispatchOwnership(
    ports: TerminalListOwnershipServicePorts,
    ledgerOwner: Conversation,
    localConversations: Conversation[],
    terminal: Record<string, any>
  ):
    | { state: "current"; conversation: Conversation }
    | { state: "conflict"; conflict: Record<string, any> } {
    const localOwner = localConversations.find((conversation) =>
      conversation.conversation_id === ledgerOwner.conversation_id &&
      sameCanonicalStatePath(conversation.state_path, ledgerOwner.state_path)
    );
    return decideLocalTerminalDispatchOwnership({
      ledgerOwnerId: ledgerOwner.conversation_id,
      localOwner,
      localOwnerMatchesLiveTerminal: localOwner
        ? managedTurnMatchesLiveTerminal(ports, localOwner, terminal)
        : false
    });
  }

function terminalScopedCodexApprovalBoundary(
  ports: TerminalListOwnershipServicePorts,
  {
    storeDir,
    terminal,
    session,
    ledger,
    approval,
    owner
  }: TerminalScopedBoundaryRequest): TerminalScopedCodexApprovalBoundary {
    const terminalRecord = isRecord(terminal) ? terminal : {};
    const terminalControl = isRecord(terminalRecord.terminal_control)
      ? terminalRecord.terminal_control as unknown as TerminalControlRef
      : undefined;
    const control = terminalControl as TerminalControlRef;
    const terminalId = String(terminalRecord.id);
    const relatedBoundSessionIds = () =>
      listManagedSessions(storeDir)
        .filter((candidate) =>
          candidate.status === "bound" &&
          candidate.agent === "codex" &&
          candidate.binding?.native_process.pid === Number(terminalRecord.pid) &&
          terminalControlsShareIncarnation(
            candidate.binding?.terminal_control,
            terminalControl
          )
        )
        .map((candidate) => candidate.session_id);
    const blockingTurnIds = () =>
      terminalIncarnationBlockingTurns(ports, storeDir, control)
        .map((turn) => turnIdForConversation(turn));
    const hasDeferredRecovery = () =>
      listDeferredForegroundTransfers(storeDir).some((transfer) =>
        !isFinalDeferredForegroundTransferStatus(transfer.status) &&
        (
          transfer.source_session_id === session.session_id ||
          transfer.target_session_id === session.session_id ||
          (
            transfer.terminal_id === terminalId &&
            terminalControlEvidenceMatches(
              transfer.terminal_endpoint,
              control
            )
          )
        )
      );
    const commonChecks = {
      relatedBoundSessionIds,
      blockingTurnIds,
      hasNativeTransition: () =>
        managedSessionHasAnyNativeTransition(storeDir, session),
      hasDeferredRecovery,
      ledgerMatchesTerminal: () =>
        ports.terminalDispatchRecordMatchesControl(ledger, control)
    };
    if (owner && ledger) {
      return decideTerminalScopedCodexApprovalAuthority({
        kind: "current_dispatch_owner",
        storeDir,
        terminal,
        owner,
        session,
        ledger,
        approval,
        checks: {
          ...commonChecks,
          assertDispatchOwner: () =>
            ports.assertManagedTerminalDispatchOwner({
              storeDir,
              conversation: owner,
              terminalControl: control,
              action: "approve"
            }),
          ownerMatchesNativeIdentity: (identity) =>
            nativeAgentIdentityMatchesTurn(
              owner,
              identity
                ? { ...identity, evidence: "terminal_scoped_approval" }
                : undefined
            )
        }
      });
    }
    return decideTerminalScopedCodexApprovalAuthority({
      kind: "managed_session_no_dispatch_owner",
      storeDir,
      terminal,
      session,
      ledger,
      approval,
      checks: {
        ...commonChecks,
        dispatchOwnershipIsNone: () =>
          terminalDispatchOwnership(ports, control).state === "none",
        hasOrphanedDispatch: () =>
          Boolean(ports.orphanedTerminalDispatchForRecovery(control))
      }
    });
  }

function managedTurnMatchesLiveTerminal(
    ports: TerminalListOwnershipServicePorts,
    conversation: Conversation,
    terminal: Record<string, any>
  ): boolean {
    const takeover = isRecord(conversation.native_session_takeover)
      ? conversation.native_session_takeover
      : undefined;
    const liveControl = isRecord(terminal.terminal_control)
      ? terminal.terminal_control
      : undefined;
    const storedControl = ports.terminalControlFromTakeover(takeover);
    const livePid = Number(terminal.pid);
    const storedPid = Number(takeover?.terminal_agent_pid);
    if (
      executorForConversation(conversation).kind !== terminal.agent ||
      !Number.isSafeInteger(livePid) ||
      livePid <= 1 ||
      storedPid !== livePid ||
      !terminalControlAliasMatches(
        stringValue(takeover?.native_session_id),
        storedControl,
        stringValue(terminal.id),
        liveControl
      ) ||
      !terminalControlsShareIncarnation(storedControl, liveControl)
    ) {
      return false;
    }
    const liveSessionId = stringValue(terminal.native_agent_session_id);
    const liveProcessUuid = stringValue(terminal.native_agent_process_uuid);
    const liveProcessBirth = stringValue(terminal.native_agent_process_birth);
    const liveRollout = isRecord(terminal.native_agent_rollout)
      ? terminal.native_agent_rollout
      : undefined;
    const liveNativeIdentity = liveSessionId
      ? {
          sessionId: liveSessionId,
          ...(liveProcessUuid ? { processUuid: liveProcessUuid } : {}),
          ...(liveProcessBirth ? { processBirth: liveProcessBirth } : {}),
          ...(liveRollout
            ? {
                rollout: {
                  fd: String(liveRollout.fd ?? ""),
                  device: String(liveRollout.device ?? ""),
                  inode: String(liveRollout.inode ?? ""),
                  path: String(liveRollout.path ?? "")
                }
              }
            : {}),
          evidence: "live_terminal"
        }
      : undefined;
    if (!nativeAgentIdentityMatchesTurn(conversation, liveNativeIdentity)) {
      return false;
    }
    const liveWorkspace = terminal.workspace ?? terminal.cwd;
    if (!ports.matchesConfiguredWorkspace(conversation.workspace, liveWorkspace)) {
      return false;
    }
    const livePanePath = liveControl?.currentPath;
    if (
      livePanePath !== undefined &&
      !ports.matchesConfiguredWorkspace(conversation.workspace, livePanePath)
    ) {
      return false;
    }
    return true;
  }

export function createTerminalListOwnershipService(
  ports: TerminalListOwnershipServicePorts
): TerminalListOwnershipService {
  return Object.freeze({
    assertTerminalIncarnationCanStartTurn: (storeDir, terminalControl) =>
      assertTerminalIncarnationCanStartTurn(ports, storeDir, terminalControl),
    managedSessionHasAnyNativeTransition,
    managedSessionHasUnresolvedNativeTransition,
    managedSessionMatchesLiveTerminalEntry: (session, terminal, storeDir) =>
      managedSessionMatchesLiveTerminalEntry(
        ports,
        session,
        terminal,
        storeDir
      ),
    managedTurnMatchesLiveTerminal: (conversation, terminal) =>
      managedTurnMatchesLiveTerminal(ports, conversation, terminal),
    managedTurnNeedsAttention,
    observeActionAuthority: (terminal, context, binding) =>
      observeActionAuthority(ports, terminal, context, binding),
    observeBindingAuthority: (terminal, context) =>
      observeBindingAuthority(ports, terminal, context),
    provisionalManagedBindingTurnCount: (storeDir, session) =>
      provisionalManagedBindingTurnCount(ports, storeDir, session),
    terminalControlForManagedConversation: (conversation) =>
      terminalControlForManagedConversation(ports, conversation),
    terminalDispatchOwnership: (terminalControl) =>
      terminalDispatchOwnership(ports, terminalControl),
    terminalIncarnationBlockingTurns: (
      storeDir,
      terminalControl,
      conversations
    ) => terminalIncarnationBlockingTurns(
      ports,
      storeDir,
      terminalControl,
      conversations
    ),
    terminalScopedCodexApprovalBoundary: (request) =>
      terminalScopedCodexApprovalBoundary(ports, request)
  });
}

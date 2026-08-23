import { createHash } from "node:crypto";
import path from "node:path";

import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import { callbackExpectedForPrimaryOutbox } from
  "./callback-route-authority.js";
import { canonicalJson } from "./canonical-json.js";
import type {
  DeferredForegroundTransfer,
  DeferredForegroundTransferSourceKind,
  DeferredForegroundTransferSourceRolloutAuthority,
  DeferredForegroundTransferSourceTurnAuthority
} from "./deferred-foreground-transfer.js";
import {
  isExactNativeThreadId,
  managedSessionBindingToken,
  managedSessionRevision,
  managedSessionStatesFromConversations,
  type ManagedSessionState
} from "./managed-session.js";
import {
  executorForConversation,
  isTerminalDispatchOwnerReleasedStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  listManagedSessions,
  loadManagedSession,
  loadNativeThreadTransition
} from "./session-store.js";
import {
  candidateSourceRootAuthorityMatches,
  exactBoundCodexSendSource,
  terminalControlsShareIncarnation,
  type CodexSendAuthorityContext
} from "./terminal-authority-policy.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef
} from "./terminal-control-ref.js";
import type { DeferredCodexForegroundDispatchSnapshot } from
  "./terminal-dispatch-composition.js";
import {
  terminalDispatchReceiptHistory as terminalLedgerReceiptHistory
} from "./terminal-dispatch-ledger-codec.js";
import {
  terminalActionFingerprint
} from "./native-thread-resume-snapshot-policy.js";
import {
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission,
  terminalBridgeSubmissionReceipts
} from "./terminal-dispatch-receipt.js";
import { pathsForConversation, pathsForConversationDir } from "./store.js";
import {
  validTerminalMonitorTimestampMs as validTimestampMs
} from "./terminal-monitor-decision-policy.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

const TERMINAL_INPUT_EVIDENCE_FIELDS = [
  "text_injected_at",
  "enter_dispatched_at",
  "submitted_at",
  "agent_accepted_at",
  "not_accepted_at",
  "uncertain_at",
  "acceptance_evidence"
] as const;

export interface DeferredForegroundAuthorityAdapterPorts {
  turn: {
    terminalControl(value: unknown): TerminalControlRef | undefined;
    storeDir(conversation: Conversation): string | undefined;
    turnsForSession(storeDir: string, sessionId: string): Conversation[];
    needsAttention(conversation: Conversation): boolean;
    readEvents(logPath: string): Record<string, any>[];
  };
  ledger: {
    load(control: TerminalControlRef): Record<string, any> | undefined;
    matchesControl(
      ledger: Record<string, any> | undefined,
      control: TerminalControlRef,
      options?: {
        requireCurrentRoute?: boolean;
        requireProcessAnchor?: boolean;
      }
    ): boolean;
    processAnchor(ledger: Record<string, any>): number | undefined;
  };
  transition: {
    hasUnresolved(storeDir: string, session: ManagedSessionState): boolean;
    hasAny(storeDir: string, session: ManagedSessionState): boolean;
  };
}

function required<Value>(
  value: Value | null | undefined,
  message: string
): Value {
  if (value === undefined || value === null || value === "") {
    throw new Error(message);
  }
  return value;
}

export function codexCandidateInventoryHasNoOtherManagedClaim(ports: DeferredForegroundAuthorityAdapterPorts, {
  storeDir,
  inventory,
  sourceSessionId,
  includeDetached = true
}: {
  storeDir: string;
  inventory: CodexOpenRootRolloutInventory;
  sourceSessionId: string;
  includeDetached?: boolean;
}): boolean {
  const candidateIds = new Set(
    inventory.roots.map((root) => root.sessionId.toLowerCase())
  );
  return !listManagedSessions(storeDir).some((session) =>
    session.session_id !== sourceSessionId &&
    (includeDetached || session.status !== "detached") &&
    isExactNativeThreadId(session.binding?.native_thread_id) &&
    candidateIds.has(session.binding!.native_thread_id!.toLowerCase())
  );
}

type TerminalBridgeSubmission = NonNullable<
  ReturnType<typeof terminalBridgeSubmission>
>;
type ManagedTerminalBinding = NonNullable<ManagedSessionState["binding"]>;

interface ReleasedAbortCandidateContext {
  ports: DeferredForegroundAuthorityAdapterPorts;
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
  binding: ManagedSessionState["binding"];
  takeover: Record<string, any> | undefined;
  submission: ReturnType<typeof terminalBridgeSubmission>;
  terminalControl: TerminalControlRef | undefined;
  messageId: string | undefined;
  preparedAt: string | undefined;
  abortedAt: string | undefined;
}

interface ReleasedAbortEnvelope extends ReleasedAbortCandidateContext {
  binding: ManagedTerminalBinding;
  takeover: Record<string, any>;
  submission: TerminalBridgeSubmission;
  terminalControl: TerminalControlRef;
  messageId: string;
}

interface ReleasedAbortStage extends ReleasedAbortEnvelope {
  preparedAt: string;
  abortedAt: string;
}

function hasExactReleasedAbortEnvelope(
  context: ReleasedAbortCandidateContext
): context is ReleasedAbortEnvelope {
  const { ports, session, turn, binding, takeover, submission,
    terminalControl, messageId } = context;
  if (
    session.status !== "bound" ||
    session.agent !== "codex" ||
    !binding ||
    !isExactNativeThreadId(binding.native_thread_id) ||
    !isTerminalDispatchOwnerReleasedStatus(turn.status) ||
    ports.turn.needsAttention(turn) ||
    isRecord(turn.callback_delivery) ||
    isRecord(turn.terminal_bridge_completion_claim) ||
    !takeover ||
    isRecord(takeover.terminal_bridge_completion_claim) ||
    !submission ||
    !terminalControl ||
    !messageId
  ) {
    return false;
  }
  return true;
}

function hasExactReleasedAbortStage(
  context: ReleasedAbortEnvelope
): context is ReleasedAbortStage {
  const { submission, preparedAt, abortedAt } = context;
  if (
    submission.status !== "aborted" ||
    submission.safe_to_retry !== true ||
    stringValue(submission.last_proven_stage) !== "prepared" ||
    !preparedAt ||
    !abortedAt ||
    !validTimestampMs(preparedAt) ||
    !validTimestampMs(abortedAt) ||
    Date.parse(abortedAt) < Date.parse(preparedAt) ||
    TERMINAL_INPUT_EVIDENCE_FIELDS.some(
      (field) => submission[field] !== undefined
    )
  ) {
    return false;
  }
  return true;
}

function releasedAbortRequestMatches(context: ReleasedAbortStage): boolean {
  const { takeover, submission, messageId } = context;
  return stringValue(takeover.terminal_bridge_message_id) === messageId &&
    stringValue(takeover.terminal_bridge_request_hash) ===
      stringValue(submission.request_hash) &&
    terminalBridgeRequestFingerprint(
      stringValue(takeover.terminal_bridge_request_text) ?? ""
    ) === stringValue(submission.request_hash);
}

function releasedAbortConversationMatches(
  context: ReleasedAbortStage
): boolean {
  const { session, turn, submission } = context;
  return executorForConversation(turn).kind === "codex" &&
    sessionIdForConversation(turn) === session.session_id &&
    stringValue(submission.session_id) === session.session_id &&
    stringValue(submission.turn_id) === turnIdForConversation(turn) &&
    stringValue(submission.executor_kind) === "codex" &&
    stringValue(submission.openclaw_session) === turn.openclaw_session;
}

function releasedAbortBindingMatches(context: ReleasedAbortStage): boolean {
  const { turn, binding, takeover, submission } = context;
  return stringValue(turn.terminal_binding_id) === binding.binding_id &&
    Number(turn.terminal_binding_generation) === binding.generation &&
    stringValue(takeover.terminal_binding_id) === binding.binding_id &&
    Number(takeover.terminal_binding_generation) === binding.generation &&
    stringValue(submission.binding_id) === binding.binding_id &&
    Number(submission.binding_generation) === binding.generation &&
    stringValue(turn.native_thread_id) === binding.native_thread_id &&
    stringValue(takeover.terminal_agent_session_id) ===
      binding.native_thread_id &&
    stringValue(submission.native_thread_id) === binding.native_thread_id;
}

function releasedAbortProcessAndControlMatches(
  context: ReleasedAbortStage
): boolean {
  const { session, turn, binding, takeover, submission, terminalControl } =
    context;
  return Number(takeover.terminal_agent_pid) === binding.native_process.pid &&
    stringValue(takeover.terminal_agent_process_uuid) ===
      binding.native_process.process_uuid &&
    stringValue(takeover.terminal_agent_process_birth) ===
      binding.native_process.process_birth &&
    terminalControlsShareIncarnation(
      terminalControl,
      binding.terminal_control
    ) &&
    terminalControlEvidenceMatches(
      submission.terminal_endpoint ?? terminalControl,
      binding.terminal_control
    ) &&
    path.resolve(turn.workspace) === path.resolve(session.workspace);
}

function releasedAbortPathsMatch(
  context: ReleasedAbortStage,
  canonical: ReturnType<typeof pathsForConversation>
): boolean {
  const { ports, storeDir, turn, submission } = context;
  return path.resolve(stringValue(turn.state_path) ?? "") ===
      path.resolve(canonical.statePath) &&
    path.resolve(stringValue(turn.event_log_path) ?? "") ===
      path.resolve(canonical.logPath) &&
    path.resolve(ports.turn.storeDir(turn) ?? "") === path.resolve(storeDir) &&
    path.resolve(stringValue(submission.store_dir) ?? "") ===
      path.resolve(storeDir);
}

function exactReleasedSafeAbortedCandidateTurn(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
  storeDir,
  session,
  turn
}: {
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
}): boolean {
  const binding = session.binding;
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(turn);
  const terminalControl = ports.turn.terminalControl(takeover);
  const messageId = stringValue(submission?.message_id);
  const preparedAt = stringValue(submission?.prepared_at);
  const abortedAt = stringValue(submission?.aborted_at);
  const context: ReleasedAbortCandidateContext = {
    ports,
    storeDir,
    session,
    turn,
    binding,
    takeover,
    submission,
    terminalControl,
    messageId,
    preparedAt,
    abortedAt
  };
  if (!hasExactReleasedAbortEnvelope(context) ||
    !hasExactReleasedAbortStage(context) ||
    !releasedAbortRequestMatches(context) ||
    !releasedAbortConversationMatches(context) ||
    !releasedAbortBindingMatches(context) ||
    !releasedAbortProcessAndControlMatches(context)) {
    return false;
  }
  const canonical = pathsForConversation(turn.conversation_id, storeDir);
  if (!releasedAbortPathsMatch(context, canonical)) {
    return false;
  }
  const matchingReceipts = terminalBridgeSubmissionReceipts(turn).filter(
    (receipt) => stringValue(receipt.message_id) === messageId
  );
  return matchingReceipts.length === 1 &&
    canonicalJson(matchingReceipts[0]) === canonicalJson(submission);
}

export function deferredCandidateSourceTurnHistory(
  ports: DeferredForegroundAuthorityAdapterPorts,
  storeDir: string,
  session: ManagedSessionState
): DeferredForegroundTransferSourceTurnAuthority[] | undefined {
  const binding = session.binding;
  if (!binding?.native_thread_id) {
    return undefined;
  }
  const turns = currentCandidateBindingTurns(
    binding,
    ports.turn.turnsForSession(storeDir, session.session_id)
  );
  if (!turns || turns.some((turn) => {
    const callbackDelivered =
      isRecord(turn.callback_delivery) &&
      turn.callback_delivery.status === "delivered";
    const explicitlyAbandonedUncertain =
      exactExplicitlyAbandonedUncertainCandidateTurn(ports, {
        storeDir,
        session,
        turn
      });
    const safelyAbortedBeforeInput = exactReleasedSafeAbortedCandidateTurn(ports, {
      storeDir,
      session,
      turn
    });
    return (
      !isTerminalDispatchOwnerReleasedStatus(turn.status) ||
      ports.turn.needsAttention(turn) ||
      (
        isRecord(turn.callback_delivery) &&
        !callbackDelivered
      ) ||
      (
        callbackExpectedForPrimaryOutbox(turn) &&
        !callbackDelivered &&
        !explicitlyAbandonedUncertain &&
        !safelyAbortedBeforeInput
      )
    );
  })) {
    return undefined;
  }
  return turns
    .map((turn) => ({
      turn_id: turnIdForConversation(turn),
      status: turn.status as DeferredForegroundTransferSourceTurnAuthority["status"],
      updated_at: required(
        stringValue(turn.updated_at),
        `managed Turn ${turnIdForConversation(turn)} updated_at is unavailable`
      ),
      binding_id: binding.binding_id,
      binding_generation: binding.generation,
      native_thread_id: binding.native_thread_id as string,
      turn_fingerprint: createHash("sha256")
        .update(JSON.stringify(turn))
        .digest("hex")
    }))
    .sort((left, right) => left.turn_id.localeCompare(right.turn_id));
}

function frozenCandidateSourceTurnHistory(
  ports: DeferredForegroundAuthorityAdapterPorts,
  storeDir: string,
  session: ManagedSessionState
): DeferredForegroundTransferSourceTurnAuthority[] | undefined {
  const binding = session.binding;
  if (!binding?.native_thread_id) {
    return undefined;
  }
  const turns = currentCandidateBindingTurns(
    binding,
    ports.turn.turnsForSession(storeDir, session.session_id)
  );
  if (!turns || turns.some((turn) =>
    !isTerminalDispatchOwnerReleasedStatus(turn.status)
  )) {
    return undefined;
  }
  return turns.map((turn) => ({
    turn_id: turnIdForConversation(turn),
    status: turn.status as DeferredForegroundTransferSourceTurnAuthority["status"],
    updated_at: required(
      stringValue(turn.updated_at),
      `managed Turn ${turnIdForConversation(turn)} updated_at is unavailable`
    ),
    binding_id: binding.binding_id,
    binding_generation: binding.generation,
    native_thread_id: binding.native_thread_id as string,
    turn_fingerprint: createHash("sha256")
      .update(JSON.stringify(turn))
      .digest("hex")
  })).sort((left, right) => left.turn_id.localeCompare(right.turn_id));
}

function candidateTurnNativeThreadId(turn: Conversation): string | undefined {
  return stringValue(turn.native_thread_id) ??
    stringValue(
      isRecord(turn.native_session_takeover)
        ? turn.native_session_takeover.terminal_agent_session_id
        : undefined
    );
}

function candidateTurnMatchesCurrentBinding(
  turn: Conversation,
  binding: ManagedTerminalBinding
): boolean {
  return stringValue(turn.terminal_binding_id) === binding.binding_id &&
    Number(turn.terminal_binding_generation) === binding.generation &&
    candidateTurnNativeThreadId(turn) === binding.native_thread_id;
}

function candidateTurnHasStrictEarlierBinding(
  turn: Conversation,
  binding: ManagedTerminalBinding
): boolean {
  const turnBindingId = stringValue(turn.terminal_binding_id);
  const turnBindingGeneration = Number(turn.terminal_binding_generation);
  const turnNativeThreadId = stringValue(turn.native_thread_id);
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  if (
    turnBindingId &&
    Number.isSafeInteger(turnBindingGeneration) &&
    turnBindingGeneration >= 1 &&
    isExactNativeThreadId(turnNativeThreadId)
  ) {
    const nestedBindingId = stringValue(takeover?.terminal_binding_id);
    const nestedBindingGeneration = takeover?.terminal_binding_generation ===
        undefined
      ? undefined
      : Number(takeover.terminal_binding_generation);
    const nestedNativeThreadIds = [
      takeover?.terminal_agent_expected_session_id,
      takeover?.terminal_agent_session_id
    ].filter((value) => value !== undefined);
    if (
      (takeover?.terminal_binding_id !== undefined &&
        nestedBindingId !== turnBindingId) ||
      (nestedBindingGeneration !== undefined &&
        nestedBindingGeneration !== turnBindingGeneration) ||
      nestedNativeThreadIds.some(
        (value) => stringValue(value) !== turnNativeThreadId
      )
    ) {
      return false;
    }
    return turnBindingId !== binding.binding_id &&
      turnBindingGeneration < binding.generation;
  }
  const hasNoPersistedBindingIdentity =
    turn.terminal_binding_id === undefined &&
    turn.terminal_binding_generation === undefined &&
    turn.native_thread_id === undefined &&
    takeover?.terminal_binding_id === undefined &&
    takeover?.terminal_binding_generation === undefined;
  if (!hasNoPersistedBindingIdentity) {
    return false;
  }
  try {
    const migrated = managedSessionStatesFromConversations([turn])[0];
    const migratedBinding = migrated?.status === "bound"
      ? migrated.binding
      : undefined;
    return Boolean(
      migratedBinding &&
      migratedBinding.binding_id !== binding.binding_id &&
      migratedBinding.generation < binding.generation &&
      isExactNativeThreadId(migratedBinding.native_thread_id)
    );
  } catch {
    return false;
  }
}

/**
 * Keep the mutable authority fingerprint scoped to the current binding epoch.
 * A released Turn from a strictly earlier binding epoch no longer owns current
 * terminal input. Its callback and notification recovery remain independent
 * concerns; any ambiguous binding or non-released Turn still fails closed.
 */
function currentCandidateBindingTurns(
  binding: ManagedTerminalBinding,
  turns: Conversation[]
): Conversation[] | undefined {
  const current: Conversation[] = [];
  for (const turn of turns) {
    if (candidateTurnMatchesCurrentBinding(turn, binding)) {
      current.push(turn);
      continue;
    }
    if (
      !isTerminalDispatchOwnerReleasedStatus(turn.status) ||
      !candidateTurnHasStrictEarlierBinding(turn, binding)
    ) {
      return undefined;
    }
  }
  return current;
}

function exactExplicitlyAbandonedUncertainCandidateTurn(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
  storeDir,
  session,
  turn
}: {
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
}): boolean {
  return explicitlyAbandonedUncertainCandidateTurnFingerprint(ports, {
    storeDir,
    session,
    turn
  }) !== undefined;
}

interface ExplicitlyAbandonedCandidateTurnProof {
  turnId: string;
  messageId: string;
  turnFingerprint: string;
  closeEvent: Record<string, any>;
  uncertainReceipt: Record<string, any>;
}

interface UncertainCandidateTurnContext {
  ports: DeferredForegroundAuthorityAdapterPorts;
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
  takeover: Record<string, any> | undefined;
  submission: ReturnType<typeof terminalBridgeSubmission>;
  terminalControl: TerminalControlRef | undefined;
  messageId: string | undefined;
}

interface UncertainCandidateEnvelope extends UncertainCandidateTurnContext {
  takeover: Record<string, any>;
  submission: TerminalBridgeSubmission;
  terminalControl: TerminalControlRef;
  messageId: string;
}

function hasExplicitCandidateClose(turn: Conversation): boolean {
  return turn.status === "closed" &&
    !isRecord(turn.callback_delivery) &&
    !isRecord(turn.terminal_bridge_completion_claim) &&
    Boolean(stringValue(turn.closed_at)) &&
    Boolean(stringValue(turn.close_reason));
}

function hasUncertainCandidateEnvelope(
  context: UncertainCandidateTurnContext
): context is UncertainCandidateEnvelope {
  const { session, turn, takeover, submission, terminalControl, messageId } =
    context;
  if (
    !takeover ||
    isRecord(takeover.terminal_bridge_completion_claim) ||
    !terminalControl ||
    submission?.status !== "uncertain" ||
    submission.safe_to_retry === true ||
    !messageId ||
    stringValue(takeover.terminal_bridge_message_id) !== messageId ||
    stringValue(submission.session_id) !== session.session_id ||
    stringValue(submission.turn_id) !== turnIdForConversation(turn)
  ) {
    return false;
  }
  return true;
}

function uncertainCandidatePathsMatch(
  context: UncertainCandidateEnvelope,
  canonical: ReturnType<typeof pathsForConversation>
): boolean {
  const { ports, storeDir, turn } = context;
  return path.resolve(stringValue(turn.state_path) ?? "") ===
      path.resolve(canonical.statePath) &&
    path.resolve(stringValue(turn.event_log_path) ?? "") ===
      path.resolve(canonical.logPath) &&
    path.resolve(ports.turn.storeDir(turn) ?? "") === path.resolve(storeDir);
}

function tryLoadAbandonmentLedger(
  ports: DeferredForegroundAuthorityAdapterPorts,
  terminalControl: TerminalControlRef,
  ledgerOverride: Record<string, any> | undefined
): Record<string, any> | undefined {
  try {
    return ledgerOverride ?? ports.ledger.load(terminalControl);
  } catch {
    return undefined;
  }
}

function resolvedAbandonmentLedgerMatches(
  ledger: Record<string, any>,
  context: UncertainCandidateEnvelope,
  canonical: ReturnType<typeof pathsForConversation>
): boolean {
  const { storeDir, session, turn, submission, messageId } = context;
  return ledger.status === "resolved" &&
    ledger.reason === "conversation explicitly closed by request" &&
    Boolean(validTimestampMs(ledger.resolved_at)) &&
    stringValue(ledger.conversation_id) === turn.conversation_id &&
    stringValue(ledger.session_id) === session.session_id &&
    stringValue(ledger.turn_id) === turnIdForConversation(turn) &&
    stringValue(ledger.message_id) === messageId &&
    stringValue(ledger.request_hash) === stringValue(submission.request_hash) &&
    stringValue(ledger.binding_id) === stringValue(turn.terminal_binding_id) &&
    Number(ledger.binding_generation) ===
      Number(turn.terminal_binding_generation) &&
    path.resolve(stringValue(ledger.state_path) ?? "") ===
      path.resolve(canonical.statePath) &&
    path.resolve(stringValue(ledger.event_log_path) ?? "") ===
      path.resolve(canonical.logPath) &&
    path.resolve(stringValue(ledger.store_dir) ?? "") === path.resolve(storeDir);
}

function uniqueAbandonmentReceipt(
  ledger: Record<string, any>,
  messageId: string
): Record<string, any> | undefined {
  try {
    const matchingReceipts = terminalLedgerReceiptHistory(ledger).filter(
      (candidate) => stringValue(candidate.message_id) === messageId
    );
    return matchingReceipts.length === 1
      ? matchingReceipts[0]
      : undefined;
  } catch {
    return undefined;
  }
}

function uncertainAbandonmentReceiptMatches(
  receipt: Record<string, any> | undefined,
  context: UncertainCandidateEnvelope,
  canonical: ReturnType<typeof pathsForConversation>
): receipt is Record<string, any> {
  const { ports, storeDir, session, turn, submission, terminalControl } =
    context;
  if (
    !receipt ||
    receipt.status !== "uncertain" ||
    receipt.safe_to_retry === true ||
    !validTimestampMs(receipt.uncertain_at) ||
    !ports.ledger.matchesControl(receipt, terminalControl) ||
    stringValue(receipt.conversation_id) !== turn.conversation_id ||
    stringValue(receipt.session_id) !== session.session_id ||
    stringValue(receipt.turn_id) !== turnIdForConversation(turn) ||
    stringValue(receipt.request_hash) !== stringValue(submission.request_hash) ||
    stringValue(receipt.binding_id) !== stringValue(turn.terminal_binding_id) ||
    Number(receipt.binding_generation) !==
      Number(turn.terminal_binding_generation) ||
    path.resolve(stringValue(receipt.state_path) ?? "") !==
      path.resolve(canonical.statePath) ||
    path.resolve(stringValue(receipt.event_log_path) ?? "") !==
      path.resolve(canonical.logPath) ||
    path.resolve(stringValue(receipt.store_dir) ?? "") !== path.resolve(storeDir)
  ) {
    return false;
  }
  return true;
}

function tryFindExplicitCloseEvent(
  ports: DeferredForegroundAuthorityAdapterPorts,
  turn: Conversation,
  logPath: string
): Record<string, any> | undefined {
  try {
    return ports.turn.readEvents(logPath).find((event) =>
      event.event === "conversation_closed" &&
      event.conversation_id === turn.conversation_id &&
      event.status === "closed" &&
      event.ts === turn.closed_at &&
      event.reason === turn.close_reason
    );
  } catch {
    return undefined;
  }
}

function explicitlyAbandonedUncertainCandidateTurnProof(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
  storeDir,
  session,
  turn,
  ledgerOverride,
  requireResolvedTopLevel = true
}: {
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
  ledgerOverride?: Record<string, any>;
  requireResolvedTopLevel?: boolean;
}): ExplicitlyAbandonedCandidateTurnProof | undefined {
  if (!hasExplicitCandidateClose(turn)) {
    return undefined;
  }
  const takeover = isRecord(turn.native_session_takeover)
    ? turn.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(turn);
  const terminalControl = ports.turn.terminalControl(takeover);
  const messageId = stringValue(submission?.message_id);
  const context: UncertainCandidateTurnContext = {
    ports,
    storeDir,
    session,
    turn,
    takeover,
    submission,
    terminalControl,
    messageId
  };
  if (!hasUncertainCandidateEnvelope(context)) {
    return undefined;
  }
  const canonical = pathsForConversation(
    turn.conversation_id,
    storeDir
  );
  if (!uncertainCandidatePathsMatch(context, canonical)) {
    return undefined;
  }
  const ledger = tryLoadAbandonmentLedger(
    ports,
    context.terminalControl,
    ledgerOverride
  );
  if (
    !ledger ||
    !ports.ledger.matchesControl(ledger, context.terminalControl) ||
    (requireResolvedTopLevel &&
      !resolvedAbandonmentLedgerMatches(ledger, context, canonical))
  ) {
    return undefined;
  }
  const receipt = uniqueAbandonmentReceipt(ledger, context.messageId);
  if (!uncertainAbandonmentReceiptMatches(receipt, context, canonical)) {
    return undefined;
  }
  const closeEvent = tryFindExplicitCloseEvent(ports, turn, canonical.logPath);
  if (!closeEvent) {
    return undefined;
  }
  // Hash the immutable close event and append-only uncertain receipt, not the
  // mutable top-level terminal ledger that the next dispatch will replace.
  return {
    turnId: turnIdForConversation(turn),
    messageId: context.messageId,
    turnFingerprint: createHash("sha256")
      .update(JSON.stringify(turn))
      .digest("hex"),
    closeEvent,
    uncertainReceipt: receipt
  };
}

function explicitlyAbandonedUncertainCandidateTurnFingerprint(ports: DeferredForegroundAuthorityAdapterPorts, args: {
  storeDir: string;
  session: ManagedSessionState;
  turn: Conversation;
}): string | undefined {
  const proof = explicitlyAbandonedUncertainCandidateTurnProof(ports, args);
  return proof
    ? terminalActionFingerprint({
        kind: "explicitly_abandoned_uncertain_codex_turn",
        source_session_id: args.session.session_id,
        source_revision: managedSessionRevision(args.session),
        source_binding_token: managedSessionBindingToken(args.session),
        turn_id: proof.turnId,
        turn_fingerprint: proof.turnFingerprint,
        close_event: proof.closeEvent,
        uncertain_receipt: proof.uncertainReceipt
      })
    : undefined;
}

export function explicitlyAbandonedCandidateSourceFingerprint(ports: DeferredForegroundAuthorityAdapterPorts, {
  storeDir,
  session,
  sourceTurnHistory,
  dispatchSnapshot,
  sourceRevision = managedSessionRevision(session),
  sourceBindingToken = managedSessionBindingToken(session),
  ledgerOverride,
  requireResolvedTopLevel = true
}: {
  storeDir: string;
  session: ManagedSessionState;
  sourceTurnHistory: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot: DeferredCodexForegroundDispatchSnapshot;
  sourceRevision?: number;
  sourceBindingToken?: string;
  ledgerOverride?: Record<string, any>;
  requireResolvedTopLevel?: boolean;
}): string | undefined {
  if (dispatchSnapshot.status !== "resolved") {
    return undefined;
  }
  const abandonedTurnProofs = ports.turn.turnsForSession(
    storeDir,
    session.session_id
  ).flatMap((turn) => {
    const proof = explicitlyAbandonedUncertainCandidateTurnProof(ports, {
        storeDir,
        session,
        turn,
        ledgerOverride,
        requireResolvedTopLevel
      });
    return proof
      ? [{
          turn_id: proof.turnId,
          message_id: proof.messageId,
          turn_fingerprint: proof.turnFingerprint,
          close_event: proof.closeEvent,
          uncertain_receipt: proof.uncertainReceipt
        }]
      : [];
  }).sort((left, right) => left.turn_id.localeCompare(right.turn_id));
  if (abandonedTurnProofs.length === 0) {
    return undefined;
  }
  return terminalActionFingerprint({
    kind: "explicitly_abandoned_codex_predecessor",
    source_session_id: session.session_id,
    source_revision: sourceRevision,
    source_binding_token: sourceBindingToken,
    source_turn_history: sourceTurnHistory,
    previous_dispatch_snapshot: dispatchSnapshot,
    abandoned_turns: abandonedTurnProofs
  });
}

export function assertFrozenExplicitlyAbandonedPredecessorAuthority(ports: DeferredForegroundAuthorityAdapterPorts, {
  storeDir,
  transfer,
  terminalControl
}: {
  storeDir: string;
  transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
}): void {
  if (
    transfer.source_rollout_authority !==
      "explicitly_abandoned_predecessor"
  ) {
    return;
  }
  const source = loadManagedSession(storeDir, transfer.source_session_id);
  const sourceAsBound: ManagedSessionState = {
    ...source,
    status: "bound",
    binding: transfer.source_before_binding,
    last_transition_id: transfer.source_previous_last_transition_id
  };
  const history = frozenCandidateSourceTurnHistory(ports, storeDir, sourceAsBound);
  const ledger = ports.ledger.load(terminalControl);
  const fingerprint = history && ledger
    ? explicitlyAbandonedCandidateSourceFingerprint(ports, {
        storeDir,
        session: sourceAsBound,
        sourceTurnHistory: history,
        dispatchSnapshot: {
          status: transfer.previous_dispatch_status,
          fingerprint: transfer.previous_dispatch_fingerprint
        },
        sourceRevision: transfer.source_expected_revision,
        sourceBindingToken: transfer.source_binding_token,
        ledgerOverride: ledger,
        requireResolvedTopLevel: false
      })
    : undefined;
  if (
    !history ||
    JSON.stringify(history) !== JSON.stringify(transfer.source_turn_history) ||
    fingerprint !== transfer.source_abandonment_fingerprint
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} lost its exact ` +
      "explicitly abandoned predecessor authority"
    );
  }
}

function candidateSourceTransitionHistoryIsTerminal(
  ports: DeferredForegroundAuthorityAdapterPorts,
  storeDir: string,
  session: ManagedSessionState
): boolean {
  if (ports.transition.hasUnresolved(storeDir, session)) {
    return false;
  }
  if (!session.last_transition_id) {
    return true;
  }
  try {
    const transition = loadNativeThreadTransition(
      storeDir,
      session.last_transition_id
    );
    return ["committed", "aborted"].includes(transition.status) &&
      (
        transition.source_session_id === session.session_id ||
        transition.target_session_id === session.session_id
      );
  } catch {
    return false;
  }
}

export function deferredCodexForegroundDispatchSnapshot(
  ports: DeferredForegroundAuthorityAdapterPorts,
  terminalControl: TerminalControlRef
): DeferredCodexForegroundDispatchSnapshot {
  const ledger = ports.ledger.load(terminalControl);
  return deferredCodexForegroundDispatchSnapshotForLedger(
    ports,
    terminalControl,
    ledger
  );
}

function deferredCodexForegroundDispatchSnapshotForLedger(
  ports: DeferredForegroundAuthorityAdapterPorts,
  terminalControl: TerminalControlRef,
  ledger: Record<string, any> | undefined
): DeferredCodexForegroundDispatchSnapshot {
  if (!ledger) {
    return {
      status: "none",
      fingerprint: terminalActionFingerprint({
        kind: "deferred_codex_foreground_terminal_dispatch",
        status: "none"
      })
    };
  }
  const currentAnchor = terminalEndpointFromControlRef(
    terminalControl
  ).processAnchorPid;
  const ledgerAnchor = ports.ledger.processAnchor(ledger);
  if (
    ledger.status !== "resolved" ||
    !Number.isSafeInteger(currentAnchor) ||
    Number(currentAnchor) < 1 ||
    ledgerAnchor !== currentAnchor ||
    !ports.ledger.matchesControl(ledger, terminalControl, {
      requireCurrentRoute: false,
      requireProcessAnchor: true
    })
  ) {
    throw new Error(
      `terminal ${terminalControl.target} does not have exact resolved ` +
      "dispatch authority"
    );
  }
  const resolvedAt = stringValue(ledger.resolved_at);
  if (!resolvedAt || !Number.isFinite(Date.parse(resolvedAt))) {
    throw new Error(
      `terminal ${terminalControl.target} resolved dispatch receipt has no ` +
      "valid resolved_at"
    );
  }
  const statePath = stringValue(ledger.state_path);
  const ledgerStoreDir = stringValue(ledger.store_dir);
  if (ledgerStoreDir && !path.isAbsolute(ledgerStoreDir)) {
    throw new Error(
      `terminal ${terminalControl.target} resolved dispatch receipt has a ` +
      "nonabsolute Store owner"
    );
  }
  if (statePath) {
    if (!ledgerStoreDir || !path.isAbsolute(statePath) ||
      !path.isAbsolute(ledgerStoreDir)) {
      throw new Error(
        `terminal ${terminalControl.target} resolved dispatch receipt has ` +
        "incomplete Store authority"
      );
    }
    const canonicalStatePath = path.resolve(statePath);
    const canonicalStoreDir = path.resolve(ledgerStoreDir);
    const canonical = pathsForConversationDir(
      path.dirname(canonicalStatePath)
    );
    if (
      path.resolve(canonical.statePath) !== canonicalStatePath ||
      path.resolve(canonical.storeDir) !== canonicalStoreDir
    ) {
      throw new Error(
        `terminal ${terminalControl.target} resolved dispatch receipt has a ` +
        "noncanonical Store/state owner"
      );
    }
    const conversationId = stringValue(ledger.conversation_id);
    if (
      conversationId &&
      path.resolve(
        pathsForConversation(conversationId, canonicalStoreDir).statePath
      ) !== canonicalStatePath
    ) {
      throw new Error(
        `terminal ${terminalControl.target} resolved dispatch receipt has a ` +
        "mismatched conversation owner"
      );
    }
  }
  return {
    status: "resolved",
    fingerprint: terminalActionFingerprint({
      kind: "deferred_codex_foreground_terminal_dispatch",
      status: "resolved",
      ledger
    })
  };
}

export function deferredCodexPreviousDispatchSnapshotMatches(ports: DeferredForegroundAuthorityAdapterPorts, {
  transfer,
  terminalControl,
  ledger
}: {
  transfer: DeferredForegroundTransfer;
  terminalControl: TerminalControlRef;
  ledger: Record<string, any> | undefined;
}): boolean {
  let snapshot: DeferredCodexForegroundDispatchSnapshot;
  try {
    snapshot = deferredCodexForegroundDispatchSnapshotForLedger(
      ports,
      terminalControl,
      ledger
    );
  } catch {
    return false;
  }
  return snapshot.status === transfer.previous_dispatch_status &&
    snapshot.fingerprint === transfer.previous_dispatch_fingerprint;
}

function tryDeferredCodexForegroundDispatchSnapshot(
  ports: DeferredForegroundAuthorityAdapterPorts,
  terminalControl: TerminalControlRef
): DeferredCodexForegroundDispatchSnapshot | undefined {
  try {
    return deferredCodexForegroundDispatchSnapshot(ports, terminalControl);
  } catch {
    return undefined;
  }
}

export type DeferredCodexAuthorityMode =
  | "list"
  | "prepare"
  | "boundary_bound"
  | "boundary_transitioning";

export interface DeferredCodexAuthorityObservation {
  sourceKind: DeferredForegroundTransferSourceKind;
  sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
  sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
  dispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
  sourceAbandonmentFingerprint?: string;
  exactSource: boolean;
}

function sourceTurnHistoryForAuthorityObservation(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
    mode,
    storeDir,
    sourceSession,
    sourceKind,
    candidateInventory
  }: {
    mode: DeferredCodexAuthorityMode;
    storeDir: string;
    sourceSession: ManagedSessionState;
    sourceKind: DeferredForegroundTransferSourceKind;
    candidateInventory?: CodexOpenRootRolloutInventory;
  }
): DeferredForegroundTransferSourceTurnAuthority[] | undefined {
  const candidateHistoryNeeded = sourceKind ===
      "candidate_rollout_quiescent" &&
    (mode !== "list" || candidateInventory !== undefined);
  if (!candidateHistoryNeeded) {
    return undefined;
  }
  return mode === "boundary_transitioning"
    ? frozenCandidateSourceTurnHistory(ports, storeDir, sourceSession)
    : deferredCandidateSourceTurnHistory(ports, storeDir, sourceSession);
}

function candidateRootIsExplicitlyAbandoned(
  sourceKind: DeferredForegroundTransferSourceKind,
  abandonment: "never" | "missing_rollout" | "missing_inventory_rollout",
  candidateInventory: CodexOpenRootRolloutInventory | undefined,
  binding: ManagedTerminalBinding
): boolean {
  if (sourceKind !== "candidate_rollout_quiescent") {
    return false;
  }
  if (abandonment !== "missing_rollout" &&
    (abandonment !== "missing_inventory_rollout" || !candidateInventory)) {
    return false;
  }
  return candidateSourceRootAuthorityMatches(
    candidateInventory?.roots ?? [],
    binding.native_thread_id,
    binding.native_process.rollout,
    "explicitly_abandoned_predecessor"
  );
}

function sourceAbandonmentFingerprintForObservation(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
    mode,
    storeDir,
    context,
    sourceSession,
    sourceRolloutAuthority,
    sourceTurnHistory,
    dispatchSnapshot,
    sourceRevision,
    sourceBindingToken
  }: {
    mode: DeferredCodexAuthorityMode;
    storeDir: string;
    context: CodexSendAuthorityContext;
    sourceSession: ManagedSessionState;
    sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
    sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
    dispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
    sourceRevision?: number;
    sourceBindingToken?: string;
  }
): string | undefined {
  if (sourceRolloutAuthority !== "explicitly_abandoned_predecessor" ||
    !sourceTurnHistory || !dispatchSnapshot) {
    return undefined;
  }
  return explicitlyAbandonedCandidateSourceFingerprint(ports, {
    storeDir,
    session: sourceSession,
    sourceTurnHistory,
    dispatchSnapshot,
    sourceRevision,
    sourceBindingToken,
    ...(mode === "boundary_transitioning"
      ? {
          ledgerOverride: ports.ledger.load(context.terminalControl),
          requireResolvedTopLevel: false
        }
      : {})
  });
}

function exactDeferredCodexSourceForObservation(
  ports: DeferredForegroundAuthorityAdapterPorts,
  {
    mode,
    storeDir,
    context,
    sourceSession,
    candidateInventory,
    sourceKind,
    sourceTurnHistory,
    sourceRolloutAuthority,
    sourceAbandonmentFingerprint,
    requireUnclaimedCandidate
  }: {
    mode: DeferredCodexAuthorityMode;
    storeDir: string;
    context: CodexSendAuthorityContext;
    sourceSession: ManagedSessionState;
    candidateInventory?: CodexOpenRootRolloutInventory;
    sourceKind: DeferredForegroundTransferSourceKind;
    sourceTurnHistory?: DeferredForegroundTransferSourceTurnAuthority[];
    sourceRolloutAuthority: DeferredForegroundTransferSourceRolloutAuthority;
    sourceAbandonmentFingerprint?: string;
    requireUnclaimedCandidate: boolean;
  }
): boolean {
  if (sourceKind === "status_card_only") {
    return Boolean(
      exactBoundCodexSendSource({
        kind: "status_card",
        sourceSession,
        context
      }) &&
      ports.turn.turnsForSession(storeDir, sourceSession.session_id).length === 0 &&
      !sourceSession.last_transition_id &&
      !ports.transition.hasAny(storeDir, sourceSession)
    );
  }
  if (!candidateInventory || !sourceTurnHistory) {
    return false;
  }
  const exactCandidate = (): boolean => exactBoundCodexSendSource({
    kind: "candidate",
    sourceSession,
    context,
    inventory: candidateInventory,
    sourceRolloutAuthority
  });
  const sourceAuthority = sourceRolloutAuthority === "present" ||
    Boolean(sourceAbandonmentFingerprint);
  if (mode === "prepare") {
    return candidateSourceTransitionHistoryIsTerminal(
      ports,
      storeDir,
      sourceSession
    ) && exactCandidate() && sourceAuthority;
  }
  return exactCandidate() && sourceAuthority &&
    (!requireUnclaimedCandidate ||
      codexCandidateInventoryHasNoOtherManagedClaim(ports, {
        storeDir,
        inventory: candidateInventory,
        sourceSessionId: sourceSession.session_id,
        includeDetached:
          sourceRolloutAuthority === "explicitly_abandoned_predecessor"
      })) &&
    candidateSourceTransitionHistoryIsTerminal(ports, storeDir, sourceSession);
}

export function observeDeferredCodexAuthority(ports: DeferredForegroundAuthorityAdapterPorts, {
  mode,
  storeDir,
  context,
  sourceSession,
  candidateInventory,
  abandonment,
  fixedSourceRolloutAuthority,
  fixedDispatchSnapshot,
  sourceRevision,
  sourceBindingToken,
  requireUnclaimedCandidate = false
}: {
  mode: DeferredCodexAuthorityMode;
  storeDir: string;
  context: CodexSendAuthorityContext;
  sourceSession?: ManagedSessionState;
  candidateInventory?: CodexOpenRootRolloutInventory;
  abandonment: "never" | "missing_rollout" | "missing_inventory_rollout";
  fixedSourceRolloutAuthority?: DeferredForegroundTransferSourceRolloutAuthority;
  fixedDispatchSnapshot?: DeferredCodexForegroundDispatchSnapshot;
  sourceRevision?: number;
  sourceBindingToken?: string;
  requireUnclaimedCandidate?: boolean;
}): DeferredCodexAuthorityObservation | undefined {
  let dispatchSnapshot = fixedDispatchSnapshot;
  if (mode === "list") {
    dispatchSnapshot = tryDeferredCodexForegroundDispatchSnapshot(
      ports,
      context.terminalControl
    );
  }
  const binding = sourceSession?.binding;
  if (!sourceSession || !binding) return undefined;
  const sourceKind: DeferredForegroundTransferSourceKind =
    binding.native_process.rollout
      ? "candidate_rollout_quiescent"
      : "status_card_only";
  const sourceTurnHistory = sourceTurnHistoryForAuthorityObservation(ports, {
    mode,
    storeDir,
    sourceSession,
    sourceKind,
    candidateInventory
  });
  if (mode === "prepare") {
    dispatchSnapshot = deferredCodexForegroundDispatchSnapshot(
      ports,
      context.terminalControl
    );
  }
  const explicitlyAbandoned = candidateRootIsExplicitlyAbandoned(
    sourceKind,
    abandonment,
    candidateInventory,
    binding
  );
  const sourceRolloutAuthority = fixedSourceRolloutAuthority ??
    (explicitlyAbandoned ? "explicitly_abandoned_predecessor" : "present");
  const sourceAbandonmentFingerprint =
    sourceAbandonmentFingerprintForObservation(ports, {
      mode,
      storeDir,
      context,
      sourceSession,
      sourceRolloutAuthority,
      sourceTurnHistory,
      dispatchSnapshot,
      sourceRevision,
      sourceBindingToken
    });
  const exactSource = exactDeferredCodexSourceForObservation(ports, {
    mode,
    storeDir,
    context,
    sourceSession,
    candidateInventory,
    sourceKind,
    sourceTurnHistory,
    sourceRolloutAuthority,
    sourceAbandonmentFingerprint,
    requireUnclaimedCandidate
  });
  return {
    sourceKind,
    sourceRolloutAuthority,
    sourceTurnHistory,
    dispatchSnapshot,
    sourceAbandonmentFingerprint,
    exactSource
  };
}

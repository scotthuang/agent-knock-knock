import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import type {
  TerminalControlEvidence,
  TerminalControlRef
} from "./terminal-control-ref.js";
import {
  sameTerminalControlIncarnation,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey
} from "./terminal-control-ref.js";
import { canonicalJson } from "./canonical-json.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export type VerifiedDeadTerminalAgentProcessProof = {
  kind: "exact_pid_absent_from_complete_process_inventory";
  agent: ExecutorKind;
  pid: number;
  process_uuid: string;
  process_birth?: string;
  conversation_id: string;
  session_id: string;
  turn_id: string;
  terminal_control: TerminalControlRef;
  terminal_endpoint: TerminalControlEvidence;
  binding_id: string;
  binding_generation: number;
  message_id: string;
  observed_at: string;
};

export type BoundTerminalAgentProcessObservation =
  | { status: "alive"; pid: number }
  | {
      status: "verified_dead";
      proof: VerifiedDeadTerminalAgentProcessProof;
    }
  | { status: "unverifiable"; reason: string };

export type VerifiedDeadAgentAuthorityDecision =
  | { status: "absent" }
  | {
      status: "valid";
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      recordedAt: string;
    }
  | { status: "invalid"; reason: string };

export type VerifiedDeadAgentAuthorityContext = {
  terminalControl: TerminalControlRef;
  conversation: {
    agent: ExecutorKind;
    conversationId: string;
    sessionId: string;
    turnId: string;
    bindingId?: string;
    bindingGeneration: number;
  };
  session?: {
    status: string;
    agent: ExecutorKind;
    workspaceMatchesConversation: boolean;
    binding?: {
      terminalControl: TerminalControlRef;
      pid: number;
      processUuid?: string;
      processBirth?: string;
      bindingId: string;
      generation: number;
    };
  };
  takeover?: {
    pid: number;
    processUuid?: string;
    processBirth?: string;
    bindingId?: string;
    bindingGeneration: number;
    messageId?: string;
  };
  submission?: {
    status?: string;
    sessionId?: string;
    turnId?: string;
    messageId?: string;
    bindingId?: string;
    bindingGeneration: number;
  };
};

export type VerifiedDeadAgentProcessDecision =
  | { status: "absent" }
  | { status: "invalid"; reason: string }
  | { status: "alive"; pid: number }
  | { status: "unverifiable"; reason: string }
  | {
      status: "verified_dead";
      proof: VerifiedDeadTerminalAgentProcessProof;
      source: "persisted" | "observation";
    };

export type VerifiedDeadAgentProcessInput = {
  persistedAuthority: VerifiedDeadAgentAuthorityDecision;
  observation?: BoundTerminalAgentProcessObservation;
};

type PersistedVerifiedDeadAgentProcessDecision = Extract<
  VerifiedDeadAgentProcessDecision,
  { status: "absent" | "invalid" | "verified_dead" }
>;

type ObservedVerifiedDeadAgentProcessDecision = Exclude<
  VerifiedDeadAgentProcessDecision,
  { status: "absent" }
>;

type FreshVerifiedDeadAgentProcessDecision = Exclude<
  ObservedVerifiedDeadAgentProcessDecision,
  { status: "invalid" }
>;

export type AcceptedTurnDeadAgentStallInput = {
  conversationStatus: string;
  terminalBridge: boolean;
  messageId?: string;
  submissionStatus?: string;
  submissionMessageId?: string;
  deferredTransferId?: string;
  deferredTransferStatus?: string;
};

export type AcceptedTurnDeadAgentStallDecision =
  | { status: "applicable" }
  | { status: "not_applicable" }
  | { status: "requires_deferred_transfer"; transferId: string };

export type VerifiedDeadAgentCompletionObservation<T> =
  | { status: "present"; completion: T }
  | { status: "absent" }
  | { status: "unverifiable"; reason: string };

export type VerifiedDeadAgentCompletionDecision<T> =
  | { action: "complete"; completion: T }
  | {
      action: "stall";
      completionObservation: "absent" | "unverifiable";
      resultReason:
        | "bound_agent_process_verified_dead"
        | "bound_agent_process_verified_dead_completion_unverifiable";
    };

type EventRecord = Readonly<Record<string, unknown>>;

type VerifiedDeadAgentEventSelection =
  | { status: "absent" }
  | {
      status: "candidate";
      proof: VerifiedDeadTerminalAgentProcessProof;
      evidenceId: string;
      recordedAt: string;
    }
  | { status: "invalid"; reason: string };

export function isVerifiedDeadAgentProcessDisposition(
  disposition: unknown
): boolean {
  return isRecord(disposition) && disposition.status === "verified_dead";
}

export function verifiedDeadTerminalAgentProcessEvidenceId(
  proof: VerifiedDeadTerminalAgentProcessProof
): string {
  return createHash("sha256")
    .update(canonicalJson({
      kind: proof.kind,
      agent: proof.agent,
      pid: proof.pid,
      process_uuid: proof.process_uuid,
      process_birth: proof.process_birth ?? null,
      conversation_id: proof.conversation_id,
      session_id: proof.session_id,
      turn_id: proof.turn_id,
      terminal_endpoint: proof.terminal_endpoint,
      binding_id: proof.binding_id,
      binding_generation: proof.binding_generation,
      message_id: proof.message_id
    }))
    .digest("hex");
}

export function validateStoredVerifiedDeadAgentAuthority({
  disposition,
  context
}: {
  disposition: unknown;
  context: VerifiedDeadAgentAuthorityContext;
}): VerifiedDeadAgentAuthorityDecision {
  if (!isVerifiedDeadAgentProcessDisposition(disposition)) {
    return { status: "absent" };
  }
  const proof = isRecord(disposition) && isRecord(disposition.proof)
    ? disposition.proof
    : undefined;
  const evidenceId = isRecord(disposition)
    ? stringValue(disposition.evidence_id)
    : undefined;
  const recordedAt = isRecord(disposition)
    ? stringValue(disposition.recorded_at)
    : undefined;
  return validateVerifiedDeadAgentEvidence({
    proof,
    evidenceId,
    recordedAt,
    context
  });
}

export function selectVerifiedDeadAgentEvent({
  events,
  conversationId
}: {
  events: readonly EventRecord[];
  conversationId: string;
}): VerifiedDeadAgentEventSelection {
  const candidates = events.filter((event) =>
    event.event === "terminal_agent_process_verified_dead" &&
    event.conversation_id === conversationId
  );
  if (candidates.length === 0) {
    return { status: "absent" };
  }
  if (candidates.length !== 1) {
    return {
      status: "invalid",
      reason: "the process-death event history is ambiguous"
    };
  }
  const event = candidates[0];
  const proof = isRecord(event.proof)
    ? event.proof as unknown as VerifiedDeadTerminalAgentProcessProof
    : undefined;
  const evidenceId = stringValue(event.evidence_id);
  const recordedAt = stringValue(event.ts);
  if (
    !proof ||
    !evidenceId ||
    !recordedAt ||
    proof.observed_at !== recordedAt ||
    verifiedDeadTerminalAgentProcessEvidenceId(proof) !== evidenceId
  ) {
    return {
      status: "invalid",
      reason: "the process-death event proof is malformed"
    };
  }
  return {
    status: "candidate",
    proof,
    evidenceId,
    recordedAt
  };
}

export function validateVerifiedDeadAgentEventAuthority({
  candidate,
  context
}: {
  candidate: Extract<VerifiedDeadAgentEventSelection, { status: "candidate" }>;
  context: VerifiedDeadAgentAuthorityContext;
}): VerifiedDeadAgentAuthorityDecision {
  return validateVerifiedDeadAgentEvidence({
    proof: candidate.proof,
    evidenceId: candidate.evidenceId,
    recordedAt: candidate.recordedAt,
    context
  });
}

export function reconcileVerifiedDeadAgentAuthority({
  stored,
  event
}: {
  stored: VerifiedDeadAgentAuthorityDecision;
  event: VerifiedDeadAgentAuthorityDecision;
}): VerifiedDeadAgentAuthorityDecision {
  if (stored.status === "invalid") {
    return stored;
  }
  if (stored.status === "absent") {
    return event;
  }
  if (
    event.status !== "valid" ||
    event.evidenceId !== stored.evidenceId ||
    canonicalJson(event.proof) !== canonicalJson(stored.proof)
  ) {
    return {
      status: "invalid",
      reason:
        "the persisted process-death disposition has no exact append-only event"
    };
  }
  return stored;
}

export function decideVerifiedDeadAgentProcess(input: {
  persistedAuthority: VerifiedDeadAgentAuthorityDecision;
  observation?: undefined;
}): PersistedVerifiedDeadAgentProcessDecision;
export function decideVerifiedDeadAgentProcess(input: {
  persistedAuthority: { status: "absent" };
  observation: BoundTerminalAgentProcessObservation;
}): FreshVerifiedDeadAgentProcessDecision;
export function decideVerifiedDeadAgentProcess(input: {
  persistedAuthority: VerifiedDeadAgentAuthorityDecision;
  observation: BoundTerminalAgentProcessObservation;
}): ObservedVerifiedDeadAgentProcessDecision;
export function decideVerifiedDeadAgentProcess(
  input: VerifiedDeadAgentProcessInput
): VerifiedDeadAgentProcessDecision;
export function decideVerifiedDeadAgentProcess({
  persistedAuthority,
  observation
}: VerifiedDeadAgentProcessInput): VerifiedDeadAgentProcessDecision {
  if (persistedAuthority.status === "invalid") {
    return persistedAuthority;
  }
  if (persistedAuthority.status === "valid") {
    return {
      status: "verified_dead",
      proof: persistedAuthority.proof,
      source: "persisted"
    };
  }
  if (!observation) {
    return { status: "absent" };
  }
  if (observation.status === "verified_dead") {
    return {
      status: "verified_dead",
      proof: observation.proof,
      source: "observation"
    };
  }
  return observation;
}

export function decideAcceptedTurnDeadAgentStall(
  input: AcceptedTurnDeadAgentStallInput
): AcceptedTurnDeadAgentStallDecision {
  if (
    input.conversationStatus !== "waiting_for_agent" ||
    input.terminalBridge !== true ||
    !input.messageId ||
    input.submissionStatus !== "agent_accepted" ||
    input.submissionMessageId !== input.messageId
  ) {
    return { status: "not_applicable" };
  }
  if (!input.deferredTransferId) {
    return { status: "applicable" };
  }
  if (input.deferredTransferStatus === undefined) {
    return {
      status: "requires_deferred_transfer",
      transferId: input.deferredTransferId
    };
  }
  return input.deferredTransferStatus === "resolved"
    ? { status: "applicable" }
    : { status: "not_applicable" };
}

export function decideVerifiedDeadAgentCompletion<T>(
  observation: VerifiedDeadAgentCompletionObservation<T>
): VerifiedDeadAgentCompletionDecision<T> {
  if (observation.status === "present") {
    return { action: "complete", completion: observation.completion };
  }
  return observation.status === "unverifiable"
    ? {
        action: "stall",
        completionObservation: "unverifiable",
        resultReason:
          "bound_agent_process_verified_dead_completion_unverifiable"
      }
    : {
        action: "stall",
        completionObservation: "absent",
        resultReason: "bound_agent_process_verified_dead"
      };
}

function validateVerifiedDeadAgentEvidence({
  proof,
  evidenceId,
  recordedAt,
  context
}: {
  proof: unknown;
  evidenceId?: string;
  recordedAt?: string;
  context: VerifiedDeadAgentAuthorityContext;
}): VerifiedDeadAgentAuthorityDecision {
  const candidate = isRecord(proof)
    ? proof as unknown as VerifiedDeadTerminalAgentProcessProof
    : undefined;
  const session = context.session;
  const binding = session?.binding;
  const takeover = context.takeover;
  const submission = context.submission;
  if (
    !candidate ||
    candidate.kind !==
      "exact_pid_absent_from_complete_process_inventory" ||
    !session ||
    session.status !== "bound" ||
    !binding ||
    candidate.agent !== session.agent ||
    session.agent !== context.conversation.agent ||
    !session.workspaceMatchesConversation ||
    candidate.pid !== takeover?.pid ||
    candidate.pid !== binding.pid ||
    candidate.process_uuid !== takeover?.processUuid ||
    candidate.process_uuid !== binding.processUuid ||
    (candidate.process_birth ?? undefined) !==
      (takeover?.processBirth ?? undefined) ||
    (candidate.process_birth ?? undefined) !==
      (binding.processBirth ?? undefined) ||
    candidate.conversation_id !== context.conversation.conversationId ||
    candidate.session_id !== context.conversation.sessionId ||
    candidate.turn_id !== context.conversation.turnId ||
    candidate.binding_id !== context.conversation.bindingId ||
    candidate.binding_id !== binding.bindingId ||
    candidate.binding_generation !==
      context.conversation.bindingGeneration ||
    candidate.binding_generation !== binding.generation ||
    !terminalControlsShareIncarnation(
      binding.terminalControl,
      context.terminalControl
    ) ||
    candidate.binding_id !== takeover?.bindingId ||
    candidate.binding_generation !== takeover?.bindingGeneration ||
    candidate.message_id !== takeover?.messageId ||
    candidate.message_id !== submission?.messageId ||
    submission?.status !== "agent_accepted" ||
    submission.sessionId !== candidate.session_id ||
    submission.turnId !== candidate.turn_id ||
    submission.bindingId !== candidate.binding_id ||
    submission.bindingGeneration !== candidate.binding_generation ||
    !isRecord(candidate.terminal_control) ||
    !terminalControlsShareIncarnation(
      candidate.terminal_control,
      context.terminalControl
    ) ||
    !terminalControlEvidenceMatches(
      candidate.terminal_endpoint,
      context.terminalControl,
      { requireProcessAnchor: true }
    ) ||
    Number(candidate.terminal_endpoint.process_anchor_pid) !==
      terminalEndpointFromControlRef(context.terminalControl).processAnchorPid ||
    validTimestampMs(candidate.observed_at) === undefined ||
    !recordedAt ||
    validTimestampMs(recordedAt) === undefined ||
    recordedAt !== candidate.observed_at ||
    !evidenceId ||
    evidenceId !== verifiedDeadTerminalAgentProcessEvidenceId(candidate)
  ) {
    return {
      status: "invalid",
      reason:
        "the persisted process-death proof no longer matches the exact Turn, Session, terminal, or submission binding"
    };
  }
  return {
    status: "valid",
    proof: candidate,
    evidenceId,
    recordedAt
  };
}

function terminalControlsShareIncarnation(
  left: unknown,
  right: unknown
): boolean {
  if (
    !terminalControlIncarnationSelectorKey(left) ||
    !terminalControlIncarnationSelectorKey(right)
  ) {
    return false;
  }
  return sameTerminalControlIncarnation(
    left as TerminalControlRef,
    right as TerminalControlRef
  );
}

function terminalControlIncarnationSelectorKey(
  value: unknown
): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    const endpoint = terminalEndpointFromControlRef(
      value as unknown as TerminalControlRef
    );
    const processAnchorPid = Number(endpoint.processAnchorPid);
    if (!Number.isSafeInteger(processAnchorPid) || processAnchorPid <= 1) {
      return undefined;
    }
    return JSON.stringify({
      identity: terminalEndpointIdentityKey(endpoint),
      process_anchor_pid: processAnchorPid
    });
  } catch {
    return undefined;
  }
}

function validTimestampMs(value: unknown): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

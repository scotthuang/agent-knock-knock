import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import {
  decideTerminalMonitorTimeout,
  reduceTerminalMonitorActivityPoll,
  reduceTerminalMonitorCompletionPoll,
  type TerminalMonitorActivityPollInput,
  type TerminalMonitorCompletionPollInput,
  type TerminalMonitorPollState,
  type TerminalMonitorTimeoutInput,
  type TerminalMonitorTimeoutDecision
} from "./terminal-monitor-poll-policy.js";
import {
  decideVerifiedDeadAgentCompletion,
  type VerifiedDeadAgentCompletionObservation
} from "./verified-dead-agent-policy.js";
import {
  terminalEndpointFromControlRef,
  terminalEndpointIdentityKey
} from "./terminal-control-ref.js";
import { isRecord, nonBlankString } from "./value-guards.js";

interface TerminalApprovalTranscriptIdentity {
  requestId: string;
  evidenceFingerprint: string;
}

type TerminalMonitorApprovalSuppression =
  | { kind: "screen_not_new" }
  | {
      kind: "consumed_screen";
      reason:
        | "same_transcript_request"
        | "same_unrepainted_screen"
        | "legacy_consumed_approval"
        | "prompt_not_observed_cleared";
      fingerprint?: string;
      screenDigest?: string;
    };

export interface TerminalMonitorApprovalInput {
  executorKind: ExecutorKind;
  executorDisplayName: string;
  terminalReachable: boolean;
  approval: unknown;
  nativeTakeover: unknown;
  currentMessageId?: string;
  currentScreenFingerprint?: string;
  currentScreenChangedSinceSend: boolean;
  observedFingerprint?: string;
  transcriptIdentity?: TerminalApprovalTranscriptIdentity;
}

/** Decide approval prompt clearing, suppression, question, and error routing. */
export function decideTerminalMonitorApproval(
  input: TerminalMonitorApprovalInput
) {
  const approval = isRecord(input.approval) ? input.approval : {};
  const takeover = isRecord(input.nativeTakeover) ? input.nativeTakeover : {};
  const messageMatches =
    input.currentMessageId !== undefined &&
    input.currentMessageId === nonBlankString(
      takeover.terminal_bridge_last_approval_message_id
    );
  const claudePermissionVisible =
    input.executorKind === "claude" &&
    approval.blocked === true &&
    approval.prompt_kind === "claude_permission";
  const markPromptCleared =
    input.executorKind === "claude" &&
    input.terminalReachable &&
    approval.scanned === true &&
    !claudePermissionVisible &&
    messageMatches &&
    validTerminalMonitorTimestampMs(
      takeover.terminal_bridge_last_approval_prompt_cleared_at
    ) === undefined &&
    validTerminalMonitorTimestampMs(
      takeover.terminal_bridge_approval_resolved_at
    ) !== undefined;
  const suppressions: TerminalMonitorApprovalSuppression[] = [];
  if (
    input.executorKind === "claude" &&
    approval.approvable === true &&
    approval.decision_mode === "keys" &&
    !input.currentScreenChangedSinceSend
  ) {
    suppressions.push({ kind: "screen_not_new" });
  }
  if (claudePermissionVisible) {
    const consumed = consumedApprovalSuppression({
      input,
      takeover,
      messageMatches
    });
    if (consumed) {
      suppressions.push(consumed);
    }
  }
  if (suppressions.length > 0 || approval.blocked !== true) {
    return { markPromptCleared, suppressions, notification: { kind: "none" } };
  }
  const evidenceUnavailable =
    approval.approvable === true &&
    (nonBlankString(approval.decision_mode) ?? "keys") === "keys" &&
    !nonBlankString(approval.fingerprint);
  if (approval.approvable !== true || evidenceUnavailable) {
    return {
      markPromptCleared,
      suppressions,
      notification: {
        kind: "error",
        reason: evidenceUnavailable
          ? `${input.executorDisplayName} approval prompt lacks exact prompt-region evidence`
          : nonBlankString(approval.reason) ??
            "Claude Code permission state cannot be safely resolved through AKK"
      }
    };
  }
  return { markPromptCleared, suppressions, notification: { kind: "question" } };
}

export function terminalMonitorApprovalEffectOrder(
  kind: "question" | "error"
): readonly ["fingerprint" | "event", "fingerprint" | "event", "record"] {
  return kind === "question"
    ? ["fingerprint", "event", "record"]
    : ["event", "fingerprint", "record"];
}

function consumedApprovalSuppression(input: {
  input: TerminalMonitorApprovalInput;
  takeover: Record<string, unknown>;
  messageMatches: boolean;
}): Exclude<TerminalMonitorApprovalSuppression, { kind: "screen_not_new" }> | undefined {
  const lastRequestId = nonBlankString(
    input.takeover.terminal_bridge_last_approval_request_id
  );
  const lastEvidence = nonBlankString(
    input.takeover.terminal_bridge_last_approval_evidence_fingerprint
  );
  const lastScreenDigest = nonBlankString(
    input.takeover.terminal_bridge_last_approval_screen_digest
  );
  const lastFingerprint = nonBlankString(
    input.takeover.terminal_bridge_last_approval_fingerprint
  );
  const promptCleared = validTerminalMonitorTimestampMs(
    input.takeover.terminal_bridge_last_approval_prompt_cleared_at
  ) !== undefined;
  const sameTranscript =
    input.messageMatches &&
    input.input.transcriptIdentity !== undefined &&
    (input.input.transcriptIdentity.requestId === lastRequestId ||
      input.input.transcriptIdentity.evidenceFingerprint === lastEvidence);
  const sameScreen =
    input.messageMatches &&
    input.input.transcriptIdentity === undefined &&
    !promptCleared &&
    lastScreenDigest !== undefined &&
    input.input.currentScreenFingerprint === lastScreenDigest;
  const unclearedFingerprint =
    input.messageMatches &&
    input.input.transcriptIdentity === undefined &&
    !promptCleared &&
    lastFingerprint !== undefined;
  const legacy =
    input.messageMatches &&
    lastRequestId === undefined &&
    lastEvidence === undefined &&
    !promptCleared &&
    (sameScreen || input.input.observedFingerprint === lastFingerprint);
  if (!sameTranscript && !sameScreen && !unclearedFingerprint && !legacy) {
    return undefined;
  }
  return {
    kind: "consumed_screen",
    reason: sameTranscript
      ? "same_transcript_request"
      : sameScreen
        ? "same_unrepainted_screen"
        : legacy
          ? "legacy_consumed_approval"
          : "prompt_not_observed_cleared",
    fingerprint: input.input.observedFingerprint,
    screenDigest: input.input.currentScreenFingerprint
  };
}

export type TerminalMonitorNextAction =
  | { kind: "complete"; completionFingerprint: string }
  | { kind: "verify_dead" }
  | { kind: "check_timeout" };

export type TerminalMonitorTimeoutAction =
  | { kind: "hard_timeout"; deadlineAtMs: number }
  | { kind: "inactivity_timeout"; deadlineAtMs: number }
  | { kind: "poll" };

export type TerminalMonitorPollDecisionInput =
  TerminalMonitorActivityPollInput &
  Omit<TerminalMonitorCompletionPollInput, "state">;

/** Preserve activity -> stable completion -> verified death -> timeout order. */
export function reduceTerminalMonitorDecision(
  input: TerminalMonitorPollDecisionInput
) {
  const activity = reduceTerminalMonitorActivityPoll(input);
  const completion = reduceTerminalMonitorCompletionPoll({
    state: activity.state,
    completionPresent: input.completionPresent,
    completionFingerprint: input.completionFingerprint
  });
  const next = completion.completionStable && input.completionFingerprint
    ? {
        kind: "complete" as const,
        completionFingerprint: input.completionFingerprint
      }
    : completion.checkVerifiedDeadAgent
      ? { kind: "verify_dead" as const }
      : { kind: "check_timeout" as const };
  return { state: completion.state, activity, next };
}

export function decideTerminalMonitorAfterEffectsTimeout(
  input: TerminalMonitorTimeoutInput
): TerminalMonitorTimeoutAction {
  const decision: TerminalMonitorTimeoutDecision =
    decideTerminalMonitorTimeout(input);
  if (decision.kind === "hard") {
    return { kind: "hard_timeout", deadlineAtMs: decision.deadlineAtMs };
  }
  if (decision.kind === "inactivity") {
    return { kind: "inactivity_timeout", deadlineAtMs: decision.deadlineAtMs };
  }
  return { kind: "poll" };
}

export function decideTerminalMonitorVerifiedDeadCompletion<T>(
  observation: VerifiedDeadAgentCompletionObservation<T>
) {
  return decideVerifiedDeadAgentCompletion(observation);
}

export function terminalMonitorActivityPersistIntervalMs(
  timeoutMinutes: number,
  pollIntervalMs: number
): number {
  return !Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0
    ? 5 * 60 * 1000
    : Math.max(pollIntervalMs, Math.min(timeoutMinutes * 30 * 1000, 5 * 60 * 1000));
}

export function validTerminalMonitorTimestampMs(
  value: unknown
): number | undefined {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function terminalMonitorDeadlineAt(
  startedAt: unknown,
  timeoutMinutes: number
): string | undefined {
  const startedAtMs = validTerminalMonitorTimestampMs(startedAt);
  return startedAtMs !== undefined && Number.isFinite(timeoutMinutes) && timeoutMinutes > 0
    ? new Date(startedAtMs + timeoutMinutes * 60 * 1000).toISOString()
    : undefined;
}

export function terminalMonitorActivityFingerprint(
  value: unknown
): string | undefined {
  const text = nonBlankString(value);
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

export function terminalMonitorScreenFingerprint(
  value: unknown
): string | undefined {
  return typeof value === "string"
    ? createHash("sha256").update(value).digest("hex")
    : undefined;
}

export function terminalMonitorApprovalFingerprint(input: {
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
}): string | undefined {
  const approval: Record<string, unknown> =
    isRecord(input.terminalStatus?.approval_state)
    ? input.terminalStatus.approval_state as Record<string, unknown>
    : {};
  const adapterFingerprint = nonBlankString(approval.fingerprint);
  if (adapterFingerprint) {
    return adapterFingerprint;
  }
  if (
    approval.approvable === true &&
    (nonBlankString(approval.decision_mode) ?? "keys") === "keys"
  ) {
    return undefined;
  }
  const endpoint = terminalEndpointFromControlRef(input.terminalControl);
  const processAnchorPid = Number(endpoint.processAnchorPid);
  if (!Number.isSafeInteger(processAnchorPid) || processAnchorPid <= 1) {
    throw new Error(
      "terminal approval fingerprint requires a stable process anchor"
    );
  }
  return createHash("sha256")
    .update(JSON.stringify({
      terminal_identity: terminalEndpointIdentityKey(endpoint),
      process_anchor_pid: processAnchorPid,
      keys: approval.keys ?? (approval.key ? [approval.key] : undefined),
      label: approval.label,
      prompt_kind: approval.prompt_kind,
      command: approval.command,
      tool_name: approval.tool_name,
      request_detail: approval.request_detail,
      excerpt: isRecord(input.terminalStatus?.screen)
        ? input.terminalStatus.screen.excerpt
        : undefined
    }))
    .digest("hex");
}

export function terminalMonitorApprovalCandidate(input: {
  executorKind: ExecutorKind;
  terminalControl: TerminalControlRef;
  terminalStatus: TerminalBridgeStatus;
  fingerprint?: string;
}): Record<string, unknown> | undefined {
  const approval: Record<string, unknown> =
    isRecord(input.terminalStatus?.approval_state)
    ? input.terminalStatus.approval_state as Record<string, unknown>
    : {};
  if (approval.approvable !== true) {
    return undefined;
  }
  const evidence = isRecord(approval.policy_evidence)
    ? approval.policy_evidence
    : undefined;
  const localClaudeEvidence =
    input.executorKind === "claude" &&
    evidence?.source === "claude_transcript" &&
    evidence.kind === "run_command";
  return {
    agent: input.executorKind,
    kind: localClaudeEvidence
      ? "run_command"
      : nonBlankString(approval.prompt_kind) ?? "unknown",
    command: localClaudeEvidence ? undefined : nonBlankString(approval.command),
    tool_name: nonBlankString(approval.tool_name),
    request_detail: nonBlankString(approval.request_detail),
    cwd: nonBlankString(approval.cwd) ?? input.terminalControl.currentPath,
    fingerprint: input.fingerprint,
    terminal_target: input.terminalControl.target,
    decision_mode: nonBlankString(approval.decision_mode),
    ...(localClaudeEvidence ? {
      command_source: "executor_local",
      policy_evidence: {
        source: "claude_transcript",
        kind: "run_command",
        command_sha256: nonBlankString(evidence.command_sha256),
        evidence_fingerprint: nonBlankString(evidence.evidence_fingerprint),
        request_id: nonBlankString(evidence.request_id)
      }
    } : {})
  };
}

export function claudeTranscriptApprovalIdentity(
  approvalState: unknown
): TerminalApprovalTranscriptIdentity | undefined {
  const approval = isRecord(approvalState) ? approvalState : undefined;
  const evidence = isRecord(approval?.policy_evidence)
    ? approval.policy_evidence
    : undefined;
  const requestId = nonBlankString(evidence?.request_id);
  const evidenceFingerprint = nonBlankString(evidence?.evidence_fingerprint);
  if (
    evidence?.source !== "claude_transcript" ||
    evidence.kind !== "run_command" ||
    !requestId ||
    !evidenceFingerprint ||
    !/^[0-9a-f]{64}$/u.test(evidenceFingerprint)
  ) {
    return undefined;
  }
  return { requestId, evidenceFingerprint };
}

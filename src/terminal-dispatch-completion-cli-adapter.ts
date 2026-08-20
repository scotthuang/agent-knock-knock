import type {
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest
} from "./terminal-agent-adapter.js";
import { terminalBridgeSubmission } from "./terminal-dispatch-receipt.js";
import {
  detectCodexBoundRolloutCompletion,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export type TerminalCompletionTurn = Readonly<Record<string, unknown>>;

export interface TerminalDispatchCompletionEnvironment {
  syntheticTerminalAcceptanceAllowed(): boolean;
}

export interface ExactBoundCodexCompletionInput {
  conversation: TerminalCompletionTurn;
  nativeTakeover?: Readonly<Record<string, unknown>>;
  request: TerminalDurableCompletionRequest;
  runtime?: Readonly<Record<string, unknown>>;
}

export interface TerminalDispatchCompletionCliAdapter {
  requiresExactBoundCodexCompletion(conversation: TerminalCompletionTurn): boolean;
  detectExactBoundCodexCompletion(input: ExactBoundCodexCompletionInput): {
    handled: boolean;
    completion?: TerminalCompletionEvidence;
  };
}

/** Keep exact-rollout completion policy behind one command-scoped boundary. */
export function createTerminalDispatchCompletionCliAdapter(input: {
  environment: TerminalDispatchCompletionEnvironment;
}): TerminalDispatchCompletionCliAdapter {
  const requiresExactBoundCodexCompletion = (
    conversation: TerminalCompletionTurn
  ) => requiresExactBound(input.environment, conversation);
  return Object.freeze({
    requiresExactBoundCodexCompletion,
    detectExactBoundCodexCompletion: (request: ExactBoundCodexCompletionInput) =>
      detectExactBound(request, requiresExactBoundCodexCompletion)
  });
}

function requiresExactBound(
  environment: TerminalDispatchCompletionEnvironment,
  conversation: TerminalCompletionTurn
): boolean {
  const submission = terminalBridgeSubmission(conversation);
  if (submission?.status !== "agent_accepted") {
    return false;
  }
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const modernProductionTurn =
    Number(nativeTakeover?.terminal_agent_identity_protocol) === 1 &&
    !environment.syntheticTerminalAcceptanceAllowed();
  if (modernProductionTurn) {
    return true;
  }
  return isRecord(nativeTakeover?.codex_rollout_acceptance_anchor) &&
    isRecord(submission.acceptance_evidence) &&
    submission.acceptance_evidence.source === "codex_rollout";
}

function detectExactBound(
  input: ExactBoundCodexCompletionInput,
  requiresExactBoundCodexCompletion: (
    conversation: TerminalCompletionTurn
  ) => boolean
): { handled: boolean; completion?: TerminalCompletionEvidence } {
  const submission = terminalBridgeSubmission(input.conversation);
  if (submission?.status !== "agent_accepted") {
    return { handled: false };
  }
  if (!requiresExactBoundCodexCompletion(input.conversation)) {
    return { handled: false };
  }
  const acceptanceEvidence = isRecord(submission.acceptance_evidence)
    ? submission.acceptance_evidence
    : undefined;
  if (acceptanceEvidence?.source !== "codex_rollout") {
    throw new Error(
      "[codex_exact_bound_rollout:invalid_acceptance_evidence] " +
      "the accepted modern Codex Turn has no exact rollout acceptance evidence"
    );
  }
  const anchor = isRecord(input.nativeTakeover?.codex_rollout_acceptance_anchor)
    ? input.nativeTakeover.codex_rollout_acceptance_anchor
    : undefined;
  if (!anchor) {
    throw new Error(
      "[codex_exact_bound_rollout:invalid_anchor] " +
      "the accepted modern Codex Turn has no exact rollout byte anchor"
    );
  }
  return exactBoundResult(input, anchor, acceptanceEvidence);
}

function exactBoundResult(
  input: ExactBoundCodexCompletionInput,
  anchor: Readonly<Record<string, unknown>>,
  acceptanceEvidence: Readonly<Record<string, unknown>>
): { handled: boolean; completion?: TerminalCompletionEvidence } {
  const nativeRollout = isRecord(input.runtime?.nativeRollout)
    ? input.runtime.nativeRollout
    : undefined;
  const result = detectCodexBoundRolloutCompletion({
    anchor: anchor as unknown as CodexRolloutAcceptanceAnchor,
    acceptanceEvidence:
      acceptanceEvidence as unknown as TerminalSubmissionAcceptanceEvidence,
    currentIdentity: {
      sessionId:
        nonBlankString(input.runtime?.nativeSessionId) ??
        nonBlankString(input.runtime?.sessionId) ??
        "",
      processUuid: nonBlankString(input.runtime?.nativeProcessUuid),
      processBirth: nonBlankString(input.runtime?.nativeProcessBirth),
      ...(nativeRollout ? { rollout: {
        fd: String(nativeRollout.fd ?? ""),
        device: String(nativeRollout.device ?? ""),
        inode: String(nativeRollout.inode ?? ""),
        path: String(nativeRollout.path ?? "")
      } } : {})
    },
    requestHash:
      nonBlankString(input.request.requestHash) ??
      nonBlankString(input.nativeTakeover?.terminal_bridge_request_hash) ??
      ""
  });
  if (result.status === "failure") {
    throw new Error(
      `[codex_exact_bound_rollout:${result.diagnostics.code}] ${
        result.diagnostics.detail ??
        "the exact bound rollout is not safely inspectable"
      }`
    );
  }
  if (result.status === "pending") {
    return { handled: true };
  }
  return {
    handled: true,
    completion: {
      ...result.completion,
      metadata: {
        ...result.completion.metadata,
        context_match: "exact_bound_rollout",
        detector_code: result.diagnostics.code
      }
    }
  };
}

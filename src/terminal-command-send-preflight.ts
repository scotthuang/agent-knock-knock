import type { Conversation } from "./protocol.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import type {
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import {
  nativeIdentityMatchesCodexPreMaterialization,
  type CodexPreMaterializationIdentity
} from "./terminal-authority-policy.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import type {
  TerminalControlSendRequest,
  TerminalDispatchTerminal
} from "./terminal-dispatch-composition.js";
import type { TerminalDispatchExecutionService } from
  "./terminal-dispatch-execution.js";
import { decideUserExplicitTerminalInputSafety } from
  "./terminal-dispatch-policy.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface TerminalSendPreflightPorts {
  assertSafeTerminalSend(
    agent: TerminalControlSendRequest["executor"]["kind"],
    status: TerminalBridgeStatus
  ): void;
  terminalRuntimeForLiveIdentity(request: {
    terminal: TerminalDispatchTerminal;
    identity?: NativeAgentSessionIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  terminalRuntimeIdentityForConversation(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): TerminalRuntimeIdentity;
}

/**
 * Shared physical-input safety check for the human-priority Send path.
 * Human intent may relax lifecycle attribution, never approval/questionnaire
 * exclusion or terminal reachability.
 */
export function assertSafeUserExplicitTerminalSend(
  status: TerminalBridgeStatus | undefined
): void {
  const approval = status && isRecord(status.approval_state)
    ? status.approval_state
    : undefined;
  const decision = decideUserExplicitTerminalInputSafety({
    reachable: status?.reachable === true,
    approvalScanned: approval?.scanned === true,
    approvalBlocked: approval?.blocked === true,
    approvalReason: nonBlankString(approval?.reason),
    awaitingApproval: status?.activity_state === "awaiting_approval",
    questionnaireActive: status?.interaction_state !== undefined
  });
  if (decision.action === "reject") {
    throw new Error(decision.reason);
  }
}

export function terminalSendCandidateAcceptanceAnchor(
  request: TerminalControlSendRequest
) {
  return request.deferredCodexForegroundBinding?.candidateAcceptanceAnchor ??
    request.postSendCodexCandidateAnchor;
}

export function assertTerminalNativeBindingBeforeSend(input: {
  execution: TerminalDispatchExecutionService;
  conversation: Conversation;
  currentNativeIdentity?: NativeAgentSessionIdentity;
  needsPostSendNativeBinding: boolean;
  allowedPreMaterializationIdentity?: CodexPreMaterializationIdentity;
}): void {
  if (!input.needsPostSendNativeBinding) {
    input.execution.assertTurnIdentity({
      conversation: input.conversation,
      currentIdentity: input.currentNativeIdentity,
      operation: "send to"
    });
    return;
  }
  if (
    input.currentNativeIdentity &&
    !nativeIdentityMatchesCodexPreMaterialization(
      input.currentNativeIdentity,
      input.allowedPreMaterializationIdentity
    )
  ) {
    throw new Error(
      "native agent session appeared while preparing an unmaterialized terminal binding; refresh list and retry"
    );
  }
}

/** Build the single immutable runtime identity used by pre-send observation. */
export function terminalPreSendRuntime(
  input: {
    request: TerminalControlSendRequest;
    terminalControl: TerminalControlRef;
    terminalAgentPid: number;
  },
  ports: Pick<
    TerminalSendPreflightPorts,
    "terminalRuntimeForLiveIdentity" |
      "terminalRuntimeIdentityForConversation"
  >
): TerminalRuntimeIdentity {
  const { request, terminalControl, terminalAgentPid } = input;
  const {
    conversation,
    nextConversation,
    executor,
    message,
    allowedPreMaterializationIdentity,
    allowedAdditionalIdentities = [],
    deferredCodexForegroundBinding
  } = request;
  const candidateAnchor = terminalSendCandidateAcceptanceAnchor(request);
  return {
    ...(candidateAnchor
      ? ports.terminalRuntimeForLiveIdentity({
          terminal: deferredCodexForegroundBinding?.terminal ?? {
            conversationId: conversation.conversation_id,
            agent: executor.kind,
            pid: terminalAgentPid,
            terminalControl
          },
          physicalOnly: true
        })
      : ports.terminalRuntimeIdentityForConversation(
          nextConversation,
          terminalControl
        )),
    allowedPreMaterializationNativeIdentity:
      allowedPreMaterializationIdentity,
    allowedAdditionalNativeIdentities: allowedAdditionalIdentities,
    messageId: message.id
  };
}

export function assertTerminalPreSendStatus(
  input: {
    request: TerminalControlSendRequest;
    status: TerminalBridgeStatus;
  },
  ports: Pick<TerminalSendPreflightPorts, "assertSafeTerminalSend">
): void {
  const { request, status } = input;
  if (nonBlankString(request.options.expectedUserExplicitTerminalToken)) {
    assertSafeUserExplicitTerminalSend(status);
  }
  const deferredCodexPrompt = Boolean(
    request.verifiedEmptyCodexHandoff ||
    request.deferredCodexForegroundBinding ||
    request.postSendCodexCandidateAnchor
  );
  if (!deferredCodexPrompt) {
    ports.assertSafeTerminalSend(request.executor.kind, status);
    return;
  }
  if (
    request.executor.kind !== "codex" ||
    status.reachable !== true ||
    status.approval_state.blocked === true ||
    status.interaction_state !== undefined ||
    !["idle", "unknown"].includes(status.activity_state)
  ) {
    throw new Error(
      `Codex deferred foreground send is not at a safe prompt ` +
      `(${status.activity_state}: ${status.activity_reason})`
    );
  }
}

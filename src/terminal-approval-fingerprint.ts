import { createHash } from "node:crypto";
import type { ExecutorKind } from "./executors.js";
import {
  terminalApprovalActionForDecision, terminalApprovalChoices, isTerminalApprovalPromptEvidence,
  type TerminalControlRef, type TerminalScreenInspection, type TerminalRuntimeIdentity,
  type TerminalApprovalDecision
} from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint, terminalEndpointFromControlRef, terminalEndpointIdentityKey
} from "./terminal-control-ref.js";

export function terminalApprovalFingerprint(
  agent: ExecutorKind,
  terminalControl: TerminalControlRef,
  inspection: TerminalScreenInspection,
  options: {
    screen?: string;
    runtime?: TerminalRuntimeIdentity;
    decision?: TerminalApprovalDecision;
  } = {}
): string | undefined {
  if (!inspection.approval.approvable) {
    return undefined;
  }
  const decision = options.decision ?? "approve_once";
  const choices = terminalApprovalChoices(inspection.approval);
  const action = terminalApprovalActionForDecision(
    inspection.approval,
    decision
  );
  if (!action) {
    return undefined;
  }
  const decisionMode = action.mode ?? "keys";
  const promptEvidence = inspection.approval.promptEvidence;
  if (
    decisionMode === "keys" &&
    !isTerminalApprovalPromptEvidence(promptEvidence)
  ) {
    return undefined;
  }
  const terminal = terminalEndpointFromControlRef(terminalControl);
  // Legacy control records without canonical endpoint evidence bind v2 to
  // their exact stored tmux coordinates. A fresh canonical capture upgrades
  // new fingerprints to stable endpoint identity; v1 fingerprints are never
  // recomputed or accepted here.
  const terminalFingerprint = hasCanonicalTerminalEndpoint(terminalControl)
    ? {
        identity: terminalEndpointIdentityKey(terminal),
        process_anchor_pid: terminal.processAnchorPid
      }
    : terminalControl.kind === "tmux" ? {
        target: terminalControl.target,
        socket_path: terminalControl.socketPath,
        session: terminalControl.session,
        window: terminalControl.window,
        pane: terminalControl.pane,
        pane_pid: terminalControl.panePid
      } : undefined;
  if (!terminalFingerprint) {
    return undefined;
  }
  return createHash("sha256")
    .update(JSON.stringify({
      version: 2,
      agent,
      provider: terminal.identity.providerKind,
      terminal: terminalFingerprint,
      runtime: approvalRuntimeFingerprint(options.runtime),
      decision,
      keys: action.keys,
      label: action.label,
      available_choices: choices.map((choice) => ({
        decision: choice.decision,
        keys: choice.keys,
        label: choice.label,
        mode: choice.mode ?? "keys",
        request_id: choice.requestId
      })),
      prompt_kind: inspection.approval.promptKind,
      command: inspection.approval.command,
      cwd: inspection.approval.cwd,
      tool_name: inspection.approval.toolName,
      request_detail: inspection.approval.requestDetail,
      policy_evidence: inspection.approval.policyEvidence
        ? {
            source: inspection.approval.policyEvidence.source,
            kind: inspection.approval.policyEvidence.kind,
            command_sha256: inspection.approval.policyEvidence.commandSha256,
            evidence_fingerprint:
              inspection.approval.policyEvidence.evidenceFingerprint,
            request_id: inspection.approval.policyEvidence.requestId,
            metadata: inspection.approval.policyEvidence.metadata
          }
        : undefined,
      prompt_evidence: promptEvidence
        ? {
            profile: promptEvidence.profile,
            sha256: promptEvidence.sha256
          }
        : undefined,
      decision_mode: decisionMode,
      request_id: action.requestId
    }))
    .digest("hex");
}

function approvalRuntimeFingerprint(runtime: TerminalRuntimeIdentity | undefined) {
  return {
        pid: runtime?.pid,
        session_id: runtime?.sessionId,
        native_session_id: runtime?.nativeSessionId,
        native_process_uuid: runtime?.nativeProcessUuid,
        native_process_birth: runtime?.nativeProcessBirth,
        require_native_process_uuid:
          runtime?.requireNativeProcessUuid,
        require_exact_claude_agent_row:
          runtime?.requireExactClaudeAgentRow,
        native_process_started_at:
          runtime?.nativeProcessStartedAt,
        exact_claude_agent_state:
          runtime?.exactClaudeAgentState,
        require_native_rollout_identity:
          runtime?.requireNativeRolloutIdentity,
        native_rollout: runtime?.nativeRollout,
        expected_native_session_id:
          runtime?.expectedNativeSessionId,
        expected_empty_native_session:
          runtime?.expectedEmptyNativeSession,
        allowed_pre_materialization_native_identity:
          runtime?.allowedPreMaterializationNativeIdentity,
        allowed_additional_native_identities:
          runtime?.allowedAdditionalNativeIdentities,
        cwd: runtime?.cwd,
        conversation_id: runtime?.conversationId,
        message_id: runtime?.messageId,
        terminal_target: runtime?.terminalTarget
      };
}

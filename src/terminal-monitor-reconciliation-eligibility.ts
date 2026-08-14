import path from "node:path";
import type { DeferredForegroundTransfer } from "./deferred-foreground-transfer.js";
import { sessionIdForConversation, turnIdForConversation, type Conversation } from
  "./protocol.js";
import type { TerminalControlRef, TerminalRuntimeIdentity } from
  "./terminal-agent-adapter.js";
import { terminalControlEvidenceMatches } from "./terminal-control-ref.js";
import { sameCanonicalStatePath } from "./terminal-dispatch-ledger-codec.js";
import { validTerminalMonitorTimestampMs as validTimestampMs } from
  "./terminal-monitor-decision-policy.js";
import {
  terminalBridgeSubmission,
  validateCodexRolloutAcceptanceAnchor
} from "./terminal-submission-facts.js";
import { isRecord, nonBlankString } from "./value-guards.js";

type JsonRecord = Record<string, unknown>;

export type TerminalMonitorEligibilityRequest =
  | { kind: "control"; nativeTakeover: JsonRecord }
  | { kind: "dispatch"; terminalControl: TerminalControlRef }
  | { kind: "store" }
  | { kind: "runtime"; terminalControl: TerminalControlRef }
  | { kind: "deferred"; storeDir: string; transferId: string };

export type TerminalMonitorEligibilityObservation =
  | { kind: "control"; terminalControl?: TerminalControlRef }
  | { kind: "dispatch"; ledger?: JsonRecord }
  | { kind: "store"; storeDir?: string }
  | { kind: "runtime"; runtime: TerminalRuntimeIdentity }
  | { kind: "deferred"; transfer: DeferredForegroundTransfer };

export type TerminalMonitorEligibility =
  | { eligible: false; reason: string }
  | {
      eligible: true;
      nativeTakeover: JsonRecord;
      terminalMessageId: string;
      terminalControl: TerminalControlRef;
      runtime: TerminalRuntimeIdentity;
      inactivityTimeoutMinutes: number;
      hardTimeoutMinutes: number;
      inactivityDeadlineAtMs: number;
      hardDeadlineAtMs: number;
    };

/** Pure staged eligibility; callers perform only the observations yielded. */
export function* terminalMonitorReconciliationEligibility(
  conversation: Conversation
): Generator<
  TerminalMonitorEligibilityRequest,
  TerminalMonitorEligibility,
  TerminalMonitorEligibilityObservation
> {
  const nativeTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (nativeTakeover?.terminal_bridge !== true) {
    return ineligible("not_terminal_bridge");
  }
  if (![
    "created", "running", "waiting_for_agent", "cancelling"
  ].includes(conversation.status)) {
    return ineligible(`conversation_status_${String(conversation.status ?? "missing")}`);
  }
  const terminalMessageId = nonBlankString(nativeTakeover.terminal_bridge_message_id);
  const control = expectObservation("control", yield { kind: "control", nativeTakeover });
  const terminalControl = control.terminalControl;
  if (!terminalMessageId || !terminalControl) {
    return ineligible("terminal_bridge_identity_missing");
  }

  const dispatch = expectObservation(
    "dispatch", yield { kind: "dispatch", terminalControl }
  );
  const ledger = dispatch.ledger;
  const statePath = nonBlankString(conversation.state_path);
  const dispatchStore = expectObservation("store", yield { kind: "store" });
  const bindingId = nonBlankString(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  if (
    !ledger ||
    nonBlankString(ledger.message_id) !== terminalMessageId ||
    !terminalControlEvidenceMatches(
      ledger.terminal_endpoint !== undefined
        ? ledger.terminal_endpoint
        : ledger.terminal_control,
      terminalControl
    ) ||
    nonBlankString(ledger.conversation_id) !== conversation.conversation_id ||
    nonBlankString(ledger.session_id) !== sessionIdForConversation(conversation) ||
    nonBlankString(ledger.turn_id) !== turnIdForConversation(conversation) ||
    !statePath || !sameCanonicalStatePath(ledger.state_path, statePath) ||
    !dispatchStore.storeDir ||
    path.resolve(nonBlankString(ledger.store_dir) ?? "") !==
      path.resolve(dispatchStore.storeDir) ||
    (bindingId !== undefined && nonBlankString(ledger.binding_id) !== bindingId) ||
    (Number.isSafeInteger(bindingGeneration) &&
      Number(ledger.binding_generation) !== bindingGeneration) ||
    !["prepared", "text_injected", "enter_dispatched", "agent_accepted", "submitted"]
      .includes(String(ledger.status))
  ) {
    return ineligible(
      `terminal_dispatch_${String(
        ledger?.status ?? "missing_or_generation_replaced"
      )}`
    );
  }

  const submission = terminalBridgeSubmission(conversation);
  if (
    submission &&
    nonBlankString(submission.message_id) === terminalMessageId &&
    ["not_accepted", "uncertain", "aborted"].includes(String(submission.status))
  ) {
    return ineligible(`terminal_submission_${submission.status}`);
  }

  const runtimeObservation = expectObservation(
    "runtime", yield { kind: "runtime", terminalControl }
  );
  const runtime = runtimeObservation.runtime;
  if (!Number.isInteger(runtime.pid) || Number(runtime.pid) <= 0 ||
    !nonBlankString(runtime.cwd)) {
    return ineligible("terminal_agent_identity_missing");
  }

  const deferredStore = expectObservation("store", yield { kind: "store" });
  const transferId = nonBlankString(nativeTakeover.deferred_foreground_transfer_id);
  if (deferredStore.storeDir && transferId) {
    const deferred = expectObservation("deferred", yield {
      kind: "deferred", storeDir: deferredStore.storeDir, transferId
    });
    const transfer = deferred.transfer;
    if (!["resolved", "abort_resolved"].includes(transfer.status) && (
      validateCodexRolloutAcceptanceAnchor(
        nativeTakeover.codex_rollout_acceptance_anchor
      )?.version !== 3 ||
      transfer.status !== "dispatch_started" ||
      submission?.status !== "enter_dispatched" ||
      transfer.turn_id !== turnIdForConversation(conversation) ||
      transfer.message_id !== terminalMessageId ||
      transfer.target_session_id !== sessionIdForConversation(conversation)
    )) {
      return ineligible(`deferred_foreground_transfer_${transfer.status}`);
    }
  }

  const inactivityTimeoutMinutes = Number(
    nativeTakeover.terminal_bridge_inactivity_timeout_minutes
  );
  const hardTimeoutMinutes = Number(nativeTakeover.terminal_bridge_hard_timeout_minutes);
  const startedAtMs = validTimestampMs(nativeTakeover.terminal_bridge_started_at);
  const lastActivityAtMs = validTimestampMs(nativeTakeover.terminal_bridge_last_activity_at);
  const inactivityDeadlineAtMs = validTimestampMs(
    nativeTakeover.terminal_bridge_inactivity_deadline_at
  );
  const hardDeadlineAtMs = validTimestampMs(nativeTakeover.terminal_bridge_hard_deadline_at);
  if (
    !Number.isFinite(inactivityTimeoutMinutes) ||
    inactivityTimeoutMinutes <= 0 ||
    !Number.isFinite(hardTimeoutMinutes) ||
    hardTimeoutMinutes <= 0 ||
    startedAtMs === undefined ||
    lastActivityAtMs === undefined ||
    inactivityDeadlineAtMs === undefined ||
    hardDeadlineAtMs === undefined
  ) {
    return ineligible("terminal_bridge_deadline_metadata_missing");
  }
  return {
    eligible: true,
    nativeTakeover,
    terminalMessageId,
    terminalControl,
    runtime,
    inactivityTimeoutMinutes,
    hardTimeoutMinutes,
    inactivityDeadlineAtMs,
    hardDeadlineAtMs
  };
}

const ineligible = (reason: string): TerminalMonitorEligibility =>
  ({ eligible: false, reason });

function expectObservation<Kind extends TerminalMonitorEligibilityObservation["kind"]>(
  kind: Kind,
  observation: TerminalMonitorEligibilityObservation | undefined
): Extract<TerminalMonitorEligibilityObservation, { kind: Kind }> {
  if (observation === undefined || observation.kind !== kind) {
    throw new Error(`terminal monitor eligibility expected ${kind} observation`);
  }
  return observation as Extract<TerminalMonitorEligibilityObservation, { kind: Kind }>;
}

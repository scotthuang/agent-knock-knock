import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import {
  callbackExpectedForConversation,
  callbackRouteFingerprintLedgerFields
} from
  "./callback-route-authority.js";
import type { DeferredForegroundApplicationScope } from
  "./deferred-foreground-boundary.js";
import {
  deferredForegroundActiveEnterDispatchedAt,
  deferredForegroundActiveMessageId,
  deferredForegroundActivePreparedAt,
  deferredForegroundActiveTextInjectedAt,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { loadManagedSession } from "./session-store.js";
import {
  isCompleteNativeRollout,
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import {
  terminalControlEvidenceMatches
} from "./terminal-control-ref.js";
import type {
  DeferredCodexForegroundBindingBoundary,
  TerminalDispatchTerminal
} from "./terminal-dispatch-composition.js";
import { terminalSubmissionPayload } from
  "./terminal-dispatch-execution.js";
import {
  terminalDispatchLedgerLooksLifecycle,
  terminalDispatchReceiptHistory as terminalLedgerReceiptHistory
} from "./terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission,
  type TerminalBridgeSubmissionMutation
} from "./terminal-dispatch-receipt.js";
import {
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import {
  loadState,
  pathsForConversation,
  pathsForConversationDir,
  saveState
} from "./store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import {
  cliEnv,
  cliExit,
  cliNow,
  cliRuntimeLog as runtimeLog
} from "./cli-runtime-context.js";

const TERMINAL_INPUT_EVIDENCE_FIELDS = [
  "text_injected_at",
  "enter_dispatched_at",
  "submitted_at",
  "agent_accepted_at",
  "not_accepted_at",
  "uncertain_at",
  "acceptance_evidence"
] as const;
const DEFERRED_INPUT_EVIDENCE_FIELDS = [
  "dispatch_started_at",
  ...TERMINAL_INPUT_EVIDENCE_FIELDS
] as const;
const DEFERRED_ACCEPTANCE_RECOVERY_STATUSES = new Set([
  "prepared",
  "text_injected",
  "enter_dispatched",
  "uncertain",
  "agent_accepted"
]);

export interface DeferredForegroundRecoveryAdapterPorts {
  native: {
    processIncarnation(pid: number): {
      processUuid: string;
      processBirth: string;
    };
    inventory(input: {
      options: Record<string, any>;
      pid: number;
      cwd?: string;
    }): Promise<CodexOpenRootRolloutInventory>;
    identity(input: {
      options: Record<string, any>;
      agent: "codex";
      pid: number;
      cwd?: string;
    }): Promise<NativeAgentSessionIdentity | undefined>;
  };
  turn: {
    terminalControl(value: unknown): TerminalControlRef | undefined;
    storeDir(conversation: Conversation): string | undefined;
    withIdentity(
      conversation: Conversation,
      identity: NativeAgentSessionIdentity
    ): Conversation;
    withSubmission(mutation: TerminalBridgeSubmissionMutation): Conversation;
  };
  ledger: {
    load(control: TerminalControlRef): Record<string, any> | undefined;
    save(control: TerminalControlRef, ledger: Record<string, unknown>): void;
    matchesControl(
      ledger: Record<string, any> | undefined,
      control: TerminalControlRef
    ): boolean;
    bindingFields(conversation: Conversation): Record<string, unknown>;
    previousSnapshotMatches(input: {
      transfer: DeferredForegroundTransfer;
      terminalControl: TerminalControlRef;
      ledger: Record<string, any> | undefined;
    }): boolean;
  };
  authority: {
    assertFrozen(input: {
      storeDir: string;
      transfer: DeferredForegroundTransfer;
      terminalControl: TerminalControlRef;
    }): void;
    assertTurnIdentity(input: {
      conversation: Conversation;
      currentIdentity: NativeAgentSessionIdentity;
      operation: string;
    }): void;
  };
  application: {
    abortBeforeInput(input: {
      options: Record<string, any>;
      scope: DeferredForegroundApplicationScope;
      boundary: DeferredCodexForegroundBindingBoundary;
      reason: string;
      terminalInputNotStartedAt?: string;
    }): void;
    commit(input: {
      options: Record<string, any>;
      scope: DeferredForegroundApplicationScope;
      boundary: DeferredCodexForegroundBindingBoundary;
      identity: NativeAgentSessionIdentity;
      acceptedAt: string;
    }): Promise<ManagedSessionState>;
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

interface DeferredForegroundTurnAuthority {
  conversation: Conversation;
  statePath: string;
  logPath: string;
  takeover: Record<string, any>;
  submission: Record<string, any>;
  anchor: CodexRolloutAcceptanceAnchor;
}

interface DeferredTurnAuthorityContext {
  ports: DeferredForegroundRecoveryAdapterPorts;
  storeDir: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
  conversation: Conversation;
  statePath: string;
  takeover: Record<string, any> | undefined;
  submission: Record<string, any> | undefined;
  terminalControl: TerminalControlRef | undefined;
  target: ManagedSessionState;
  targetBefore: DeferredForegroundTransfer["target_before_binding"];
  anchor: CodexRolloutAcceptanceAnchor | undefined;
  prebindingTurn: boolean;
  acceptedTurn: boolean;
  precommitTargetAuthority: boolean;
  committedTargetAuthority: boolean;
}

export function deferredCodexBoundaryFromTransfer(ports: DeferredForegroundRecoveryAdapterPorts, {
  terminal,
  transfer
}: {
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
}): DeferredCodexForegroundBindingBoundary {
  const liveIncarnation = ports.native.processIncarnation(terminal.pid);
  if (
    terminal.agent !== "codex" ||
    transfer.terminal_id !== terminal.conversationId ||
    transfer.process_pid !== terminal.pid ||
    transfer.process_uuid !== liveIncarnation.processUuid ||
    transfer.process_birth !== liveIncarnation.processBirth ||
    path.resolve(transfer.workspace) !== path.resolve(
      terminal.terminalControl.currentPath ?? ""
    ) ||
    !terminalControlEvidenceMatches(
      transfer.terminal_endpoint,
      terminal.terminalControl
    )
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} no longer ` +
      "matches the exact terminal incarnation"
    );
  }
  return {
    terminal,
    transferId: transfer.transfer_id,
    preparedAt: transfer.prepared_at,
    targetSessionId: transfer.target_session_id,
    sourceSessionId: transfer.source_session_id,
    sourceBoundRevision: transfer.source_expected_revision,
    sourceBoundBindingToken: transfer.source_binding_token,
    processUuid: transfer.process_uuid,
    processBirth: transfer.process_birth,
    previousDispatchSnapshot: {
      status: transfer.previous_dispatch_status,
      fingerprint: transfer.previous_dispatch_fingerprint
    },
    sourceKind: transfer.version === 1
      ? "status_card_only"
      : required(
          transfer.source_kind,
          "deferred foreground source kind is unavailable"
        ),
    sourceRolloutAuthority: transfer.source_rollout_authority ?? "present",
    ...(transfer.source_abandonment_fingerprint
      ? {
          sourceAbandonmentFingerprint:
            transfer.source_abandonment_fingerprint
        }
      : {}),
    ...(transfer.source_turn_history
      ? { sourceTurnHistory: transfer.source_turn_history }
      : {}),
    ...(transfer.source_previous_last_transition_id
      ? {
          sourcePreviousLastTransitionId:
            transfer.source_previous_last_transition_id
        }
      : {}),
    sourceReservedRevision: transfer.source_expected_revision + 1,
    sourceReservedBindingToken: managedSessionBindingToken({
      session_id: transfer.source_session_id,
      status: "transitioning",
      binding: transfer.source_before_binding
    }),
    targetPreparedRevision: transfer.target_prepared_revision,
    targetPreparedBindingToken: transfer.target_prepared_binding_token
  };
}

export function loadDeferredForegroundTurnAuthority(
  ports: DeferredForegroundRecoveryAdapterPorts,
  { storeDir, terminal, transfer, scope }: {
  storeDir: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
  scope?: DeferredForegroundApplicationScope;
  }
): DeferredForegroundTurnAuthority {
  if (scope) assertActiveTurnRoute(scope, transfer);
  const statePath = canonicalDeferredTurnStatePath(storeDir, transfer);
  const canonical = pathsForConversationDir(path.dirname(statePath));
  const conversation = loadState(statePath);
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const submission = terminalBridgeSubmission(conversation);
  const terminalControl = ports.turn.terminalControl(takeover);
  const anchor = validatedDeferredAnchor(
    takeover?.codex_rollout_acceptance_anchor
  );
  const target = loadManagedSession(storeDir, transfer.target_session_id);
  const turnNativeThreadId = stringValue(conversation.native_thread_id);
  const takeoverNativeThreadId = stringValue(
    takeover?.terminal_agent_session_id
  );
  const submissionNativeThreadId = stringValue(submission?.native_thread_id);
  const context: DeferredTurnAuthorityContext = {
    ports,
    storeDir,
    terminal,
    transfer,
    conversation,
    statePath,
    takeover,
    submission,
    terminalControl,
    target,
    targetBefore: transfer.target_before_binding,
    anchor,
    prebindingTurn: turnNativeThreadId === undefined &&
      takeoverNativeThreadId === undefined &&
      submissionNativeThreadId === undefined &&
      takeover?.terminal_agent_rollout === undefined,
    acceptedTurn: exactAcceptedDeferredTurn({
      transfer,
      submission,
      turnNativeThreadId,
      takeoverNativeThreadId,
      submissionNativeThreadId,
      turnRollout: takeover?.terminal_agent_rollout
    }),
    precommitTargetAuthority: exactPrecommitTarget(transfer, target),
    committedTargetAuthority: exactCommittedTarget(transfer, target)
  };
  if (!deferredTurnAuthorityMatches(context)) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} Turn authority ` +
      "does not match its exact request/terminal/process fence"
    );
  }
  return {
    conversation,
    statePath,
    logPath: canonical.logPath,
    takeover: takeover!,
    submission: submission!,
    anchor: anchor!
  };
}

function canonicalDeferredTurnStatePath(
  storeDir: string,
  transfer: DeferredForegroundTransfer
): string {
  const statePath = path.resolve(required(
    transfer.state_path,
    "deferred foreground Turn state path is unavailable"
  ));
  const canonical = pathsForConversationDir(path.dirname(statePath));
  if (
    path.resolve(canonical.storeDir) !== path.resolve(storeDir) ||
    path.resolve(canonical.statePath) !== statePath
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has a noncanonical ` +
      "Turn state path"
    );
  }
  return statePath;
}

function assertActiveTurnRoute(
  scope: DeferredForegroundApplicationScope,
  transfer: DeferredForegroundTransfer
): void {
  if (!scope.transferBelongsToTurn(transfer)) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} escaped its ` +
      "active Turn state capability"
    );
  }
}

function validatedDeferredAnchor(
  value: unknown
): CodexRolloutAcceptanceAnchor | undefined {
  try {
    return validateCodexRolloutAcceptanceAnchor(value);
  } catch {
    return undefined;
  }
}

function exactPrecommitTarget(
  transfer: DeferredForegroundTransfer,
  target: ManagedSessionState
): boolean {
  return Boolean(
    !["committed", "resolved"].includes(transfer.status) &&
    target.status === "transitioning" &&
    target.last_transition_id === transfer.transfer_id
  );
}

function exactCommittedTarget(
  transfer: DeferredForegroundTransfer,
  target: ManagedSessionState
): boolean {
  const binding = transfer.target_accepted_binding;
  if (!binding || !["committed", "resolved"].includes(transfer.status)) {
    return false;
  }
  const transitioning = target.status === "transitioning" &&
    target.last_transition_id === transfer.transfer_id &&
    managedSessionRevision(target) === transfer.target_accepted_revision &&
    managedSessionBindingToken(target) ===
      transfer.target_accepted_binding_token;
  const bound = target.status === "bound" &&
    !target.last_transition_id &&
    managedSessionRevision(target) ===
      Number(transfer.target_accepted_revision) + 1 &&
    managedSessionBindingToken(target) === managedSessionBindingToken({
      session_id: transfer.target_session_id,
      status: "bound",
      binding
    });
  return (transitioning || bound) &&
    JSON.stringify(target.binding) === JSON.stringify(binding);
}

function exactAcceptedDeferredTurn(input: {
  transfer: DeferredForegroundTransfer;
  submission: Record<string, any> | undefined;
  turnNativeThreadId?: string;
  takeoverNativeThreadId?: string;
  submissionNativeThreadId?: string;
  turnRollout: unknown;
}): boolean {
  if (
    !input.turnNativeThreadId ||
    input.takeoverNativeThreadId !== input.turnNativeThreadId ||
    input.submissionNativeThreadId !== input.turnNativeThreadId ||
    !isCompleteNativeRollout(input.turnRollout) ||
    String(input.submission?.status) !== "agent_accepted"
  ) {
    return false;
  }
  try {
    validateTerminalSubmissionAcceptanceEvidence(
      input.submission?.acceptance_evidence,
      {
        source: "codex_rollout",
        nativeThreadId: input.turnNativeThreadId,
        requestHash: input.transfer.request_hash
      }
    );
    return true;
  } catch {
    return false;
  }
}

function deferredTurnAuthorityMatches(
  context: DeferredTurnAuthorityContext
): boolean {
  return deferredTurnTerminalMatches(context) &&
    deferredTurnStorageMatches(context) &&
    deferredTurnRequestMatches(context) &&
    deferredTurnBindingMatches(context) &&
    deferredTargetMatches(context) &&
    exactDeferredAcceptanceAnchor(context.anchor, context.transfer);
}

function deferredTurnTerminalMatches(
  context: DeferredTurnAuthorityContext
): boolean {
  const { terminalControl, terminal, conversation, transfer } = context;
  return Boolean(
    context.takeover && context.submission && terminalControl &&
    context.targetBefore &&
    terminalControlsShareIncarnation(
      terminalControl!,
      terminal.terminalControl
    ) &&
    terminalControlEvidenceMatches(
      context.takeover!.terminal_endpoint ?? terminalControl,
      terminal.terminalControl
    ) &&
    executorForConversation(conversation).kind === "codex" &&
    conversation.conversation_id === transfer.turn_id &&
    sessionIdForConversation(conversation) === transfer.target_session_id &&
    turnIdForConversation(conversation) === transfer.turn_id
  );
}

function deferredTurnStorageMatches(
  context: DeferredTurnAuthorityContext
): boolean {
  const { ports, storeDir, conversation, statePath, takeover, transfer } =
    context;
  return Boolean(
    path.resolve(required(
      stringValue(conversation.state_path),
      "deferred foreground Turn state path is missing"
    )) === statePath &&
    path.resolve(
      pathsForConversation(conversation.conversation_id, storeDir).statePath
    ) === statePath &&
    path.resolve(required(
      ports.turn.storeDir(conversation),
      "deferred foreground Turn Store is missing"
    )) === path.resolve(storeDir) &&
    stringValue(takeover!.deferred_foreground_transfer_id) ===
      transfer.transfer_id &&
    stringValue(takeover!.terminal_bridge_message_id) ===
      deferredForegroundActiveMessageId(transfer)
  );
}

function deferredTurnRequestMatches(
  context: DeferredTurnAuthorityContext
): boolean {
  const { storeDir, conversation, takeover, submission, transfer } = context;
  const messageBodyHash = stringValue(submission!.message_body_hash);
  const requestText = stringValue(takeover!.terminal_bridge_request_text);
  return Boolean(
    stringValue(submission!.session_id) === transfer.target_session_id &&
    stringValue(submission!.turn_id) === transfer.turn_id &&
    stringValue(submission!.message_id) ===
      deferredForegroundActiveMessageId(transfer) &&
    stringValue(submission!.message_type) === "task" &&
    stringValue(submission!.executor_kind) === "codex" &&
    messageBodyHash && /^[0-9a-f]{64}$/u.test(messageBodyHash) &&
    createHash("sha256").update(String(conversation.user_request)).digest("hex") ===
      messageBodyHash &&
    terminalBridgeRequestFingerprint(
      terminalSubmissionPayload(String(conversation.user_request))
    ) === transfer.request_hash &&
    stringValue(takeover!.terminal_bridge_request_hash) ===
      transfer.request_hash &&
    stringValue(submission!.request_hash) === transfer.request_hash &&
    requestText &&
    terminalBridgeRequestFingerprint(requestText) === transfer.request_hash &&
    path.resolve(required(
      stringValue(submission!.store_dir),
      "deferred foreground submission Store is missing"
    )) === path.resolve(storeDir)
  );
}

function deferredTurnBindingMatches(
  context: DeferredTurnAuthorityContext
): boolean {
  const { conversation, takeover, submission, targetBefore, transfer } = context;
  if (!targetBefore) return false;
  const bindingAuthority =
    stringValue(conversation.terminal_binding_id) === targetBefore.binding_id &&
    Number(conversation.terminal_binding_generation) === targetBefore.generation &&
    stringValue(takeover!.terminal_binding_id) === targetBefore.binding_id &&
    Number(takeover!.terminal_binding_generation) === targetBefore.generation &&
    stringValue(submission!.binding_id) === targetBefore.binding_id &&
    Number(submission!.binding_generation) === targetBefore.generation;
  return bindingAuthority && (context.prebindingTurn || context.acceptedTurn) &&
    stringValue(takeover!.terminal_agent_expected_session_id) === undefined &&
    Number(takeover!.terminal_agent_pid) === transfer.process_pid &&
    stringValue(takeover!.terminal_agent_process_uuid) ===
      transfer.process_uuid &&
    stringValue(takeover!.terminal_agent_process_birth) ===
      transfer.process_birth;
}

function deferredTargetMatches(context: DeferredTurnAuthorityContext): boolean {
  const { target, targetBefore, transfer } = context;
  if (!targetBefore) return false;
  return Boolean(
    target.session_id === transfer.target_session_id &&
    (context.precommitTargetAuthority || context.committedTargetAuthority) &&
    target.lineage.transition_id === transfer.transfer_id &&
    target.lineage.previous_session_id === transfer.source_session_id &&
    target.binding &&
    target.binding.binding_id === targetBefore.binding_id &&
    target.binding.generation === targetBefore.generation &&
    target.binding.terminal_id === targetBefore.terminal_id &&
    terminalControlsShareIncarnation(
      target.binding.terminal_control,
      targetBefore.terminal_control
    ) &&
    target.binding.native_process.pid === transfer.process_pid &&
    target.binding.native_process.process_uuid === transfer.process_uuid &&
    target.binding.native_process.process_birth === transfer.process_birth
  );
}

function exactDeferredAcceptanceAnchor(
  anchor: CodexRolloutAcceptanceAnchor | undefined,
  transfer: DeferredForegroundTransfer
): boolean {
  if (
    !anchor || anchor.process_uuid !== transfer.process_uuid ||
    anchor.process_birth !== transfer.process_birth
  ) {
    return false;
  }
  if (anchor.version === 2) {
    return anchor.mode === "pre_materialization" &&
      anchor.native_thread_binding === "post_submission" &&
      anchor.file_existed === false && anchor.offset_bytes === 0 &&
      anchor.expected_empty_native_session === true;
  }
  return anchor.version === 3 && anchor.mode === "candidate_set" &&
    anchor.inventory_pid === transfer.process_pid &&
    path.resolve(anchor.inventory_cwd ?? "") === path.resolve(transfer.workspace) &&
    anchor.candidate_rollouts.length > 0;
}

export function assertDeferredForegroundLedgerAuthority(ports: DeferredForegroundRecoveryAdapterPorts, {
  storeDir,
  terminal,
  transfer,
  ledger,
  statePath,
  expectedMessageBodyHash
}: {
  storeDir: string;
  terminal: Pick<TerminalDispatchTerminal, "terminalControl">;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
  statePath: string;
  expectedMessageBodyHash?: string;
}): void {
  const targetBefore = transfer.target_before_binding;
  const ledgerMessageBodyHash = stringValue(ledger.message_body_hash);
  const exactCommittedAcceptance = exactCommittedLedgerAcceptance(
    transfer,
    ledger
  );
  const exactPostDispatchPending = exactPostDispatchPendingLedger(
    transfer,
    ledger
  );
  const matches = targetBefore && ledgerIdentityMatches({
    ports,
    storeDir,
    terminal,
    transfer,
    ledger,
    statePath,
    expectedMessageBodyHash,
    ledgerMessageBodyHash,
    targetBefore,
    exactCommittedAcceptance,
    exactPostDispatchPending
  });
  if (!matches) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} dispatch ledger ` +
      "does not match its exact Turn authority"
    );
  }
}

interface DeferredLedgerAuthorityContext {
  ports: DeferredForegroundRecoveryAdapterPorts;
  storeDir: string;
  terminal: Pick<TerminalDispatchTerminal, "terminalControl">;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
  statePath: string;
  expectedMessageBodyHash?: string;
  ledgerMessageBodyHash?: string;
  targetBefore: NonNullable<DeferredForegroundTransfer["target_before_binding"]>;
  exactCommittedAcceptance: boolean;
  exactPostDispatchPending: boolean;
}

function exactCommittedLedgerAcceptance(
  transfer: DeferredForegroundTransfer,
  ledger: Record<string, any>
): boolean {
  if (
    !["committed", "resolved"].includes(transfer.status) ||
    ledger.status !== "agent_accepted" ||
    stringValue(ledger.native_thread_id) !== transfer.target_native_thread_id ||
    ledger.dispatcher_pid !== null ||
    stringValue(ledger.agent_accepted_at) !== transfer.agent_accepted_at ||
    !transfer.target_native_thread_id
  ) {
    return false;
  }
  try {
    validateTerminalSubmissionAcceptanceEvidence(
      ledger.acceptance_evidence,
      {
        source: "codex_rollout",
        nativeThreadId: transfer.target_native_thread_id,
        requestHash: transfer.request_hash
      }
    );
    return true;
  } catch {
    return false;
  }
}

function exactPostDispatchPendingLedger(
  transfer: DeferredForegroundTransfer,
  ledger: Record<string, any>
): boolean {
  return ["dispatch_started", "uncertain"].includes(transfer.status) &&
    transfer.input_stage === "enter_dispatched" &&
    ["enter_dispatched", "uncertain"].includes(String(ledger.status)) &&
    ledger.dispatcher_pid === null &&
    stringValue(ledger.prepared_at) ===
      deferredForegroundActivePreparedAt(transfer) &&
    stringValue(ledger.text_injected_at) ===
      deferredForegroundActiveTextInjectedAt(transfer) &&
    stringValue(ledger.enter_dispatched_at) ===
      deferredForegroundActiveEnterDispatchedAt(transfer) &&
    ledger.agent_accepted_at === undefined &&
    ledger.not_accepted_at === undefined &&
    (ledger.status === "uncertain"
      ? stringValue(ledger.uncertain_at) !== undefined
      : ledger.uncertain_at === undefined) &&
    ledger.acceptance_evidence === undefined &&
    ledger.safe_to_retry !== true;
}

function ledgerIdentityMatches(context: DeferredLedgerAuthorityContext): boolean {
  return ledgerOwnerFieldsMatch(context) && ledgerRouteMatches(context) &&
    ledgerDispatchFenceMatches(context);
}

function ledgerOwnerFieldsMatch(context: DeferredLedgerAuthorityContext): boolean {
  const { ports, terminal, transfer, ledger, ledgerMessageBodyHash } = context;
  return !terminalDispatchLedgerLooksLifecycle(ledger) &&
    ports.ledger.matchesControl(ledger, terminal.terminalControl) &&
    stringValue(ledger.deferred_foreground_transfer_id) ===
      transfer.transfer_id &&
    stringValue(ledger.generation_id) ===
      deferredForegroundActiveMessageId(transfer) &&
    stringValue(ledger.conversation_id) === transfer.turn_id &&
    stringValue(ledger.session_id) === transfer.target_session_id &&
    stringValue(ledger.turn_id) === transfer.turn_id &&
    stringValue(ledger.message_id) ===
      deferredForegroundActiveMessageId(transfer) &&
    stringValue(ledger.message_type) === "task" &&
    stringValue(ledger.executor_kind) === "codex" &&
    Boolean(ledgerMessageBodyHash) &&
    /^[0-9a-f]{64}$/u.test(ledgerMessageBodyHash!) &&
    (context.expectedMessageBodyHash === undefined ||
      ledgerMessageBodyHash === context.expectedMessageBodyHash) &&
    stringValue(ledger.request_hash) === transfer.request_hash;
}

function ledgerRouteMatches(context: DeferredLedgerAuthorityContext): boolean {
  const { storeDir, transfer, ledger, statePath, targetBefore } = context;
  const nativeThreadId = stringValue(ledger.native_thread_id);
  const nativeAuthority = context.exactCommittedAcceptance
    ? nativeThreadId === transfer.target_native_thread_id
    : nativeThreadId === undefined;
  return stringValue(ledger.binding_id) === targetBefore.binding_id &&
    Number(ledger.binding_generation) === targetBefore.generation &&
    nativeAuthority &&
    path.resolve(required(ledger.state_path, "dispatch state path is missing")) ===
      statePath &&
    path.resolve(required(ledger.store_dir, "dispatch Store is missing")) ===
      path.resolve(storeDir);
}

function ledgerDispatchFenceMatches(
  context: DeferredLedgerAuthorityContext
): boolean {
  const { transfer, ledger } = context;
  return ledger.status === "resolved" || context.exactCommittedAcceptance ||
    context.exactPostDispatchPending ||
    exactSubmissionRetryLedgerFence(transfer, ledger) ||
    Number(ledger.dispatcher_pid) === transfer.dispatcher_pid;
}

function exactSubmissionRetryLedgerFence(
  transfer: DeferredForegroundTransfer,
  ledger: Record<string, any>
): boolean {
  const mode = transfer.submission_retry_mode;
  const attemptId = transfer.submission_retry_attempt_id;
  const messageId = transfer.submission_retry_message_id;
  if (!mode || !attemptId || !messageId) return false;
  const expected = transfer.submission_retry_enter_dispatched_at
    ? { state: "enter_dispatched", revision: mode === "replacement_send" ? 5 : 2 }
    : transfer.submission_retry_enter_reserved_at
      ? { state: "enter_reserved", revision: mode === "replacement_send" ? 4 : 1 }
      : transfer.submission_retry_text_injected_at
        ? { state: "replacement_text_injected", revision: 3 }
        : transfer.submission_retry_text_reserved_at
          ? { state: "replacement_text_reserved", revision: 2 }
          : { state: "replacement_reserved", revision: 1 };
  const sameOptionalTimestamp = (
    ledgerValue: unknown,
    transferValue: string | undefined
  ) => stringValue(ledgerValue) === transferValue;
  return stringValue(ledger.submission_retry_attempt_id) === attemptId &&
    stringValue(ledger.submission_retry_mode) === mode &&
    stringValue(ledger.submission_retry_original_message_id) ===
      transfer.message_id &&
    stringValue(ledger.submission_retry_active_message_id) === messageId &&
    ledger.submission_retry_state === expected.state &&
    Number(ledger.submission_retry_revision) === expected.revision &&
    sameOptionalTimestamp(
      ledger.submission_retry_replacement_text_reserved_at,
      transfer.submission_retry_text_reserved_at
    ) &&
    sameOptionalTimestamp(
      ledger.submission_retry_replacement_text_injected_at,
      transfer.submission_retry_text_injected_at
    ) &&
    sameOptionalTimestamp(
      ledger.submission_retry_enter_reserved_at,
      transfer.submission_retry_enter_reserved_at
    ) &&
    sameOptionalTimestamp(
      ledger.submission_retry_enter_dispatched_at,
      transfer.submission_retry_enter_dispatched_at
    ) &&
    ["uncertain", "text_injected", "enter_dispatched"].includes(
      String(ledger.status)
    ) &&
    ledger.agent_accepted_at === undefined &&
    ledger.not_accepted_at === undefined &&
    ledger.acceptance_evidence === undefined &&
    ledger.safe_to_retry !== true;
}

export function assertDeferredForegroundResolvedZeroInputLedger(ports: DeferredForegroundRecoveryAdapterPorts, {
  storeDir,
  terminal,
  transfer,
  ledger,
  statePath
}: {
  storeDir: string;
  terminal: Pick<TerminalDispatchTerminal, "terminalControl">;
  transfer: DeferredForegroundTransfer;
  ledger: Record<string, any>;
  statePath: string;
}): void {
  assertDeferredForegroundLedgerAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    ledger,
    statePath
  });
  const abortedAt = stringValue(ledger.aborted_at);
  const resolvedAt = stringValue(ledger.resolved_at);
  if (
    ledger.status !== "resolved" ||
    ledger.safe_to_retry !== true ||
    !abortedAt ||
    !resolvedAt ||
    !Number.isFinite(Date.parse(abortedAt)) ||
    !Number.isFinite(Date.parse(resolvedAt)) ||
    Date.parse(resolvedAt) < Date.parse(abortedAt) ||
    DEFERRED_INPUT_EVIDENCE_FIELDS.some((field) => ledger[field] !== undefined)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} resolved ledger ` +
      "does not prove a zero-input abort"
    );
  }
  // Validate the whole history for malformed/duplicate identities, then
  // require the append-only copy of this exact generation. The top-level
  // resolved record alone is insufficient because it can later be replaced.
  terminalLedgerReceiptHistory(ledger);
  const rawHistory = ledger.terminal_submission_receipts;
  if (!Array.isArray(rawHistory)) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} resolved ledger ` +
      "has no append-only abort receipt"
    );
  }
  const ownReceipts = rawHistory.filter((receipt) =>
    isRecord(receipt) &&
    stringValue(receipt.message_id) === transfer.message_id
  );
  if (ownReceipts.length !== 1) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} resolved ledger ` +
      "does not have one exact append-only abort receipt"
    );
  }
  const ownReceipt = ownReceipts[0];
  assertDeferredForegroundLedgerAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    // A receipt uses `aborted`, while the same exact owner fields at the
    // top-level use `resolved`. Validate its authority in that same domain.
    ledger: { ...ownReceipt, status: "resolved" },
    statePath
  });
  if (
    ownReceipt.status !== "aborted" ||
    ownReceipt.safe_to_retry !== true ||
    stringValue(ownReceipt.aborted_at) !== abortedAt ||
    stringValue(ownReceipt.resolved_at) !== resolvedAt ||
    DEFERRED_INPUT_EVIDENCE_FIELDS.some((field) => ownReceipt[field] !== undefined)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} append-only ` +
      "receipt does not prove a zero-input abort"
    );
  }
}

export function deferredCodexDurableInputNotStartedAt(
  _ports: DeferredForegroundRecoveryAdapterPorts,
  scope: DeferredForegroundApplicationScope,
  transfer: DeferredForegroundTransfer
): string | undefined {
  if (
    transfer.status !== "dispatch_started" ||
    transfer.input_stage !== "dispatch_started" ||
    !transfer.state_path
  ) {
    return undefined;
  }
  assertActiveTurnRoute(scope, transfer);
  const conversation = loadState(path.resolve(transfer.state_path));
  const submission = terminalBridgeSubmission(conversation);
  const abortedAt = stringValue(submission?.aborted_at);
  if (
    submission?.status !== "aborted" ||
    submission.safe_to_retry !== true ||
    !abortedAt ||
    !Number.isFinite(Date.parse(abortedAt)) ||
    stringValue(submission.text_injected_at) !== undefined ||
    stringValue(submission.enter_dispatched_at) !== undefined ||
    stringValue(submission.agent_accepted_at) !== undefined
  ) {
    return undefined;
  }
  return abortedAt;
}

interface AbortPreparedDeferredTurnInput {
  options: Record<string, any>;
  scope: DeferredForegroundApplicationScope;
  storeDir: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
  boundary: DeferredCodexForegroundBindingBoundary;
  terminalInputNotStartedAt?: string;
}

export function abortPreparedDeferredForegroundTurn(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: AbortPreparedDeferredTurnInput
): void {
  const {
    options, scope, storeDir, terminal, transfer, boundary,
    terminalInputNotStartedAt
  } = input;
  assertActiveTurnRoute(scope, transfer);
  const dispatchIntentWasProvedNotStarted = assertAbortInputProof(
    transfer,
    terminalInputNotStartedAt
  );
  const observedLedger = ports.ledger.load(terminal.terminalControl);
  const previousDispatchStillCurrent = ports.ledger.previousSnapshotMatches({
    transfer,
    terminalControl: terminal.terminalControl,
    ledger: observedLedger
  });
  const ledger = deferredTransferLedger(
    transfer,
    observedLedger,
    previousDispatchStillCurrent
  );
  if (abortBeforeTurnPreparation(ports, input, ledger)) return;
  const statePath = canonicalDeferredTurnStatePath(storeDir, transfer);
  if (abortMissingDeferredTurn(ports, input, {
    ledger,
    statePath,
    dispatchIntentWasProvedNotStarted
  })) return;
  persistDeferredTurnAbortReceipts(ports, input, {
    ledger,
    dispatchIntentWasProvedNotStarted
  });
  if (
    cliEnv().AKK_TEST_EXIT_AFTER_DEFERRED_PREINPUT_ABORT_RECEIPTS === "1"
  ) {
    // Both exact zero-input receipts are durable. A second writer may finish
    // only the Store rollback and must never replay terminal input.
    cliExit(86);
  }
  ports.application.abortBeforeInput({
    options,
    scope,
    boundary,
    reason: "recovered exact prepared Turn with zero terminal input",
    terminalInputNotStartedAt
  });
}

function assertAbortInputProof(
  transfer: DeferredForegroundTransfer,
  terminalInputNotStartedAt?: string
): boolean {
  const dispatchIntentWasProvedNotStarted =
    transfer.status === "dispatch_started" &&
    transfer.input_stage === "dispatch_started" &&
    terminalInputNotStartedAt !== undefined &&
    Number.isFinite(Date.parse(terminalInputNotStartedAt));
  if (
    terminalInputNotStartedAt !== undefined &&
    !dispatchIntentWasProvedNotStarted
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} cannot attach ` +
      "terminal-input-not-started proof to its current stage"
    );
  }
  return dispatchIntentWasProvedNotStarted;
}

function deferredTransferLedger(
  transfer: DeferredForegroundTransfer,
  observedLedger: Record<string, any> | undefined,
  previousDispatchStillCurrent: boolean
): Record<string, any> | undefined {
  // Before this transfer publishes its own ordinary dispatch ledger, the
  // terminal may still carry the exact resolved history that was snapshot into
  // the immutable transfer receipt. Treat only that exact fingerprint (or the
  // exact persisted `none`) as no new dispatch; every other change must prove
  // this transfer's own ledger below or fail closed.
  if (!previousDispatchStillCurrent && !observedLedger) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} previous dispatch ` +
      "snapshot disappeared before its own ledger was published"
    );
  }
  return previousDispatchStillCurrent
    ? undefined
    : observedLedger;
}

function abortBeforeTurnPreparation(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: AbortPreparedDeferredTurnInput,
  ledger: Record<string, any> | undefined
): boolean {
  const { options, scope, transfer, boundary } = input;
  if (!transfer.state_path) {
    if (ledger) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} has a dispatch ` +
        "before its Turn authority was prepared"
      );
    }
    ports.application.abortBeforeInput({
      options,
      scope,
      boundary,
      reason: "recovered before target Turn preparation"
    });
    return true;
  }
  return false;
}

function abortMissingDeferredTurn(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: AbortPreparedDeferredTurnInput,
  facts: {
    ledger: Record<string, any> | undefined;
    statePath: string;
    dispatchIntentWasProvedNotStarted: boolean;
  }
): boolean {
  const { options, scope, storeDir, terminal, transfer, boundary } = input;
  const { ledger, statePath, dispatchIntentWasProvedNotStarted } = facts;
  if (!fs.existsSync(statePath)) {
    if (dispatchIntentWasProvedNotStarted) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} lost its Turn ` +
        "before terminal-input-not-started proof became durable"
      );
    }
    if (ledger) {
      // runTerminalControlSend publishes the exact prepared terminal ledger
      // before its Turn state.  A crash in that narrow window still proves
      // zero input, provided every immutable ledger field matches this
      // transfer. Resolve that owner before aborting/restoring the Sessions.
      assertDeferredForegroundLedgerAuthority(ports, {
        storeDir,
        terminal,
        transfer,
        ledger,
        statePath
      });
      if (!["prepared", "resolved"].includes(String(ledger.status))) {
        throw new Error(
          `deferred foreground transfer ${transfer.transfer_id} has ` +
          `${String(ledger.status)} transport evidence but no exact Turn state`
        );
      }
      if (ledger.status === "prepared") {
        const abortedAt = cliNow().toISOString();
        ports.ledger.save(terminal.terminalControl, {
          ...ledger,
          status: "resolved",
          aborted_at: abortedAt,
          safe_to_retry: true,
          resolved_at: abortedAt,
          dispatcher_pid: null,
          reason:
            "deferred dispatcher exited after ledger prepare and before Turn persistence"
        });
      } else {
        assertDeferredForegroundResolvedZeroInputLedger(ports, {
          storeDir,
          terminal,
          transfer,
          ledger,
          statePath
        });
      }
      if (
        cliEnv().AKK_TEST_EXIT_AFTER_DEFERRED_LEDGER_ABORT_WITHOUT_STATE === "1"
      ) {
        // The zero-input top-level and append-only ledger receipts are both
        // durable, while the transfer still fences both Sessions. A second
        // writer must accept this exact resolved form and finish Store-only
        // rollback without creating or replaying a Turn.
        cliExit(86);
      }
    }
    ports.application.abortBeforeInput({
      options,
      scope,
      boundary,
      reason: ledger
        ? "recovered exact prepared ledger before target Turn state became durable"
        : "recovered before target Turn state became durable"
    });
    return true;
  }
  return false;
}

function persistDeferredTurnAbortReceipts(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: AbortPreparedDeferredTurnInput,
  facts: {
    ledger: Record<string, any> | undefined;
    dispatchIntentWasProvedNotStarted: boolean;
  }
): void {
  const { storeDir, terminal, transfer, terminalInputNotStartedAt } = input;
  const authority = loadDeferredForegroundTurnAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    scope: input.scope
  });
  const submissionStatus = String(authority.submission.status);
  assertAbortLedger(ports, input, authority, facts.ledger, submissionStatus);
  const durableNotStartedAt = reconcileTurnAbortProof(
    transfer,
    authority.submission,
    submissionStatus,
    terminalInputNotStartedAt,
    facts.dispatchIntentWasProvedNotStarted
  );
  persistTurnAbort(ports, transfer, authority, submissionStatus,
    durableNotStartedAt);
  assertResolvedAbortLedgerProof(
    transfer,
    facts.ledger,
    durableNotStartedAt,
    facts.dispatchIntentWasProvedNotStarted
  );
  persistAbortLedger(ports, terminal, facts.ledger, durableNotStartedAt);
}

function assertAbortLedger(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: AbortPreparedDeferredTurnInput,
  authority: DeferredForegroundTurnAuthority,
  ledger: Record<string, any> | undefined,
  submissionStatus: string
): void {
  const { storeDir, terminal, transfer } = input;
  if (!ledger && submissionStatus !== "aborted") {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has prepared Turn ` +
      "state without its exact terminal ledger"
    );
  }
  if (!ledger) return;
  assertDeferredForegroundLedgerAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    ledger,
    statePath: authority.statePath,
    expectedMessageBodyHash: stringValue(authority.submission.message_body_hash)
  });
  if (!["prepared", "resolved"].includes(String(ledger.status))) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has ` +
      `${String(ledger.status)} transport evidence and cannot be aborted`
    );
  }
}

function reconcileTurnAbortProof(
  transfer: DeferredForegroundTransfer,
  submission: Record<string, any>,
  submissionStatus: string,
  terminalInputNotStartedAt: string | undefined,
  dispatchIntentWasProvedNotStarted: boolean
): string | undefined {
  if (!dispatchIntentWasProvedNotStarted || submissionStatus !== "aborted") {
    return terminalInputNotStartedAt;
  }
  const existingAbortedAt = stringValue(submission.aborted_at);
  if (
    submission.safe_to_retry !== true || !existingAbortedAt ||
    !Number.isFinite(Date.parse(existingAbortedAt)) ||
    stringValue(submission.text_injected_at) !== undefined ||
    stringValue(submission.enter_dispatched_at) !== undefined ||
    stringValue(submission.agent_accepted_at) !== undefined ||
    (terminalInputNotStartedAt !== undefined &&
      terminalInputNotStartedAt !== existingAbortedAt)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has ` +
      "inconsistent terminal-input-not-started Turn proof"
    );
  }
  return existingAbortedAt;
}

function persistTurnAbort(
  ports: DeferredForegroundRecoveryAdapterPorts,
  transfer: DeferredForegroundTransfer,
  authority: DeferredForegroundTurnAuthority,
  submissionStatus: string,
  durableNotStartedAt?: string
): void {
  if (submissionStatus !== "prepared") {
    if (submissionStatus === "aborted") return;
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} Turn has ` +
      `${submissionStatus} input evidence and cannot be aborted`
    );
  }
  const abortedAt = durableNotStartedAt ?? cliNow().toISOString();
  const aborted = ports.turn.withSubmission({
    conversation: {
      ...authority.conversation,
      status: "failed",
      failed_at: abortedAt,
      failure_reason: "dispatcher exited before the deferred terminal-input boundary",
      updated_at: abortedAt
    },
    messageId: deferredForegroundActiveMessageId(transfer) as string,
    messageType: "task",
    requestText: String(authority.takeover.terminal_bridge_request_text ?? ""),
    status: "aborted",
    preparedAt: stringValue(authority.submission.prepared_at) ?? abortedAt,
    abortedAt,
    error: "dispatcher exited before terminal input",
    safeToRetry: true
  });
  saveState(authority.statePath, aborted);
}

function assertResolvedAbortLedgerProof(
  transfer: DeferredForegroundTransfer,
  ledger: Record<string, any> | undefined,
  durableNotStartedAt: string | undefined,
  dispatchIntentWasProvedNotStarted: boolean
): void {
  if (!dispatchIntentWasProvedNotStarted || ledger?.status !== "resolved") {
    return;
  }
  if (
    ledger.safe_to_retry !== true ||
    stringValue(ledger.aborted_at) !== durableNotStartedAt ||
    stringValue(ledger.text_injected_at) !== undefined ||
    stringValue(ledger.enter_dispatched_at) !== undefined ||
    stringValue(ledger.agent_accepted_at) !== undefined
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has ` +
      "inconsistent terminal-input-not-started ledger proof"
    );
  }
}

function persistAbortLedger(
  ports: DeferredForegroundRecoveryAdapterPorts,
  terminal: TerminalDispatchTerminal,
  ledger: Record<string, any> | undefined,
  durableNotStartedAt?: string
): void {
  if (!ledger || ledger.status === "resolved") return;
  const abortedAt = durableNotStartedAt ?? cliNow().toISOString();
  ports.ledger.save(terminal.terminalControl, {
    ...ledger,
    status: "resolved",
    aborted_at: abortedAt,
    safe_to_retry: true,
    resolved_at: abortedAt,
    dispatcher_pid: null,
    reason: "deferred dispatcher exited before the durable terminal-input boundary"
  });
}

interface RecoverAcceptedDeferredDispatchInput {
  options: Record<string, any>;
  scope: DeferredForegroundApplicationScope;
  storeDir: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
  boundary: DeferredCodexForegroundBindingBoundary;
}

interface RecoveredAcceptance {
  identity: NativeAgentSessionIdentity;
  evidence: TerminalSubmissionAcceptanceEvidence;
}

export async function recoverAcceptedDeferredForegroundDispatch(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput
): Promise<boolean> {
  const { options, scope, storeDir, terminal, transfer, boundary } = input;
  assertActiveTurnRoute(scope, transfer);
  path.resolve(required(
    transfer.state_path,
    "deferred foreground Turn state path is unavailable"
  ));
  const authority = loadDeferredForegroundTurnAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    scope
  });
  const ledger = required(
    ports.ledger.load(terminal.terminalControl),
    `deferred foreground transfer ${transfer.transfer_id} has no exact ` +
      "terminal dispatch ledger for acceptance recovery"
  );
  assertAcceptanceRecoveryAuthority(ports, input, authority, ledger);
  const recovered = await observeRecoveredAcceptance(
    ports,
    input,
    authority.anchor
  );
  if (!recovered) return false;
  validateAcceptedLedger(ledger, transfer, recovered.identity);
  const acceptedAt = cliNow().toISOString();
  const acceptedConversation = acceptedDeferredConversation(
    ports,
    authority,
    transfer,
    recovered,
    acceptedAt
  );
  const callbackRouteLedgerFields = callbackRouteFingerprintLedgerFields({
    receipt: terminalBridgeSubmission(acceptedConversation),
    ledger,
    context: "deferred foreground acceptance"
  });
  let acceptedStatePersisted = false;
  // Turn acceptance is stronger than every Session/ledger write that follows.
  saveState(authority.statePath, acceptedConversation);
  acceptedStatePersisted = true;
  if (cliEnv().AKK_TEST_EXIT_AFTER_DEFERRED_ACCEPTED_TURN === "1") cliExit(86);
  return commitRecoveredAcceptance(ports, input, {
    authority,
    ledger,
    recovered,
    acceptedAt,
    acceptedConversation,
    callbackRouteLedgerFields,
    acceptedStatePersisted
  });
}

function assertAcceptanceRecoveryAuthority(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  authority: DeferredForegroundTurnAuthority,
  ledger: Record<string, any>
): void {
  const { storeDir, terminal, transfer } = input;
  assertDeferredForegroundLedgerAuthority(ports, {
    storeDir,
    terminal,
    transfer,
    ledger,
    statePath: authority.statePath,
    expectedMessageBodyHash: stringValue(authority.submission.message_body_hash)
  });
  ports.authority.assertFrozen({
    storeDir,
    transfer,
    terminalControl: terminal.terminalControl
  });
  if (!DEFERRED_ACCEPTANCE_RECOVERY_STATUSES.has(String(ledger.status))) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has invalid ` +
      `${String(ledger.status)} dispatch evidence for acceptance recovery`
    );
  }
}

async function observeRecoveredAcceptance(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  anchor: CodexRolloutAcceptanceAnchor
): Promise<RecoveredAcceptance | undefined> {
  const { options, terminal, transfer } = input;
  if (anchor.version === 3) {
    const inventory = await ports.native.inventory({
      options,
      pid: transfer.process_pid,
      cwd: terminal.terminalControl.currentPath
    });
    const result = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: inventory,
      requestHash: transfer.request_hash
    });
    if (result.status === "uncertain") {
      throw new Error(
        `Codex candidate-set recovery is uncertain (${result.code}): ` +
        result.reason
      );
    }
    return result.status === "accepted"
      ? { identity: result.identity, evidence: result.evidence }
      : undefined;
  }
  const identity = await ports.native.identity({
    options,
    agent: "codex",
    pid: transfer.process_pid,
    cwd: terminal.terminalControl.currentPath
  });
  if (!identity) return undefined;
  const evidence = detectCodexRolloutAcceptance({
    anchor,
    currentIdentity: identity,
    requestHash: transfer.request_hash
  });
  return evidence ? { identity, evidence } : undefined;
}

function validateAcceptedLedger(
  ledger: Record<string, any>,
  transfer: DeferredForegroundTransfer,
  identity: NativeAgentSessionIdentity
): void {
  if (ledger.status !== "agent_accepted") return;
  validateTerminalSubmissionAcceptanceEvidence(
    ledger.acceptance_evidence,
    {
      source: "codex_rollout",
      nativeThreadId: identity.sessionId,
      requestHash: transfer.request_hash
    }
  );
}

function acceptedDeferredConversation(
  ports: DeferredForegroundRecoveryAdapterPorts,
  authority: DeferredForegroundTurnAuthority,
  transfer: DeferredForegroundTransfer,
  recovered: RecoveredAcceptance,
  acceptedAt: string
): Conversation {
  return ports.turn.withSubmission({
    conversation: ports.turn.withIdentity({
      ...authority.conversation,
      status: "waiting_for_agent",
      stalled_at: undefined,
      stalled_reason: undefined,
      updated_at: acceptedAt
    }, recovered.identity),
    messageId: deferredForegroundActiveMessageId(transfer) as string,
    messageType: "task",
    requestText: String(authority.takeover.terminal_bridge_request_text ?? ""),
    status: "agent_accepted",
    preparedAt: deferredForegroundActivePreparedAt(transfer),
    textInjectedAt: deferredForegroundActiveTextInjectedAt(transfer) ??
      stringValue(authority.submission.text_injected_at),
    enterDispatchedAt: deferredForegroundActiveEnterDispatchedAt(transfer) ??
      stringValue(authority.submission.enter_dispatched_at),
    agentAcceptedAt: acceptedAt,
    acceptanceEvidence: recovered.evidence
  });
}

interface RecoveredCommitFacts {
  authority: DeferredForegroundTurnAuthority;
  ledger: Record<string, any>;
  recovered: RecoveredAcceptance;
  acceptedAt: string;
  acceptedConversation: Conversation;
  callbackRouteLedgerFields: {
    callback_route_fingerprint?: string | null;
  };
  acceptedStatePersisted: boolean;
}

async function commitRecoveredAcceptance(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  facts: RecoveredCommitFacts
): Promise<boolean> {
  let transferCommitted = false;
  try {
    await ports.application.commit({
      options: input.options,
      scope: input.scope,
      boundary: input.boundary,
      identity: facts.recovered.identity,
      acceptedAt: facts.acceptedAt
    });
    transferCommitted = true;
    ports.authority.assertTurnIdentity({
      conversation: facts.acceptedConversation,
      currentIdentity: facts.recovered.identity,
      operation: "recover deferred foreground binding for"
    });
    saveRecoveredAcceptanceLedger(ports, input, facts);
    return true;
  } catch (error) {
    recordRecoveredAcceptanceFailure(
      ports,
      input,
      facts,
      transferCommitted,
      error
    );
    throw error;
  }
}

function saveRecoveredAcceptanceLedger(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  facts: RecoveredCommitFacts
): void {
  const { terminal, transfer } = input;
  const textInjectedAt = deferredForegroundActiveTextInjectedAt(transfer);
  const enterDispatchedAt = deferredForegroundActiveEnterDispatchedAt(transfer);
  ports.ledger.save(terminal.terminalControl, {
    ...facts.ledger,
    ...ports.ledger.bindingFields(facts.acceptedConversation),
    status: "agent_accepted",
    generation_id: deferredForegroundActiveMessageId(transfer),
    conversation_id: facts.acceptedConversation.conversation_id,
    session_id: transfer.target_session_id,
    turn_id: transfer.turn_id,
    message_id: deferredForegroundActiveMessageId(transfer),
    message_type: "task",
    request_hash: transfer.request_hash,
    prepared_at: deferredForegroundActivePreparedAt(transfer),
    ...(textInjectedAt ? { text_injected_at: textInjectedAt } : {}),
    ...(enterDispatchedAt ? { enter_dispatched_at: enterDispatchedAt } : {}),
    agent_accepted_at: facts.acceptedAt,
    acceptance_evidence: facts.recovered.evidence,
    dispatcher_pid: null,
    state_path: facts.authority.statePath,
    event_log_path: facts.authority.logPath,
    callback_expected: callbackExpectedForConversation(
      facts.acceptedConversation
    ),
    ...facts.callbackRouteLedgerFields,
    reason: "recovered exact deferred foreground request acceptance"
  });
}

function recordRecoveredAcceptanceFailure(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  facts: RecoveredCommitFacts,
  transferCommitted: boolean,
  error: unknown
): void {
  if (transferCommitted && !facts.acceptedStatePersisted) {
    saveMissingAcceptedStateFailure(ports, input, facts, error);
  } else if (transferCommitted) {
    saveAcceptedBookkeepingFailure(ports, input, facts, error);
  }
}

function saveMissingAcceptedStateFailure(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  facts: RecoveredCommitFacts,
  error: unknown
): void {
  const uncertainAt = cliNow().toISOString();
  const reason = "deferred Session transfer resolved but exact Turn identity " +
    `bookkeeping failed: ${error instanceof Error ? error.message : String(error)}`;
  const uncertainConversation = ports.turn.withSubmission({
    conversation: {
      ...facts.authority.conversation,
      status: "stalled",
      stalled_at: uncertainAt,
      stalled_reason: reason,
      updated_at: uncertainAt
    },
    messageId: deferredForegroundActiveMessageId(input.transfer) as string,
    messageType: "task",
    requestText: String(
      facts.authority.takeover.terminal_bridge_request_text ?? ""
    ),
    status: "uncertain",
    preparedAt: stringValue(facts.authority.submission.prepared_at) ??
      deferredForegroundActivePreparedAt(input.transfer),
    textInjectedAt: stringValue(facts.authority.submission.text_injected_at) ??
      deferredForegroundActiveTextInjectedAt(input.transfer) ??
        input.transfer.dispatch_started_at,
    enterDispatchedAt: stringValue(facts.authority.submission.enter_dispatched_at) ??
      deferredForegroundActiveEnterDispatchedAt(input.transfer) ??
        input.transfer.dispatch_started_at,
    uncertainAt,
    error: reason,
    lastProvenStage: "enter_dispatched",
    safeToRetry: false
  });
  saveState(facts.authority.statePath, uncertainConversation);
  ports.ledger.save(input.terminal.terminalControl, {
    ...facts.ledger,
    ...ports.ledger.bindingFields(uncertainConversation),
    status: "uncertain",
    uncertain_at: uncertainAt,
    dispatcher_pid: null,
    callback_expected: false,
    reason
  });
}

function saveAcceptedBookkeepingFailure(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: RecoverAcceptedDeferredDispatchInput,
  facts: RecoveredCommitFacts,
  error: unknown
): void {
  const stalledAt = cliNow().toISOString();
  const reason = "deferred transfer resolved, but exact accepted Turn bookkeeping " +
    `failed: ${error instanceof Error ? error.message : String(error)}`;
  saveState(facts.authority.statePath, {
    ...facts.acceptedConversation,
    status: "stalled",
    stalled_at: stalledAt,
    stalled_reason: reason,
    updated_at: stalledAt
  });
  try {
    ports.ledger.save(input.terminal.terminalControl, {
      ...facts.ledger,
      ...ports.ledger.bindingFields(facts.acceptedConversation),
      status: "uncertain",
      uncertain_at: stalledAt,
      last_proven_stage: "agent_accepted",
      acceptance_evidence: facts.recovered.evidence,
      dispatcher_pid: null,
      callback_expected: false,
      ...facts.callbackRouteLedgerFields,
      reason
    });
  } catch {
    // The exact accepted Turn remains authoritative if ledger bookkeeping fails.
  }
  runtimeLog("error", "deferred_acceptance_ledger_bookkeeping_failed", {
    transfer_id: input.transfer.transfer_id,
    turn_id: input.transfer.turn_id,
    state_path: facts.authority.statePath,
    error: error instanceof Error ? error.message : String(error)
  });
}

interface PersistCommittedAcceptanceInput {
  options: Record<string, any>;
  scope: DeferredForegroundApplicationScope;
  storeDir: string;
  terminal: TerminalDispatchTerminal;
  transfer: DeferredForegroundTransfer;
}

export async function persistCommittedDeferredForegroundTurnAcceptance(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: PersistCommittedAcceptanceInput
): Promise<{
  conversation: Conversation;
  identity: NativeAgentSessionIdentity;
}> {
  const { options, scope, storeDir, terminal, transfer } = input;
  const current = scope.loadTransfer(transfer.transfer_id);
  assertActiveTurnRoute(scope, current);
  const identity = committedDeferredIdentity(current, transfer.transfer_id);
  path.resolve(required(
    current.state_path,
    "deferred foreground Turn state path is unavailable"
  ));
  const authority = loadDeferredForegroundTurnAuthority(ports, {
    storeDir,
    terminal,
    transfer: current,
    scope
  });
  const ledger = required(
    ports.ledger.load(terminal.terminalControl),
    `deferred foreground transfer ${current.transfer_id} has no exact ` +
      "terminal dispatch ledger for committed recovery"
  );
  assertCommittedRecoveryLedger(ports, input, current, authority, ledger);
  const acceptance = await observeCommittedAcceptance(
    ports,
    { ...input, transfer: current },
    authority.anchor,
    identity
  );
  validateAcceptedLedger(ledger, current, identity);
  const acceptedConversation = acceptedDeferredConversation(
    ports,
    authority,
    current,
    { identity, evidence: acceptance },
    current.agent_accepted_at as string
  );
  const callbackRouteLedgerFields = callbackRouteFingerprintLedgerFields({
    receipt: terminalBridgeSubmission(acceptedConversation),
    ledger,
    context: "committed deferred foreground acceptance"
  });
  saveState(authority.statePath, acceptedConversation);
  saveCommittedAcceptanceLedger(ports, {
    terminal,
    transfer: current,
    authority,
    ledger,
    acceptance,
    acceptedConversation,
    callbackRouteLedgerFields
  });
  return { conversation: acceptedConversation, identity };
}

function committedDeferredIdentity(
  transfer: DeferredForegroundTransfer,
  expectedTransferId: string
): NativeAgentSessionIdentity {
  const binding = transfer.target_accepted_binding;
  if (
    transfer.status !== "committed" || !binding ||
    !transfer.target_native_thread_id || !transfer.agent_accepted_at
  ) {
    throw new Error(
      `deferred foreground transfer ${expectedTransferId} has no exact ` +
      "committed acceptance authority"
    );
  }
  const rollout = binding.native_process.rollout;
  const processUuid = binding.native_process.process_uuid;
  const processBirth = binding.native_process.process_birth;
  if (
    binding.native_thread_id !== transfer.target_native_thread_id ||
    processUuid !== transfer.process_uuid ||
    processBirth !== transfer.process_birth ||
    !isCompleteNativeRollout(rollout)
  ) {
    throw new Error(
      `deferred foreground transfer ${expectedTransferId} committed binding ` +
      "is incomplete"
    );
  }
  return {
    sessionId: transfer.target_native_thread_id,
    processUuid,
    processBirth,
    rollout,
    evidence: binding.native_process.evidence
  };
}

function assertCommittedRecoveryLedger(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: PersistCommittedAcceptanceInput,
  current: DeferredForegroundTransfer,
  authority: DeferredForegroundTurnAuthority,
  ledger: Record<string, any>
): void {
  assertDeferredForegroundLedgerAuthority(ports, {
    storeDir: input.storeDir,
    terminal: input.terminal,
    transfer: current,
    ledger,
    statePath: authority.statePath,
    expectedMessageBodyHash: stringValue(authority.submission.message_body_hash)
  });
  if (!DEFERRED_ACCEPTANCE_RECOVERY_STATUSES.has(String(ledger.status))) {
    throw new Error(
      `deferred foreground transfer ${current.transfer_id} has invalid ` +
      `${String(ledger.status)} dispatch evidence for committed recovery`
    );
  }
}

async function observeCommittedAcceptance(
  ports: DeferredForegroundRecoveryAdapterPorts,
  input: PersistCommittedAcceptanceInput,
  anchor: CodexRolloutAcceptanceAnchor,
  identity: NativeAgentSessionIdentity
): Promise<TerminalSubmissionAcceptanceEvidence> {
  let acceptance: TerminalSubmissionAcceptanceEvidence | undefined;
  if (anchor.version === 3) {
    const inventory = await ports.native.inventory({
      options: input.options,
      pid: input.transfer.process_pid,
      cwd: input.terminal.terminalControl.currentPath
    });
    const result = detectCodexCandidateSetRolloutAcceptance({
      anchor,
      currentInventory: inventory,
      requestHash: input.transfer.request_hash
    });
    if (result.status === "uncertain") {
      throw new Error(
        `Codex committed candidate acceptance is uncertain (${result.code}): ` +
        result.reason
      );
    }
    if (result.status === "accepted") {
      if (result.identity.sessionId !== identity.sessionId) {
        throw new Error(
          "committed candidate acceptance resolved to a different native thread"
        );
      }
      acceptance = result.evidence;
    }
  } else {
    acceptance = detectCodexRolloutAcceptance({
      anchor,
      currentIdentity: identity,
      requestHash: input.transfer.request_hash
    });
  }
  if (!acceptance) {
    throw new Error(
      `deferred foreground transfer ${input.transfer.transfer_id} cannot re-prove ` +
      "its exact request acceptance"
    );
  }
  return acceptance;
}

function saveCommittedAcceptanceLedger(
  ports: DeferredForegroundRecoveryAdapterPorts,
  facts: {
    terminal: TerminalDispatchTerminal;
    transfer: DeferredForegroundTransfer;
    authority: DeferredForegroundTurnAuthority;
    ledger: Record<string, any>;
    acceptance: TerminalSubmissionAcceptanceEvidence;
    acceptedConversation: Conversation;
    callbackRouteLedgerFields: {
      callback_route_fingerprint?: string | null;
    };
  }
): void {
  const { terminal, transfer, authority, ledger, acceptance,
    acceptedConversation, callbackRouteLedgerFields } = facts;
  ports.ledger.save(terminal.terminalControl, {
    ...ledger,
    ...ports.ledger.bindingFields(acceptedConversation),
    status: "agent_accepted",
    generation_id: deferredForegroundActiveMessageId(transfer),
    conversation_id: acceptedConversation.conversation_id,
    session_id: transfer.target_session_id,
    turn_id: transfer.turn_id,
    message_id: deferredForegroundActiveMessageId(transfer),
    message_type: "task",
    request_hash: transfer.request_hash,
    prepared_at: deferredForegroundActivePreparedAt(transfer),
    text_injected_at: deferredForegroundActiveTextInjectedAt(transfer) ??
      transfer.dispatch_started_at,
    enter_dispatched_at: deferredForegroundActiveEnterDispatchedAt(transfer) ??
      transfer.dispatch_started_at,
    agent_accepted_at: transfer.agent_accepted_at,
    acceptance_evidence: acceptance,
    dispatcher_pid: null,
    state_path: authority.statePath,
    event_log_path: authority.logPath,
    callback_expected: callbackExpectedForConversation(acceptedConversation),
    ...callbackRouteLedgerFields,
    reason: "recovered committed deferred foreground request acceptance"
  });
}

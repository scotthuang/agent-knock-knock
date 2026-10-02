/** Repair legacy collateral stalls only from exact completion, delivery, and owner evidence. */
import { listDeferredForegroundTransfers } from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from "./deferred-foreground-transfer-policy.js";
import {
  isSessionSendBlockingStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  appendEvent,
  listConversations,
  loadState,
  logPathForStatePath,
  saveState,
  withStoreWriterLeaseAsync
} from "./store.js";
import { readNdjsonLog } from "./transcript.js";
import type { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { cliNow, cliRuntimeLog } from "./cli-runtime-context.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import { terminalControlsShareIncarnation } from "./terminal-authority-policy.js";
import { terminalBridgeSubmission } from "./terminal-dispatch-receipt.js";
import { validTerminalMonitorTimestampMs } from "./terminal-monitor-decision-policy.js";
import { isRecord, nonBlankString } from "./value-guards.js";
import {
  type Release,
  COLLATERAL_STALL_REASON,
  type TerminalMonitorStateCliDependencies,
  type TerminalMonitorStateCliAdapter,
  type TerminalBridgeCollateralStallReconciliation,
  takeoverFor
} from "./terminal-monitor-state-contract.js";

interface TerminalBridgeCollateralRepairEvidence {
  uncertainMessageId: string;
  ownerConversationId: string;
  restoredStatus: "idle";
}

interface CollateralOwnerVerificationInput {
  conversation: Conversation;
  takeover: Record<string, unknown>;
  ownMessageId: string;
  completionClaim: Record<string, unknown>;
  callbackMessage: Record<string, unknown>;
  callbackMessageId: string;
  deliveredAt: string;
  claimedAt: string;
  fenceObservedAt: string;
  fenceAtMs: number;
  uncertainMessageId: string;
  control: TerminalControlRef;
  ownerListed: Conversation;
}

type CollateralRecoveryDependencies = {
  authority: Pick<TerminalMonitorStateCliDependencies["authority"], "terminalControlForConversation">;
};

export class TerminalMonitorCollateralRecovery {
  readonly #dependencies: CollateralRecoveryDependencies;
  readonly #stateFileLock: ReturnType<typeof createFileLockCliAdapter>;

  constructor(
    dependencies: CollateralRecoveryDependencies,
    stateFileLock: ReturnType<typeof createFileLockCliAdapter>
  ) {
    this.#dependencies = dependencies;
    this.#stateFileLock = stateFileLock;
  }

  #stallOtherConversations(input: {
    storeDir: string;
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): string[] {
    const stalledConversationIds: string[] = [];
    for (const listed of listConversations(input.storeDir)) {
      if (
        listed.conversation_id === input.currentConversationId ||
        !isSessionSendBlockingStatus(listed.status)
      ) {
        continue;
      }
      const listedTakeover = takeoverFor(listed);
      if (
        listedTakeover?.terminal_bridge !== true ||
        !terminalControlsShareIncarnation(
          terminalControlFromTakeover(listedTakeover),
          input.terminalControl
        )
      ) {
        continue;
      }
      const statePath = nonBlankString(listed.state_path);
      if (!statePath) {
        continue;
      }
      const release = this.#stateFileLock.acquire(`${statePath}.lock`);
      try {
        const current = loadState(statePath);
        const currentTakeover = takeoverFor(current);
        if (
          !isSessionSendBlockingStatus(current.status) ||
          currentTakeover?.terminal_bridge !== true ||
          !terminalControlsShareIncarnation(
            terminalControlFromTakeover(currentTakeover),
            input.terminalControl
          )
        ) {
          continue;
        }
        const stalledAt = cliNow().toISOString();
        const stalledConversation: Conversation = {
          ...current,
          status: "stalled",
          stalled_at: stalledAt,
          stalled_reason: COLLATERAL_STALL_REASON,
          native_session_takeover: {
            ...currentTakeover,
            terminal_bridge_uncertain_dispatch_fence: {
              message_id: input.uncertainMessageId,
              observed_at: stalledAt,
              previous_status: current.status
            }
          },
          updated_at: stalledAt
        };
        saveState(statePath, stalledConversation);
        try {
          appendEvent(logPathForStatePath(statePath), {
            ts: stalledAt,
            conversation_id: current.conversation_id,
            event: "terminal_bridge_stalled_by_uncertain_dispatch",
            terminal_control: input.terminalControl,
            uncertain_message_id: input.uncertainMessageId
          });
        } catch {
          // State plus the terminal ledger are the authoritative fence.
        }
        stalledConversationIds.push(current.conversation_id);
      } finally {
        release();
      }
    }
    return stalledConversationIds;
  }

  stallOther(
    input: Parameters<TerminalMonitorStateCliAdapter["stallOther"]>[0]
  ): string[] {
    return this.#stallOtherConversations(input);
  }

  #exactCollateralRepairEvidence(
    conversation: Conversation,
    storeDir: string
  ): TerminalBridgeCollateralRepairEvidence | undefined {
    const source = collateralSourceEvidence(conversation);
    if (!source) return undefined;
    const { uncertainMessageId } = source;
    const control = this.#dependencies.authority
      .terminalControlForConversation(conversation);
    if (!control) {
      return undefined;
    }
    const ownerCandidates = listConversations(storeDir).filter((candidate) => {
      if (candidate.conversation_id === conversation.conversation_id) {
        return false;
      }
      const candidateTakeover = takeoverFor(candidate);
      const candidateSubmission = terminalBridgeSubmission(candidate);
      return candidateTakeover?.terminal_bridge === true &&
        nonBlankString(candidateTakeover.terminal_bridge_message_id) ===
          uncertainMessageId &&
        nonBlankString(candidateSubmission?.message_id) === uncertainMessageId &&
        terminalControlsShareIncarnation(
          this.#dependencies.authority.terminalControlForConversation(candidate),
          control
        );
    });
    if (ownerCandidates.length !== 1) {
      return undefined;
    }
    return this.#verifyCollateralOwner({
      ...source,
      control,
      ownerListed: ownerCandidates[0]
    });
  }

  #verifyCollateralOwner(
    input: CollateralOwnerVerificationInput
  ): TerminalBridgeCollateralRepairEvidence | undefined {
    const ownerStatePath = nonBlankString(input.ownerListed.state_path);
    if (!ownerStatePath) {
      return undefined;
    }
    let owner: Conversation;
    let ownerEvents: Record<string, unknown>[];
    let events: Record<string, unknown>[];
    try {
      owner = loadState(ownerStatePath);
      ownerEvents = readNdjsonLog(
        nonBlankString(owner.event_log_path) ??
          logPathForStatePath(ownerStatePath)
      );
      const statePath = nonBlankString(input.conversation.state_path);
      if (!statePath) {
        return undefined;
      }
      events = readNdjsonLog(
        nonBlankString(input.conversation.event_log_path) ??
          logPathForStatePath(statePath)
      );
    } catch {
      return undefined;
    }
    const ownerTakeover = takeoverFor(owner);
    const ownerSubmission = terminalBridgeSubmission(owner);
    const ownerClosedAt = nonBlankString(owner.closed_at);
    const ownerClosedAtMs = validTerminalMonitorTimestampMs(ownerClosedAt);
    if (
      owner.conversation_id !== input.ownerListed.conversation_id ||
      owner.status !== "closed" ||
      !ownerClosedAt ||
      ownerClosedAtMs === undefined ||
      ownerClosedAtMs < input.fenceAtMs ||
      !nonBlankString(owner.close_reason) ||
      owner.updated_at !== ownerClosedAt ||
      ownerTakeover?.terminal_bridge !== true ||
      nonBlankString(ownerTakeover.terminal_bridge_message_id) !==
        input.uncertainMessageId ||
      ownerSubmission?.status !== "uncertain" ||
      nonBlankString(ownerSubmission.message_id) !== input.uncertainMessageId ||
      nonBlankString(ownerSubmission.session_id) !== sessionIdForConversation(owner) ||
      nonBlankString(ownerSubmission.turn_id) !== turnIdForConversation(owner) ||
      isRecord(ownerTakeover.terminal_bridge_uncertain_dispatch_fence) ||
      !terminalControlsShareIncarnation(
        this.#dependencies.authority.terminalControlForConversation(owner),
        input.control
      )
    ) {
      return undefined;
    }
    if (!this.#hasExactCollateralEvents(input, owner, ownerClosedAt, events,
      ownerEvents)) {
      return undefined;
    }
    return {
      uncertainMessageId: input.uncertainMessageId,
      ownerConversationId: owner.conversation_id,
      restoredStatus: "idle"
    };
  }

  #hasExactCollateralEvents(
    input: CollateralOwnerVerificationInput,
    owner: Conversation,
    ownerClosedAt: string,
    events: Record<string, unknown>[],
    ownerEvents: Record<string, unknown>[]
  ): boolean {
    const hasCompletionClaim = events.some((event) =>
      event.event === "terminal_bridge_completion_claimed" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.terminal_bridge_message_id === input.ownMessageId &&
      event.callback_message_id === input.callbackMessageId &&
      event.completion_fingerprint === input.completionClaim.completion_fingerprint &&
      event.completion_id === input.completionClaim.completion_id &&
      event.outcome === "success" &&
      event.ts === input.claimedAt
    );
    const hasCompletionDetected = events.some((event) =>
      event.event === "terminal_bridge_completion_detected" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.terminal_bridge_message_id === input.ownMessageId &&
      event.callback_message_id === input.callbackMessageId &&
      event.completion_id === input.completionClaim.completion_id &&
      event.completion_outcome === "success" &&
      validTerminalMonitorTimestampMs(event.ts) !== undefined &&
      (validTerminalMonitorTimestampMs(event.ts) as number) <= input.fenceAtMs
    );
    const hasDeliveredCallback = events.some((event) =>
      event.event === "callback_delivery_succeeded" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.message_id === input.callbackMessageId &&
      event.status === "idle" &&
      event.ts === input.deliveredAt
    );
    const hasExactFence = events.some((event) =>
      event.event === "terminal_bridge_stalled_by_uncertain_dispatch" &&
      event.conversation_id === input.conversation.conversation_id &&
      event.uncertain_message_id === input.uncertainMessageId &&
      event.ts === input.fenceObservedAt
    );
    const hasExactOwnerClose = ownerEvents.some((event) =>
      event.event === "conversation_closed" &&
      event.conversation_id === owner.conversation_id &&
      event.status === "closed" &&
      event.ts === ownerClosedAt &&
      event.reason === owner.close_reason
    );
    return hasCompletionClaim && hasCompletionDetected &&
      hasDeliveredCallback && hasExactFence && hasExactOwnerClose;
  }

  async reconcileCollateral(
    storeDir: string,
    conversationId?: string
  ): Promise<TerminalBridgeCollateralStallReconciliation> {
    return withStoreWriterLeaseAsync(storeDir, async () =>
      this.#reconcileCollateralLocked(storeDir, conversationId));
  }

  #reconcileCollateralLocked(
    storeDir: string,
    conversationId?: string
  ): TerminalBridgeCollateralStallReconciliation {
    const reservedSourceTurnIds = new Set(
      listDeferredForegroundTransfers(storeDir)
        .filter((transfer) =>
          transfer.version === 2 &&
          transfer.source_kind === "candidate_rollout_quiescent" &&
          !isFinalDeferredForegroundTransferStatus(transfer.status)
        )
        .flatMap((transfer) =>
          (transfer.source_turn_history ?? []).map((turn) => turn.turn_id)
        )
    );
    const candidates = listConversations(storeDir).filter((conversation) => {
      const takeover = takeoverFor(conversation);
      return (
        conversationId === undefined ||
        conversation.conversation_id === conversationId
      ) &&
        !reservedSourceTurnIds.has(turnIdForConversation(conversation)) &&
        conversation.status === "stalled" &&
        isRecord(takeover?.terminal_bridge_uncertain_dispatch_fence);
    });
    const result: TerminalBridgeCollateralStallReconciliation = {
      checked: candidates.length,
      repaired: 0,
      skipped: 0,
      errors: [],
      items: []
    };
    for (const listed of candidates) {
      this.#reconcileCollateralCandidate(storeDir, listed, result);
    }
    return result;
  }

  #reconcileCollateralCandidate(
    storeDir: string,
    listed: Conversation,
    result: TerminalBridgeCollateralStallReconciliation
  ): void {
    const statePath = nonBlankString(listed.state_path);
    if (!statePath) {
      result.skipped += 1;
      return;
    }
    let release: Release | undefined;
    try {
      release = this.#stateFileLock.acquire(`${statePath}.lock`);
      const current = loadState(statePath);
      const evidence = this.#exactCollateralRepairEvidence(current, storeDir);
      if (!evidence) {
        result.skipped += 1;
        return;
      }
      const repaired = this.#persistCollateralRepair(
        statePath,
        current,
        evidence
      );
      result.repaired += 1;
      result.items.push(repaired);
    } catch (error) {
      result.skipped += 1;
      const reason = error instanceof Error ? error.message : String(error);
      result.errors.push(`${listed.conversation_id}: ${reason}`);
      result.items.push({
        conversation_id: listed.conversation_id,
        status: "error",
        reason
      });
    } finally {
      release?.();
    }
  }

  #persistCollateralRepair(
    statePath: string,
    current: Conversation,
    evidence: TerminalBridgeCollateralRepairEvidence
  ): Record<string, unknown> {
    const takeover = { ...takeoverFor(current) };
    delete takeover.terminal_bridge_uncertain_dispatch_fence;
    const repairedAt = cliNow().toISOString();
    takeover.terminal_bridge_collateral_stall_repair = {
      repaired_at: repairedAt,
      uncertain_message_id: evidence.uncertainMessageId,
      uncertain_owner_conversation_id: evidence.ownerConversationId,
      restored_status: evidence.restoredStatus,
      evidence:
        "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
    };
    const conversation: Conversation = {
      ...current,
      status: evidence.restoredStatus,
      native_session_takeover: takeover,
      updated_at: repairedAt
    };
    delete conversation.stalled_at;
    delete conversation.stalled_reason;
    saveState(statePath, conversation);
    const eventWarning = this.#appendCollateralRepairEvent(
      statePath,
      current,
      evidence,
      repairedAt
    );
    return {
      conversation_id: current.conversation_id,
      status: "repaired",
      reason: "legacy_terminal_bridge_collateral_stall",
      uncertain_message_id: evidence.uncertainMessageId,
      uncertain_owner_conversation_id: evidence.ownerConversationId,
      restored_status: evidence.restoredStatus,
      ...(eventWarning ? { event_warning: eventWarning } : {})
    };
  }

  #appendCollateralRepairEvent(
    statePath: string,
    current: Conversation,
    evidence: TerminalBridgeCollateralRepairEvidence,
    repairedAt: string
  ): string | undefined {
    try {
      appendEvent(
        nonBlankString(current.event_log_path) ??
          logPathForStatePath(statePath),
        {
          ts: repairedAt,
          conversation_id: current.conversation_id,
          event: "terminal_bridge_collateral_stall_repaired",
          uncertain_message_id: evidence.uncertainMessageId,
          uncertain_owner_conversation_id: evidence.ownerConversationId,
          previous_status: "stalled",
          restored_status: evidence.restoredStatus,
          evidence:
            "foreign_uncertain_fence+completion_claim+delivered_callback+closed_owner"
        }
      );
      return undefined;
    } catch (error) {
      const warning = error instanceof Error ? error.message : String(error);
      cliRuntimeLog(
        "warn",
        "terminal_bridge_collateral_stall_repair_event_failed",
        {
          conversation_id: current.conversation_id,
          uncertain_message_id: evidence.uncertainMessageId,
          error: warning
        }
      );
      return warning;
    }
  }
}

/** Validate the source receipt before consulting any collateral owner. */
function collateralSourceEvidence(
  conversation: Conversation
): Omit<CollateralOwnerVerificationInput, "control" | "ownerListed"> | undefined {
  if (
    conversation.status !== "stalled" ||
    conversation.stalled_reason !== COLLATERAL_STALL_REASON
  ) {
    return undefined;
  }
  const takeover = takeoverFor(conversation);
  const fence = isRecord(takeover?.terminal_bridge_uncertain_dispatch_fence)
    ? takeover.terminal_bridge_uncertain_dispatch_fence
    : undefined;
  const uncertainMessageId = nonBlankString(fence?.message_id);
  const fenceObservedAt = nonBlankString(fence?.observed_at);
  const previousStatus = nonBlankString(fence?.previous_status);
  const ownMessageId = nonBlankString(takeover?.terminal_bridge_message_id);
  const ownSubmission = terminalBridgeSubmission(conversation);
  const completionClaim = isRecord(takeover?.terminal_bridge_completion_claim)
    ? takeover.terminal_bridge_completion_claim
    : undefined;
  const callbackDelivery = isRecord(conversation.callback_delivery)
    ? conversation.callback_delivery
    : undefined;
  const callbackMessage = isRecord(callbackDelivery?.message)
    ? callbackDelivery.message
    : undefined;
  const idleSince = nonBlankString(conversation.idle_since);
  const deliveredAt = nonBlankString(callbackDelivery?.delivered_at);
  const claimedAt = nonBlankString(completionClaim?.claimed_at);
  const fenceAtMs = validTerminalMonitorTimestampMs(fenceObservedAt);
  const idleAtMs = validTerminalMonitorTimestampMs(idleSince);
  const deliveredAtMs = validTerminalMonitorTimestampMs(deliveredAt);
  const claimedAtMs = validTerminalMonitorTimestampMs(claimedAt);
  if (
    takeover?.terminal_bridge !== true ||
    !uncertainMessageId ||
    !fenceObservedAt ||
    fenceAtMs === undefined ||
    uncertainMessageId === ownMessageId ||
    (previousStatus !== undefined && previousStatus !== "idle") ||
    conversation.stalled_at !== fenceObservedAt ||
    conversation.updated_at !== fenceObservedAt ||
    !idleSince ||
    idleAtMs === undefined ||
    idleAtMs > fenceAtMs ||
    !ownMessageId ||
    ownSubmission?.status !== "agent_accepted" ||
    nonBlankString(ownSubmission.message_id) !== ownMessageId ||
    nonBlankString(ownSubmission.session_id) !==
      sessionIdForConversation(conversation) ||
    nonBlankString(ownSubmission.turn_id) !== turnIdForConversation(conversation) ||
    !completionClaim ||
    nonBlankString(completionClaim.terminal_bridge_message_id) !== ownMessageId ||
    completionClaim.outcome !== "success" ||
    !claimedAt ||
    claimedAtMs === undefined ||
    claimedAtMs > fenceAtMs ||
    callbackDelivery?.status !== "delivered" ||
    callbackDelivery.final_status !== "idle" ||
    callbackDelivery.preserve_conversation_status !== true ||
    !callbackMessage ||
    !collateralCallbackMatchesSource(
      callbackMessage, completionClaim, conversation, ownMessageId
    ) ||
    !deliveredAt ||
    deliveredAtMs === undefined ||
    deliveredAtMs > fenceAtMs
  ) {
    return undefined;
  }
  return {
    conversation,
    takeover,
    ownMessageId,
    completionClaim,
    callbackMessage,
    callbackMessageId: nonBlankString(callbackMessage.id) as string,
    deliveredAt,
    claimedAt,
    fenceObservedAt,
    fenceAtMs,
    uncertainMessageId
  };
}

function collateralCallbackMatchesSource(
  callbackMessage: Record<string, unknown>,
  completionClaim: Record<string, unknown>,
  conversation: Conversation,
  ownMessageId: string
): boolean {
  return !(
    callbackMessage.type !== "done" ||
    callbackMessage.requires_response !== false ||
    nonBlankString(callbackMessage.id) !==
      nonBlankString(completionClaim.callback_message_id) ||
    nonBlankString(callbackMessage.conversation_id) !==
      conversation.conversation_id ||
    nonBlankString(callbackMessage.session_id) !==
      sessionIdForConversation(conversation) ||
    nonBlankString(callbackMessage.turn_id) !== turnIdForConversation(conversation) ||
    nonBlankString(
      isRecord(callbackMessage.metadata)
        ? callbackMessage.metadata.terminal_bridge_message_id
        : undefined
    ) !== ownMessageId
  );
}

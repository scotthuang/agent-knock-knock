import {
  isDeferredForegroundSubmissionRetryPending,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import type { Conversation } from "./protocol.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary
} from "./deferred-foreground-boundary.js";
import type { TerminalNativeIdentity } from
  "./terminal-binding-authority.js";

interface AcceptedTurn {
  conversation: Conversation;
  identity: TerminalNativeIdentity;
}

export interface DeferredForegroundRecoveryPorts {
  transaction: {
    writerScope(): DeferredForegroundApplicationScope;
    withTransferScope<Result>(
      transfer: DeferredForegroundTransfer,
      operation: (
        scope: DeferredForegroundApplicationScope
      ) => Promise<Result>
    ): Promise<Result>;
  };
  repository: {
    all(
      scope: DeferredForegroundApplicationScope
    ): DeferredForegroundTransfer[];
    matching(
      scope: DeferredForegroundApplicationScope
    ): DeferredForegroundTransfer[];
    load(
      scope: DeferredForegroundApplicationScope,
      transferId: string
    ): DeferredForegroundTransfer;
    markUncertain(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredForegroundBindingBoundary,
      reason: string
    ): DeferredForegroundTransfer;
  };
  recovery: {
    boundary(
      transfer: DeferredForegroundTransfer
    ): DeferredForegroundBindingBoundary;
    assertRoute(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer,
      boundary: DeferredForegroundBindingBoundary
    ): void;
    finalizeAbort(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer
    ): void;
    persistCommitted(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer
    ): Promise<AcceptedTurn>;
    crashAfterCommittedBackfill(): void;
    resolveCommitted(
      scope: DeferredForegroundApplicationScope,
      boundary: DeferredForegroundBindingBoundary
    ): Promise<void>;
    assertAcceptedTurn(accepted: AcceptedTurn): void;
    abortPrepared(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer,
      boundary: DeferredForegroundBindingBoundary,
      terminalInputNotStartedAt?: string
    ): void;
    durableInputNotStartedAt(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer
    ): string | undefined;
    recoverAccepted(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer,
      boundary: DeferredForegroundBindingBoundary
    ): Promise<boolean>;
    pendingAnchorVersion(
      scope: DeferredForegroundApplicationScope,
      transfer: DeferredForegroundTransfer
    ): number;
  };
  runtime: {
    terminalTarget: string;
    isStoreMutationLockTimeout(error: unknown): boolean;
  };
}

/**
 * Recovery ordering for one canonical terminal -> writer invocation.
 * Terminal/Store/Turn paths, raw locks, ledgers, bridge observations, and CLI
 * presentation remain behind the supplied ports.
 */
export class DeferredForegroundRecoveryService {
  readonly #ports: DeferredForegroundRecoveryPorts;

  constructor(ports: DeferredForegroundRecoveryPorts) {
    this.#ports = ports;
  }

  async recover(): Promise<void> {
    const writerScope = this.#ports.transaction.writerScope();
    const all = this.#ports.repository.all(writerScope);
    for (const aborted of all.filter((entry) =>
      entry.status === "aborted"
    )) {
      this.#ports.recovery.finalizeAbort(writerScope, aborted);
    }
    const matching = this.#ports.repository.matching(writerScope);
    const candidates = matching.filter((transfer) =>
      transfer.status !== "aborted" &&
      !isFinalDeferredForegroundTransferStatus(transfer.status)
    );
    if (candidates.length === 0) return;
    if (candidates.length !== 1) {
      throw new Error(
        `terminal ${this.#ports.runtime.terminalTarget} has multiple ` +
        "unresolved deferred foreground transfers; no terminal input was sent"
      );
    }
    const transfer = candidates[0];
    await this.#ports.transaction.withTransferScope(
      transfer,
      (scope) => this.#recoverCandidate(scope, transfer)
    );
  }

  async #recoverCandidate(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer
  ): Promise<void> {
    const boundary = this.#ports.recovery.boundary(transfer);
    this.#ports.recovery.assertRoute(scope, transfer, boundary);
    if (transfer.status === "committed") {
      await this.#recoverCommitted(scope, transfer, boundary);
      return;
    }
    if (["prepared", "source_reserved", "target_prepared"].includes(
      transfer.status
    )) {
      this.#ports.recovery.abortPrepared(scope, transfer, boundary);
      return;
    }
    if (!["dispatch_started", "uncertain"].includes(transfer.status)) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} has ` +
        `unsupported recovery status ${transfer.status}`
      );
    }
    await this.#recoverPossibleInput(scope, transfer, boundary);
  }

  async #recoverCommitted(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredForegroundBindingBoundary
  ): Promise<void> {
    const accepted = await this.#ports.recovery.persistCommitted(
      scope,
      transfer
    );
    this.#ports.recovery.crashAfterCommittedBackfill();
    await this.#ports.recovery.resolveCommitted(scope, boundary);
    this.#ports.recovery.assertAcceptedTurn(accepted);
  }

  async #recoverPossibleInput(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredForegroundBindingBoundary
  ): Promise<void> {
    const durableZeroInput =
      this.#ports.recovery.durableInputNotStartedAt(scope, transfer);
    if (durableZeroInput) {
      this.#ports.recovery.abortPrepared(
        scope,
        transfer,
        boundary,
        durableZeroInput
      );
      return;
    }
    let current = transfer;
    try {
      if (await this.#ports.recovery.recoverAccepted(
        scope,
        current,
        boundary
      )) {
        return;
      }
    } catch (error) {
      if (this.#ports.runtime.isStoreMutationLockTimeout(error)) throw error;
      current = this.#markFailedAcceptance(scope, current, boundary, error);
      throw new Error(
        `terminal ${this.#ports.runtime.terminalTarget} deferred foreground ` +
        `recovery failed closed: ${errorMessage(error)}`,
        { cause: error }
      );
    }
    const pendingCandidateSet =
      this.#ports.recovery.pendingAnchorVersion(scope, current) === 3;
    const pendingRetry = isDeferredForegroundSubmissionRetryPending(current);
    if (pendingCandidateSet && pendingRetry) {
      return;
    }
    if (current.status !== "uncertain") {
      if (pendingCandidateSet) return;
      current = this.#ports.repository.markUncertain(
        scope,
        boundary,
        "dispatcher exited after the conservative terminal-input boundary " +
          "without exact native request acceptance"
      );
    }
    throw new Error(
      `terminal ${this.#ports.runtime.terminalTarget} has deferred foreground ` +
      `transfer ${current.transfer_id} with an uncertain dispatch; do not ` +
      "retry or resolve its Turn outside dedicated recovery"
    );
  }

  #markFailedAcceptance(
    scope: DeferredForegroundApplicationScope,
    transfer: DeferredForegroundTransfer,
    boundary: DeferredForegroundBindingBoundary,
    error: unknown
  ): DeferredForegroundTransfer {
    const durable = this.#ports.repository.load(scope, transfer.transfer_id);
    if (durable.status !== "dispatch_started") return transfer;
    return this.#ports.repository.markUncertain(
      scope,
      boundary,
      "exact deferred acceptance recovery failed: " + errorMessage(error)
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const FINAL_DEFERRED_FOREGROUND_TRANSFER_STATUSES = new Set([
  "resolved",
  "abort_resolved",
  "user_abandoned"
]);

/** True once a transfer no longer blocks new AKK management operations. */
export function isFinalDeferredForegroundTransferStatus(status: unknown): boolean {
  return typeof status === "string" &&
    FINAL_DEFERRED_FOREGROUND_TRANSFER_STATUSES.has(status);
}

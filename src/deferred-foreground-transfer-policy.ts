const FINAL_DEFERRED_FOREGROUND_TRANSFER_STATUSES = new Set([
  "resolved",
  "abort_resolved",
  "user_abandoned"
]);

/** True only after a deferred foreground transfer no longer owns resources. */
export function isFinalDeferredForegroundTransferStatus(status: unknown): boolean {
  return typeof status === "string" &&
    FINAL_DEFERRED_FOREGROUND_TRANSFER_STATUSES.has(status);
}

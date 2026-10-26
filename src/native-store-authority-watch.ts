import { terminalControlEvidenceMatches, type TerminalControlRef } from "./terminal-control-ref.js";
import { listTerminalWatches, type TerminalWatch } from "./terminal-watch-store.js";
import { cliEnv } from "./cli-runtime-context.js";
import { captureStoreOwnerIdentity } from "./store-owner-identity.js";
import { registerStoreOwnerIdentity } from "./store-owner-registry.js";
import { withStoreWriterLease } from "./store.js";

/** Register the creating Host atomically with the Watch's durable authority. */
export function withNativeAuthorityWatchOwner<T>(storeDir: string, create: () => T): T {
  return withStoreWriterLease(storeDir, () => {
    registerStoreOwnerIdentity(captureStoreOwnerIdentity(storeDir, cliEnv()));
    return create();
  });
}

function watchNativeThreadId(watch: TerminalWatch): string | undefined {
  const anchor = watch.anchor;
  if (anchor.schema === "agent-knock-knock/claude-human-started-active-task-anchor") return anchor.session_id;
  if (anchor.schema === "agent-knock-knock/claude-user-explicit-fallback-watch-anchor") return anchor.transcript_anchor.session_id;
  if (anchor.schema === "agent-knock-knock/codex-human-started-active-task-anchor" ||
    anchor.schema === "agent-knock-knock/codex-paginated-task-anchor") return anchor.native_thread_id;
  if (anchor.schema !== "agent-knock-knock/codex-user-explicit-fallback-watch-anchor") return undefined;
  const checkpoint = watch.observation_checkpoint;
  if ("schema" in checkpoint && checkpoint.schema === "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint") {
    const accepted = checkpoint.accepted_identity?.native_thread_id;
    if (accepted) return accepted;
  }
  return anchor.acceptance_anchor.version === 1 ? anchor.acceptance_anchor.native_thread_id : undefined;
}

/** Read only: a transfer must retain outstanding Watch observation/callback ownership. */
export function hasOutstandingNativeAuthorityWatch(input: {
  storeDir: string;
  terminalControl: TerminalControlRef;
  nativeThreadId?: string;
}): boolean {
  return listTerminalWatches(input.storeDir).some(watch => {
    const nativeThreadId = watchNativeThreadId(watch);
    const related = nativeThreadId && input.nativeThreadId
      ? nativeThreadId.toLowerCase() === input.nativeThreadId.toLowerCase()
      : terminalControlEvidenceMatches(watch.terminal.terminal_endpoint, input.terminalControl);
    return related && (watch.status === "active" || watch.notification_outbox.some(notification =>
      notification.status !== "delivered" && notification.status !== "superseded"));
  });
}

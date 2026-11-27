import { ClaudeNativeError, createClaudeNativeConversationId, type ClaudeNativeCatalogEntry } from "./claude-native-identity.js";
import type { ClaudeNativeSnapshot } from "./claude-native-observation.js";

/** Read-only Watch admission; never grants input or peer-message acceptance. */
export function claudeNativeWatchAdmission(entry: ClaudeNativeCatalogEntry, snapshot: ClaudeNativeSnapshot) {
  const current = snapshot.currentTask === undefined
    ? snapshot.selectedInput?.inputUuid === snapshot.latestInputUuid && snapshot.selectedInput
      ? { input: snapshot.selectedInput, progress: snapshot.progress } : null
    : snapshot.currentTask;
  const reason = createClaudeNativeConversationId(entry) !== createClaudeNativeConversationId(snapshot.identity)
    ? "identity_mismatch" : snapshot.readError
      ?? (!current ? "causal_task_owner_unproven"
        : current.input.kind !== "root_user" ? "input_is_not_root_task"
          : current.input.state !== "inProgress" ? current.input.reason ?? "task_not_active"
            : !["working", "waiting"].includes(entry.status) ? "registry_task_not_active" : undefined);
  if (reason || !current) return { ready: false as const, reason: reason ?? "causal_task_owner_unproven",
    fallbackAllowed: reason !== "identity_mismatch" };
  return { ready: true as const, ...current };
}
export function claudeWatchRefusal(reason: string, fallback: string): ClaudeNativeError {
  return new ClaudeNativeError("task_anchor_unavailable",
    `Claude Watch exact task unavailable: ${reason}; terminal_activity fallback: ${fallback}. Refresh List/Status and use an exact live terminal; no input was sent.`);
}

// In-process routing evidence, not a public flag that can bypass native checks.
const activityRoute = Symbol("verifiedClaudeWatchActivityRoute");
export interface ClaudeWatchActivityRoute { nativeId: string; reason: string }
export function markClaudeWatchActivity(value: object, route: ClaudeWatchActivityRoute): void {
  Object.assign(value, { [activityRoute]: route });
}
export function claudeWatchActivity(value: object): ClaudeWatchActivityRoute | undefined {
  return (value as { [activityRoute]?: ClaudeWatchActivityRoute })[activityRoute];
}

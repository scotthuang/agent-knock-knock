import path from "node:path";
import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import type { DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";
import { backendPublicProgress } from "./backend-public-progress.js";
import { desktopFinalAnswer } from "./desktop-final-answer.js";

type OwnerProof = { ownerId: string; endpointId: string };

/** The shared reader may serve older disk history. Bind it to a Desktop writer on both sides of the read. */
export function createDesktopPersistedTurnReader(
  verifyOwner: (target: DesktopThreadIdentity) => Promise<OwnerProof>,
  readHistory: (target: DesktopThreadIdentity) => Promise<{ cwd: string; latestTurn: DesktopTurn | null }>
) {
  return async (target: DesktopThreadIdentity, catalogCwd: string): Promise<DesktopTurn | null> => {
    const before = await verifyOwner(target);
    const history = await readHistory(target);
    const after = await verifyOwner(target);
    if (before.ownerId !== after.ownerId || before.endpointId !== after.endpointId || history.cwd !== catalogCwd) {
      throw new Error("Desktop writer, endpoint or working directory changed during the history read");
    }
    return history.latestTurn;
  };
}

export function canInspectDesktopHistory(identity: DesktopThreadIdentity, entry: DesktopCatalogEntry): entry is DesktopCatalogEntry & { cwd: string } {
  return identity.hostId === "local" && entry.localVerifiable && !entry.archived && identity.hostId === entry.hostId &&
    identity.threadId === entry.threadId && identity.codexHome === entry.codexHome && !!entry.cwd && path.isAbsolute(entry.cwd);
}

/** History gives no evidence of current composer contents, pending interactions, or idleness. */
export function desktopPersistedHistoryProjection(turn: DesktopTurn | null, readAt: string, originalRequester = false) {
  return {
    pending_interaction_count: null, pending_async_count: null,
    persisted_history: {
      source: "codex_app_server", scope: "latest_persisted_turn",
      latest_turn: turn ? { id: turn.turnId, status: turn.status, items_complete: turn.itemsComplete,
        ...(turn.status === "completed" && turn.itemsComplete ? desktopFinalAnswer(turn, originalRequester) : {}) } : null,
      progress: backendPublicProgress({ nativeTurnId: turn?.turnId ?? null, turn: turn ?? undefined, readAt })
    }
  };
}

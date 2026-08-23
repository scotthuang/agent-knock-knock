import path from "node:path";

import {
  saveDeferredForegroundTransfer,
  tryLoadDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import {
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import {
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface DeferredForegroundUserCloseCleanupResult {
  transfer_id?: string;
  transfer_finalized: boolean;
  detached_session_ids: string[];
  warnings: string[];
}

/**
 * Release only AKK-owned metadata for one explicitly closed Turn. The linked
 * transfer is finalized before either Session is touched, so a Session cleanup
 * failure cannot keep the old transfer live. Missing, drifted, or concurrently
 * changed records are warnings: explicit Close owns the user-facing outcome.
 */
export function cleanupDeferredForegroundUserClose(input: {
  storeDir: string;
  conversation: Conversation;
  at: string;
}): DeferredForegroundUserCloseCleanupResult {
  const result: DeferredForegroundUserCloseCleanupResult = {
    transfer_finalized: false,
    detached_session_ids: [],
    warnings: []
  };
  const takeover = isRecord(input.conversation.native_session_takeover)
    ? input.conversation.native_session_takeover
    : undefined;
  const transferId = nonBlankString(
    takeover?.deferred_foreground_transfer_id
  );
  if (!transferId) {
    // Most managed Turns have no deferred transfer. There is nothing to
    // release in that case, and ordinary Close should not manufacture a
    // cleanup warning.
    return result;
  }
  result.transfer_id = transferId;

  let transfer: DeferredForegroundTransfer | undefined;
  try {
    transfer = tryLoadDeferredForegroundTransfer(input.storeDir, transferId);
  } catch (error) {
    result.warnings.push(warning("linked_transfer_unreadable", error));
    return result;
  }
  if (!transfer) {
    result.warnings.push(
      `linked_transfer_missing: deferred foreground transfer ${transferId} is absent`
    );
    return result;
  }
  let targetsExactTurn = false;
  try {
    targetsExactTurn = exactTargetTurn(input.conversation, transfer);
  } catch (error) {
    result.warnings.push(warning("linked_transfer_drift", error));
    return result;
  }
  if (!targetsExactTurn) {
    result.warnings.push(
      `linked_transfer_drift: deferred foreground transfer ${transferId} ` +
      "does not target this exact Turn"
    );
    return result;
  }

  if (transfer.status === "user_abandoned") {
    result.transfer_finalized = true;
  } else if (
    transfer.status === "resolved" || transfer.status === "abort_resolved"
  ) {
    result.transfer_finalized = true;
  } else {
    const originStatus = transfer.status;
    try {
      transfer = saveDeferredForegroundTransfer(input.storeDir, {
        ...transfer,
        status: "user_abandoned",
        origin_status: originStatus,
        user_abandoned_at: input.at
      }, { expectedRevision: requiredRevision(transfer) });
      result.transfer_finalized = true;
    } catch (error) {
      result.warnings.push(warning("linked_transfer_conflict", error));
      return result;
    }
  }

  for (const sessionId of new Set([
    transfer.source_session_id,
    transfer.target_session_id
  ])) {
    detachExactTransferSession({
      storeDir: input.storeDir,
      sessionId,
      transfer,
      at: input.at,
      result
    });
  }
  return result;
}

function exactTargetTurn(
  conversation: Conversation,
  transfer: DeferredForegroundTransfer
): boolean {
  const statePath = nonBlankString(conversation.state_path);
  const transferStatePath = nonBlankString(transfer.state_path);
  return transfer.turn_id === turnIdForConversation(conversation) &&
    transfer.target_session_id === sessionIdForConversation(conversation) &&
    Boolean(
      statePath && transferStatePath &&
      path.resolve(statePath) === path.resolve(transferStatePath)
    );
}

function detachExactTransferSession(input: {
  storeDir: string;
  sessionId: string;
  transfer: DeferredForegroundTransfer;
  at: string;
  result: DeferredForegroundUserCloseCleanupResult;
}): void {
  let session;
  try {
    session = tryLoadManagedSession(input.storeDir, input.sessionId);
  } catch (error) {
    input.result.warnings.push(warning(
      `session_unreadable:${input.sessionId}`,
      error
    ));
    return;
  }
  if (!session) {
    input.result.warnings.push(
      `session_missing: managed Session ${input.sessionId} is absent`
    );
    return;
  }
  if (session.status === "detached") {
    return;
  }
  if (session.status !== "transitioning") {
    input.result.warnings.push(
      `session_drift: managed Session ${input.sessionId} is ${session.status}, ` +
      "so explicit Close preserved it instead of detaching a possible newer owner"
    );
    return;
  }
  if (session.last_transition_id !== input.transfer.transfer_id) {
    input.result.warnings.push(
      `session_drift: managed Session ${input.sessionId} is no longer owned ` +
      `by deferred foreground transfer ${input.transfer.transfer_id}`
    );
    return;
  }
  let exactAuthority = false;
  try {
    exactAuthority = exactTransferSessionAuthority(
      session,
      input.transfer,
      input.sessionId === input.transfer.source_session_id
        ? "source"
        : "target"
    );
  } catch (error) {
    input.result.warnings.push(warning(
      `session_drift:${input.sessionId}`,
      error
    ));
    return;
  }
  if (!exactAuthority) {
    input.result.warnings.push(
      `session_drift: managed Session ${input.sessionId} no longer matches ` +
      `deferred foreground transfer ${input.transfer.transfer_id}`
    );
    return;
  }
  try {
    saveManagedSession(input.storeDir, {
      ...session,
      status: "detached",
      detached_at: input.at,
      updated_at: input.at
    }, { expectedRevision: managedSessionRevision(session) });
    input.result.detached_session_ids.push(input.sessionId);
  } catch (error) {
    input.result.warnings.push(warning(
      `session_conflict:${input.sessionId}`,
      error
    ));
  }
}

function exactTransferSessionAuthority(
  session: ManagedSessionState,
  transfer: DeferredForegroundTransfer,
  role: "source" | "target"
): boolean {
  const revision = managedSessionRevision(session);
  if (role === "source") {
    const expectedRevision = Number(transfer.source_expected_revision);
    return Number.isSafeInteger(expectedRevision) &&
      revision === expectedRevision + 1 &&
      managedSessionBindingToken({
        ...session,
        status: "bound"
      }) === transfer.source_binding_token;
  }
  return revision === transfer.target_prepared_revision &&
    transfer.target_prepared_status === "transitioning" &&
    transfer.target_prepared_last_transition_id === transfer.transfer_id &&
    managedSessionBindingToken(session) ===
      transfer.target_prepared_binding_token;
}

function requiredRevision(transfer: DeferredForegroundTransfer): number {
  const revision = Number(transfer.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} has invalid revision`
    );
  }
  return revision;
}

function warning(code: string, error: unknown): string {
  return `${code}: ${error instanceof Error ? error.message : String(error)}`;
}

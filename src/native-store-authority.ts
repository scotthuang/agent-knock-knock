import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import { listDeferredForegroundTransfers } from "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from "./deferred-foreground-transfer-policy.js";
import type { ManagedSessionState } from "./managed-session.js";
import { listManagedSessions, listNativeThreadTransitions } from "./session-store.js";
import { listConversations, pathsForConversationDir, storeManifestPath } from "./store.js";
import { readJsonFileNoFollow } from "./durable-json-file.js";
import { hasOutstandingNativeAuthorityWatch } from "./native-store-authority-watch.js";
import { isSessionSendBlockingStatus, sessionIdForConversation } from "./protocol.js";
import { terminalControlEvidence, terminalControlEvidenceMatches, type TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalDispatchLedgerDocument } from "./terminal-dispatch-ledger-codec.js";
import { isStoreOwnerIdentity, storeOwnerKind } from "./store-owner-identity.js";
import { readStoreOwnerInventory, probeStoreOwnerInventory, type StoreOwnerInventory } from "./store-owner-registry.js";
import { nonBlankString, recordValue } from "./value-guards.js";

export interface NativeStoreAuthorityInspection {
  state: "none" | "current" | "conflict" | "transferring";
  reason?: string;
  sourceStoreDir?: string;
  sessionId?: string;
  generation?: number;
  fingerprint?: string;
  transferEligible: boolean;
  automaticEligible: boolean;
  ownerStatus: "alive" | "dead" | "unknown" | "legacy";
  session?: ManagedSessionState;
}

export function canonicalAuthorityStore(storeDir: string): string {
  const resolved = path.resolve(storeDir);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

export function nativeAuthorityStore(ledger: TerminalDispatchLedgerDocument): string | undefined {
  const stored = nonBlankString(ledger.store_dir);
  if (stored) return canonicalAuthorityStore(stored);
  const statePath = nonBlankString(ledger.state_path);
  if (!statePath) return undefined;
  try { return canonicalAuthorityStore(pathsForConversationDir(path.dirname(statePath)).storeDir); }
  catch { return undefined; }
}

export function nativeAuthorityThreadIds(ledger: TerminalDispatchLedgerDocument): string[] {
  const binding = recordValue(ledger.binding);
  return [ledger.native_thread_id, binding?.native_thread_id,
    ledger.before_native_thread_id, ledger.target_native_thread_id]
    .flatMap(value => nonBlankString(value)?.toLowerCase() ?? []);
}

/** A resolved dispatch releases the Turn, not this native thread's Store authority. */
export function nativeAuthorityWorkSettled(storeDir: string, session: ManagedSessionState): boolean {
  if (!["bound", "detached"].includes(session.status) || session.authority_transfer) return false;
  const turns = listConversations(storeDir).filter(turn => sessionIdForConversation(turn) === session.session_id);
  if (turns.some(turn => isSessionSendBlockingStatus(turn.status) ||
    recordValue(turn.approval_state)?.blocked === true ||
    [turn.callback_delivery, turn.callback_notification_delivery].some(hasUnsettledAuthorityCallback))) return false;
  if (listNativeThreadTransitions(storeDir).some(transition =>
    (transition.source_session_id === session.session_id || transition.target_session_id === session.session_id) &&
    !["committed", "aborted"].includes(transition.status))) return false;
  if (session.binding && hasOutstandingNativeAuthorityWatch({ storeDir,
    terminalControl: session.binding.terminal_control, nativeThreadId: session.binding.native_thread_id })) return false;
  // Conservatively wait for all Store transfers: a callback/deferred handoff may
  // carry authority indirectly through a Turn rather than the Session id.
  return !listDeferredForegroundTransfers(storeDir).some(transfer => !isFinalDeferredForegroundTransferStatus(transfer.status));
}

function hasUnsettledAuthorityCallback(value: unknown): boolean {
  const delivery = recordValue(value);
  return Boolean(delivery && !["delivered", "accepted", "superseded"].includes(String(delivery.status)));
}

export function nativeAuthorityFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Shared, read-only authority predicate for List, Status and mutation preflight. */
export function inspectNativeStoreAuthority(input: {
  ledger?: TerminalDispatchLedgerDocument;
  terminalControl: TerminalControlRef;
  nativeThreadId?: string;
  storeDir: string;
}): NativeStoreAuthorityInspection {
  const result: NativeStoreAuthorityInspection = {
    state: "none", ownerStatus: "legacy", transferEligible: false, automaticEligible: false
  };
  const ledger = input.ledger;
  if (!ledger) return result;
  const ids = nativeAuthorityThreadIds(ledger);
  if (!ids.length || input.nativeThreadId && !ids.includes(input.nativeThreadId.toLowerCase())) return result;
  const evidence = ledger.terminal_endpoint ?? ledger.terminal_control;
  if (!terminalControlEvidenceMatches(evidence, input.terminalControl, { requireProcessAnchor: false })) {
    return { ...result, state: "conflict", reason: "authority_terminal_identity_unverified" };
  }
  result.sourceStoreDir = nativeAuthorityStore(ledger);
  result.sessionId = nonBlankString(ledger.session_id ?? ledger.target_session_id);
  const authority = recordValue(ledger.store_authority);
  result.generation = Number(authority?.generation ?? 1);
  const transfer = recordValue(ledger.store_authority_transfer);
  const inProgress = transfer && transfer.phase !== "committed";
  result.state = inProgress ? "transferring" : result.sourceStoreDir === canonicalAuthorityStore(input.storeDir) ? "current" : "conflict";
  if (result.state === "current") return result;
  result.reason = inProgress ? "store_authority_transfer_incomplete" : "native_thread_authoritative_in_another_store";
  if (!result.sourceStoreDir || !result.sessionId) {
    result.reason = "authority_store_or_session_unverified";
    return result;
  }
  return inspectForeignStoreAuthority(input, ledger, result);
}

function inspectForeignStoreAuthority(
  input: Parameters<typeof inspectNativeStoreAuthority>[0],
  ledger: TerminalDispatchLedgerDocument,
  result: NativeStoreAuthorityInspection
): NativeStoreAuthorityInspection {
  const sourceStoreDir = result.sourceStoreDir!;
  const ids = nativeAuthorityThreadIds(ledger);
  const authority = recordValue(ledger.store_authority);
  const transfer = recordValue(ledger.store_authority_transfer);
  const inProgress = transfer && transfer.phase !== "committed";
  try {
    const inventory = readStoreOwnerInventory(sourceStoreDir);
    result.ownerStatus = inspectStoreAuthorityOwner(ledger.store_authority, inventory, sourceStoreDir);
    const sessions = listManagedSessions(sourceStoreDir);
    const session = sessions.find(value => value.session_id === result.sessionId);
    if (!session || !session.binding || !ids.includes(session.binding.native_thread_id?.toLowerCase() ?? "")) {
      result.reason = "authority_session_binding_unverified";
      return result;
    }
    result.session = session;
    result.fingerprint = nativeAuthorityFingerprint({ ledger, session, inventory: inventory.fingerprint,
      targetStore: canonicalAuthorityStore(input.storeDir), terminal: terminalControlEvidence(input.terminalControl) });
    if (inProgress) return inspectPendingTransfer(result, transfer, inventory.fingerprint, input.storeDir);
    if (ledger.status !== "resolved" || !nativeAuthorityWorkSettled(sourceStoreDir, session)) {
      result.reason = "authority_has_unresolved_work";
      return result;
    }
    if (["alive", "unknown"].includes(result.ownerStatus)) {
      result.reason = `authority_owner_${result.ownerStatus}`;
      return result;
    }
    result.transferEligible = true;
    result.automaticEligible = automaticOwnerEvidence(result, authority, inventory);
    return result;
  } catch {
    return { ...result, reason: "authority_evidence_unreadable", transferEligible: false, automaticEligible: false };
  }
}

function inspectStoreAuthorityOwner(value: unknown, inventory: StoreOwnerInventory,
  sourceStoreDir: string): NativeStoreAuthorityInspection["ownerStatus"] {
  const authority = recordValue(value);
  if (value !== undefined && (!authority || authority.version !== 1 || !isStoreOwnerIdentity(authority.owner))) return "unknown";
  if (authority && (canonicalAuthorityStore(String(authority.store_dir)) !== sourceStoreDir ||
    !inventory.owners.some(owner => canonicalJson(owner) === canonicalJson(authority.owner)))) return "unknown";
  if (!authority && inventory.reason === "owner_inventory_absent") return "legacy";
  const state = probeStoreOwnerInventory(inventory).state;
  if (state !== "dead") return state;
  const manifest = recordValue(readJsonFileNoFollow(storeManifestPath(sourceStoreDir), "Store manifest"));
  return !authority || authority.legacy_owner_coverage === true || manifest?.owner_registration !== "required" ? "legacy" : "dead";
}

function automaticOwnerEvidence(result: NativeStoreAuthorityInspection, authority: Record<string, unknown> | undefined,
  inventory: StoreOwnerInventory): boolean {
  return result.ownerStatus === "dead" && isStoreOwnerIdentity(authority?.owner) && inventory.complete &&
    inventory.owners.some(owner => canonicalJson(owner) === canonicalJson(authority.owner)) &&
    inventory.owners.every(owner => owner.store_kind === "ephemeral") &&
    storeOwnerKind(result.sourceStoreDir!, { AKK_EPHEMERAL_STORE: "1" }) === "ephemeral";
}

function inspectPendingTransfer(result: NativeStoreAuthorityInspection, transfer: Record<string, unknown>,
  inventoryFingerprint: string | null, storeDir: string): NativeStoreAuthorityInspection {
  if (transfer.source_inventory !== inventoryFingerprint) {
    result.reason = "authority_owner_registrations_changed";
    return result;
  }
  if (result.ownerStatus === "alive" || result.ownerStatus === "unknown" ||
    result.ownerStatus === "legacy" && transfer.legacy_acknowledged !== true) {
    result.reason = `authority_owner_${result.ownerStatus}`;
    return result;
  }
  result.transferEligible = canonicalAuthorityStore(String(transfer.target_store_dir)) === canonicalAuthorityStore(storeDir);
  return result;
}

export function assertNativeStoreAuthorityCurrent(input: Parameters<typeof inspectNativeStoreAuthority>[0]): void {
  const inspected = inspectNativeStoreAuthority(input);
  if (!["conflict", "transferring"].includes(inspected.state)) return;
  throw new Error(`terminal ${input.terminalControl.target} native thread is authoritative in another Store ` +
    `${inspected.sourceStoreDir ?? "(unverified)"}: ${inspected.reason}. Refresh AKK list and use its ` +
    "transfer_store_authority action (agent_knock_knock_reconcile_binding operation=transfer_store_authority). " +
    "Active or unverifiable owners must be stopped/repaired first; do not delete the Store or runtime ledger.");
}

import { randomUUID } from "node:crypto";
import { cliEnv } from "./cli-runtime-context.js";
import { canonicalJson } from "./canonical-json.js";
import { type ManagedSessionState } from "./managed-session.js";
import { loadManagedSession, saveManagedSession, listManagedSessions, tryLoadManagedSession } from "./session-store.js";
import { withStoreWriterLease } from "./store.js";
import { captureStoreOwnerIdentity, type StoreOwnerIdentity } from "./store-owner-identity.js";
import { readStoreOwnerInventory, registerStoreOwnerIdentity, probeStoreOwnerInventory } from "./store-owner-registry.js";
import { canonicalAuthorityStore, inspectNativeStoreAuthority, nativeAuthorityWorkSettled } from "./native-store-authority.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalDispatchLedgerDocument as Ledger } from "./terminal-dispatch-ledger-codec.js";
import type { TerminalDispatchRepositoryCliAdapter } from "./terminal-dispatch-repository-cli-adapter.js";
import { recordValue } from "./value-guards.js";

interface TransferJournal {
  version: 1;
  transfer_id: string;
  phase: "prepared" | "source_retired" | "target_created" | "committed";
  source_store_dir: string;
  target_store_dir: string;
  source_inventory: string | null;
  source_session: ManagedSessionState;
  target_session: ManagedSessionState;
  generation: number;
  automatic: boolean;
  legacy_acknowledged: boolean;
  started_at: string;
  initial_authority_token?: string;
  target_owner?: StoreOwnerIdentity;
}

export interface NativeStoreAuthorityTransferRequest {
  storeDir: string;
  terminalControl: TerminalControlRef;
  expectedAuthorityToken?: string;
  maintenanceAcknowledgement?: boolean;
  automatic?: boolean;
}

function readJournal(ledger: Ledger): TransferJournal | undefined {
  const journal = recordValue(ledger.store_authority_transfer);
  if (!journal || journal.phase === "committed") return undefined;
  if (journal.version !== 1 || !journal.source_session || !journal.target_session ||
    typeof journal.source_store_dir !== "string" || typeof journal.target_store_dir !== "string" ||
    typeof journal.transfer_id !== "string" || !["prepared", "source_retired", "target_created"].includes(String(journal.phase))) {
    throw new Error("Store authority transfer journal is invalid; preserve evidence and repair it before retrying");
  }
  return journal as unknown as TransferJournal;
}

function verifySourceOwner(journal: TransferJournal): void {
  const inventory = readStoreOwnerInventory(journal.source_store_dir);
  if (inventory.fingerprint !== journal.source_inventory) throw new Error("source Store owner registrations changed during transfer; no input sent");
  if (journal.legacy_acknowledged && inventory.reason === "owner_inventory_absent") return;
  if (probeStoreOwnerInventory(inventory).state !== "dead") throw new Error("source Store has an active or unverifiable owner; transfer refused; no input sent");
}

function prepareJournal(input: NativeStoreAuthorityTransferRequest, ledger: Ledger): TransferJournal {
  const inspection = inspectNativeStoreAuthority({ ...input, ledger });
  if (!inspection.transferEligible || !inspection.session || !inspection.sourceStoreDir) {
    throw new Error(`Store authority transfer refused: ${inspection.reason ?? inspection.state}; no input sent`);
  }
  if (input.automatic ? !inspection.automaticEligible : inspection.fingerprint !== input.expectedAuthorityToken) {
    throw new Error("Store authority changed or is not automatically reclaimable; refresh AKK list; no input sent");
  }
  if (inspection.ownerStatus === "legacy" && input.maintenanceAcknowledgement !== true) {
    throw new Error("legacy Store owner is unknown; stop all associated Hosts/writers, then explicitly supply maintenance_acknowledgement=true");
  }
  const source = inspection.session;
  const now = new Date().toISOString();
  const id = randomUUID();
  const target: ManagedSessionState = { ...source, revision: undefined, status: "bound",
    binding: { ...source.binding!, binding_id: randomUUID(), generation: source.binding!.generation + 1,
      bound_at: now, last_verified_at: now },
    updated_at: now, detached_at: undefined, quarantine_reason: undefined,
    authority_transfer: undefined,
    authority_received: { transfer_id: id, source_store_dir: inspection.sourceStoreDir, received_at: now } };
  return { version: 1, transfer_id: id, phase: "prepared", source_store_dir: inspection.sourceStoreDir,
    target_store_dir: canonicalAuthorityStore(input.storeDir),
    source_inventory: readStoreOwnerInventory(inspection.sourceStoreDir).fingerprint,
    source_session: source, target_session: JSON.parse(JSON.stringify(target)) as ManagedSessionState,
    generation: (inspection.generation ?? 1) + 1,
    automatic: input.automatic === true, legacy_acknowledged: inspection.ownerStatus === "legacy",
    started_at: now, initial_authority_token: input.expectedAuthorityToken };
}

export function completedNativeStoreAuthorityReceipt(input: NativeStoreAuthorityTransferRequest, ledger?: Ledger) {
  const journal = recordValue(ledger?.store_authority_transfer);
  if (!journal || journal.phase !== "committed" || journal.target_store_dir !== canonicalAuthorityStore(input.storeDir) ||
    (input.automatic ? journal.automatic !== true : !input.expectedAuthorityToken || input.expectedAuthorityToken !== journal.initial_authority_token)) return undefined;
  return { transferred: true as const, transfer_id: String(journal.transfer_id),
    session_id: String(recordValue(journal.target_session)?.session_id), store_dir: String(journal.target_store_dir) };
}

function targetAvailable(journal: TransferJournal): void {
  const existing = listManagedSessions(journal.target_store_dir);
  for (const session of existing) {
    if ((session.session_id === journal.target_session.session_id ||
      session.binding?.native_thread_id === journal.target_session.binding?.native_thread_id) &&
      session.authority_received?.transfer_id !== journal.transfer_id) {
      throw new Error("destination Store already has a competing Session; transfer refused");
    }
  }
}

/** Caller holds the shared terminal lock. Store leases are deliberately sequential. */
export function transferNativeStoreAuthorityWhileLocked(
  input: NativeStoreAuthorityTransferRequest, repository: TerminalDispatchRepositoryCliAdapter
): { transferred: true; transfer_id: string; session_id: string; store_dir: string } {
  let ledger = repository.load(input.terminalControl);
  if (!ledger || !repository.matchesControl(ledger, input.terminalControl)) {
    throw new Error("Store authority terminal incarnation changed; refresh AKK list; no input sent");
  }
  const completed = completedNativeStoreAuthorityReceipt(input, ledger);
  if (completed) return completed;
  let journal = readJournal(ledger);
  if (journal) {
    const inspection = inspectNativeStoreAuthority({ ...input, ledger });
    if (canonicalAuthorityStore(input.storeDir) !== journal.target_store_dir ||
      (input.automatic ? !journal.automatic : inspection.fingerprint !== input.expectedAuthorityToken)) {
      throw new Error("unfinished Store authority transfer belongs to another destination or snapshot");
    }
  } else journal = prepareJournal(input, ledger);
  const transaction = journal;
  const persist = (phase: TransferJournal["phase"]) => {
    transaction.phase = phase;
    ledger = { ...ledger, store_authority_transfer: { ...transaction } };
    repository.save(input.terminalControl, ledger, { authorityTransfer: true });
  };
  // Upgrade/check destination before installing a durable fence. Once prepared,
  // every crash point is resumed by this journal, without any terminal input.
  withStoreWriterLease(transaction.target_store_dir, () => {
    targetAvailable(transaction);
    const owner = captureStoreOwnerIdentity(transaction.target_store_dir, cliEnv());
    registerStoreOwnerIdentity(owner);
    if (!readStoreOwnerInventory(transaction.target_store_dir).complete) throw new Error("destination owner inventory is incomplete; source authority unchanged");
    transaction.target_owner ??= owner;
  });
  withStoreWriterLease(transaction.source_store_dir, () => {
    verifySourceOwner(transaction);
    const source = loadManagedSession(transaction.source_store_dir, transaction.source_session.session_id);
    if (source.authority_transfer?.transfer_id === transaction.transfer_id) return;
    if (canonicalJson(source) !== canonicalJson(transaction.source_session) ||
      !nativeAuthorityWorkSettled(transaction.source_store_dir, source)) {
      throw new Error("source Session/work changed during authority transfer; no input sent");
    }
    persist("prepared");
    saveManagedSession(transaction.source_store_dir, { ...source, status: "quarantined",
      quarantine_reason: "native Store authority transferred", updated_at: transaction.started_at,
      authority_transfer: { transfer_id: transaction.transfer_id, target_store_dir: transaction.target_store_dir,
        transferred_at: transaction.started_at } }, { expectedRevision: source.revision! });
    persist("source_retired");
  });
  withStoreWriterLease(transaction.target_store_dir, () => {
    verifySourceOwner(transaction);
    targetAvailable(transaction);
    const present = tryLoadManagedSession(transaction.target_store_dir, transaction.target_session.session_id);
    const { revision: _revision, ...presentBody } = present ?? {};
    if (present && canonicalJson(presentBody) !== canonicalJson(transaction.target_session)) {
      throw new Error("destination Session changed before authority transfer commit; preserve the journal and inspect the destination");
    }
    if (!present) saveManagedSession(transaction.target_store_dir, transaction.target_session, { expectedRevision: null });
    persist("target_created");
    const owner = captureStoreOwnerIdentity(transaction.target_store_dir, cliEnv());
    registerStoreOwnerIdentity(owner);
    const session = loadManagedSession(transaction.target_store_dir, transaction.target_session.session_id);
    // No old Turn is adopted or replayed. Its callback/history stay in source.
    ledger = { status: "resolved", store_dir: transaction.target_store_dir,
      native_thread_id: session.binding!.native_thread_id, session_id: session.session_id,
      binding: session.binding, resolved_at: new Date().toISOString(),
      reason: "native Store authority transferred without terminal input",
      store_authority: { version: 1, generation: transaction.generation,
        store_dir: transaction.target_store_dir, owner },
      store_authority_transfer: { ...transaction, phase: "committed" } };
    repository.save(input.terminalControl, ledger, { authorityTransfer: true });
  });
  return { transferred: true, transfer_id: transaction.transfer_id,
    session_id: transaction.target_session.session_id, store_dir: transaction.target_store_dir };
}

export function transferNativeStoreAuthority(input: NativeStoreAuthorityTransferRequest,
  repository: TerminalDispatchRepositoryCliAdapter) {
  const release = repository.acquire(input.storeDir, input.terminalControl);
  try { return transferNativeStoreAuthorityWhileLocked(input, repository); }
  finally { release(); }
}

/** Called after the terminal lock and before the destination Store lease. */
export function recoverNativeStoreAuthorityWhileLocked(input: Omit<NativeStoreAuthorityTransferRequest, "automatic">,
  repository: TerminalDispatchRepositoryCliAdapter): void {
  const ledger = repository.load(input.terminalControl);
  const inspection = inspectNativeStoreAuthority({ ...input, ledger });
  const journal = ledger && readJournal(ledger);
  if (inspection.automaticEligible || journal?.automatic && journal.target_store_dir === canonicalAuthorityStore(input.storeDir)) {
    transferNativeStoreAuthorityWhileLocked({ ...input, automatic: true }, repository);
  }
}

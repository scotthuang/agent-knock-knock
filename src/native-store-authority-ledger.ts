import { cliEnv } from "./cli-runtime-context.js";
import { canonicalAuthorityStore, nativeAuthorityStore, nativeAuthorityThreadIds } from "./native-store-authority.js";
import { captureStoreOwnerIdentity, isStoreOwnerIdentity } from "./store-owner-identity.js";
import { registerStoreOwnerIdentity } from "./store-owner-registry.js";
import type { TerminalDispatchLedgerDocument as Ledger } from "./terminal-dispatch-ledger-codec.js";
import { recordValue } from "./value-guards.js";

/** Repository-level fence also catches delayed writers that passed preflight earlier. */
export function stampNativeStoreAuthority(previous: Ledger | undefined, incoming: Ledger,
  transferWrite: boolean): Ledger {
  const priorTransfer = recordValue(previous?.store_authority_transfer);
  const store = nativeAuthorityStore(incoming);
  const previousStore = previous && nativeAuthorityStore(previous);
  const ids = nativeAuthorityThreadIds(incoming);
  const priorIds = previous ? nativeAuthorityThreadIds(previous) : [];
  const sameThread = ids.some(id => priorIds.includes(id));
  if (!transferWrite) assertAuthorityWriteAllowed({ priorTransfer, previousStore, store, sameThread, hasIds: ids.length > 0 });
  if (!store || !ids.length) return incoming;
  const priorAuthority = recordValue(previous?.store_authority);
  const sameStore = previousStore === canonicalAuthorityStore(store);
  // A transfer journal retains the source owner until the destination commit.
  if (transferWrite) return incoming;
  const owner = captureStoreOwnerIdentity(store, cliEnv());
  registerStoreOwnerIdentity(owner);
  return { ...incoming,
    store_authority: sameStore && sameThread && isStoreOwnerIdentity(priorAuthority?.owner)
      ? priorAuthority
      : { version: 1, generation: Number(priorAuthority?.generation ?? 0) + 1,
          store_dir: store, owner,
          ...(sameStore && sameThread ? { legacy_owner_coverage: true } : {}) },
    ...(sameStore && sameThread && priorTransfer ? { store_authority_transfer: priorTransfer } : {})
  };
}

function assertAuthorityWriteAllowed(facts: {
  priorTransfer?: Record<string, unknown>; previousStore?: string;
  store?: string; sameThread: boolean; hasIds: boolean;
}): void {
  const { priorTransfer, previousStore, store, sameThread, hasIds } = facts;
  if (priorTransfer && priorTransfer.phase !== "committed") {
    throw new Error("Store authority transfer is incomplete; refresh AKK list and resume transfer_store_authority; no terminal input is permitted");
  }
  if (previousStore && store !== previousStore && sameThread) {
    throw new Error("native thread Store authority changed; refusing a stale writer; refresh AKK list");
  }
  if (priorTransfer && (!store || !hasIds)) {
    throw new Error("a Store authority transfer cannot be erased by a stale ledger write");
  }
}

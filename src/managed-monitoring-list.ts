import { expandHome } from "./cli-command-runtime.js";
import { cliCwd } from "./cli-runtime-context.js";
import type { Conversation } from "./protocol.js";
import { listManagedSessions } from "./session-store.js";
import { defaultStoreDir, inspectStoreCompatibility, listConversations, STORE_SESSION_AUTHORITY_PROTOCOL } from "./store.js";
import type { TerminalListProjectionService } from "./terminal-list-projection-service.js";

/** Reuse existing pane-independent recovery policy without discovering or probing terminals. */
export function listManagedMonitoringRecords(
  options: Record<string, any>, service: TerminalListProjectionService,
  discoverable: (conversation: Conversation) => boolean
): Record<string, unknown>[] {
  const storeDir = expandHome(options.storeDir ?? options.logDir ?? defaultStoreDir(cliCwd()));
  const store = inspectStoreCompatibility(storeDir);
  const conversations = listConversations(storeDir).filter(discoverable);
  return service.projectTerminalFirstList({
    storeDir, terminals: [], managedSessions: store.readable ? listManagedSessions(storeDir) : [],
    sessionAuthorityRequired: Number(store.writer_protocol) >= STORE_SESSION_AUTHORITY_PROTOCOL,
    allConversations: conversations, displayedConversations: conversations,
    includeAll: true, managedOnly: true, mutationsAllowed: store.writable === true
  }).unavailableManagedTurns;
}

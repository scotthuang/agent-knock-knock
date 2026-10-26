import fs from "node:fs";
import path from "node:path";
import { readJsonFileNoFollow } from "./durable-json-file.js";
import { nativeAuthorityStore, nativeAuthorityThreadIds, canonicalAuthorityStore } from "./native-store-authority.js";
import { associateTerminalEndpointEvidence, type TerminalControlRef } from "./terminal-control-ref.js";
import { createTerminalDispatchRepositoryCliAdapter } from "./terminal-dispatch-repository-cli-adapter.js";
import { captureStoreOwnerIdentity } from "./store-owner-identity.js";
import { registerStoreOwnerIdentity } from "./store-owner-registry.js";
import { withStoreWriterLease } from "./store.js";
import { cliEnv } from "./cli-runtime-context.js";
import { recordValue } from "./value-guards.js";

interface RuntimeAuthorityRequest { nativeThreadId: string; storeDir: string; runtimeDir: string }

function matchingLedgers(input: RuntimeAuthorityRequest): Record<string, unknown>[] {
  const directory = path.join(input.runtimeDir, "terminal-dispatch");
  let names: string[];
  try { names = fs.readdirSync(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  return names.filter(name => /^terminal-dispatch-[0-9a-f]+\.json$/u.test(name)).flatMap(name => {
    const ledger = recordValue(readJsonFileNoFollow(path.join(directory, name), "terminal authority ledger"));
    if (!ledger) throw new Error("terminal authority ledger is unreadable; refusing native mutation");
    return nativeAuthorityThreadIds(ledger).includes(input.nativeThreadId.toLowerCase()) ? [ledger] : [];
  });
}

/** Native backend access must not bypass an existing managed terminal authority. */
export function assertNativeRuntimeStoreAuthority(input: RuntimeAuthorityRequest): void {
  for (const ledger of matchingLedgers(input)) {
    const transfer = recordValue(ledger.store_authority_transfer);
    if (nativeAuthorityStore(ledger) !== canonicalAuthorityStore(input.storeDir) || transfer && transfer.phase !== "committed") {
      throw new Error("native thread has conflicting or transferring Store authority; refresh AKK list and use " +
        "transfer_store_authority (agent_knock_knock_reconcile_binding operation=transfer_store_authority); no native input sent");
    }
  }
}

function ledgerControl(ledger: Record<string, unknown>): TerminalControlRef {
  const value = recordValue(ledger.terminal_control);
  if (!value || !["herdr", "tmux"].includes(String(value.kind))) throw new Error("unverified authority terminal control");
  const common = { target: String(value.target), session: String(value.session ?? ""),
    socketPath: typeof value.socket_path === "string" ? value.socket_path : undefined,
    panePid: Number(value.pane_pid), capabilities: [] };
  const control: TerminalControlRef = value.kind === "herdr" ? { ...common, kind: "herdr",
    workspaceId: String(value.workspace_id), tabId: String(value.tab_id), paneId: String(value.pane_id),
    terminalId: String(value.terminal_id), sessionDir: typeof value.session_dir === "string" ? value.session_dir : undefined }
    : { ...common, kind: "tmux", window: 0, pane: 0 };
  return ledger.terminal_endpoint ? associateTerminalEndpointEvidence(control, ledger.terminal_endpoint) : control;
}

export async function withNativeRuntimeStoreAuthority<T>(input: RuntimeAuthorityRequest,
  action: () => Promise<T>): Promise<T> {
  const repository = createTerminalDispatchRepositoryCliAdapter();
  if (path.resolve(input.runtimeDir) !== path.resolve(repository.runtimeDir())) throw new Error("native authority runtime namespace changed");
  const controls = [...new Map(matchingLedgers(input).map(ledger => {
    const control = ledgerControl(ledger);
    return [repository.runtimeKey(control), control] as const;
  })).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, control]) => control);
  const releases: Array<() => void> = [];
  try {
    for (const control of controls) releases.push(repository.acquire(input.storeDir, control));
    assertNativeRuntimeStoreAuthority(input);
    if (controls.length) withStoreWriterLease(input.storeDir, () => {
      registerStoreOwnerIdentity(captureStoreOwnerIdentity(input.storeDir, cliEnv()));
    });
    return await action();
  } finally { for (const release of releases.reverse()) release(); }
}

import { createCodexNativeStateStore } from "./codex-native-state-store.js";
import { createClaudeNativeStateStore } from "./claude-native-state-store.js";
import { createDesktopStateStore } from "./desktop-state-store.js";
import { createTerminalWatchStore } from "./terminal-watch-store.js";
import { codexNativeTaskProjection } from "./codex-native-public-projection.js";
import { claudeNativeTaskProjection } from "./claude-native-public-projection.js";
import { desktopTaskProjection } from "./desktop-public-projection.js";
import { publicTerminalWatch } from "./terminal-watch-presentation.js";
import { defaultStoreDir } from "./store.js";
import { expandHome } from "./cli-command-runtime.js";
import { cliCwd, cliNowMs, writeCliStdout } from "./cli-runtime-context.js";
import { parseWatchListOptions, projectWatchList, type WatchListInventory } from "./watch-list-projection.js";

type Row = Record<string, unknown>;
const readOnlyLocks = { acquire(): never { throw new Error("Watches listing must not mutate Store"); } };

/** Pure retained-record inventory: no native clients, monitors, reconciliation or callback attempts. */
export function readWatchListInventory(storeDir: string, readManagedTurns: () => Row[]): WatchListInventory {
  const inventory: WatchListInventory = { watches: [], managed_turns: [], diagnostics: [] };
  const providers = [
    ["codex_cli", () => { const scan = createCodexNativeStateStore(storeDir, readOnlyLocks).scanForReconciliation();
      return { rows: scan.tasks.map(task => ({ ...codexNativeTaskProjection(task), agent: "codex" })), errors: scan.errors.length }; }],
    ["claude_cli", () => { const scan = createClaudeNativeStateStore(storeDir, readOnlyLocks).scanForReconciliation();
      return { rows: scan.tasks.map(task => ({ ...claudeNativeTaskProjection(task), agent: "claude" })), errors: scan.errors.length }; }],
    ["codex_desktop", () => { const scan = createDesktopStateStore(storeDir, readOnlyLocks).scanForReconciliation();
      return { rows: scan.tasks.map(task => ({ ...desktopTaskProjection(task, false), agent: "codex" })), errors: scan.errors.length }; }],
    ["terminal", () => { const scan = createTerminalWatchStore(storeDir, readOnlyLocks).scanForReconciliation();
      return { rows: scan.watches.map(watch => publicTerminalWatch(watch)), errors: scan.errors.length }; }]
  ] as const;
  for (const [provider, scan] of providers) {
    try { const result = scan(); inventory.watches.push(...result.rows);
      inventory.diagnostics!.push({ provider, status: result.errors ? "partial" : "ok", invalid_records: result.errors }); }
    catch { inventory.diagnostics!.push({ provider, status: "unavailable" }); }
  }
  try {
    inventory.managed_turns = readManagedTurns();
    inventory.diagnostics!.push({ provider: "managed_turns", status: "ok" });
  } catch { inventory.diagnostics!.push({ provider: "managed_turns", status: "unavailable" }); }
  return inventory;
}

export function runWatchList(options: Row, readManagedTurns: () => Row[]): void {
  const params = { hours: options.hours, limit: options.limit, cursor: options.cursor, agent: options.agent,
    status: options.status, conversation_id: options.conversation ?? options.conversationId };
  parseWatchListOptions(params, cliNowMs());
  const supplied = options.storeDir ?? options.logDir;
  const storeDir = expandHome(typeof supplied === "string" ? supplied : defaultStoreDir(cliCwd()));
  writeCliStdout(JSON.stringify(projectWatchList(readWatchListInventory(storeDir, readManagedTurns), params, cliNowMs())) + "\n");
}

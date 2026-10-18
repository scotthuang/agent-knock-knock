import os from "node:os";
import path from "node:path";
import { cliCwd, cliEnv, cliNow, writeCliStdout } from "./cli-runtime-context.js";
import { collectExpiredWatchHistory } from "./watch-history-retention.js";

/** Internal Host maintenance entry; querying List or Watches never invokes cleanup. */
export function runWatchHistoryMaintenanceForCli(options: Record<string, unknown>): void {
  const home = cliEnv().HOME ?? os.homedir();
  const configured = options.storeDir ?? options.logDir;
  const value = typeof configured === "string" && configured.trim() ? configured : path.join(home, ".agent-knock-knock", "store");
  const storeDir = path.resolve(cliCwd(), value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  writeCliStdout(JSON.stringify(collectExpiredWatchHistory({ storeDir, now: cliNow() })) + "\n");
}

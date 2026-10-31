import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicSaveJsonFile, readJsonFileNoFollow } from "./durable-json-file.js";
import { parseCodexDeliveryDiagnostics, type CodexDeliveryDiagnostics, type CodexRoutingHealth } from "./codex-routing-diagnostics.js";
import { recordValue } from "./value-guards.js";

const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Best-effort advisory cache outside the Store. Never used to choose, reject or authorize a route.
 * Store + home scope prevents another Host/home's List from becoming a misleading correction hint.
 */
export function createCodexRoutingDiagnosticCache(storeDir: string, now: () => Date) {
  const directory = path.join(path.dirname(path.resolve(storeDir)), "routing-diagnostics", digest(path.resolve(storeDir)));
  const file = (kind: string, home: string, thread?: string) => path.join(directory, `${kind}-${digest([path.resolve(home), thread])}.json`);
  function read(filename: string): Record<string, unknown> | undefined {
    try {
      if (fs.lstatSync(filename).size > 1024 * 1024) return undefined;
      const row = recordValue(readJsonFileNoFollow(filename, "Codex routing diagnostics"));
      const age = now().getTime() - Date.parse(String(row?.observed_at));
      return row?.version === 1 && age >= 0 && age <= MAX_AGE_MS ? row : undefined;
    } catch { return undefined; }
  }
  function save(filename: string, value: Record<string, unknown>): void {
    try {
      atomicSaveJsonFile(filename, { ...value, version: 1, observed_at: now().toISOString() }, {
        rootLabel: "Routing diagnostic cache", directoryLabel: "Routing diagnostic scope", fileLabel: "Routing diagnostic record",
        ensureDirectory: directory => { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
      });
    } catch { /* Missing/unwritable diagnostic storage must not affect discovery or delivery. */ }
  }
  return {
    rememberList(home: string, threadIds: readonly string[], complete: boolean): void {
      // Incomplete inventory invalidates the previous negative-membership hint; it is not an empty List.
      save(file("list", home), { complete: complete && threadIds.length <= 10_000,
        thread_hashes: threadIds.slice(0, 10_000).map(digest) });
    },
    listMatch(home: string, threadId: string): Pick<CodexDeliveryDiagnostics, "recent_list_match" | "recent_list_observed_at"> {
      const row = read(file("list", home));
      if (row?.complete !== true || !Array.isArray(row.thread_hashes) ||
        !row.thread_hashes.every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash))) return { recent_list_match: "not_checked" };
      return { recent_list_match: row.thread_hashes.includes(digest(threadId)) ? "matched" : "no_match",
        recent_list_observed_at: new Date(String(row.observed_at)).toISOString() };
    },
    rememberFailure(home: string, threadId: string, diagnostics: CodexDeliveryDiagnostics): void {
      const safe = parseCodexDeliveryDiagnostics(diagnostics);
      if (safe) save(file("failure", home, threadId), { diagnostics: safe });
    },
    lastFailure(home: string, threadId: string): CodexRoutingHealth["last_failure"] {
      const row = read(file("failure", home, threadId)), safe = parseCodexDeliveryDiagnostics(row?.diagnostics);
      return safe && safe.target_thread_id === threadId ? { ...safe, observed_at: new Date(String(row!.observed_at)).toISOString() } : null;
    }
  };
}

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cliEnv, cliExecutionMemo } from "./cli-runtime-context.js";
import { resolveOptionalExecutable } from "./cli-command-runtime.js";

type Reader = (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
interface Snapshot { output?: string; pending?: Promise<string>; }

const runReader: Reader = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" },
    (error, stdout) => error ? reject(error) : resolve(stdout));
});

function canonical(value: string): string {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function snapshot(configDir: string, reader: string, run: Reader): Snapshot {
  const readers = cliExecutionMemo("claude-agent-discovery", run, () => new Map<string, Snapshot>());
  const key = JSON.stringify([canonical(configDir), reader]);
  let entry = readers.get(key);
  if (!entry) readers.set(key, entry = {});
  return entry;
}

/** Share the expensive reader only for discovery; registry/process/socket checks remain separate. */
export function readClaudeAgentDiscovery(configDir: string, reader: string, run: Reader = runReader): Promise<string> {
  // The production cache key and launched executable must agree, including HOME/PATH fallback.
  const executable = run === runReader ? resolveOptionalExecutable(reader) : reader;
  const entry = snapshot(configDir, executable, run);
  if (entry.output !== undefined) return Promise.resolve(entry.output);
  return entry.pending ??= Promise.resolve().then(() => run(executable, ["agents", "--json", "--all"],
    { ...cliEnv(), CLAUDE_CONFIG_DIR: configDir })).then(output => {
      entry.output = output;
      return output;
    }).finally(() => { entry.pending = undefined; });
}

/** Read-only List enrichment may consume its completed discovery; execution preflights never use this. */
export function completedClaudeAgentDiscovery(configDir: string, reader: string): string | undefined {
  return snapshot(configDir, resolveOptionalExecutable(reader), runReader).output;
}


import { spawnSync } from "node:child_process";

import { resolveOptionalExecutable } from "./cli-command-runtime.js";
import { cliDependencies } from "./cli-runtime-context.js";

/** Read the stable OS birth evidence for one exact Codex process. */
export function codexProcessBirthForLifecycle(pid: number): string {
  const injected = cliDependencies().codexProcessBirthForPid;
  if (injected) {
    return injected(pid);
  }
  const ps = resolveOptionalExecutable("ps");
  if (!ps) {
    throw new Error(
      "cannot verify Codex process incarnation because ps is unavailable"
    );
  }
  const result = spawnSync(ps, ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024 * 1024
  });
  const processBirth = String(result.stdout ?? "").trim();
  if (result.error || result.status !== 0 || !processBirth) {
    throw new Error(
      String(result.stderr ?? "").trim() ||
      result.error?.message ||
      `cannot verify Codex process incarnation for pid ${pid}`
    );
  }
  return processBirth;
}

/** Canonical physical identity derived from PID plus its verified birth. */
export function codexProcessIncarnationForPid(pid: number): {
  processUuid: string;
  processBirth: string;
  evidence: "codex_process_birth";
} {
  const processBirth = codexProcessBirthForLifecycle(pid);
  return {
    processUuid: `codex-pid:${pid}:birth:${processBirth}`,
    processBirth,
    evidence: "codex_process_birth"
  };
}

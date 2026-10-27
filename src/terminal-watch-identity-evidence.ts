/** Optional observation metadata is not permission to change terminal identity. */
import path from "node:path";
import { isRecord, nonBlankString } from "./value-guards.js";

export function optionalTerminalWorkspace(terminal: Record<string, unknown>): string | undefined {
  const control = isRecord(terminal.terminal_control) ? terminal.terminal_control : undefined;
  const workspace = nonBlankString(terminal.workspace) ?? nonBlankString(terminal.cwd) ??
    nonBlankString(control?.currentPath);
  if (workspace === undefined) return undefined;
  if (workspace.includes("\0") || !path.isAbsolute(workspace)) {
    throw new Error("terminal workspace must be absolute");
  }
  return path.resolve(workspace);
}

export function terminalWatchProcessEvidence(terminal: Record<string, unknown>): {
  uuid?: string; birth?: string;
} {
  return {
    uuid: optionalObservation(() => nonBlankString(terminal.native_agent_process_uuid)),
    // Both birth fields come from the same host-timezone OS observation. Never
    // substitute Claude's UTC processStart or mix native and OS UUID formats.
    birth: optionalObservation(() => nonBlankString(terminal.native_agent_process_birth)) ??
      optionalObservation(() => nonBlankString(terminal._physical_agent_process_birth))
  };
}

/** Read independent facts separately so one failed read cannot hide another mismatch. */
export function optionalObservation<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

export function knownIdentityDifference(left: string | undefined,
  right: string | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
}

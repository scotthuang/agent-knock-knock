/** A row returned by `claude agents --json --all`. Unknown fields are intentionally ignored. */
export interface ClaudeAgentRow {
  pid?: number;
  cwd?: string;
  kind?: string;
  sessionId?: string;
  startedAt?: number;
  status?: string;
  waitingFor?: string;
  /** Registry metadata bound to this exact PID/session/process incarnation by the reader. */
  configDir?: string;
  version?: string;
  processStart?: string;
}

/**
 * Claude Code 2.1.251 through 2.1.267 can report an input-ready interactive composer as
 * `waiting` without a `waitingFor` reason. A non-empty wait reason remains a
 * real blocked state and must never be promoted to idle.
 */
export function isClaudeAgentIdleState(row: ClaudeAgentRow): boolean {
  const waitingFor = typeof row.waitingFor === "string"
    ? row.waitingFor.trim()
    : "";
  return row.status === "idle" ||
    (row.status === "waiting" && waitingFor.length === 0);
}

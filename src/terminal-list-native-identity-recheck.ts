import type { ActiveTerminalProcess } from "./terminal-agent-adapter.js";
import type { TerminalNativeIdentityObservation } from "./terminal-binding-authority.js";
import type { ClaudeIdentityRow } from "./terminal-dispatch-execution.js";
import type { TerminalListInventoryOptions, TerminalListInventoryPorts } from "./terminal-list-inventory.js";

export interface TerminalListIdentityRecheck {
  attempted: true;
  status: "resolved" | "unresolved" | "failed";
}

export interface TerminalListNativeIdentitySnapshot {
  observation: TerminalNativeIdentityObservation;
  recheck?: TerminalListIdentityRecheck;
  windowRole?: "background_view";
}

/** Scope reader snapshots to one List invocation, including exact-terminal List. */
export function withClaudeListIdentityRecheck<Options extends TerminalListInventoryOptions>(input: {
  loadRows?(options: Options, observation: { required: true }): readonly ClaudeIdentityRow[];
  observeWindowRole?(options: Options, pid: number, cwd?: string): "background_view" | undefined;
  observe(request: { options: Options; agent: "claude"; pid: number; cwd?: string;
    claudeAgentRows: readonly ClaudeIdentityRow[] }): Promise<TerminalNativeIdentityObservation>;
  project(request: Parameters<TerminalListInventoryPorts<Options>["projectTerminal"]>[0],
    snapshot?: TerminalListNativeIdentitySnapshot): ReturnType<TerminalListInventoryPorts<Options>["projectTerminal"]>;
}): TerminalListInventoryPorts<Options>["projectTerminal"] {
  let pending: Promise<Map<number, TerminalListNativeIdentitySnapshot>> | undefined;
  const loadRows = input.loadRows;
  return async request => {
    const snapshots = request.session.agent === "claude" && loadRows
      ? await (pending ??= observeClaudeListIdentitySnapshots({
          sessions: request.selectedSessions,
          loadRows: () => loadRows(request.options, { required: true }),
          observeWindowRole: session => input.observeWindowRole?.(request.options, session.pid,
            session.cwd ?? session.terminalControl?.currentPath),
          observe: (session, claudeAgentRows) => input.observe({ options: request.options,
            agent: "claude", pid: session.pid,
            cwd: session.cwd ?? session.terminalControl?.currentPath, claudeAgentRows })
        }))
      : undefined;
    return input.project(request, snapshots?.get(request.session.pid));
  };
}

/** One fresh retry is shared by all unresolved Claude PIDs in this physical scan. */
export async function observeClaudeListIdentitySnapshots(input: {
  sessions: readonly ActiveTerminalProcess[];
  loadRows(): readonly ClaudeIdentityRow[];
  observeWindowRole?(session: ActiveTerminalProcess): "background_view" | undefined;
  observe(session: ActiveTerminalProcess, rows: readonly ClaudeIdentityRow[]):
    Promise<TerminalNativeIdentityObservation>;
}): Promise<Map<number, TerminalListNativeIdentitySnapshot>> {
  const sessions = input.sessions.filter(session => session.agent === "claude");
  const result = new Map<number, TerminalListNativeIdentitySnapshot>();
  if (sessions.length === 0) return result;
  const observeBatch = async (selected: readonly ActiveTerminalProcess[], retry: boolean) => {
    let rows: readonly ClaudeIdentityRow[];
    try {
      rows = input.loadRows();
    } catch (error) {
      for (const session of selected) result.set(session.pid, {
        observation: unavailable(error),
        ...(retry ? { recheck: { attempted: true, status: "failed" } as const } : {})
      });
      return;
    }
    for (const session of selected) {
      try {
        const observation = await input.observe(session, rows);
        result.set(session.pid, { observation,
          ...(retry ? { recheck: { attempted: true,
            status: observation.status === "resolved" ? "resolved" : "unresolved"
          } as const } : {}) });
      } catch (error) {
        result.set(session.pid, { observation: unavailable(error),
          ...(retry ? { recheck: { attempted: true, status: "failed" } as const } : {}) });
      }
    }
  };
  await observeBatch(sessions, false);
  const unresolved = sessions.filter(session =>
    result.get(session.pid)?.observation.status !== "resolved");
  if (unresolved.length > 0) await observeBatch(unresolved, true);
  annotateWindowRoles(unresolved, result, input.observeWindowRole);
  return result;
}

/** Display enrichment stays separate from the identity-retry transaction. */
function annotateWindowRoles(sessions: readonly ActiveTerminalProcess[],
  snapshots: Map<number, TerminalListNativeIdentitySnapshot>,
  observe?: (session: ActiveTerminalProcess) => "background_view" | undefined): void {
  for (const session of sessions) {
    const snapshot = snapshots.get(session.pid)!;
    if (snapshot.observation.status === "resolved") continue;
    try {
      const role = observe?.(session);
      if (role === "background_view") snapshot.windowRole = role;
    } catch { /* Diagnostics failure never changes identity, actions or fallback guidance. */ }
  }
}

function unavailable(error: unknown): TerminalNativeIdentityObservation {
  return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
}

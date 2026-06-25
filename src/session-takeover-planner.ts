import type {
  ActiveCodexProcess,
  CodexSessionSummary,
  ForkContextPackage
} from "./codex-session-provider.js";

export type SessionControlMode = "takeover" | "fork";
export type SessionControlPlan = TakeoverPlan | ForkPlan;

export interface ProcessTarget {
  pid: number;
  childPids: number[];
  cwd?: string;
  command: string;
  sessionId?: string;
}

export interface TakeoverPlan {
  mode: "takeover";
  allowed: boolean;
  requiresConfirmation: boolean;
  reason: "active_cli_conflict" | "no_active_cli" | "ambiguous_active_cli";
  targets: ProcessTarget[];
  resumeAfterExit?: {
    sessionId: string;
    cwd: string;
  };
}

export interface ForkPlan {
  mode: "fork";
  allowed: boolean;
  requiresConfirmation: true;
  requiresOpenClawSummary: true;
  reason: "fork_context_ready";
  source: {
    agent: "codex";
    sessionId: string;
    cwd: string;
  };
  contextPackage: ForkContextPackage;
}

export function planTakeover(session: CodexSessionSummary, activeProcesses: ActiveCodexProcess[]): TakeoverPlan {
  const targets = matchingActiveProcesses(session, activeProcesses);
  if (targets.length === 0) {
    return {
      mode: "takeover",
      allowed: false,
      requiresConfirmation: false,
      reason: "no_active_cli",
      targets: []
    };
  }

  const hasExactSessionMatch = targets.some((target) => target.sessionId === session.id);
  return {
    mode: "takeover",
    allowed: hasExactSessionMatch,
    requiresConfirmation: hasExactSessionMatch,
    reason: hasExactSessionMatch ? "active_cli_conflict" : "ambiguous_active_cli",
    targets,
    resumeAfterExit: hasExactSessionMatch ? {
      sessionId: session.id,
      cwd: session.cwd
    } : undefined
  };
}

export function planFork(session: CodexSessionSummary, contextPackage: ForkContextPackage): ForkPlan {
  return {
    mode: "fork",
    allowed: true,
    requiresConfirmation: true,
    requiresOpenClawSummary: true,
    reason: "fork_context_ready",
    source: {
      agent: "codex",
      sessionId: session.id,
      cwd: session.cwd
    },
    contextPackage
  };
}

export function matchingActiveProcesses(session: CodexSessionSummary, activeProcesses: ActiveCodexProcess[]): ProcessTarget[] {
  const matched = activeProcesses.filter((process) =>
    process.kind === "codex_cli" &&
    (
      process.sessionId === session.id ||
      (!process.sessionId && process.cwd === session.cwd)
    )
  );
  const pidSet = new Set(matched.map((process) => process.pid));

  return matched
    .filter((process) => !process.ppid || !pidSet.has(process.ppid))
    .map((process) => ({
      pid: process.pid,
      childPids: matched
        .filter((child) => child.ppid === process.pid)
        .map((child) => child.pid),
      cwd: process.cwd,
      command: process.command,
      sessionId: process.sessionId
    }));
}

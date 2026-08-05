import type {
  ActiveAgentSessionIdentity,
  AgentSessionCapabilities,
  CodingAgentSessionProvider,
  ForkContextOptions
} from "./agent-session-provider.js";
import {
  buildForkContextPackage,
  codexSessionsFromThreadRows,
  discoverCodexProcesses,
  parseCodexRolloutJsonl,
  type ActiveCodexProcess,
  type CodexProcessSnapshot,
  type CodexSessionSummary,
  type CodexThreadRow,
  type ForkContextPackage
} from "./codex-session-provider.js";

export interface CodexLocalSessionAdapter {
  listThreadRows(): Promise<CodexThreadRow[]>;
  readRollout(path: string): Promise<string | undefined>;
  listProcessSnapshots(): Promise<CodexProcessSnapshot[]>;
  resolveActiveSessionIdentityForPid?(
    pid: number,
    cwd?: string,
    preferredSessionId?: string,
    allowedCompanionIdentity?: ActiveAgentSessionIdentity,
    allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[]
  ): Promise<ActiveAgentSessionIdentity | undefined>;
}

export class CodexLocalSessionProvider implements CodingAgentSessionProvider {
  readonly agent = "codex" as const;
  private readonly adapter: CodexLocalSessionAdapter;

  constructor(adapter: CodexLocalSessionAdapter) {
    this.adapter = adapter;
  }

  async getCapabilities(): Promise<AgentSessionCapabilities> {
    const reasons: string[] = [];
    let sessions: CodexSessionSummary[] = [];
    let historicalSessions: AgentSessionCapabilities["historicalSessions"] = "unavailable";
    let forkContext: AgentSessionCapabilities["forkContext"] = "unavailable";
    let activeSessions: AgentSessionCapabilities["activeSessions"] = "unavailable";

    try {
      sessions = await this.listHistoricalSessions();
      historicalSessions = sessions.some((session) => session.capability === "full") ? "full" : "metadata_only";
      forkContext = sessions.some((session) => session.rolloutPath) ? "full" : "partial";
      if (sessions.length === 0) {
        reasons.push("no Codex thread metadata was discovered");
      }
    } catch (error) {
      reasons.push(`historical session discovery unavailable: ${errorMessage(error)}`);
    }

    try {
      await this.listActiveSessions();
      activeSessions = "process_scan";
    } catch (error) {
      reasons.push(`active session discovery unavailable: ${errorMessage(error)}`);
    }

    return {
      historicalSessions,
      forkContext,
      activeSessions,
      takeover: activeSessions === "process_scan" ? "plan_only" : "unavailable",
      reasons
    };
  }

  async listHistoricalSessions(): Promise<CodexSessionSummary[]> {
    return codexSessionsFromThreadRows(await this.adapter.listThreadRows());
  }

  async listActiveSessions(): Promise<ActiveCodexProcess[]> {
    return discoverCodexProcesses(await this.adapter.listProcessSnapshots())
      .filter((process) => process.kind === "codex_cli");
  }

  async resolveActiveSessionIdentityForPid(
    pid: number,
    cwd?: string,
    preferredSessionId?: string,
    allowedCompanionIdentity?: ActiveAgentSessionIdentity,
    allowedAdditionalIdentities?: readonly ActiveAgentSessionIdentity[]
  ): Promise<ActiveAgentSessionIdentity | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error("Codex process pid must be a positive integer greater than 1");
    }
    if (this.adapter.resolveActiveSessionIdentityForPid) {
      return this.adapter.resolveActiveSessionIdentityForPid(
        pid,
        cwd,
        preferredSessionId,
        allowedCompanionIdentity,
        allowedAdditionalIdentities
      );
    }
    const sessionId = (await this.listActiveSessions())
      .find((process) => process.pid === pid)?.sessionId;
    return sessionId
      ? {
          sessionId,
          processUuid: `static-pid:${pid}`,
          evidence: "process_command_session_id"
        }
      : undefined;
  }

  async getSession(sessionId: string): Promise<CodexSessionSummary | undefined> {
    const sessions = await this.listHistoricalSessions();
    return sessions.find((session) => session.id === sessionId);
  }

  async getForkContext(options: ForkContextOptions): Promise<ForkContextPackage | undefined> {
    const session = await this.getSession(options.sessionId);
    if (!session) {
      return undefined;
    }

    if (!session.rolloutPath) {
      return buildForkContextPackage(session, {
        messages: [],
        commands: [],
        turns: [],
        skippedLines: 0,
        truncated: false
      });
    }

    const rollout = await this.adapter.readRollout(session.rolloutPath);
    if (!rollout) {
      return buildForkContextPackage(session, {
        messages: [],
        commands: [],
        turns: [],
        skippedLines: 0,
        truncated: false
      });
    }

    return buildForkContextPackage(session, parseCodexRolloutJsonl(rollout, options));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

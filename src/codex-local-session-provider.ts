import type {
  AgentSessionCapabilities,
  CodingAgentSessionProvider,
  ForkContextOptions
} from "./agent-session-provider.js";
import {
  buildForkContextPackage,
  codexSessionsFromThreadRows,
  discoverCodexProcesses,
  parseCodexRolloutJsonl,
  parseCodexRolloutModel,
  type ActiveCodexProcess,
  type CodexProcessSnapshot,
  type CodexSessionModelInfo,
  type CodexSessionSummary,
  type CodexThreadRow,
  type ForkContextPackage
} from "./codex-session-provider.js";

export interface CodexLocalSessionAdapter {
  listThreadRows(): Promise<CodexThreadRow[]>;
  readRollout(path: string): Promise<string | undefined>;
  listProcessSnapshots(): Promise<CodexProcessSnapshot[]>;
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

  async getSession(sessionId: string): Promise<CodexSessionSummary | undefined> {
    const sessions = await this.listHistoricalSessions();
    return sessions.find((session) => session.id === sessionId);
  }

  async getSessionModel(sessionId: string): Promise<CodexSessionModelInfo | undefined> {
    const session = await this.getSession(sessionId);
    if (!session?.rolloutPath) {
      return undefined;
    }

    const rollout = await this.adapter.readRollout(session.rolloutPath);
    return rollout ? parseCodexRolloutModel(rollout) : undefined;
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
        skippedLines: 0,
        truncated: false
      });
    }

    const rollout = await this.adapter.readRollout(session.rolloutPath);
    if (!rollout) {
      return buildForkContextPackage(session, {
        messages: [],
        commands: [],
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

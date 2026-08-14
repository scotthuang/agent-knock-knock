import type {
  ActiveAgentSessionIdentity,
  AgentSessionCapabilities,
  CodexOpenRootRolloutInventory,
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
import {
  isRecord,
  nonBlankString
} from "./value-guards.js";

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
  inspectOpenRootRolloutInventoryForPid?(
    pid: number,
    cwd?: string
  ): Promise<CodexOpenRootRolloutInventory>;
}

export class InlineCodexLocalSessionAdapter implements CodexLocalSessionAdapter {
  private readonly threads: CodexThreadRow[];
  private readonly processes: CodexProcessSnapshot[];
  private readonly processBatches: CodexProcessSnapshot[][];
  private processBatchIndex = 0;
  private readonly rollouts: Map<string, string>;
  private readonly activeSessionIdentities: Map<number, ActiveAgentSessionIdentity>;

  constructor({
    threads,
    processes,
    rollouts,
    activeSessionIdentities
  }: {
    threads?: CodexThreadRow[];
    processes?: CodexProcessSnapshot[] | CodexProcessSnapshot[][];
    rollouts?: Record<string, string>;
    activeSessionIdentities?: Record<string, unknown>;
  }) {
    this.threads = Array.isArray(threads) ? threads : [];
    this.processBatches = Array.isArray(processes?.[0])
      ? processes as CodexProcessSnapshot[][]
      : [];
    this.processes = Array.isArray(processes) && !Array.isArray(processes[0])
      ? processes as CodexProcessSnapshot[]
      : [];
    this.rollouts = new Map(Object.entries(rollouts ?? {}));
    this.activeSessionIdentities = new Map(
      Object.entries(activeSessionIdentities ?? {}).flatMap(([pidValue, value]) => {
        const pid = Number(pidValue);
        if (!Number.isSafeInteger(pid) || pid <= 1 || !isRecord(value)) {
          return [];
        }
        const sessionId = nonBlankString(value.sessionId ?? value.session_id);
        if (!sessionId) {
          return [];
        }
        const processUuid = nonBlankString(value.processUuid ?? value.process_uuid);
        const processBirth = nonBlankString(value.processBirth ?? value.process_birth);
        const rollout = isRecord(value.rollout) &&
            nonBlankString(value.rollout.fd) &&
            nonBlankString(value.rollout.device) &&
            nonBlankString(value.rollout.inode) &&
            nonBlankString(value.rollout.path)
          ? {
              fd: nonBlankString(value.rollout.fd) as string,
              device: nonBlankString(value.rollout.device) as string,
              inode: nonBlankString(value.rollout.inode) as string,
              path: nonBlankString(value.rollout.path) as string
            }
          : undefined;
        return [[pid, {
          sessionId,
          ...(processUuid ? { processUuid } : {}),
          ...(processBirth ? { processBirth } : {}),
          ...(rollout ? { rollout } : {}),
          evidence: nonBlankString(value.evidence) ?? "static_exact_fixture"
        }]];
      })
    );
  }

  async listThreadRows(): Promise<CodexThreadRow[]> {
    return this.threads;
  }

  async readRollout(rolloutPath: string): Promise<string | undefined> {
    return this.rollouts.get(rolloutPath);
  }

  async listProcessSnapshots(): Promise<CodexProcessSnapshot[]> {
    if (this.processBatches.length > 0) {
      const batch = this.processBatches[
        Math.min(this.processBatchIndex, this.processBatches.length - 1)
      ];
      this.processBatchIndex += 1;
      return batch;
    }
    return this.processes;
  }

  async resolveActiveSessionIdentityForPid(
    pid: number
  ): Promise<ActiveAgentSessionIdentity | undefined> {
    return this.activeSessionIdentities.get(pid);
  }
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

  async inspectOpenRootRolloutInventoryForPid(
    pid: number,
    cwd?: string
  ): Promise<CodexOpenRootRolloutInventory> {
    if (!this.adapter.inspectOpenRootRolloutInventoryForPid) {
      throw new Error(
        "Codex open-root rollout inventory inspection is unavailable"
      );
    }
    return this.adapter.inspectOpenRootRolloutInventoryForPid(pid, cwd);
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

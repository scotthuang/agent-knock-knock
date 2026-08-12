import type {
  ActiveCodexProcess,
  CodexSessionSummary,
  ForkContextPackage,
  RolloutExcerptOptions
} from "./codex-session-provider.js";

export type CodingAgentSessionProviderAgent = "codex";
export type HistoricalSessionCapability = "full" | "metadata_only" | "unavailable";
export type ForkContextCapability = "full" | "partial" | "unavailable";
export type ActiveSessionCapability = "process_scan" | "unavailable";
export type TakeoverCapability = "plan_only" | "unavailable";

export interface AgentSessionCapabilities {
  historicalSessions: HistoricalSessionCapability;
  forkContext: ForkContextCapability;
  activeSessions: ActiveSessionCapability;
  takeover: TakeoverCapability;
  reasons: string[];
}

export interface ForkContextOptions extends RolloutExcerptOptions {
  sessionId: string;
}

export interface ActiveAgentSessionIdentity {
  sessionId: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  evidence: string;
}

export interface CodexOpenRootRolloutIdentity
  extends ActiveAgentSessionIdentity {
  processUuid: string;
  processBirth: string;
  rollout: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  evidence: "codex_open_root_rollout";
}

interface CodexOpenRootRolloutInventoryBase {
  schema: "agent-knock-knock/codex-open-root-rollout-inventory";
  version: 1;
  pid: number;
  processUuid: string;
  processBirth: string;
  cwd?: string;
  roots: CodexOpenRootRolloutIdentity[];
  inventoryFingerprint: string;
}

export type CodexOpenRootRolloutInventory =
  | CodexOpenRootRolloutInventoryBase & {
      status: "verified_absent";
      roots: [];
    }
  | CodexOpenRootRolloutInventoryBase & {
      status: "resolved";
      roots: [CodexOpenRootRolloutIdentity];
    }
  | CodexOpenRootRolloutInventoryBase & {
      status: "unbound";
      reason: "multiple_open_root_rollouts";
      roots: CodexOpenRootRolloutIdentity[];
    };

export interface CodingAgentSessionProvider {
  agent: CodingAgentSessionProviderAgent;

  getCapabilities(): Promise<AgentSessionCapabilities>;
  listHistoricalSessions(): Promise<CodexSessionSummary[]>;
  listActiveSessions(): Promise<ActiveCodexProcess[]>;
  resolveActiveSessionIdentityForPid(
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
  getSession(sessionId: string): Promise<CodexSessionSummary | undefined>;
  getForkContext(options: ForkContextOptions): Promise<ForkContextPackage | undefined>;
}

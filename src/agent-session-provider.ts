import type {
  ActiveCodexProcess,
  CodexSessionModelInfo,
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

export interface CodingAgentSessionProvider {
  agent: CodingAgentSessionProviderAgent;

  getCapabilities(): Promise<AgentSessionCapabilities>;
  listHistoricalSessions(): Promise<CodexSessionSummary[]>;
  listActiveSessions(): Promise<ActiveCodexProcess[]>;
  getSession(sessionId: string): Promise<CodexSessionSummary | undefined>;
  getSessionModel(sessionId: string): Promise<CodexSessionModelInfo | undefined>;
  getForkContext(options: ForkContextOptions): Promise<ForkContextPackage | undefined>;
}

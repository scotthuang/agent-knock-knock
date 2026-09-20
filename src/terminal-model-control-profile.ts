import type { ExecutorKind } from "./executors.js";

/**
 * Verified native model-control behavior profiles.
 *
 * Keep every version/profile pairing here. Callers must consume this registry
 * instead of independently deciding that a running TUI is compatible.
 */
export const TERMINAL_MODEL_CONTROL_PROFILE_IDS = Object.freeze({
  codex: "codex-model-control-0.154.0",
  codex01551: "codex-model-control-0.155.1",
  claude: "claude-model-control-2.1.266"
} as const);

export type TerminalModelControlBehaviorProfile =
  typeof TERMINAL_MODEL_CONTROL_PROFILE_IDS[keyof
    typeof TERMINAL_MODEL_CONTROL_PROFILE_IDS];

export type TerminalModelControlScope =
  | "current_session"
  | "current_and_new_sessions";

export interface TerminalModelControlCapabilities {
  readonly status: "supported" | "unsupported" | "unknown";
  readonly agentVersion?: string;
  readonly behaviorProfile?: string;
  readonly scope?: TerminalModelControlScope;
  readonly modelSelection: boolean;
  readonly reasoningEffortSelection: boolean;
  readonly reason: string;
}

export interface TerminalModelControlPlan {
  readonly behaviorProfile: TerminalModelControlBehaviorProfile;
  readonly command: "/model";
  readonly scope: TerminalModelControlScope;
  readonly requiresIdle: true;
  readonly requiresExactEmptyComposer: true;
}

export interface TerminalModelControlProfile {
  readonly agent: ExecutorKind;
  readonly agentVersion: string;
  readonly behaviorProfile: TerminalModelControlBehaviorProfile;
  readonly plan: TerminalModelControlPlan;
  readonly supportsZeroRolloutPhysicalAuthority: boolean;
  readonly supportsResidualContinuation: boolean;
  readonly supportsResidualRepair: boolean;
  /** Exact native slash-completion rows accepted before dispatching Enter. */
  readonly slashCompletionRows: readonly string[];
  /**
   * Whether an exact styled Composer/popup may prove the slash surface without
   * the legacy viewport-wide background paint. Keep this version-profiled:
   * identical visible completion text does not imply identical TUI authority.
   */
  readonly allowsStyledSlashPopupWithoutViewportPaint: boolean;
  readonly reason: string;
}

export const CODEX_MODEL_CONTROL_AGENT_VERSION = "0.154.0";
export const CODEX_MODEL_CONTROL_AGENT_VERSIONS = Object.freeze([
  CODEX_MODEL_CONTROL_AGENT_VERSION,
  "0.155.1"
] as const);
export type CodexModelControlAgentVersion =
  typeof CODEX_MODEL_CONTROL_AGENT_VERSIONS[number];
export const CLAUDE_MODEL_CONTROL_AGENT_VERSION = "2.1.266";

export function isCodexModelControlAgentVersion(
  value: string
): value is CodexModelControlAgentVersion {
  return (CODEX_MODEL_CONTROL_AGENT_VERSIONS as readonly string[]).includes(value);
}

const MODEL_CONTROL_PROFILES: readonly TerminalModelControlProfile[] =
  Object.freeze([
    Object.freeze({
      agent: "codex",
      agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSION,
      behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
      plan: Object.freeze({
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex,
        command: "/model",
        scope: "current_and_new_sessions",
        requiresIdle: true,
        requiresExactEmptyComposer: true
      }),
      supportsZeroRolloutPhysicalAuthority: true,
      supportsResidualContinuation: true,
      supportsResidualRepair: true,
      slashCompletionRows: Object.freeze([
        "  /model  choose what model and reasoning effort to use"
      ]),
      allowsStyledSlashPopupWithoutViewportPaint: false,
      reason:
        `Codex ${CODEX_MODEL_CONTROL_AGENT_VERSION} /model control changes the ` +
        "current session and persisted defaults"
    }),
    Object.freeze({
      agent: "codex",
      agentVersion: CODEX_MODEL_CONTROL_AGENT_VERSIONS[1],
      behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex01551,
      plan: Object.freeze({
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.codex01551,
        command: "/model",
        scope: "current_and_new_sessions",
        requiresIdle: true,
        requiresExactEmptyComposer: true
      }),
      supportsZeroRolloutPhysicalAuthority: true,
      supportsResidualContinuation: true,
      supportsResidualRepair: true,
      slashCompletionRows: Object.freeze([
        "  /model  choose what model and reasoning effort to use"
      ]),
      allowsStyledSlashPopupWithoutViewportPaint: true,
      reason:
        `Codex ${CODEX_MODEL_CONTROL_AGENT_VERSIONS[1]} /model control changes the ` +
        "current session and persisted defaults"
    }),
    Object.freeze({
      agent: "claude",
      agentVersion: CLAUDE_MODEL_CONTROL_AGENT_VERSION,
      behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
      plan: Object.freeze({
        behaviorProfile: TERMINAL_MODEL_CONTROL_PROFILE_IDS.claude,
        command: "/model",
        scope: "current_session",
        requiresIdle: true,
        requiresExactEmptyComposer: true
      }),
      supportsZeroRolloutPhysicalAuthority: false,
      supportsResidualContinuation: false,
      supportsResidualRepair: false,
      slashCompletionRows: Object.freeze([]),
      allowsStyledSlashPopupWithoutViewportPaint: false,
      reason:
        `Claude Code ${CLAUDE_MODEL_CONTROL_AGENT_VERSION} /model supports the ` +
        "explicit session-only selection path"
    })
  ] satisfies readonly TerminalModelControlProfile[]);

export function terminalModelControlProfiles():
readonly TerminalModelControlProfile[] {
  return MODEL_CONTROL_PROFILES;
}

export function terminalModelControlProfileFor(
  agent: ExecutorKind,
  agentVersion: string | undefined
): TerminalModelControlProfile | undefined {
  const version = nonBlank(agentVersion);
  if (!version) return undefined;
  return MODEL_CONTROL_PROFILES.find((profile) =>
    profile.agent === agent && profile.agentVersion === version
  );
}

export function terminalModelControlProfileForPlan(
  plan: TerminalModelControlPlan
): TerminalModelControlProfile | undefined {
  return MODEL_CONTROL_PROFILES.find((profile) =>
    profile.behaviorProfile === plan.behaviorProfile &&
    samePlan(profile.plan, plan)
  );
}

export function terminalModelControlPlanConforms(input: {
  readonly agent: ExecutorKind;
  readonly agentVersion: string | undefined;
  readonly plan: TerminalModelControlPlan;
}): boolean {
  const profile = terminalModelControlProfileFor(
    input.agent,
    input.agentVersion
  );
  return profile !== undefined && samePlan(profile.plan, input.plan);
}

export function isTerminalModelControlPlanForAgent(
  plan: TerminalModelControlPlan,
  agent: ExecutorKind
): boolean {
  return terminalModelControlProfileForPlan(plan)?.agent === agent;
}

export function terminalModelControlSlashCompletionRows(
  plan: TerminalModelControlPlan
): readonly string[] {
  return terminalModelControlProfileForPlan(plan)?.slashCompletionRows ?? [];
}

export function terminalModelControlAllowsStyledSlashPopupWithoutViewportPaint(
  plan: TerminalModelControlPlan
): boolean {
  return terminalModelControlProfileForPlan(plan)
    ?.allowsStyledSlashPopupWithoutViewportPaint === true;
}

export function probeTerminalModelControlProfile(
  agent: ExecutorKind,
  agentVersion: string | undefined
): TerminalModelControlCapabilities {
  const version = nonBlank(agentVersion);
  if (!version) {
    return {
      status: "unknown",
      modelSelection: false,
      reasoningEffortSelection: false,
      reason:
        `the running ${agent === "codex" ? "Codex" : "Claude Code"} ` +
        "version could not be verified"
    };
  }
  const profile = terminalModelControlProfileFor(agent, version);
  if (!profile) {
    return {
      status: "unsupported",
      agentVersion: version,
      modelSelection: false,
      reasoningEffortSelection: false,
      reason:
        `${agent === "codex" ? "Codex" : "Claude Code"} ${version} ` +
        "has no verified model-control profile"
    };
  }
  return {
    status: "supported",
    agentVersion: profile.agentVersion,
    behaviorProfile: profile.behaviorProfile,
    scope: profile.plan.scope,
    modelSelection: true,
    reasoningEffortSelection: true,
    reason: profile.reason
  };
}

export function planTerminalModelControlProfile(
  capabilities: TerminalModelControlCapabilities
): TerminalModelControlPlan {
  if (
    capabilities.status !== "supported" ||
    capabilities.modelSelection !== true ||
    capabilities.reasoningEffortSelection !== true ||
    !capabilities.behaviorProfile ||
    !capabilities.scope
  ) {
    throw new Error(capabilities.reason);
  }
  const profile = MODEL_CONTROL_PROFILES.find((candidate) =>
    (!capabilities.agentVersion ||
      candidate.agentVersion === capabilities.agentVersion.trim()) &&
    candidate.behaviorProfile === capabilities.behaviorProfile &&
    candidate.plan.scope === capabilities.scope
  );
  if (!profile) {
    throw new Error("refusing an unprofiled terminal model-control plan");
  }
  return profile.plan;
}

function samePlan(
  left: TerminalModelControlPlan,
  right: TerminalModelControlPlan
): boolean {
  return left.behaviorProfile === right.behaviorProfile &&
    left.command === right.command &&
    left.scope === right.scope &&
    left.requiresIdle === right.requiresIdle &&
    left.requiresExactEmptyComposer === right.requiresExactEmptyComposer;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

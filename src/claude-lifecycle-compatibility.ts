export interface ClaudeLifecycleCompatibilityProfile {
  readonly lifecycleBehaviorProfile: string;
  readonly nativeInspectionBehaviorProfile: string;
  readonly nativeInspectionComposerStableMs: number;
  readonly nativeInspectionComposerSettleTimeoutMs: number;
  readonly nativeStatusPanelFields: readonly string[];
  readonly nativeStatusPanelRequiredValues: Readonly<Record<string, string>>;
  readonly resumableSourceVersions: readonly string[];
}

const CLAUDE_STATUS_PANEL_FIELDS_2_1_218 = Object.freeze([
  "Version",
  "Session name",
  "Session ID",
  "cwd",
  "Auth token",
  "Anthropic base URL",
  "Model",
  "MCP servers",
  "Setting sources"
]);

const CLAUDE_STATUS_PANEL_FIELDS_2_1_226 = Object.freeze([
  "Version",
  "Session name",
  "Session ID",
  "Session kind",
  "cwd",
  "Auth token",
  "Anthropic base URL",
  "Model",
  "MCP servers",
  "Setting sources"
]);

const CLAUDE_LIFECYCLE_PROFILES: Readonly<
  Record<string, ClaudeLifecycleCompatibilityProfile>
> = Object.freeze({
  "2.1.218": Object.freeze({
    lifecycleBehaviorProfile: "claude-code-2.1.218",
    nativeInspectionBehaviorProfile:
      "claude-code-2.1.218-native-status",
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 2_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_218,
    nativeStatusPanelRequiredValues: Object.freeze({}),
    resumableSourceVersions: Object.freeze(["2.1.218"])
  }),
  "2.1.226": Object.freeze({
    lifecycleBehaviorProfile: "claude-code-2.1.226",
    nativeInspectionBehaviorProfile:
      "claude-code-2.1.226-native-status",
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 5_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_226,
    nativeStatusPanelRequiredValues: Object.freeze({
      "Session kind": "interactive"
    }),
    resumableSourceVersions: Object.freeze(["2.1.218", "2.1.226"])
  })
});

// Preserve the historical optional-call default. Production discovery always
// supplies the exact running version, while callers that omitted it before the
// multi-profile registry continue to inspect 2.1.218 fixtures deterministically.
export const DEFAULT_CLAUDE_LIFECYCLE_VERSION = "2.1.218";

export function claudeLifecycleCompatibilityProfile(
  agentVersion: string | undefined
): ClaudeLifecycleCompatibilityProfile | undefined {
  return agentVersion
    ? CLAUDE_LIFECYCLE_PROFILES[agentVersion]
    : undefined;
}

export function claudeLifecycleBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  return claudeLifecycleCompatibilityProfile(agentVersion)
    ?.lifecycleBehaviorProfile;
}

export function claudeNativeInspectionBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  return claudeLifecycleCompatibilityProfile(agentVersion)
    ?.nativeInspectionBehaviorProfile;
}

export function supportedClaudeLifecycleVersions(): readonly string[] {
  return Object.keys(CLAUDE_LIFECYCLE_PROFILES);
}

export function claudeLifecycleSourceVersionSupported(
  runningAgentVersion: string | undefined,
  sourceAgentVersion: string | undefined
): boolean {
  if (!sourceAgentVersion) {
    return false;
  }
  return claudeLifecycleCompatibilityProfile(runningAgentVersion)
    ?.resumableSourceVersions.includes(sourceAgentVersion) === true;
}

export function profiledClaudeNativeStatusPanelFields(): readonly string[] {
  return [...new Set(
    Object.values(CLAUDE_LIFECYCLE_PROFILES)
      .flatMap((profile) => profile.nativeStatusPanelFields)
  )];
}

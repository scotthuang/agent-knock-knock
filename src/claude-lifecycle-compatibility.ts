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

const CLAUDE_STATUS_PANEL_FIELDS_2_1_251 = Object.freeze([
  "Version",
  "Session name",
  "Session ID",
  "Session kind",
  "Peer address",
  "cwd",
  "Auth token",
  "Anthropic base URL",
  "Model",
  "MCP servers",
  "Setting sources",
  "Skipped sources",
  "Claude Code on the web",
  "Managed settings (remote)"
]);

const CLAUDE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export const CLAUDE_UNVERIFIED_LIFECYCLE_BEHAVIOR_PROFILE =
  "claude-code-unverified-runtime-v1";
export const CLAUDE_UNVERIFIED_NATIVE_INSPECTION_BEHAVIOR_PROFILE =
  "claude-code-unverified-native-status-v1";

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
  }),
  "2.1.237": Object.freeze({
    lifecycleBehaviorProfile: "claude-code-2.1.237",
    nativeInspectionBehaviorProfile:
      "claude-code-2.1.237-native-status",
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 5_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_226,
    nativeStatusPanelRequiredValues: Object.freeze({
      "Session kind": "interactive"
    }),
    resumableSourceVersions: Object.freeze([
      "2.1.218",
      "2.1.226",
      "2.1.237"
    ])
  }),
  "2.1.251": Object.freeze({
    lifecycleBehaviorProfile: "claude-code-2.1.251",
    nativeInspectionBehaviorProfile:
      "claude-code-2.1.251-native-status",
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 5_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_251,
    nativeStatusPanelRequiredValues: Object.freeze({
      "Session kind": "interactive"
    }),
    resumableSourceVersions: Object.freeze([
      "2.1.218",
      "2.1.226",
      "2.1.237",
      "2.1.251"
    ])
  }),
  "2.1.259": Object.freeze({
    lifecycleBehaviorProfile: "claude-code-2.1.259",
    nativeInspectionBehaviorProfile:
      "claude-code-2.1.259-native-status",
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 5_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_251,
    nativeStatusPanelRequiredValues: Object.freeze({
      "Session kind": "interactive"
    }),
    resumableSourceVersions: Object.freeze([
      "2.1.218",
      "2.1.226",
      "2.1.237",
      "2.1.251",
      "2.1.259"
    ])
  })
});

/**
 * Best-effort runtime protocol for complete x.y.z Claude Code versions
 * that AKK has not regression-tested yet. This deliberately reuses the newest
 * verified, bounded Status modal shape; a real TUI change therefore fails at
 * observation instead of being blocked solely by its version number.
 */
const CLAUDE_UNVERIFIED_LIFECYCLE_PROFILE:
  ClaudeLifecycleCompatibilityProfile = Object.freeze({
    lifecycleBehaviorProfile:
      CLAUDE_UNVERIFIED_LIFECYCLE_BEHAVIOR_PROFILE,
    nativeInspectionBehaviorProfile:
      CLAUDE_UNVERIFIED_NATIVE_INSPECTION_BEHAVIOR_PROFILE,
    nativeInspectionComposerStableMs: 80,
    nativeInspectionComposerSettleTimeoutMs: 5_000,
    nativeStatusPanelFields: CLAUDE_STATUS_PANEL_FIELDS_2_1_251,
    nativeStatusPanelRequiredValues: Object.freeze({
      "Session kind": "interactive"
    }),
    // Runtime candidate compatibility is structural and semver-based below;
    // this exact-version registry field remains only as historical evidence.
    resumableSourceVersions: Object.freeze([])
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

export function isValidClaudeSemanticVersion(
  agentVersion: string | undefined
): agentVersion is string {
  if (!agentVersion) {
    return false;
  }
  return CLAUDE_VERSION_PATTERN.test(agentVersion);
}

/**
 * Selects a runtime protocol without turning the exact tested-version registry
 * into an allowlist. Missing or malformed versions remain unknown.
 */
export function claudeRuntimeLifecycleCompatibilityProfile(
  agentVersion: string | undefined
): ClaudeLifecycleCompatibilityProfile | undefined {
  if (!isValidClaudeSemanticVersion(agentVersion)) {
    return undefined;
  }
  return claudeLifecycleCompatibilityProfile(agentVersion) ??
    CLAUDE_UNVERIFIED_LIFECYCLE_PROFILE;
}

export function claudeRuntimeCompatibilityWarning(
  agentVersion: string | undefined
): string | undefined {
  if (
    !isValidClaudeSemanticVersion(agentVersion) ||
    claudeLifecycleCompatibilityProfile(agentVersion)
  ) {
    return undefined;
  }
  return `Claude Code ${agentVersion} has not been regression-tested by AKK; ` +
    "the command will use the generic compatibility profile and may fail if the UI changed";
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
  return isValidClaudeSemanticVersion(runningAgentVersion) &&
    isValidClaudeSemanticVersion(sourceAgentVersion);
}

export function profiledClaudeNativeStatusPanelFields(): readonly string[] {
  return [...new Set(
    Object.values(CLAUDE_LIFECYCLE_PROFILES)
      .concat(CLAUDE_UNVERIFIED_LIFECYCLE_PROFILE)
      .flatMap((profile) => profile.nativeStatusPanelFields)
  )];
}

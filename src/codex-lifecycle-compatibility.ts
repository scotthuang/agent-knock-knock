const CODEX_LIFECYCLE_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  "0.146.0": "codex-tui-0.146.0",
  "0.146.1": "codex-tui-0.146.1",
  "0.147.0": "codex-tui-0.147.0",
  "0.148.0": "codex-tui-0.148.0",
  "0.149.1": "codex-tui-0.149.1",
  "0.150.1": "codex-tui-0.150.1",
  "0.151.0": "codex-tui-0.151.0",
  "0.153.0": "codex-tui-0.153.0"
});

/**
 * Stable behavior contract used for a complete x.y.z Codex version that
 * AKK has not regression-tested yet. Exact profiles remain useful as evidence
 * of verification, but are not a runtime allowlist.
 */
export const CODEX_GENERIC_RUNTIME_BEHAVIOR_PROFILE =
  "codex-tui-generic-v1";

const CODEX_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface CodexRuntimeCompatibilityProfile {
  readonly behaviorProfile: string;
  readonly versionCompatibility: "verified" | "unverified";
  readonly compatibilityWarning?: string;
}

export function codexLifecycleBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  return agentVersion
    ? CODEX_LIFECYCLE_PROFILES[agentVersion]
    : undefined;
}

/** True only for a complete x.y.z version shared by runtime and artifacts. */
export function isValidCodexAgentVersion(
  agentVersion: string | undefined
): agentVersion is string {
  if (!agentVersion) return false;
  return CODEX_SEMVER.test(agentVersion);
}

/**
 * Select the runtime behavior profile without turning the verified-version
 * registry into a feature gate.
 */
export function codexRuntimeCompatibilityProfile(
  agentVersion: string | undefined
): CodexRuntimeCompatibilityProfile | undefined {
  if (!isValidCodexAgentVersion(agentVersion)) return undefined;
  const exactProfile = codexLifecycleBehaviorProfile(agentVersion);
  if (exactProfile) {
    return {
      behaviorProfile: exactProfile,
      versionCompatibility: "verified"
    };
  }
  return {
    behaviorProfile: CODEX_GENERIC_RUNTIME_BEHAVIOR_PROFILE,
    versionCompatibility: "unverified",
    compatibilityWarning:
      `Codex ${agentVersion} has not been regression-tested by AKK; ` +
      "native terminal behavior will be attempted optimistically and may fail if the UI or lifecycle protocol changed"
  };
}

export function codexRuntimeLifecycleBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  return codexRuntimeCompatibilityProfile(agentVersion)?.behaviorProfile;
}

export function supportedCodexLifecycleVersions(): readonly string[] {
  return Object.keys(CODEX_LIFECYCLE_PROFILES);
}

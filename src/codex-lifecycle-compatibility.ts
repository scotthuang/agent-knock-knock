const CODEX_LIFECYCLE_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  "0.146.0": "codex-tui-0.146.0",
  "0.146.1": "codex-tui-0.146.1",
  "0.147.0": "codex-tui-0.147.0",
  "0.148.0": "codex-tui-0.148.0",
  "0.149.1": "codex-tui-0.149.1",
  "0.150.1": "codex-tui-0.150.1",
  "0.151.0": "codex-tui-0.151.0",
  "0.153.0": "codex-tui-0.153.0",
  "0.153.4": "codex-tui-0.153.4",
  "0.154.0": "codex-tui-0.154.0",
  "0.155.1": "codex-tui-0.155.1",
  "0.158.0": "codex-tui-0.158.0",
  "0.159.0": "codex-tui-0.159.0",
  "0.159.2": "codex-tui-0.159.2"
});

export type CodexPaginatedVersion = "0.158.0" | "0.159.0" | "0.159.2";
export type CodexPaginatedBackendVersion = CodexPaginatedVersion;

/** Versions whose paginated history and physical TUI binding are verified together. */
export function isCodexPaginatedVersion(value: unknown): value is CodexPaginatedVersion {
  return value === "0.158.0" || value === "0.159.0" || value === "0.159.2";
}

/**
 * Eligibility to try the closed paginated read contract, not proof of support.
 * The actual styled Composer, command popup, fresh status identity and backend
 * response must still pass their independent checks. Never use this for native
 * interaction writes, which require an audited physical/server version pair.
 */
export function isCodexPaginatedReadCandidate(value: unknown): value is string {
  if (typeof value !== "string" || !CODEX_SEMVER.test(value)) return false;
  const [major, minor] = value.split(".").map(Number);
  return major! > 0 || minor! >= 158;
}

/** Audited physical TUI and shared app-server pairs; unknown patch versions fail closed. */
export function isAuditedCodexPaginatedServerPair(
  agentVersion: unknown,
  serverVersion: unknown
): serverVersion is CodexPaginatedBackendVersion {
  return agentVersion === "0.158.0" && serverVersion === "0.158.0" ||
    agentVersion === "0.159.0" &&
      (serverVersion === "0.159.0" || serverVersion === "0.159.2") ||
    agentVersion === "0.159.2" && serverVersion === "0.159.2";
}

/**
 * Stable behavior contract used for a complete x.y.z Codex version that
 * AKK has not regression-tested yet. Exact profiles remain useful as evidence
 * of verification, but are not a runtime allowlist.
 */
export const CODEX_GENERIC_RUNTIME_BEHAVIOR_PROFILE =
  "codex-tui-generic-v1";

const CODEX_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

/**
 * Known protocol changes are different from a merely unverified release.
 * These versions create durable TUI threads with paginated history, including
 * under --no-daemon. Their shared server can also own the history instead of
 * the physical TUI process, so the legacy rollout/FD protocol cannot prove a
 * managed task or thread transition.
 */
export function codexUnsupportedDurableHistoryWarning(
  agentVersion: string | undefined
): string | undefined {
  if (agentVersion !== "0.157.0" && agentVersion !== "0.157.1") {
    return undefined;
  }
  return `Codex ${agentVersion} creates durable TUI sessions with paginated ` +
    "history and may use a shared background server; AKK does not yet support " +
    "that history and identity protocol. Managed completion callbacks, native " +
    "thread lifecycle actions, and native status dispatch are unavailable; explicit terminal Send " +
    "and terminal-activity Watch remain available subject to native UI safety checks";
}

/** Paginated Watch support does not implement legacy managed thread transitions. */
export function codexThreadLifecycleHistoryWarning(agentVersion: string | undefined): string | undefined {
  if (isCodexPaginatedVersion(agentVersion)) return `Codex ${agentVersion} paginated task Watch is supported, but managed native thread new/resume requires a separate paginated lifecycle adapter`;
  if (isCodexPaginatedReadCandidate(agentVersion)) return `Codex ${agentVersion} may support the paginated task read contract, but managed native thread new/resume requires a separate paginated lifecycle adapter`;
  return codexUnsupportedDurableHistoryWarning(agentVersion);
}

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
      codexUnsupportedDurableHistoryWarning(agentVersion) ??
      (`Codex ${agentVersion} has not been regression-tested by AKK; ` +
        "native terminal behavior will be attempted optimistically and may fail if the UI or lifecycle protocol changed")
  };
}

/** A shared strict fullscreen status grammar, with the actual TUI version pinned. */
export function codexNativeInspectionCompatibilityProfile(
  agentVersion: string | undefined
): CodexRuntimeCompatibilityProfile | undefined {
  const profile = codexRuntimeCompatibilityProfile(agentVersion);
  if (!profile || profile.versionCompatibility === "verified" ||
      !isCodexPaginatedReadCandidate(agentVersion)) return profile;
  return {
    ...profile,
    behaviorProfile: `codex-tui-fullscreen-status-v1@${agentVersion}`,
    compatibilityWarning: `Codex ${agentVersion} has not been regression-tested by AKK; ` +
      "read-only status and task observation require the recognized fullscreen UI and paginated read contracts; native interaction writes remain version-gated"
  };
}

export function codexRuntimeLifecycleBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  if (codexUnsupportedDurableHistoryWarning(agentVersion)) return undefined;
  return codexRuntimeCompatibilityProfile(agentVersion)?.behaviorProfile;
}

export function supportedCodexLifecycleVersions(): readonly string[] {
  return Object.keys(CODEX_LIFECYCLE_PROFILES);
}

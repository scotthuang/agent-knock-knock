const CODEX_LIFECYCLE_PROFILES: Readonly<Record<string, string>> = Object.freeze({
  "0.146.0": "codex-tui-0.146.0",
  "0.146.1": "codex-tui-0.146.1",
  "0.147.0": "codex-tui-0.147.0"
});

export function codexLifecycleBehaviorProfile(
  agentVersion: string | undefined
): string | undefined {
  return agentVersion
    ? CODEX_LIFECYCLE_PROFILES[agentVersion]
    : undefined;
}

export function supportedCodexLifecycleVersions(): readonly string[] {
  return Object.keys(CODEX_LIFECYCLE_PROFILES);
}

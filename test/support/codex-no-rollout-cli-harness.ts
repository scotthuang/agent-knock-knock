interface CodexNoRolloutStorePaths {
  storeDir: string;
  codexHome: string;
}

export function codexNoRolloutStoreArgs(
  fixture: CodexNoRolloutStorePaths
): string[] {
  return [
    "--store-dir",
    fixture.storeDir,
    "--codex-home",
    fixture.codexHome
  ];
}

export function codexNoRolloutBackgroundSendArgs(
  fixture: CodexNoRolloutStorePaths
): string[] {
  return [
    "--background",
    ...codexNoRolloutStoreArgs(fixture),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
}

export function codexNativeAcceptanceEnv(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
}

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

export function codexNoRolloutManagedStateMachineArgs(
  args: readonly string[]
): string[] {
  if (
    args[0] !== "send" ||
    args.includes("--managed-only") ||
    args.includes("--expected-terminal-token")
  ) {
    return [...args];
  }
  const exactTerminalTarget = ["--session", "--conversation"]
    .map((option) => args.indexOf(option))
    .some((index) => index >= 0 && args[index + 1]?.startsWith("terminal:v"));
  return exactTerminalTarget ? [...args, "--managed-only"] : [...args];
}

export function codexNativeAcceptanceEnv(
  environment: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...environment,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "0"
  };
}

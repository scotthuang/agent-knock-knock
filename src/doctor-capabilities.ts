import { spawnSync } from "node:child_process";
import { claudeNativeInspectionBehaviorProfile } from "./claude-lifecycle-compatibility.js";
import { codexLifecycleBehaviorProfile } from "./codex-lifecycle-compatibility.js";

export type DoctorMode = "tmux";

export type DoctorReadiness = "ready" | "partially_ready" | "not_ready";

export type DoctorProbeCommand =
  | "openclaw"
  | "tmux"
  | "herdr"
  | "codex"
  | "claude";

export type DoctorProbeStatus =
  | "ok"
  | "not_found"
  | "not_executable"
  | "version_failed"
  | "timeout"
  | "malformed_output";

export interface DoctorCommandCheck {
  command: string;
  available: boolean;
  version_supported?: boolean;
  native_profile_supported?: boolean;
  native_profile?: string;
  status?: DoctorProbeStatus;
}

export interface DoctorCommandProbe extends DoctorCommandCheck {
  command: DoctorProbeCommand;
  status: DoctorProbeStatus;
  executable: string;
  args: readonly string[];
  found: boolean;
  executable_ok: boolean;
  duration_ms: number;
  version?: string;
  output?: string;
  error?: string;
  exit_code?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface DoctorProbeOptions {
  /**
   * Timeout for each command. Values above 30 seconds are clamped so a doctor
   * run cannot become unbounded through configuration.
   */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  executables?: Partial<Record<DoctorProbeCommand, string>>;
}

interface DoctorModeCapability {
  available: boolean;
  status: DoctorReadiness;
  agents: string[];
  requires: string[];
  missing: string[];
}

interface DoctorTmuxCapability extends DoctorModeCapability {
  recommended: true;
}

interface DoctorHerdrCapability extends DoctorModeCapability {
  version_supported: boolean;
  required_version: typeof DOCTOR_SUPPORTED_HERDR_VERSION;
}

export interface DoctorCapabilitySummary {
  coreOk: boolean;
  transportOk: boolean;
  available_transports: Array<"tmux" | "herdr">;
  /** Retained for compatibility with existing doctor consumers. */
  mode: DoctorMode;
  readiness: DoctorReadiness;
  tmux: DoctorTmuxCapability;
  herdr: DoctorHerdrCapability;
}

export const DOCTOR_SUPPORTED_HERDR_VERSION = "0.8.0" as const;

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_BUFFER_BYTES = 64 * 1024;
const MAX_REPORTED_OUTPUT_CHARS = 2_000;

const PROBE_ARGUMENTS: Readonly<Record<DoctorProbeCommand, readonly string[]>> = {
  openclaw: ["--version"],
  tmux: ["-V"],
  herdr: ["--version"],
  codex: ["--version"],
  claude: ["--version"]
};

const DEFAULT_PROBE_EXECUTABLES: Readonly<Record<DoctorProbeCommand, string>> = {
  openclaw: "openclaw",
  tmux: "tmux",
  herdr: "herdr",
  codex: "codex",
  claude: "claude"
};

export const DOCTOR_PROBE_COMMANDS = Object.freeze(
  Object.keys(PROBE_ARGUMENTS) as DoctorProbeCommand[]
);

/**
 * Return the exact native lifecycle/status profile verified for a coding-agent
 * version. This diagnostic never controls general doctor readiness: unknown
 * versions may still support ordinary terminal work while native lifecycle and
 * inspection remain fail closed.
 */
export function doctorCodingAgentNativeProfile(
  command: "codex" | "claude",
  version: string | undefined
): string | undefined {
  return command === "codex"
    ? codexLifecycleBehaviorProfile(version)
    : claudeNativeInspectionBehaviorProfile(version);
}

/**
 * Run a bounded, non-interactive version probe for one doctor dependency.
 *
 * This deliberately does not invoke a shell. Successful process execution is
 * not enough: the output must also contain a recognizable version.
 */
export function probeDoctorCommand(
  command: DoctorProbeCommand,
  options: DoctorProbeOptions = {}
): DoctorCommandProbe {
  const executable =
    options.executables?.[command] ?? DEFAULT_PROBE_EXECUTABLES[command];
  const args = PROBE_ARGUMENTS[command];
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const startedAt = Date.now();
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      ...options.env
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_PROBE_BUFFER_BYTES,
    windowsHide: true
  });
  const durationMs = Date.now() - startedAt;
  const output = cleanProbeOutput([result.stdout, result.stderr].filter(Boolean).join("\n"));
  const processError = result.error as NodeJS.ErrnoException | undefined;

  if (processError) {
    const status = classifySpawnError(processError);
    return buildProbeResult({
      command,
      executable,
      args,
      status,
      durationMs,
      output,
      error: processError.message,
      exitCode: result.status,
      signal: result.signal
    });
  }

  if (result.status !== 0) {
    return buildProbeResult({
      command,
      executable,
      args,
      status: "version_failed",
      durationMs,
      output,
      error: output || `${command} version probe exited with status ${result.status}`,
      exitCode: result.status,
      signal: result.signal
    });
  }

  const version = parseVersion(output);
  if (!version) {
    return buildProbeResult({
      command,
      executable,
      args,
      status: "malformed_output",
      durationMs,
      output,
      error: `${command} version probe did not return a recognizable version`,
      exitCode: result.status,
      signal: result.signal
    });
  }

  return buildProbeResult({
    command,
    executable,
    args,
    status: "ok",
    durationMs,
    output,
    version,
    exitCode: result.status,
    signal: result.signal
  });
}

/**
 * Probe every external command used by the supported terminal transports.
 */
export function runDoctorCapabilityProbes(
  options: DoctorProbeOptions = {}
): DoctorCommandProbe[] {
  return DOCTOR_PROBE_COMMANDS.map((command) =>
    probeDoctorCommand(command, options)
  );
}

export function evaluateDoctorCapabilities(
  checks: readonly DoctorCommandCheck[]
): DoctorCapabilitySummary {
  const checkByCommand = new Map(checks.map((check) => [check.command, check]));
  const nodeCheck = checkByCommand.get("node");
  const nodeOk =
    isUsable(nodeCheck) &&
    nodeCheck?.version_supported === true;
  const openclawOk = isUsable(checkByCommand.get("openclaw"));
  const coreOk = nodeOk && openclawOk;
  const missingCore = [
    ...(!nodeOk ? ["node"] : []),
    ...(!openclawOk ? ["openclaw"] : [])
  ];
  const availableAgents = ["codex", "claude"]
    .filter((agent) => isUsable(checkByCommand.get(agent)));
  const agentsOk = availableAgents.length > 0;
  const tmuxTransportOk = isUsable(checkByCommand.get("tmux"));
  const herdrCheck = checkByCommand.get("herdr");
  const herdrExecutableOk = isUsable(herdrCheck);
  const herdrVersionSupported =
    herdrExecutableOk && herdrCheck?.version_supported === true;

  const tmux = {
    available: tmuxTransportOk && agentsOk,
    status: readinessFromParts([coreOk, tmuxTransportOk, agentsOk]),
    recommended: true as const,
    agents: availableAgents,
    requires: ["node", "openclaw", "tmux", "codex or claude"],
    missing: [
      ...missingCore,
      ...(!tmuxTransportOk ? ["tmux"] : []),
      ...(!agentsOk ? ["codex or claude"] : [])
    ]
  };
  const herdr = {
    available: herdrVersionSupported && agentsOk,
    status: readinessFromParts([coreOk, herdrVersionSupported, agentsOk]),
    version_supported: herdrVersionSupported,
    required_version: DOCTOR_SUPPORTED_HERDR_VERSION,
    agents: availableAgents,
    requires: [
      "node",
      "openclaw",
      `herdr ${DOCTOR_SUPPORTED_HERDR_VERSION}`,
      "codex or claude"
    ],
    missing: [
      ...missingCore,
      ...(!herdrExecutableOk
        ? ["herdr"]
        : !herdrVersionSupported
          ? [`herdr ${DOCTOR_SUPPORTED_HERDR_VERSION}`]
          : []),
      ...(!agentsOk ? ["codex or claude"] : [])
    ]
  };
  const availableTransports: Array<"tmux" | "herdr"> = [
    ...(tmuxTransportOk ? ["tmux" as const] : []),
    ...(herdrVersionSupported ? ["herdr" as const] : [])
  ];
  const anyTransportOk = availableTransports.length > 0;

  return {
    coreOk,
    transportOk: anyTransportOk && agentsOk,
    available_transports: availableTransports,
    mode: "tmux",
    readiness: readinessFromParts([coreOk, anyTransportOk, agentsOk]),
    tmux,
    herdr
  };
}

function buildProbeResult({
  command,
  executable,
  args,
  status,
  durationMs,
  version,
  output,
  error,
  exitCode,
  signal
}: {
  command: DoctorProbeCommand;
  executable: string;
  args: readonly string[];
  status: DoctorProbeStatus;
  durationMs: number;
  version?: string;
  output?: string;
  error?: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}): DoctorCommandProbe {
  const nativeProfile =
    (command === "codex" || command === "claude") && status === "ok"
      ? doctorCodingAgentNativeProfile(command, version)
      : undefined;
  return {
    command,
    executable,
    args,
    status,
    available: status === "ok",
    ...(command === "codex" || command === "claude"
      ? {
          native_profile_supported: nativeProfile !== undefined,
          ...(nativeProfile ? { native_profile: nativeProfile } : {})
        }
      : {}),
    ...(command === "herdr"
      ? {
          version_supported:
            status === "ok" && version === DOCTOR_SUPPORTED_HERDR_VERSION
        }
      : {}),
    found: status !== "not_found",
    executable_ok: !["not_found", "not_executable"].includes(status),
    duration_ms: durationMs,
    ...(version ? { version } : {}),
    ...(output ? { output } : {}),
    ...(error ? { error } : {}),
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    ...(signal !== undefined ? { signal } : {})
  };
}

function classifySpawnError(error: NodeJS.ErrnoException): DoctorProbeStatus {
  if (error.code === "ENOENT" || error.code === "ENOTDIR") {
    return "not_found";
  }
  if (
    error.code === "EACCES" ||
    error.code === "EPERM" ||
    error.code === "EISDIR" ||
    error.code === "ENOEXEC"
  ) {
    return "not_executable";
  }
  if (error.code === "ETIMEDOUT") {
    return "timeout";
  }
  return "version_failed";
}

function cleanProbeOutput(value: string): string | undefined {
  const cleaned = value
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  return cleaned.slice(0, MAX_REPORTED_OUTPUT_CHARS);
}

function parseVersion(output: string | undefined): string | undefined {
  if (!output) {
    return undefined;
  }
  const match = output.match(
    /(?:^|[^0-9A-Za-z])v?(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+|[A-Za-z]\d*)?)(?=$|[^0-9A-Za-z])/m
  );
  return match?.[1];
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_PROBE_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("doctor probe timeoutMs must be a positive finite number");
  }
  return Math.min(Math.ceil(value), MAX_PROBE_TIMEOUT_MS);
}

function isUsable(check: DoctorCommandCheck | undefined): boolean {
  return check?.available === true && (check.status === undefined || check.status === "ok");
}

function readinessFromParts(parts: readonly boolean[]): DoctorReadiness {
  const readyParts = parts.filter(Boolean).length;
  if (readyParts === parts.length) {
    return "ready";
  }
  return readyParts === 0 ? "not_ready" : "partially_ready";
}

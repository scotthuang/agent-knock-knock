import { spawnSync } from "node:child_process";

export type DoctorMode = "tmux";

export type DoctorReadiness = "ready" | "partially_ready" | "not_ready";

export type DoctorProbeCommand =
  | "openclaw"
  | "tmux"
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

export interface DoctorCapabilitySummary {
  coreOk: boolean;
  transportOk: boolean;
  mode: DoctorMode;
  readiness: DoctorReadiness;
  tmux: DoctorTmuxCapability;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_BUFFER_BYTES = 64 * 1024;
const MAX_REPORTED_OUTPUT_CHARS = 2_000;

const PROBE_ARGUMENTS: Readonly<Record<DoctorProbeCommand, readonly string[]>> = {
  openclaw: ["--version"],
  tmux: ["-V"],
  codex: ["--version"],
  claude: ["--version"]
};

const DEFAULT_PROBE_EXECUTABLES: Readonly<Record<DoctorProbeCommand, string>> = {
  openclaw: "openclaw",
  tmux: "tmux",
  codex: "codex",
  claude: "claude"
};

export const DOCTOR_PROBE_COMMANDS = Object.freeze(
  Object.keys(PROBE_ARGUMENTS) as DoctorProbeCommand[]
);

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
 * Probe every external command used by the tmux execution mode.
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
  const tmuxTransportOk = isUsable(checkByCommand.get("tmux"));

  const tmux = {
    available: tmuxTransportOk && availableAgents.length > 0,
    status: readinessFromParts([coreOk, tmuxTransportOk, availableAgents.length > 0]),
    recommended: true as const,
    agents: availableAgents,
    requires: ["node", "openclaw", "tmux", "codex or claude"],
    missing: [
      ...missingCore,
      ...(!tmuxTransportOk ? ["tmux"] : []),
      ...(availableAgents.length === 0 ? ["codex or claude"] : [])
    ]
  };

  return {
    coreOk,
    transportOk: tmux.available,
    mode: "tmux",
    readiness: tmux.status,
    tmux
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
  return {
    command,
    executable,
    args,
    status,
    available: status === "ok",
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

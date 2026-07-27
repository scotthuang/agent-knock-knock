import { spawnSync } from "node:child_process";

export type DoctorMode = "tmux" | "acpx" | "all";

export type DoctorReadiness = "ready" | "partially_ready" | "not_ready";

export type DoctorProbeCommand =
  | "openclaw"
  | "tmux"
  | "acpx"
  | "codex"
  | "claude"
  | "cursor";

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

interface DoctorAcpxCapability extends DoctorModeCapability {
  client: "acpx";
}

export interface DoctorCapabilitySummary {
  coreOk: boolean;
  transportOk: boolean;
  mode: DoctorMode;
  readiness: DoctorReadiness;
  tmux: DoctorTmuxCapability;
  acpx: DoctorAcpxCapability;
  /**
   * Backwards-compatible alias retained for existing CLI consumers.
   */
  acp: DoctorAcpxCapability;
}

const DEFAULT_PROBE_TIMEOUT_MS = 3_000;
const MAX_PROBE_TIMEOUT_MS = 30_000;
const MAX_PROBE_BUFFER_BYTES = 64 * 1024;
const MAX_REPORTED_OUTPUT_CHARS = 2_000;

const PROBE_ARGUMENTS: Readonly<Record<DoctorProbeCommand, readonly string[]>> = {
  openclaw: ["--version"],
  tmux: ["-V"],
  acpx: ["--version"],
  codex: ["--version"],
  claude: ["--version"],
  cursor: ["--version"]
};

const DEFAULT_PROBE_EXECUTABLES: Readonly<Record<DoctorProbeCommand, string>> = {
  openclaw: "openclaw",
  tmux: "tmux",
  acpx: "acpx",
  codex: "codex",
  claude: "claude",
  // ACPX's built-in Cursor adapter launches `cursor-agent acp`. The desktop
  // `cursor` shim may exist while no ACP-capable Cursor agent is available.
  cursor: "cursor-agent"
};

export const DOCTOR_PROBE_COMMANDS = Object.freeze(
  Object.keys(PROBE_ARGUMENTS) as DoctorProbeCommand[]
);

const MODE_PROBE_COMMANDS: Readonly<Record<DoctorMode, readonly DoctorProbeCommand[]>> = {
  tmux: ["openclaw", "tmux", "codex", "claude"],
  acpx: ["openclaw", "acpx", "codex", "claude", "cursor"],
  all: DOCTOR_PROBE_COMMANDS
};

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
 * Probe every external command used by the tmux and ACPX execution modes.
 */
export function runDoctorCapabilityProbes(
  options: DoctorProbeOptions = {},
  mode: DoctorMode = "all"
): DoctorCommandProbe[] {
  return MODE_PROBE_COMMANDS[mode].map((command) =>
    probeDoctorCommand(command, options)
  );
}

export function evaluateDoctorCapabilities(
  checks: readonly DoctorCommandCheck[],
  mode: DoctorMode = "all"
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
  const availableAgents = ["codex", "claude", "cursor"]
    .filter((agent) => isUsable(checkByCommand.get(agent)));
  const tmuxAgents = availableAgents.filter((agent) => agent !== "cursor");
  const tmuxTransportOk = isUsable(checkByCommand.get("tmux"));
  const acpxTransportOk = isUsable(checkByCommand.get("acpx"));

  const tmux = {
    available: tmuxTransportOk && tmuxAgents.length > 0,
    status: readinessFromParts([coreOk, tmuxTransportOk, tmuxAgents.length > 0]),
    recommended: true as const,
    agents: tmuxAgents,
    requires: ["node", "openclaw", "tmux", "codex or claude"],
    missing: [
      ...missingCore,
      ...(!tmuxTransportOk ? ["tmux"] : []),
      ...(tmuxAgents.length === 0 ? ["codex or claude"] : [])
    ]
  };
  const acpx = {
    available: acpxTransportOk && availableAgents.length > 0,
    status: readinessFromParts([coreOk, acpxTransportOk, availableAgents.length > 0]),
    client: "acpx" as const,
    agents: availableAgents,
    requires: ["node", "openclaw", "acpx", "codex, claude, or cursor"],
    missing: [
      ...missingCore,
      ...(!acpxTransportOk ? ["acpx"] : []),
      ...(availableAgents.length === 0 ? ["codex, claude, or cursor"] : [])
    ]
  };

  return {
    coreOk,
    transportOk: tmux.available || acpx.available,
    mode,
    readiness: selectedReadiness(mode, tmux.status, acpx.status),
    tmux,
    acpx,
    acp: acpx
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

function selectedReadiness(
  mode: DoctorMode,
  tmux: DoctorReadiness,
  acpx: DoctorReadiness
): DoctorReadiness {
  if (mode === "tmux") {
    return tmux;
  }
  if (mode === "acpx") {
    return acpx;
  }
  // "all" inspects both execution modes, but the product only requires one
  // usable transport. Per-mode status still shows which optional mode needs
  // attention.
  if (tmux === "ready" || acpx === "ready") {
    return "ready";
  }
  if (tmux === "not_ready" && acpx === "not_ready") {
    return "not_ready";
  }
  return "partially_ready";
}

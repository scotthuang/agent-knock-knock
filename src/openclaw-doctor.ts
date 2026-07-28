import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type OpenClawDiagnosticStatus =
  | "ok"
  | "failed"
  | "missing"
  | "invalid"
  | "unreachable";

export interface OpenClawDiagnosticCheck {
  name:
    | "config"
    | "plugin_entry"
    | "plugin_installed"
    | "plugin_enabled"
    | "plugin_runtime"
    | "skill"
    | "workspace"
    | "gateway";
  ok: boolean;
  status: OpenClawDiagnosticStatus;
  detail: string;
  remediation?: string[];
}

export interface OpenClawChainDiagnostics {
  ready: boolean;
  package_ready: boolean;
  gateway_ready: boolean;
  default_agent?: "codex" | "claude";
  workspace?: string;
  checks: OpenClawDiagnosticCheck[];
}

export interface OpenClawChainDiagnosticOptions {
  openclawBin: string;
  workspace?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface CommandResult {
  ok: boolean;
  json?: unknown;
  detail: string;
}

const PLUGIN_ID = "agent-knock-knock";
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

/**
 * Verify the complete OpenClaw-side AKK chain without returning config values
 * other than the explicitly non-secret workspace path.
 */
export function runOpenClawChainDiagnostics(
  options: OpenClawChainDiagnosticOptions
): OpenClawChainDiagnostics {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const run = (args: string[]): CommandResult =>
    runOpenClawJson(options.openclawBin, args, {
      timeoutMs,
      env: options.env,
      cwd: options.cwd
    });

  const checks: OpenClawDiagnosticCheck[] = [];
  const configResult = run(["config", "validate", "--json"]);
  const configJson = recordValue(configResult.json);
  const configOk = configResult.ok && configJson?.valid === true;
  checks.push({
    name: "config",
    ok: configOk,
    status: configOk ? "ok" : "invalid",
    detail: configOk
      ? "OpenClaw config is valid."
      : configResult.detail,
    ...(!configOk
      ? {
          remediation: [
            "openclaw config validate",
            "openclaw doctor --fix"
          ]
        }
      : {})
  });

  const entryResult = run([
    "config",
    "get",
    `plugins.entries.${PLUGIN_ID}`,
    "--json"
  ]);
  const entry = recordValue(entryResult.json);
  const entryOk = entryResult.ok && entry !== undefined;
  checks.push({
    name: "plugin_entry",
    ok: entryOk,
    status: entryOk ? "ok" : "missing",
    detail: entryOk
      ? "AKK has an OpenClaw plugin config entry."
      : entryResult.detail,
    ...(!entryOk
      ? {
          remediation: [
            "openclaw plugins install clawhub:@scotthuang/agent-knock-knock",
            "openclaw plugins enable agent-knock-knock"
          ]
        }
      : {})
  });

  const inspectResult = run([
    "plugins",
    "inspect",
    PLUGIN_ID,
    "--runtime",
    "--json"
  ]);
  const inspect = recordValue(inspectResult.json);
  const plugin = recordValue(inspect?.plugin);
  const installed = inspectResult.ok &&
    plugin?.id === PLUGIN_ID &&
    typeof plugin.source === "string";
  const enabled = installed && plugin?.enabled === true;
  const diagnostics = Array.isArray(inspect?.diagnostics) ? inspect.diagnostics : [];
  const runtimeLoaded = enabled &&
    plugin?.status === "loaded" &&
    diagnostics.length === 0;

  checks.push({
    name: "plugin_installed",
    ok: installed,
    status: installed ? "ok" : "missing",
    detail: installed
      ? "AKK is installed in OpenClaw."
      : inspectResult.detail,
    ...(!installed
      ? {
          remediation: [
            "openclaw plugins install clawhub:@scotthuang/agent-knock-knock"
          ]
        }
      : {})
  });
  checks.push({
    name: "plugin_enabled",
    ok: enabled,
    status: enabled ? "ok" : "failed",
    detail: enabled
      ? "AKK is enabled."
      : "AKK is not enabled.",
    ...(!enabled
      ? {
          remediation: ["openclaw plugins enable agent-knock-knock"]
        }
      : {})
  });
  checks.push({
    name: "plugin_runtime",
    ok: runtimeLoaded,
    status: runtimeLoaded ? "ok" : "failed",
    detail: runtimeLoaded
      ? "AKK runtime loaded with no diagnostics."
      : "AKK runtime is not loaded cleanly.",
    ...(!runtimeLoaded
      ? {
          remediation: [
            "openclaw plugins inspect agent-knock-knock --runtime --json",
            "openclaw gateway restart"
          ]
        }
      : {})
  });

  const skillResult = run(["skills", "info", PLUGIN_ID, "--json"]);
  const skill = recordValue(skillResult.json);
  const skillOk = skillResult.ok &&
    skill?.name === PLUGIN_ID &&
    skill?.eligible === true &&
    skill?.disabled !== true &&
    skill?.blockedByAllowlist !== true &&
    skill?.blockedByAgentFilter !== true;
  checks.push({
    name: "skill",
    ok: skillOk,
    status: skillOk ? "ok" : "missing",
    detail: skillOk
      ? "The bundled AKK skill is discoverable."
      : skillResult.detail,
    ...(!skillOk
      ? {
          remediation: [
            "openclaw skills info agent-knock-knock --json",
            "openclaw plugins update agent-knock-knock"
          ]
        }
      : {})
  });

  const configuredWorkspace = stringValue(recordValue(entry?.config)?.workspace);
  const configuredDefaultAgent = executorValue(recordValue(entry?.config)?.defaultAgent);
  const workspace = configuredWorkspace;
  const workspaceCheck = diagnoseWorkspace(workspace);
  if (workspaceCheck.ok && options.workspace && workspace) {
    let expectedWorkspace: string | undefined;
    try {
      expectedWorkspace = fs.realpathSync(options.workspace);
    } catch {
      // The expected path is checked below without aborting the rest of doctor.
    }
    if (!expectedWorkspace || expectedWorkspace !== fs.realpathSync(workspace)) {
      workspaceCheck.ok = false;
      workspaceCheck.status = "invalid";
      workspaceCheck.detail = expectedWorkspace
        ? "Configured AKK workspace does not match the requested workspace."
        : "Requested AKK workspace does not exist.";
      workspaceCheck.remediation = [
        `openclaw config set plugins.entries.agent-knock-knock.config.workspace ${expectedWorkspace ?? "/absolute/path/to/workspace"}`
      ];
    }
  }
  checks.push(workspaceCheck);

  const healthResult = run(["health", "--json", "--timeout", String(timeoutMs)]);
  const health = recordValue(healthResult.json);
  const gatewayOk = healthResult.ok && health?.ok === true;
  checks.push({
    name: "gateway",
    ok: gatewayOk,
    status: gatewayOk ? "ok" : "unreachable",
    detail: gatewayOk
      ? "OpenClaw Gateway is healthy."
      : healthResult.detail,
    ...(!gatewayOk
      ? {
          remediation: [
            "openclaw gateway restart",
            "openclaw health --json"
          ]
        }
      : {})
  });

  const packageChecks = checks.filter((check) => check.name !== "gateway");
  const packageReady = packageChecks.every((check) => check.ok);
  return {
    ready: packageReady && gatewayOk,
    package_ready: packageReady,
    gateway_ready: gatewayOk,
    ...(configuredDefaultAgent ? { default_agent: configuredDefaultAgent } : {}),
    ...(workspace ? { workspace } : {}),
    checks
  };
}

function diagnoseWorkspace(workspace: string | undefined): OpenClawDiagnosticCheck {
  const remediation = [
    "openclaw config set plugins.entries.agent-knock-knock.config.workspace /absolute/path/to/workspace"
  ];
  if (!workspace) {
    return {
      name: "workspace",
      ok: false,
      status: "missing",
      detail: "AKK workspace is not configured.",
      remediation
    };
  }
  if (!path.isAbsolute(workspace)) {
    return {
      name: "workspace",
      ok: false,
      status: "invalid",
      detail: "AKK workspace must be an absolute path.",
      remediation
    };
  }

  let stat: fs.Stats;
  let canonical: string;
  try {
    stat = fs.statSync(workspace);
    canonical = fs.realpathSync(workspace);
  } catch {
    return {
      name: "workspace",
      ok: false,
      status: "missing",
      detail: "Configured AKK workspace does not exist.",
      remediation
    };
  }
  if (!stat.isDirectory()) {
    return {
      name: "workspace",
      ok: false,
      status: "invalid",
      detail: "Configured AKK workspace is not a directory.",
      remediation
    };
  }
  if (path.normalize(workspace) !== canonical) {
    return {
      name: "workspace",
      ok: false,
      status: "invalid",
      detail: `AKK workspace is not canonical. Use: ${canonical}`,
      remediation: [
        `openclaw config set plugins.entries.agent-knock-knock.config.workspace ${canonical}`
      ]
    };
  }
  return {
    name: "workspace",
    ok: true,
    status: "ok",
    detail: "AKK workspace is absolute, canonical, and exists."
  };
}

function runOpenClawJson(
  executable: string,
  args: string[],
  options: {
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  }
): CommandResult {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
      ...options.env
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES,
    windowsHide: true
  });
  if (result.error) {
    const error = result.error as NodeJS.ErrnoException;
    const detail = error.code === "ETIMEDOUT"
      ? `openclaw ${args[0]} timed out.`
      : `openclaw ${args[0]} could not run (${error.code ?? "spawn_failed"}).`;
    return { ok: false, detail };
  }

  const json = parseJsonOutput(result.stdout);
  if (result.status !== 0) {
    return {
      ok: false,
      json,
      detail:
        `openclaw ${args.slice(0, 2).join(" ")} exited with status ${result.status}.`
    };
  }
  if (json === undefined) {
    return {
      ok: false,
      detail: `openclaw ${args[0]} returned malformed JSON.`
    };
  }
  return {
    ok: true,
    json,
    detail: `openclaw ${args[0]} completed.`
  };
}

function parseJsonOutput(output: string | Buffer | null | undefined): unknown {
  const text = String(output ?? "").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (!/^\s*[\[{]/u.test(lines[index])) {
        continue;
      }
      try {
        return JSON.parse(lines.slice(index).join("\n"));
      } catch {
        // Keep looking for a JSON suffix after incidental plugin logging.
      }
    }
    return undefined;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("OpenClaw diagnostic timeout must be a positive finite number");
  }
  return Math.min(Math.ceil(value), MAX_TIMEOUT_MS);
}

function recordValue(value: unknown): Record<string, any> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value
    : undefined;
}

function executorValue(value: unknown): "codex" | "claude" | undefined {
  return value === "codex" || value === "claude"
    ? value
    : undefined;
}

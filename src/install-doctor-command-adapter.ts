import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  cleanProcessText,
  expandHome,
  packageRootDir,
  positiveMilliseconds,
  resolveExecutable,
  resolveOptionalExecutable,
  writeCliJson
} from "./cli-command-runtime.js";
import { setCliExitCode } from "./cli-runtime-context.js";
import { evaluateDoctorCapabilities, runDoctorCapabilityProbes } from "./doctor-capabilities.js";
import { runOpenClawChainDiagnostics } from "./openclaw-doctor.js";
import type { UnknownRecord } from "./value-guards.js";

const MINIMUM_NODE_VERSION = "22.19.0";
const INSTALL_COMMAND_MAX_BUFFER_BYTES = 1024 * 1024 * 10;

export interface InstallDoctorCommandOptions extends Record<string, unknown> {
  mode?: unknown;
  workspace?: unknown;
  defaultAgent?: unknown;
  skillOnly?: boolean;
  verify?: boolean;
  noRestart?: boolean;
  openclawBin?: string;
  skillPath?: string;
  timeoutMs?: string | number;
  tmuxBin?: string;
  herdrBin?: string;
  codexBin?: string;
  claudeBin?: string;
}

export function runInstallOpenClaw(options: InstallDoctorCommandOptions): void {
  const root = packageRootDir();
  const skillOnly = options.skillOnly === true;
  if (options.workspace !== undefined) {
    throw new Error(
      "--workspace was removed from install-openclaw; AKK now discovers verified terminal panes across workspaces. Configure autoApprove.rules[].workspaces only for trusted automatic approvals."
    );
  }
  if (options.defaultAgent !== undefined) {
    throw new Error(
      "--default-agent was removed; AKK now selects the only eligible idle terminal pane"
    );
  }
  if (options.mode !== undefined) {
    throw new Error("--mode was removed; Agent Knock Knock discovers supported terminal providers automatically");
  }
  if (skillOnly && options.verify === true) {
    throw new Error("--skill-only cannot be combined with --verify");
  }

  const needsOpenClaw = !skillOnly || options.noRestart !== true || options.verify === true;
  const openclawBin = needsOpenClaw
    ? options.openclawBin ?? resolveExecutable("openclaw")
    : options.openclawBin;
  const skillSource = path.join(root, "templates", "openclaw-skills", "agent-knock-knock", "SKILL.md");
  const skillDest = expandHome(
    options.skillPath ?? "~/.openclaw/skills/agent-knock-knock/SKILL.md"
  );
  const steps: UnknownRecord[] = [];

  if (!skillOnly) {
    const pluginInstall = installOpenClawPlugin(openclawBin!, root);
    steps.push({ name: "plugin_installed", path: root, mode: pluginInstall.mode });
    const configOperations = [{
      path: "plugins.entries.agent-knock-knock.enabled",
      value: true
    }];
    runCheckedCommand(
      openclawBin!,
      ["config", "set", "--batch-json", JSON.stringify(configOperations)],
      "openclaw config set"
    );
    steps.push({
      name: "plugin_configured",
      plugin: "agent-knock-knock",
      updated: configOperations.map((operation) => operation.path)
    });
  }

  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  fs.copyFileSync(skillSource, skillDest);
  steps.push({ name: "skill_installed", path: skillDest });
  if (options.noRestart !== true) {
    runCheckedCommand(
      openclawBin!,
      ["gateway", "restart"],
      "openclaw gateway restart"
    );
    steps.push({ name: "gateway_restarted" });
  }

  const pendingRestart = !skillOnly && options.noRestart === true;
  const verification = options.verify === true
    ? buildDoctorReport({ ...options, openclawBin })
    : undefined;
  const result = {
    installed: true,
    ready: verification ? verification.ok === true && !pendingRestart : false,
    pending_restart: pendingRestart,
    mode: skillOnly ? "skill_only" : "full",
    execution_mode: "terminal_provider",
    terminal_providers: ["tmux", "herdr"],
    package_root: root,
    openclaw_bin: openclawBin ?? null,
    steps,
    ...(verification ? { verification } : {}),
    next_actions: installNextActions({ pendingRestart, verification })
  };
  writeCliJson(result);
}

export function runDoctor(options: InstallDoctorCommandOptions): void {
  const report = buildDoctorReport(options);
  writeCliJson(report);
  if (!report.ok) {
    setCliExitCode(1);
  }
}

function buildDoctorReport(options: InstallDoctorCommandOptions) {
  if (options.mode !== undefined) {
    throw new Error("--mode was removed; Agent Knock Knock checks supported terminal providers automatically");
  }
  if (options.workspace !== undefined) {
    throw new Error(
      "--workspace was removed from doctor; AKK now discovers verified terminal panes across workspaces"
    );
  }
  const timeoutMs = options.timeoutMs === undefined
    ? undefined
    : positiveMilliseconds(options.timeoutMs, "--timeout-ms");
  const openclawBin = String(
    options.openclawBin ?? resolveOptionalExecutable("openclaw")
  );
  const executables = {
    openclaw: openclawBin,
    ...(options.tmuxBin ? { tmux: String(options.tmuxBin) } : {}),
    herdr: String(options.herdrBin ?? resolveOptionalExecutable("herdr")),
    ...(options.codexBin ? { codex: String(options.codexBin) } : {}),
    ...(options.claudeBin ? { claude: String(options.claudeBin) } : {})
  };
  const checks = [{
    command: "node",
    status: "ok" as const,
    available: true,
    executable: process.execPath,
    version: process.versions.node,
    version_supported: versionAtLeast(process.versions.node, MINIMUM_NODE_VERSION),
    minimum_version: MINIMUM_NODE_VERSION
  }, ...runDoctorCapabilityProbes({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    executables
  })];
  const root = packageRootDir();
  const packageFiles = [
    "dist/src/cli.js",
    "dist/src/cli-core.js",
    "dist/src/openclaw-plugin.js",
    "templates/openclaw-skills/agent-knock-knock/SKILL.md",
    "openclaw.plugin.json"
  ].map((relativePath) => {
    const filePath = path.join(root, relativePath);
    return { path: filePath, exists: fs.existsSync(filePath) };
  });
  const capabilities = evaluateDoctorCapabilities(checks);
  const filesOk = packageFiles.every((check) => check.exists);
  const openclaw = runOpenClawChainDiagnostics({
    openclawBin,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  });
  const ok = capabilities.readiness === "ready" && filesOk && openclaw.ready;
  return {
    ok,
    readiness: ok
      ? "ready"
      : capabilities.readiness === "not_ready"
        ? "not_ready"
        : "partially_ready",
    selected_mode: capabilities.available_transports[0] ?? "terminal_provider",
    available_transports: capabilities.available_transports,
    live_terminal: {
      checked: false,
      required_for_install_readiness: false,
      detail:
        "Installation readiness checks tmux or exact-version Herdr and at least one supported CLI. " +
        "AKK verifies a live eligible pane when delegation begins."
    },
    package_root: root,
    checks,
    package_files: packageFiles,
    capabilities: { tmux: capabilities.tmux, herdr: capabilities.herdr },
    openclaw,
    notes: [
      `Node.js ${MINIMUM_NODE_VERSION}+ and OpenClaw are required.`,
      "AKK supports Codex and Claude Code through shared tmux or local Herdr terminals.",
      "Coding-agent checks report exact native lifecycle/status profiles separately; an unprofiled executable can remain available for ordinary terminal work while native actions fail closed.",
      "Doctor does not require a live coding-agent pane; delegation discovers and verifies one at send time.",
      "Claude terminal completion is hook-free and fails closed unless the local transcript schema is verified.",
      "Herdr support is exact-version gated to 0.8.0/protocol 19 and uses local Unix sockets."
    ]
  };
}

type DoctorReport = ReturnType<typeof buildDoctorReport>;

function installNextActions({
  pendingRestart,
  verification
}: {
  pendingRestart: boolean;
  verification?: DoctorReport;
}): Array<{ action: string; command: string }> {
  if (pendingRestart) {
    return [
      { action: "apply_plugin_changes", command: "openclaw gateway restart" },
      { action: "verify", command: "agent-knock-knock doctor" }
    ];
  }
  if (verification && verification.ok !== true) {
    const remediation = verification.openclaw.checks.flatMap(
      (check) => check.remediation ?? []
    );
    return [...new Set(remediation)].map((command) => ({
      action: "repair",
      command
    }));
  }
  if (!verification) {
    return [{ action: "verify", command: "agent-knock-knock doctor" }];
  }
  return [{
    action: "start_shared_terminal",
    command: "tmux new -s akk-work -c \"$PWD\" codex # use claude instead when preferred"
  }];
}

function installOpenClawPlugin(
  openclawBin: string,
  root: string
): { mode: "linked" | "replaced" } {
  const linked = spawnSync(openclawBin, ["plugins", "install", "--link", root], {
    encoding: "utf8",
    maxBuffer: INSTALL_COMMAND_MAX_BUFFER_BYTES
  });
  if (linked.error) {
    throw new Error(`openclaw plugins install failed to start: ${linked.error.message}`);
  }
  if (linked.status === 0) {
    return { mode: "linked" };
  }
  const failure = cleanProcessText(linked.stderr || linked.stdout)
    ?? `openclaw plugins install exited with status ${linked.status}`;
  if (!(/plugin already exists:/i.test(failure) ||
    /install cancelled;\s*rerun with --force\b/i.test(failure))) {
    throw new Error(failure);
  }
  runCheckedCommand(
    openclawBin,
    ["plugins", "install", "--force", root],
    "openclaw plugins replace"
  );
  return { mode: "replaced" };
}

function runCheckedCommand(
  command: string,
  args: string[],
  label: string
): void {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: INSTALL_COMMAND_MAX_BUFFER_BYTES
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(cleanProcessText(
      result.stderr || result.stdout || `${label} exited with status ${result.status}`
    ));
  }
}

function versionAtLeast(version: string, minimum: string): boolean {
  const parsed = version.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  const required = minimum.split(".").slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parsed.length !== 3 || required.length !== 3 ||
    [...parsed, ...required].some((part) => !Number.isInteger(part) || part < 0)) {
    return false;
  }
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== required[index]) {
      return parsed[index] > required[index];
    }
  }
  return true;
}

#!/usr/bin/env node

import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const packageJson = readJson(path.join(packageRoot, "package.json"));
const manifest = readJson(path.join(packageRoot, "openclaw.plugin.json"));
const minimumHostVersion = exactFloor(
  packageJson.openclaw?.install?.minHostVersion,
  "openclaw.install.minHostVersion"
);
const minimumApiVersion = exactFloor(
  packageJson.openclaw?.compat?.pluginApi,
  "openclaw.compat.pluginApi"
);
const buildVersion = requiredString(
  packageJson.openclaw?.build?.openclawVersion,
  "openclaw.build.openclawVersion"
);
const boundaryVersion = "2026.5.10-beta.2";
const knownTargets = [
  "minimum",
  "current",
  "api-minimum",
  "api-boundary"
];
const requestedTargets = parseTargets(process.argv.slice(2));
const tempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "akk-openclaw-compat-")
);
const summaries = [];
let artifactPath;

try {
  for (const target of requestedTargets) {
    const version = versionForTarget(target);
    process.stderr.write(
      `Verifying OpenClaw ${version} (${target})...\n`
    );
    const caseRoot = path.join(tempRoot, safeName(target));
    fs.mkdirSync(caseRoot, { recursive: true });
    const host = installHost(version, caseRoot);

    if (target === "api-minimum" || target === "api-boundary") {
      artifactPath ??= packArtifact(tempRoot);
      summaries.push(
        await verifyApiBoundary({
          artifactPath,
          caseRoot,
          expectSupported: target === "api-minimum",
          host,
          target,
          version
        })
      );
      continue;
    }

    artifactPath ??= packArtifact(tempRoot);
    summaries.push(
      await verifyFullHost({
        artifactPath,
        caseRoot,
        host,
        target,
        version
      })
    );
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    package: packageJson.name,
    package_version: packageJson.version,
    minimum_host_version: minimumHostVersion,
    minimum_plugin_api_version: minimumApiVersion,
    build_openclaw_version: buildVersion,
    api_boundary_version: boundaryVersion,
    results: summaries
  }, null, 2)}\n`);
} finally {
  if (process.env.AKK_KEEP_COMPAT_TEMP === "1") {
    process.stderr.write(`Compatibility temp retained at ${tempRoot}\n`);
  } else {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function parseTargets(argv) {
  if (argv.length === 0) {
    return knownTargets;
  }
  const selected = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--target") {
      throw new Error(`Unexpected compatibility argument: ${argument}`);
    }
    const target = argv[index + 1];
    if (!target || !knownTargets.includes(target)) {
      throw new Error(
        `--target must be one of: ${knownTargets.join(", ")}`
      );
    }
    selected.push(target);
    index += 1;
  }
  return [...new Set(selected)];
}

function versionForTarget(target) {
  if (target === "minimum") {
    return minimumHostVersion;
  }
  if (target === "current") {
    return buildVersion;
  }
  if (target === "api-minimum") {
    return minimumApiVersion;
  }
  return boundaryVersion;
}

function installHost(version, caseRoot) {
  const hostDir = path.join(caseRoot, "host");
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(
    path.join(hostDir, "package.json"),
    `${JSON.stringify({
      name: `akk-openclaw-compat-${safeName(version)}`,
      private: true,
      version: "0.0.0"
    }, null, 2)}\n`,
    "utf8"
  );
  const env = isolatedEnv({
    npm_config_cache: path.join(caseRoot, "npm-cache"),
    npm_config_update_notifier: "false"
  });
  runNpm([
    "install",
    "--no-audit",
    "--no-fund",
    "--prefer-offline",
    "--save-exact",
    `openclaw@${version}`
  ], {
    cwd: hostDir,
    env,
    timeoutMs: 8 * 60 * 1000
  });

  const openclawPackagePath = path.join(
    hostDir,
    "node_modules",
    "openclaw",
    "package.json"
  );
  const installedPackage = readJson(openclawPackagePath);
  assert.equal(
    installedPackage.version,
    version,
    "isolated host must contain the exact requested OpenClaw version"
  );
  const openclawBin = process.platform === "win32"
    ? path.join(hostDir, "node_modules", ".bin", "openclaw.cmd")
    : path.join(hostDir, "node_modules", ".bin", "openclaw");
  assert.equal(fs.existsSync(openclawBin), true, "OpenClaw CLI must exist");

  const versionResult = run(openclawBin, ["--version"], {
    cwd: hostDir,
    env,
    timeoutMs: 30_000
  });
  assert.match(
    `${versionResult.stdout}\n${versionResult.stderr}`,
    new RegExp(escapeRegex(version)),
    "OpenClaw CLI must report the exact candidate version"
  );

  return {
    dir: hostDir,
    env,
    openclawBin,
    packagePath: openclawPackagePath,
    version
  };
}

function packArtifact(root) {
  const artifactDir = path.join(root, "artifact");
  fs.mkdirSync(artifactDir, { recursive: true });
  const packed = run("npm", [
    "pack",
    "--ignore-scripts",
    "--pack-destination",
    artifactDir,
    "--silent"
  ], {
    cwd: packageRoot,
    env: isolatedEnv(),
    timeoutMs: 2 * 60 * 1000
  });
  const filename = packed.stdout.trim().split(/\r?\n/u).at(-1);
  const artifact = filename ? path.join(artifactDir, filename) : undefined;
  assert.equal(
    typeof artifact === "string" && fs.existsSync(artifact),
    true,
    "npm pack must create the AKK artifact"
  );
  return artifact;
}

async function verifyApiBoundary({
  artifactPath: artifact,
  caseRoot,
  expectSupported,
  host,
  target,
  version
}) {
  runNpm([
    "install",
    "--no-audit",
    "--no-fund",
    "--no-save",
    "--prefer-offline",
    "--legacy-peer-deps",
    artifact
  ], {
    cwd: host.dir,
    env: host.env,
    timeoutMs: 4 * 60 * 1000
  });
  assert.equal(
    readJson(host.packagePath).version,
    version,
    "installing the AKK artifact must not replace the candidate host"
  );

  const hostRequire = createRequire(path.join(host.dir, "package.json"));
  const testApiPath = hostRequire.resolve(
    "openclaw/plugin-sdk/plugin-test-api"
  );
  const { createTestPluginApi } = await import(
    pathToFileURL(testApiPath).href
  );
  assert.equal(typeof createTestPluginApi, "function");

  let gatewayHandler;
  const api = createTestPluginApi({
    pluginConfig: {},
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {}
    },
    async enqueueNextTurnInjection(injection) {
      return {
        enqueued: true,
        id: "compat-injection",
        sessionKey: injection.sessionKey
      };
    },
    registerGatewayMethod(method, handler) {
      if (method === "agent-knock-knock.callback") {
        gatewayHandler = handler;
      }
    }
  });
  assert.equal(
    typeof api.enqueueNextTurnInjection,
    "function",
    "the boundary host must retain the legacy flat injection API"
  );
  assert.equal(
    typeof api.session?.workflow?.enqueueNextTurnInjection,
    expectSupported ? "function" : "undefined"
  );

  const pluginPath = path.join(
    host.dir,
    "node_modules",
    "@scotthuang",
    "agent-knock-knock",
    "dist",
    "src",
    "openclaw-plugin.js"
  );
  const pluginModule = await import(pathToFileURL(pluginPath).href);
  const plugin = pluginModule.default;
  assert.equal(typeof plugin?.register, "function");
  plugin.register(api);
  assert.equal(typeof gatewayHandler, "function");

  let callbackResponse;
  await gatewayHandler({
    params: callbackParams(`api-${safeName(version)}`),
    respond(ok, result, error) {
      callbackResponse = { ok, result, error };
    }
  });
  assert.notEqual(callbackResponse, undefined);

  if (expectSupported) {
    assert.equal(callbackResponse.ok, true);
    assert.equal(callbackResponse.result?.enqueued, true);
    assert.equal(callbackResponse.result?.delivery_required, false);
    assert.equal(callbackResponse.error, undefined);
  } else {
    assert.equal(callbackResponse.ok, false);
    assert.equal(
      callbackResponse.error?.code,
      "AGENT_KNOCK_KNOCK_CALLBACK_FAILED"
    );
    assert.match(
      callbackResponse.error?.message ?? "",
      /workflow/u,
      "the adjacent boundary must fail on the missing grouped workflow API"
    );
  }

  return {
    target,
    openclaw_version: version,
    result: expectSupported
      ? "api-compatible"
      : "expected-incompatible",
    flat_injection_api: true,
    grouped_injection_api: expectSupported,
    callback: expectSupported ? "passed" : "failed-as-expected",
    incompatibility: expectSupported
      ? null
      : "api.session.workflow.enqueueNextTurnInjection is unavailable"
  };
}

async function verifyFullHost({
  artifactPath: artifact,
  caseRoot,
  host,
  target,
  version
}) {
  const stateDir = path.join(caseRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const openclawHome = path.join(caseRoot, "openclaw-home");
  const workspacePath = path.join(caseRoot, "workspace");
  const storeDir = path.join(caseRoot, "akk-store");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(openclawHome, { recursive: true });
  fs.mkdirSync(workspacePath, { recursive: true });
  const workspace = fs.realpathSync(workspacePath);
  const fakeExecutables = createFakeExecutables(caseRoot);
  const fakeBinDir = path.dirname(fakeExecutables.tmux);
  const port = await reservePort();
  const token = `akk-compat-${randomBytes(18).toString("hex")}`;
  const env = isolatedEnv({
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_DISABLE_BONJOUR: "1",
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_GATEWAY_TOKEN: token,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    PATH: [fakeBinDir, process.env.PATH].filter(Boolean).join(path.delimiter),
    npm_config_cache: path.join(caseRoot, "npm-cache"),
    npm_config_update_notifier: "false"
  });
  const openclaw = (args, options = {}) => run(host.openclawBin, args, {
    cwd: workspace,
    env,
    timeoutMs: options.timeoutMs ?? 90_000,
    ...options
  });
  const openclawJson = (args, options = {}) =>
    parseJsonOutput(openclaw(args, options).stdout, args.join(" "));

  setConfig(openclaw, "gateway.mode", "local");
  setConfig(openclaw, "gateway.port", port);
  setConfig(openclaw, "gateway.auth.mode", "token");
  setConfig(openclaw, "gateway.auth.token", token);
  setConfig(openclaw, "agents.defaults.workspace", workspace);

  openclaw([
    "plugins",
    "install",
    `npm-pack:${artifact}`,
    "--force"
  ], {
    timeoutMs: 4 * 60 * 1000
  });
  setConfig(openclaw, "plugins.allow", ["agent-knock-knock"]);
  setConfig(
    openclaw,
    "plugins.entries.agent-knock-knock.config.workspace",
    workspace
  );
  setConfig(
    openclaw,
    "plugins.entries.agent-knock-knock.config.storeDir",
    storeDir
  );
  setConfig(
    openclaw,
    "plugins.entries.agent-knock-knock.config.openclawBin",
    host.openclawBin
  );

  const inspect = openclawJson([
    "plugins",
    "inspect",
    "agent-knock-knock",
    "--runtime",
    "--json"
  ]);
  assertRuntimeContract(inspect);

  const skill = openclawJson([
    "skills",
    "info",
    "agent-knock-knock",
    "--json"
  ]);
  assert.equal(skill.eligible, true);
  assert.equal(skill.disabled, false);
  assert.equal(skill.modelVisible, true);
  assert.equal(skill.userInvocable, true);
  assert.equal(
    isInside(stateDir, requiredString(skill.filePath, "skill.filePath")),
    true,
    "bundled skill must resolve inside the isolated OpenClaw state"
  );

  const pluginRoot = requiredString(
    inspect.plugin?.rootDir,
    "inspect.plugin.rootDir"
  );
  const relayPath = path.join(pluginRoot, "dist", "src", "cli.js");
  assert.equal(fs.existsSync(relayPath), true);
  const relayVersion = run(process.execPath, [relayPath, "--version"], {
    cwd: workspace,
    env,
    timeoutMs: 30_000
  });
  assert.match(relayVersion.stdout, new RegExp(escapeRegex(packageJson.version)));

  const readOnlyList = parseJsonOutput(
    run(process.execPath, [
      relayPath,
      "list",
      "--store-dir",
      storeDir,
      "--terminal-debug",
      "--processes-json",
      JSON.stringify([{
        pid: 2202,
        ppid: 9002,
        elapsed: "00:21",
        command: "codex",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target: "akk-compat:0.0",
        session: "akk-compat",
        window: 0,
        pane: 0,
        panePid: 9002,
        currentCommand: "node",
        currentPath: workspace
      }]),
      "--terminal-screens-json",
      JSON.stringify({
        "akk-compat:0.0": "Codex is ready\n›"
      })
    ], {
      cwd: workspace,
      env,
      timeoutMs: 60_000
    }).stdout,
    "agent-knock-knock list --terminal-debug"
  );
  assert.equal(readOnlyList.terminal_controlled?.length, 1);
  assert.equal(
    readOnlyList.terminal_controlled[0]?.terminal_control?.target,
    "akk-compat:0.0"
  );
  assert.equal(readOnlyList.native_scan?.terminal_scan?.provider, "static");

  const gateway = startGateway({
    env,
    host,
    port,
    token,
    workspace
  });
  try {
    await gateway.ready;
    await waitForGatewayOutput(
      gateway,
      /agent-knock-knock monitor reconciliation: checked=\d+ launched=\d+ already_running=\d+ skipped=\d+ errors=0/u
    );
    const callback = gatewayCall({
      env,
      host,
      method: "agent-knock-knock.callback",
      params: callbackParams(`gateway-${safeName(version)}`),
      port,
      token,
      workspace
    });
    assert.equal(callback.ok, true);
    assert.equal(callback.enqueued, true);
    assert.equal(callback.delivery_required, false);
    assert.equal(callback.delivery_mode, "none");
    assert.equal(
      callback.session_key,
      `agent:main:gateway-${safeName(version)}`
    );

    const health = gatewayCall({
      env,
      host,
      method: "health",
      params: {},
      port,
      token,
      workspace
    });
    assert.notEqual(health, null);

    const commands = gatewayCall({
      env,
      host,
      method: "commands.list",
      params: {},
      port,
      token,
      workspace
    });
    assert.equal(hasAkkCommand(commands), true);

    await verifyAkkDoctorCommand({
      env,
      host,
      port,
      token,
      version,
      workspace
    });

    const doctor = parseJsonOutput(
      run(process.execPath, [
        relayPath,
        "doctor",
        "--workspace",
        workspace,
        "--openclaw-bin",
        host.openclawBin,
        "--tmux-bin",
        fakeExecutables.tmux,
        "--codex-bin",
        fakeExecutables.codex,
        "--claude-bin",
        fakeExecutables.claude,
        "--timeout-ms",
        "20000"
      ], {
        cwd: workspace,
        env,
        timeoutMs: 2 * 60 * 1000,
        allowNonzero: true
      }).stdout,
      "agent-knock-knock doctor"
    );
    assert.equal(doctor.openclaw?.package_ready, true);
    assert.equal(doctor.openclaw?.gateway_ready, true);
    assert.equal(doctor.capabilities?.tmux?.status, "ready");
  } finally {
    await stopGateway(gateway);
  }

  openclaw([
    "plugins",
    "install",
    `npm-pack:${artifact}`,
    "--force"
  ], {
    timeoutMs: 4 * 60 * 1000
  });
  const inspectAfterUpdate = openclawJson([
    "plugins",
    "inspect",
    "agent-knock-knock",
    "--runtime",
    "--json"
  ]);
  assertRuntimeContract(inspectAfterUpdate);
  const lifecycle = verifyPluginLifecycle({
    artifact,
    caseRoot,
    host,
    workspace
  });

  return {
    target,
    openclaw_version: version,
    result: "compatible",
    install: "npm-pack --force",
    runtime_status: inspect.plugin?.status,
    tools: normalizedToolNames(inspect).length,
    command: "akk",
    service: "agent-knock-knock-monitor-reconciliation",
    gateway_method: "agent-knock-knock.callback",
    callback: "passed",
    akk_doctor_command: "passed",
    bundled_skill: "eligible",
    tmux_read_only_fixture: "passed",
    tmux_diagnostics: "passed",
    update_reinstall: "passed",
    update_dry_run: lifecycle.update,
    uninstall: "passed"
  };
}

function verifyPluginLifecycle({
  artifact,
  caseRoot,
  host,
  workspace
}) {
  const stateDir = path.join(caseRoot, "lifecycle-state");
  const configPath = path.join(stateDir, "openclaw.json");
  const openclawHome = path.join(caseRoot, "lifecycle-home");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(openclawHome, { recursive: true });
  const env = isolatedEnv({
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_HOME: openclawHome,
    OPENCLAW_STATE_DIR: stateDir,
    npm_config_cache: path.join(caseRoot, "npm-cache"),
    npm_config_update_notifier: "false"
  });
  const openclaw = (args, options = {}) => run(host.openclawBin, args, {
    cwd: workspace,
    env,
    timeoutMs: options.timeoutMs ?? 90_000,
    ...options
  });

  // A plain tarball is intentionally tracked as an archive. That lets the
  // candidate verify update CLI behavior without consulting npm, where the
  // previously published release still carries the old compatibility floor.
  openclaw(["plugins", "install", artifact, "--force"], {
    timeoutMs: 4 * 60 * 1000
  });
  const update = openclaw([
    "plugins",
    "update",
    "agent-knock-knock",
    "--dry-run"
  ]);
  assert.match(
    `${update.stdout}\n${update.stderr}`,
    /Skipping "agent-knock-knock" \(source: archive\)/u
  );
  openclaw(["plugins", "install", artifact, "--force"], {
    timeoutMs: 4 * 60 * 1000
  });
  openclaw([
    "plugins",
    "uninstall",
    "agent-knock-knock",
    "--dry-run"
  ]);
  openclaw([
    "plugins",
    "uninstall",
    "agent-knock-knock",
    "--force"
  ], {
    timeoutMs: 2 * 60 * 1000
  });
  const afterUninstall = openclaw([
    "plugins",
    "inspect",
    "agent-knock-knock",
    "--runtime",
    "--json"
  ], {
    allowNonzero: true
  });
  assert.notEqual(
    afterUninstall.status,
    0,
    "the plugin must no longer inspect successfully after uninstall"
  );
  return {
    update: "archive-skip-passed"
  };
}

function assertRuntimeContract(inspect) {
  const plugin = inspect.plugin ?? {};
  assert.equal(plugin.status, "loaded");
  assert.equal(plugin.enabled, true);
  assert.equal(plugin.imported, true);
  assert.equal(plugin.configSchema, true);
  const diagnostics = Array.isArray(plugin.diagnostics)
    ? plugin.diagnostics
    : Array.isArray(inspect.diagnostics)
      ? inspect.diagnostics
      : [];
  assert.deepEqual(
    diagnostics.filter((entry) => entry?.level === "error"),
    [],
    "runtime inspect must not report error diagnostics"
  );
  assert.deepEqual(
    normalizedToolNames(inspect),
    sorted(requiredStringArray(manifest.contracts?.tools, "contracts.tools"))
  );
  assert.equal(
    normalizedNames(plugin.commands ?? inspect.commands).includes("akk"),
    true
  );
  assert.equal(
    normalizedNames(plugin.services ?? inspect.services).includes(
      "agent-knock-knock-monitor-reconciliation"
    ),
    true
  );
  assert.equal(
    normalizedNames(
      plugin.gatewayMethods ?? inspect.gatewayMethods
    ).includes("agent-knock-knock.callback"),
    true
  );
}

function normalizedToolNames(inspect) {
  const direct = inspect.plugin?.toolNames;
  if (Array.isArray(direct)) {
    return sorted(direct.filter((value) => typeof value === "string"));
  }
  const tools = Array.isArray(inspect.tools) ? inspect.tools : [];
  return sorted(
    tools.flatMap((tool) =>
      Array.isArray(tool?.names)
        ? tool.names.filter((value) => typeof value === "string")
        : []
    )
  );
}

function normalizedNames(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (typeof entry === "string") {
      return [entry];
    }
    if (typeof entry?.name === "string") {
      return [entry.name];
    }
    return [];
  });
}

function callbackParams(suffix) {
  return {
    sessionKey: `agent:main:${suffix}`,
    conversation: {
      conversation_id: `compat-${suffix}`,
      openclaw_session: `agent:main:${suffix}`
    },
    message: {
      id: `message-${suffix}`,
      conversation_id: `compat-${suffix}`,
      type: "progress",
      requires_response: false,
      round: 1,
      body: "OpenClaw compatibility callback"
    }
  };
}

function setConfig(openclaw, key, value) {
  openclaw([
    "config",
    "set",
    key,
    JSON.stringify(value),
    "--strict-json"
  ]);
}

function gatewayCall({
  env,
  host,
  method,
  params,
  port,
  token,
  workspace
}) {
  const result = run(host.openclawBin, [
    "gateway",
    "call",
    method,
    "--url",
    `ws://127.0.0.1:${port}`,
    "--token",
    token,
    "--params",
    JSON.stringify(params),
    "--timeout",
    "20000",
    "--json"
  ], {
    cwd: workspace,
    env,
    timeoutMs: 30_000
  });
  return parseJsonOutput(result.stdout, `gateway call ${method}`);
}

async function verifyAkkDoctorCommand({
  env,
  host,
  port,
  token,
  version,
  workspace
}) {
  const suffix = safeName(version);
  const sessionKey = `agent:main:akk-command-${suffix}`;
  const runId = `akk-command-${suffix}-1`;
  const started = gatewayCall({
    env,
    host,
    method: "chat.send",
    params: {
      sessionKey,
      message: "/akk doctor",
      deliver: false,
      idempotencyKey: runId
    },
    port,
    token,
    workspace
  });
  assert.equal(started.status, "started");

  let history;
  let assistant;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    history = gatewayCall({
      env,
      host,
      method: "chat.history",
      params: {
        sessionKey,
        limit: 20
      },
      port,
      token,
      workspace
    });
    assistant = (history.messages ?? []).find((message) => {
      const text = messageText(message);
      return message?.role === "assistant" &&
        /AKK doctor: (?:ready|needs attention)/u.test(text) &&
        /Gateway: healthy/u.test(text);
    });
    if (assistant) {
      break;
    }
    await delay(500);
  }

  assert.equal(history?.sessionKey, sessionKey);
  assert.equal(
    (history?.messages ?? []).some((message) =>
      message?.role === "user" && messageText(message) === "/akk doctor"
    ),
    true
  );
  assert.notEqual(assistant, undefined, "/akk doctor must return a reply");
  const text = messageText(assistant);
  assert.match(text, /OpenClaw package: ready/u);
  assert.match(text, /Gateway: healthy/u);
  assert.equal(assistant.model, "gateway-injected");
  assert.equal(assistant.provider, "openclaw");
  assert.equal(assistant.usage?.input ?? 0, 0);
  assert.equal(assistant.usage?.output ?? 0, 0);
  assert.equal(assistant.usage?.totalTokens ?? 0, 0);
  assert.equal(history.sessionInfo?.hasActiveRun, false);
}

function messageText(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .map((block) => typeof block?.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function startGateway({ env, host, port, token, workspace }) {
  const child = spawn(host.openclawBin, [
    "gateway",
    "run",
    "--allow-unconfigured",
    "--auth",
    "token",
    "--token",
    token,
    "--bind",
    "loopback",
    "--port",
    String(port),
    "--ws-log",
    "compact"
  ], {
    cwd: workspace,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectReady(
        new Error(`OpenClaw Gateway did not become ready:\n${output}`)
      );
    }
  }, 60_000);
  timeout.unref();

  const capture = (chunk) => {
    output = appendBounded(output, String(chunk), 80_000);
    if (!settled && /\[gateway\] ready/u.test(stripAnsi(output))) {
      settled = true;
      clearTimeout(timeout);
      resolveReady();
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(error);
    }
  });
  child.once("exit", (code, signal) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(
        new Error(
          `OpenClaw Gateway exited before ready (${code ?? signal}):\n${output}`
        )
      );
    }
  });
  return {
    child,
    get output() {
      return output;
    },
    ready
  };
}

async function stopGateway(gateway) {
  const child = gateway.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  const stopped = await waitForExit(child, 10_000);
  if (!stopped) {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForGatewayOutput(gateway, pattern) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (pattern.test(stripAnsi(gateway.output))) {
      return;
    }
    await delay(250);
  }
  assert.match(
    stripAnsi(gateway.output),
    pattern,
    "the registered AKK service must start inside the candidate Gateway"
  );
}

function createFakeExecutables(caseRoot) {
  const binDir = path.join(caseRoot, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  const values = {
    tmux: { filename: "tmux", version: "tmux 3.5a" },
    codex: { filename: "codex", version: "codex-cli 0.107.0" },
    claude: { filename: "claude", version: "2.1.218" }
  };
  return Object.fromEntries(
    Object.entries(values).map(([name, value]) => {
      const executable = path.join(binDir, value.filename);
      fs.writeFileSync(
        executable,
        `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(value.version)});\n`,
        { encoding: "utf8", mode: 0o755 }
      );
      fs.chmodSync(executable, 0o755);
      return [name, executable];
    })
  );
}

function hasAkkCommand(result) {
  const commands = Array.isArray(result)
    ? result
    : Array.isArray(result?.commands)
      ? result.commands
      : [];
  return commands.some((command) => {
    if (typeof command === "string") {
      return command.replace(/^\//u, "") === "akk";
    }
    const name = command?.name ?? command?.command ?? command?.key;
    return typeof name === "string" && name.replace(/^\//u, "") === "akk";
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address
        ? address.port
        : undefined;
      server.close((error) => {
        if (error) {
          reject(error);
        } else if (port) {
          resolve(port);
        } else {
          reject(new Error("Unable to reserve a Gateway port"));
        }
      });
    });
  });
}

function run(command, args, {
  allowNonzero = false,
  cwd = packageRoot,
  env = isolatedEnv(),
  timeoutMs = 60_000
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(
      `${command} ${args.join(" ")} failed to run: ${result.error.message}`
    );
  }
  if (!allowNonzero && result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} exited with ${result.status}`,
      result.stdout,
      result.stderr
    ].filter(Boolean).join("\n").slice(-20_000));
  }
  return result;
}

function runNpm(args, options) {
  let lastResult;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    lastResult = run("npm", args, {
      ...options,
      allowNonzero: true
    });
    if (lastResult.status === 0) {
      return lastResult;
    }
    const output = `${lastResult.stdout}\n${lastResult.stderr}`;
    const retryable = /(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|429|502|503|504)/iu.test(
      output
    );
    if (!retryable || attempt === 3) {
      break;
    }
    process.stderr.write(
      `npm network failure; retrying (${attempt}/3)...\n`
    );
  }
  throw new Error([
    `npm ${args.join(" ")} exited with ${lastResult?.status}`,
    lastResult?.stdout,
    lastResult?.stderr
  ].filter(Boolean).join("\n").slice(-20_000));
}

function isolatedEnv(extra = {}) {
  const inheritedKeys = [
    "CI",
    "COMSPEC",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "LANG",
    "LC_ALL",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SystemRoot",
    "TEMP",
    "TERM",
    "TMP",
    "TMPDIR",
    "http_proxy",
    "https_proxy",
    "no_proxy"
  ];
  const env = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return {
    ...env,
    CI: "1",
    NO_COLOR: "1",
    npm_config_audit: "false",
    npm_config_fund: "false",
    ...extra
  };
}

function parseJsonOutput(stdout, label) {
  const trimmed = String(stdout ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    for (let index = trimmed.indexOf("{"); index >= 0;) {
      try {
        return JSON.parse(trimmed.slice(index));
      } catch {
        index = trimmed.indexOf("{", index + 1);
      }
    }
    throw new Error(
      `${label} returned malformed JSON:\n${trimmed.slice(-4000)}`
    );
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function exactFloor(value, label) {
  const range = requiredString(value, label);
  const match = /^>=(\d{4}\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(range);
  if (!match) {
    throw new Error(`${label} must be an exact >= version floor`);
  }
  return match[1];
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requiredStringArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || entry === "")
  ) {
    throw new Error(`${label} must be a non-empty string array`);
  }
  return value;
}

function sorted(values) {
  return [...values].sort();
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/gu, "-");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function appendBounded(current, addition, maxLength) {
  const combined = current + addition;
  return combined.length > maxLength
    ? combined.slice(-maxLength)
    : combined;
}

function stripAnsi(value) {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "");
}

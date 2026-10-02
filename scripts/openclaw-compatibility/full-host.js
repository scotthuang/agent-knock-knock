import assert from "node:assert/strict";
import {
  randomBytes
} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  packageJson
} from "./configuration.js";
import {
  verifyPluginLifecycle
} from "./lifecycle.js";
import {
  assertRuntimeContract,
  normalizedToolNames,
  callbackParams,
  hasAkkCommand
} from "./runtime-contract.js";
import {
  setConfig,
  openClawPluginInstallArgs,
  run,
  isolatedEnv,
  parseJsonOutput,
  requiredString,
  isInside,
  safeName,
  escapeRegex
} from "./command-runtime.js";
import {
  gatewayCall,
  startGateway,
  stopGateway,
  waitForGatewayOutput,
  reservePort
} from "./gateway.js";
import {
  verifyAkkDoctorCommand
} from "./doctor.js";
import {
  createFakeExecutables
} from "./fixtures.js";

export async function verifyFullHost({
  artifactPath: artifact,
  caseRoot,
  host,
  target,
  version
}) {
  const prepared = await prepareInstalledHost({ artifact, caseRoot, host });
  const { inspect, relayPath } = verifyInstalledHost(prepared);
  const { env, workspace, port, token, pluginInstallArgs } = prepared;
  const gateway = startGateway({ env, host, port, token, workspace });
  try {
    await verifyGatewayScenario({
      ...prepared, gateway, host, version, relayPath
    });
  } finally {
    await stopGateway(gateway);
  }
  const lifecycle = verifyUpdatedHost({ ...prepared, artifact, caseRoot, host });
  return {
    target,
    openclaw_version: version,
    result: "compatible",
    install: pluginInstallArgs.includes("--accept-capabilities")
      ? "npm-pack --force --accept-capabilities"
      : "npm-pack --force",
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

async function prepareInstalledHost({ artifact, caseRoot, host }) {
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
  const pluginInstallArgs = openClawPluginInstallArgs(
    openclaw,
    `npm-pack:${artifact}`
  );

  setConfig(openclaw, "gateway.mode", "local");
  setConfig(openclaw, "gateway.port", port);
  setConfig(openclaw, "gateway.auth.mode", "token");
  setConfig(openclaw, "gateway.auth.token", token);
  setConfig(openclaw, "agents.defaults.workspace", workspace);

  openclaw(pluginInstallArgs, {
    timeoutMs: 4 * 60 * 1000
  });
  setConfig(openclaw, "plugins.allow", ["agent-knock-knock"]);
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
  return {
    env, stateDir, workspace, storeDir, fakeExecutables, port, token,
    openclaw, openclawJson, pluginInstallArgs
  };
}

function verifyInstalledHost({
  openclawJson, stateDir, workspace, storeDir, env
}) {
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
  assert.equal(readOnlyList.terminals?.length, 1);
  assert.equal(
    readOnlyList.terminals[0]?.terminal_control?.target,
    "akk-compat:0.0"
  );
  assert.equal(readOnlyList.terminal_scan?.diagnostics?.provider, "registry");
  assert.deepEqual(
    readOnlyList.terminal_scan?.diagnostics?.providerKinds,
    ["tmux"]
  );
  assert.equal(
    readOnlyList.terminal_scan?.diagnostics?.providers?.tmux?.provider,
    "static"
  );
  assert.deepEqual(
    readOnlyList.terminal_scan?.diagnostics?.discoveryErrors,
    {}
  );
  return { inspect, relayPath };
}

async function verifyGatewayScenario({
  gateway, env, host, port, token, workspace, version, relayPath, fakeExecutables
}) {
  await gateway.ready;
  await waitForGatewayOutput(
    gateway,
    /agent-knock-knock monitor reconciliation: checked=\d+ launched=\d+ already_running=\d+ skipped=\d+ errors=0/u
  );
  // OpenClaw 2026.6.5 cannot see plugin method scope descriptors from the
  // standalone CLI process. Its first plugin RPC therefore pairs with the
  // CLI default scopes. Exercise that legacy path before narrower core RPCs
  // so the later callback is not mistaken for a device scope upgrade. A
  // distinct callback identity keeps the real enqueue assertion independent
  // across host versions with different bootstrap enqueue behavior.
  const scopeBootstrapSuffix =
    `gateway-scope-bootstrap-${safeName(version)}`;
  const scopeBootstrap = gatewayCall({
    env,
    host,
    method: "agent-knock-knock.callback",
    params: callbackParams(scopeBootstrapSuffix),
    port,
    token,
    workspace
  });
  assert.equal(scopeBootstrap.ok, true);
  assert.equal(typeof scopeBootstrap.enqueued, "boolean");
  assert.equal(scopeBootstrap.delivery_required, false);
  assert.equal(scopeBootstrap.delivery_mode, "none");
  assert.equal(
    scopeBootstrap.session_key,
    `agent:main:${scopeBootstrapSuffix}`
  );

  const callbackSuffix = `gateway-${safeName(version)}`;
  const callbackSessionKey = `agent:main:${callbackSuffix}`;
  const callbackSession = gatewayCall({
    env,
    host,
    method: "sessions.create",
    params: {
      key: callbackSessionKey,
      label: "AKK compatibility callback"
    },
    port,
    token,
    workspace
  });
  assert.equal(callbackSession.ok, true);
  assert.equal(callbackSession.key, callbackSessionKey);
  const callback = gatewayCall({
    env,
    host,
    method: "agent-knock-knock.callback",
    params: callbackParams(callbackSuffix),
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
    callbackSessionKey
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
}

function verifyUpdatedHost({
  openclaw, openclawJson, pluginInstallArgs, artifact, caseRoot, host, workspace
}) {
  openclaw(pluginInstallArgs, {
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
  return lifecycle;
}

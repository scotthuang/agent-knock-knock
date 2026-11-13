#!/usr/bin/env node
// Real published Host/connector/core; synthetic CLI data, no model or transport.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

assert.equal(process.argv.length, 3, "usage: node smoke-installed.mjs <clean-install-root>");
const root = fs.realpathSync(process.argv[2]);
const requireRoot = createRequire(path.join(root, "package.json"));
const manifestPath = requireRoot.resolve("@scotthuang/agent-knock-knock-deepseek-harness/package.json");
const packageRoot = path.dirname(fs.realpathSync(manifestPath));
assert.ok(packageRoot.startsWith(root + path.sep), "connector must be inside the isolated install");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
assert.equal(manifest.version, "0.1.0-rc.27");
assert.equal(manifest.dependencies["@scotthuang/agent-knock-knock"], "0.16.14");
const requireConnector = createRequire(manifestPath);
const coreManifestPath = requireConnector.resolve("@scotthuang/agent-knock-knock/package.json");
assert.ok(fs.realpathSync(coreManifestPath).startsWith(root + path.sep));
const coreManifest = JSON.parse(fs.readFileSync(coreManifestPath, "utf8"));
assert.equal(coreManifest.version, "0.16.14");
const hostAdapterEntry = coreManifest.exports["./host-adapter"].import;
assert.equal(typeof hostAdapterEntry, "string");
const launcherManifestPath = requireRoot.resolve("@deepseek-ai/dsh/package.json");
const launcher = JSON.parse(fs.readFileSync(launcherManifestPath, "utf8"));
assert.equal(launcher.version, "0.2.2-rc.3");
const requireLauncher = createRequire(launcherManifestPath);
const anchor = requireLauncher.resolve("@deepseek-ai/dsh-base/package.json");
const requireHost = createRequire(anchor);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dsh-install-"));
process.once("exit", () => fs.rmSync(sandbox, { recursive: true, force: true }));
const home = path.join(sandbox, "home");
const store = path.join(sandbox, "store");
for (const dir of [home, store]) fs.mkdirSync(dir, { mode: 0o700 });
const executablePath = process.env.PATH;
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, { PATH: executablePath, HOME: home, TMPDIR: sandbox });
process.chdir(sandbox);
const loadHost = name => import(pathToFileURL(requireHost.resolve(name)).href);
const connector = await import(pathToFileURL(path.join(packageRoot, "lib/index.js")).href);
const launcherBin = path.resolve(path.dirname(launcherManifestPath),
  typeof launcher.bin === "string" ? launcher.bin : launcher.bin.dsh);
const runtime = await connector.loadSupportedDeepSeekHarnessRuntime(
  connector.createDeepSeekHarnessManifestResolver(launcherBin));
assert.equal(runtime.version, "0.2.2-rc.3");
assert.equal(runtime.supportsCallbackRecovery, true);
const [{ Context }, { AgentRegistry }, { CommandRuntime }, llm, { SkillRegistry },
  { default: SystemPrompt }, { ToolRuntime }, { NativeToolExecutor }, coreExports] = await Promise.all([
  loadHost("@deepseek-ai/cordis"), loadHost("@deepseek-ai/dsh-agent"),
  loadHost("@deepseek-ai/dsh-commands"), loadHost("@deepseek-ai/dsh-llm"),
  loadHost("@deepseek-ai/dsh-skill"), loadHost("@deepseek-ai/dsh-system-prompt"),
  loadHost("@deepseek-ai/dsh-tools"), loadHost("@deepseek-ai/dsh-tool-executor-native"),
  import(pathToFileURL(path.resolve(path.dirname(coreManifestPath), hostAdapterEntry)).href),
]);
const relay = path.join(sandbox, "fixture-relay.mjs");
const calls = path.join(sandbox, "calls.jsonl");
const conversation = "fixture-conversation";
const listReply = { conversations: [{
  conversation_id: conversation, source: "codex_cli", surface: "cli", agent: "codex",
  title: "Synthetic install fixture", activity_state: "idle", capabilities: { status: true, send: false },
  available_actions: { status: { tool: "agent_knock_knock_status", arguments: { conversation_id: conversation } } },
}] };
const statusReply = { conversation_id: conversation, native_turn_id: "fixture-turn",
  source: "codex_cli_native", status: "active", progress: { text: "Synthetic public progress" } };
fs.writeFileSync(relay, `import fs from "node:fs";
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\\n");
if(args[0]==="list")process.stdout.write(${JSON.stringify(JSON.stringify(listReply))});
else if(args[0]==="status"&&args.includes(${JSON.stringify(conversation)}))
  process.stdout.write(${JSON.stringify(JSON.stringify(statusReply))});
else throw Error("Only synthetic List and exact Status are permitted");
`, { mode: 0o600 });
const adapter = coreExports.createHostAdapter({ listProjectionVersion: 5, relayPath: relay,
  pluginConfig: { storeDir: store }, environmentForContext: () => ({ HOME: home, PATH: executablePath }),
  lifecycleEnvironment: {}, logger: { debug() {}, info() {}, warn() {}, error() {} } });
const skill = fs.readFileSync(path.join(packageRoot, "skills/agent-knock-knock/SKILL.md"), "utf8");
const names = adapter.tools.map(tool => tool.name);
const handshake = adapter.verifyCapabilityHandshake(skill, names);
const ctx = new Context();
new SystemPrompt(ctx, {});
new ToolRuntime(ctx);
ctx.tools.setExecutor(new NativeToolExecutor(ctx));
new AgentRegistry(ctx);
new CommandRuntime(ctx);
new SkillRegistry(ctx);
let dispose, detach;
try {
  dispose = await connector.applyWithDependencies(ctx, { pluginConfig: { storeDir: store } }, {
    loadSupportedDeepSeekHarnessRuntime: async () => runtime,
    createHostAdapter: () => ({ ...adapter, lifecycle: { start() {}, async stop() {} } }),
    createCallbackIpcServer: () => ({ async start() {}, async stop() {} }),
  });
  assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), names);
  const agent = { id: "fixture-controller", session: { id: "fixture-controller" }, status: "idle", ctx };
  detach = ctx.agents.enter(agent);
  const invoke = async (name, args, id) => {
    const batch = await ctx.tools.execute({ agent, signal: new AbortController().signal,
      calls: [{ type: "tool-call", id: llm.ToolCallId(id), name, arguments: JSON.stringify(args) }] });
    assert.equal(batch.results.length, 1);
    assert.equal(batch.results[0].callId, id);
    const result = batch.results[0].result;
    assert.equal(result.isError, false, JSON.stringify(result));
    return result.value.details;
  };
  const list = await invoke("agent_knock_knock_list", {}, "fixture-list");
  assert.equal(list.projection.version, 5);
  assert.equal(list.conversations[0].conversation_id, conversation);
  assert.equal(list.conversations[0].capabilities.send, false);
  const status = await invoke("agent_knock_knock_status", { conversation_id: conversation }, "fixture-status");
  assert.equal(status.native_turn_id, "fixture-turn");
  assert.equal(status.progress.text, "Synthetic public progress");
  const dispatched = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(dispatched.map(args => args[0]), ["list", "status"]);
  assert.equal(fs.readdirSync(store).length, 0);
  console.log(JSON.stringify({ ok: true, connector: manifest.version, core: "0.16.14",
    host: runtime.version, launcher_owned_runtime_verified: true, recovery_api_exports_verified: true,
    tool_count: handshake.toolCount, skill_sha256: createHash("sha256").update(skill).digest("hex"),
    list_projection: list.projection.version, exact_status: true,
    limits: ["synthetic CLI discovery and progress", "SDK registration, not a running Web server",
      "no lifecycle worker or callback transport", "no model, paid task or external channel",
      "six older accepted Hosts not retested"] }, null, 2));
} finally {
  detach?.(); await dispose?.(); await adapter.lifecycle.stop(); await ctx.fiber.dispose();
  fs.rmSync(sandbox, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readClaudeTerminalAgents } from "../src/claude-terminal-agent-observation.js";
import { claudeNativeRuntimeOptions } from "../src/claude-native-cli-adapter.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { createTerminalRuntimeCliAdapter } from "../src/terminal-runtime-cli-adapter.js";

function fixture(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "akk-vendor-reader-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "vendor-data"), reader = path.join(dir, "vendor-reader.cjs");
  fs.mkdirSync(path.join(root, "sessions"), { recursive: true, mode: 0o700 });
  const row = { pid: process.pid, cwd: dir, sessionId: randomUUID(), kind: "interactive", startedAt: Date.now(), status: "idle" };
  const ps = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
    encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  assert.equal(ps.status, 0);
  const registry = { ...row, version: "2.1.295", procStart: ps.stdout.trim().replace(/\s+/gu, " ") };
  const save = () => {
    fs.writeFileSync(path.join(root, "agents.json"), JSON.stringify([row]));
    fs.writeFileSync(path.join(root, "sessions", `${row.pid}.json`), JSON.stringify(registry), { mode: 0o600 });
  };
  save();
  fs.writeFileSync(reader, `#!${process.execPath}\nconst fs = require('node:fs'); const path = require('node:path');
if (JSON.stringify(process.argv.slice(2)) !== '["agents","--json","--all"]') process.exit(17);
process.stdout.write(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'agents.json')));\n`, { mode: 0o700 });
  const env = { HOME: dir, PATH: dir, CLAUDE_CONFIG_DIR: root, AKK_NATIVE_CLAUDE_BIN: reader };
  const logs: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const run = (body: () => Promise<void>, overrides: NodeJS.ProcessEnv = {}) => runCliCommandExecution(
    "isolated-reader-test", {}, { cwd: dir, env: { ...env, ...overrides },
      runtimeLog: (_level, event, fields) => { logs.push({ event, fields }); } }, body);
  const runtime = (options = {}) => createTerminalRuntimeCliAdapter({ options, dependencies: {},
    completion: { detectExactBound: () => ({ handled: false }), loadCodexContexts: async () => [] },
    identity: { resolveCurrent: async () => undefined, assertRuntime: () => undefined }, workspace: { assertConfigured: () => undefined } });
  return { dir, root, reader, row, registry, save, run, runtime, logs };
}

test("terminal and native select the same vendor reader; terminal version comes from the exact registry", async t => {
  const f = fixture(t);
  await f.run(async () => {
    const native = claudeNativeRuntimeOptions({});
    assert.equal(native.claudeBin, f.reader); assert.deepEqual(native.claudeConfigDirs, [f.root]);
    const rows = f.runtime().loadClaudeAgentRows({ required: true });
    assert.equal(rows[0].configDir, f.root); assert.equal(rows[0].version, "2.1.295");
    assert.equal(f.runtime().agentVersionForRunningProcess("claude", f.row.pid), "2.1.295");
    assert.deepEqual(readClaudeTerminalAgents({ claudeBin: path.join(f.dir, "missing") }).errors, ["claude_reader_unavailable"]);
  });
});

test("explicit reader/root beat discovery defaults and bad readers never mean an empty verified catalog", async t => {
  const f = fixture(t);
  await f.run(async () => {
    const configured = { claudeBin: f.reader, claudeHome: f.root };
    assert.equal(f.runtime(configured).loadClaudeAgentRows({ required: true })[0].sessionId, f.row.sessionId);
    assert.equal(claudeNativeRuntimeOptions(configured).claudeConfigDirs[0], f.root);
    assert.throws(() => f.runtime().loadClaudeAgentRows({ required: true }), /claude_reader_invalid_configuration/);
  }, { AKK_NATIVE_CLAUDE_BIN: path.join(f.dir, "not-installed"), AKK_NATIVE_CLAUDE_CONFIG_DIRS: "bad-json" });
  await f.run(async () => {
    const target = f.runtime({ claudeBin: path.join(f.dir, "not-installed") });
    assert.deepEqual(target.loadClaudeAgentRows(), []);
    assert.throws(() => target.loadClaudeAgentRows({ required: true }), /claude_reader_unavailable/);
  });
});

test("missing reader explains default, environment and explicit selection without leaking installation paths", async t => {
  const f = fixture(t);
  for (const sample of [
    { options: {}, env: { AKK_NATIVE_CLAUDE_BIN: undefined }, name: "claude", source: "default", pathOmitted: false },
    { options: {}, env: { AKK_NATIVE_CLAUDE_BIN: path.join(f.dir, "missing-vendor") }, name: "missing-vendor", source: "environment", pathOmitted: true },
    { options: { claudeBin: path.join(f.dir, "explicit-missing") }, env: {}, name: "explicit-missing", source: "option", pathOmitted: true }
  ]) {
    await f.run(async () => {
      const result = readClaudeTerminalAgents(sample.options);
      assert.deepEqual(result.rows, []);
      assert.deepEqual(result.errors, ["claude_reader_unavailable"]);
      assert.deepEqual(result.reader, { executable: sample.name, source: sample.source, path_omitted: sample.pathOmitted });
      assert.equal(result.next_action, "check_claude_reader_in_host_environment");
      const log = [...f.logs].reverse().find(entry => entry.event === "claude_agents_list_failed")!;
      assert.deepEqual(log.fields.reader, result.reader);
      assert.equal(log.fields.next_action, result.next_action);
      assert.equal(JSON.stringify(log.fields).includes(f.dir), false);
      assert.throws(() => f.runtime(sample.options).loadClaudeAgentRows({ required: true }), error => {
        const message = (error as Error).message;
        assert.ok(message.includes(`reader="${sample.name}" source=${sample.source}`));
        assert.match(message, /AKK_NATIVE_CLAUDE_BIN.*starts this Host/u);
        assert.equal(message.includes(f.dir), false);
        return true;
      });
    }, sample.env);
  }
});

test("present invalid registry blocks version fallback and exact identity; static fixture cannot forge root authority", async t => {
  const f = fixture(t);
  f.registry.procStart = "Mon Jan 1 00:00:00 2001"; f.save();
  await f.run(async () => {
    assert.equal(f.runtime().agentVersionForRunningProcess("claude", f.row.pid), undefined);
    assert.throws(() => f.runtime().loadClaudeAgentRows({ required: true }), /claude_registry_process_changed/);
    assert.equal(f.runtime({ claudeAgentsJson: [{ ...f.row, configDir: f.root, version: "9.9.9" }] })
      .loadClaudeAgentRows()[0].configDir, undefined);
  });
});

test("two roots never overwrite the same PID and an unverified alternative root cannot use the default transcript", async t => {
  const f = fixture(t), second = path.join(f.dir, "second");
  fs.cpSync(f.root, second, { recursive: true });
  await f.run(async () => {
    const observed = readClaudeTerminalAgents({});
    assert.deepEqual(observed.rows, []); assert.ok(observed.errors.includes("claude_registry_conflicting_roots"));
    assert.throws(() => f.runtime().loadClaudeAgentRows({ required: true }), /conflicting_roots/);
  }, { AKK_NATIVE_CLAUDE_CONFIG_DIRS: JSON.stringify([f.root, second]) });
  fs.unlinkSync(path.join(second, "sessions", `${f.row.pid}.json`));
  await f.run(async () => {
    assert.deepEqual(readClaudeTerminalAgents({}).errors, ["claude_registry_root_unverified"]);
    // A user explicitly selecting the legacy root retains the existing manual-root contract.
    assert.equal(f.runtime({ claudeHome: second }).loadClaudeAgentRows({ required: true })[0].sessionId, f.row.sessionId);
  }, { AKK_NATIVE_CLAUDE_CONFIG_DIRS: JSON.stringify([second]) });
});

test("reader errors remain observable while unrelated valid catalog rows survive optional discovery", async t => {
  const f = fixture(t), failedRoot = path.join(f.dir, "broken");
  fs.mkdirSync(failedRoot);
  await f.run(async () => {
    const result = readClaudeTerminalAgents({});
    assert.equal(result.rows[0].sessionId, f.row.sessionId);
    assert.deepEqual(result.errors, ["claude_reader_failed"]);
    assert.equal(result.reader?.source, "environment");
    assert.equal(result.next_action, undefined);
    assert.throws(() => f.runtime().loadClaudeAgentRows({ required: true }), /claude_reader_failed/);
  }, { AKK_NATIVE_CLAUDE_CONFIG_DIRS: JSON.stringify([f.root, failedRoot]) });
});

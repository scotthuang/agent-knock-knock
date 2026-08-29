import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CodingAgentSessionProvider } from
  "../src/agent-session-provider.js";
import type { ActiveCodexProcess } from "../src/codex-session-provider.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createTerminalRuntimeCliAdapter,
  terminalControlFromTakeover,
  type TerminalRuntimeCliDependencies,
  type TerminalRuntimeCliOptions,
  type TerminalRuntimeCompletionPorts
} from "../src/terminal-runtime-cli-adapter.js";
import {
  createTerminalControlProviderRegistry,
  StaticTerminalControlProvider
} from "../src/terminal-control-provider.js";
import { StaticTerminalProcessSource } from "../src/terminal-process-source.js";

function runtime(
  options: TerminalRuntimeCliOptions = {},
  dependencies: TerminalRuntimeCliDependencies = {},
  completion: TerminalRuntimeCompletionPorts = {
    detectExactBound: () => ({ handled: false }),
    loadCodexContexts: async () => []
  }
) {
  return createTerminalRuntimeCliAdapter({
    options,
    dependencies,
    completion,
    identity: {
      resolveCurrent: async () => undefined,
      assertRuntime: () => undefined
    },
    workspace: { assertConfigured: () => undefined }
  });
}

test("runtime factories stay lazy, ordered, and instance scoped", () => {
  const order: string[] = [];
  const registry = createTerminalControlProviderRegistry([
    new StaticTerminalControlProvider()
  ]);
  const source = new StaticTerminalProcessSource([]);
  const dependencies: TerminalRuntimeCliDependencies = {
    get terminalControlProviderRegistry() {
      order.push("provider");
      return registry;
    },
    get loadClaudeAgentRows() {
      order.push("registry");
      return () => [];
    },
    get terminalProcessSource() {
      order.push("process_source");
      return source;
    }
  };
  const first = runtime({}, dependencies);
  const secondSource = new StaticTerminalProcessSource([{
    pid: 22,
    command: "codex"
  }]);
  const second = runtime({}, { terminalProcessSource: secondSource });

  assert.deepEqual(order, []);
  first.createBridge();
  assert.deepEqual(order, ["provider", "registry", "process_source"]);
  assert.equal(first.createProcessSource(), source);
  assert.equal(second.createProcessSource(), secondSource);
});

test("injected and static terminal observations preserve precedence and truthiness", async () => {
  const injectedRegistry = createTerminalControlProviderRegistry([
    new StaticTerminalControlProvider()
  ]);
  assert.equal(
    runtime(
      { terminalsJson: "not-json" },
      { terminalControlProviderRegistry: injectedRegistry }
    ).createControlProviderRegistry(),
    injectedRegistry
  );

  const fixture = runtime({
    terminalsJson: "[]",
    terminalScreensJson: "{}",
    processesJson: "[]"
  });
  assert.deepEqual(
    fixture.createControlProviderRegistry().list().map(({ kind }) => kind),
    ["tmux"]
  );
  assert.equal(fixture.createProcessSource().completeInventoryAuthority, undefined);
  assert.deepEqual(await fixture.createProcessSource().listProcessSnapshots(), []);
  const terminalOnlyFixture = runtime({ terminalsJson: "[]" });
  assert.equal(
    terminalOnlyFixture.createProcessSource().completeInventoryAuthority,
    undefined
  );
  assert.deepEqual(
    await terminalOnlyFixture.createProcessSource().listProcessSnapshots(),
    []
  );

  const production = runtime({ processesJson: "" });
  assert.deepEqual(
    production.createControlProviderRegistry().list().map(({ kind }) => kind),
    ["tmux", "herdr"]
  );
  assert.equal(production.createProcessSource().completeInventoryAuthority, true);
  assert.throws(
    () => runtime({ terminalsJson: "{" }).createControlProviderRegistry(),
    /--terminals-json must be valid JSON/u
  );
});

test("Codex session providers preserve injection, fixtures, and JSON validation", async () => {
  const injected = agentSessionProvider([]);
  let injectedReads = 0;
  const selected = runtime({ threadsJson: "not-json" }, {
    get createAgentSessionProvider() {
      injectedReads += 1;
      return () => injected;
    }
  });
  assert.equal(injectedReads, 0);
  assert.equal(selected.createAgentSessionProvider("codex"), injected);
  assert.equal(injectedReads, 1);
  assert.throws(() => selected.createAgentSessionProvider("claude"),
    /unsupported agent session provider: claude/u);

  const fixture = runtime({
    threadsJson: "[]", processesJson: "[]", rolloutsJson: "{}",
    codexActiveSessionIdentitiesJson: "{}"
  }).createAgentSessionProvider("codex");
  assert.deepEqual(await fixture.listHistoricalSessions(), []);
  assert.deepEqual(await fixture.listActiveSessions(), []);
  assert.throws(
    () => runtime({ threadsJson: "{" }).createAgentSessionProvider("codex"),
    /--threads-json must be valid JSON/u
  );
});

test("Codex lifecycle candidate providers preserve their dedicated precedence", () => {
  const injected = {
    listThreadLifecycleCandidates: async () => [],
    revalidateThreadLifecycleCandidate: async () => ({
      status: "unavailable" as const,
      reason: "test"
    })
  };
  let injectedReads = 0;
  const selected = runtime({ codexHome: "/unused" }, {
    get codexThreadLifecycleProvider() {
      injectedReads += 1;
      return injected;
    }
  });
  assert.equal(injectedReads, 0);
  assert.equal(
    selected.createThreadLifecycleCandidateProvider("codex"),
    injected
  );
  assert.equal(injectedReads, 1);
  assert.throws(
    () => selected.createThreadLifecycleCandidateProvider("claude"),
    /unsupported thread lifecycle candidate provider: claude/u
  );
  const production = runtime({ codexHome: "/tmp/codex-lifecycle" })
    .createThreadLifecycleCandidateProvider("codex");
  assert.equal(typeof production.listThreadLifecycleCandidates, "function");
  assert.equal(typeof production.revalidateThreadLifecycleCandidate, "function");
});

test("active Session attachment preserves provider, source, and bridge call counts", async () => {
  const active: ActiveCodexProcess = {
    agent: "codex", pid: 101, ppid: 100, command: "codex", kind: "codex_cli",
    sessionId: "native-101", confidence: "high", reason: "test"
  };
  let providerCalls = 0;
  let sourceGets = 0;
  let sourceCalls = 0;
  const provider = agentSessionProvider([active], () => { providerCalls += 1; });
  const processSource = new StaticTerminalProcessSource([
    { pid: 100, ppid: 1, command: "tmux: server" },
    { pid: 101, ppid: 100, command: "codex" }
  ]);
  const countedSource = {
    async listProcessSnapshots(...args: Parameters<
      StaticTerminalProcessSource["listProcessSnapshots"]
    >) {
      sourceCalls += 1;
      return processSource.listProcessSnapshots(...args);
    }
  };
  const terminalProvider = new StaticTerminalControlProvider({ panes: [{
    kind: "tmux", target: "%1", session: "work", window: 0, pane: 1,
    panePid: 100, currentPath: "/workspace"
  }] });
  const dependencies: TerminalRuntimeCliDependencies = {
    get terminalProcessSource() {
      sourceGets += 1;
      return countedSource;
    }
  };
  const attached = await runtime(
    { claudeAgentsJson: [] }, dependencies
  ).listActiveSessionsWithTerminalControl(provider, terminalProvider);
  assert.equal(providerCalls, 1);
  assert.equal(sourceGets, 2);
  assert.equal(sourceCalls, 1);
  assert.equal(attached[0].terminalControl?.target, "%1");

  providerCalls = 0;
  sourceGets = 0;
  sourceCalls = 0;
  await runtime(
    { claudeAgentsJson: [] }, dependencies
  ).listActiveSessionsWithTerminalControl(
    agentSessionProvider([], () => { providerCalls += 1; }), terminalProvider);
  assert.equal(providerCalls, 1);
  assert.equal(sourceGets, 1);
  assert.equal(sourceCalls, 0);
});

test("Codex completion keeps exact-bound priority before fallback context reads", async () => {
  const events: string[] = [];
  const exact = runtime({ claudeAgentsJson: [] }, {}, {
    detectExactBound: () => {
      events.push("exact");
      return {
        handled: true,
        completion: { source: "durable", text: "exact result" }
      };
    },
    loadCodexContexts: async () => {
      events.push("contexts");
      return [];
    }
  }).createAgentRegistry().require("codex");
  assert.deepEqual(await exact.detectDurableCompletion?.({
    context: { conversation: {}, nativeTakeover: {} }
  }), { source: "durable", text: "exact result" });
  assert.deepEqual(events, ["exact"]);

  events.length = 0;
  const fallback = runtime({ claudeAgentsJson: [] }, {}, {
    detectExactBound: () => {
      events.push("exact");
      return { handled: false };
    },
    loadCodexContexts: async () => {
      events.push("contexts");
      return [];
    }
  }).createAgentRegistry().require("codex");
  assert.equal(await fallback.detectDurableCompletion?.({
    context: { conversation: {}, nativeTakeover: {} }
  }), undefined);
  assert.deepEqual(events, ["exact", "contexts"]);
});

test("Claude observation uses the exact command and keeps fail-closed errors", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-claude-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "claude");
  const argsPath = path.join(directory, "args.txt");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > \"${argsPath}\"`,
    "printf '%s\\n' '[{\"pid\":42,\"sessionId\":\"native-42\",\"status\":\"idle\"}]'"
  ].join("\n"));
  fs.chmodSync(executable, 0o700);

  await runCliCommandExecution("runtime-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: () => undefined
  }, async () => {
    assert.deepEqual(runtime().loadClaudeAgentRows({ required: true }), [{
      pid: 42,
      sessionId: "native-42",
      status: "idle"
    }]);
  });
  assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"),
    ["agents", "--json", "--all"]);

  fs.writeFileSync(executable, [
    "#!/bin/sh",
    "printf '%s\\n' 'agent list failed' >&2",
    "exit 7"
  ].join("\n"));
  fs.chmodSync(executable, 0o700);
  const logged: string[] = [];
  await runCliCommandExecution("runtime-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: (_level, event) => logged.push(event)
  }, async () => {
    assert.deepEqual(runtime().loadClaudeAgentRows(), []);
    assert.throws(
      () => runtime().loadClaudeAgentRows({ required: true }),
      /Claude agent session observation failed/u
    );
  });
  assert.deepEqual(logged.filter((event) => event === "claude_agents_list_failed"),
    ["claude_agents_list_failed", "claude_agents_list_failed"]);
});

test("agent versions and provider-owned takeover facts stay data-only", async (t) => {
  const injected = runtime({ agentVersionsJson: "not-json" }, {
    agentVersionForRunningProcess: () => "9.8.7"
  });
  assert.equal(injected.agentVersionForRunningProcess("codex", 42), "9.8.7");

  const fixture = runtime({
    agentVersionsJson: JSON.stringify({ "42": "1.2.3", codex: "4.5.6" })
  });
  assert.equal(fixture.agentVersionForRunningProcess("codex", 42), "1.2.3");
  assert.equal(fixture.agentVersionForRunningProcess("codex", 43), "4.5.6");

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-lsof-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "lsof");
  const argsPath = path.join(directory, "args.txt");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > \"${argsPath}\"`,
    "printf '%s\\n' 'n/Users/test/.codex/packages/standalone/releases/0.150.1-aarch64-apple-darwin/bin/codex'",
    "printf '%s\\n' 'n/Users/test/.local/share/claude/versions/2.1.237'"
  ].join("\n"));
  fs.chmodSync(executable, 0o700);
  await runCliCommandExecution("runtime-version-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: () => undefined
  }, async () => {
    assert.equal(runtime().agentVersionForRunningProcess("codex", 77), "0.150.1");
    assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"),
      ["-a", "-p", "77", "-d", "txt", "-Fn"]);
    assert.equal(runtime().agentVersionForRunningProcess("claude", 78), "2.1.237");
  });
  assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"),
    ["-a", "-p", "78", "-d", "txt", "-Fn"]);

  const control = terminalControlFromTakeover({
    terminal_control: {
      kind: "tmux",
      target: "work:0.0",
      session: "work",
      window: 0,
      pane: 0,
      panePid: 42
    }
  });
  assert.equal(control?.kind, "tmux");
  assert.deepEqual(Object.keys(control ?? {}), [
    "kind", "target", "session", "window", "pane", "panePid",
    "currentCommand", "currentPath", "socketPath", "capabilities"
  ]);
  assert.deepEqual(control?.capabilities, [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "screen_completion",
    "durable_completion",
    "terminal_cancel"
  ]);
  assert.equal(terminalControlFromTakeover({
    terminal_control: {
      kind: "herdr",
      target: "workspace/tab/pane/terminal",
      socketPath: "/tmp/herdr.sock",
      session: "workspace",
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      panePid: 43,
      capabilities: ["send_keys", "not-a-capability"]
    }
  })?.kind, "herdr");
  assert.equal(terminalControlFromTakeover({
    terminal_control: {
      kind: "tmux",
      target: "work:0.0",
      session: "work",
      window: 0,
      pane: 0,
      panePid: 42
    },
    terminal_endpoint: {}
  }), undefined);
});

test("static terminal observations never inspect host executable versions", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-runtime-static-version-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "lsof");
  const callsPath = path.join(directory, "calls.txt");
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" >> \"${callsPath}\"`,
    "printf '%s\\n' 'n/Users/test/.codex/packages/standalone/releases/0.149.1-aarch64-apple-darwin/bin/codex'"
  ].join("\n"));
  fs.chmodSync(executable, 0o700);

  await runCliCommandExecution("runtime-static-version-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: () => undefined
  }, async () => {
    for (const options of [
      { agentVersionsJson: "[]" },
      { processesJson: "[]" },
      { terminalsJson: "[]" },
      { terminalScreensJson: "{}" }
    ]) {
      assert.equal(
        runtime(options).agentVersionForRunningProcess("codex", 77),
        undefined
      );
    }
    assert.equal(
      runtime({
        processesJson: "[]",
        agentVersionsJson: JSON.stringify({ codex: "0.149.1" })
      }).agentVersionForRunningProcess("codex", 77),
      "0.149.1"
    );
  });

  assert.equal(fs.existsSync(callsPath), false);
});

function agentSessionProvider(
  active: ActiveCodexProcess[],
  onList: () => void = () => undefined
): CodingAgentSessionProvider {
  return {
    agent: "codex",
    getCapabilities: async () => ({
      historicalSessions: "full", forkContext: "full",
      activeSessions: "process_scan", takeover: "plan_only", reasons: []
    }),
    listHistoricalSessions: async () => [],
    listActiveSessions: async () => { onList(); return active; },
    resolveActiveSessionIdentityForPid: async () => undefined,
    inspectOpenRootRolloutInventoryForPid: async () => ({
      schema: "agent-knock-knock/codex-open-root-rollout-inventory",
      version: 1, status: "verified_absent", pid: 1,
      processUuid: "none", processBirth: "none", roots: [],
      inventoryFingerprint: "none"
    }),
    getSession: async () => undefined,
    getForkContext: async () => undefined
  };
}

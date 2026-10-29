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
  StaticTerminalControlProvider,
  type TerminalControlProvider
} from "../src/terminal-control-provider.js";
import type { TerminalEndpointRef } from "../src/terminal-control-ref.js";
import { StaticTerminalProcessSource } from "../src/terminal-process-source.js";
import type { TerminalModelOptionsBridgeResult } from
  "../src/terminal-agent-bridge.js";
import {
  planTerminalModelControl,
  probeTerminalModelControl
} from "../src/terminal-model-control.js";

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

test("List runtimes share terminal enumeration but endpoint resolution and later commands stay fresh", async () => {
  let discoveries = 0, resolutions = 0;
  const observed = new WeakSet<TerminalEndpointRef>();
  class Provider extends StaticTerminalControlProvider {
    override async listTerminals() {
      discoveries++; const endpoints = await super.listTerminals();
      endpoints.forEach(endpoint => observed.add(endpoint)); return endpoints;
    }
    override async resolve(terminal: TerminalEndpointRef) {
      assert.equal(observed.has(terminal), true); resolutions++; return terminal;
    }
  }
  const registry = createTerminalControlProviderRegistry([new Provider({ panes: [{
    kind: "tmux", target: "work:0.0", session: "work", window: 0, pane: 0, panePid: 42
  }] })]);
  const dependencies = { terminalControlProviderRegistry: registry };
  await runCliCommandExecution("list", {}, { runtimeLog() {} }, async () => {
    const a = runtime({ listDiscoveryOnly: true }, dependencies).createControlProvider();
    const b = runtime({ listDiscoveryOnly: true }, dependencies).createControlProvider();
    const [first, second] = await Promise.all([a.listTerminals(), b.listTerminals()]);
    assert.deepEqual(first, second);
    assert.equal(discoveries, 1);
    await a.resolve(first[0]); await b.resolve(second[0]);
    assert.equal(resolutions, 2);
    await runtime({}, dependencies).createControlProvider().listTerminals();
    assert.equal(discoveries, 2);
  });
  await runCliCommandExecution("list", {}, { runtimeLog() {} }, async () => {
    await runtime({ listDiscoveryOnly: true }, dependencies).createControlProvider().listTerminals();
  });
  assert.equal(discoveries, 3);
});

test("lightweight and Codex-only inventory does not eagerly enumerate Claude for adapter construction", () => {
  const dependencies = { loadClaudeAgentRows() { throw new Error("unexpected Claude enumeration"); } };
  for (const options of [{ listDiscoveryOnly: true }, { agent: "codex" }]) {
    const registry = runtime(options, dependencies).createAgentRegistry();
    assert.ok(registry.require("codex"));
    assert.ok(registry.require("claude"));
  }
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
    assert.deepEqual(runtime({ terminal: "terminal:v2:tmux:claude:akk:0.0:42" })
      .loadClaudeAgentRows({ required: true }), [{ pid: 42, sessionId: "native-42", status: "idle" }],
    "a missing exact registry retains the legacy reader fallback");
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

test("Claude model control accepts only the same exact agents row across its native dialog", async (t) => {
  const nativeSessionId = "11111111-1111-4111-8111-111111111111";
  const cwd = "/workspace/project";
  const startedAt = 1_725_000_000_000;
  const divider = "─".repeat(80);
  const idleScreen = [divider, "❯ ", divider].join("\n");
  const draftScreen = [
    "/model                        Set the AI model for Claude Code (currently claude-sonnet-4-6)",
    divider,
    "❯ /model",
    divider,
    "⏵⏵ plan mode on · shift+tab to cycle"
  ].join("\n");
  type Drift = "none" | "session" | "pid" | "cwd" | "waiting_reason" |
    "busy" | "non_model_surface";
  class ModelDialogProvider extends StaticTerminalControlProvider {
    phase: "idle" | "draft" | "picker" = "idle";
    effort: "high" | "low" = "high";

    constructor(readonly drift: Drift) {
      super({ panes: [{
        kind: "tmux", target: "work:0.0", session: "work", window: 0,
        pane: 0, panePid: 41, currentCommand: "claude", currentPath: cwd
      }] });
    }

    override async capture(_terminal: TerminalEndpointRef): Promise<string> {
      if (this.phase === "idle") return idleScreen;
      if (this.phase === "draft") return draftScreen;
      if (this.drift === "non_model_surface") {
        return [
          "Do you want to proceed?",
          "❯ 1. Yes",
          "  2. No",
          "Enter to select · Esc to cancel"
        ].join("\n");
      }
      return [
        "▔".repeat(80),
        "   Select model",
        "   Switch between Claude models.",
        "   ❯ 1. Claude Sonnet 4.6 ✔  Claude Sonnet 4.6 model",
        `   ${this.effort === "high" ? "● High" : "○ Low"} effort ←/→ to adjust`,
        "   Enter to set as default · s to use this session only · Esc to cancel"
      ].join("\n");
    }

    override async sendText(
      terminal: TerminalEndpointRef,
      text: string
    ): Promise<void> {
      await super.sendText(terminal, text);
      assert.equal(text, "/model");
      this.phase = "draft";
    }

    override async sendKeys(
      terminal: TerminalEndpointRef,
      keys: readonly string[]
    ): Promise<void> {
      await super.sendKeys(terminal, keys);
      assert.equal(keys.length, 1);
      if (keys[0] === "C-m" && this.phase === "draft") {
        this.phase = "picker";
        return;
      }
      if (keys[0] === "Right" && this.phase === "picker") {
        this.effort = this.effort === "high" ? "low" : "high";
        return;
      }
      assert.equal(keys[0], "Escape");
      this.phase = "idle";
    }
  }
  const plan = planTerminalModelControl(
    probeTerminalModelControl("claude", "2.1.266")
  );
  const processSource = new StaticTerminalProcessSource([
    { pid: 41, ppid: 1, command: "tmux: server", cwd },
    { pid: 42, ppid: 41, command: "claude", cwd }
  ]);
  const exactRuntime = {
    pid: 42,
    nativeSessionId,
    requireExactClaudeAgentRow: true as const,
    nativeProcessStartedAt: startedAt,
    exactClaudeAgentState: "idle" as const,
    cwd
  };

  async function exercise(drift: Drift): Promise<{
    provider: ModelDialogProvider;
    result?: TerminalModelOptionsBridgeResult;
    error?: unknown;
  }> {
    const provider = new ModelDialogProvider(drift);
    const registry = createTerminalControlProviderRegistry([provider]);
    const dependencies: TerminalRuntimeCliDependencies = {
      terminalControlProviderRegistry: registry,
      terminalProcessSource: processSource,
      loadClaudeAgentRows: () => {
        const inDialog = provider.phase === "picker";
        return [{
          pid: inDialog && drift === "pid" ? 43 : 42,
          cwd: inDialog && drift === "cwd" ? "/workspace/other" : cwd,
          kind: "interactive",
          sessionId: inDialog && drift === "session"
            ? "22222222-2222-4222-8222-222222222222"
            : nativeSessionId,
          startedAt,
          status: inDialog && drift === "busy" ? "working" :
            inDialog ? "waiting" : "idle",
          ...(inDialog
            ? { waitingFor: drift === "waiting_reason"
                ? "permission prompt"
                : "dialog open" }
            : {})
        }];
      }
    };
    const facade = runtime({}, dependencies);
    const terminal = (await provider.listTerminals())[0];
    assert.ok(terminal);
    const control = provider.toControlRef(terminal);
    try {
      const result = await facade.createBridge(provider).modelOptions(
        "claude", control, "2.1.266", plan,
        { runtime: exactRuntime, beforeInput: () => undefined }
      );
      return { provider, result };
    } catch (error) {
      return { provider, error };
    }
  }

  await t.test("same pid, incarnation, session, cwd, and dialog state", async () => {
    const exercised = await exercise("none");
    assert.ifError(exercised.error);
    assert.equal(exercised.result?.catalog.current.model, "sonnet-4.6");
    assert.equal(exercised.provider.phase, "idle");
    assert.ok(exercised.provider.sentKeys.some(({ keys }) =>
      keys.length === 1 && keys[0] === "Escape"
    ));
  });

  for (const drift of [
    "session", "pid", "cwd", "waiting_reason", "busy", "non_model_surface"
  ] as const) {
    await t.test(`${drift} drift remains fail-closed`, async () => {
      const exercised = await exercise(drift);
      assert.match(String(exercised.error),
        /native Claude agents identity, cwd, or idle state changed/u);
      assert.equal(exercised.provider.phase, "picker");
      assert.deepEqual(
        exercised.provider.sentKeys.filter(({ keys }) => keys[0] !== "-l")
          .map(({ keys }) => keys),
        [["C-m"]]
      );
    });
  }
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
  const codexExecutable = path.join(directory, "releases", "0.153.0", "bin", "codex");
  fs.mkdirSync(path.dirname(codexExecutable), { recursive: true });
  fs.writeFileSync(codexExecutable, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.153.0'\n", { mode: 0o700 });
  const evidence = codexProcessEvidence(directory, codexExecutable);
  fs.writeFileSync(executable, [
    "#!/bin/sh",
    `printf '%s\\n' \"$@\" > \"${argsPath}\"`,
    `/bin/cat '${evidence.mappedPath}'`,
    "printf '%s\\n' 'ftxt'",
    "printf '%s\\n' 'n/Users/test/.local/share/claude/versions/2.1.259'"
  ].join("\n"));
  fs.chmodSync(executable, 0o700);
  await runCliCommandExecution("runtime-version-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: () => undefined
  }, async () => {
    assert.equal(runtime().agentVersionForRunningProcess("codex", 77), "0.153.0");
    assert.deepEqual(fs.readFileSync(argsPath, "utf8").trim().split("\n"),
      ["-a", "-p", "77", "-d", "txt", "-FpnDi"]);
    assert.equal(runtime().agentVersionForRunningProcess("claude", 78), "2.1.259");
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

test("running Codex 0.155.1 catalog uses its exact executable and custom CODEX_HOME", async (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-runtime-codex-catalog-")
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const releaseRoot = path.join(
    directory, "standalone", "releases", "0.155.1-aarch64-apple-darwin"
  );
  const codexExecutable = path.join(releaseRoot, "bin", "codex");
  const secondExecutable = path.join(
    directory, "standalone", "releases", "0.155.1-second", "bin", "codex"
  );
  const lsofExecutable = path.join(directory, "lsof");
  const argsPath = path.join(directory, "codex-args.txt");
  const homePath = path.join(directory, "codex-home.txt");
  const cwdPath = path.join(directory, "codex-cwd.txt");
  const lsofArgsPath = path.join(directory, "lsof-args.txt");
  const codexHome = path.join(directory, "isolated-codex-home");
  const workingDirectory = path.join(directory, "workspace");
  fs.mkdirSync(path.dirname(codexExecutable), { recursive: true });
  fs.mkdirSync(path.dirname(secondExecutable), { recursive: true });
  fs.mkdirSync(codexHome);
  fs.mkdirSync(workingDirectory);
  fs.writeFileSync(codexExecutable, [
    "#!/bin/sh",
    "if [ \"$1\" = '--version' ]; then printf '%s\\n' 'codex-cli 0.155.1'; exit 0; fi",
    `printf '%s\\n' \"$@\" > \"${argsPath}\"`,
    `printf '%s\\n' \"$CODEX_HOME\" > \"${homePath}\"`,
    `pwd > \"${cwdPath}\"`,
    "printf '%s\\n' '{\"models\":[{\"slug\":\"gpt-6-astra\",\"display_name\":\"GPT-6 Astra\",\"visibility\":\"list\",\"supported_reasoning_levels\":[{\"effort\":\"high\"},{\"effort\":\"ultra\"}]}]}'"
  ].join("\n"));
  fs.chmodSync(codexExecutable, 0o700);
  fs.writeFileSync(secondExecutable, "unused");
  const evidence = codexProcessEvidence(directory, codexExecutable);
  const writeLsof = (paths: readonly string[]) => {
    fs.writeFileSync(lsofExecutable, [
      "#!/bin/sh",
      `printf '%s\\n' \"$@\" > \"${lsofArgsPath}\"`,
      `printf '%s\\n' '${evidence.mappedRecords(paths)}'`
    ].join("\n"));
    fs.chmodSync(lsofExecutable, 0o700);
  };
  writeLsof([codexExecutable]);

  await runCliCommandExecution("runtime-model-catalog-test", {}, {
    env: { PATH: directory, HOME: directory },
    runtimeLog: () => undefined
  }, async () => {
    const catalog = runtime({ codexHome })
      .codexModelCatalogForRunningProcess(
        77, "0.155.1", workingDirectory
      );
    assert.deepEqual(catalog, { models: [{
      id: "gpt-6-astra",
      label: "GPT-6 Astra",
      reasoningEfforts: ["high", "ultra"]
    }] });
    assert.deepEqual(
      fs.readFileSync(lsofArgsPath, "utf8").trim().split("\n"),
      ["-a", "-p", "77", "-d", "txt", "-FpnDi"]
    );
    assert.deepEqual(
      fs.readFileSync(argsPath, "utf8").trim().split("\n"),
      ["debug", "models"]
    );
    assert.equal(fs.readFileSync(homePath, "utf8").trim(), codexHome);
    assert.equal(
      fs.readFileSync(cwdPath, "utf8").trim(),
      fs.realpathSync(workingDirectory)
    );

    assert.throws(
      () => runtime({ codexHome }).codexModelCatalogForRunningProcess(
        77, "0.154.0", workingDirectory
      ),
      /does not expose exactly one 0\.154\.0 executable/u
    );

    writeLsof([codexExecutable, secondExecutable]);
    assert.throws(
      () => runtime({ codexHome }).codexModelCatalogForRunningProcess(
        77, "0.155.1", workingDirectory
      ),
      /does not expose exactly one 0\.155\.1 executable/u
    );

    writeLsof([codexExecutable]);
    fs.writeFileSync(codexExecutable, "#!/bin/sh\nif [ \"$1\" = '--version' ]; then printf '%s\\n' 'codex-cli 0.155.1'; exit 0; fi\nexit 7\n");
    fs.chmodSync(codexExecutable, 0o700);
    assert.throws(
      () => runtime({ codexHome }).codexModelCatalogForRunningProcess(
        77, "0.155.1", workingDirectory
      ),
      /could not return its model catalog/u
    );
  });
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

test("running Codex versions follow the exact npm native image and reject stale process evidence", async (t) => {
  for (const scenario of ["npm wrapper", "direct native", "ambiguous children",
    "grandchild only", "different arguments", "replaced image", "wrong mapped PID",
    "root reused", "child reused", "image changed during probe"] as const) {
    await t.test(scenario, async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-version-"));
      t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
      const executable = path.join(directory, "node_modules", "@openai", "codex-darwin-arm64",
        "vendor", "aarch64-apple-darwin", "bin", "codex");
      fs.mkdirSync(path.dirname(executable), { recursive: true });
      fs.writeFileSync(executable, "#!/bin/sh\nprintf '%s\\n' 'codex-cli 0.164.0'\n", { mode: 0o700 });
      const nativePid = scenario === "direct native" ? 77 : 78;
      const evidence = codexProcessEvidence(directory, executable, nativePid);
      const wrapper = `node ${directory}/bin/codex --yolo`;
      const nativeCommand = `${executable} --yolo`;
      const rows = nativePid === 77 ? [evidence.processRow(77, 10, nativeCommand)] : [
        evidence.processRow(77, 10, wrapper), evidence.processRow(78, 77, nativeCommand)
      ];
      if (scenario === "ambiguous children") rows.push(evidence.processRow(79, 77, nativeCommand));
      if (scenario === "grandchild only") {
        rows[1] = evidence.processRow(78, 77, "/bin/sh worker");
        rows.push(evidence.processRow(79, 78, nativeCommand));
      }
      if (scenario === "different arguments") rows[1] = evidence.processRow(78, 77, `${executable} app-server`);
      evidence.writeProcesses(rows);
      if (scenario === "replaced image") fs.writeFileSync(evidence.mappedPath,
        evidence.mappedRecords([executable]).replace(/\ni\d+/u, "\ni1"));
      if (scenario === "wrong mapped PID") fs.writeFileSync(evidence.mappedPath,
        evidence.mappedRecords([executable]).replace(`p${nativePid}`, "p999"));
      const marker = path.join(directory, "version-probed");
      const probeEffect: string[] = [];
      if (scenario === "root reused" || scenario === "child reused") {
        const changed = [...rows];
        const index = scenario === "root reused" ? 0 : 1;
        changed[index] = changed[index]!.replace(evidence.birth, evidence.laterBirth);
        const replacement = path.join(directory, "replacement-processes");
        fs.writeFileSync(replacement, `${changed.join("\n")}\n`);
        probeEffect.push(`/bin/cat '${replacement}' > '${evidence.processesPath}'`);
      }
      if (scenario === "image changed during probe") probeEffect.push("printf '\\n' >> \"$0\"");
      fs.writeFileSync(executable, ["#!/bin/sh", `printf 'probed' > '${marker}'`,
        ...probeEffect, "printf '%s\\n' 'codex-cli 0.164.0'", ""].join("\n"));
      // A conflicting PATH installation must never supply running-version authority.
      fs.writeFileSync(path.join(directory, "codex"), "#!/bin/sh\nprintf '%s\\n' 'codex-cli 9.9.9'\n", { mode: 0o700 });
      await runCliCommandExecution("runtime-npm-version-test", {}, {
        env: { PATH: directory, HOME: directory }, runtimeLog: () => undefined
      }, async () => {
        const instance = runtime();
        const expected = ["npm wrapper", "direct native"].includes(scenario) ? "0.164.0" : undefined;
        assert.equal(instance.agentVersionForRunningProcess("codex", 77), expected);
        const shouldProbe = expected !== undefined || ["root reused", "child reused", "image changed during probe"].includes(scenario);
        assert.equal(fs.existsSync(marker), shouldProbe);
        if (scenario === "ambiguous children") {
          evidence.writeProcesses(rows.slice(0, 2));
          assert.equal(instance.agentVersionForRunningProcess("codex", 77), "0.164.0",
            "an unavailable observation must not be cached after the ambiguity clears");
        }
      });
    });
  }
});

/** Real files plus OS-command fixtures exercise the production runtime boundary. */
function codexProcessEvidence(directory: string, executable: string, nativePid = 77) {
  const psDate = (offset: number) => new Date(Date.now() + offset).toUTCString()
    .replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\S+) GMT$/u, "$1 $3 $2 $5 $4");
  const birth = psDate(60_000);
  const laterBirth = psDate(120_000);
  const processesPath = path.join(directory, "processes.txt");
  const mappedPath = path.join(directory, "mapped.txt");
  const processRow = (pid: number, ppid: number, command: string) => `${pid} ${ppid} ${birth} ${command}`;
  const writeProcesses = (rows: readonly string[]) => fs.writeFileSync(processesPath, `${rows.join("\n")}\n`);
  const mappedRecords = (paths: readonly string[]) => [`p${nativePid}`, ...paths.flatMap(file => {
    const stat = fs.statSync(file, { bigint: true });
    return ["ftxt", `D0x${stat.dev.toString(16)}`, `i${stat.ino}`, `n${file}`];
  }), ""].join("\n");
  writeProcesses([processRow(nativePid, 10, `${executable} --yolo`)]);
  fs.writeFileSync(mappedPath, mappedRecords([executable]));
  for (const [command, file] of [["ps", processesPath], ["lsof", mappedPath]] as const) {
    fs.writeFileSync(path.join(directory, command), `#!/bin/sh\n/bin/cat '${file}'\n`, { mode: 0o700 });
  }
  return { birth, laterBirth, processesPath, mappedPath, processRow, writeProcesses, mappedRecords };
}

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

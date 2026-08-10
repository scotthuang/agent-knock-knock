import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  StaticTerminalControlProvider,
  TerminalControlInputNotSentError,
  TmuxTerminalControlProvider,
  createTerminalControlProviderRegistry,
  discoverTmuxSocketPaths,
  enrichActiveProcessesWithTerminalControl,
  parseTmuxListPanes,
  type TerminalControlProvider
} from "../src/terminal-control-provider.js";
import {
  createTerminalEndpointRef,
  sameTerminalEndpointIdentity,
  type TerminalControlCapability,
  type TerminalControlRef,
  type TerminalProviderCapability,
  type TerminalEndpointRef
} from "../src/terminal-control-ref.js";
import type { ActiveCodexProcess } from "../src/codex-session-provider.js";

class RecordingTerminalControlProvider implements TerminalControlProvider {
  readonly calls: string[] = [];
  readonly control: TerminalControlRef;
  readonly terminal: TerminalEndpointRef;

  constructor(
    readonly kind: string,
    readonly supportedCapabilities: readonly TerminalControlCapability[],
    readonly providerCapabilities: readonly TerminalProviderCapability[],
    options: {
      label?: string;
      processAnchorPid?: number;
    } = {}
  ) {
    const label = options.label ?? `${kind}:0.0`;
    this.control = {
      kind,
      target: label,
      session: `${kind}-session`,
      panePid: options.processAnchorPid ?? 100,
      capabilities: [...supportedCapabilities]
    } as unknown as TerminalControlRef;
    this.terminal = createTerminalEndpointRef({
      identity: {
        providerKind: kind,
        endpointKey: `endpoint:${kind}`,
        resourceKey: `resource:${kind}`
      },
      route: {
        routeKey: `route:${kind}`,
        label
      },
      processAnchorPid: options.processAnchorPid ?? 100,
      capabilities: supportedCapabilities,
      providerRef: this.control
    });
  }

  async diagnostics(): Promise<Record<string, unknown>> {
    this.calls.push("diagnostics");
    return { kind: this.kind };
  }

  async listTerminals(): Promise<TerminalEndpointRef[]> {
    this.calls.push("listTerminals");
    return [this.terminal];
  }

  endpoint(terminalControl: TerminalControlRef): TerminalEndpointRef {
    this.calls.push("endpoint");
    assert.equal(terminalControl.kind, this.kind);
    return this.terminal;
  }

  toControlRef(
    terminal: TerminalEndpointRef,
    capabilities: readonly TerminalControlCapability[] = terminal.capabilities
  ): TerminalControlRef {
    this.calls.push("toControlRef");
    assert.equal(terminal.identity.providerKind, this.kind);
    return {
      ...this.control,
      capabilities: [...capabilities]
    } as TerminalControlRef;
  }

  async resolve(terminal: TerminalEndpointRef): Promise<TerminalEndpointRef> {
    this.calls.push("resolve");
    assert.equal(terminal.identity.providerKind, this.kind);
    return this.terminal;
  }

  containsProcess(
    terminal: TerminalEndpointRef,
    process: { pid: number; ppid: number },
    _processes: readonly { pid: number; ppid: number }[]
  ): boolean {
    this.calls.push("containsProcess");
    assert.equal(terminal.identity.providerKind, this.kind);
    return process.pid === terminal.processAnchorPid ||
      process.ppid === terminal.processAnchorPid;
  }

  async capture(
    terminal: TerminalEndpointRef,
    options: { scrollbackLines?: number; preserveEscapes?: boolean } = {}
  ): Promise<string> {
    this.calls.push(`capture:${options.scrollbackLines ?? "default"}`);
    assert.equal(terminal.identity.providerKind, this.kind);
    return `${this.kind}:screen`;
  }

  async sendText(terminal: TerminalEndpointRef, text: string): Promise<void> {
    this.calls.push(`sendText:${text}`);
    assert.equal(terminal.identity.providerKind, this.kind);
  }

  async sendKeys(
    terminal: TerminalEndpointRef,
    keys: readonly string[]
  ): Promise<void> {
    this.calls.push(`sendKeys:${keys.join(",")}`);
    assert.equal(terminal.identity.providerKind, this.kind);
  }
}

class FailingDiscoveryTerminalControlProvider extends RecordingTerminalControlProvider {
  failDiscovery = true;
  failDiagnostics = true;

  override async diagnostics(): Promise<Record<string, unknown>> {
    this.calls.push("diagnostics");
    if (this.failDiagnostics) {
      throw new Error(`${this.kind} diagnostics failed`);
    }
    return { kind: this.kind };
  }

  override async listTerminals(): Promise<TerminalEndpointRef[]> {
    this.calls.push("listTerminals");
    if (this.failDiscovery) {
      throw new Error(`${this.kind} discovery failed`);
    }
    return [this.terminal];
  }
}

async function terminalEndpoint(
  target: string,
  canonicalSocketPath?: string,
  options: {
    legacySocketPath?: string;
    paneId?: string;
  } = {}
): Promise<TerminalEndpointRef> {
  const separator = target.lastIndexOf(":");
  const session = separator >= 0 ? target.slice(0, separator) : target;
  const route = separator >= 0 ? target.slice(separator + 1) : "0.0";
  const [windowText = "0", paneText = "0"] = route.split(".", 2);
  const provider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target,
      socketPath: options.legacySocketPath ?? canonicalSocketPath,
      serverSocketPath: canonicalSocketPath,
      paneId: options.paneId ?? "%test",
      session,
      window: Number.parseInt(windowText, 10),
      pane: Number.parseInt(paneText, 10),
      panePid: 36_017
    }]
  });
  const [terminal] = await provider.listTerminals();
  assert.ok(terminal);
  return terminal;
}

test("parseTmuxListPanes parses stable tmux targets", () => {
  const panes = parseTmuxListPanes([
    "codex-work\t0\t0\t36017\tnode\t/Users/me/github/codex",
    "codex-work\t1\t2\t36099\tzsh\t/Users/me/github/app"
  ].join("\n"));

  assert.deepEqual(panes.map((pane) => pane.target), ["codex-work:0.0", "codex-work:1.2"]);
  assert.equal(panes[0].panePid, 36017);
  assert.equal(panes[0].currentCommand, "node");
});

test("parseTmuxListPanes preserves stable tmux socket and pane identities", async () => {
  const panes = parseTmuxListPanes([
    "codex-work\t0\t2\t36017\tnode\t/Users/me/github/codex\t/private/tmp/tmux-501/default\t%7"
  ].join("\n"), "/private/tmp/tmux-501/default");

  assert.equal(panes.length, 1);
  assert.equal(panes[0].socketPath, "/private/tmp/tmux-501/default");
  assert.equal(panes[0].serverSocketPath, "/private/tmp/tmux-501/default");
  assert.equal(panes[0].paneId, "%7");
  assert.equal(panes[0].target, "codex-work:0.2");

  const [terminal] = await new StaticTerminalControlProvider({ panes })
    .listTerminals();
  assert.deepEqual(terminal.identity, {
    providerKind: "tmux",
    endpointKey: "socket:/private/tmp/tmux-501/default",
    resourceKey: "pane-id:%7"
  });
});

test("parseTmuxListPanes falls back to whitespace-delimited output", () => {
  const panes = parseTmuxListPanes("codex-work 0 0 36017 node /Users/me/github/codex\n");

  assert.equal(panes.length, 1);
  assert.equal(panes[0].target, "codex-work:0.0");
  assert.equal(panes[0].panePid, 36017);
  assert.equal(panes[0].currentPath, "/Users/me/github/codex");
});

test("parseTmuxListPanes falls back to underscore-delimited output", () => {
  const panes = parseTmuxListPanes("codex-work_0_0_36017_node_/Users/me/github/codex\n");

  assert.equal(panes.length, 1);
  assert.equal(panes[0].target, "codex-work:0.0");
  assert.equal(panes[0].panePid, 36017);
  assert.equal(panes[0].currentCommand, "node");
  assert.equal(panes[0].currentPath, "/Users/me/github/codex");
});

test("enrichActiveProcessesWithTerminalControl attaches tmux metadata by pid ancestry", async () => {
  const processes: ActiveCodexProcess[] = [{
    agent: "codex",
    pid: 101,
    ppid: 100,
    command: "codex resume 019ee559-7bb8-7fd1-970c-0f7b6978c44e",
    cwd: "/repo",
    kind: "codex_cli",
    sessionId: "019ee559-7bb8-7fd1-970c-0f7b6978c44e",
    confidence: "high",
    reason: "test"
  }];
  const provider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "codex-work:0.0",
      session: "codex-work",
      window: 0,
      pane: 0,
      panePid: 100,
      currentCommand: "node",
      currentPath: "/repo"
    }]
  });

  const enriched = await enrichActiveProcessesWithTerminalControl(processes, provider);
  assert.equal(enriched[0].terminalControl?.target, "codex-work:0.0");
  assert.deepEqual(enriched[0].terminalControl?.capabilities, ["screen_status", "send_keys"]);
});

test("terminal enrichment only adds agent capabilities supplied by the caller", async () => {
  const processes: ActiveCodexProcess[] = [{
    agent: "codex",
    pid: 101,
    ppid: 100,
    command: "codex",
    cwd: "/repo",
    kind: "codex_cli",
    confidence: "medium",
    reason: "test"
  }];
  const provider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "codex-work:0.0",
      session: "codex-work",
      window: 0,
      pane: 0,
      panePid: 100,
      currentPath: "/repo"
    }]
  });

  const enriched = await enrichActiveProcessesWithTerminalControl(processes, provider, {
    capabilities: ["screen_status", "send_keys", "terminal_approval", "durable_completion"]
  });

  assert.deepEqual(enriched[0].terminalControl?.capabilities, [
    "screen_status",
    "send_keys",
    "terminal_approval",
    "durable_completion"
  ]);
});

test("enrichActiveProcessesWithTerminalControl never grants control from cwd alone", async () => {
  const processes: ActiveCodexProcess[] = [{
    agent: "codex",
    pid: 34663,
    ppid: 34654,
    command: "node /Users/me/.npm-global/bin/codex --",
    cwd: "/Users/me/github/talk-to-shadow",
    kind: "codex_cli",
    confidence: "medium",
    reason: "test"
  }];
  const provider = new StaticTerminalControlProvider({
    panes: [
      {
        kind: "tmux",
        target: "codex-work:0.2",
        session: "codex-work",
        window: 0,
        pane: 2,
        panePid: 85361,
        currentCommand: "node",
        currentPath: "/Users/me/github/talk-to-shadow"
      },
      {
        kind: "tmux",
        target: "codex-work:0.2",
        socketPath: "/private/tmp/tmux-501/default",
        session: "codex-work",
        window: 0,
        pane: 2,
        panePid: 85361,
        currentCommand: "node",
        currentPath: "/Users/me/github/talk-to-shadow"
      }
    ]
  });

  const enriched = await enrichActiveProcessesWithTerminalControl(processes, provider);

  assert.equal(enriched[0].terminalControl, undefined);
});

test("terminal enrichment follows an explicit unclassified wrapper ancestry", async () => {
  const processes: ActiveCodexProcess[] = [{
    agent: "codex",
    pid: 34663,
    ppid: 34654,
    command: "node /Users/me/.npm-global/bin/codex --",
    cwd: "/Users/me/github/talk-to-shadow",
    kind: "codex_cli",
    confidence: "medium",
    reason: "test"
  }];
  const provider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "codex-work:0.2",
      session: "codex-work",
      window: 0,
      pane: 2,
      panePid: 85361,
      currentCommand: "node",
      currentPath: "/Users/me/github/talk-to-shadow"
    }]
  });

  const enriched = await enrichActiveProcessesWithTerminalControl(processes, provider, {
    processTree: [
      processes[0],
      { pid: 34654, ppid: 85361, command: "npm exec codex" }
    ]
  });

  assert.equal(enriched[0].terminalControl?.target, "codex-work:0.2");
});

test("enrichActiveProcessesWithTerminalControl does not use ambiguous cwd fallback", async () => {
  const processes: ActiveCodexProcess[] = [{
    agent: "codex",
    pid: 500,
    ppid: 400,
    command: "node /Users/me/.npm-global/bin/codex",
    cwd: "/repo",
    kind: "codex_cli",
    confidence: "medium",
    reason: "test"
  }];
  const provider = new StaticTerminalControlProvider({
    panes: [
      {
        kind: "tmux",
        target: "codex-work:0.0",
        session: "codex-work",
        window: 0,
        pane: 0,
        panePid: 100,
        currentCommand: "node",
        currentPath: "/repo"
      },
      {
        kind: "tmux",
        target: "codex-work:0.1",
        session: "codex-work",
        window: 0,
        pane: 1,
        panePid: 200,
        currentCommand: "node",
        currentPath: "/repo"
      }
    ]
  });

  const enriched = await enrichActiveProcessesWithTerminalControl(processes, provider);

  assert.equal(enriched[0].terminalControl, undefined);
});

test("tmux provider falls back to explicit socket paths", async () => {
  const calls: string[][] = [];
  const provider = new TmuxTerminalControlProvider({
    socketPaths: ["/private/tmp/tmux-501/default"],
    commands: ["tmux"],
    runCommand(_command, args) {
      calls.push(args);
      if (args[0] === "-S" && args[1] === "/private/tmp/tmux-501/default" && args[2] === "list-panes") {
        return {
          status: 0,
          stdout: "codex-work\t0\t0\t36017\tnode\t/Users/me/github/codex\n",
          stderr: ""
        };
      }
      return {
        status: 1,
        stdout: "",
        stderr: "no server running"
      };
    }
  });

  const panes = await provider.listPanes();

  assert.equal(panes.length, 1);
  assert.equal(panes[0].target, "codex-work:0.0");
  assert.equal(panes[0].socketPath, "/private/tmp/tmux-501/default");
  assert.deepEqual(calls.map((args) => args.slice(0, 3)), [
    ["list-panes", "-a", "-F"],
    ["-S", "/private/tmp/tmux-501/default", "list-panes"]
  ]);
});

test("tmux provider deduplicates a default server also found by socket path", async () => {
  const provider = new TmuxTerminalControlProvider({
    socketPaths: ["/private/tmp/tmux-501/default"],
    commands: ["tmux"],
    runCommand() {
      return {
        status: 0,
        stdout: "codex-work\t0\t0\t36017\tnode\t/Users/me/github/codex\n",
        stderr: ""
      };
    }
  });

  const panes = await provider.listPanes();

  assert.equal(panes.length, 1);
  assert.equal(panes[0].target, "codex-work:0.0");
  assert.equal(panes[0].panePid, 36017);
  assert.equal(panes[0].socketPath, undefined);
});

test("terminal provider registry rejects duplicate and unknown provider kinds", () => {
  const provider = new StaticTerminalControlProvider();
  const registry = createTerminalControlProviderRegistry([provider]);

  assert.equal(registry.require("tmux"), provider);
  assert.throws(
    () => registry.register(new StaticTerminalControlProvider()),
    /already registered for tmux/u
  );
  assert.throws(
    () => registry.require("unknown"),
    /not registered for unknown/u
  );
});

test("terminal provider registry facade aggregates and dispatches by provider kind", async () => {
  const alpha = new RecordingTerminalControlProvider(
    "alpha",
    ["screen_status", "send_keys", "terminal_cancel"],
    ["screen_capture", "text_delivery", "key_delivery"]
  );
  const beta = new RecordingTerminalControlProvider(
    "beta",
    ["screen_status", "terminal_approval"],
    ["screen_capture", "ansi_capture", "key_delivery"]
  );
  const registry = createTerminalControlProviderRegistry([alpha]);
  const provider = registry.asProvider();

  assert.equal(registry.asProvider(), provider);
  assert.deepEqual(provider.supportedCapabilities, [
    "screen_status",
    "send_keys",
    "terminal_cancel"
  ]);
  registry.register(beta);
  assert.deepEqual(provider.supportedCapabilities, ["screen_status"]);
  assert.deepEqual(provider.providerCapabilities, [
    "screen_capture",
    "key_delivery"
  ]);

  assert.deepEqual(await provider.listTerminals(), [
    alpha.terminal,
    beta.terminal
  ]);
  assert.equal(provider.endpoint(alpha.control), alpha.terminal);
  assert.equal(
    provider.toControlRef(beta.terminal, ["screen_status"]).kind,
    "beta"
  );
  assert.equal(await provider.resolve(beta.terminal), beta.terminal);
  assert.equal(
    provider.containsProcess(alpha.terminal, { pid: 101, ppid: 100 }, []),
    true
  );
  assert.equal(
    await provider.capture(beta.terminal, { scrollbackLines: 12 }),
    "beta:screen"
  );
  await provider.sendText(alpha.terminal, "hello");
  await provider.sendKeys(beta.terminal, ["C-m"]);

  assert.deepEqual(alpha.calls, [
    "listTerminals",
    "endpoint",
    "containsProcess",
    "sendText:hello"
  ]);
  assert.deepEqual(beta.calls, [
    "listTerminals",
    "toControlRef",
    "resolve",
    "capture:12",
    "sendKeys:C-m"
  ]);

  const unknown = new RecordingTerminalControlProvider(
    "unknown",
    ["screen_status"],
    ["screen_capture"]
  );
  assert.throws(
    () => provider.toControlRef(unknown.terminal),
    /not registered for unknown/u
  );
});

test("terminal provider registry isolates discovery failures by provider", async () => {
  const tmux = new RecordingTerminalControlProvider(
    "tmux",
    ["screen_status", "send_keys"],
    ["screen_capture", "text_delivery", "key_delivery"]
  );
  const herdr = new FailingDiscoveryTerminalControlProvider(
    "herdr",
    ["screen_status", "send_keys"],
    ["screen_capture", "text_delivery", "key_delivery"]
  );
  const provider = createTerminalControlProviderRegistry([
    tmux,
    herdr
  ]).asProvider();

  assert.deepEqual(await provider.listTerminals(), [tmux.terminal]);
  assert.deepEqual(await provider.diagnostics(), {
    provider: "registry",
    providerKinds: ["tmux", "herdr"],
    providers: {
      tmux: { kind: "tmux" },
      herdr: {
        provider: "herdr",
        status: "error",
        error: "herdr diagnostics failed"
      }
    },
    discoveryErrors: {
      herdr: "herdr discovery failed"
    }
  });

  herdr.failDiscovery = false;
  herdr.failDiagnostics = false;
  assert.deepEqual(await provider.listTerminals(), [
    tmux.terminal,
    herdr.terminal
  ]);
  assert.deepEqual(
    (await provider.diagnostics()).discoveryErrors,
    {}
  );
});

test("terminal enrichment fails closed when providers contain the same process", async () => {
  const process: ActiveCodexProcess = {
    agent: "codex",
    pid: 101,
    ppid: 100,
    command: "codex",
    cwd: "/repo",
    kind: "codex_cli",
    confidence: "high",
    reason: "test"
  };
  const alpha = new RecordingTerminalControlProvider(
    "alpha",
    ["screen_status", "send_keys"],
    ["screen_capture", "process_inspection"],
    { processAnchorPid: 100 }
  );
  const beta = new RecordingTerminalControlProvider(
    "beta",
    ["screen_status", "send_keys"],
    ["screen_capture", "process_inspection"],
    { processAnchorPid: 100 }
  );
  const provider = createTerminalControlProviderRegistry([
    alpha,
    beta
  ]).asProvider();

  const [enriched] = await enrichActiveProcessesWithTerminalControl(
    [process],
    provider
  );

  assert.equal(enriched.terminalControl, undefined);
  assert.equal(alpha.calls.includes("toControlRef"), false);
  assert.equal(beta.calls.includes("toControlRef"), false);
});

test("terminal resolve refreshes the route without changing stable resource identity", async () => {
  const stableServerSocketPath = "/private/tmp/tmux-501/default";
  const originalProvider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "codex-work:0.0",
      serverSocketPath: stableServerSocketPath,
      paneId: "%7",
      session: "codex-work",
      window: 0,
      pane: 0,
      panePid: 36017,
      currentPath: "/repo/old"
    }]
  });
  const refreshedProvider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "renamed-work:1.2",
      socketPath: stableServerSocketPath,
      serverSocketPath: stableServerSocketPath,
      paneId: "%7",
      session: "renamed-work",
      window: 1,
      pane: 2,
      panePid: 36017,
      currentPath: "/repo/new"
    }]
  });
  const [original] = await originalProvider.listTerminals();

  const refreshed = await refreshedProvider.resolve(original);
  const refreshedControl = refreshedProvider.toControlRef(refreshed);

  assert.equal(sameTerminalEndpointIdentity(refreshed, original), true);
  assert.deepEqual(refreshed.identity, original.identity);
  assert.notEqual(refreshed.route.routeKey, original.route.routeKey);
  assert.equal(refreshed.route.label, "renamed-work:1.2");
  assert.equal(refreshed.route.currentPath, "/repo/new");
  assert.equal(refreshed.processAnchorPid, original.processAnchorPid);
  assert.equal(refreshedControl.target, "renamed-work:1.2");
  assert.equal(refreshedControl.socketPath, stableServerSocketPath);
});

test("tmux provider fails closed before command invocation without transport capability", async () => {
  const calls: string[][] = [];
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux"],
    runCommand(_command, args) {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    }
  });
  Object.defineProperty(provider, "providerCapabilities", {
    value: provider.providerCapabilities.filter((capability) =>
      capability !== "text_delivery"
    )
  });
  const endpointProvider = new StaticTerminalControlProvider({
    panes: [{
      kind: "tmux",
      target: "codex-work:0.0",
      serverSocketPath: "/private/tmp/tmux-501/default",
      paneId: "%7",
      session: "codex-work",
      window: 0,
      pane: 0,
      panePid: 36017
    }]
  });
  const [terminal] = await endpointProvider.listTerminals();

  await assert.rejects(
    provider.sendText(terminal, "hello"),
    (error: unknown) => {
      assert.ok(error instanceof TerminalControlInputNotSentError);
      assert.match(error.message, /does not support text_delivery/u);
      return true;
    }
  );
  assert.deepEqual(calls, []);
});

test("tmux provider falls back to absolute tmux command paths", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const provider = new TmuxTerminalControlProvider({
    socketPaths: ["/private/tmp/tmux-501/default"],
    commands: ["tmux", "/usr/local/bin/tmux"],
    runCommand(command, args) {
      calls.push({ command, args });
      if (command === "/usr/local/bin/tmux" && args[0] === "-S" && args[1] === "/private/tmp/tmux-501/default") {
        return {
          status: 0,
          stdout: "codex-work\t0\t0\t36017\tnode\t/Users/me/github/codex\n",
          stderr: ""
        };
      }
      return {
        status: command === "tmux" ? null : 1,
        stdout: "",
        stderr: "",
        error: command === "tmux" ? new Error("spawnSync tmux ENOENT") : undefined
      };
    }
  });

  const panes = await provider.listPanes();

  assert.equal(panes.length, 1);
  assert.equal(panes[0].target, "codex-work:0.0");
  assert.deepEqual(calls.map((call) => call.command), [
    "tmux",
    "tmux",
    "/usr/local/bin/tmux",
    "/usr/local/bin/tmux"
  ]);
});

test("discovers tmux default sockets across uid directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-tmux-sockets-"));
  try {
    fs.mkdirSync(path.join(root, "tmux-501"));
    fs.writeFileSync(path.join(root, "tmux-501", "default"), "");
    fs.mkdirSync(path.join(root, "not-tmux"));
    fs.writeFileSync(path.join(root, "not-tmux", "default"), "");

    assert.deepEqual(discoverTmuxSocketPaths(root), [
      path.join(root, "tmux-501", "default")
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tmux provider uses canonical socket and pane identity for capture and sends", async () => {
  const calls: string[][] = [];
  const canonicalSocketPath = "/private/tmp/tmux-501/canonical";
  const terminal = await terminalEndpoint(
    "codex-work:0.0",
    canonicalSocketPath,
    {
      legacySocketPath: "/private/tmp/tmux-501/stale-route",
      paneId: "%42"
    }
  );
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    runCommand(_command, args) {
      calls.push(args);
      return {
        status: 0,
        stdout: args.includes("capture-pane") ? "screen" : "",
        stderr: ""
      };
    }
  });

  assert.equal(await provider.capture(terminal, {
    scrollbackLines: 10
  }), "screen");
  await provider.sendText(terminal, "hello");
  await provider.sendKeys(terminal, ["Enter"]);

  assert.deepEqual(calls, [
    [
      "-S",
      canonicalSocketPath,
      "capture-pane",
      "-t",
      "%42",
      "-p",
      "-S",
      "-10"
    ],
    ["-S", canonicalSocketPath, "send-keys", "-t", "%42", "-l", "hello"],
    ["-S", canonicalSocketPath, "send-keys", "-t", "%42", "Enter"]
  ]);
});

test("tmux provider uses canonical socket and pane identity for multiline paste", async () => {
  const calls: string[][] = [];
  const canonicalSocketPath = "/private/tmp/tmux-501/canonical";
  const terminal = await terminalEndpoint(
    "claude-work:0.0",
    canonicalSocketPath,
    {
      legacySocketPath: "/private/tmp/tmux-501/stale-route",
      paneId: "%43"
    }
  );
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux"],
    runCommand(_command, args) {
      calls.push(args);
      return {
        status: 0,
        stdout: "",
        stderr: ""
      };
    }
  });

  await provider.sendText(terminal, "first line\nsecond line");

  assert.equal(calls.length, 2);
  assert.match(calls[0][4], /^akk-\d+-[0-9a-f-]+$/u);
  assert.deepEqual(calls[0].slice(0, 5), [
    "-S",
    canonicalSocketPath,
    "set-buffer",
    "-b",
    calls[0][4]
  ]);
  assert.deepEqual(calls[0].slice(5), ["--", "first line\nsecond line"]);
  assert.deepEqual(calls[1], [
    "-S",
    canonicalSocketPath,
    "paste-buffer",
    "-p",
    "-d",
    "-b",
    calls[0][4],
    "-t",
    "%43"
  ]);
  assert.equal(calls.some((args) => args.includes("send-keys")), false);
});

test("tmux provider treats a started multiline paste rejection as uncertain without retry", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const canonicalSocketPath = "/private/tmp/tmux-501/canonical";
  const terminal = await terminalEndpoint(
    "claude-work:0.0",
    canonicalSocketPath,
    {
      legacySocketPath: "/private/tmp/tmux-501/stale-route",
      paneId: "%44"
    }
  );
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/fallback/tmux"],
    runCommand(command, args) {
      calls.push({ command, args });
      if (args.includes("paste-buffer")) {
        return {
          status: 1,
          stdout: "",
          stderr: "paste rejected after start"
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  await assert.rejects(
    provider.sendText(terminal, "first line\nsecond line"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TerminalControlInputNotSentError, false);
      assert.match(error.message, /paste rejected after start/u);
      return true;
    }
  );

  assert.deepEqual(calls.map(({ command }) => command), ["tmux", "tmux", "tmux"]);
  assert.deepEqual(calls.map(({ args }) => args[2]), [
    "set-buffer",
    "paste-buffer",
    "delete-buffer"
  ]);
  assert.deepEqual(calls[2].args, [
    "-S",
    canonicalSocketPath,
    "delete-buffer",
    "-b",
    calls[0].args[4]
  ]);
  assert.equal(calls.some(({ command }) => command === "/fallback/tmux"), false);
  assert.equal(calls[1].args.at(-1), "%44");
  assert.equal(calls.every(({ args }) => args[1] === canonicalSocketPath), true);
});

test("tmux provider proves no input when commands reject or cannot start", async () => {
  const calls: string[] = [];
  const terminal = await terminalEndpoint("codex-work:0.0");
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/missing/tmux"],
    runCommand(command) {
      calls.push(command);
      if (command === "tmux") {
        return { status: 1, stdout: "", stderr: "no pane" };
      }
      const error = Object.assign(new Error("spawn ENOENT"), {
        code: "ENOENT"
      });
      return { status: null, stdout: "", stderr: "", error };
    }
  });

  await assert.rejects(
    provider.sendText(terminal, "hello"),
    TerminalControlInputNotSentError
  );
  assert.deepEqual(calls, ["tmux", "/missing/tmux"]);
});

test("tmux provider stops after an uncertain input attempt", async () => {
  const calls: string[] = [];
  const terminal = await terminalEndpoint("codex-work:0.0");
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/fallback/tmux"],
    runCommand(command) {
      calls.push(command);
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
      };
    }
  });

  await assert.rejects(
    provider.sendText(terminal, "hello"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TerminalControlInputNotSentError, false);
      assert.match(error.message, /timed out/u);
      return true;
    }
  );
  assert.deepEqual(calls, ["tmux"]);
});

test("tmux provider never retries an uncertain key dispatch", async () => {
  const calls: string[] = [];
  const terminal = await terminalEndpoint("codex-work:0.0");
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/fallback/tmux"],
    runCommand(command) {
      calls.push(command);
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("key dispatch timed out"), {
          code: "ETIMEDOUT"
        })
      };
    }
  });

  await assert.rejects(
    provider.sendKeys(terminal, ["C-m"]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof TerminalControlInputNotSentError, false);
      assert.match(error.message, /key dispatch timed out/u);
      return true;
    }
  );
  assert.deepEqual(calls, ["tmux"]);
});

test("tmux provider does not retry keys after tmux starts and rejects them", async () => {
  const calls: string[] = [];
  const terminal = await terminalEndpoint("codex-work:0.0");
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/fallback/tmux"],
    runCommand(command) {
      calls.push(command);
      return { status: 1, stdout: "", stderr: "no pane" };
    }
  });

  await assert.rejects(
    provider.sendKeys(terminal, ["C-m"]),
    TerminalControlInputNotSentError
  );
  assert.deepEqual(calls, ["tmux"]);
});

test("tmux provider may retry keys only when the executable never started", async () => {
  const calls: string[] = [];
  const terminal = await terminalEndpoint("codex-work:0.0");
  const provider = new TmuxTerminalControlProvider({
    socketPaths: [],
    commands: ["tmux", "/working/tmux"],
    runCommand(command) {
      calls.push(command);
      if (command === "tmux") {
        return {
          status: null,
          stdout: "",
          stderr: "",
          error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" })
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    }
  });

  await provider.sendKeys(terminal, ["C-m"]);
  assert.deepEqual(calls, ["tmux", "/working/tmux"]);
});

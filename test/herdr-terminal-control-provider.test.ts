import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import {
  HERDR_EXACT_PROTOCOL,
  HERDR_EXACT_VERSION,
  HerdrTerminalControlProvider,
  HerdrTransportError,
  inspectHerdrTtyViewport,
  parseHerdrSessionList,
  readHerdrSocketIdentity,
  requestHerdrUnixSocket,
  translateHerdrKey,
  type HerdrRequestFunction,
  type HerdrRequestOptions,
  type HerdrSessionInfo,
  type HerdrSocketIdentity,
  type HerdrTtyDeviceIdentity,
  type HerdrWireRequest
} from "../src/herdr-terminal-control-provider.js";
import {
  TerminalControlInputNotSentError,
  type CommandResult
} from "../src/terminal-control-provider.js";
import {
  sameTerminalEndpointIdentity,
  type HerdrTerminalControlRef
} from "../src/terminal-control-ref.js";

const SESSION: HerdrSessionInfo = {
  name: "default",
  default: true,
  running: true,
  socketPath: "/tmp/herdr-default.sock",
  sessionDir: "/tmp/herdr-default"
};

const SOCKET_IDENTITY: HerdrSocketIdentity = {
  device: "1",
  inode: "7001",
  ctimeNs: "1000000",
  ownerUid: 501
};

interface PaneState {
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  shellPid?: number;
  cwd: string;
  command: string;
}

interface HerdrHarness {
  provider: HerdrTerminalControlProvider;
  diagnostics: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>>;
  }>;
  state: PaneState;
  requests: Array<{
    socketPath: string;
    request: HerdrWireRequest;
    options?: HerdrRequestOptions;
  }>;
  inputFailure?: Error;
  inputResult?: Record<string, unknown>;
  serverVersion: string;
  serverProtocol: number;
  socketIdentity: HerdrSocketIdentity;
  viewportColumns: number;
  viewportRows: number;
  includeViewportLayout: boolean;
  viewportLayoutOverrides?: Record<string, unknown>;
  viewportLayoutPaneFocused?: unknown;
  ttyViewport?: { columns: number; rows: number };
  ttyViewportCalls: number[];
  ttyViewportError?: Error;
  viewportSnapshotPane?: Partial<Pick<
    PaneState,
    "paneId" | "terminalId" | "workspaceId" | "tabId"
  >>;
}

function sessionListJson(sessions: readonly HerdrSessionInfo[] = [SESSION]): string {
  return JSON.stringify({
    sessions: sessions.map((session) => ({
      name: session.name,
      default: session.default,
      running: session.running,
      socket_path: session.socketPath,
      session_dir: session.sessionDir
    }))
  });
}

function commandSuccess(stdout: string): CommandResult {
  return { status: 0, stdout, stderr: "" };
}

function ttyDeviceIdentity(
  overrides: Partial<HerdrTtyDeviceIdentity> = {}
): HerdrTtyDeviceIdentity {
  return {
    device: "13",
    inode: "37",
    rdev: "42",
    ctimeNs: "9000",
    ownerUid: 501,
    symbolicLink: false,
    characterDevice: true,
    ...overrides
  };
}

function psTtyEvidence(
  tty: string,
  processBirth = "Mon Aug 11 12:34:56 2026",
  pid = 7_001
): string {
  return `${pid} ${tty} ${processBirth}\n`;
}

function response(
  request: HerdrWireRequest,
  result: Record<string, unknown>
): Record<string, unknown> {
  return { id: request.id, result };
}

function createHarness(): HerdrHarness {
  const harness: HerdrHarness = {
    state: {
      paneId: "w1:p1",
      terminalId: "terminal-7",
      workspaceId: "w1",
      tabId: "w1:t1",
      shellPid: 7_001,
      cwd: "/work/old",
      command: "node old.js"
    },
    requests: [],
    diagnostics: [],
    serverVersion: HERDR_EXACT_VERSION,
    serverProtocol: HERDR_EXACT_PROTOCOL,
    socketIdentity: SOCKET_IDENTITY,
    viewportColumns: 132,
    viewportRows: 41,
    includeViewportLayout: true,
    viewportLayoutOverrides: undefined,
    viewportLayoutPaneFocused: true,
    ttyViewport: { columns: 80, rows: 40 },
    ttyViewportCalls: [],
    ttyViewportError: undefined,
    viewportSnapshotPane: undefined,
    provider: undefined as unknown as HerdrTerminalControlProvider,
    inputFailure: undefined,
    inputResult: undefined
  };

  const request: HerdrRequestFunction = async (
    socketPath,
    wireRequest,
    options
  ) => {
    harness.requests.push({ socketPath, request: wireRequest, options });
    const pane = harness.state;
    switch (wireRequest.method) {
      case "ping":
        return response(wireRequest, {
          type: "pong",
          version: harness.serverVersion,
          protocol: harness.serverProtocol,
          capabilities: {
            live_handoff: true,
            detached_server_daemon: true
          }
        });
      case "session.snapshot": {
        const snapshotOrdinal = harness.requests.filter((entry) =>
          entry.request.method === "session.snapshot").length;
        const snapshotPane = snapshotOrdinal >= 3 &&
          harness.viewportSnapshotPane
          ? { ...pane, ...harness.viewportSnapshotPane }
          : pane;
        return response(wireRequest, {
          type: "session_snapshot",
          snapshot: {
            version: harness.serverVersion,
            protocol: harness.serverProtocol,
            panes: [{
              pane_id: snapshotPane.paneId,
              terminal_id: snapshotPane.terminalId,
              workspace_id: snapshotPane.workspaceId,
              tab_id: snapshotPane.tabId,
              cwd: snapshotPane.cwd,
              focused: true,
              agent_status: null,
              revision: 0
            }],
            ...(harness.includeViewportLayout ? {
              layouts: [{
                workspace_id: pane.workspaceId,
                tab_id: pane.tabId,
                zoomed: false,
                ...harness.viewportLayoutOverrides,
                panes: [{
                  pane_id: pane.paneId,
                  focused: harness.viewportLayoutPaneFocused,
                  rect: {
                    x: 0,
                    y: 0,
                    width: harness.viewportColumns,
                    height: harness.viewportRows
                  }
                }],
                splits: []
              }]
            } : {})
          }
        });
      }
      case "pane.process_info":
        return response(wireRequest, {
          type: "pane_process_info",
          process_info: {
            pane_id: pane.paneId,
            shell_pid: pane.shellPid,
            foreground_process_group_id: 7_010,
            tty: null,
            foreground_processes: [{
              pid: 7_010,
              name: "node",
              argv0: "node",
              argv: ["node", "old.js"],
              cmdline: pane.command,
              cwd: pane.cwd
            }]
          }
        });
      case "pane.read":
        return response(wireRequest, {
          type: "pane_read",
          read: {
            pane_id: pane.paneId,
            workspace_id: pane.workspaceId,
            tab_id: pane.tabId,
            source: wireRequest.params.source,
            format: wireRequest.params.format,
            text: wireRequest.params.source === "visible" &&
              wireRequest.params.format === "ansi"
              ? "\u001b[2mplaceholder\u001b[0m"
              : "placeholder",
            revision: 0,
            truncated: false
          }
        });
      case "pane.send_input":
        if (harness.inputFailure) {
          throw harness.inputFailure;
        }
        return response(wireRequest, harness.inputResult ?? { type: "ok" });
      default:
        throw new Error(`unexpected Herdr method ${wireRequest.method}`);
    }
  };

  harness.provider = new HerdrTerminalControlProvider({
    command: "herdr-test",
    runCommand: (_command, args) => {
      if (args.length === 1 && args[0] === "--version") {
        return commandSuccess(`herdr ${HERDR_EXACT_VERSION}\n`);
      }
      assert.deepEqual(args, ["session", "list", "--json"]);
      return commandSuccess(sessionListJson());
    },
    request,
    diagnosticLog: (event, fields) => {
      harness.diagnostics.push({ event, fields });
    },
    statSocket: () => harness.socketIdentity,
    inspectTtyViewport: async (shellPid) => {
      harness.ttyViewportCalls.push(shellPid);
      if (harness.ttyViewportError) {
        throw harness.ttyViewportError;
      }
      return harness.ttyViewport;
    }
  });
  return harness;
}

test("Herdr discovery diagnostics identify a missing pane shell PID", async () => {
  const harness = createHarness();
  harness.state.shellPid = undefined;

  assert.deepEqual(await harness.provider.listTerminals(), []);
  assert.ok(harness.diagnostics.some(({ event, fields }) =>
    event === "herdr_pane_process_observation" &&
    fields.pane_id === "w1:p1" &&
    fields.shell_pid_available === false
  ));
  assert.ok(harness.diagnostics.some(({ event, fields }) =>
    event === "herdr_pane_endpoint_observation" &&
    fields.pane_id === "w1:p1" &&
    fields.status === "omitted" &&
    fields.reason === "shell_pid_unavailable"
  ));
});

test("parseHerdrSessionList maps official snake_case session records", () => {
  assert.deepEqual(parseHerdrSessionList(sessionListJson()), [SESSION]);
  assert.throws(
    () => parseHerdrSessionList(JSON.stringify({
      sessions: [
        {
          name: "one",
          default: true,
          running: true,
          socket_path: "/tmp/same.sock",
          session_dir: "/tmp/one"
        },
        {
          name: "two",
          default: false,
          running: true,
          socket_path: "/tmp/same.sock",
          session_dir: "/tmp/two"
        }
      ]
    })),
    /duplicate Herdr session socket/u
  );
  assert.throws(
    () => parseHerdrSessionList(JSON.stringify({
      sessions: [{
        name: "relative",
        default: true,
        running: true,
        socket_path: "relative/herdr.sock",
        session_dir: "/tmp/herdr"
      }]
    })),
    /invalid herdr session record/u
  );
});

test("Herdr command fallback only advances when an executable definitely did not start", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
  const provider = new HerdrTerminalControlProvider({
    runCommand: (command, args) => {
      calls.push({ command, args });
      if (command === "herdr") {
        return { status: null, stdout: "", stderr: "", error: missing };
      }
      if (args[0] === "--version") {
        return commandSuccess(`herdr ${HERDR_EXACT_VERSION}\n`);
      }
      return commandSuccess(sessionListJson([]));
    }
  });

  assert.deepEqual(await provider.listTerminals(), []);
  assert.deepEqual(calls, [
    { command: "herdr", args: ["--version"] },
    { command: "/opt/homebrew/bin/herdr", args: ["--version"] },
    {
      command: "/opt/homebrew/bin/herdr",
      args: ["session", "list", "--json"]
    }
  ]);
  const diagnostics = await provider.diagnostics();
  assert.equal(diagnostics.selectedCommand, "/opt/homebrew/bin/herdr");
});

test("Herdr pins the first started executable and treats CLI mismatch as unavailable", async () => {
  const calls: string[] = [];
  const provider = new HerdrTerminalControlProvider({
    runCommand: (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      return commandSuccess("herdr 0.9.0\n");
    }
  });

  assert.deepEqual(await provider.listTerminals(), []);
  assert.deepEqual(calls, ["herdr --version"]);
  const diagnostics = await provider.diagnostics();
  assert.equal(diagnostics.selectedCommand, "herdr");
  assert.match(
    String((diagnostics.attempts as Array<{ error?: string }>)[0]?.error),
    /requires exact CLI 0\.8\.0/u
  );
  assert.equal(calls.some((call) => call.startsWith("/opt/homebrew")), false);
});

test("Herdr discovery uses socket plus terminal_id as stable identity", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  assert.deepEqual(terminal.identity, {
    providerKind: "herdr",
    endpointKey: `socket:${SESSION.socketPath}`,
    resourceKey: "terminal-id:terminal-7"
  });
  assert.equal(terminal.processAnchorPid, 7_001);
  assert.equal(terminal.route.label, "default:w1:p1");
  assert.equal(terminal.route.currentPath, "/work/old");
  assert.equal(terminal.route.currentCommand, "node old.js");

  const control = harness.provider.toControlRef(terminal) as HerdrTerminalControlRef;
  assert.equal(control.kind, "herdr");
  assert.equal(control.terminalId, "terminal-7");
  assert.equal(control.paneId, "w1:p1");
  assert.equal(control.socketPath, SESSION.socketPath);
  assert.equal(
    sameTerminalEndpointIdentity(harness.provider.endpoint(control), terminal),
    true
  );
  assert.deepEqual(
    (harness.provider.toControlRef(terminal, ["send_keys"]) as HerdrTerminalControlRef)
      .capabilities,
    ["send_keys"]
  );
  assert.deepEqual(
    (harness.provider.toControlRef(
      { ...terminal, capabilities: ["screen_status"] },
      ["send_keys"]
    ) as HerdrTerminalControlRef).capabilities,
    []
  );

  harness.state.shellPid = undefined;
  assert.deepEqual(await harness.provider.listTerminals(), []);
});

test("Herdr resolve refreshes a moved pane route without changing identity", async () => {
  const harness = createHarness();
  const [before] = await harness.provider.listTerminals();
  assert.ok(before);

  harness.state.paneId = "w2:p9";
  harness.state.workspaceId = "w2";
  harness.state.tabId = "w2:t3";
  harness.state.shellPid = 8_001;
  harness.state.cwd = "/work/new";
  harness.state.command = "node new.js";
  const after = await harness.provider.resolve(before);

  assert.equal(sameTerminalEndpointIdentity(before, after), true);
  assert.notEqual(after.route.routeKey, before.route.routeKey);
  assert.equal(after.route.label, "default:w2:p9");
  assert.equal(after.processAnchorPid, 8_001);
  const control = harness.provider.toControlRef(after) as HerdrTerminalControlRef;
  assert.equal(control.paneId, "w2:p9");
  assert.equal(control.workspaceId, "w2");
  assert.equal(control.tabId, "w2:t3");
});

test("Herdr skips an incompatible protocol but fails closed on live API errors", async () => {
  const incompatible = createHarness();
  incompatible.serverProtocol = HERDR_EXACT_PROTOCOL + 1;
  assert.deepEqual(await incompatible.provider.listTerminals(), []);
  assert.equal(
    incompatible.requests.some((entry) => entry.request.method === "session.snapshot"),
    false
  );

  const failed = createHarness();
  failed.inputFailure = new Error("unused");
  const originalProvider = failed.provider;
  failed.provider = new HerdrTerminalControlProvider({
    command: "herdr-test",
    runCommand: (_command, args) => args[0] === "--version"
      ? commandSuccess(`herdr ${HERDR_EXACT_VERSION}\n`)
      : commandSuccess(sessionListJson()),
    request: async (_socketPath, request) => {
      if (request.method === "ping") {
        throw new HerdrTransportError("socket reset", false);
      }
      throw new Error("unexpected method");
    },
    statSocket: () => SOCKET_IDENTITY
  });
  assert.notEqual(failed.provider, originalProvider);
  await assert.rejects(failed.provider.listTerminals(), /socket reset/u);
});

test("Herdr capture resolves freshly and selects a style-preserving source", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;

  assert.equal(
    await harness.provider.capture(terminal, {
      scrollbackLines: 80
    }),
    "placeholder"
  );
  let read = harness.requests.find((entry) =>
    entry.request.method === "pane.read");
  assert.ok(read);
  assert.deepEqual(read.request.params, {
    pane_id: "w1:p1",
    source: "detection",
    lines: 80,
    format: "text"
  });

  harness.requests.length = 0;
  assert.equal(
    await harness.provider.capture(terminal, {
      scrollbackLines: 5_000,
      preserveEscapes: true
    }),
    "\u001b[2mplaceholder\u001b[0m"
  );
  read = harness.requests.find((entry) =>
    entry.request.method === "pane.read");
  assert.ok(read);
  assert.deepEqual(read.request.params, {
    pane_id: "w1:p1",
    source: "visible",
    lines: 1_000,
    format: "ansi"
  });
});

test("Herdr viewport inspection uses a fresh same-incarnation snapshot", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;

  assert.deepEqual(await harness.provider.inspectViewport(terminal), {
    columns: 80,
    rows: 40
  });
  assert.deepEqual(harness.ttyViewportCalls, [7_001]);
  const snapshots = harness.requests.filter((entry) =>
    entry.request.method === "session.snapshot");
  assert.equal(snapshots.length, 5);
  assert.deepEqual(
    snapshots.at(-1)?.options?.expectedSocketIdentity,
    SOCKET_IDENTITY
  );
});

test("Herdr viewport inspection prefers exact PTY size over zoomed layout area", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.viewportColumns = 54;
  harness.viewportRows = 40;
  harness.viewportLayoutOverrides = {
    zoomed: true,
    focused_pane_id: "w1:p1",
    area: { x: 0, y: 0, width: 108, height: 40 }
  };

  assert.deepEqual(await harness.provider.inspectViewport(terminal), {
    columns: 80,
    rows: 40
  });
  assert.deepEqual(harness.ttyViewportCalls, [7_001]);
});

test("Herdr viewport inspection returns unknown when another pane is zoomed", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.viewportColumns = 54;
  harness.viewportRows = 40;
  harness.viewportLayoutPaneFocused = false;
  harness.viewportLayoutOverrides = {
    zoomed: true,
    focused_pane_id: "w1:p2",
    area: { x: 0, y: 0, width: 108, height: 40 }
  };

  assert.equal(await harness.provider.inspectViewport(terminal), undefined);
  assert.deepEqual(harness.ttyViewportCalls, []);
});

test("Herdr viewport inspection never falls back to layout geometry", async () => {
  for (const area of [undefined, "108x40", { width: 0, height: 40 }]) {
    const harness = createHarness();
    const [terminal] = await harness.provider.listTerminals();
    assert.ok(terminal);
    harness.requests.length = 0;
    harness.viewportLayoutOverrides = {
      zoomed: true,
      focused_pane_id: "w1:p1",
      ...(area === undefined ? {} : { area })
    };

    assert.deepEqual(await harness.provider.inspectViewport(terminal), {
      columns: 80,
      rows: 40
    });
  }
});

test("Herdr zoomed viewport rejects missing or inconsistent focus metadata", async () => {
  const cases: Array<{
    overrides: Record<string, unknown>;
    paneFocused: unknown;
    error: RegExp;
  }> = [
    {
      overrides: {
        zoomed: true,
        area: { width: 108, height: 40 }
      },
      paneFocused: true,
      error: /requires an exact focused pane identity/u
    },
    {
      overrides: {
        zoomed: true,
        focused_pane_id: "w1:p1",
        area: { width: 108, height: 40 }
      },
      paneFocused: false,
      error: /focus metadata is inconsistent or missing/u
    },
    {
      overrides: {
        zoomed: true,
        focused_pane_id: "w1:p2",
        area: { width: 108, height: 40 }
      },
      paneFocused: true,
      error: /focus metadata is inconsistent/u
    },
    {
      overrides: {
        zoomed: true,
        focused_pane_id: "w1:p1",
        area: { width: 108, height: 40 }
      },
      paneFocused: "true",
      error: /layout pane focus is invalid/u
    }
  ];

  for (const scenario of cases) {
    const harness = createHarness();
    const [terminal] = await harness.provider.listTerminals();
    assert.ok(terminal);
    harness.requests.length = 0;
    harness.viewportLayoutOverrides = scenario.overrides;
    harness.viewportLayoutPaneFocused = scenario.paneFocused;

    await assert.rejects(
      harness.provider.inspectViewport(terminal),
      scenario.error
    );
    assert.deepEqual(harness.ttyViewportCalls, []);
  }
});

test("Herdr viewport inspection fails closed for malformed visibility metadata", async () => {
  const cases: Array<{
    overrides: Record<string, unknown>;
    error: RegExp;
  }> = [
    {
      overrides: { zoomed: "true" },
      error: /zoom state is invalid/u
    },
    {
      overrides: { zoomed: true, focused_pane_id: {} },
      error: /focused pane identity is invalid/u
    }
  ];

  for (const scenario of cases) {
    const harness = createHarness();
    const [terminal] = await harness.provider.listTerminals();
    assert.ok(terminal);
    harness.requests.length = 0;
    harness.viewportLayoutOverrides = scenario.overrides;

    await assert.rejects(
      harness.provider.inspectViewport(terminal),
      scenario.error
    );
  }
});

test("Herdr viewport inspection needs no layout area for a visible exact PTY", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.viewportLayoutOverrides = {
    zoomed: true,
    focused_pane_id: "w1:p1"
  };

  assert.deepEqual(await harness.provider.inspectViewport(terminal), {
    columns: 80,
    rows: 40
  });
});

test("Herdr viewport inspection fails closed when exact PTY size is unavailable or invalid", async () => {
  const unavailable = createHarness();
  const [unavailableTerminal] = await unavailable.provider.listTerminals();
  assert.ok(unavailableTerminal);
  unavailable.requests.length = 0;
  unavailable.ttyViewport = undefined;
  assert.equal(
    await unavailable.provider.inspectViewport(unavailableTerminal),
    undefined
  );

  const invalid = createHarness();
  const [invalidTerminal] = await invalid.provider.listTerminals();
  assert.ok(invalidTerminal);
  invalid.requests.length = 0;
  invalid.ttyViewport = { columns: 0, rows: 40 };
  await assert.rejects(
    invalid.provider.inspectViewport(invalidTerminal),
    /invalid exact PTY viewport dimensions/u
  );

  const overflow = createHarness();
  const [overflowTerminal] = await overflow.provider.listTerminals();
  assert.ok(overflowTerminal);
  overflow.requests.length = 0;
  overflow.ttyViewport = { columns: 65_536, rows: 40 };
  await assert.rejects(
    overflow.provider.inspectViewport(overflowTerminal),
    /invalid exact PTY viewport dimensions/u
  );
});

test("exact Herdr PTY inspection uses absolute macOS and Linux command variants", () => {
  for (const scenario of [
    {
      platform: "darwin" as const,
      tty: "ttys007",
      ttyPath: "/dev/ttys007",
      sttyFlag: "-f"
    },
    {
      platform: "linux" as const,
      tty: "pts/4",
      ttyPath: "/dev/pts/4",
      sttyFlag: "-F"
    }
  ]) {
    const calls: Array<{ command: string; args: string[] }> = [];
    const statPaths: string[] = [];
    const viewport = inspectHerdrTtyViewport(7_001, {
      platform: scenario.platform,
      currentUid: 501,
      statTty(ttyPath) {
        statPaths.push(ttyPath);
        return ttyDeviceIdentity();
      },
      runCommand(command, args) {
        calls.push({ command, args });
        return command.endsWith("/stty")
          ? commandSuccess("40 80\n")
          : commandSuccess(psTtyEvidence(scenario.tty));
      }
    });

    assert.deepEqual(viewport, { columns: 80, rows: 40 });
    assert.deepEqual(calls, [
      {
        command: "/bin/ps",
        args: ["-p", "7001", "-o", "pid=,tty=,lstart="]
      },
      {
        command: "/bin/stty",
        args: [scenario.sttyFlag, scenario.ttyPath, "size"]
      },
      {
        command: "/bin/ps",
        args: ["-p", "7001", "-o", "pid=,tty=,lstart="]
      }
    ]);
    assert.deepEqual(statPaths, [scenario.ttyPath, scenario.ttyPath]);
  }
});

test("exact Herdr PTY inspection rejects TTY, birth, and device incarnation drift", () => {
  let psCount = 0;
  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "darwin",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand(command) {
        if (command.endsWith("/stty")) {
          return commandSuccess("40 80\n");
        }
        psCount += 1;
        return commandSuccess(psTtyEvidence(
          psCount === 1 ? "ttys007" : "ttys008"
        ));
      }
    }),
    /TTY process identity changed during viewport inspection/u
  );

  psCount = 0;
  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "darwin",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand(command) {
        if (command.endsWith("/stty")) {
          return commandSuccess("40 80\n");
        }
        psCount += 1;
        return commandSuccess(psTtyEvidence(
          "ttys007",
          psCount === 1
            ? "Mon Aug 11 12:34:56 2026"
            : "Mon Aug 11 12:35:01 2026"
        ));
      }
    }),
    /TTY process identity changed during viewport inspection/u
  );

  let statCount = 0;
  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty() {
        statCount += 1;
        return ttyDeviceIdentity({ rdev: String(41 + statCount) });
      },
      runCommand(command) {
        return command.endsWith("/stty")
          ? commandSuccess("40 80\n")
          : commandSuccess(psTtyEvidence("pts/4"));
      }
    }),
    /TTY device .* changed during viewport inspection/u
  );
});

test("exact Herdr PTY inspection rejects unsafe devices and malformed sizes", () => {
  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand: () => commandSuccess(psTtyEvidence("../../etc/passwd"))
    }),
    /unsafe TTY path/u
  );

  for (const identity of [
    ttyDeviceIdentity({ symbolicLink: true }),
    ttyDeviceIdentity({ characterDevice: false }),
    ttyDeviceIdentity({ ownerUid: 502 })
  ]) {
    assert.throws(
      () => inspectHerdrTtyViewport(7_001, {
        platform: "darwin",
        currentUid: 501,
        statTty: () => identity,
        runCommand: () => commandSuccess(psTtyEvidence("ttys007"))
      }),
      /symbolic link|character device|owned by uid/u
    );
  }

  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "darwin",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand(command) {
        return command.endsWith("/stty")
          ? commandSuccess("80x40\n")
          : commandSuccess(psTtyEvidence("ttys007"));
      }
    }),
    /malformed PTY viewport dimensions/u
  );

  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand(command) {
        return command.endsWith("/stty")
          ? commandSuccess("40 65536\n")
          : commandSuccess(psTtyEvidence("pts/4"));
      }
    }),
    /malformed PTY viewport dimensions/u
  );

  assert.throws(
    () => inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand: () => commandSuccess(psTtyEvidence(
        `pts/${"1".repeat(1_025)}`
      ))
    }),
    /overlong TTY path/u
  );
});

test("exact Herdr PTY inspection returns unknown when TTY authority is unavailable", () => {
  assert.equal(
    inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand: () => commandSuccess(psTtyEvidence("??"))
    }),
    undefined
  );
  assert.equal(
    inspectHerdrTtyViewport(7_001, {
      platform: "linux",
      currentUid: 501,
      statTty: () => ttyDeviceIdentity(),
      runCommand(command) {
        return command.endsWith("/stty")
          ? { status: 1, stdout: "", stderr: "not attached" }
          : commandSuccess(psTtyEvidence("pts/4"));
      }
    }),
    undefined
  );
});

test("Herdr viewport inspection rejects fresh pane identity and route drift", async () => {
  for (const viewportSnapshotPane of [
    { terminalId: "terminal-replaced" },
    { workspaceId: "w2" },
    { tabId: "w1:t2" }
  ]) {
    const harness = createHarness();
    const [terminal] = await harness.provider.listTerminals();
    assert.ok(terminal);
    harness.requests.length = 0;
    harness.viewportSnapshotPane = viewportSnapshotPane;

    await assert.rejects(
      harness.provider.inspectViewport(terminal),
      /identity or route changed during viewport inspection/u
    );
  }
});

test("Herdr viewport inspection returns unknown when layout geometry is missing", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.includeViewportLayout = false;

  assert.equal(await harness.provider.inspectViewport(terminal), undefined);
});

test("Herdr sends literal text and translated keys in separate single requests", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);

  harness.requests.length = 0;
  await harness.provider.sendText(terminal, "first\nsecond");
  let inputs = harness.requests.filter((entry) =>
    entry.request.method === "pane.send_input");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].request.params, {
    pane_id: "w1:p1",
    text: "first\nsecond"
  });

  harness.requests.length = 0;
  await harness.provider.sendKeys(terminal, ["C-m", "C-u", "C-c", "Escape", "y"]);
  inputs = harness.requests.filter((entry) =>
    entry.request.method === "pane.send_input");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0].request.params, {
    pane_id: "w1:p1",
    keys: ["enter", "ctrl+u", "ctrl+c", "esc", "y"]
  });
  assert.deepEqual(inputs[0].options?.expectedSocketIdentity, SOCKET_IDENTITY);
});

test("Herdr input refuses process-anchor and server-socket drift before dispatch", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);

  harness.requests.length = 0;
  harness.state.shellPid = 8_001;
  await assert.rejects(
    harness.provider.sendText(terminal, "do not send"),
    TerminalControlInputNotSentError
  );
  assert.equal(
    harness.requests.some((entry) => entry.request.method === "pane.send_input"),
    false
  );

  harness.state.shellPid = 7_001;
  harness.socketIdentity = {
    ...SOCKET_IDENTITY,
    inode: "7002"
  };
  harness.requests.length = 0;
  await assert.rejects(
    harness.provider.sendKeys(terminal, ["C-m"]),
    TerminalControlInputNotSentError
  );
  assert.equal(
    harness.requests.some((entry) => entry.request.method === "pane.send_input"),
    false
  );
});

test("Herdr rejects every unsupported key before discovery or dispatch", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;

  await assert.rejects(
    harness.provider.sendKeys(terminal, ["C-m", "Prefix+x"]),
    TerminalControlInputNotSentError
  );
  assert.deepEqual(harness.requests, []);
  assert.equal(translateHerdrKey("S-Tab"), "shift+tab");
});

test("Herdr classifies explicit pre-enqueue input rejection as definitely not sent", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.inputResult = undefined;
  harness.inputFailure = undefined;

  let sendAttempts = 0;
  const rejectingProvider = new HerdrTerminalControlProvider({
    command: "herdr-test",
    runCommand: (_command, args) => args[0] === "--version"
      ? commandSuccess(`herdr ${HERDR_EXACT_VERSION}\n`)
      : commandSuccess(sessionListJson()),
    request: async (socketPath, request) => {
      if (request.method === "pane.send_input") {
        sendAttempts += 1;
        return {
          id: request.id,
          error: { code: "pane_send_failed", message: "queue rejected input" }
        };
      }
      return discoveryResponse(socketPath, request, harness.state);
    },
    statSocket: () => SOCKET_IDENTITY
  });

  await assert.rejects(
    rejectingProvider.sendText(terminal, "hello"),
    TerminalControlInputNotSentError
  );
  assert.equal(sendAttempts, 1);
});

test("Herdr never converts a post-connect lost ACK into a retryable no-send error", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.inputFailure = new HerdrTransportError("lost ACK", false);

  await assert.rejects(
    harness.provider.sendText(terminal, "do once"),
    (error: unknown) => {
      assert.equal(error instanceof TerminalControlInputNotSentError, false);
      assert.match(String(error), /lost ACK/u);
      return true;
    }
  );
  assert.equal(
    harness.requests.filter((entry) => entry.request.method === "pane.send_input").length,
    1
  );
});

test("Herdr maps a pre-connect transport failure to definitely not sent", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.inputFailure = new HerdrTransportError("not connected", true);

  await assert.rejects(
    harness.provider.sendText(terminal, "safe to retry"),
    TerminalControlInputNotSentError
  );
});

test("Herdr treats an unexpected post-dispatch ACK as uncertain", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  harness.requests.length = 0;
  harness.inputResult = { type: "unexpected" };

  await assert.rejects(
    harness.provider.sendKeys(terminal, ["C-m"]),
    (error: unknown) => {
      assert.equal(error instanceof TerminalControlInputNotSentError, false);
      assert.match(String(error), /unexpected result/u);
      return true;
    }
  );
  assert.equal(
    harness.requests.filter((entry) => entry.request.method === "pane.send_input").length,
    1
  );
});

test("Herdr process containment uses only exact PID ancestry", async () => {
  const harness = createHarness();
  const [terminal] = await harness.provider.listTerminals();
  assert.ok(terminal);
  const processes = [
    { pid: 7_001, ppid: 100 },
    { pid: 7_100, ppid: 7_001 },
    { pid: 7_101, ppid: 7_100 },
    { pid: 9_000, ppid: 1 }
  ];
  assert.equal(
    harness.provider.containsProcess(terminal, processes[2], processes),
    true
  );
  assert.equal(
    harness.provider.containsProcess(terminal, processes[3], processes),
    false
  );
});

test("raw Herdr Unix client writes one NDJSON request and correlates its response", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "akk-herdr-test-"));
  const socketPath = path.join(directory, "herdr.sock");
  let received = "";
  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      received += String(chunk);
      const newline = received.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const request = JSON.parse(received.slice(0, newline)) as HerdrWireRequest;
      socket.end(`${JSON.stringify({
        id: request.id,
        result: {
          type: "pong",
          version: HERDR_EXACT_VERSION,
          protocol: HERDR_EXACT_PROTOCOL
        }
      })}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const request: HerdrWireRequest = {
      id: "test:1",
      method: "ping",
      params: {}
    };
    assert.deepEqual(await requestHerdrUnixSocket(socketPath, request), {
      id: "test:1",
      result: {
        type: "pong",
        version: HERDR_EXACT_VERSION,
        protocol: HERDR_EXACT_PROTOCOL
      }
    });
    assert.equal(received, `${JSON.stringify(request)}\n`);

    const liveIdentity = readHerdrSocketIdentity(socketPath);
    await assert.rejects(
      requestHerdrUnixSocket(socketPath, {
        ...request,
        id: "test:socket-drift"
      }, {
        expectedSocketIdentity: {
          ...liveIdentity,
          inode: `${liveIdentity.inode}-changed`
        }
      }),
      (error: unknown) => {
        assert.ok(error instanceof HerdrTransportError);
        assert.equal(error.definitelyNotSent, true);
        assert.match(error.message, /changed before request dispatch/u);
        return true;
      }
    );
    assert.equal(received, `${JSON.stringify(request)}\n`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});

function discoveryResponse(
  _socketPath: string,
  request: HerdrWireRequest,
  pane: PaneState
): Record<string, unknown> {
  switch (request.method) {
    case "ping":
      return response(request, {
        type: "pong",
        version: HERDR_EXACT_VERSION,
        protocol: HERDR_EXACT_PROTOCOL
      });
    case "session.snapshot":
      return response(request, {
        type: "session_snapshot",
        snapshot: {
          version: HERDR_EXACT_VERSION,
          protocol: HERDR_EXACT_PROTOCOL,
          panes: [{
            pane_id: pane.paneId,
            terminal_id: pane.terminalId,
            workspace_id: pane.workspaceId,
            tab_id: pane.tabId,
            cwd: pane.cwd,
            focused: true,
            agent_status: null,
            revision: 0
          }]
        }
      });
    case "pane.process_info":
      return response(request, {
        type: "pane_process_info",
        process_info: {
          pane_id: pane.paneId,
          shell_pid: pane.shellPid,
          foreground_process_group_id: 7_010,
          tty: null,
          foreground_processes: [{
            pid: 7_010,
            name: "node",
            cmdline: pane.command,
            cwd: pane.cwd
          }]
        }
      });
    default:
      throw new Error(`unexpected discovery method ${request.method}`);
  }
}

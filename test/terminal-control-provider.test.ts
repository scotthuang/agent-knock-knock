import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  StaticTerminalControlProvider,
  TmuxTerminalControlProvider,
  discoverTmuxSocketPaths,
  enrichActiveProcessesWithTerminalControl,
  parseTmuxListPanes
} from "../src/terminal-control-provider.js";
import type { ActiveCodexProcess } from "../src/codex-session-provider.js";

test("parseTmuxListPanes parses stable tmux targets", () => {
  const panes = parseTmuxListPanes([
    "codex-work\t0\t0\t36017\tnode\t/Users/me/github/codex",
    "codex-work\t1\t2\t36099\tzsh\t/Users/me/github/app"
  ].join("\n"));

  assert.deepEqual(panes.map((pane) => pane.target), ["codex-work:0.0", "codex-work:1.2"]);
  assert.equal(panes[0].panePid, 36017);
  assert.equal(panes[0].currentCommand, "node");
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
  assert.deepEqual(enriched[0].terminalControl?.capabilities, ["screen_status", "send_keys", "terminal_approval"]);
});

test("enrichActiveProcessesWithTerminalControl falls back to unique pane cwd for wrapper-launched Codex", async () => {
  const processes: ActiveCodexProcess[] = [{
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

  assert.equal(enriched[0].terminalControl?.target, "codex-work:0.2");
  assert.equal(enriched[0].terminalControl?.panePid, 85361);
});

test("enrichActiveProcessesWithTerminalControl does not use ambiguous cwd fallback", async () => {
  const processes: ActiveCodexProcess[] = [{
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

test("tmux provider uses socket path for capture and sends", async () => {
  const calls: string[][] = [];
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

  assert.equal(await provider.capture("codex-work:0.0", {
    scrollbackLines: 10,
    socketPath: "/private/tmp/tmux-501/default"
  }), "screen");
  await provider.sendText("codex-work:0.0", "hello", {
    socketPath: "/private/tmp/tmux-501/default"
  });
  await provider.sendKeys("codex-work:0.0", ["Enter"], {
    socketPath: "/private/tmp/tmux-501/default"
  });

  assert.deepEqual(calls.map((args) => args.slice(0, 4)), [
    ["-S", "/private/tmp/tmux-501/default", "capture-pane", "-t"],
    ["-S", "/private/tmp/tmux-501/default", "send-keys", "-t"],
    ["-S", "/private/tmp/tmux-501/default", "send-keys", "-t"]
  ]);
});

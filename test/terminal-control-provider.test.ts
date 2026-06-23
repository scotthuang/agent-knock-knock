import test from "node:test";
import assert from "node:assert/strict";
import {
  StaticTerminalControlProvider,
  TmuxTerminalControlProvider,
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
  assert.deepEqual(enriched[0].terminalControl?.capabilities, ["capture_screen", "send_keys", "terminal_approval"]);
});

test("tmux provider falls back to explicit socket paths", async () => {
  const calls: string[][] = [];
  const provider = new TmuxTerminalControlProvider({
    socketPaths: ["/private/tmp/tmux-501/default"],
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  StaticTerminalControlProvider,
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

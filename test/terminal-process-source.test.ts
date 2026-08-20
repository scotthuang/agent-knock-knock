import test from "node:test";
import assert from "node:assert/strict";
import {
  isProcessAlive,
  parseProcessElapsedSeconds,
  StaticTerminalProcessSource,
  SystemTerminalProcessSource,
  type ProcessCommandResult,
  type TerminalProcessSource
} from "../src/terminal-process-source.js";

test("canonical terminal process liveness accepts self and rejects an absent pid", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(2_147_483_647), false);
});

test("ps elapsed values parse for selector recency", () => {
  assert.equal(parseProcessElapsedSeconds("00:12"), 12);
  assert.equal(parseProcessElapsedSeconds("01:02:03"), 3723);
  assert.equal(parseProcessElapsedSeconds("2-01:02:03"), 176523);
  assert.equal(parseProcessElapsedSeconds("not-a-duration"), undefined);
  assert.equal(parseProcessElapsedSeconds("00:99"), undefined);
});

test("only the system process source advertises complete inventory authority", () => {
  const staticSource: TerminalProcessSource = new StaticTerminalProcessSource([]);
  assert.equal(
    new SystemTerminalProcessSource().completeInventoryAuthority,
    true
  );
  assert.equal(
    staticSource.completeInventoryAuthority,
    undefined
  );
});

test("system process source returns neutral filtered snapshots with cwd metadata", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const source = new SystemTerminalProcessSource({
    runCommand(command, args): ProcessCommandResult {
      calls.push({ command, args });
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          "  100     1       01:00 tmux: client",
          " 1050   100       00:20 npm exec test-claude",
          " 1100  1050       00:12 test-claude --resume abc",
          " 1200   100       00:08 unrelated"
        ].join("\n") + "\n");
      }
      if (command === "lsof") {
        return ok([
          "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
          "node     1100 me    cwd    DIR   1,18       64  123 /repo/project"
        ].join("\n"));
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }
  });

  const snapshots = await source.listProcessSnapshots(
    (snapshot) => snapshot.command.startsWith("test-claude"),
    { includeAncestors: true }
  );

  assert.deepEqual(snapshots, [
    {
      pid: 100,
      ppid: 1,
      elapsed: "01:00",
      command: "tmux: client",
      cwd: undefined
    },
    {
      pid: 1050,
      ppid: 100,
      elapsed: "00:20",
      command: "npm exec test-claude",
      cwd: undefined
    },
    {
      pid: 1100,
      ppid: 1050,
      elapsed: "00:12",
      command: "test-claude --resume abc",
      cwd: "/repo/project"
    }
  ]);
  assert.deepEqual(calls.map(({ command }) => command), ["ps", "lsof"]);
  assert.deepEqual(calls[1].args.slice(-1), ["1100"]);
  assert.equal("agent" in snapshots.at(-1)!, false);
  assert.equal("kind" in snapshots.at(-1)!, false);
});

test("system process source keeps valid cwd rows from a partial lsof failure", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const source = new SystemTerminalProcessSource({
    runCommand(command, args): ProcessCommandResult {
      calls.push({ command, args });
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          "  100     1       01:00 tmux: server",
          " 1100   100       00:12 codex",
          " 1200   100       00:08 unrelated"
        ].join("\n") + "\n");
      }
      if (command === "lsof") {
        return {
          status: 1,
          stdout: [
            "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
            "codex    1100 me    cwd    DIR   1,18       64  123 /repo/project"
          ].join("\n"),
          stderr: ""
        };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
    }
  });

  const snapshots = await source.listProcessSnapshots(
    (snapshot) => snapshot.pid === 1100,
    { includeAncestors: true }
  );

  assert.equal(snapshots.find((snapshot) => snapshot.pid === 1100)?.cwd, "/repo/project");
  assert.deepEqual(calls.map(({ command }) => command), ["ps", "lsof"]);
  assert.deepEqual(calls[1].args.slice(-1), ["1100"]);
});

test("system process source rejects incomplete or malformed successful ps inventories", async (t) => {
  const cases = [
    {
      name: "malformed process row",
      stdout: [
        "  PID  PPID     ELAPSED COMMAND",
        " 1100 malformed process row"
      ].join("\n") + "\n",
      expected: /unparseable process inventory row/u
    },
    {
      name: "unexpected header",
      stdout: [
        "  PID  PPID COMMAND",
        " 1100   100 codex"
      ].join("\n") + "\n",
      expected: /unexpected process inventory header/u
    },
    {
      name: "header-only inventory",
      stdout: "  PID  PPID     ELAPSED COMMAND\n",
      expected: /header-only process inventory/u
    },
    {
      name: "truncated inventory without a final newline",
      stdout: [
        "  PID  PPID     ELAPSED COMMAND",
        " 1100   100       00:12 codex"
      ].join("\n"),
      expected: /truncated process inventory/u
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      const source = new SystemTerminalProcessSource({
        runCommand(command): ProcessCommandResult {
          assert.equal(command, "ps");
          return ok(fixture.stdout);
        }
      });

      await assert.rejects(
        source.listProcessSnapshots(),
        fixture.expected
      );
    });
  }
});

function ok(stdout: string): ProcessCommandResult {
  return { status: 0, stdout, stderr: "" };
}

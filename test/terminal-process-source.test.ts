import test from "node:test";
import assert from "node:assert/strict";
import {
  SystemTerminalProcessSource,
  type ProcessCommandResult
} from "../src/terminal-process-source.js";

test("system process source returns neutral filtered snapshots with cwd metadata", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  const source = new SystemTerminalProcessSource({
    runCommand(command, args): ProcessCommandResult {
      calls.push({ command, args });
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          " 1100   100       00:12 test-claude --resume abc",
          " 1200   100       00:08 unrelated"
        ].join("\n"));
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
    (snapshot) => snapshot.command.startsWith("test-claude")
  );

  assert.deepEqual(snapshots, [{
    pid: 1100,
    ppid: 100,
    elapsed: "00:12",
    command: "test-claude --resume abc",
    cwd: "/repo/project"
  }]);
  assert.deepEqual(calls.map(({ command }) => command), ["ps", "lsof"]);
  assert.deepEqual(calls[1].args.slice(-1), ["1100"]);
  assert.equal("agent" in snapshots[0], false);
  assert.equal("kind" in snapshots[0], false);
});

function ok(stdout: string): ProcessCommandResult {
  return { status: 0, stdout, stderr: "" };
}

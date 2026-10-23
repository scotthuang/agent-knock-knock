import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { processIncarnationRelationship } from "../src/terminal-authority-policy.js";
import { codexProcessBirthForLifecycle } from "../src/codex-process-incarnation.js";
import type { ManagedTerminalBinding } from "../src/managed-session.js";
import {
  isProcessAlive,
  parseProcessElapsedSeconds,
  StaticTerminalProcessSource,
  SystemTerminalProcessSource,
  terminalProcessIncarnationForPid,
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

test("physical process incarnation distinguishes PID reuse by process birth", () => {
  const before = terminalProcessIncarnationForPid(
    4242,
    () => "Mon Aug 24 10:00:00 2026"
  );
  const after = terminalProcessIncarnationForPid(
    4242,
    () => "Mon Aug 24 10:01:00 2026"
  );
  assert.equal(before.processBirth, "Mon Aug 24 10:00:00 2026");
  assert.notEqual(before.processUuid, after.processUuid);
  assert.throws(
    () => terminalProcessIncarnationForPid(4242, () => ""),
    /cannot verify process incarnation/u
  );
});

test("OS process probes fix the locale without changing the local timezone or birth format", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-process-locale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const birth = "Mon Aug 24 10:00:00 2026", probeLog = path.join(root, "probes.jsonl");
  fs.writeFileSync(path.join(root, "ps"), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({
  locale: process.env.LC_ALL, timezone: process.env.TZ ?? null
}) + "\\n");
if (process.env.LC_ALL !== "C") { process.stderr.write("unexpected localized probe"); process.exit(1); }
process.stdout.write(process.argv.includes("-axo")
  ? "  PID  PPID ELAPSED COMMAND\\n 4242 1 00:12 fixture-agent\\n"
  : ${JSON.stringify(birth + "\n")});
`, { mode: 0o700 });
  const keys = ["PATH", "LANG", "LC_ALL", "LC_TIME", "TZ"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, { PATH: root, LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8", LC_TIME: "zh_CN.UTF-8" });
    for (const timezone of ["Asia/Shanghai", undefined]) {
      if (timezone === undefined) delete process.env.TZ;
      else process.env.TZ = timezone;
      fs.writeFileSync(probeLog, "");
      const physical = terminalProcessIncarnationForPid(4242);
      assert.equal(physical.processBirth, birth);
      assert.equal(physical.processUuid, `process-pid:4242:birth:${birth}`);
      assert.equal(codexProcessBirthForLifecycle(4242), birth);
      const rows = await new SystemTerminalProcessSource().listProcessSnapshots(undefined, { includeCwd: false });
      assert.deepEqual(rows, [{ pid: 4242, ppid: 1, elapsed: "00:12", command: "fixture-agent" }]);
      const probes = fs.readFileSync(probeLog, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(probes, Array.from({ length: 3 }, () => ({ locale: "C", timezone: timezone ?? null })));
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});

test("locale repair retains exact legacy binding checks rather than accepting translated births", () => {
  const birth = "Mon Aug 24 10:00:00 2026";
  const current = terminalProcessIncarnationForPid(4242, () => birth);
  const binding: ManagedTerminalBinding = {
    binding_id: "fixture", generation: 1, terminal_id: "terminal:v2:tmux:claude:fixture:0.0:4242",
    terminal_control: { kind: "tmux", target: "fixture:0.0", session: "fixture", window: 0, pane: 0,
      panePid: 4242, capabilities: [] },
    native_process: { pid: 4242, process_uuid: current.processUuid, process_birth: birth, evidence: "process_birth" },
    bound_at: "2026-08-24T10:00:00Z", last_verified_at: "2026-08-24T10:00:00Z"
  };
  const live = { livePid: 4242, liveProcessUuid: current.processUuid, liveProcessBirth: current.processBirth };
  assert.equal(processIncarnationRelationship({ binding, ...live }), "same");
  const translated = "一 8月 24 10:00:00 2026";
  assert.equal(processIncarnationRelationship({ binding: { ...binding, native_process: {
    ...binding.native_process, process_birth: translated, process_uuid: `process-pid:4242:birth:${translated}`
  } }, ...live }), "different");
  assert.equal(binding.native_process.process_birth, birth, "no stored identity is rewritten");
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

test("system process source keeps PID authority when elapsed metadata is malformed", async () => {
  const diagnostics: Array<{
    event: string;
    fields: Readonly<Record<string, unknown>>;
  }> = [];
  const source = new SystemTerminalProcessSource({
    runCommand(command): ProcessCommandResult {
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          "  100     1       01:00 terminal shell",
          " 1099   100           - short-lived unrelated process",
          " 1100   100       00:12 codex"
        ].join("\n") + "\n");
      }
      if (command === "lsof") {
        return { status: 1, stdout: "", stderr: "lsof unavailable" };
      }
      return { status: 1, stdout: "", stderr: `unexpected command: ${command}` };
    },
    diagnosticLog(event, fields) {
      diagnostics.push({ event, fields });
    }
  });

  const snapshots = await source.listProcessSnapshots(
    (snapshot) => snapshot.pid === 1100,
    { includeAncestors: true }
  );

  assert.deepEqual(snapshots.map(({ pid, elapsed }) => ({ pid, elapsed })), [
    { pid: 100, elapsed: "01:00" },
    { pid: 1100, elapsed: "00:12" }
  ]);
  assert.deepEqual(diagnostics, [{
    event: "terminal_process_inventory_row",
    fields: {
      status: "metadata_unavailable",
      failure_kind: "elapsed_unparseable",
      row_number: 3,
      pid: 1099,
      ppid: 100,
      elapsed_value: "-",
      elapsed_value_length: 1
    }
  }]);
  assert.equal("command" in diagnostics[0]!.fields, false);
});

test("process inventory diagnostics cannot change discovery behavior", async () => {
  const source = new SystemTerminalProcessSource({
    runCommand(command): ProcessCommandResult {
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          " 1100   100           - codex"
        ].join("\n") + "\n");
      }
      return { status: 1, stdout: "", stderr: "lsof unavailable" };
    },
    diagnosticLog() {
      throw new Error("diagnostic sink failed");
    }
  });

  assert.deepEqual(await source.listProcessSnapshots(), [{
    pid: 1100,
    ppid: 100,
    command: "codex"
  }]);
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

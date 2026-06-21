import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexStoreAdapter,
  buildThreadSelect,
  latestStateDbPath,
  parseLsofCwdMap,
  parsePsProcessSnapshots,
  type CommandResult
} from "../src/codex-store-adapter.js";

const SESSION_ID = "019ee559-7bb8-7fd1-970c-0f7b6978c44e";

test("Codex store adapter selects the newest state sqlite database without hardcoding the version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-store-"));
  const oldDb = path.join(dir, "state_5.sqlite");
  const newDb = path.join(dir, "state_6.sqlite");

  try {
    fs.writeFileSync(oldDb, "", "utf8");
    fs.writeFileSync(newDb, "", "utf8");
    const now = new Date("2026-06-21T00:00:00Z");
    fs.utimesSync(oldDb, new Date("2026-06-20T00:00:00Z"), new Date("2026-06-20T00:00:00Z"));
    fs.utimesSync(newDb, now, now);

    assert.equal(latestStateDbPath(dir), newDb);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter builds thread selects from detected columns", () => {
  assert.equal(
    buildThreadSelect(["id", "cwd", "updated_at"], 25),
    "select id, cwd, null as rollout_path, null as title, null as preview, null as first_user_message, updated_at * 1000 as updated_at_ms, 0 as archived from threads order by updated_at * 1000 desc limit 25"
  );
  assert.equal(
    buildThreadSelect(["id", "cwd", "rollout_path", "updated_at_ms", "archived"], 0),
    "select id, cwd, rollout_path, null as title, null as preview, null as first_user_message, updated_at_ms, archived from threads order by updated_at_ms desc limit 1"
  );
});

test("Codex store adapter parses process and cwd command output", () => {
  const snapshots = parsePsProcessSnapshots([
    "  PID  PPID     ELAPSED COMMAND",
    ` 1000     1       50:35 node /Users/me/bin/codex resume ${SESSION_ID}`,
    " 1001  1000       50:35 /vendor/bin/codex",
    " bad"
  ].join("\n"));
  const cwdByPid = parseLsofCwdMap([
    "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
    "node     1000 me    cwd    DIR   1,18       64  123 /repo/acpx",
    "codex    1001 me    cwd    DIR   1,18       64  124 /repo/acpx"
  ].join("\n"));

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].pid, 1000);
  assert.equal(snapshots[0].command, `node /Users/me/bin/codex resume ${SESSION_ID}`);
  assert.equal(cwdByPid.get(1001), "/repo/acpx");
});

test("Codex store adapter wraps sqlite and process command output behind the adapter interface", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-adapter-"));
  const dbPath = path.join(dir, "state_6.sqlite");
  const calls: string[] = [];
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command, args): CommandResult {
      calls.push([command, ...args].join(" "));
      if (command === "sqlite3" && args[0] === "-json" && args[2] === "pragma table_info(threads)") {
        return ok(JSON.stringify([
          { name: "id" },
          { name: "cwd" },
          { name: "rollout_path" },
          { name: "updated_at_ms" }
        ]));
      }
      if (command === "sqlite3" && args[0] === "-json" && args[2].startsWith("select id")) {
        return ok(JSON.stringify([{
          id: SESSION_ID,
          cwd: "/repo/acpx",
          rollout_path: "/rollout.jsonl",
          updated_at_ms: 20,
          archived: 0
        }]));
      }
      if (command === "ps") {
        return ok([
          "  PID  PPID     ELAPSED COMMAND",
          ` 1000     1       50:35 node /Users/me/bin/codex resume ${SESSION_ID}`
        ].join("\n"));
      }
      if (command === "lsof") {
        return ok([
          "COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME",
          "node     1000 me    cwd    DIR   1,18       64  123 /repo/acpx"
        ].join("\n"));
      }
      return {
        status: 1,
        stdout: "",
        stderr: "unexpected command"
      };
    }
  });

  try {
    fs.writeFileSync(dbPath, "", "utf8");

    assert.equal((await adapter.listThreadRows())[0].id, SESSION_ID);
    assert.equal((await adapter.listProcessSnapshots())[0].cwd, "/repo/acpx");
    assert.equal(calls.some((call) => call.startsWith("sqlite3 -json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function ok(stdout: string): CommandResult {
  return {
    status: 0,
    stdout,
    stderr: ""
  };
}

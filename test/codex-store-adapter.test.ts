import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexStoreAdapter,
  buildThreadSelect,
  latestStateDbPath,
  parseLsofOpenFiles,
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

test("Codex store adapter resolves the one open root rollout for an exact process pid", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-adapter-"));
  const sessionsDir = path.join(dir, "sessions", "2026", "08", "05");
  const rootPath = path.join(sessionsDir, `rollout-root-${SESSION_ID}.jsonl`);
  const childThreadId = "019ee559-7bb8-7fd1-970c-0f7b6978c450";
  const childPath = path.join(sessionsDir, `rollout-child-${childThreadId}.jsonl`);
  const calls: string[] = [];
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command, args): CommandResult {
      calls.push([command, ...args].join(" "));
      if (command === "ps") {
        return ok(`${processBirth}\n`);
      }
      if (command === "lsof") {
        const rootStat = fs.statSync(rootPath, { bigint: true });
        const childStat = fs.statSync(childPath, { bigint: true });
        return ok([
          "p4242",
          "fcwd",
          "tDIR",
          "n/repo/project",
          "f12r",
          "tREG",
          `D${rootStat.dev}`,
          `i${rootStat.ino}`,
          `n${rootPath}`,
          "f13r",
          "tREG",
          `D${childStat.dev}`,
          `i${childStat.ino}`,
          `n${childPath}`
        ].join("\n"));
      }
      return { status: 1, stdout: "", stderr: "unexpected command" };
    }
  });

  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(rootPath, JSON.stringify({
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: "cli"
      }
    }) + "\n", "utf8");
    fs.writeFileSync(childPath, JSON.stringify({
      type: "session_meta",
      payload: {
        id: childThreadId,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: { subagent: { thread_spawn: { parent_thread_id: SESSION_ID } } }
      }
    }) + "\n", "utf8");
    assert.deepEqual(
      await adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      {
      sessionId: SESSION_ID,
      processUuid: `codex-pid:4242:birth:${processBirth}`,
      processBirth,
      rollout: {
        fd: "12r",
        device: String(fs.statSync(rootPath, { bigint: true }).dev),
        inode: String(fs.statSync(rootPath, { bigint: true }).ino),
        path: fs.realpathSync(rootPath)
      },
      evidence: "codex_open_root_rollout"
      }
    );
    assert.equal(
      calls.includes("lsof -a -p 4242 -FnfDit"),
      true
    );
    assert.deepEqual(
      parseLsofOpenFiles(`p4242\nfcwd\ntDIR\nn/repo/project\nf12r\ntREG\nD1\ni2\nn${rootPath}\n`),
      [
        { fd: "cwd", type: "DIR", path: "/repo/project" },
        { fd: "12r", type: "REG", device: "1", inode: "2", path: rootPath }
      ]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed when multiple root rollouts are open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-ambiguous-"));
  const sessionsDir = path.join(dir, "sessions");
  const secondId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const paths = [SESSION_ID, secondId].map((id) =>
    path.join(sessionsDir, `rollout-${id}.jsonl`)
  );
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      return ok(paths.flatMap((filePath, index) => {
        const stat = fs.statSync(filePath, { bigint: true });
        return [
          `f${20 + index}r`,
          "tREG",
          `D${stat.dev}`,
          `i${stat.ino}`,
          `n${filePath}`
        ];
      }).join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (let index = 0; index < paths.length; index += 1) {
      fs.writeFileSync(paths[index], JSON.stringify({
        type: "session_meta",
        payload: {
          id: [SESSION_ID, secondId][index],
          cwd: "/repo/project",
          originator: "codex-tui",
          source: "cli"
        }
      }) + "\n", "utf8");
    }
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /2 open root rollout files/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed when the same root rollout has multiple descriptors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-duplicate-fd-"));
  const sessionsDir = path.join(dir, "sessions");
  const rolloutPath = path.join(sessionsDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(rolloutPath, { bigint: true });
      return ok([12, 13].flatMap((fd) => [
        `f${fd}r`,
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${rolloutPath}`
      ]).join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(rolloutPath, JSON.stringify({
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: "cli"
      }
    }) + "\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /2 open root rollout files/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter never treats a rollout outside CODEX_HOME sessions as virgin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-outside-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-external-"));
  const rolloutPath = path.join(outsideDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(rolloutPath, { bigint: true });
      return ok([
        "f12r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${rolloutPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    fs.writeFileSync(rolloutPath, "{}\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /outside CODEX_HOME\/sessions/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("Codex store adapter never treats a rollout as virgin when the configured sessions root is absent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-no-root-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-no-root-open-"));
  const rolloutPath = path.join(outsideDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(rolloutPath, { bigint: true });
      return ok([
        "f12r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${rolloutPath}`
      ].join("\n"));
    }
  });
  try {
    fs.writeFileSync(rolloutPath, "{}\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /CODEX_HOME\/sessions is unavailable/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed for deleted rollout descriptors", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-deleted-"));
  const sessionsDir = path.join(dir, "sessions");
  const rolloutPath = path.join(sessionsDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(rolloutPath, { bigint: true });
      return ok([
        "f12r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${rolloutPath} (deleted)`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(rolloutPath, "{}\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /unverifiable open rollout descriptor/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter rechecks rollout device and inode on the no-follow metadata fd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-fstat-"));
  const sessionsDir = path.join(dir, "sessions");
  const rolloutPath = path.join(sessionsDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(rolloutPath, { bigint: true });
      return ok([
        "f12r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino + 1n}`,
        `n${rolloutPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(rolloutPath, "{}\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /rollout descriptor no longer matches its file/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter does not follow a rollout symlink while reading metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-symlink-"));
  const sessionsDir = path.join(dir, "sessions");
  const targetPath = path.join(sessionsDir, "target.jsonl");
  const rolloutPath = path.join(sessionsDir, `rollout-${SESSION_ID}.jsonl`);
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      const stat = fs.statSync(targetPath, { bigint: true });
      return ok([
        "f12r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${rolloutPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(targetPath, JSON.stringify({
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: "cli"
      }
    }) + "\n", "utf8");
    fs.symlinkSync(targetPath, rolloutPath);
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /unreadable open rollout descriptor/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter never treats an unverifiable sessions rollout fd as virgin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-unverifiable-"));
  const rolloutPath = path.join(
    dir,
    "sessions",
    `rollout-${SESSION_ID}.jsonl`
  );
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      return ok([
        "f12r",
        "tREG",
        "D1",
        // Missing inode: the descriptor cannot be tied to the current file.
        `n${rolloutPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, "{}\n", "utf8");
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      /unverifiable open rollout descriptor/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter reports virgin only when the process has no sessions rollout fd", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-virgin-"));
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok("Tue Aug  4 14:15:13 2026\n");
      }
      return ok("p4242\nfcwd\ntDIR\nn/repo/project\n");
    }
  });
  try {
    assert.equal(
      await adapter.resolveActiveSessionIdentityForPid(4242, "/repo/project"),
      undefined
    );
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
    "node     1000 me    cwd    DIR   1,18       64  123 /repo/project",
    "codex    1001 me    cwd    DIR   1,18       64  124 /repo/project"
  ].join("\n"));

  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[0].pid, 1000);
  assert.equal(snapshots[0].command, `node /Users/me/bin/codex resume ${SESSION_ID}`);
  assert.equal(cwdByPid.get(1001), "/repo/project");
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
          cwd: "/repo/project",
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
          "node     1000 me    cwd    DIR   1,18       64  123 /repo/project"
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
    assert.equal((await adapter.listProcessSnapshots())[0].cwd, "/repo/project");
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

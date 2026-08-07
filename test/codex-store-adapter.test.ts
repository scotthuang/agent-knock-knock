import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CodexStoreAdapter,
  buildThreadByIdSelect,
  buildThreadSelect,
  latestStateDbPath,
  parseLsofOpenFiles,
  parseLsofCwdMap,
  parsePsProcessSnapshots,
  runCodexSqliteThreadQuery,
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
  const missingId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const paths = [SESSION_ID, secondId].map((id) =>
    path.join(sessionsDir, `rollout-${id}.jsonl`)
  );
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok(`${processBirth}\n`);
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
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        secondId
      ),
      /does not have the preferred session as its sole open root rollout/u
    );
    const companionStat = fs.statSync(paths[0], { bigint: true });
    const allowedCompanionIdentity = {
      sessionId: SESSION_ID,
      processUuid: `codex-pid:4242:birth:${processBirth}`,
      processBirth,
      rollout: {
        fd: "20r",
        device: String(companionStat.dev),
        inode: String(companionStat.ino),
        path: fs.realpathSync(paths[0])
      },
      evidence: "codex_open_root_rollout"
    };
    const selected = await adapter.resolveActiveSessionIdentityForPid(
      4242,
      "/repo/project",
      secondId,
      allowedCompanionIdentity
    );
    const selectedStat = fs.statSync(paths[1], { bigint: true });
    assert.deepEqual(selected, {
      sessionId: secondId,
      processUuid: `codex-pid:4242:birth:${processBirth}`,
      processBirth,
      rollout: {
        fd: "21r",
        device: String(selectedStat.dev),
        inode: String(selectedStat.ino),
        path: fs.realpathSync(paths[1])
      },
      evidence: "codex_open_root_rollout"
    });
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        missingId
      ),
      /does not have the preferred session as its sole open root rollout/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter falls back to an exact open companion when the preferred rollout is missing and the primary identity is status-only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-companion-fallback-"));
  const sessionsDir = path.join(dir, "sessions");
  const companionId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const preferredId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const companionPath = path.join(sessionsDir, `rollout-${companionId}.jsonl`);
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok(`${processBirth}\n`);
      }
      const stat = fs.statSync(companionPath, { bigint: true });
      return ok([
        "f20r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${companionPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(companionPath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: companionId,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: "cli"
      }
    })}\n`, "utf8");
    const stat = fs.statSync(companionPath, { bigint: true });
    const exactCompanionIdentity = {
      sessionId: companionId,
      processUuid,
      processBirth,
      rollout: {
        fd: "20r",
        device: String(stat.dev),
        inode: String(stat.ino),
        path: fs.realpathSync(companionPath)
      },
      evidence: "codex_open_root_rollout"
    };

    assert.deepEqual(
      await adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        preferredId,
        {
          sessionId: SESSION_ID,
          processUuid,
          processBirth,
          evidence: "codex_status_card"
        },
        [exactCompanionIdentity]
      ),
      exactCompanionIdentity
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed when the preferred rollout is missing and only an unknown root is open", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-unknown-only-"));
  const sessionsDir = path.join(dir, "sessions");
  const knownCompanionId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const preferredId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const unknownId = "019ee559-7bb8-7fd1-970c-0f7b6978c453";
  const knownCompanionPath = path.join(
    sessionsDir,
    `rollout-${knownCompanionId}.jsonl`
  );
  const unknownPath = path.join(sessionsDir, `rollout-${unknownId}.jsonl`);
  const processBirth = "Tue Aug  4 14:15:13 2026";
  const processUuid = `codex-pid:4242:birth:${processBirth}`;
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok(`${processBirth}\n`);
      }
      const stat = fs.statSync(unknownPath, { bigint: true });
      return ok([
        "f21r",
        "tREG",
        `D${stat.dev}`,
        `i${stat.ino}`,
        `n${unknownPath}`
      ].join("\n"));
    }
  });
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    for (const [id, rolloutPath] of [
      [knownCompanionId, knownCompanionPath],
      [unknownId, unknownPath]
    ]) {
      fs.writeFileSync(rolloutPath, `${JSON.stringify({
        type: "session_meta",
        payload: {
          id,
          cwd: "/repo/project",
          originator: "codex-tui",
          source: "cli"
        }
      })}\n`, "utf8");
    }
    const knownStat = fs.statSync(knownCompanionPath, { bigint: true });

    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        preferredId,
        {
          sessionId: SESSION_ID,
          processUuid,
          processBirth,
          evidence: "codex_status_card"
        },
        [{
          sessionId: knownCompanionId,
          processUuid,
          processBirth,
          rollout: {
            fd: "20r",
            device: String(knownStat.dev),
            inode: String(knownStat.ino),
            path: fs.realpathSync(knownCompanionPath)
          },
          evidence: "codex_open_root_rollout"
        }]
      ),
      /unexpected open root rollout outside the preferred and exact companion identities/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter allows multiple exact historical roots but rejects an unknown extra root", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-rollout-history-set-"));
  const sessionsDir = path.join(dir, "sessions");
  const secondOldId = "019ee559-7bb8-7fd1-970c-0f7b6978c451";
  const targetId = "019ee559-7bb8-7fd1-970c-0f7b6978c452";
  const unknownId = "019ee559-7bb8-7fd1-970c-0f7b6978c453";
  const ids = [SESSION_ID, secondOldId, targetId, unknownId];
  const paths = ids.map((id) =>
    path.join(sessionsDir, `rollout-${id}.jsonl`)
  );
  const processBirth = "Tue Aug  4 14:15:13 2026";
  let openRootCount = 3;
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    runCommand(command): CommandResult {
      if (command === "ps") {
        return ok(`${processBirth}\n`);
      }
      return ok(paths.slice(0, openRootCount).flatMap((filePath, index) => {
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
      fs.writeFileSync(paths[index], `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: ids[index],
          cwd: "/repo/project",
          originator: "codex-tui",
          source: "cli"
        }
      })}\n`, "utf8");
    }
    const identityFor = (index: number) => {
      const stat = fs.statSync(paths[index], { bigint: true });
      return {
        sessionId: ids[index],
        processUuid: `codex-pid:4242:birth:${processBirth}`,
        processBirth,
        rollout: {
          fd: `${20 + index}r`,
          device: String(stat.dev),
          inode: String(stat.ino),
          path: fs.realpathSync(paths[index])
        },
        evidence: "codex_open_root_rollout"
      };
    };
    const primaryOldIdentity = identityFor(0);
    const additionalOldIdentity = identityFor(1);
    assert.deepEqual(
      await adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        targetId,
        primaryOldIdentity,
        [additionalOldIdentity]
      ),
      identityFor(2)
    );

    openRootCount = 4;
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        targetId,
        primaryOldIdentity,
        [additionalOldIdentity]
      ),
      /unexpected open root rollout outside the preferred and exact companion identities/u
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
    await assert.rejects(
      adapter.resolveActiveSessionIdentityForPid(
        4242,
        "/repo/project",
        SESSION_ID
      ),
      new RegExp(
        `multiple open root rollouts for preferred session ${SESSION_ID}`,
        "u"
      )
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
    "select id, cwd, null as rollout_path, null as title, null as preview, null as first_user_message, updated_at * 1000 as updated_at_ms, 0 as archived, null as source, null as model_provider, null as cli_version, null as name from threads order by updated_at * 1000 desc limit 25"
  );
  assert.equal(
    buildThreadSelect(["id", "cwd", "rollout_path", "updated_at_ms", "archived"], 0),
    "select id, cwd, rollout_path, null as title, null as preview, null as first_user_message, updated_at_ms, archived, null as source, null as model_provider, null as cli_version, null as name from threads order by updated_at_ms desc limit 1"
  );
  assert.match(
    buildThreadByIdSelect(["id", "cwd", "updated_at_ms"], SESSION_ID),
    new RegExp(`where id = '${SESSION_ID}'`, "u")
  );
  const lifecycleSelect = buildThreadSelect([
    "id",
    "cwd",
    "updated_at_ms",
    "archived",
    "source",
    "model_provider"
  ], 25, {
    cwd: "/repo/o'hare\n.quit",
    source: "cli",
    archived: false,
    modelProvider: "openai"
  });
  assert.match(
    lifecycleSelect,
    /where cwd collate binary = :akk_cwd and source collate binary = :akk_source and archived = 0 and model_provider collate binary = :akk_model_provider/u
  );
  assert.match(
    lifecycleSelect,
    /order by updated_at_ms desc, id desc limit 25$/u
  );
  assert.equal(lifecycleSelect.includes("o'hare"), false);
  assert.match(
    buildThreadSelect(["id", "cwd", "updated_at_ms"], 5, { source: "cli" }),
    /where 0 = 1 order by updated_at_ms desc, id desc limit 5$/u
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
  const sqliteCalls: Array<{ openMode: string; nativeThreadId?: string }> = [];
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    async runSqliteThreadQuery(request) {
      sqliteCalls.push({
        openMode: request.openMode,
        nativeThreadId: request.nativeThreadId
      });
      return {
        columns: ["id", "cwd", "rollout_path", "updated_at_ms"],
        rows: [{
          id: SESSION_ID,
          cwd: "/repo/project",
          rollout_path: "/rollout.jsonl",
          updated_at_ms: 20,
          archived: 0
        }]
      };
    },
    runCommand(command, args): CommandResult {
      calls.push([command, ...args].join(" "));
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
    assert.deepEqual(sqliteCalls, [{ openMode: "readonly", nativeThreadId: undefined }]);
    assert.equal(calls.some((call) => call.startsWith("sqlite3 ")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex lifecycle candidates require exact root metadata and revalidate the rollout token", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-candidates-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const rolloutPath = path.join(
    dir,
    "sessions",
    "2026",
    "08",
    "06",
    `rollout-root-${SESSION_ID}.jsonl`
  );
  const row = {
    id: SESSION_ID,
    cwd: "/repo/project",
    rollout_path: rolloutPath,
    title: "Candidate title",
    preview: "Candidate preview",
    updated_at_ms: 1234,
    archived: 0,
    source: "cli",
    model_provider: "openai",
    cli_version: "0.146.1",
    name: "Candidate name"
  };
  const columns = Object.keys(row);
  const queryRequests: Array<{
    nativeThreadId?: string;
    filters?: {
      cwd?: string;
      source?: string;
      archived?: boolean;
      modelProvider?: string;
    };
  }> = [];
  const adapter = new CodexStoreAdapter({
    codexHome: dir,
    async runSqliteThreadQuery(request) {
      queryRequests.push({
        nativeThreadId: request.nativeThreadId,
        filters: request.filters
      });
      return {
        columns,
        rows: request.nativeThreadId && request.nativeThreadId !== row.id
          ? []
          : [row]
      };
    }
  });
  const writeRollout = (cliVersion: string): void => {
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd: "/repo/project",
        originator: "codex-tui",
        source: "cli",
        cli_version: cliVersion,
        model_provider: "openai"
      }
    })}\n`, "utf8");
  };
  try {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    writeRollout("0.146.1");
    fs.writeFileSync(dbPath, "", "utf8");

    const request = {
      cwd: "/repo/project",
      agentVersion: "0.146.1",
      modelProvider: "openai"
    };
    const candidate = (await adapter.listThreadLifecycleCandidates(request))[0];
    assert.equal(candidate.nativeThreadId, SESSION_ID);
    assert.equal(candidate.rootInteractive, true);
    assert.equal(candidate.fileToken.path, fs.realpathSync(rolloutPath));
    assert.equal(
      candidate.candidateToken.schema,
      "agent-knock-knock/thread-candidate-token"
    );
    assert.equal(candidate.agentVersion, "0.146.1");
    assert.equal(candidate.sourceAgentVersion, "0.146.1");
    assert.equal(candidate.candidateToken.version, 1);
    assert.equal(candidate.candidateToken.agentVersion, "0.146.1");
    assert.equal("sourceAgentVersion" in candidate.candidateToken, false);
    assert.deepEqual(queryRequests[0], {
      nativeThreadId: undefined,
      filters: {
        cwd: "/repo/project",
        source: "cli",
        archived: false,
        modelProvider: "openai"
      }
    });
    assert.match(candidate.fileToken.device, /^\d+$/u);
    assert.match(candidate.fileToken.inode, /^\d+$/u);
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate(
        candidate.candidateToken,
        request
      )).status,
      "valid"
    );
    fs.appendFileSync(rolloutPath, "{}\n", "utf8");
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate(
        candidate.candidateToken,
        request
      )).status,
      "changed"
    );
    await assert.rejects(
      adapter.listThreadLifecycleCandidates({
        ...request,
        agentVersion: "0.146.2"
      }),
      /supported exact versions: 0\.146\.0, 0\.146\.1/u
    );

    row.cli_version = "0.140.0";
    writeRollout("0.140.0");
    const historicalCandidate = (
      await adapter.listThreadLifecycleCandidates(request)
    )[0];
    assert.equal(historicalCandidate.agentVersion, "0.146.1");
    assert.equal(historicalCandidate.sourceAgentVersion, "0.140.0");
    assert.equal(historicalCandidate.candidateToken.version, 2);
    assert.equal(historicalCandidate.candidateToken.agentVersion, "0.146.1");
    assert.equal(
      historicalCandidate.candidateToken.sourceAgentVersion,
      "0.140.0"
    );
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate(
        historicalCandidate.candidateToken,
        request
      )).status,
      "valid"
    );

    if (historicalCandidate.candidateToken.version !== 2) {
      assert.fail("historical Codex candidate must use a v2 token");
    }
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate({
        ...historicalCandidate.candidateToken,
        sourceAgentVersion: "0.139.0"
      }, request)).status,
      "changed"
    );
    const {
      sourceAgentVersion: _sourceAgentVersion,
      ...historicalTokenBase
    } = historicalCandidate.candidateToken;
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate({
        ...historicalTokenBase,
        version: 1
      }, request)).status,
      "changed"
    );

    row.cli_version = "0.146.0";
    assert.deepEqual(
      await adapter.listThreadLifecycleCandidates(request),
      []
    );
    writeRollout("0.146.0");
    assert.equal(
      (await adapter.listThreadLifecycleCandidates(request))[0]
        .sourceAgentVersion,
      "0.146.0"
    );

    row.archived = 2;
    assert.deepEqual(
      await adapter.listThreadLifecycleCandidates(request),
      []
    );
    row.archived = 0;

    row.source = JSON.stringify({ subagent: { thread_spawn: {} } });
    assert.deepEqual(
      await adapter.listThreadLifecycleCandidates(request),
      []
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SQLITE_AVAILABLE = spawnSync("sqlite3", ["-version"], {
  encoding: "utf8"
}).status === 0;

test("Codex lifecycle discovery filters before LIMIT and lists older producer versions", {
  skip: !SQLITE_AVAILABLE
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-candidate-limit-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const cwd = "/repo/o'hare\n.quit";
  const rolloutPath = path.join(
    dir,
    "sessions",
    "2026",
    "08",
    "08",
    `rollout-root-${SESSION_ID}.jsonl`
  );
  try {
    fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
    fs.writeFileSync(rolloutPath, `${JSON.stringify({
      type: "session_meta",
      payload: {
        id: SESSION_ID,
        cwd,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.140.0",
        model_provider: "openai"
      }
    })}\n`, "utf8");

    const rowSql = ({
      id,
      rowCwd,
      rowRolloutPath,
      updatedAtMs,
      archived = 0,
      source = "cli"
    }: {
      id: string;
      rowCwd: string;
      rowRolloutPath: string;
      updatedAtMs: number;
      archived?: number;
      source?: string;
    }): string =>
      "insert into threads(" +
      "id,cwd,rollout_path,updated_at_ms,archived,source," +
      "model_provider,cli_version,title,preview,name" +
      ") values(" + [
        sqliteLiteral(id),
        sqliteLiteral(rowCwd),
        sqliteLiteral(rowRolloutPath),
        String(updatedAtMs),
        String(archived),
        sqliteLiteral(source),
        sqliteLiteral("openai"),
        sqliteLiteral(id === SESSION_ID ? "0.140.0" : "0.146.1"),
        sqliteLiteral("title"),
        sqliteLiteral("preview"),
        sqliteLiteral("name")
      ].join(",") + ");";
    const decoys = Array.from({ length: 105 }, (_, index) => rowSql({
      id: `10000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
      rowCwd: `/repo/unrelated-${index}`,
      rowRolloutPath: path.join(dir, `missing-${index}.jsonl`),
      updatedAtMs: 10_000 + index
    }));
    const statements = [
      "pragma journal_mode=WAL;",
      "create table threads(" +
        "id text primary key," +
        "cwd text not null," +
        "rollout_path text not null," +
        "updated_at_ms integer not null," +
        "archived integer not null," +
        "source text not null," +
        "model_provider text not null," +
        "cli_version text not null," +
        "title text,preview text,name text" +
        ");",
      ...decoys,
      rowSql({
        id: "20000000-0000-4000-8000-000000000001",
        rowCwd: cwd,
        rowRolloutPath: path.join(dir, "archived.jsonl"),
        updatedAtMs: 30_000,
        archived: 1
      }),
      rowSql({
        id: "20000000-0000-4000-8000-000000000002",
        rowCwd: cwd,
        rowRolloutPath: path.join(dir, "subagent.jsonl"),
        updatedAtMs: 20_000,
        source: "exec"
      }),
      rowSql({
        id: SESSION_ID,
        rowCwd: cwd,
        rowRolloutPath: rolloutPath,
        updatedAtMs: 1
      }),
      "pragma wal_checkpoint(TRUNCATE);"
    ];
    const setup = spawnSync("sqlite3", [dbPath, statements.join(" ")], {
      encoding: "utf8"
    });
    assert.equal(setup.status, 0, setup.stderr);

    const queryOnlyRows = await runCodexSqliteThreadQuery({
      dbPath,
      openMode: "query_only",
      maxSessions: 1,
      filters: {
        cwd,
        source: "cli",
        archived: false,
        modelProvider: "openai"
      }
    });
    assert.deepEqual(queryOnlyRows.rows.map((row) => row.id), [SESSION_ID]);

    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      maxSessions: 1,
      sqliteCantOpenRetryDelaysMs: []
    });
    const candidates = await adapter.listThreadLifecycleCandidates({
      cwd,
      agentVersion: "0.146.1",
      modelProvider: "openai"
    });

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].nativeThreadId, SESSION_ID);
    assert.equal(candidates[0].agentVersion, "0.146.1");
    assert.equal(candidates[0].sourceAgentVersion, "0.140.0");
    assert.equal(candidates[0].candidateToken.version, 2);
    assert.equal(
      (await adapter.revalidateThreadLifecycleCandidate(
        candidates[0].candidateToken,
        { cwd, agentVersion: "0.146.1", modelProvider: "openai" }
      )).status,
      "valid"
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex lifecycle filters survive CANTOPEN recovery on the WAL-safe path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-filter-retry-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const requests: Array<{
    openMode: string;
    filters: unknown;
    nativeThreadId?: string;
  }> = [];
  try {
    fs.writeFileSync(dbPath, "fixture", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      sqliteCantOpenRetryDelaysMs: [],
      async runSqliteThreadQuery(request) {
        requests.push({
          openMode: request.openMode,
          filters: request.filters,
          nativeThreadId: request.nativeThreadId
        });
        if (request.openMode === "readonly") {
          throw sqliteFailure(14, "schema", "unable to open database file (14)");
        }
        return {
          columns: ["id", "cwd", "source", "archived"],
          rows: []
        };
      }
    });

    assert.deepEqual(
      await adapter.listThreadLifecycleCandidates({
        cwd: "/repo/project",
        agentVersion: "0.146.1",
        modelProvider: "openai"
      }),
      []
    );
    const expectedFilters = {
      cwd: "/repo/project",
      source: "cli",
      archived: false,
      modelProvider: "openai"
    };
    assert.deepEqual(requests, [
      {
        openMode: "readonly",
        filters: expectedFilters,
        nativeThreadId: undefined
      },
      {
        openMode: "query_only",
        filters: expectedFilters,
        nativeThreadId: undefined
      }
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter materializes missing WAL sidecars through a query-only connection", {
  skip: !SQLITE_AVAILABLE
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-wal-missing-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  try {
    createWalThreadDatabase(dbPath, [{
      id: SESSION_ID,
      cwd: "/repo/project",
      updatedAtMs: 20
    }]);
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    const directReadonly = spawnSync("sqlite3", [
      "-readonly",
      "-json",
      dbPath,
      "pragma table_info(threads)"
    ], { encoding: "utf8" });
    const readonlyObservedCantOpen = directReadonly.status === 14 ||
      /(?:SQLITE_CANTOPEN|unable to open database file|\(14\))/iu.test(
        directReadonly.stderr
      );
    assert.equal(
      directReadonly.status === 0 || readonlyObservedCantOpen,
      true,
      directReadonly.stderr
    );

    const before = fs.readFileSync(dbPath);
    const modes: string[] = [];
    let simulatedCantOpen = false;
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      sqliteCantOpenRetryDelaysMs: [],
      async runSqliteThreadQuery(request) {
        modes.push(request.openMode);
        if (
          request.openMode === "readonly" &&
          !readonlyObservedCantOpen &&
          !simulatedCantOpen
        ) {
          simulatedCantOpen = true;
          throw sqliteFailure(14, "schema", "SQLITE_CANTOPEN (14)");
        }
        return runCodexSqliteThreadQuery(request);
      }
    });
    const rows = await adapter.listThreadRows();

    assert.deepEqual(rows.map((row) => row.id), [SESSION_ID]);
    assert.deepEqual(modes, ["readonly", "query_only"]);
    assert.equal(fs.readFileSync(dbPath).equals(before), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter tolerates WAL and SHM replacement during bounded CANTOPEN retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-wal-rebuild-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const modes: string[] = [];
  const waits: number[] = [];
  let attempt = 0;
  try {
    fs.writeFileSync(dbPath, "fixture", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      sqliteCantOpenRetryDelaysMs: [5],
      async sleep(milliseconds) {
        waits.push(milliseconds);
        fs.writeFileSync(`${dbPath}-wal`, "rebuilt-wal", "utf8");
        fs.writeFileSync(`${dbPath}-shm`, "rebuilt-shm", "utf8");
      },
      async runSqliteThreadQuery(request) {
        modes.push(request.openMode);
        attempt += 1;
        if (attempt === 1) {
          throw sqliteFailure(14, "schema", "unable to open database file (14)");
        }
        return threadQueryResult();
      }
    });

    assert.equal((await adapter.listThreadRows())[0].id, SESSION_ID);
    assert.deepEqual(modes, ["readonly", "readonly"]);
    assert.deepEqual(waits, [5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed when the main state database changes during retry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-db-rotate-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  let calls = 0;
  try {
    fs.writeFileSync(dbPath, "before", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      sqliteCantOpenRetryDelaysMs: [1],
      async sleep() {
        const replacement = path.join(dir, "replacement.sqlite");
        fs.writeFileSync(replacement, "after", "utf8");
        fs.renameSync(replacement, dbPath);
      },
      async runSqliteThreadQuery() {
        calls += 1;
        throw sqliteFailure(14, "schema", "unable to open database file (14)");
      }
    });

    await assert.rejects(
      adapter.listThreadRows(),
      /main database changed during readonly_attempt_2/u
    );
    assert.equal(calls, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter fails closed when a newer state database appears during a query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-db-newer-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const newerPath = path.join(dir, "state_6.sqlite");
  try {
    fs.writeFileSync(dbPath, "before", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      async runSqliteThreadQuery() {
        fs.writeFileSync(newerPath, "newer", "utf8");
        const future = new Date(Date.now() + 2_000);
        fs.utimesSync(newerPath, future, future);
        return threadQueryResult();
      }
    });

    await assert.rejects(
      adapter.listThreadRows(),
      /main database changed during readonly_attempt_1_complete/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter reports query stage and main WAL SHM state after recovery is exhausted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-wal-diagnostic-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const modes: string[] = [];
  try {
    fs.writeFileSync(dbPath, "fixture", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      sqliteCantOpenRetryDelaysMs: [0],
      async sleep() {},
      async runSqliteThreadQuery(request) {
        modes.push(request.openMode);
        throw sqliteFailure(14, "schema", "unable to open database file (14)");
      }
    });

    await assert.rejects(adapter.listThreadRows(), (error: unknown) => {
      assert.equal(error instanceof Error, true);
      const message = error instanceof Error ? error.message : String(error);
      assert.match(message, /stage=query_only_materialization:schema/u);
      assert.match(message, /status=14/u);
      assert.match(message, new RegExp(`db=${escapeRegExp(dbPath)}`, "u"));
      assert.match(message, /main=file\(dev=\d+,ino=\d+,size=7,/u);
      assert.match(message, /wal=missing\(ENOENT\)/u);
      assert.match(message, /shm=missing\(ENOENT\)/u);
      return true;
    });
    assert.deepEqual(modes, ["readonly", "readonly", "query_only"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex store adapter never retries non-CANTOPEN SQLite failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-db-busy-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const modes: string[] = [];
  try {
    fs.writeFileSync(dbPath, "fixture", "utf8");
    const adapter = new CodexStoreAdapter({
      codexHome: dir,
      async runSqliteThreadQuery(request) {
        modes.push(request.openMode);
        throw sqliteFailure(5, "schema", "database is locked (5)");
      }
    });

    await assert.rejects(adapter.listThreadRows(), /status=5/u);
    assert.deepEqual(modes, ["readonly"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex sqlite keeps one snapshot while a concurrent checkpoint is blocked, then survives checkpoint", {
  skip: !SQLITE_AVAILABLE
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-wal-checkpoint-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  const secondId = "019ee559-7bb8-7fd1-970c-0f7b6978c450";
  try {
    createWalThreadDatabase(dbPath, [{
      id: SESSION_ID,
      cwd: "/repo/project",
      updatedAtMs: 20
    }]);
    const first = await runCodexSqliteThreadQuery({
      dbPath,
      openMode: "query_only",
      maxSessions: 10,
      afterSchema() {
        const writer = spawnSync("sqlite3", [dbPath, [
          `insert into threads(id,cwd,updated_at_ms,archived) values('${secondId}','/repo/project',30,0);`,
          "pragma wal_checkpoint(TRUNCATE);"
        ].join(" ")], { encoding: "utf8", timeout: 5_000 });
        assert.equal(writer.status, 0, writer.stderr);
        assert.match(writer.stdout.trim(), /^1\|\d+\|\d+$/u);
      }
    });
    assert.deepEqual(first.rows.map((row) => row.id), [SESSION_ID]);

    const checkpoint = spawnSync("sqlite3", [
      dbPath,
      "pragma wal_checkpoint(TRUNCATE);"
    ], { encoding: "utf8", timeout: 5_000 });
    assert.equal(checkpoint.status, 0, checkpoint.stderr);
    assert.match(checkpoint.stdout.trim(), /^0\|\d+\|\d+$/u);

    const second = await runCodexSqliteThreadQuery({
      dbPath,
      openMode: "query_only",
      maxSessions: 10
    });
    assert.deepEqual(
      second.rows.map((row) => row.id),
      [secondId, SESSION_ID]
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Codex sqlite query rejects a threads schema missing required columns before selecting rows", {
  skip: !SQLITE_AVAILABLE
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-codex-db-schema-"));
  const dbPath = path.join(dir, "state_5.sqlite");
  try {
    const setup = spawnSync("sqlite3", [
      dbPath,
      "create table threads(id text primary key);"
    ], { encoding: "utf8" });
    assert.equal(setup.status, 0, setup.stderr);

    await assert.rejects(
      runCodexSqliteThreadQuery({
        dbPath,
        openMode: "query_only",
        maxSessions: 10
      }),
      /threads table is missing required id or cwd columns/u
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createWalThreadDatabase(
  dbPath: string,
  rows: Array<{ id: string; cwd: string; updatedAtMs: number }>
): void {
  const statements = [
    "pragma journal_mode=WAL;",
    "create table threads(" +
      "id text primary key," +
      "cwd text not null," +
      "updated_at_ms integer not null," +
      "archived integer not null default 0" +
      ");",
    ...rows.map((row) =>
      `insert into threads(id,cwd,updated_at_ms,archived) values(` +
      `'${row.id}','${row.cwd}',${row.updatedAtMs},0);`
    ),
    "pragma wal_checkpoint(TRUNCATE);"
  ];
  const created = spawnSync("sqlite3", [dbPath, statements.join(" ")], {
    encoding: "utf8"
  });
  assert.equal(created.status, 0, created.stderr);
}

function threadQueryResult() {
  return {
    columns: ["id", "cwd", "updated_at_ms", "archived"],
    rows: [{
      id: SESSION_ID,
      cwd: "/repo/project",
      updated_at_ms: 20,
      archived: 0
    }]
  };
}

function sqliteFailure(status: number, stage: string, message: string): Error {
  return Object.assign(new Error(message), { status, stage });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sqliteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function ok(stdout: string): CommandResult {
  return {
    status: 0,
    stdout,
    stderr: ""
  };
}

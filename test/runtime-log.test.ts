import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupRuntimeLogs,
  localDateStamp,
  localTimestamp,
  redactRecord,
  redactString,
  runtimeLogPath,
  writeRuntimeLog
} from "../src/runtime-log.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("runtime logs use local timestamps and preserve absolute paths", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-log-"));
  const now = new Date(2026, 5, 19, 18, 30, 45, 123);
  const absolutePath = path.join(tempDir, "workspace", "file.txt");

  try {
    const result = writeRuntimeLog({
      level: "info",
      event: "path_check",
      state_path: absolutePath
    }, {
      logDir: tempDir,
      now,
      retentionDays: 14
    });

    assert.equal(result.written, true);
    assert.equal(result.path, runtimeLogPath({ now, logDir: tempDir }));
    assert.match(localTimestamp(now), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
    assert.equal(path.basename(result.path), `runtime-${localDateStamp(now)}.ndjson`);

    const entry = JSON.parse(fs.readFileSync(result.path, "utf8").trim());
    assert.equal(entry.event, "path_check");
    assert.equal(entry.state_path, absolutePath);
    assert.equal(entry.ts, localTimestamp(now));
    assert.equal(entry.ts_utc, now.toISOString());
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime log redaction removes secrets but not ordinary paths", () => {
  const absolutePath = "/Users/example/projects/agent-knock-knock/state.json";
  const redacted = redactRecord({
    state_path: absolutePath,
    gatewayToken: "secret-token",
    nested: {
      authorization: "Bearer abc.def.ghi",
      callback_command: "agent-knock-knock callback --token sk-abcdefghijklmnopqrstuvwxyz --state /tmp/state.json",
      proxy_url: "socks5h://user:pass@127.0.0.1:1082"
    }
  }) as {
    state_path: string;
    gatewayToken: string;
    nested: {
      authorization: string;
      callback_command: string;
      proxy_url: string;
    };
  };

  assert.equal(redacted.state_path, absolutePath);
  assert.equal(redacted.gatewayToken, "[REDACTED]");
  assert.equal(redacted.nested.authorization, "[REDACTED]");
  assert.match(redacted.nested.callback_command, /--token \[REDACTED\]/);
  assert.doesNotMatch(redacted.nested.callback_command, /sk-abcdefghijklmnopqrstuvwxyz/);
  assert.equal(redacted.nested.proxy_url, "[REDACTED]");

  assert.equal(
    redactString("Authorization: Bearer abcdef and url socks5h://user:pass@127.0.0.1:1082"),
    "Authorization: Bearer [REDACTED] and url socks5h://[REDACTED]@127.0.0.1:1082"
  );
});

test("runtime log cleanup removes old daily files", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-cleanup-"));

  try {
    fs.writeFileSync(path.join(tempDir, "runtime-2026-06-01.ndjson"), "{}\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "runtime-2026-06-18.ndjson"), "{}\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "notes.txt"), "keep\n", "utf8");

    const result = cleanupRuntimeLogs({
      logDir: tempDir,
      retentionDays: 14,
      now: new Date(2026, 5, 20, 12, 0, 0, 0)
    });

    assert.equal(result.checked, 2);
    assert.equal(result.deleted, 1);
    assert.equal(fs.existsSync(path.join(tempDir, "runtime-2026-06-01.ndjson")), false);
    assert.equal(fs.existsSync(path.join(tempDir, "runtime-2026-06-18.ndjson")), true);
    assert.equal(fs.existsSync(path.join(tempDir, "notes.txt")), true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("runtime log level can suppress lower-severity entries", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-level-"));

  try {
    const info = writeRuntimeLog({
      level: "info",
      event: "suppressed"
    }, {
      logDir: tempDir,
      level: "warn"
    });
    const warn = writeRuntimeLog({
      level: "warn",
      event: "written"
    }, {
      logDir: tempDir,
      level: "warn"
    });

    assert.equal(info.written, false);
    assert.equal(warn.written, true);
    assert.ok(warn.path);
    const lines = fs.readFileSync(warn.path, "utf8").trim().split(/\r?\n/);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).event, "written");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI writes runtime logs without leaking full request secrets", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-runtime-cli-"));
  const storeDir = path.join(tempDir, "conversations");
  const logDir = path.join(tempDir, "runtime");
  const request = "Investigate issue with token sk-abcdefghijklmnopqrstuvwxyz in a callback command.";

  try {
    const result = spawnSync(process.execPath, [
      binPath,
      "new",
      "--agent",
      "codex",
      "--session",
      "codex-runtime",
      "--request",
      request,
      "--store-dir",
      storeDir
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        AKK_LOG_DIR: logDir
      }
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = JSON.parse(result.stdout);
    const logFile = fs.readdirSync(logDir).find((file) => /^runtime-\d{4}-\d{2}-\d{2}\.ndjson$/.test(file));
    assert.ok(logFile);

    const text = fs.readFileSync(path.join(logDir, logFile), "utf8");
    assert.doesNotMatch(text, /sk-abcdefghijklmnopqrstuvwxyz/);
    const events = text.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(events.some((event) => event.event === "cli_start" && event.command === "new"), true);
    assert.equal(events.some((event) =>
      event.event === "conversation_created" &&
      event.conversation_id === parsed.conversation.conversation_id &&
      event.request.preview.includes("sk-[REDACTED]")
    ), true);
    assert.equal(events.at(-1).event, "cli_finish");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

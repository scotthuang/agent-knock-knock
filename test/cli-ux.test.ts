import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createConversation } from "../src/protocol.js";
import {
  appendEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const packageRoot = path.resolve(path.dirname(binPath), "../..");

test("global help exits successfully", () => {
  for (const argument of ["--help", "-h", "help"]) {
    const result = runCliRaw([argument]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage:/);
    assert.match(result.stdout, /agent-knock-knock --version/);
  }
});

test("global version prints the package version and exits successfully", () => {
  const expectedVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
  ).version;

  for (const argument of ["--version", "-v", "version"]) {
    const result = runCliRaw([argument]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expectedVersion);
  }
});

test("doctor exits non-zero when required package files are missing", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-failure-"));
  const copiedDistDir = path.join(tempDir, "dist", "src");

  try {
    fs.mkdirSync(path.dirname(copiedDistDir), { recursive: true });
    fs.cpSync(path.dirname(binPath), copiedDistDir, { recursive: true });
    const result = spawnSync(
      process.execPath,
      [
        path.join(copiedDistDir, "cli.js"),
        "doctor",
        "--openclaw-bin",
        path.join(tempDir, "missing-openclaw"),
        "--timeout-ms",
        "100"
      ],
      { encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.package_files.some((entry) => entry.exists === false), true);
    const nodeCheck = output.checks.find((entry) => entry.command === "node");
    assert.equal(nodeCheck.version, process.versions.node);
    assert.equal(nodeCheck.minimum_version, "22.19.0");
    assert.equal(nodeCheck.version_supported, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("doctor rejects an OpenClaw binary that exists but cannot run", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-doctor-runtime-"));
  const fakeOpenClaw = path.join(tempDir, "openclaw");

  try {
    fs.writeFileSync(
      fakeOpenClaw,
      `#!/bin/sh
printf '%s' 'unsupported Node runtime' >&2
exit 9
`,
      "utf8"
    );
    fs.chmodSync(fakeOpenClaw, 0o755);
    const result = runCliRaw([
      "doctor",
      "--openclaw-bin",
      fakeOpenClaw,
      "--timeout-ms",
      "10000"
    ]);
    const output = JSON.parse(result.stdout);
    const openclaw = output.checks.find((entry) => entry.command === "openclaw");

    assert.equal(result.status, 1);
    assert.equal(output.ok, false);
    assert.equal(openclaw.status, "version_failed");
    assert.equal(openclaw.available, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI output redacts legacy Gateway credentials", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cli-redaction-"));
  const storeDir = path.join(tempDir, "conversations");
  const gatewayToken = "gateway-token-that-must-not-reach-stdout";

  try {
    const stored = storeConversationFixture(storeDir, "redaction test");
    const statePath = stored.paths.statePath;
    const state = {
      ...stored.conversation,
      gateway_token: gatewayToken,
      callback_command:
        `agent-knock-knock callback --token ${gatewayToken} --state ${statePath}`,
      native_session_takeover: {
        claude_home: "/private/.claude",
        claude_transcript_anchor: {
          relative_path: "-private-workspace/private-session.jsonl",
          cwd: "/private/workspace",
          pid: 4242,
          inode: "private-inode"
        }
      }
    };
    saveState(statePath, state);

    const status = runCliRaw([
      "status",
      "--conversation",
      state.conversation_id,
      "--store-dir",
      storeDir
    ]);
    assert.equal(status.status, 0, status.stderr);
    assert.doesNotMatch(status.stdout, new RegExp(gatewayToken));
    const output = JSON.parse(status.stdout);
    assert.equal(Object.hasOwn(output.conversation, "gateway_token"), false);
    assert.match(output.conversation.callback_command, /--token \[REDACTED\]/u);
    assert.equal(
      Object.hasOwn(
        output.conversation.native_session_takeover,
        "claude_transcript_anchor"
      ),
      false
    );
    assert.equal(
      Object.hasOwn(output.conversation.native_session_takeover, "claude_home"),
      false
    );
    assert.doesNotMatch(
      status.stdout,
      /private-session|private-inode|private\/\.claude/u
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function storeConversationFixture(storeDir: string, request: string) {
  const conversation = createConversation({
    userRequest: request,
    executorKind: "claude",
    executorSession: "claude-redaction",
    now: new Date("2026-07-28T00:00:00.000Z")
  });
  const paths = pathsForConversation(conversation.conversation_id, storeDir);
  const storedConversation = {
    ...conversation,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
  saveState(paths.statePath, storedConversation);
  appendEvent(paths.logPath, {
    ts: storedConversation.created_at,
    conversation_id: storedConversation.conversation_id,
    event: "conversation_created",
    conversation: storedConversation
  });
  return { conversation: storedConversation, paths };
}

function runCliRaw(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8"
  });
}

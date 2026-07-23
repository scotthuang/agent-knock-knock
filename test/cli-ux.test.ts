import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
      [path.join(copiedDistDir, "cli.js"), "doctor"],
      { encoding: "utf8" }
    );

    assert.notEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, false);
    assert.equal(output.package_files.some((entry) => entry.exists === false), true);
    const nodeCheck = output.checks.find((entry) => entry.command === "node");
    assert.equal(nodeCheck.version, process.versions.node);
    assert.equal(nodeCheck.minimum_version, "22.14.0");
    assert.equal(nodeCheck.version_supported, true);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("CLI output redacts legacy Gateway credentials", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-cli-redaction-"));
  const storeDir = path.join(tempDir, "conversations");
  const gatewayToken = "gateway-token-that-must-not-reach-stdout";

  try {
    const created = runCliRaw([
      "new",
      "--request",
      "redaction test",
      "--store-dir",
      storeDir
    ]);
    assert.equal(created.status, 0, created.stderr);
    const createdOutput = JSON.parse(created.stdout);
    const statePath = createdOutput.paths.statePath;
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, `${JSON.stringify({
      ...state,
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
    }, null, 2)}\n`);

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

function runCliRaw(args: string[]) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8"
  });
}

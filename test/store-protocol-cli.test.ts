import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMessageToConversation,
  createConversation,
  createMessage
} from "../src/protocol.js";
import {
  appendEvent,
  messageEvent,
  pathsForConversation,
  saveState,
  STORE_WRITER_PROTOCOL,
  storeManifestPath
} from "../src/store.js";
import {
  MutableRecordingTerminalProvider,
  MutableTerminalProcessSource,
  runInProcessCli,
  terminalCliDependencies
} from "./in-process-cli-fixtures.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;

test("standalone list and status leave persisted conversation files and runtime untouched", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-protocol-read-"));
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime-must-not-exist");

  try {
    const fixture = storeConversationFixture(storeDir);
    setDetectableReadOnlyMetadata(fixture.paths.statePath, 0o640);
    setDetectableReadOnlyMetadata(fixture.paths.logPath, 0o604);
    const before = conversationFileSnapshots(fixture.paths);

    const listed = runCli([
      "list",
      "--managed-only",
      "--store-dir",
      storeDir
    ], { runtimeDir });
    assert.equal(listed.reconciliation.status, "disabled");
    assert.equal(listed.unavailable_managed_turns.length, 1);

    const status = runCli([
      "status",
      "--conversation",
      fixture.conversation.conversation_id,
      "--managed-only",
      "--store-dir",
      storeDir
    ], { runtimeDir });
    assert.equal(status.reconciliation.status, "disabled");
    assert.equal(
      status.conversation.conversation_id,
      fixture.conversation.conversation_id
    );

    assert.deepEqual(conversationFileSnapshots(fixture.paths), before);
    assert.equal(
      fs.existsSync(runtimeDir),
      false,
      "read-only CLI commands must not create terminal runtime state"
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("list --reconcile remains readable and skips writes for a newer writer protocol", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-protocol-reconcile-"));
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime-must-not-exist");

  try {
    const fixture = storeConversationFixture(storeDir);
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.writer_protocol = STORE_WRITER_PROTOCOL + 1;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    setDetectableReadOnlyMetadata(manifestPath, 0o640);
    setDetectableReadOnlyMetadata(fixture.paths.statePath, 0o640);
    setDetectableReadOnlyMetadata(fixture.paths.logPath, 0o604);
    const before = {
      manifest: fileSnapshot(manifestPath),
      ...conversationFileSnapshots(fixture.paths),
      storeEntries: fs.readdirSync(storeDir).sort()
    };

    const listed = runCli([
      "list",
      "--reconcile",
      "--managed-only",
      "--all",
      "--store-dir",
      storeDir
    ], { runtimeDir });

    assert.equal(listed.store.status, "incompatible");
    assert.equal(listed.store.readable, true);
    assert.equal(listed.store.writable, false);
    assert.equal(listed.reconciliation.status, "skipped");
    assert.match(listed.reconciliation.reason, /writer protocol/iu);
    assert.equal(listed.unavailable_managed_turns.length, 1);
    const listedTurn = listed.unavailable_managed_turns[0];
    assert.deepEqual(
      Object.keys(listedTurn.available_actions),
      ["status"]
    );
    const mutationSelector = spawnCli([
      "respond",
      "--turn",
      listedTurn.short_ref,
      "--message",
      "must remain read-only",
      "--managed-only",
      "--store-dir",
      storeDir,
      "--processes-json",
      "[]",
      "--terminals-json",
      "[]",
      "--terminal-screens-json",
      "{}"
    ], { runtimeDir });
    assert.notEqual(mutationSelector.status, 0);
    assert.match(mutationSelector.stderr, /not actionable for respond/iu);
    assert.deepEqual({
      manifest: fileSnapshot(manifestPath),
      ...conversationFileSnapshots(fixture.paths),
      storeEntries: fs.readdirSync(storeDir).sort()
    }, before);
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
    assert.equal(fs.existsSync(runtimeDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("managed respond fails closed on writer protocol mismatch before invoking tmux", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-store-protocol-send-"));
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime-must-not-exist");
  const fakeBinDir = path.join(tempDir, "bin");
  const tmuxCallsPath = path.join(tempDir, "tmux-calls.ndjson");

  try {
    const fixture = storeConversationFixture(storeDir);
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.writer_protocol = STORE_WRITER_PROTOCOL + 1;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const before = conversationFileSnapshots(fixture.paths);

    fs.mkdirSync(fakeBinDir, { recursive: true });
    const fakeTmuxPath = path.join(fakeBinDir, "tmux");
    fs.writeFileSync(
      fakeTmuxPath,
      `#!${process.execPath}\n` +
        'require("node:fs").appendFileSync(process.env.AKK_TMUX_CALLS, JSON.stringify(process.argv.slice(2)) + "\\n");\n',
      "utf8"
    );
    fs.chmodSync(fakeTmuxPath, 0o755);

    const result = spawnCli([
      "respond",
      "--turn",
      fixture.conversation.turn_id,
      "--message",
      "this must not reach tmux",
      "--store-dir",
      storeDir
    ], {
      runtimeDir,
      env: {
        AKK_TMUX_CALLS: tmuxCallsPath,
        PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`
      }
    });

    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /writer protocol|refusing to mutate/iu);
    assert.equal(
      fs.existsSync(tmuxCallsPath),
      false,
      "writer preflight must fail before any tmux command is attempted"
    );
    assert.deepEqual(conversationFileSnapshots(fixture.paths), before);
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
    assert.equal(fs.existsSync(runtimeDir), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("explicit physical send bypasses a newer writer protocol without mutating Store", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-store-protocol-physical-send-")
  );
  const storeDir = path.join(tempDir, "store");
  const runtimeDir = path.join(tempDir, "runtime");
  const workspace = path.join(tempDir, "workspace");
  const terminalTarget = "protocol-test:0.0";
  const terminalId =
    `terminal:v2:tmux:codex:${terminalTarget}:4242`;
  const message = "deliver despite the incompatible AKK Store";

  try {
    const fixture = storeConversationFixture(storeDir);
    const manifestPath = storeManifestPath(storeDir);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.writer_protocol = STORE_WRITER_PROTOCOL + 1;
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    const before = {
      manifest: fileSnapshot(manifestPath),
      ...conversationFileSnapshots(fixture.paths)
    };

    fs.mkdirSync(workspace, { recursive: true });
    let pendingText = "";
    const terminalProvider = new MutableRecordingTerminalProvider({
      panes: [{
        kind: "tmux",
        target: terminalTarget,
        session: "protocol-test",
        window: 0,
        pane: 0,
        panePid: 9001,
        currentCommand: "codex",
        currentPath: workspace
      }],
      screens: { [terminalTarget]: "Ready\n› " },
      hooks: {
        sendText(operation, provider) {
          pendingText = operation.text;
          provider.setScreen(
            terminalTarget,
            `Ready\n› ${operation.text}\n\ngpt-5.6-sol high · /repo`
          );
        },
        sendKeys(operation, provider) {
          if (operation.keys.includes("C-m")) {
            pendingText = "";
            provider.setScreen(terminalTarget, "Working\n");
          }
        }
      }
    });
    const processSource = new MutableTerminalProcessSource([{
      pid: 4242,
      ppid: 9001,
      elapsed: "00:20",
      command: "codex",
      cwd: workspace
    }]);
    const dependencies = terminalCliDependencies({
      terminalProvider,
      processSource,
      env: {
        ...process.env,
        AKK_LOG_LEVEL: "silent",
        AKK_RUNTIME_DIR: runtimeDir,
        TMUX: ""
      },
      overrides: {
        agentVersionForRunningProcess: () => "0.149.1",
        codexProcessBirthForPid: () => "fixture-process-birth"
      }
    });
    const listed = await runInProcessCli([
      "list",
      "--store-dir",
      storeDir
    ], dependencies);
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const terminal = JSON.parse(listed.stdout).terminals.find(
      (entry: Record<string, unknown>) => entry.id === terminalId
    );
    assert.ok(terminal, listed.stdout);
    assert.equal(
      terminal.available_actions.send.scope,
      "terminal_user_explicit"
    );
    const expectedTerminalToken =
      terminal.available_actions.send.arguments.expected_terminal_token;
    assert.equal(typeof expectedTerminalToken, "string");
    terminalProvider.clearOperations();

    const result = await runInProcessCli([
      "send",
      "--conversation",
      terminalId,
      "--expected-terminal-token",
      expectedTerminalToken,
      "--message",
      message,
      "--message-id",
      "store-protocol-explicit-send",
      "--background",
      "--store-dir",
      storeDir,
      "--disable-terminal-bridge-monitor"
    ], dependencies);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const output = JSON.parse(result.stdout);
    assert.equal(output.delivered, true);
    assert.equal(output.delivered_unmanaged, true);
    assert.equal(output.management_mode, "unmanaged_fallback");
    assert.equal(output.scope, "terminal_user_explicit");
    assert.equal(pendingText, "");
    assert.deepEqual(terminalProvider.literalInputs(), [message]);
    assert.deepEqual(terminalProvider.keyDispatches(), [["C-m"]]);
    assert.deepEqual({
      manifest: fileSnapshot(manifestPath),
      ...conversationFileSnapshots(fixture.paths)
    }, before);
    assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function storeConversationFixture(storeDir: string) {
  const now = new Date("2026-08-01T00:00:00.000Z");
  const base = createConversation({
    userRequest: "Exercise store protocol boundaries",
    workspace: path.dirname(storeDir),
    executorKind: "codex",
    executorSession: "codex-store-protocol",
    now
  });
  const message = createMessage({
    conversation: base,
    from: "openclaw",
    to: base.executor.actor,
    type: "task",
    body: base.user_request,
    now
  });
  const paths = pathsForConversation(base.conversation_id, storeDir);
  const conversation = {
    ...applyMessageToConversation(base, message, now),
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };

  saveState(paths.statePath, conversation);
  appendEvent(paths.logPath, {
    ts: now.toISOString(),
    conversation_id: conversation.conversation_id,
    event: "conversation_created",
    conversation
  });
  appendEvent(paths.logPath, messageEvent(message));
  return { conversation, paths };
}

function setDetectableReadOnlyMetadata(filePath: string, mode: number): void {
  if (process.platform !== "win32") {
    fs.chmodSync(filePath, mode);
  }
  const oldTimestamp = new Date("2020-01-02T03:04:05.000Z");
  fs.utimesSync(filePath, oldTimestamp, oldTimestamp);
}

function conversationFileSnapshots(paths: {
  statePath: string;
  logPath: string;
}) {
  return {
    state: fileSnapshot(paths.statePath),
    events: fileSnapshot(paths.logPath)
  };
}

function fileSnapshot(filePath: string) {
  const stat = fs.statSync(filePath);
  return {
    contents: fs.readFileSync(filePath, "utf8"),
    mtimeMs: stat.mtimeMs,
    mode: process.platform === "win32" ? undefined : stat.mode & 0o777
  };
}

function runCli(
  args: string[],
  options: { runtimeDir: string; env?: NodeJS.ProcessEnv }
): Record<string, any> {
  const result = spawnCli(args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function spawnCli(
  args: string[],
  options: { runtimeDir: string; env?: NodeJS.ProcessEnv }
) {
  return spawnSync(process.execPath, [binPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      AKK_LOG_LEVEL: "silent",
      AKK_RUNTIME_DIR: options.runtimeDir,
      ...options.env
    }
  });
}

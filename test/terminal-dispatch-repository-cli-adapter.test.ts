import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createTerminalDispatchRepositoryCliAdapter
} from "../src/terminal-dispatch-repository-cli-adapter.js";
import {
  createTerminalEndpointRef,
  terminalRuntimeResourceKey,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";

const NOW = new Date("2026-08-15T04:05:06.000Z");

function tmuxControl(): TerminalControlRef {
  return {
    kind: "tmux",
    target: "akk:0.1",
    socketPath: "/private/tmp/tmux-501/default",
    session: "akk",
    window: 0,
    pane: 1,
    panePid: 4200,
    currentPath: "/repo/project",
    capabilities: ["send_keys", "screen_status"]
  };
}

function associateCanonicalEndpoint(control: TerminalControlRef): void {
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey: "socket:/private/tmp/tmux-501/default",
      resourceKey: "pane-id:%42"
    },
    route: {
      routeKey: "tmux-route:akk:0.1",
      label: control.target,
      currentPath: control.currentPath
    },
    processAnchorPid: control.panePid,
    capabilities: control.capabilities,
    providerRef: control
  });
}

function ledgerPath(runtimeDir: string, key: string): string {
  return path.join(
    runtimeDir,
    "terminal-dispatch",
    `terminal-dispatch-${key}.json`
  );
}

function lockPath(runtimeDir: string, key: string): string {
  return path.join(
    runtimeDir,
    "terminal-locks",
    `terminal-bridge-send-${key}.lock`
  );
}

test("repository promotes legacy ownership and preserves exact private JSON bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-repository-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();
  const legacyKey = terminalRuntimeResourceKey(control, { legacy: true });

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(control, {
      status: "agent_accepted",
      conversation_id: "conversation-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      request_hash: "request-1",
      agent_accepted_at: "2026-08-15T04:00:00.000Z"
    });
    const legacyPath = ledgerPath(runtimeDir, legacyKey);
    assert.equal(fs.existsSync(legacyPath), true);
    assert.equal(repository.load(control)?.version, 1);
    const acceptedBytes = fs.readFileSync(legacyPath);
    assert.equal(repository.resolve(control, {
      conversation: { conversation_id: "conversation-1" },
      expectedMessageId: "another-message",
      reason: "must not settle"
    }), false);
    assert.deepEqual(fs.readFileSync(legacyPath), acceptedBytes);

    associateCanonicalEndpoint(control);
    const canonicalKey = repository.runtimeKey(control);
    const canonicalPath = ledgerPath(runtimeDir, canonicalKey);
    assert.notEqual(canonicalPath, legacyPath);
    repository.save(control, {
      status: "resolved",
      conversation_id: "conversation-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: "message-1",
      request_hash: "request-1",
      agent_accepted_at: "2026-08-15T04:00:00.000Z",
      resolved_at: NOW.toISOString(),
      reason: "test settlement"
    });

    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(fs.existsSync(canonicalPath), true);
    assert.equal(fs.statSync(canonicalPath).mode & 0o777, 0o600);
    const raw = fs.readFileSync(canonicalPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(raw, `${JSON.stringify(parsed, null, 2)}\n`);
    assert.equal(parsed.version, 2);
    assert.deepEqual(
      (parsed.terminal_submission_receipts as Array<Record<string, unknown>>)
        .map((receipt) => [receipt.message_id, receipt.status]),
      [["message-1", "agent_accepted"]]
    );
    assert.deepEqual(
      fs.readdirSync(path.dirname(canonicalPath)).sort(),
      [path.basename(canonicalPath)]
    );
    fs.copyFileSync(canonicalPath, legacyPath);
    assert.throws(
      () => repository.load(control),
      /conflicting canonical and legacy owners/u
    );
    fs.unlinkSync(legacyPath);
  });
});

test("repository rejects dangling symlink owners without replacing their targets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-symlink-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();
  associateCanonicalEndpoint(control);

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    const filePath = ledgerPath(runtimeDir, repository.runtimeKey(control));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const missingTarget = path.join(root, "must-remain-missing");
    fs.symlinkSync(missingTarget, filePath);

    assert.throws(
      () => repository.load(control),
      /not a regular file/u
    );
    assert.throws(
      () => repository.save(control, { status: "prepared" }),
      /not a regular file/u
    );
    assert.equal(fs.lstatSync(filePath).isSymbolicLink(), true);
    assert.equal(fs.existsSync(missingTarget), false);
  });
});

test("repository acquires canonical and legacy locks lexically and releases idempotently", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-locks-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();
  associateCanonicalEndpoint(control);

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    pid: process.pid,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    const paths = [
      lockPath(runtimeDir, repository.runtimeKey(control)),
      lockPath(runtimeDir, terminalRuntimeResourceKey(control, { legacy: true }))
    ].sort();
    assert.equal(new Set(paths).size, 2);

    const release = repository.acquire("/unused/store", control, {
      timeoutMs: 0,
      retryMs: 0
    });
    assert.deepEqual(
      fs.readdirSync(path.dirname(paths[0])).sort(),
      paths.map((candidate) => path.basename(candidate)).sort()
    );
    for (const candidate of paths) {
      assert.equal(fs.statSync(candidate).mode & 0o777, 0o600);
      assert.equal(
        (JSON.parse(fs.readFileSync(candidate, "utf8")) as { pid: number }).pid,
        process.pid
      );
    }
    release();
    release();
    assert.deepEqual(fs.readdirSync(path.dirname(paths[0])), []);
  });
});

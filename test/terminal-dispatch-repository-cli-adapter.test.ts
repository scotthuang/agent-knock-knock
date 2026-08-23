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
  tmuxTerminalRouteKey,
  terminalRuntimeResourceKey,
  type TerminalControlRef,
  type TmuxTerminalControlRef
} from "../src/terminal-control-ref.js";

const NOW = new Date("2026-08-15T04:05:06.000Z");

function tmuxControl(): TmuxTerminalControlRef {
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

function associateCanonicalEndpoint(
  control: TerminalControlRef,
  resourceKey = "pane-id:%42"
): void {
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey: "socket:/private/tmp/tmux-501/default",
      resourceKey
    },
    route: {
      routeKey: tmuxTerminalRouteKey(
        "socket:/private/tmp/tmux-501/default",
        control.target,
        control.socketPath
      ),
      label: control.target,
      currentPath: control.currentPath
    },
    processAnchorPid: control.panePid,
    capabilities: control.capabilities,
    providerRef: control
  });
}

function acceptedLedger(messageId: string): Record<string, unknown> {
  return {
    status: "agent_accepted",
    conversation_id: `conversation-${messageId}`,
    session_id: `session-${messageId}`,
    turn_id: `turn-${messageId}`,
    message_id: messageId,
    request_hash: `request-${messageId}`,
    agent_accepted_at: "2026-08-15T04:00:00.000Z"
  };
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

    const receiptBeforeResolve = JSON.stringify(
      (repository.load(control)?.terminal_submission_receipts as
        Array<Record<string, unknown>>)[0]
    );
    assert.equal(repository.resolve(control, {
      conversation: { conversation_id: "conversation-1" },
      expectedMessageId: "message-1",
      reason: "conversation explicitly closed by request"
    }), true);
    const resolved = repository.load(control)!;
    assert.equal(resolved.status, "resolved");
    assert.equal(resolved.resolved_at, NOW.toISOString());
    assert.equal(
      JSON.stringify(
        (resolved.terminal_submission_receipts as
          Array<Record<string, unknown>>)[0]
      ),
      receiptBeforeResolve
    );

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

test("repository leaves a different-incarnation legacy owner as history and writes the current canonical owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-stale-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();
  const oldControl = { ...control, panePid: control.panePid - 1 };

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(oldControl, acceptedLedger("old-message"));
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(control, { legacy: true })
    );
    const legacyBytes = fs.readFileSync(legacyPath);

    associateCanonicalEndpoint(control);
    const canonicalPath = ledgerPath(runtimeDir, repository.runtimeKey(control));
    assert.equal(repository.load(control), undefined);
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
    assert.equal(fs.existsSync(canonicalPath), false);

    repository.save(control, acceptedLedger("current-message"));
    assert.equal(fs.existsSync(legacyPath), true);
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
    assert.equal(fs.existsSync(canonicalPath), true);
    assert.equal(repository.load(control)?.message_id, "current-message");
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);

    repository.save(control, {
      ...acceptedLedger("current-message"),
      status: "resolved",
      resolved_at: NOW.toISOString(),
      reason: "current settlement"
    });
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
    assert.equal(repository.load(control)?.status, "resolved");
  });
});

test("repository promotes the current legacy owner over a stale canonical owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-current-legacy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const staleControl = { ...tmuxControl(), panePid: 4100 };
  associateCanonicalEndpoint(staleControl);

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(staleControl, acceptedLedger("stale-canonical"));
    const canonicalPath = ledgerPath(
      runtimeDir,
      repository.runtimeKey(staleControl)
    );
    const staleCanonicalBytes = fs.readFileSync(canonicalPath);

    const currentControl = tmuxControl();
    repository.save(currentControl, acceptedLedger("current-legacy"));
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(currentControl, { legacy: true })
    );
    assert.equal(fs.existsSync(legacyPath), true);

    associateCanonicalEndpoint(currentControl);
    assert.equal(repository.load(currentControl)?.message_id, "current-legacy");
    repository.save(currentControl, {
      ...acceptedLedger("current-legacy"),
      status: "resolved",
      resolved_at: NOW.toISOString(),
      reason: "promote current legacy owner"
    });

    assert.equal(fs.existsSync(legacyPath), false);
    assert.equal(repository.load(currentControl)?.message_id, "current-legacy");
    assert.equal(repository.load(currentControl)?.version, 2);
    assert.notDeepEqual(fs.readFileSync(canonicalPath), staleCanonicalBytes);
  });
});

test("repository recovers a rename-before-v2 crash after the tmux route is reindexed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-crash-image-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const originalControl = tmuxControl();

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(originalControl, acceptedLedger("crash-message"));
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(originalControl, { legacy: true })
    );
    const legacyBytes = fs.readFileSync(legacyPath);

    associateCanonicalEndpoint(originalControl);
    const canonicalPath = ledgerPath(
      runtimeDir,
      repository.runtimeKey(originalControl)
    );
    // Reproduce the old save() crash window exactly: legacy v1 has reached the
    // stable filename, but the atomic canonical-v2 rewrite has not happened.
    fs.renameSync(legacyPath, canonicalPath);

    const reindexedControl: TerminalControlRef = {
      ...originalControl,
      target: "akk:0.7",
      pane: 7
    };
    associateCanonicalEndpoint(reindexedControl);
    assert.equal(
      repository.runtimeKey(reindexedControl),
      repository.runtimeKey(originalControl)
    );

    const recovered = repository.load(reindexedControl);
    assert.equal(recovered?.version, 2);
    assert.equal(recovered?.message_id, "crash-message");
    assert.equal(
      (recovered?.terminal_control as Record<string, unknown>).target,
      originalControl.target
    );
    assert.equal(repository.matchesControl(recovered, reindexedControl), true);
    assert.equal(
      repository.reconcileIncarnation(reindexedControl, recovered)?.status,
      "agent_accepted"
    );
    // Recovery is a read-only projection; the next ordinary mutation performs
    // the durable v2 repair.
    assert.deepEqual(fs.readFileSync(canonicalPath), legacyBytes);

    assert.equal(repository.resolve(reindexedControl, {
      conversation: { conversation_id: "conversation-crash-message" },
      expectedMessageId: "crash-message",
      reason: "repair interrupted migration"
    }), true);
    const persisted = JSON.parse(
      fs.readFileSync(canonicalPath, "utf8")
    ) as Record<string, unknown>;
    assert.equal(persisted.version, 2);
    assert.equal(
      (persisted.terminal_control as Record<string, unknown>).target,
      reindexedControl.target
    );
    assert.deepEqual(
      (persisted.terminal_submission_receipts as Array<Record<string, unknown>>)
        .map((receipt) => [receipt.message_id, receipt.status]),
      [["crash-message", "agent_accepted"]]
    );
    assert.equal(
      (
        (persisted.terminal_submission_receipts as Array<Record<string, unknown>>)[0]
          ?.terminal_control as Record<string, unknown>
      ).target,
      originalControl.target
    );
    assert.equal(repository.matchesControl(
      repository.load(reindexedControl),
      reindexedControl
    ), true);
  });
});

test("repository fails closed for v1 artifacts outside the exact interrupted migration proof", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-crash-negative-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const originalControl = tmuxControl();

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(originalControl, acceptedLedger("negative-message"));
    const originalLegacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(originalControl, { legacy: true })
    );
    const v1 = JSON.parse(fs.readFileSync(originalLegacyPath, "utf8")) as {
      terminal_key: string;
      terminal_control: Record<string, unknown>;
      [key: string]: unknown;
    };
    associateCanonicalEndpoint(originalControl);
    const canonicalPath = ledgerPath(
      runtimeDir,
      repository.runtimeKey(originalControl)
    );
    fs.unlinkSync(originalLegacyPath);

    const assertCanonicalRejected = (
      mutate: (document: typeof v1) => void
    ): void => {
      const document = structuredClone(v1);
      mutate(document);
      fs.writeFileSync(
        canonicalPath,
        `${JSON.stringify(document, null, 2)}\n`,
        { mode: 0o600 }
      );
      assert.throws(
        () => repository.load(originalControl),
        /terminal dispatch ledger is invalid/u
      );
    };

    assertCanonicalRejected((document) => {
      document.terminal_control.pane_pid = originalControl.panePid + 1;
    });
    assertCanonicalRejected((document) => {
      document.terminal_control.pane_pid = String(originalControl.panePid);
    });
    assertCanonicalRejected((document) => {
      document.terminal_control.kind = "herdr";
    });
    assertCanonicalRejected((document) => {
      const otherSocket = "/private/tmp/tmux-501/other";
      document.terminal_control.socket_path = otherSocket;
      document.terminal_key = terminalRuntimeResourceKey({
        ...originalControl,
        socketPath: otherSocket
      }, { legacy: true });
    });
    assertCanonicalRejected((document) => {
      document.terminal_key = "not-the-document-self-key";
    });

    fs.unlinkSync(canonicalPath);
    const reindexedControl: TerminalControlRef = {
      ...originalControl,
      target: "akk:0.8",
      pane: 8
    };
    associateCanonicalEndpoint(reindexedControl);
    const currentLegacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(reindexedControl, { legacy: true })
    );
    fs.writeFileSync(currentLegacyPath, `${JSON.stringify(v1, null, 2)}\n`, {
      mode: 0o600
    });
    assert.throws(
      () => repository.load(reindexedControl),
      /terminal dispatch ledger is invalid/u
    );
  });
});

test("repository rejects dual owners from the same process incarnation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-same-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(control, acceptedLedger("same-anchor"));
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(control, { legacy: true })
    );
    const legacyBytes = fs.readFileSync(legacyPath);

    associateCanonicalEndpoint(control);
    repository.save(control, {
      ...acceptedLedger("same-anchor"),
      status: "resolved",
      resolved_at: NOW.toISOString(),
      reason: "promote current owner"
    });
    fs.writeFileSync(legacyPath, legacyBytes, { mode: 0o600 });

    assert.throws(
      () => repository.load(control),
      /conflicting canonical and legacy owners/u
    );
  });
});

test("repository rejects dual owners when legacy process evidence is incomplete", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-unknown-anchor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const control = tmuxControl();

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(control, acceptedLedger("unknown-anchor"));
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(control, { legacy: true })
    );
    const legacy = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as {
      terminal_control: Record<string, unknown>;
    };

    associateCanonicalEndpoint(control);
    repository.save(control, {
      ...acceptedLedger("unknown-anchor"),
      status: "resolved",
      resolved_at: NOW.toISOString(),
      reason: "promote current owner"
    });
    legacy.terminal_control.pane_pid = null;
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, {
      mode: 0o600
    });

    assert.throws(
      () => repository.load(control),
      /conflicting canonical and legacy owners/u
    );
  });
});

test("repository preserves distinct stale canonical and legacy histories without selecting an owner", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-dispatch-stale-dual-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeDir = path.join(root, "runtime");
  const oldControl = { ...tmuxControl(), panePid: 4100 };
  associateCanonicalEndpoint(oldControl);

  await runCliCommandExecution("repository-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    repository.save(oldControl, acceptedLedger("old-canonical"));
    const canonicalPath = ledgerPath(runtimeDir, repository.runtimeKey(oldControl));

    const currentControl = tmuxControl();
    associateCanonicalEndpoint(currentControl);
    assert.equal(
      ledgerPath(runtimeDir, repository.runtimeKey(currentControl)),
      canonicalPath
    );
    const legacyPath = ledgerPath(
      runtimeDir,
      terminalRuntimeResourceKey(currentControl, { legacy: true })
    );
    const legacyDocument = {
      ...acceptedLedger("old-legacy"),
      version: 1,
      terminal_key: terminalRuntimeResourceKey(currentControl, { legacy: true }),
      terminal_control: {
        kind: "tmux",
        target: currentControl.target,
        socket_path: currentControl.socketPath ?? null,
        pane_pid: oldControl.panePid,
        current_path: currentControl.currentPath ?? null
      }
    };
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacyDocument, null, 2)}\n`, {
      mode: 0o600
    });

    assert.throws(
      () => repository.load(currentControl),
      /conflicting canonical and legacy owners/u
    );
    legacyDocument.terminal_control.pane_pid = oldControl.panePid - 1;
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacyDocument, null, 2)}\n`, {
      mode: 0o600
    });
    const canonicalBytes = fs.readFileSync(canonicalPath);
    const legacyBytes = fs.readFileSync(legacyPath);

    assert.equal(repository.load(currentControl), undefined);
    assert.deepEqual(fs.readFileSync(canonicalPath), canonicalBytes);
    assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes);
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

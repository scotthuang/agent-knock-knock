import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import {
  listManagedSessions,
  saveManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const NATIVE_THREAD_ID = "44444444-4444-4444-8444-444444444444";

test("raw pane-B attach cannot duplicate a native thread actively owned by pane A", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: true });
  try {
    persistOwnerSession(fixture, "bound");
    const sent = fixture.send("pane-b must not receive this task");
    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(
      String(sent.stderr),
      /already active in another codex process|already claimed by managed Session/u
    );
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("an unrelated-workspace virgin Codex process does not block exact ownership", () => {
  const fixture = createOwnershipFixture({
    includeOwnerProcess: false,
    unknownProcessWorkspace: "different"
  });
  try {
    const sent = fixture.send("an unrelated virgin process is not an owner");
    assert.equal(sent.status, 0, String(sent.stderr || sent.stdout));
    assert.equal(JSON.parse(String(sent.stdout)).delivered, true);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("a same-workspace Codex process without exact identity blocks ownership", () => {
  const fixture = createOwnershipFixture({
    includeOwnerProcess: false,
    unknownProcessWorkspace: "same"
  });
  try {
    const sent = fixture.send("same-workspace unknown ownership must fail closed");
    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(String(sent.stderr), /ownership is unverifiable/u);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

for (const unknownProcessWorkspace of ["missing", "nonexistent"] as const) {
  test(`a Codex process with ${unknownProcessWorkspace} cwd fails ownership closed`, () => {
    const fixture = createOwnershipFixture({
      includeOwnerProcess: false,
      unknownProcessWorkspace
    });
    try {
      const sent = fixture.send(
        `${unknownProcessWorkspace} cwd cannot prove a different workspace`
      );
      assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
      assert.match(String(sent.stderr), /ownership is unverifiable/u);
      assert.equal(listManagedSessions(fixture.storeDir).length, 0);
      assert.equal(listConversations(fixture.storeDir).length, 0);
    } finally {
      fixture.cleanup();
    }
  });
}

test("an exact same-UUID owner is rejected even from another workspace", () => {
  const fixture = createOwnershipFixture({
    includeOwnerProcess: true,
    ownerProcessWorkspace: "different"
  });
  try {
    const sent = fixture.send("exact ownership remains global");
    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(String(sent.stderr), /already active in another codex process/u);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("ambiguous Claude rows retain every exact UUID as a global owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-native-owner-"));
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other-workspace");
  const currentPid = 75_001;
  const ownerPid = 75_002;
  const panePid = 75_101;
  const target = "claude-native-owner:0.0";
  const terminalId = `terminal:v2:tmux:claude:${target}:${currentPid}`;
  const otherNativeThreadId = "55555555-5555-4555-8555-555555555555";
  try {
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(otherWorkspace, { recursive: true });
    const sent = spawnSync(process.execPath, [
      binPath,
      "send",
      "--conversation",
      terminalId,
      "--message",
      "ambiguous rows must not hide an exact global owner",
      "--background",
      "--store-dir",
      storeDir,
      "--processes-json",
      JSON.stringify([{
        pid: currentPid,
        ppid: panePid,
        elapsed: "00:20",
        command: "claude",
        cwd: workspace
      }]),
      "--terminals-json",
      JSON.stringify([{
        kind: "tmux",
        target,
        session: "claude-native-owner",
        window: 0,
        pane: 0,
        panePid,
        currentCommand: "claude",
        currentPath: workspace,
        capabilities: [
          "screen_status",
          "send_keys",
          "terminal_approval",
          "screen_completion",
          "durable_completion",
          "terminal_cancel"
        ]
      }]),
      "--terminal-screens-json",
      JSON.stringify({ [target]: "Ready\n❯ " }),
      "--claude-agents-json",
      JSON.stringify([
        {
          pid: currentPid,
          cwd: workspace,
          kind: "interactive",
          sessionId: NATIVE_THREAD_ID,
          startedAt: 1_786_000_000_001,
          status: "idle"
        },
        {
          pid: ownerPid,
          cwd: otherWorkspace,
          kind: "interactive",
          sessionId: NATIVE_THREAD_ID,
          startedAt: 1_786_000_000_002,
          status: "idle"
        },
        {
          pid: ownerPid,
          cwd: otherWorkspace,
          kind: "interactive",
          sessionId: otherNativeThreadId,
          startedAt: 1_786_000_000_002,
          status: "idle"
        }
      ]),
      "--openclaw-bin",
      "/usr/bin/true",
      "--disable-terminal-bridge-monitor"
    ], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir }
    });

    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(
      String(sent.stderr),
      /already active in another claude process \(75002\)/u
    );
    assert.equal(listManagedSessions(storeDir).length, 0);
    assert.equal(listConversations(storeDir).length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("raw attach reuses one detached native-thread Session with a fresh binding", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: false });
  try {
    const detached = persistOwnerSession(fixture, "detached");
    const sent = fixture.send("continue the detached native thread");
    assert.equal(sent.status, 0, String(sent.stderr || sent.stdout));
    const output = JSON.parse(String(sent.stdout));
    assert.equal(output.delivered, true);
    assert.equal(output.session_id, detached.session_id);

    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].session_id, detached.session_id);
    assert.equal(sessions[0].status, "bound");
    assert.equal(sessions[0].binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(sessions[0].binding?.native_process.pid, fixture.currentPid);
    assert.equal(sessions[0].binding?.generation, 2);
    assert.notEqual(
      sessions[0].binding?.binding_id,
      detached.binding?.binding_id
    );
    assert.equal(listConversations(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("resolved pane authority prevents the same native thread from crossing Stores", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: false });
  try {
    const authorityStore = path.join(fixture.root, "authority-store-a");
    ensureStoreWritable(authorityStore);
    fixture.seedResolvedAuthority(authorityStore);

    const sent = fixture.send("store B must not steal store A authority");
    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(String(sent.stderr), /authoritative in another Store/u);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("resolved authority from another Store does not block a changed native thread", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: false });
  try {
    const authorityStore = path.join(fixture.root, "authority-store-a");
    ensureStoreWritable(authorityStore);
    fixture.seedResolvedAuthority(
      authorityStore,
      "55555555-5555-4555-8555-555555555555",
      99_998,
      "submitted"
    );

    const sent = fixture.send("the native identity changed, so Store B may attach");
    assert.equal(sent.status, 0, String(sent.stderr || sent.stdout));
    assert.equal(JSON.parse(String(sent.stdout)).delivered, true);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(
      listManagedSessions(fixture.storeDir)[0].binding?.native_thread_id,
      NATIVE_THREAD_ID
    );
  } finally {
    fixture.cleanup();
  }
});

test("a submitted waiting owner in Store A blocks Store B before Session creation", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: false });
  try {
    const ownerStore = path.join(fixture.root, "submitted-owner-store-a");
    const accepted = fixture.sendToStore(
      ownerStore,
      "Store A owns the submitted terminal task"
    );
    assert.equal(accepted.status, 0, String(accepted.stderr || accepted.stdout));
    assert.equal(JSON.parse(String(accepted.stdout)).delivered, true);

    const rejected = fixture.sendToStore(
      fixture.storeDir,
      "Store B must not create a duplicate Session"
    );
    assert.equal(rejected.status, 1, String(rejected.stderr || rejected.stdout));
    assert.match(String(rejected.stderr), /authoritative in another Store/u);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
    assert.equal(listConversations(fixture.storeDir).length, 0);
    const allSessions = [
      ...listManagedSessions(ownerStore),
      ...listManagedSessions(fixture.storeDir)
    ];
    assert.equal(allSessions.length, 1);
    assert.equal(
      allSessions.filter((session) =>
        session.binding?.native_thread_id === NATIVE_THREAD_ID
      ).length,
      1
    );
  } finally {
    fixture.cleanup();
  }
});

test("a stale pane ledger still preserves same-UUID Store authority", () => {
  const fixture = createOwnershipFixture({ includeOwnerProcess: false });
  try {
    const staleStore = path.join(fixture.root, "stale-pane-store-a");
    ensureStoreWritable(staleStore);
    fixture.seedResolvedAuthority(
      staleStore,
      NATIVE_THREAD_ID,
      99_999,
      "submitted"
    );

    const sent = fixture.send("the native UUID remains owned across pane restart");
    assert.equal(sent.status, 1, String(sent.stderr || sent.stdout));
    assert.match(String(sent.stderr), /authoritative in another Store/u);
    assert.equal(listManagedSessions(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

interface OwnershipFixture {
  root: string;
  storeDir: string;
  workspace: string;
  ownerPid: number;
  currentPid: number;
  ownerTerminalId: string;
  ownerControl: TerminalControlRef;
  seedResolvedAuthority(
    storeDir: string,
    nativeThreadId?: string,
    panePid?: number,
    status?: "resolved" | "submitted"
  ): void;
  sendToStore(storeDir: string, message: string): ReturnType<typeof spawnSync>;
  send(message: string): ReturnType<typeof spawnSync>;
  cleanup(): void;
}

function createOwnershipFixture({
  includeOwnerProcess,
  ownerProcessWorkspace = "same",
  unknownProcessWorkspace
}: {
  includeOwnerProcess: boolean;
  ownerProcessWorkspace?: "same" | "different";
  unknownProcessWorkspace?: "same" | "different" | "missing" | "nonexistent";
}): OwnershipFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-native-owner-cli-"));
  const storeDir = path.join(root, "store");
  const workspace = path.join(root, "workspace");
  const runtimeDir = path.join(root, "runtime");
  const otherWorkspace = path.join(root, "other-workspace");
  const ownerPid = 74_001;
  const currentPid = 74_002;
  const unknownPid = 74_003;
  const ownerPanePid = 74_101;
  const currentPanePid = 74_102;
  const ownerTarget = "native-owner-a:0.0";
  const currentTarget = "native-owner-b:0.0";
  const ownerTerminalId =
    `terminal:v2:tmux:codex:${ownerTarget}:${ownerPid}`;
  const currentTerminalId =
    `terminal:v2:tmux:codex:${currentTarget}:${currentPid}`;
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(otherWorkspace, { recursive: true });
  const selectedOwnerWorkspace = ownerProcessWorkspace === "different"
    ? otherWorkspace
    : workspace;
  const selectedUnknownWorkspace = unknownProcessWorkspace === "different"
    ? otherWorkspace
    : unknownProcessWorkspace === "nonexistent"
      ? path.join(root, "nonexistent-workspace")
      : unknownProcessWorkspace === "missing"
        ? undefined
        : workspace;

  const ownerControl: TerminalControlRef = {
    kind: "tmux",
    target: ownerTarget,
    session: "native-owner-a",
    window: 0,
    pane: 0,
    panePid: ownerPanePid,
    currentCommand: "codex",
    currentPath: workspace,
    capabilities: [
      "screen_status",
      "send_keys",
      "terminal_approval",
      "screen_completion",
      "durable_completion",
      "terminal_cancel"
    ]
  };
  const currentControl: TerminalControlRef = {
    ...ownerControl,
    target: currentTarget,
    session: "native-owner-b",
    panePid: currentPanePid
  };
  const processes = [
    ...(includeOwnerProcess
      ? [{
          pid: ownerPid,
          ppid: ownerPanePid,
          elapsed: "00:30",
          command: "codex",
          cwd: selectedOwnerWorkspace
        }]
      : []),
    ...(unknownProcessWorkspace
      ? [{
          pid: unknownPid,
          ppid: 74_103,
          elapsed: "00:25",
          command: "codex",
          ...(selectedUnknownWorkspace
            ? { cwd: selectedUnknownWorkspace }
            : {})
        }]
      : []),
    {
      pid: currentPid,
      ppid: currentPanePid,
      elapsed: "00:20",
      command: "codex",
      cwd: workspace
    }
  ];
  const terminals = [
    ...(includeOwnerProcess ? [ownerControl] : []),
    currentControl
  ];
  const identity = (pid: number) => ({
    sessionId: NATIVE_THREAD_ID,
    processUuid: `codex-pid:${pid}:birth:fixture-${pid}`,
    processBirth: `fixture-${pid}`,
    rollout: {
      fd: "12u",
      device: "1",
      inode: String(pid),
      path: path.join(root, `rollout-${pid}.jsonl`)
    },
    evidence: "static_exact_fixture"
  });
  const identities = {
    ...(includeOwnerProcess ? { [ownerPid]: identity(ownerPid) } : {}),
    [currentPid]: identity(currentPid)
  };
  const commonArgs = [
    "--processes-json",
    JSON.stringify(processes),
    "--terminals-json",
    JSON.stringify(terminals),
    "--terminal-screens-json",
    JSON.stringify({ [currentTarget]: "› \n" }),
    "--codex-active-session-identities-json",
    JSON.stringify(identities),
    "--openclaw-bin",
    "/usr/bin/true",
    "--disable-terminal-bridge-monitor"
  ];
  const sendToStore = (selectedStoreDir: string, message: string) =>
    spawnSync(process.execPath, [
      binPath,
      "send",
      "--conversation",
      currentTerminalId,
      "--message",
      message,
      "--background",
      "--store-dir",
      selectedStoreDir,
      ...commonArgs
    ], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir }
    });
  return {
    root,
    storeDir,
    workspace,
    ownerPid,
    currentPid,
    ownerTerminalId,
    ownerControl,
    seedResolvedAuthority(
      authorityStoreDir: string,
      nativeThreadId = NATIVE_THREAD_ID,
      authorityPanePid = currentPanePid,
      status: "resolved" | "submitted" = "resolved"
    ) {
      const ledgerKey = createHash("sha256")
        .update(JSON.stringify({ target: currentTarget, socket_path: null }))
        .digest("hex")
        .slice(0, 20);
      const ledgerPath = path.join(
        runtimeDir,
        "terminal-dispatch",
        `terminal-dispatch-${ledgerKey}.json`
      );
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      fs.writeFileSync(ledgerPath, `${JSON.stringify({
        version: 1,
        terminal_key: ledgerKey,
        terminal_control: {
          kind: "tmux",
          target: currentTarget,
          socket_path: null,
          pane_pid: authorityPanePid,
          current_path: workspace
        },
        status,
        native_thread_id: nativeThreadId,
        store_dir: authorityStoreDir,
        resolved_at: "2026-08-06T05:01:00.000Z"
      })}\n`, { mode: 0o600 });
    },
    sendToStore,
    send(message: string) {
      return sendToStore(storeDir, message);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function persistOwnerSession(
  fixture: OwnershipFixture,
  status: "bound" | "detached"
): ManagedSessionState {
  ensureStoreWritable(fixture.storeDir);
  const now = new Date("2026-08-06T05:00:00.000Z");
  return saveManagedSession(fixture.storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-native-owner-a",
    agent: "codex",
    workspace: fixture.workspace,
    status,
    binding: terminalBindingFrom({
      terminalId: fixture.ownerTerminalId,
      terminalControl: fixture.ownerControl,
      pid: fixture.ownerPid,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: `codex-pid:${fixture.ownerPid}:birth:fixture-${fixture.ownerPid}`,
      processBirth: `fixture-${fixture.ownerPid}`,
      rollout: {
        fd: "12u",
        device: "1",
        inode: String(fixture.ownerPid),
        path: path.join(fixture.root, `rollout-${fixture.ownerPid}.jsonl`)
      },
      evidence: "static_exact_fixture",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    ...(status === "detached" ? { detached_at: now.toISOString() } : {})
  }, { expectedRevision: null });
}

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  nativeThreadCommandFingerprint,
  terminalBindingFrom,
  type NativeThreadTransition
} from "../src/managed-session.js";
import {
  planCodexThreadLifecycle,
  probeCodexThreadLifecycle
} from "../src/codex-terminal-agent-adapter.js";
import {
  planClaudeThreadLifecycle,
  probeClaudeThreadLifecycle
} from "../src/claude-terminal-agent-adapter.js";
import type { CodexLocalSessionAdapter } from "../src/codex-local-session-provider.js";
import type { CodexOpenRootRolloutInventory } from
  "../src/agent-session-provider.js";
import {
  listManagedSessions,
  loadNativeThreadTransition,
  saveManagedSession,
  saveNativeThreadTransition
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type {
  TerminalControlRef,
  TerminalProcessSnapshot
} from "../src/terminal-agent-adapter.js";
import {
  createTerminalEndpointRef,
  tmuxTerminalRouteKey
} from "../src/terminal-control-ref.js";
import {
  MutableRecordingTerminalProvider,
  MutableTerminalProcessSource,
  runInProcessCli,
  terminalCliDependencies,
  type InProcessCliResult
} from "./in-process-cli-fixtures.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const BEFORE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";
const CLAUDE_CURRENT_EMPTY_COMPOSER = [
  "Ready",
  "────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────",
  "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents"
].join("\n");
const CODEX_STATUS_COMPOSER = [
  "Ready",
  "› /status",
  "  /status  show current session configuration and token usage"
].join("\n");

test("black-box Codex recovery clears a dispatching composer and rolls exact-before back without replay", async () => {
  const fixture = seededCodexRecoveryFixture("dispatching", {
    execution: "black-box"
  });
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    const automaticallyBlocked = await fixture.run([
      "send",
      "--session",
      fixture.terminalId,
      "--message",
      "This task must remain fenced.",
      "--background",
      "--disable-terminal-bridge-monitor"
    ]);
    assert.equal(automaticallyBlocked.status, 1);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "uncertain"
    );
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.deepEqual(fixture.literalInputs(), []);
    assert.equal(fixture.keyDispatches().some((keys) =>
      keys.includes("C-u")
    ), false);

    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(
      JSON.parse(recovered.stdout).terminal_dispatch_resolved,
      true,
      fixture.debug(recovered)
    );
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      fixture.transitionId
    );
    assert.equal(transition.status, "aborted");
    assert.equal(transition.reconciled_outcome, "before");
    assert.equal(fixture.source().status, "bound");
    assert.equal(listConversations(fixture.storeDir).length, 0);
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(fixture.keyDispatches().filter((keys) =>
      keys.includes("C-u")
    ).length, 1);
    assert.equal(fixture.literalInputs().includes(`/resume ${TARGET_ID}`), false);
  } finally {
    fixture.cleanup();
  }
});

test("manual recovery rolls a submitted exact resume target forward without replay", async () => {
  const fixture = seededCodexRecoveryFixture("submitted", {
    dispatcherPid: process.pid
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(JSON.parse(recovered.stdout).terminal_dispatch_resolved, true);
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      fixture.transitionId
    );
    assert.equal(transition.status, "committed");
    assert.equal(transition.reconciled_outcome, "after");
    assert.equal(fixture.source().status, "detached");
    const target = listManagedSessions(fixture.storeDir).find((session) =>
      session.session_id === fixture.targetSessionId
    );
    assert.equal(target?.status, "bound");
    assert.equal(target?.binding?.native_thread_id, TARGET_ID);
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(fixture.literalInputs().includes(`/resume ${TARGET_ID}`), false);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("manual exact-after recovery fails closed when another Codex pid owns the target", async () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setSecondOwner(TARGET_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(fixture.literalInputs().includes(`/resume ${TARGET_ID}`), false);
  } finally {
    fixture.cleanup();
  }
});

test("manual exact-before rollback fails closed when another Codex pid owns the source thread", async () => {
  const fixture = seededCodexRecoveryFixture("dispatching");
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    fixture.setSecondOwner(BEFORE_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "uncertain"
    );
    assert.equal(fixture.source().status, "quarantined");
  } finally {
    fixture.cleanup();
  }
});

test("target CAS failure never partially detaches the lifecycle source", async () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.injectTargetConflict();
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(
      listManagedSessions(fixture.storeDir).find((session) =>
        session.session_id === fixture.targetSessionId
      )?.binding?.native_thread_id,
      THIRD_ID
    );
  } finally {
    fixture.cleanup();
  }
});

test("manual recovery refuses to probe or submit when C-u does not empty the composer", async () => {
  const fixture = seededCodexRecoveryFixture("dispatching");
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    fixture.setClearLineNoop();
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "uncertain"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.deepEqual(fixture.literalInputs(), []);
    const keys = fixture.keyDispatches();
    assert.equal(
      keys.some((entry) => entry.includes("C-u")),
      true,
      fixture.debug(blocked)
    );
    assert.equal(keys.some((entry) => entry.includes("C-m")), false);
  } finally {
    fixture.cleanup();
  }
});

test("manual submitted recovery never probes /status over a non-empty Codex composer", async () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setCurrentIdentity(TARGET_ID, "preserve this operator draft");
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.notEqual(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "committed"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.deepEqual(fixture.literalInputs(), []);
    const keys = fixture.keyDispatches();
    assert.equal(keys.some((entry) => entry.includes("C-u")), false);
    assert.equal(keys.some((entry) => entry.includes("C-m")), false);
  } finally {
    fixture.cleanup();
  }
});

test("manual dispatching recovery rolls a status-only recorded-before identity back", async () => {
  const fixture = seededCodexRecoveryFixture("dispatching", {
    beforeRollout: false
  });
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(
      JSON.parse(recovered.stdout).terminal_dispatch_resolved,
      true,
      fixture.debug(recovered)
    );
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      fixture.transitionId
    );
    assert.equal(transition.status, "aborted");
    assert.equal(transition.reconciled_outcome, "before");
    assert.equal(transition.before_process_rollout, undefined);
    assert.equal(fixture.source().status, "bound");
    assert.equal(
      fixture.source().binding?.native_process.rollout,
      undefined
    );
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(fixture.keyDispatches().filter((keys) =>
      keys.includes("C-u")
    ).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("verified recovery refuses to roll forward when the resume candidate inode changed", async () => {
  const fixture = seededCodexRecoveryFixture("verified", {
    targetCandidateInodeMismatch: true
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(
      listManagedSessions(fixture.storeDir).some((session) =>
        session.session_id === fixture.targetSessionId
      ),
      false
    );
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("manual recovery keeps a submitted third identity quarantined and blocked", async () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setCurrentIdentity(THIRD_ID);

    for (const ledgerPatch of [
      { dispatcher_pid: 123_456_789 },
      {
        dispatcher_pid: fixture.dispatcherPid,
        prepared_at: "2026-08-06T03:00:00.001Z"
      },
      {
        prepared_at: fixture.preparedAt,
        status: "prepared"
      }
    ]) {
      fixture.patchLedger(ledgerPatch);
      const integrityBlocked = await fixture.close();
      assert.equal(
        integrityBlocked.status,
        0,
        fixture.debug(integrityBlocked)
      );
      assert.equal(
        JSON.parse(integrityBlocked.stdout).terminal_dispatch_resolved,
        false
      );
      assert.equal(
        loadNativeThreadTransition(
          fixture.storeDir,
          fixture.transitionId
        ).status,
        "submitted"
      );
    }
    fixture.patchLedger({ status: "submitted" });
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    const result = JSON.parse(recovered.stdout);
    assert.equal(result.terminal_dispatch_resolved, false);
    assert.equal(result.blocked, true);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "uncertain"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(fixture.literalInputs().includes(`/resume ${TARGET_ID}`), false);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
    assert.equal(listConversations(fixture.storeDir).length, 0);
  } finally {
    fixture.cleanup();
  }
});

test("verified mismatch stays blocked and later exact-after evidence commits the same transition", async () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(THIRD_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");

    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(
      JSON.parse(recovered.stdout).terminal_dispatch_resolved,
      true,
      fixture.debug(recovered)
    );
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "committed"
    );
    assert.equal(fixture.source().status, "detached");
    assert.equal(fixture.literalInputs().includes(`/resume ${TARGET_ID}`), false);
  } finally {
    fixture.cleanup();
  }
});

test("raw terminal send directly rolls a verified crash forward before one Session Turn", async () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const sent = await fixture.run([
      "send",
      "--session",
      fixture.terminalId,
      "--message",
      "Report the current branch.",
      "--background",
      "--disable-terminal-bridge-monitor"
    ]);
    assert.equal(sent.status, 0, sent.stderr || sent.stdout);
    const result = JSON.parse(sent.stdout);
    assert.equal(result.delivered, true, sent.stdout);
    assert.notEqual(result.session_id, fixture.targetSessionId);
    assert.equal(listConversations(fixture.storeDir).length, 1);
    const sessions = listManagedSessions(fixture.storeDir);
    assert.equal(sessions.length, 3);
    assert.equal(fixture.source().status, "detached");
    assert.equal(
      sessions.find((session) =>
        session.session_id === fixture.targetSessionId
      )?.status,
      "detached"
    );
    assert.equal(
      sessions.find((session) => session.session_id === result.session_id)
        ?.status,
      "bound"
    );
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "committed"
    );
    assert.deepEqual(fixture.literalInputs(), ["Report the current branch."]);
  } finally {
    fixture.cleanup();
  }
});

test("verified no-rollout recovery rejects a stale Codex status screen", async () => {
  const fixture = seededCodexRecoveryFixture("verified", {
    verifiedAfterRollout: false
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setStatusProbeNoop();
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("submitted recovery rejects an unchanged old Codex status card beyond 120 lines", async () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setLongUnchangedStatusProbe(TARGET_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(
      JSON.parse(blocked.stdout).terminal_dispatch_resolved,
      false,
      fixture.debug(blocked)
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.deepEqual(fixture.literalInputs(), ["/status"]);
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("verified rollout recovery fails closed on a Codex resolver error", async () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setResolverError();
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("Claude manual recovery rolls exact-before back without lifecycle replay", async () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(BEFORE_ID);
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(JSON.parse(recovered.stdout).terminal_dispatch_resolved, true);
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      fixture.transitionId
    );
    assert.equal(transition.status, "aborted");
    assert.equal(transition.reconciled_outcome, "before");
    assert.equal(fixture.source().status, "bound");
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("imported Claude recovery rolls an exact submitted resume target forward", async () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = await fixture.close();
    assert.equal(recovered.status, 0, fixture.debug(recovered));
    assert.equal(
      JSON.parse(recovered.stdout).terminal_dispatch_resolved,
      true,
      fixture.debug(recovered)
    );
    const transition = loadNativeThreadTransition(
      fixture.storeDir,
      fixture.transitionId
    );
    assert.equal(transition.status, "committed");
    assert.equal(transition.reconciled_outcome, "after");
    assert.equal(fixture.source().status, "detached");
    assert.equal(
      listManagedSessions(fixture.storeDir).find((session) =>
        session.session_id === fixture.targetSessionId
      )?.binding?.native_thread_id,
      TARGET_ID
    );
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("Claude manual recovery keeps a third exact identity blocked", async () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(THIRD_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "uncertain"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.deepEqual(fixture.literalInputs(), []);
  } finally {
    fixture.cleanup();
  }
});

test("Claude verified recovery fails closed on ambiguous exact-PID agents rows", async () => {
  const fixture = seededClaudeRecoveryFixture({ verified: true });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setAgentsAmbiguous();
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
  } finally {
    fixture.cleanup();
  }
});

test("Claude verified recovery fails closed when another pid owns the target", async () => {
  const fixture = seededClaudeRecoveryFixture({ verified: true });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setSecondOwner(TARGET_ID);
    const blocked = await fixture.close();
    assert.equal(blocked.status, 0, fixture.debug(blocked));
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");
    assert.equal(listManagedSessions(fixture.storeDir).length, 1);
  } finally {
    fixture.cleanup();
  }
});

function seededCodexRecoveryFixture(
  status: "dispatching" | "submitted" | "verified",
  options: {
    execution?: "in-process" | "black-box";
    verifiedAfterRollout?: boolean;
    dispatcherPid?: number;
    beforeRollout?: boolean;
    targetCandidateInodeMismatch?: boolean;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-lifecycle-recovery-"));
  const fakeBinDir = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const codexHome = path.join(root, ".codex");
  const screenPath = path.join(root, "screen.txt");
  const currentIdPath = path.join(root, "current-id.txt");
  const callsPath = path.join(root, "tmux-calls.ndjson");
  const probeCountPath = path.join(root, "probe-count.txt");
  const preProbeScreenPath = path.join(root, "pre-probe-screen.txt");
  const clearNoopPath = path.join(root, "clear-noop");
  const statusNoopPath = path.join(root, "status-noop");
  const statusUnchangedPath = path.join(root, "status-unchanged");
  const resolverErrorRequestPath = path.join(root, "resolver-error-request");
  const resolverErrorArmedPath = path.join(root, "resolver-error-armed");
  const secondOwnerIdPath = path.join(root, "second-owner-id.txt");
  const target = "recovery-fixture:0.0";
  const paneId = "%77";
  const panePid = 72_000;
  const codexPid = 72_001;
  const secondCodexPid = 72_002;
  const processBirth = "Thu Aug  6 11:00:00 2026";
  const secondProcessBirth = "Thu Aug  6 11:00:01 2026";
  const processUuid = `codex-pid:${codexPid}:birth:${processBirth}`;
  const terminalId = `terminal:v2:tmux:codex:${target}:${codexPid}`;
  const transitionId = `transition-recovery-${status}`;
  const dispatcherPid = options.dispatcherPid ?? 2_000_000_000;
  const sourceSessionId = `session-source-${status}`;
  const targetSessionId = `session-target-${status}`;
  const executablePath =
    "/opt/akk-test/releases/0.146.0-aarch64-apple-darwin/bin/codex";
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const rolloutPaths = Object.fromEntries(
    [BEFORE_ID, TARGET_ID, THIRD_ID].map((id) => {
      const rolloutPath = path.join(
        codexHome,
        "sessions",
        `rollout-${id}.jsonl`
      );
      fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
      fs.writeFileSync(rolloutPath, `${JSON.stringify({
        timestamp: "2026-08-06T03:00:00.000Z",
        type: "session_meta",
        payload: {
          id,
          cwd: workspace,
          originator: "codex-tui",
          source: "cli",
          cli_version: "0.146.0"
        }
      })}\n`, { mode: 0o600 });
      return [id, rolloutPath];
    })
  );
  fs.writeFileSync(currentIdPath, BEFORE_ID);
  fs.writeFileSync(screenPath, "Ready\n› ");
  writeRecoveryFakeTmux({
    fakeBinDir,
    callsPath,
    screenPath,
    currentIdPath,
    probeCountPath,
    preProbeScreenPath,
    clearNoopPath,
    statusNoopPath,
    resolverErrorRequestPath,
    resolverErrorArmedPath,
    target,
    paneId,
    panePid,
    workspace
  });
  const openRolloutPaths = options.beforeRollout === false
    ? Object.fromEntries(
        Object.entries(rolloutPaths).filter(([id]) => id !== BEFORE_ID)
      )
    : rolloutPaths;
  writeRecoveryFakeProcessTools({
    fakeBinDir,
    currentIdPath,
    rolloutPaths: openRolloutPaths,
    executablePath,
    workspace,
    panePid,
    codexPid,
    secondCodexPid,
    processBirth,
    secondProcessBirth,
    secondOwnerIdPath,
    resolverErrorPath: resolverErrorArmedPath
  });
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: "recovery-fixture",
    window: 0,
    pane: 0,
    panePid,
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
  const endpointKey = "default-server-route";
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey: `pane-id:${paneId}`
    },
    route: {
      routeKey: tmuxTerminalRouteKey(endpointKey, target),
      label: target,
      currentCommand: terminalControl.currentCommand,
      currentPath: terminalControl.currentPath
    },
    processAnchorPid: panePid,
    capabilities: terminalControl.capabilities,
    providerRef: terminalControl
  });
  const processSnapshots = (): TerminalProcessSnapshot[] => [
    {
      pid: panePid,
      ppid: 1,
      elapsed: "00:10",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: codexPid,
      ppid: panePid,
      elapsed: "00:09",
      command: executablePath,
      cwd: workspace
    },
    ...(fs.existsSync(secondOwnerIdPath)
      ? [{
          pid: secondCodexPid,
          ppid: 1,
          elapsed: "00:08",
          command: executablePath,
          cwd: workspace
        }]
      : [])
  ];
  const processSource = new MutableTerminalProcessSource(processSnapshots());
  let pendingTerminalText = "";
  const terminalProvider = new MutableRecordingTerminalProvider({
    panes: [{
      kind: "tmux",
      target,
      session: "recovery-fixture",
      window: 0,
      pane: 0,
      panePid,
      paneId,
      currentCommand: "codex",
      currentPath: workspace,
      columns: 100,
      rows: 30
    }],
    screens: { [target]: fs.readFileSync(screenPath, "utf8") },
    hooks: {
      capture(operation, provider) {
        if (fs.existsSync(resolverErrorRequestPath)) {
          fs.writeFileSync(resolverErrorArmedPath, "1");
        }
        const screen = fs.readFileSync(screenPath, "utf8");
        provider.setScreen(target, screen);
        if (operation.scrollbackLines === undefined) {
          return screen;
        }
        return screen.split("\n")
          .slice(-operation.scrollbackLines)
          .join("\n");
      },
      sendText(operation, provider) {
        pendingTerminalText = operation.text;
        if (operation.text === "/status") {
          fs.copyFileSync(screenPath, preProbeScreenPath);
          const composerScreen = fs.existsSync(statusUnchangedPath)
            ? `${fs.readFileSync(screenPath, "utf8")}\n${CODEX_STATUS_COMPOSER}`
            : CODEX_STATUS_COMPOSER;
          fs.writeFileSync(screenPath, composerScreen);
          provider.setScreen(target, composerScreen);
          return;
        }
        const composer = `Ready\n› ${operation.text}\ngpt-5.6-sol high · /repo`;
        fs.writeFileSync(screenPath, composer);
        provider.setScreen(target, composer);
      },
      sendKeys(operation, provider) {
        if (operation.keys.includes("C-m")) {
          if (pendingTerminalText && pendingTerminalText !== "/status") {
            pendingTerminalText = "";
            fs.writeFileSync(screenPath, "Working\n");
            provider.setScreen(target, "Working\n");
            return;
          }
          pendingTerminalText = "";
          if (fs.existsSync(statusUnchangedPath)) {
            return;
          }
          if (fs.existsSync(statusNoopPath)) {
            const staleScreen = fs.readFileSync(preProbeScreenPath, "utf8");
            fs.writeFileSync(screenPath, staleScreen);
            provider.setScreen(target, staleScreen);
            return;
          }
          const count = fs.existsSync(probeCountPath)
            ? Number(fs.readFileSync(probeCountPath, "utf8")) + 1
            : 1;
          fs.writeFileSync(probeCountPath, String(count));
          const id = fs.readFileSync(currentIdPath, "utf8").trim();
          const screen = `/status\nprobe-${count}\nSession: ${id}\n› `;
          fs.writeFileSync(screenPath, screen);
          provider.setScreen(target, screen);
          return;
        }
        if (
          operation.keys.includes("C-u") &&
          !fs.existsSync(clearNoopPath)
        ) {
          fs.writeFileSync(screenPath, "Ready\n› ");
          provider.setScreen(target, "Ready\n› ");
        }
      }
    }
  });
  const rollout = (id: string) => {
    const rolloutPath = fs.realpathSync(rolloutPaths[id]);
    const stat = fs.statSync(rolloutPath);
    return {
      fd: "12u",
      device: String(stat.dev),
      inode: String(stat.ino),
      path: rolloutPath
    };
  };
  ensureStoreWritable(storeDir);
  const preparedAt = new Date("2026-08-06T03:00:00.000Z");
  const targetCandidateRollout = rollout(TARGET_ID);
  const targetCandidateFileIdentity = {
    path: targetCandidateRollout.path,
    device: targetCandidateRollout.device,
    inode: options.targetCandidateInodeMismatch
      ? String(BigInt(targetCandidateRollout.inode) + 1n)
      : targetCandidateRollout.inode
  };
  const source = saveManagedSession(storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sourceSessionId,
    agent: "codex",
    workspace,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId,
      terminalControl,
      pid: codexPid,
      nativeThreadId: BEFORE_ID,
      processUuid,
      processBirth,
      rollout: options.beforeRollout === false
        ? undefined
        : rollout(BEFORE_ID),
      evidence: options.beforeRollout === false
        ? "codex_status_card"
        : "codex_rollout_fd",
      generation: 1,
      now: preparedAt
    }),
    lineage: { created_by: "attach" },
    created_at: preparedAt.toISOString(),
    updated_at: preparedAt.toISOString()
  }, { expectedRevision: null });
  const capabilities = probeCodexThreadLifecycle("0.146.0");
  assert.equal(capabilities.status, "supported");
  const plan = planCodexThreadLifecycle(
    { kind: "resume_thread", nativeThreadId: TARGET_ID },
    capabilities
  );
  let transition: NativeThreadTransition = {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: transitionId,
    operation: "resume_thread",
    status: "prepared",
    terminal_id: terminalId,
    agent: "codex",
    workspace,
    source_session_id: sourceSessionId,
    source_expected_revision: 1,
    target_session_id: targetSessionId,
    target_expected_revision: null,
    target_native_thread_id: TARGET_ID,
    target_candidate_file_identity: targetCandidateFileIdentity,
    before_native_thread_id: BEFORE_ID,
    before_process_uuid: processUuid,
    before_process_birth: processBirth,
    before_process_rollout: options.beforeRollout === false
      ? undefined
      : rollout(BEFORE_ID),
    before_binding: source.binding,
    adapter_version: "0.146.0",
    command_fingerprint: nativeThreadCommandFingerprint(
      JSON.stringify(plan.steps)
    ),
    dispatcher_pid: dispatcherPid,
    prepared_at: preparedAt.toISOString()
  };
  transition = saveNativeThreadTransition(storeDir, transition, {
    expectedRevision: null
  });
  const dispatchingAt = "2026-08-06T03:00:01.000Z";
  transition = saveNativeThreadTransition(storeDir, {
    ...transition,
    status: "dispatching",
    dispatching_at: dispatchingAt
  }, { expectedRevision: 1 });
  if (status !== "dispatching") {
    transition = saveNativeThreadTransition(storeDir, {
      ...transition,
      status: "submitted",
      submitted_at: "2026-08-06T03:00:02.000Z"
    }, { expectedRevision: 2 });
  }
  if (status === "verified") {
    transition = saveNativeThreadTransition(storeDir, {
      ...transition,
      status: "verified",
      verified_at: "2026-08-06T03:00:03.000Z",
      after_binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: codexPid,
        nativeThreadId: TARGET_ID,
        processUuid,
        processBirth,
        rollout: options.verifiedAfterRollout === false
          ? undefined
          : rollout(TARGET_ID),
        evidence: "codex_rollout_fd",
        generation: 1,
        now: new Date("2026-08-06T03:00:03.000Z")
      })
    }, { expectedRevision: 3 });
  }
  saveManagedSession(storeDir, {
    ...source,
    status: "transitioning",
    last_transition_id: transitionId,
    updated_at: dispatchingAt
  }, { expectedRevision: 1 });
  const ledgerKey = createHash("sha256")
    .update(JSON.stringify({ target, socket_path: null }))
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
      target,
      socket_path: null,
      pane_pid: panePid,
      current_path: workspace
    },
    kind: "lifecycle",
    generation_id: transitionId,
    transition_id: transitionId,
    status: status === "verified" ? "submitted" : status,
    operation: "resume_thread",
    terminal_id: terminalId,
    agent: "codex",
    workspace,
    adapter_version: "0.146.0",
    command_fingerprint: transition.command_fingerprint,
    source_session_id: sourceSessionId,
    target_session_id: targetSessionId,
    target_native_thread_id: TARGET_ID,
    target_candidate_file_identity: targetCandidateFileIdentity,
    before_native_thread_id: BEFORE_ID,
    before_process_uuid: processUuid,
    before_process_birth: processBirth,
    before_process_rollout: options.beforeRollout === false
      ? undefined
      : rollout(BEFORE_ID),
    store_dir: storeDir,
    prepared_at: preparedAt.toISOString(),
    dispatching_at: dispatchingAt,
    submitted_at: transition.submitted_at,
    dispatcher_pid: dispatcherPid,
    binding: source.binding
  })}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AKK_RUNTIME_DIR: runtimeDir,
    AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
    AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
  };
  const openRootInventory = (
    pid: number,
    cwd = workspace
  ): CodexOpenRootRolloutInventory => {
    const selectedId = pid === secondCodexPid
      ? fs.existsSync(secondOwnerIdPath)
        ? fs.readFileSync(secondOwnerIdPath, "utf8").trim()
        : undefined
      : pid === codexPid
        ? fs.readFileSync(currentIdPath, "utf8").trim()
        : undefined;
    const birth = pid === secondCodexPid
      ? secondProcessBirth
      : processBirth;
    const selectedRolloutPath = selectedId
      ? openRolloutPaths[selectedId]
      : undefined;
    const roots = selectedId && selectedRolloutPath &&
        fs.existsSync(selectedRolloutPath)
      ? (() => {
          const realPath = fs.realpathSync(selectedRolloutPath);
          const stat = fs.statSync(realPath);
          return [{
            sessionId: selectedId,
            processUuid: `codex-pid:${pid}:birth:${birth}`,
            processBirth: birth,
            rollout: {
              fd: "12u",
              device: String(stat.dev),
              inode: String(stat.ino),
              path: realPath
            },
            evidence: "codex_open_root_rollout" as const
          }];
        })()
      : [];
    const authority = {
      schema: "agent-knock-knock/codex-open-root-rollout-inventory" as const,
      version: 1 as const,
      pid,
      processUuid: `codex-pid:${pid}:birth:${birth}`,
      processBirth: birth,
      cwd,
      roots
    };
    const inventoryFingerprint = createHash("sha256")
      .update(JSON.stringify(authority))
      .digest("hex");
    return roots.length === 1
      ? {
          ...authority,
          status: "resolved",
          roots: [roots[0]!],
          inventoryFingerprint
        }
      : {
          ...authority,
          status: "verified_absent",
          roots: [],
          inventoryFingerprint
        };
  };
  const codexAdapter: CodexLocalSessionAdapter = {
    async listThreadRows() {
      return [];
    },
    async readRollout(rolloutPath) {
      return fs.existsSync(rolloutPath)
        ? fs.readFileSync(rolloutPath, "utf8")
        : undefined;
    },
    async listProcessSnapshots() {
      return processSource.listProcessSnapshots();
    },
    async inspectOpenRootRolloutInventoryForPid(pid, cwd) {
      return openRootInventory(pid, cwd);
    },
    async resolveActiveSessionIdentityForPid(pid) {
      if (pid === codexPid && fs.existsSync(resolverErrorArmedPath)) {
        throw new Error("resolver fixture failure");
      }
      const selectedId = pid === secondCodexPid
        ? fs.existsSync(secondOwnerIdPath)
          ? fs.readFileSync(secondOwnerIdPath, "utf8").trim()
          : undefined
        : pid === codexPid
          ? fs.readFileSync(currentIdPath, "utf8").trim()
          : undefined;
      if (!selectedId) {
        return undefined;
      }
      const selectedRolloutPath = openRolloutPaths[selectedId];
      if (!selectedRolloutPath || !fs.existsSync(selectedRolloutPath)) {
        return undefined;
      }
      const realPath = fs.realpathSync(selectedRolloutPath);
      const stat = fs.statSync(realPath);
      const birth = pid === secondCodexPid
        ? secondProcessBirth
        : processBirth;
      return {
        sessionId: selectedId,
        processUuid: `codex-pid:${pid}:birth:${birth}`,
        processBirth: birth,
        rollout: {
          fd: "12u",
          device: String(stat.dev),
          inode: String(stat.ino),
          path: realPath
        },
        evidence: "codex_rollout_fd"
      };
    }
  };
  const dependencies = terminalCliDependencies({
    terminalProvider,
    processSource,
    env,
    overrides: {
      codexLocalSessionAdapter: codexAdapter,
      agentVersionForRunningProcess: () => "0.146.0",
      codexProcessBirthForPid(pid) {
        return pid === secondCodexPid ? secondProcessBirth : processBirth;
      }
    }
  });
  const commandArguments = (args: string[]) => [
    ...args,
    "--store-dir",
    storeDir,
    "--codex-home",
    codexHome
  ];
  const run = async (args: string[]) => {
    if (options.execution === "black-box") {
      return spawnSync(
        process.execPath,
        [binPath, ...commandArguments(args)],
        { encoding: "utf8", env, timeout: 30_000 }
      );
    }
    return runInProcessCli(commandArguments(args), dependencies);
  };
  return {
    root,
    storeDir,
    terminalId,
    transitionId,
    targetSessionId,
    dispatcherPid,
    preparedAt: preparedAt.toISOString(),
    run,
    close: () => run([
      "close",
      "--conversation",
      terminalId,
      "--expected-transition-id",
      transitionId
    ]),
    setCurrentIdentity(id: string, composer?: string) {
      fs.writeFileSync(currentIdPath, id);
      fs.writeFileSync(
        screenPath,
        composer === undefined
          ? `/status external\nSession: ${id}\n› `
          : `Ready\n› ${composer}`
      );
    },
    source: () => listManagedSessions(storeDir).find((session) =>
      session.session_id === sourceSessionId
    )!,
    literalInputs: () => options.execution === "black-box"
      ? readCalls(callsPath)
          .filter((args) => args[0] === "send-keys" && args.includes("-l"))
          .map((args) => args.at(-1) as string)
      : terminalProvider.literalInputs(),
    keyDispatches: () => options.execution === "black-box"
      ? readCalls(callsPath)
          .filter((args) => args[0] === "send-keys" && !args.includes("-l"))
      : terminalProvider.keyDispatches(),
    setClearLineNoop: () => fs.writeFileSync(clearNoopPath, "1"),
    setStatusProbeNoop: () => fs.writeFileSync(statusNoopPath, "1"),
    setLongUnchangedStatusProbe(id: string) {
      fs.writeFileSync(currentIdPath, id);
      fs.writeFileSync(statusUnchangedPath, "1");
      fs.writeFileSync(screenPath, [
        ...Array.from({ length: 130 }, (_, index) => `history-${index}`),
        "/status external",
        `Session: ${id}`,
        "› "
      ].join("\n"));
    },
    setResolverError: () => fs.writeFileSync(resolverErrorRequestPath, "1"),
    setSecondOwner(id: string) {
      fs.writeFileSync(secondOwnerIdPath, id);
      processSource.setSnapshots(processSnapshots());
    },
    patchLedger(patch: Record<string, unknown>) {
      const currentLedgerPath = currentTerminalDispatchLedgerPath(runtimeDir);
      const current = JSON.parse(
        fs.readFileSync(currentLedgerPath, "utf8")
      );
      fs.writeFileSync(
        currentLedgerPath,
        `${JSON.stringify({ ...current, ...patch })}\n`,
        { mode: 0o600 }
      );
    },
    injectTargetConflict() {
      saveManagedSession(storeDir, {
        schema: "agent-knock-knock/session",
        version: 1,
        session_id: targetSessionId,
        agent: "codex",
        workspace,
        status: "detached",
        binding: terminalBindingFrom({
          terminalId: `${terminalId}:stale-target`,
          terminalControl: {
            ...terminalControl,
            target: "stale-target:0.0",
            panePid: codexPid + 100
          },
          pid: codexPid + 100,
          nativeThreadId: THIRD_ID,
          processUuid: `codex-pid:${codexPid + 100}:birth:stale`,
          processBirth: "stale",
          evidence: "test_target_cas_conflict",
          generation: 1,
          now: new Date("2026-08-06T03:00:02.500Z")
        }),
        lineage: { created_by: "attach" },
        created_at: "2026-08-06T03:00:02.500Z",
        updated_at: "2026-08-06T03:00:02.500Z"
      }, { expectedRevision: null });
    },
    debug: (result: InProcessCliResult | ReturnType<typeof spawnSync>) => JSON.stringify({
      status: result.status,
      signal: "signal" in result ? result.signal : undefined,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: options.execution === "black-box"
        ? readCalls(callsPath)
        : terminalProvider.operations,
      screen: fs.readFileSync(screenPath, "utf8")
    }, null, 2),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function currentTerminalDispatchLedgerPath(runtimeDir: string): string {
  const ledgerDir = path.join(runtimeDir, "terminal-dispatch");
  const ledgers = fs.readdirSync(ledgerDir)
    .filter((name) => /^terminal-dispatch-[0-9a-f]{20}\.json$/u.test(name));
  assert.equal(
    ledgers.length,
    1,
    `expected one current terminal dispatch ledger, found ${ledgers.join(", ")}`
  );
  return path.join(ledgerDir, ledgers[0]);
}

function seededClaudeRecoveryFixture(
  options: {
    verified?: boolean;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-recovery-"));
  const fakeBinDir = path.join(root, "bin");
  const workspace = path.join(root, "workspace");
  const storeDir = path.join(root, "store");
  const runtimeDir = path.join(root, "runtime");
  const screenPath = path.join(root, "screen.txt");
  const currentIdPath = path.join(root, "current-id.txt");
  const callsPath = path.join(root, "tmux-calls.ndjson");
  const agentsAmbiguousPath = path.join(root, "agents-ambiguous");
  const secondOwnerIdPath = path.join(root, "second-owner-id.txt");
  const target = "claude-recovery:0.0";
  const panePid = 73_000;
  const claudePid = 73_001;
  const startedAt = 1_786_000_000_000;
  const processUuid = `claude-pid:${claudePid}:started:${startedAt}`;
  const terminalId = `terminal:v2:tmux:claude:${target}:${claudePid}`;
  const transitionId = "transition-claude-recovery";
  const sourceSessionId = "session-claude-source";
  const targetSessionId = "session-claude-target";
  const executablePath =
    "/Users/test/.local/share/claude/versions/2.1.226";
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(currentIdPath, BEFORE_ID);
  fs.writeFileSync(screenPath, CLAUDE_CURRENT_EMPTY_COMPOSER);
  writeClaudeRecoveryFakeTmux({
    fakeBinDir,
    callsPath,
    screenPath,
    target,
    panePid,
    workspace
  });
  writeClaudeRecoveryFakeProcessTools({
    fakeBinDir,
    currentIdPath,
    executablePath,
    workspace,
    panePid,
    claudePid,
    startedAt,
    agentsAmbiguousPath,
    secondOwnerIdPath
  });
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target,
    session: "claude-recovery",
    window: 0,
    pane: 0,
    panePid,
    currentCommand: "claude",
    currentPath: workspace,
    capabilities: [
      "screen_status",
      "send_keys",
      "terminal_approval",
      "durable_completion",
      "terminal_cancel"
    ]
  };
  const processSource = new MutableTerminalProcessSource([
    {
      pid: panePid,
      ppid: 1,
      elapsed: "00:10",
      command: "zsh",
      cwd: workspace
    },
    {
      pid: claudePid,
      ppid: panePid,
      elapsed: "00:09",
      command: executablePath,
      cwd: workspace
    }
  ]);
  const terminalProvider = new MutableRecordingTerminalProvider({
    panes: [{
      kind: "tmux",
      target,
      session: "claude-recovery",
      window: 0,
      pane: 0,
      panePid,
      currentCommand: "claude",
      currentPath: workspace
    }],
    screens: { [target]: fs.readFileSync(screenPath, "utf8") },
    hooks: {
      capture(_operation, provider) {
        const screen = fs.readFileSync(screenPath, "utf8");
        provider.setScreen(target, screen);
        return screen;
      },
      sendKeys(operation, provider) {
        if (operation.keys.includes("C-u")) {
          fs.writeFileSync(screenPath, CLAUDE_CURRENT_EMPTY_COMPOSER);
          provider.setScreen(target, CLAUDE_CURRENT_EMPTY_COMPOSER);
        }
      }
    }
  });
  ensureStoreWritable(storeDir);
  const preparedAt = new Date("2026-08-06T04:00:00.000Z");
  const source = saveManagedSession(storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sourceSessionId,
    agent: "claude",
    workspace,
    status: "bound",
    binding: terminalBindingFrom({
      terminalId,
      terminalControl,
      pid: claudePid,
      nativeThreadId: BEFORE_ID,
      processUuid,
      evidence: "claude_agents_exact_pid",
      generation: 1,
      now: preparedAt
    }),
    lineage: { created_by: "attach" },
    created_at: preparedAt.toISOString(),
    updated_at: preparedAt.toISOString()
  }, { expectedRevision: null });
  const capabilities = probeClaudeThreadLifecycle("2.1.226");
  assert.equal(capabilities.status, "supported");
  const plan = planClaudeThreadLifecycle(
    { kind: "resume_thread", nativeThreadId: TARGET_ID },
    capabilities
  );
  let transition: NativeThreadTransition = {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: transitionId,
    operation: "resume_thread",
    status: "prepared",
    terminal_id: terminalId,
    agent: "claude",
    workspace,
    source_session_id: sourceSessionId,
    source_expected_revision: 1,
    target_session_id: targetSessionId,
    target_expected_revision: null,
    target_native_thread_id: TARGET_ID,
    before_native_thread_id: BEFORE_ID,
    before_process_uuid: processUuid,
    before_process_started_at: startedAt,
    before_binding: source.binding,
    adapter_version: "2.1.226",
    command_fingerprint: nativeThreadCommandFingerprint(
      JSON.stringify(plan.steps)
    ),
    dispatcher_pid: 2_000_000_000,
    prepared_at: preparedAt.toISOString()
  };
  transition = saveNativeThreadTransition(storeDir, transition, {
    expectedRevision: null
  });
  transition = saveNativeThreadTransition(storeDir, {
    ...transition,
    status: "dispatching",
    dispatching_at: "2026-08-06T04:00:01.000Z"
  }, { expectedRevision: 1 });
  transition = saveNativeThreadTransition(storeDir, {
    ...transition,
    status: "submitted",
    submitted_at: "2026-08-06T04:00:02.000Z"
  }, { expectedRevision: 2 });
  if (options.verified) {
    transition = saveNativeThreadTransition(storeDir, {
      ...transition,
      status: "verified",
      verified_at: "2026-08-06T04:00:03.000Z",
      after_binding: terminalBindingFrom({
        terminalId,
        terminalControl,
        pid: claudePid,
        nativeThreadId: TARGET_ID,
        processUuid,
        evidence: "claude_agents_exact_pid",
        generation: 1,
        now: new Date("2026-08-06T04:00:03.000Z")
      })
    }, { expectedRevision: 3 });
  }
  saveManagedSession(storeDir, {
    ...source,
    status: "transitioning",
    last_transition_id: transitionId,
    updated_at: "2026-08-06T04:00:01.000Z"
  }, { expectedRevision: 1 });
  const ledgerKey = createHash("sha256")
    .update(JSON.stringify({ target, socket_path: null }))
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
      target,
      socket_path: null,
      pane_pid: panePid,
      current_path: workspace
    },
    kind: "lifecycle",
    generation_id: transitionId,
    transition_id: transitionId,
    status: "submitted",
    operation: "resume_thread",
    terminal_id: terminalId,
    agent: "claude",
    workspace,
    adapter_version: "2.1.226",
    command_fingerprint: transition.command_fingerprint,
    source_session_id: sourceSessionId,
    target_session_id: targetSessionId,
    target_native_thread_id: TARGET_ID,
    before_native_thread_id: BEFORE_ID,
    before_process_uuid: processUuid,
    before_process_started_at: startedAt,
    store_dir: storeDir,
    prepared_at: transition.prepared_at,
    dispatching_at: transition.dispatching_at,
    submitted_at: transition.submitted_at,
    dispatcher_pid: 2_000_000_000,
    binding: source.binding
  })}\n`, { mode: 0o600 });
  const env = {
    ...process.env,
    PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH ?? ""}`,
    AKK_RUNTIME_DIR: runtimeDir
  };
  const claudeRows = () => {
    const sessionId = fs.readFileSync(currentIdPath, "utf8").trim();
    const row = {
      pid: claudePid,
      cwd: workspace,
      kind: "interactive",
      sessionId,
      startedAt,
      status: "idle"
    };
    if (fs.existsSync(agentsAmbiguousPath)) {
      return [row, { ...row }];
    }
    if (fs.existsSync(secondOwnerIdPath)) {
      return [row, {
        ...row,
        pid: claudePid + 1,
        sessionId: fs.readFileSync(secondOwnerIdPath, "utf8").trim(),
        startedAt: startedAt + 1
      }];
    }
    return [row];
  };
  const dependencies = terminalCliDependencies({
    terminalProvider,
    processSource,
    env,
    overrides: {
      loadClaudeAgentRows: () => claudeRows(),
      agentVersionForRunningProcess: () => "2.1.226"
    }
  });
  const commandArguments = (args: string[]) => [
    ...args,
    "--store-dir",
    storeDir
  ];
  const run = (args: string[]) =>
    runInProcessCli(commandArguments(args), dependencies);
  return {
    storeDir,
    terminalId,
    transitionId,
    targetSessionId,
    close: () => run([
      "close",
      "--conversation",
      terminalId,
      "--expected-transition-id",
      transitionId
    ]),
    setCurrentIdentity(id: string, composer?: string) {
      fs.writeFileSync(currentIdPath, id);
      fs.writeFileSync(
        screenPath,
        composer === undefined
          ? CLAUDE_CURRENT_EMPTY_COMPOSER
          : `Ready\n❯ ${composer}`
      );
    },
    source: () => listManagedSessions(storeDir).find((session) =>
      session.session_id === sourceSessionId
    )!,
    literalInputs: () => terminalProvider.literalInputs(),
    setAgentsAmbiguous: () => fs.writeFileSync(agentsAmbiguousPath, "1"),
    setSecondOwner: (id: string) => fs.writeFileSync(secondOwnerIdPath, id),
    debug: (result: InProcessCliResult | ReturnType<typeof spawnSync>) => JSON.stringify({
      status: result.status,
      signal: "signal" in result ? result.signal : undefined,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: terminalProvider.operations,
      screen: fs.readFileSync(screenPath, "utf8"),
      currentId: fs.readFileSync(currentIdPath, "utf8")
    }, null, 2),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function writeRecoveryFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  currentIdPath: string;
  probeCountPath: string;
  preProbeScreenPath: string;
  clearNoopPath: string;
  statusNoopPath: string;
  resolverErrorRequestPath: string;
  resolverErrorArmedPath: string;
  target: string;
  paneId: string;
  panePid: number;
  workspace: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `recovery-fixture\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\t\t${options.paneId}\n`
  )});
  process.exit(0);
}
if (args[0] === "display-message") {
  process.stdout.write("100\\t30\\n");
  process.exit(0);
}
if (args[0] === "capture-pane") {
  if (fs.existsSync(${JSON.stringify(options.resolverErrorRequestPath)})) {
    fs.writeFileSync(${JSON.stringify(options.resolverErrorArmedPath)}, "1");
  }
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("C-u")) {
  if (!fs.existsSync(${JSON.stringify(options.clearNoopPath)})) {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Ready\\n› ");
  }
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("-l")) {
  const text = args[args.length - 1];
  if (text === "/status") {
    fs.copyFileSync(
      ${JSON.stringify(options.screenPath)},
      ${JSON.stringify(options.preProbeScreenPath)}
    );
    fs.writeFileSync(
      ${JSON.stringify(options.screenPath)},
      ${JSON.stringify(CODEX_STATUS_COMPOSER)}
    );
  } else {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("C-m")) {
  if (fs.existsSync(${JSON.stringify(options.statusNoopPath)})) {
    fs.copyFileSync(
      ${JSON.stringify(options.preProbeScreenPath)},
      ${JSON.stringify(options.screenPath)}
    );
    process.exit(0);
  }
  const count = fs.existsSync(${JSON.stringify(options.probeCountPath)})
    ? Number(fs.readFileSync(${JSON.stringify(options.probeCountPath)}, "utf8")) + 1
    : 1;
  fs.writeFileSync(${JSON.stringify(options.probeCountPath)}, String(count));
  const id = fs.readFileSync(${JSON.stringify(options.currentIdPath)}, "utf8").trim();
  fs.writeFileSync(${JSON.stringify(options.screenPath)},
    "/status\\nprobe-" + count + "\\nSession: " + id + "\\n› ");
  process.exit(0);
}
`, { mode: 0o755 });
}

function writeRecoveryFakeProcessTools(options: {
  fakeBinDir: string;
  currentIdPath: string;
  rolloutPaths: Record<string, string>;
  executablePath: string;
  workspace: string;
  panePid: number;
  codexPid: number;
  secondCodexPid: number;
  processBirth: string;
  secondProcessBirth: string;
  secondOwnerIdPath: string;
  resolverErrorPath: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "ps"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pidIndex = args.indexOf("-p");
const requestedPid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : undefined;
const secondActive = fs.existsSync(${JSON.stringify(options.secondOwnerIdPath)});
if (args.includes("lstart=")) {
  process.stdout.write(requestedPid === ${options.secondCodexPid}
    ? ${JSON.stringify(`${options.secondProcessBirth}\n`)}
    : ${JSON.stringify(`${options.processBirth}\n`)});
} else {
  process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
    ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
    ${JSON.stringify(`${options.codexPid} ${options.panePid} 00:09 ${options.executablePath}\n`)} +
    (secondActive
      ? ${JSON.stringify(`${options.secondCodexPid} 1 00:08 ${options.executablePath}\n`)}
      : ""));
}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(options.fakeBinDir, "lsof"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const pidIndex = args.indexOf("-p");
const requestedPid = pidIndex >= 0 ? Number(args[pidIndex + 1]) : ${options.codexPid};
const secondActive = fs.existsSync(${JSON.stringify(options.secondOwnerIdPath)});
const selectedPid = secondActive && requestedPid === ${options.secondCodexPid}
  ? ${options.secondCodexPid}
  : ${options.codexPid};
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "codex " + selectedPid + " me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p" + selectedPid + "\\nftxt\\nn${options.executablePath}\\n");
} else {
  if (fs.existsSync(${JSON.stringify(options.resolverErrorPath)})) {
    process.stderr.write("resolver fixture failure\\n");
    process.exit(1);
  }
  const id = selectedPid === ${options.secondCodexPid}
    ? fs.readFileSync(${JSON.stringify(options.secondOwnerIdPath)}, "utf8").trim()
    : fs.readFileSync(${JSON.stringify(options.currentIdPath)}, "utf8").trim();
  const paths = ${JSON.stringify(options.rolloutPaths)};
  const rolloutPath = paths[id];
  if (rolloutPath) {
    const stat = fs.statSync(rolloutPath);
    process.stdout.write("p" + selectedPid + "\\nf12u\\ntREG\\nD" + stat.dev +
      "\\ni" + stat.ino + "\\nn" + rolloutPath + "\\n");
  }
}
`, { mode: 0o755 });
}

function writeClaudeRecoveryFakeTmux(options: {
  fakeBinDir: string;
  callsPath: string;
  screenPath: string;
  target: string;
  panePid: number;
  workspace: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "tmux"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(options.callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "list-panes") {
  process.stdout.write(${JSON.stringify(
    `claude-recovery\t0\t0\t${options.panePid}\tclaude\t${options.workspace}\n`
  )});
  process.exit(0);
}
if (args[0] === "capture-pane") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(options.screenPath)}, "utf8"));
  process.exit(0);
}
if (args[0] === "send-keys" && args.includes("C-u")) {
  fs.writeFileSync(
    ${JSON.stringify(options.screenPath)},
    ${JSON.stringify(CLAUDE_CURRENT_EMPTY_COMPOSER)}
  );
}
`, { mode: 0o755 });
}

function writeClaudeRecoveryFakeProcessTools(options: {
  fakeBinDir: string;
  currentIdPath: string;
  executablePath: string;
  workspace: string;
  panePid: number;
  claudePid: number;
  startedAt: number;
  agentsAmbiguousPath: string;
  secondOwnerIdPath: string;
}): void {
  fs.writeFileSync(path.join(options.fakeBinDir, "ps"), `#!/usr/bin/env node
process.stdout.write("  PID  PPID ELAPSED COMMAND\\n" +
  ${JSON.stringify(`${options.panePid} 1 00:10 zsh\n`)} +
  ${JSON.stringify(`${options.claudePid} ${options.panePid} 00:09 claude\n`)});
`, { mode: 0o755 });
  fs.writeFileSync(path.join(options.fakeBinDir, "lsof"), `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("cwd")) {
  process.stdout.write("COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME\\n" +
    "claude ${options.claudePid} me cwd DIR 1,18 64 123 ${options.workspace}\\n");
} else if (args.includes("txt")) {
  process.stdout.write("p${options.claudePid}\\nftxt\\nn${options.executablePath}\\n");
}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(options.fakeBinDir, "claude"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "agents") {
  const sessionId = fs.readFileSync(${JSON.stringify(options.currentIdPath)}, "utf8").trim();
  const row = {
    pid: ${options.claudePid},
    cwd: ${JSON.stringify(options.workspace)},
    kind: "interactive",
    sessionId,
    startedAt: ${options.startedAt},
    status: "idle"
  };
  const secondRow = {
    pid: ${options.claudePid + 1},
    cwd: ${JSON.stringify(options.workspace)},
    kind: "interactive",
    sessionId: fs.existsSync(${JSON.stringify(options.secondOwnerIdPath)})
      ? fs.readFileSync(${JSON.stringify(options.secondOwnerIdPath)}, "utf8").trim()
      : undefined,
    startedAt: ${options.startedAt + 1},
    status: "idle"
  };
  process.stdout.write(JSON.stringify(
    fs.existsSync(${JSON.stringify(options.agentsAmbiguousPath)})
      ? [row, { ...row }]
      : fs.existsSync(${JSON.stringify(options.secondOwnerIdPath)})
        ? [row, secondRow]
        : [row]
  ));
} else {
  process.stdout.write("2.1.226\\n");
}
`, { mode: 0o755 });
}

function readCalls(filePath: string): string[][] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs.readFileSync(filePath, "utf8")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line).args as string[]);
}

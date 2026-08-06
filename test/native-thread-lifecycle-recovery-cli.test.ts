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
import {
  listManagedSessions,
  loadNativeThreadTransition,
  saveManagedSession,
  saveNativeThreadTransition
} from "../src/session-store.js";
import { ensureStoreWritable, listConversations } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";

const binPath = new URL("../src/cli.js", import.meta.url).pathname;
const BEFORE_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_ID = "22222222-2222-4222-8222-222222222222";
const THIRD_ID = "33333333-3333-4333-8333-333333333333";

test("manual recovery clears a dispatching composer and rolls exact-before back without replay", () => {
  const fixture = seededCodexRecoveryFixture("dispatching");
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    const automaticallyBlocked = fixture.run([
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

    const recovered = fixture.close();
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

test("manual recovery rolls a submitted exact resume target forward without replay", () => {
  const fixture = seededCodexRecoveryFixture("submitted", {
    dispatcherPid: process.pid
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = fixture.close();
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

test("manual exact-after recovery fails closed when another Codex pid owns the target", () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setSecondOwner(TARGET_ID);
    const blocked = fixture.close();
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

test("manual exact-before rollback fails closed when another Codex pid owns the source thread", () => {
  const fixture = seededCodexRecoveryFixture("dispatching");
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    fixture.setSecondOwner(BEFORE_ID);
    const blocked = fixture.close();
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

test("target CAS failure never partially detaches the lifecycle source", () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.injectTargetConflict();
    const blocked = fixture.close();
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

test("manual recovery refuses to probe or submit when C-u does not empty the composer", () => {
  const fixture = seededCodexRecoveryFixture("dispatching");
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    fixture.setClearLineNoop();
    const blocked = fixture.close();
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

test("manual submitted recovery never probes /status over a non-empty Codex composer", () => {
  const fixture = seededCodexRecoveryFixture("submitted");
  try {
    fixture.setCurrentIdentity(TARGET_ID, "preserve this operator draft");
    const blocked = fixture.close();
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

test("manual dispatching recovery rolls a status-only recorded-before identity back", () => {
  const fixture = seededCodexRecoveryFixture("dispatching", {
    beforeRollout: false
  });
  try {
    fixture.setCurrentIdentity(BEFORE_ID, `/resume ${TARGET_ID}`);
    const recovered = fixture.close();
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

test("verified recovery refuses to roll forward when the resume candidate inode changed", () => {
  const fixture = seededCodexRecoveryFixture("verified", {
    targetCandidateInodeMismatch: true
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const blocked = fixture.close();
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

test("manual recovery keeps a submitted third identity quarantined and blocked", () => {
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
      const integrityBlocked = fixture.close();
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
    const recovered = fixture.close();
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

test("verified mismatch stays blocked and later exact-after evidence commits the same transition", () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(THIRD_ID);
    const blocked = fixture.close();
    assert.equal(blocked.status, 0, blocked.stderr);
    assert.equal(JSON.parse(blocked.stdout).terminal_dispatch_resolved, false);
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "verified"
    );
    assert.equal(fixture.source().status, "quarantined");

    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = fixture.close();
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

test("raw terminal send directly rolls a verified crash forward before one Session Turn", () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const sent = fixture.run([
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
    assert.equal(result.delivered, true);
    assert.equal(result.session_id, fixture.targetSessionId);
    assert.equal(listConversations(fixture.storeDir).length, 1);
    assert.equal(listManagedSessions(fixture.storeDir).length, 2);
    assert.equal(fixture.source().status, "detached");
    assert.equal(
      loadNativeThreadTransition(fixture.storeDir, fixture.transitionId).status,
      "committed"
    );
    assert.deepEqual(fixture.literalInputs(), [
      "/status",
      "Report the current branch."
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("verified no-rollout recovery rejects a stale Codex status screen", () => {
  const fixture = seededCodexRecoveryFixture("verified", {
    verifiedAfterRollout: false
  });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setStatusProbeNoop();
    const blocked = fixture.close();
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

test("verified rollout recovery fails closed on a Codex resolver error", () => {
  const fixture = seededCodexRecoveryFixture("verified");
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setResolverError();
    const blocked = fixture.close();
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

test("Claude manual recovery rolls exact-before back without lifecycle replay", () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(BEFORE_ID);
    const recovered = fixture.close();
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

test("Claude manual recovery rolls an exact submitted resume target forward", () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    const recovered = fixture.close();
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

test("Claude manual recovery keeps a third exact identity blocked", () => {
  const fixture = seededClaudeRecoveryFixture();
  try {
    fixture.setCurrentIdentity(THIRD_ID);
    const blocked = fixture.close();
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

test("Claude verified recovery fails closed on ambiguous exact-PID agents rows", () => {
  const fixture = seededClaudeRecoveryFixture({ verified: true });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setAgentsAmbiguous();
    const blocked = fixture.close();
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

test("Claude verified recovery fails closed when another pid owns the target", () => {
  const fixture = seededClaudeRecoveryFixture({ verified: true });
  try {
    fixture.setCurrentIdentity(TARGET_ID);
    fixture.setSecondOwner(TARGET_ID);
    const blocked = fixture.close();
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
  const clearNoopPath = path.join(root, "clear-noop");
  const statusNoopPath = path.join(root, "status-noop");
  const resolverErrorRequestPath = path.join(root, "resolver-error-request");
  const resolverErrorArmedPath = path.join(root, "resolver-error-armed");
  const secondOwnerIdPath = path.join(root, "second-owner-id.txt");
  const target = "recovery-fixture:0.0";
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
    clearNoopPath,
    statusNoopPath,
    resolverErrorRequestPath,
    resolverErrorArmedPath,
    target,
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
  const run = (args: string[]) => spawnSync(
    process.execPath,
    [
      binPath,
      ...args,
      "--store-dir",
      storeDir,
      "--codex-home",
      codexHome
    ],
    { encoding: "utf8", env, timeout: 30_000 }
  );
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
    literalInputs: () => readCalls(callsPath)
      .filter((args) => args[0] === "send-keys" && args.includes("-l"))
      .map((args) => args.at(-1) as string),
    keyDispatches: () => readCalls(callsPath)
      .filter((args) => args[0] === "send-keys" && !args.includes("-l")),
    setClearLineNoop: () => fs.writeFileSync(clearNoopPath, "1"),
    setStatusProbeNoop: () => fs.writeFileSync(statusNoopPath, "1"),
    setResolverError: () => fs.writeFileSync(resolverErrorRequestPath, "1"),
    setSecondOwner: (id: string) => fs.writeFileSync(secondOwnerIdPath, id),
    patchLedger(patch: Record<string, unknown>) {
      const current = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
      fs.writeFileSync(
        ledgerPath,
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
    debug: (result: ReturnType<typeof spawnSync>) => JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readCalls(callsPath),
      screen: fs.readFileSync(screenPath, "utf8")
    }, null, 2),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  };
}

function seededClaudeRecoveryFixture(
  options: { verified?: boolean } = {}
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
    "/Users/test/.local/share/claude/versions/2.1.218";
  fs.mkdirSync(fakeBinDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(currentIdPath, BEFORE_ID);
  fs.writeFileSync(screenPath, "Ready\n❯ ");
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
  const capabilities = probeClaudeThreadLifecycle("2.1.218");
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
    adapter_version: "2.1.218",
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
    adapter_version: "2.1.218",
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
  const run = (args: string[]) => spawnSync(
    process.execPath,
    [binPath, ...args, "--store-dir", storeDir],
    { encoding: "utf8", env, timeout: 30_000 }
  );
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
        composer === undefined ? "Ready\n❯ " : `Ready\n❯ ${composer}`
      );
    },
    source: () => listManagedSessions(storeDir).find((session) =>
      session.session_id === sourceSessionId
    )!,
    literalInputs: () => readCalls(callsPath)
      .filter((args) => args[0] === "send-keys" && args.includes("-l"))
      .map((args) => args.at(-1) as string),
    setAgentsAmbiguous: () => fs.writeFileSync(agentsAmbiguousPath, "1"),
    setSecondOwner: (id: string) => fs.writeFileSync(secondOwnerIdPath, id),
    debug: (result: ReturnType<typeof spawnSync>) => JSON.stringify({
      status: result.status,
      signal: result.signal,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: readCalls(callsPath),
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
  clearNoopPath: string;
  statusNoopPath: string;
  resolverErrorRequestPath: string;
  resolverErrorArmedPath: string;
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
    `recovery-fixture\t0\t0\t${options.panePid}\tcodex\t${options.workspace}\n`
  )});
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
    if (fs.existsSync(${JSON.stringify(options.statusNoopPath)})) {
      process.exit(0);
    }
    const count = fs.existsSync(${JSON.stringify(options.probeCountPath)})
      ? Number(fs.readFileSync(${JSON.stringify(options.probeCountPath)}, "utf8")) + 1
      : 1;
    fs.writeFileSync(${JSON.stringify(options.probeCountPath)}, String(count));
    const id = fs.readFileSync(${JSON.stringify(options.currentIdPath)}, "utf8").trim();
    fs.writeFileSync(${JSON.stringify(options.screenPath)},
      "/status\\nprobe-" + count + "\\nSession: " + id + "\\n› ");
  } else {
    fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Working\\n");
  }
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
  fs.writeFileSync(${JSON.stringify(options.screenPath)}, "Ready\\n❯ ");
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
  process.stdout.write("2.1.218\\n");
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collisionSafeNativeThreadShortIds,
  createNativeThreadResumeSnapshot,
  nativeThreadCandidateSnapshotFingerprint,
  nativeThreadResumeSnapshotRowsMatchCandidates,
  resolveNativeThreadResumeSelection,
  saveNativeThreadResumeSnapshot,
  sortNativeThreadCandidates,
  verifiedPreviousResumeCandidate
} from "../src/native-thread-resume-snapshot.js";
import type {
  ManagedSessionState,
  ManagedTerminalBinding,
  NativeThreadCandidate,
  NativeThreadTransition
} from "../src/managed-session.js";

const terminalId = "terminal:v2:tmux:codex:work:0.0:1234";
const workspace = "/private/work";
const storeDir = "/private/store";
const selectionScope = "openclaw:test-scope";

test("resume snapshot ordering and short ids are deterministic and collision-safe", () => {
  const ids = [
    "abcdef12-0000-4000-8000-000000000002",
    "abcdef12-0000-4000-8000-000000000001",
    "12345678-0000-4000-8000-000000000003"
  ];
  const shortIds = collisionSafeNativeThreadShortIds(ids);
  assert.equal(shortIds.get(ids[0]), "@abcdef12000040008000000000000002");
  assert.equal(shortIds.get(ids[1]), "@abcdef12000040008000000000000001");
  assert.equal(shortIds.get(ids[2]), "@12345678");

  const ordered = sortNativeThreadCandidates([
    candidate(ids[0], 100),
    candidate(ids[2], 200),
    candidate(ids[1], 100)
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.native_thread_id),
    [ids[2], ids[1], ids[0]]
  );
  assert.deepEqual(
    sortNativeThreadCandidates([...ordered].reverse()),
    ordered
  );
  assert.throws(
    () => collisionSafeNativeThreadShortIds([ids[0], ids[0].toUpperCase()]),
    /duplicate native thread ids/u
  );
});

test("number, short id, and opaque handle resolve only inside one exact snapshot scope", () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-resume-snapshot-")
  );
  const runtimeDir = path.join(tempDir, "runtime");
  const now = new Date("2026-08-07T03:00:00.000Z");
  try {
    const candidates = [
      candidate("11111111-1111-4111-8111-111111111111", 200, false),
      candidate("22222222-2222-4222-8222-222222222222", 100, true)
    ];
    const snapshot = createNativeThreadResumeSnapshot({
      storeDir,
      selectionScope,
      terminalId,
      agent: "codex",
      workspace,
      terminalControl: { target: "work:0.0", panePid: 1234 },
      currentSessionId: "session-current",
      currentNativeThreadId: candidates[0].native_thread_id,
      expectedBindingToken: "binding-token",
      terminalActionFingerprint: "a".repeat(64),
      candidates,
      now
    });
    saveNativeThreadResumeSnapshot(runtimeDir, storeDir, snapshot, now);
    const originalSnapshotPath = findSnapshot(runtimeDir, snapshot.snapshot_id);
    const selectedRow = snapshot.rows[1];
    for (const selector of [
      { snapshotId: snapshot.snapshot_id, selectionNumber: 2 },
      { snapshotId: snapshot.snapshot_id, shortId: selectedRow.short_id },
      { selectionHandle: selectedRow.selection_handle }
    ]) {
      const selected = resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId,
        selectionScope,
        ...selector,
        now: new Date(now.getTime() + 1)
      });
      assert.equal(selected.row.native_thread_id, candidates[1].native_thread_id);
      assert.equal(selected.row.candidate_token, candidates[1].candidate_token);
    }
    assert.throws(
      () => resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId: `${terminalId}-other`,
        selectionScope,
        snapshotId: snapshot.snapshot_id,
        selectionNumber: 2,
        now
      }),
      /another terminal or OpenClaw session/u
    );
    assert.throws(
      () => resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId,
        selectionScope: "openclaw:other",
        selectionHandle: selectedRow.selection_handle,
        now
      }),
      /another terminal or OpenClaw session/u
    );
    assert.throws(
      () => resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId,
        selectionScope,
        snapshotId: snapshot.snapshot_id,
        selectionNumber: 2,
        now: new Date(snapshot.expires_at)
      }),
      /expired/u
    );
    assert.equal(fs.statSync(originalSnapshotPath).mode & 0o777, 0o600);

    const tampered = structuredClone(snapshot);
    tampered.rows = [...tampered.rows].reverse().map((row, index) => ({
      ...row,
      selection_number: index + 1,
      selection_handle: `${tampered.snapshot_id}:${index + 1}`
    }));
    assert.equal(
      nativeThreadResumeSnapshotRowsMatchCandidates(tampered, candidates),
      false
    );

    const other = createNativeThreadResumeSnapshot({
      storeDir,
      selectionScope,
      terminalId,
      agent: "codex",
      workspace,
      terminalControl: { target: "work:0.0", panePid: 1234 },
      expectedBindingToken: "binding-token",
      terminalActionFingerprint: "a".repeat(64),
      candidates,
      now
    });
    saveNativeThreadResumeSnapshot(runtimeDir, storeDir, other, now);
    fs.copyFileSync(
      originalSnapshotPath,
      findSnapshot(runtimeDir, other.snapshot_id)
    );
    assert.throws(
      () => resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId,
        selectionScope,
        snapshotId: other.snapshot_id,
        selectionNumber: 2,
        now
      }),
      /malformed/u
    );

    const future = createNativeThreadResumeSnapshot({
      storeDir,
      selectionScope,
      terminalId,
      agent: "codex",
      workspace,
      terminalControl: { target: "work:0.0", panePid: 1234 },
      expectedBindingToken: "binding-token",
      terminalActionFingerprint: "a".repeat(64),
      candidates,
      now: new Date(now.getTime() + 60_000)
    });
    saveNativeThreadResumeSnapshot(runtimeDir, storeDir, future, now);
    assert.throws(
      () => resolveNativeThreadResumeSelection({
        runtimeDir,
        storeDir,
        terminalId,
        selectionScope,
        snapshotId: future.snapshot_id,
        selectionNumber: 2,
        now
      }),
      /from the future/u
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("the whole ordered candidate set participates in snapshot revalidation", () => {
  const first = candidate("11111111-1111-4111-8111-111111111111", 200);
  const second = candidate("22222222-2222-4222-8222-222222222222", 100);
  const baseline = nativeThreadCandidateSnapshotFingerprint([first, second]);
  assert.equal(
    nativeThreadCandidateSnapshotFingerprint([second, first]) === baseline,
    false,
    "a reordered displayed snapshot must not be reinterpreted"
  );
  assert.notEqual(
    nativeThreadCandidateSnapshotFingerprint([
      first,
      { ...second, candidate_token: "changed-token" }
    ]),
    baseline
  );
});

test("previous follows the latest committed transition through repeated A/B rebinding", () => {
  const nativeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const nativeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const bindingA = binding("binding-a", nativeA, 3);
  const bindingB = binding("binding-b", nativeB, 2);
  const sessionB = managedSession("session-b", bindingB, "transition-a-to-b", {
    created_by: "new_thread",
    previous_session_id: "session-old-static-lineage"
  });
  const aToB = transition({
    transitionId: "transition-a-to-b",
    operation: "new_thread",
    sourceSessionId: "session-a",
    targetSessionId: "session-b",
    beforeNativeThreadId: nativeA,
    beforeBinding: bindingA,
    afterBinding: bindingB
  });
  const candidateA = {
    ...candidate(nativeA, 100),
    managed_session_id: "session-a"
  };
  assert.equal(
    verifiedPreviousResumeCandidate({
      terminalId,
      agent: "codex",
      workspace,
      currentSession: sessionB,
      transition: aToB,
      candidates: [candidateA]
    })?.native_thread_id,
    nativeA
  );

  const refinedBindingB = {
    ...bindingB,
    last_verified_at: "2026-08-07T03:01:00.000Z",
    native_process: {
      ...bindingB.native_process,
      rollout: { fd: "12u", path: "/tmp/b.jsonl", device: "1", inode: "2" },
      evidence: "codex_rollout_fd"
    }
  };
  assert.equal(
    verifiedPreviousResumeCandidate({
      terminalId,
      agent: "codex",
      workspace,
      currentSession: managedSession(
        "session-b",
        refinedBindingB,
        "transition-a-to-b",
        sessionB.lineage
      ),
      transition: aToB,
      candidates: [candidateA]
    })?.native_thread_id,
    nativeA,
    "monotonic identity refinement must not erase committed previous provenance"
  );

  const sessionA = managedSession(
    "session-a",
    bindingA,
    "transition-b-to-a",
    { created_by: "attach", previous_session_id: "session-never-authoritative" }
  );
  const bToA = transition({
    transitionId: "transition-b-to-a",
    operation: "resume_thread",
    sourceSessionId: "session-b",
    targetSessionId: "session-a",
    beforeNativeThreadId: nativeB,
    beforeBinding: bindingB,
    afterBinding: bindingA
  });
  const candidateB = {
    ...candidate(nativeB, 100),
    managed_session_id: "session-b"
  };
  assert.equal(
    verifiedPreviousResumeCandidate({
      terminalId,
      agent: "codex",
      workspace,
      currentSession: sessionA,
      transition: bToA,
      candidates: [candidateB]
    })?.native_thread_id,
    nativeB
  );
  assert.equal(
    verifiedPreviousResumeCandidate({
      terminalId,
      agent: "codex",
      workspace,
      currentSession: sessionA,
      transition: { ...bToA, status: "uncertain", committed_at: undefined },
      candidates: [candidateB]
    }),
    undefined
  );
  assert.equal(
    verifiedPreviousResumeCandidate({
      terminalId,
      agent: "codex",
      workspace,
      currentSession: sessionA,
      transition: bToA,
      candidates: [{ ...candidateB, resumable: false, unavailable_reason: "active_elsewhere" }]
    }),
    undefined
  );
});

function candidate(
  nativeThreadId: string,
  updatedAtMs: number,
  resumable = true
): NativeThreadCandidate {
  return {
    native_thread_id: nativeThreadId,
    candidate_token: `token-${nativeThreadId}`,
    agent: "codex",
    workspace,
    updated_at_ms: updatedAtMs,
    updated_at: new Date(updatedAtMs).toISOString(),
    resumable,
    unavailable_reason: resumable ? undefined : "already_active"
  };
}

function findSnapshot(runtimeDir: string, snapshotId: string): string {
  const root = path.join(runtimeDir, "resume-snapshots");
  const storeKey = fs.readdirSync(root)[0];
  return path.join(root, storeKey, `${snapshotId}.json`);
}

function binding(
  bindingId: string,
  nativeThreadId: string,
  generation: number
): ManagedTerminalBinding {
  return {
    binding_id: bindingId,
    generation,
    terminal_id: terminalId,
    terminal_control: {
      kind: "tmux",
      target: "work:0.0",
      session: "work",
      window: 0,
      pane: 0,
      panePid: 1234,
      currentCommand: "codex",
      currentPath: workspace,
      capabilities: []
    },
    native_thread_id: nativeThreadId,
    native_process: {
      pid: 1235,
      process_uuid: "codex-process",
      process_birth: "Fri Aug  7 03:00:00 2026",
      evidence: "codex_status_card"
    },
    bound_at: "2026-08-07T03:00:00.000Z",
    last_verified_at: "2026-08-07T03:00:00.000Z"
  };
}

function managedSession(
  sessionId: string,
  terminalBinding: ManagedTerminalBinding,
  lastTransitionId: string,
  lineage: ManagedSessionState["lineage"]
): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    revision: 1,
    session_id: sessionId,
    agent: "codex",
    workspace,
    status: "bound",
    binding: terminalBinding,
    lineage,
    created_at: "2026-08-07T03:00:00.000Z",
    updated_at: "2026-08-07T03:00:00.000Z",
    last_transition_id: lastTransitionId
  };
}

function transition({
  transitionId,
  operation,
  sourceSessionId,
  targetSessionId,
  beforeNativeThreadId,
  beforeBinding,
  afterBinding
}: {
  transitionId: string;
  operation: NativeThreadTransition["operation"];
  sourceSessionId: string;
  targetSessionId: string;
  beforeNativeThreadId: string;
  beforeBinding: ManagedTerminalBinding;
  afterBinding: ManagedTerminalBinding;
}): NativeThreadTransition {
  return {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    revision: 6,
    transition_id: transitionId,
    operation,
    status: "committed",
    terminal_id: terminalId,
    agent: "codex",
    workspace,
    source_session_id: sourceSessionId,
    source_expected_revision: 1,
    target_session_id: targetSessionId,
    target_expected_revision: null,
    target_native_thread_id: afterBinding.native_thread_id,
    before_native_thread_id: beforeNativeThreadId,
    before_process_uuid: "codex-process",
    before_process_birth: "Fri Aug  7 03:00:00 2026",
    before_binding: beforeBinding,
    after_binding: afterBinding,
    adapter_version: "0.146.1",
    command_fingerprint: "f".repeat(64),
    dispatcher_pid: 999,
    prepared_at: "2026-08-07T03:00:00.000Z",
    dispatching_at: "2026-08-07T03:00:01.000Z",
    submitted_at: "2026-08-07T03:00:02.000Z",
    verified_at: "2026-08-07T03:00:03.000Z",
    committed_at: "2026-08-07T03:00:04.000Z"
  };
}

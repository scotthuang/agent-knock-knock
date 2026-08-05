import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  managedSessionStorageKey,
  nativeThreadCommandFingerprint,
  terminalBindingFrom,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../src/managed-session.js";
import {
  listManagedSessions,
  loadManagedSession,
  ManagedSessionConflictError,
  ManagedSessionNativeThreadConflictError,
  ManagedSessionStateMissingError,
  NativeThreadTransitionConflictError,
  pathsForManagedSession,
  saveNativeThreadTransition,
  saveManagedSession,
  tryLoadManagedSession
} from "../src/session-store.js";
import { ensureStoreWritable } from "../src/store.js";

const NATIVE_THREAD_ID = "00000000-0000-4000-8000-000000000201";
const AFTER_NATIVE_THREAD_ID = "00000000-0000-4000-8000-000000000202";

function candidate(sessionId = "session/cas/会话"): ManagedSessionState {
  const now = new Date("2026-08-06T02:00:00.000Z");
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: sessionId,
    agent: "claude",
    workspace: "/workspace/project",
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: "tmux:claude:akk:0.0:100",
      terminalControl: {
        kind: "tmux",
        target: "akk:0.0",
        session: "akk",
        window: 0,
        pane: 0,
        panePid: 100,
        currentCommand: "claude",
        currentPath: "/workspace/project",
        capabilities: ["screen_status", "send_keys", "durable_completion"]
      },
      pid: 200,
      nativeThreadId: NATIVE_THREAD_ID,
      processUuid: "process-incarnation-1",
      evidence: "claude_process_uuid",
      generation: 1,
      now
    }),
    lineage: { created_by: "attach" },
    created_at: now.toISOString(),
    updated_at: now.toISOString()
  };
}

test("Session paths use only the SHA-256 of an arbitrary session_id", () => {
  const storeDir = "/tmp/akk-session-path-test";
  const sessionId = "../../not/a/path/会话";
  const paths = pathsForManagedSession(sessionId, storeDir);
  assert.equal(
    paths.directory,
    path.join(storeDir, "sessions", managedSessionStorageKey(sessionId))
  );
  assert.equal(path.dirname(paths.directory), path.join(storeDir, "sessions"));
  assert.equal(path.basename(paths.directory).length, 64);
  assert.doesNotMatch(paths.directory, /not\/a\/path/u);
});

test("managed Session writes use explicit revision CAS", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-cas-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const initial = candidate();
    const created = saveManagedSession(storeDir, initial, {
      expectedRevision: null
    });
    assert.equal(created.revision, 1);
    assert.equal(loadManagedSession(storeDir, initial.session_id).revision, 1);

    const quarantined = saveManagedSession(storeDir, {
      ...created,
      status: "quarantined",
      quarantine_reason: "operator reconciliation required",
      updated_at: "2026-08-06T02:01:00.000Z"
    }, { expectedRevision: 1 });
    assert.equal(quarantined.revision, 2);

    assert.throws(
      () => saveManagedSession(storeDir, {
        ...created,
        status: "detached",
        detached_at: "2026-08-06T02:02:00.000Z",
        updated_at: "2026-08-06T02:02:00.000Z"
      }, { expectedRevision: 1 }),
      (error: unknown) =>
        error instanceof ManagedSessionConflictError &&
        error.expectedRevision === 1 &&
        error.actualRevision === 2
    );
    assert.equal(
      loadManagedSession(storeDir, initial.session_id).status,
      "quarantined"
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("one agent native thread cannot be claimed by two managed Sessions", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-native-unique-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const first = saveManagedSession(storeDir, candidate("session-native-first"), {
      expectedRevision: null
    });
    saveManagedSession(storeDir, {
      ...first,
      status: "detached",
      detached_at: "2026-08-06T02:01:00.000Z",
      updated_at: "2026-08-06T02:01:00.000Z"
    }, { expectedRevision: 1 });

    const second = candidate("session-native-second");
    assert.throws(
      () => saveManagedSession(storeDir, second, { expectedRevision: null }),
      (error: unknown) =>
        error instanceof ManagedSessionNativeThreadConflictError &&
        error.sessionId === "session-native-second" &&
        error.nativeThreadId === NATIVE_THREAD_ID &&
        error.conflictingSessionIds.length === 1 &&
        error.conflictingSessionIds[0] === "session-native-first"
    );
    assert.throws(
      () => loadManagedSession(storeDir, "session-native-second"),
      ManagedSessionStateMissingError
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("native thread transition writes reject stale revisions and status regression", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-transition-cas-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const prepared: NativeThreadTransition = {
      schema: "agent-knock-knock/native-thread-transition",
      version: 1,
      transition_id: "transition-cas-test",
      operation: "new_thread",
      status: "prepared",
      terminal_id: "terminal:v2:tmux:codex:akk:0.0:200",
      agent: "codex",
      workspace: "/workspace/project",
      target_session_id: "session-transition-target",
      target_expected_revision: null,
      before_native_thread_id: NATIVE_THREAD_ID,
      before_process_uuid: "codex-pid:200:birth:fixture",
      before_process_birth: "fixture",
      adapter_version: "0.146.0",
      command_fingerprint: nativeThreadCommandFingerprint("/clear"),
      dispatcher_pid: 999,
      prepared_at: "2026-08-06T02:00:00.000Z"
    };
    const created = saveNativeThreadTransition(storeDir, prepared, {
      expectedRevision: null
    });
    assert.equal(created.revision, 1);
    const dispatching = saveNativeThreadTransition(storeDir, {
      ...created,
      status: "dispatching",
      dispatching_at: "2026-08-06T02:00:01.000Z"
    }, { expectedRevision: 1 });
    assert.equal(dispatching.revision, 2);
    assert.throws(
      () => saveNativeThreadTransition(storeDir, {
        ...created,
        status: "aborted",
        aborted_at: "2026-08-06T02:00:02.000Z"
      }, { expectedRevision: 1 }),
      (error: unknown) =>
        error instanceof NativeThreadTransitionConflictError &&
        error.actualRevision === 2
    );
    assert.throws(
      () => saveNativeThreadTransition(storeDir, {
        ...dispatching,
        status: "prepared"
      }, { expectedRevision: 2 }),
      /cannot move from dispatching to prepared/u
    );
    const submitted = saveNativeThreadTransition(storeDir, {
      ...dispatching,
      status: "submitted",
      submitted_at: "2026-08-06T02:00:02.000Z"
    }, { expectedRevision: 2 });
    const verified = saveNativeThreadTransition(storeDir, {
      ...submitted,
      status: "verified",
      verified_at: "2026-08-06T02:00:03.000Z",
      after_binding: terminalBindingFrom({
        terminalId: prepared.terminal_id,
        terminalControl: {
          kind: "tmux",
          target: "akk:0.0",
          session: "akk",
          window: 0,
          pane: 0,
          panePid: 100,
          currentCommand: "codex",
          currentPath: prepared.workspace,
          capabilities: ["screen_status", "send_keys", "durable_completion"]
        },
        pid: 200,
        nativeThreadId: AFTER_NATIVE_THREAD_ID,
        processUuid: "codex-pid:200:birth:fixture",
        processBirth: "fixture",
        evidence: "codex_status_card+process_birth",
        generation: 1,
        now: new Date("2026-08-06T02:00:03.000Z")
      })
    }, { expectedRevision: 3 });
    const committed = saveNativeThreadTransition(storeDir, {
      ...verified,
      status: "committed",
      committed_at: "2026-08-06T02:00:04.000Z"
    }, { expectedRevision: 4 });
    assert.throws(
      () => saveNativeThreadTransition(storeDir, {
        ...committed,
        status: "verified"
      }, { expectedRevision: 5 }),
      /cannot move from committed to verified/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("binding replacements require a fresh id and generation +1", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-binding-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveManagedSession(storeDir, candidate("session-binding"), {
      expectedRevision: null
    });
    const wrongGeneration: ManagedSessionState = {
      ...created,
      binding: {
        ...created.binding!,
        binding_id: "binding-replacement",
        native_thread_id: "00000000-0000-4000-8000-000000000202"
      },
      updated_at: "2026-08-06T02:01:00.000Z"
    };
    assert.throws(
      () => saveManagedSession(storeDir, wrongGeneration, {
        expectedRevision: 1
      }),
      /binding replacement must use a new id and generation 2/u
    );

    const replaced = saveManagedSession(storeDir, {
      ...wrongGeneration,
      binding: { ...wrongGeneration.binding!, generation: 2 }
    }, { expectedRevision: 1 });
    assert.equal(replaced.revision, 2);
    assert.equal(replaced.binding?.generation, 2);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("a provisional binding may only gain native identity evidence in place", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-refine-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const initial = candidate("session-provisional-refinement");
    const provisional = saveManagedSession(storeDir, {
      ...initial,
      binding: {
        ...initial.binding!,
        native_thread_id: undefined,
        native_process: {
          pid: initial.binding!.native_process.pid,
          evidence: "native_thread_boundary"
        }
      }
    }, { expectedRevision: null });
    const rollout = {
      fd: "12u",
      device: "1",
      inode: "4242",
      path: "/tmp/akk-refined-rollout.jsonl"
    };
    const refinedAt = "2026-08-06T02:01:00.000Z";
    const refined = saveManagedSession(storeDir, {
      ...provisional,
      binding: {
        ...provisional.binding!,
        native_thread_id: NATIVE_THREAD_ID,
        native_process: {
          ...provisional.binding!.native_process,
          process_uuid: "process-incarnation-refined",
          process_birth: "Thu Aug  6 10:00:00 2026",
          rollout,
          evidence: "codex_rollout_fd"
        },
        last_verified_at: refinedAt
      },
      updated_at: refinedAt
    }, { expectedRevision: 1 });

    assert.equal(refined.revision, 2);
    assert.equal(refined.binding?.binding_id, provisional.binding?.binding_id);
    assert.equal(refined.binding?.generation, provisional.binding?.generation);
    assert.equal(refined.binding?.native_thread_id, NATIVE_THREAD_ID);
    assert.equal(
      refined.binding?.native_process.process_uuid,
      "process-incarnation-refined"
    );
    assert.deepEqual(refined.binding?.native_process.rollout, rollout);

    const forbiddenMutations: Array<[string, ManagedSessionState]> = [
      ["native thread", {
        ...refined,
        binding: {
          ...refined.binding!,
          native_thread_id: AFTER_NATIVE_THREAD_ID
        }
      }],
      ["process UUID", {
        ...refined,
        binding: {
          ...refined.binding!,
          native_process: {
            ...refined.binding!.native_process,
            process_uuid: "replacement-process"
          }
        }
      }],
      ["process birth", {
        ...refined,
        binding: {
          ...refined.binding!,
          native_process: {
            ...refined.binding!.native_process,
            process_birth: "replacement-birth"
          }
        }
      }],
      ["rollout", {
        ...refined,
        binding: {
          ...refined.binding!,
          native_process: {
            ...refined.binding!.native_process,
            rollout: { ...rollout, inode: "9999" }
          }
        }
      }],
      ["terminal", {
        ...refined,
        binding: {
          ...refined.binding!,
          terminal_id: "tmux:claude:other:0.0:100"
        }
      }],
      ["PID", {
        ...refined,
        binding: {
          ...refined.binding!,
          native_process: {
            ...refined.binding!.native_process,
            pid: 201
          }
        }
      }],
      ["bound timestamp", {
        ...refined,
        binding: {
          ...refined.binding!,
          bound_at: "2026-08-06T02:02:00.000Z"
        }
      }]
    ];
    for (const [label, mutation] of forbiddenMutations) {
      assert.throws(
        () => saveManagedSession(storeDir, mutation, { expectedRevision: 2 }),
        /cannot (?:replace verified binding|mutate an existing binding identity)/u,
        `${label} must not be mutable within one binding generation`
      );
    }
    assert.equal(loadManagedSession(storeDir, refined.session_id).revision, 2);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("protocol 3 missing Session state fails closed instead of returning a Turn fallback", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-missing-"));
  const storeDir = path.join(sandbox, "store");
  try {
    ensureStoreWritable(storeDir);
    assert.throws(
      () => loadManagedSession(storeDir, "session-missing"),
      (error: unknown) => error instanceof ManagedSessionStateMissingError
    );
    assert.equal(
      tryLoadManagedSession(storeDir, "session-missing"),
      undefined
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("listing validates the hash key and strict nested state", () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-session-strict-"));
  const storeDir = path.join(sandbox, "store");
  try {
    const created = saveManagedSession(storeDir, candidate("session-strict"), {
      expectedRevision: null
    });
    const paths = pathsForManagedSession(created.session_id, storeDir);
    const malformed: any = JSON.parse(fs.readFileSync(paths.statePath, "utf8"));
    malformed.binding.terminal_control.capabilities.push("arbitrary_input");
    fs.writeFileSync(paths.statePath, `${JSON.stringify(malformed, null, 2)}\n`);
    assert.throws(
      () => listManagedSessions(storeDir),
      /terminal_control capabilities are invalid/u
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

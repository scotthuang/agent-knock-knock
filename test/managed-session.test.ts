import test from "node:test";
import assert from "node:assert/strict";
import {
  assertManagedSessionState,
  assertNativeThreadTransition,
  legacyManagedSessionBindingToken,
  legacyUnmanagedTerminalBindingToken,
  managedSessionBindingToken,
  managedSessionStorageKey,
  nativeThreadCommandFingerprint,
  terminalBindingFrom,
  unmanagedTerminalBindingToken,
  type ManagedSessionState,
  type NativeThreadTransition
} from "../src/managed-session.js";

const NATIVE_THREAD_ID = "00000000-0000-4000-8000-000000000101";
const AFTER_NATIVE_THREAD_ID = "00000000-0000-4000-8000-000000000102";

function binding(generation = 1) {
  return terminalBindingFrom({
    terminalId: "tmux:codex:akk:0.0:123",
    terminalControl: {
      kind: "tmux",
      target: "akk:0.0",
      session: "akk",
      window: 0,
      pane: 0,
      panePid: 123,
      currentCommand: "codex",
      currentPath: "/workspace/project",
      capabilities: ["screen_status", "send_keys", "durable_completion"]
    },
    pid: 456,
    nativeThreadId: NATIVE_THREAD_ID,
    processUuid: "codex-pid:456:birth:12345",
    processBirth: "12345",
    rollout: {
      fd: "7",
      device: "1",
      inode: "999",
      path: "/tmp/rollout.jsonl"
    },
    evidence: "codex_rollout_fd",
    generation,
    now: new Date("2026-08-06T01:00:00.000Z")
  });
}

function state(): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session/with arbitrary unicode/会话",
    revision: 1,
    agent: "codex",
    workspace: "/workspace/project",
    status: "bound",
    binding: binding(),
    lineage: { created_by: "attach" },
    created_at: "2026-08-06T01:00:00.000Z",
    updated_at: "2026-08-06T01:00:00.000Z"
  };
}

test("managed Session storage keys are deterministic SHA-256 of arbitrary ids", () => {
  const key = managedSessionStorageKey("session/with arbitrary unicode/会话");
  assert.match(key, /^[0-9a-f]{64}$/u);
  assert.equal(
    key,
    "ac1e5a4c2d95fb08be0b58dff731cd34a8081464bbd27fb325288e0a2323f40c"
  );
});

test("v0.11.6 managed and unmanaged binding tokens remain bit-for-bit stable", () => {
  const rollout = {
    fd: "11",
    device: "16777234",
    inode: "987654321",
    path: "/Users/example/.codex/sessions/2026/08/10/rollout-legacy.jsonl"
  };
  const terminalControl = {
    kind: "tmux" as const,
    target: "legacy:0.1",
    socketPath: "/private/tmp/tmux-501/default",
    session: "legacy",
    window: 0,
    pane: 1,
    panePid: 2345,
    currentCommand: "codex",
    currentPath: "/Users/example/project",
    capabilities: [
      "screen_status" as const,
      "send_keys" as const,
      "durable_completion" as const
    ]
  };
  const managed = {
    session_id: "session-20260810T010203-legacy01",
    status: "bound" as const,
    binding: {
      binding_id: "binding-11111111-2222-4333-8444-555555555555",
      generation: 7,
      terminal_id: "terminal:v2:tmux:codex:legacy:0.1:2345",
      terminal_control: terminalControl,
      native_thread_id: "11111111-2222-4333-8444-555555555555",
      native_process: {
        pid: 3456,
        process_uuid: "codex-pid:3456:birth:98765",
        process_birth: "98765",
        rollout,
        evidence: "codex_rollout_fd"
      },
      bound_at: "2026-08-10T01:02:03.000Z",
      last_verified_at: "2026-08-10T01:02:04.000Z"
    }
  } satisfies Pick<ManagedSessionState, "session_id" | "status" | "binding">;
  const unmanaged = {
    terminalId: managed.binding.terminal_id,
    terminalControl,
    agent: "codex" as const,
    pid: managed.binding.native_process.pid,
    workspace: "/Users/example/project",
    nativeThreadId: managed.binding.native_thread_id,
    processUuid: managed.binding.native_process.process_uuid,
    processBirth: managed.binding.native_process.process_birth,
    rollout
  };

  const expectedManaged =
    "6be676d249acf8271f5228f6e372498c3efeb01a9aa959217ff1eaf09d72ed9c";
  const expectedUnmanaged =
    "23a42e69ada94dd5ba890ba208752d58b47e17b2b58582fd23091384042e0417";
  assert.equal(legacyManagedSessionBindingToken(managed), expectedManaged);
  assert.equal(managedSessionBindingToken(managed), expectedManaged);
  assert.equal(legacyUnmanagedTerminalBindingToken(unmanaged), expectedUnmanaged);
  assert.equal(unmanagedTerminalBindingToken(unmanaged), expectedUnmanaged);
});

test("managed Session validation is strict throughout nested binding state", () => {
  const valid = state();
  assert.doesNotThrow(() => assertManagedSessionState(valid));

  const malformedPid = structuredClone(valid) as any;
  malformedPid.binding.native_process.pid = "456";
  assert.throws(
    () => assertManagedSessionState(malformedPid),
    /native_process pid must be a positive safe integer/u
  );

  const unknownNestedField = structuredClone(valid) as any;
  unknownNestedField.binding.terminal_control.shell = "zsh";
  assert.throws(
    () => assertManagedSessionState(unknownNestedField),
    /terminal_control contains unsupported field shell/u
  );

  const partialRollout = structuredClone(valid) as any;
  delete partialRollout.binding.native_process.rollout.inode;
  assert.throws(
    () => assertManagedSessionState(partialRollout),
    /rollout inode must be a non-empty string/u
  );
});

test("transition schema distinguishes prepared from dispatching uncertainty", () => {
  const prepared: NativeThreadTransition = {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: "transition-test",
    revision: 1,
    operation: "new_thread",
    status: "prepared",
    terminal_id: "tmux:codex:akk:0.0:123",
    agent: "codex",
    workspace: "/workspace/project",
    target_session_id: "session-target",
    target_expected_revision: null,
    before_native_thread_id: NATIVE_THREAD_ID,
    before_process_uuid: "codex-pid:456:birth:12345",
    before_process_birth: "12345",
    adapter_version: "codex/1",
    command_fingerprint: nativeThreadCommandFingerprint("/new"),
    dispatcher_pid: 789,
    prepared_at: "2026-08-06T01:00:00.000Z"
  };
  assert.doesNotThrow(() => assertNativeThreadTransition(prepared));

  const dispatching: NativeThreadTransition = {
    ...prepared,
    status: "dispatching",
    dispatching_at: "2026-08-06T01:00:01.000Z"
  };
  assert.doesNotThrow(() => assertNativeThreadTransition(dispatching));
  const missingBoundary: any = { ...dispatching };
  delete missingBoundary.dispatching_at;
  assert.throws(
    () => assertNativeThreadTransition(missingBoundary),
    /dispatching transition requires dispatching_at/u
  );

  const uncertainBeforeReturn: NativeThreadTransition = {
    ...dispatching,
    status: "uncertain",
    uncertain_at: "2026-08-06T01:00:02.000Z",
    do_not_retry: true
  };
  assert.doesNotThrow(() => assertNativeThreadTransition(uncertainBeforeReturn));

  assert.throws(
    () => assertNativeThreadTransition({
      ...prepared,
      target_native_thread_id: AFTER_NATIVE_THREAD_ID
    }),
    /new_thread cannot carry target_native_thread_id/u
  );

  const withBeforeBinding: NativeThreadTransition = {
    ...prepared,
    source_session_id: "session-source",
    source_expected_revision: 1,
    before_process_rollout: binding().native_process.rollout,
    before_binding: binding()
  };
  assert.doesNotThrow(() => assertNativeThreadTransition(withBeforeBinding));
  assert.throws(
    () => assertNativeThreadTransition({
      ...withBeforeBinding,
      before_process_uuid: "codex-pid:999:birth:12345"
    }),
    /before_binding disagrees with prepare identity/u
  );

  const verified: NativeThreadTransition = {
    ...dispatching,
    status: "verified",
    submitted_at: "2026-08-06T01:00:02.000Z",
    verified_at: "2026-08-06T01:00:03.000Z",
    after_binding: {
      ...binding(),
      binding_id: "binding-after",
      native_thread_id: AFTER_NATIVE_THREAD_ID,
      native_process: {
        ...binding().native_process,
        rollout: {
          fd: "8",
          device: "1",
          inode: "1000",
          path: "/tmp/rollout-after.jsonl"
        }
      }
    }
  };
  assert.doesNotThrow(() => assertNativeThreadTransition(verified));
  assert.throws(
    () => assertNativeThreadTransition({
      ...verified,
      after_binding: {
        ...verified.after_binding!,
        native_thread_id: NATIVE_THREAD_ID
      }
    }),
    /after_binding does not satisfy its operation/u
  );
  assert.throws(
    () => assertNativeThreadTransition({
      ...verified,
      status: "submitted",
      verified_at: undefined
    }),
    /cannot carry after_binding before verification/u
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decideTerminalBindingMatch,
  terminalObservationFromListEntry,
  terminalObservationFromResolvedIdentity,
  type TerminalBindingMatchEvidence,
  type TerminalObservation
} from "../src/terminal-binding-authority.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import { createConversation } from "../src/protocol.js";
import { saveManagedSession } from "../src/session-store.js";
import { ensureStoreWritable } from "../src/store.js";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import {
  createTerminalTurnBindingAuthorityCliAdapter
} from "../src/terminal-turn-binding-authority-cli-adapter.js";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0101";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102";
const PROCESS_UUID = "codex-pid:4100:birth:12345";
const PROCESS_BIRTH = "12345";
const ROLLOUT = {
  fd: "12",
  device: "1,18",
  inode: "42",
  path: "/safe/sessions/rollout.jsonl"
};

function terminalControl(): TerminalControlRef {
  return {
    kind: "tmux",
    target: "work:0.0",
    socketPath: "/private/tmp/tmux-501/default",
    session: "work",
    window: 0,
    pane: 0,
    panePid: 4_000,
    currentCommand: "codex",
    currentPath: "/repo",
    capabilities: ["screen_status", "send_keys"]
  };
}

function managedSession(
  overrides: Partial<ManagedSessionState> = {}
): ManagedSessionState {
  const control = terminalControl();
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-authority-a",
    revision: 1,
    agent: "codex",
    workspace: "/repo",
    status: "bound",
    binding: {
      binding_id: "binding-authority-a",
      generation: 1,
      terminal_id: "terminal:v2:tmux:codex:work:0.0:4100",
      terminal_control: control,
      native_thread_id: THREAD_A,
      native_process: {
        pid: 4_100,
        process_uuid: PROCESS_UUID,
        process_birth: PROCESS_BIRTH,
        rollout: ROLLOUT,
        evidence: "codex_rollout_fd"
      },
      bound_at: "2026-08-14T00:00:00.000Z",
      last_verified_at: "2026-08-14T00:00:00.000Z"
    },
    lineage: { created_by: "attach" },
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

function resolvedObservation(
  overrides: Partial<TerminalObservation> = {}
): TerminalObservation {
  return {
    agent: "codex",
    pid: 4_100,
    nativeIdentity: {
      status: "resolved",
      identity: {
        sessionId: THREAD_A,
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH,
        rollout: ROLLOUT,
        evidence: "codex_rollout_fd"
      }
    },
    processIncarnation: {
      processUuid: PROCESS_UUID,
      processBirth: PROCESS_BIRTH
    },
    ...overrides
  };
}

const MATCHING_EVIDENCE: TerminalBindingMatchEvidence = {
  terminalAliasMatches: true,
  workspaceMatches: true
};

test("list observation adapter preserves resolved and no-identity evidence", () => {
  const resolved = terminalObservationFromListEntry({
    pid: 4_100,
    native_agent_session_id: THREAD_A,
    native_agent_process_uuid: PROCESS_UUID,
    native_agent_process_birth: PROCESS_BIRTH,
    native_agent_rollout: ROLLOUT,
    native_agent_identity_evidence: "codex_rollout_fd",
    native_agent_status_card_session_id: THREAD_A
  }, "codex");
  assert.deepEqual(resolved, {
    ...resolvedObservation(),
    statusCardNativeThreadId: THREAD_A,
    codexOpenRootInventory: undefined
  });

  assert.deepEqual(
    terminalObservationFromListEntry({
      pid: 4_100,
      native_agent_identity_observation: {
        status: "verified_absent",
        evidence: "native_identity_resolver_verified_absent"
      }
    }, "codex").nativeIdentity,
    {
      status: "verified_absent",
      evidence: "native_identity_resolver_verified_absent"
    }
  );
  assert.deepEqual(
    terminalObservationFromListEntry({
      pid: 4_100,
      native_agent_identity_observation: {
        status: "unavailable",
        reason: "inventory unavailable"
      }
    }, "codex").nativeIdentity,
    { status: "unavailable", reason: "inventory unavailable" }
  );
  assert.deepEqual(
    terminalObservationFromListEntry({ pid: 4_100 }, "codex").nativeIdentity,
    { status: "not_observed" }
  );
});

test("mutation observation adapter never imports list-only supplemental evidence", () => {
  const identity = resolvedObservation().nativeIdentity;
  assert.equal(identity.status, "resolved");
  assert.deepEqual(
    terminalObservationFromResolvedIdentity({
      agent: "codex",
      pid: 4_100,
      identity: identity.identity,
      processIncarnation: {
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH
      }
    }),
    resolvedObservation()
  );
  assert.deepEqual(
    terminalObservationFromResolvedIdentity({
      agent: "codex",
      pid: 4_100,
      identity: undefined,
      processIncarnation: {
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH
      }
    }),
    {
      agent: "codex",
      pid: 4_100,
      nativeIdentity: { status: "not_observed" },
      processIncarnation: {
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH
      }
    }
  );
});

test("exact binding policy rejects every structural authority mismatch", () => {
  const session = managedSession();
  const observation = resolvedObservation();
  const cases: Array<{
    name: string;
    session: ManagedSessionState;
    observation: TerminalObservation;
    evidence: TerminalBindingMatchEvidence;
    reason: string;
  }> = [
    {
      name: "session status",
      session: managedSession({ status: "detached" }),
      observation,
      evidence: MATCHING_EVIDENCE,
      reason: "session_not_bound"
    },
    {
      name: "missing binding",
      session: managedSession({ binding: undefined }),
      observation,
      evidence: MATCHING_EVIDENCE,
      reason: "missing_binding"
    },
    {
      name: "agent",
      session,
      observation: resolvedObservation({ agent: "claude" }),
      evidence: MATCHING_EVIDENCE,
      reason: "agent_mismatch"
    },
    {
      name: "pid",
      session,
      observation: resolvedObservation({ pid: 4_101 }),
      evidence: MATCHING_EVIDENCE,
      reason: "pid_mismatch"
    },
    {
      name: "terminal alias",
      session,
      observation,
      evidence: { ...MATCHING_EVIDENCE, terminalAliasMatches: false },
      reason: "terminal_alias_mismatch"
    },
    {
      name: "workspace",
      session,
      observation,
      evidence: { ...MATCHING_EVIDENCE, workspaceMatches: false },
      reason: "workspace_mismatch"
    }
  ];

  for (const fixture of cases) {
    assert.deepEqual(
      decideTerminalBindingMatch(
        fixture.session,
        fixture.observation,
        fixture.evidence
      ),
      { state: "unrelated", reason: fixture.reason },
      fixture.name
    );
  }
});

test("resolved native identity remains the primary exact-match authority", () => {
  assert.deepEqual(
    decideTerminalBindingMatch(
      managedSession(),
      resolvedObservation(),
      MATCHING_EVIDENCE
    ),
    { state: "exact", basis: "native_identity" }
  );

  const claudeSession = managedSession({
    agent: "claude",
    binding: {
      ...(managedSession().binding as NonNullable<ManagedSessionState["binding"]>),
      native_process: {
        pid: 4_100,
        process_uuid: "claude-pid:4100:started:12345",
        evidence: "claude_agents_exact_pid"
      }
    }
  });
  const claudeObservation = resolvedObservation({
    agent: "claude",
    nativeIdentity: {
      status: "resolved",
      identity: {
        sessionId: THREAD_A,
        processUuid: "claude-pid:4100:started:12345",
        evidence: "claude_agents_exact_pid"
      }
    },
    processIncarnation: {
      processUuid: "claude-pid:4100:started:12345"
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      claudeSession,
      claudeObservation,
      MATCHING_EVIDENCE
    ),
    { state: "exact", basis: "native_identity" }
  );
});

test("Codex preserves the two exact no-identity compatibility authorities", () => {
  const statusCardSession = managedSession({
    binding: {
      ...(managedSession().binding as NonNullable<ManagedSessionState["binding"]>),
      native_process: {
        pid: 4_100,
        process_uuid: PROCESS_UUID,
        process_birth: PROCESS_BIRTH,
        evidence: "native_inspection+codex_status_card"
      }
    }
  });
  const noIdentity = resolvedObservation({
    nativeIdentity: { status: "verified_absent" },
    processIncarnation: {
      processUuid: PROCESS_UUID,
      processBirth: PROCESS_BIRTH
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      statusCardSession,
      noIdentity,
      MATCHING_EVIDENCE
    ),
    { state: "exact", basis: "codex_status_card_process" }
  );

  const inventoryObservation = resolvedObservation({
    nativeIdentity: { status: "verified_absent" },
    codexOpenRootInventory: {
      pid: 4_100,
      processUuid: PROCESS_UUID,
      processBirth: PROCESS_BIRTH,
      roots: [{
        sessionId: THREAD_A.toUpperCase(),
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH,
        rollout: ROLLOUT
      }]
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      managedSession(),
      inventoryObservation,
      MATCHING_EVIDENCE
    ),
    { state: "exact", basis: "codex_open_root_rollout" }
  );
});

test("status-card disagreement wins over otherwise exact or lingering evidence", () => {
  const observation = resolvedObservation({
    statusCardNativeThreadId: THREAD_B
  });
  assert.deepEqual(
    decideTerminalBindingMatch(managedSession(), observation, {
      ...MATCHING_EVIDENCE,
      codexLingeringBeforeMatches: true
    }),
    { state: "not_exact", reason: "status_card_thread_mismatch" }
  );
});

test("Codex lingering-before evidence upgrades only a resolved identity mismatch", () => {
  const statusCardOnly = managedSession({
    binding: {
      ...(managedSession().binding as NonNullable<ManagedSessionState["binding"]>),
      native_process: {
        pid: 4_100,
        process_uuid: PROCESS_UUID,
        process_birth: PROCESS_BIRTH,
        evidence: "native_inspection+codex_status_card"
      }
    }
  });
  const observation = resolvedObservation({
    nativeIdentity: {
      status: "resolved",
      identity: {
        sessionId: THREAD_B,
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH,
        rollout: ROLLOUT,
        evidence: "managed_transition_before_identity"
      }
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      statusCardOnly,
      observation,
      MATCHING_EVIDENCE
    ),
    { state: "not_exact", reason: "native_identity_mismatch" }
  );
  assert.deepEqual(
    decideTerminalBindingMatch(statusCardOnly, observation, {
      ...MATCHING_EVIDENCE,
      codexLingeringBeforeMatches: true
    }),
    { state: "exact", basis: "codex_lingering_before" }
  );

  const rolloutBacked = managedSession();
  assert.deepEqual(
    decideTerminalBindingMatch(rolloutBacked, observation, {
      ...MATCHING_EVIDENCE,
      codexLingeringBeforeMatches: true
    }),
    { state: "not_exact", reason: "native_identity_mismatch" }
  );
});

test("resolved identity is never supplemented by process or inventory evidence", () => {
  const missingIdentityBirth = resolvedObservation({
    nativeIdentity: {
      status: "resolved",
      identity: {
        sessionId: THREAD_A,
        processUuid: PROCESS_UUID,
        evidence: "partial_native_identity"
      }
    },
    processIncarnation: {
      processUuid: PROCESS_UUID,
      processBirth: PROCESS_BIRTH
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      managedSession(),
      missingIdentityBirth,
      MATCHING_EVIDENCE
    ),
    { state: "not_exact", reason: "native_identity_mismatch" }
  );

  const wrongResolvedWithMatchingInventory = resolvedObservation({
    nativeIdentity: {
      status: "resolved",
      identity: {
        sessionId: THREAD_B,
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH,
        rollout: ROLLOUT,
        evidence: "codex_rollout_fd"
      }
    },
    codexOpenRootInventory: {
      pid: 4_100,
      processUuid: PROCESS_UUID,
      processBirth: PROCESS_BIRTH,
      roots: [{
        sessionId: THREAD_A,
        processUuid: PROCESS_UUID,
        processBirth: PROCESS_BIRTH,
        rollout: ROLLOUT
      }]
    }
  });
  assert.deepEqual(
    decideTerminalBindingMatch(
      managedSession(),
      wrongResolvedWithMatchingInventory,
      MATCHING_EVIDENCE
    ),
    { state: "not_exact", reason: "native_identity_mismatch" }
  );
});

test("identity field drift and UUID casing remain fail-closed", () => {
  const mismatches: Array<[string, TerminalObservation]> = [
    ["thread", resolvedObservation({
      nativeIdentity: {
        status: "resolved",
        identity: {
          sessionId: THREAD_B,
          processUuid: PROCESS_UUID,
          processBirth: PROCESS_BIRTH,
          rollout: ROLLOUT,
          evidence: "codex_rollout_fd"
        }
      }
    })],
    ["thread case", resolvedObservation({
      nativeIdentity: {
        status: "resolved",
        identity: {
          sessionId: THREAD_A.toUpperCase(),
          processUuid: PROCESS_UUID,
          processBirth: PROCESS_BIRTH,
          rollout: ROLLOUT,
          evidence: "codex_rollout_fd"
        }
      }
    })],
    ["process UUID", resolvedObservation({
      nativeIdentity: {
        status: "resolved",
        identity: {
          sessionId: THREAD_A,
          processUuid: "other-process",
          processBirth: PROCESS_BIRTH,
          rollout: ROLLOUT,
          evidence: "codex_rollout_fd"
        }
      }
    })],
    ["process birth", resolvedObservation({
      nativeIdentity: {
        status: "resolved",
        identity: {
          sessionId: THREAD_A,
          processUuid: PROCESS_UUID,
          processBirth: "54321",
          rollout: ROLLOUT,
          evidence: "codex_rollout_fd"
        }
      }
    })],
    ["rollout", resolvedObservation({
      nativeIdentity: {
        status: "resolved",
        identity: {
          sessionId: THREAD_A,
          processUuid: PROCESS_UUID,
          processBirth: PROCESS_BIRTH,
          rollout: { ...ROLLOUT, inode: "43" },
          evidence: "codex_rollout_fd"
        }
      }
    })]
  ];
  for (const [name, observation] of mismatches) {
    assert.deepEqual(
      decideTerminalBindingMatch(
        managedSession(),
        observation,
        MATCHING_EVIDENCE
      ),
      { state: "not_exact", reason: "native_identity_mismatch" },
      name
    );
  }
});

test("missing identity states remain distinct diagnostics but grant no authority", () => {
  for (const nativeIdentity of [
    { status: "verified_absent" as const, evidence: "exact_empty_probe" },
    { status: "unavailable" as const, reason: "resolver failed" },
    { status: "not_observed" as const }
  ]) {
    const observation = resolvedObservation({
      nativeIdentity,
      processIncarnation: {}
    });
    assert.deepEqual(
      decideTerminalBindingMatch(
        managedSession(),
        observation,
        MATCHING_EVIDENCE
      ),
      { state: "not_exact", reason: "native_identity_absent" },
      nativeIdentity.status
    );
  }
});

test("CLI Turn binding authority accepts only the persisted current generation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-turn-binding-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const control = terminalControl();
  const sessionId = "session-authority-current";
  const turnId = "turn-authority-current";
  saveManagedSession(storeDir, managedSession({
    session_id: sessionId,
    workspace: root,
    binding: {
      ...managedSession().binding!,
      terminal_control: control,
      native_thread_id: THREAD_A
    }
  }), { expectedRevision: null });
  const conversation = {
    ...createConversation({
      userRequest: "preserve the exact Turn binding",
      sessionId,
      turnId,
      workspace: root,
      executorKind: "codex"
    }),
    store_dir: storeDir,
    terminal_binding_id: "binding-authority-a",
    terminal_binding_generation: 1,
    native_thread_id: THREAD_A,
    native_session_takeover: {
      terminal_control: control,
      terminal_agent_session_id: THREAD_A
    }
  };
  const calls: string[] = [];
  const authority = createTerminalTurnBindingAuthorityCliAdapter({
    storeDirForConversation(value) {
      calls.push(value.turn_id);
      return storeDir;
    }
  });

  authority.assertCurrent(conversation, "approve");
  assert.deepEqual(calls, [turnId]);

  let superseded: unknown;
  assert.throws(
    () => authority.assertCurrent({
      ...conversation,
      terminal_binding_generation: 2
    }, "approve"),
    (error) => {
      superseded = error;
      return error instanceof Error &&
        error.message === `cannot approve Turn ${turnId}: its Session binding ` +
          "generation is no longer current";
    }
  );
  assert.deepEqual(authority.superseded(superseded), {
    code: "AKK_TURN_BINDING_SUPERSEDED",
    message: `cannot approve Turn ${turnId}: its Session binding generation ` +
      "is no longer current"
  });
  assert.equal(authority.superseded(new Error("different error")), undefined);
});

test("CLI Turn binding authority preserves delegated and malformed short-circuits", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-turn-shortcut-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "must-not-be-created");
  const authority = createTerminalTurnBindingAuthorityCliAdapter({
    storeDirForConversation: () => storeDir
  });
  const delegated = createConversation({
    userRequest: "delegated Turn",
    sessionId: "session-delegated",
    turnId: "turn-delegated",
    executorKind: "codex"
  });

  authority.assertCurrent(delegated, "cancel");
  assert.equal(fs.existsSync(storeDir), false);
  assert.throws(
    () => authority.assertCurrent({
      ...delegated,
      native_session_takeover: { terminal_control: {} }
    }, "cancel"),
    /cannot cancel Turn turn-delegated: its terminal binding is malformed/u
  );
  assert.equal(fs.existsSync(storeDir), false);
});

test("CLI Turn binding authority retains the exact migrated compatibility fence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-turn-migrated-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const control = terminalControl();
  const sessionId = "session-authority-migrated";
  const turnId = "turn-authority-migrated";
  const migrated = managedSession({
    session_id: sessionId,
    workspace: root,
    lineage: { created_by: "migration" },
    binding: {
      ...managedSession().binding!,
      terminal_control: control,
      native_thread_id: THREAD_A
    }
  });
  saveManagedSession(storeDir, migrated, { expectedRevision: null });
  const conversation = {
    ...createConversation({
      userRequest: "retain migrated compatibility",
      sessionId,
      turnId,
      workspace: root,
      executorKind: "codex"
    }),
    native_thread_id: THREAD_A,
    native_session_takeover: {
      native_session_id: migrated.binding!.terminal_id,
      terminal_control: control,
      terminal_agent_pid: migrated.binding!.native_process.pid,
      terminal_agent_session_id: THREAD_A,
      terminal_agent_process_uuid: PROCESS_UUID,
      terminal_agent_process_birth: PROCESS_BIRTH,
      terminal_agent_rollout: ROLLOUT
    }
  };
  const authority = createTerminalTurnBindingAuthorityCliAdapter({
    storeDirForConversation: () => storeDir
  });

  authority.assertCurrent(conversation, "respond");
  assert.throws(() => authority.assertCurrent({
    ...conversation,
    native_session_takeover: {
      ...conversation.native_session_takeover,
      terminal_agent_process_birth: "different-birth"
    }
  }, "respond"), /Session binding generation is no longer current/u);
});

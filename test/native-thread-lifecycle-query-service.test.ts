import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  assertNativeThreadHasExclusiveOwnership,
  previousCommittedResumeCandidate,
  resumableNativeThreadCandidates,
  revalidateNativeThreadCandidate,
  type LifecycleTerminalObservation,
  type NativeThreadLifecycleQueryPorts
} from "../src/native-thread-lifecycle-query-service.js";
import {
  assertResumeSnapshotActionFingerprint,
  assertResumeSnapshotCandidates,
  assertResumeSnapshotMatchesTerminal,
  assertResumeSnapshotNotExpired,
  decodeThreadCandidateToken,
  encodeThreadCandidateToken,
  lifecycleAfterBindingMatchesCurrent,
  type NativeThreadResumeSnapshot
} from "../src/native-thread-resume-snapshot-policy.js";
import type {
  ManagedSessionState,
  ManagedTerminalBinding,
  NativeThreadCandidate,
  NativeThreadTransition
} from "../src/managed-session.js";
import type {
  TerminalThreadLifecycleCandidate,
  TerminalThreadLifecycleCandidateProvider,
  TerminalThreadLifecycleCandidateToken
} from "../src/terminal-agent-adapter.js";

const workspace = "/private/query-workspace";
const currentId = "11111111-1111-4111-8111-111111111111";
const newestId = "22222222-2222-4222-8222-222222222222";
const oldestId = "33333333-3333-4333-8333-333333333333";

const terminal: LifecycleTerminalObservation = {
  conversationId: "terminal:v2:tmux:codex:work:0.0:1234",
  agent: "codex",
  pid: 1235,
  terminalControl: {
    kind: "tmux",
    target: "work:0.0",
    session: "work",
    window: 0,
    pane: 0,
    panePid: 1234,
    currentPath: workspace,
    capabilities: []
  }
};

test("agent version failure short-circuits candidate discovery without writes", async () => {
  const events: string[] = [];
  const ports = queryPorts(events, {
    runningVersion: () => undefined
  });
  await assert.rejects(
    resumableNativeThreadCandidates({ terminal }, ports),
    /without the exact running version/u
  );
  assert.deepEqual(events, [
    "terminal:list-processes",
    "store:list-sessions",
    "terminal:version"
  ]);
  assert.equal(
    Object.keys(ports).some((key) => /^(save|write|mutat|lock)/iu.test(key)),
    false
  );
});

test("candidate observation order, deduplication, and sorting stay deterministic", async () => {
  const events: string[] = [];
  const ports = queryPorts(events, {
    candidates: [
      lifecycleCandidate(oldestId, 100),
      lifecycleCandidate(newestId, 300),
      lifecycleCandidate(oldestId, 200)
    ]
  });
  const candidates = await resumableNativeThreadCandidates({ terminal }, ports);
  assert.deepEqual(events, [
    "terminal:list-processes",
    "store:list-sessions",
    "terminal:version",
    "terminal:provider",
    "terminal:list-candidates"
  ]);
  assert.deepEqual(
    candidates.map((candidate) => [
      candidate.native_thread_id,
      candidate.updated_at_ms,
      candidate.resumable
    ]),
    [
      [newestId, 300, true],
      [oldestId, 200, true]
    ]
  );
});

test("resume candidate tokens preserve JSON.stringify bytes and reject mismatches first", async () => {
  const events: string[] = [];
  const token = candidateToken(newestId);
  const reordered = {
    version: 1,
    metadataFingerprint: token.metadataFingerprint,
    fileToken: token.fileToken,
    agentVersion: token.agentVersion,
    source: token.source,
    cwd: token.cwd,
    nativeThreadId: token.nativeThreadId,
    agent: token.agent,
    schema: token.schema
  } as TerminalThreadLifecycleCandidateToken;
  const encoded = encodeThreadCandidateToken(token);
  assert.equal(
    encoded,
    Buffer.from(JSON.stringify(token), "utf8").toString("base64url")
  );
  assert.notEqual(encoded, encodeThreadCandidateToken(reordered));
  assert.deepEqual(decodeThreadCandidateToken(encoded), token);

  const ports = queryPorts(events, { storeError: "Store was observed" });
  await assert.rejects(
    revalidateNativeThreadCandidate({
      terminal,
      nativeThreadId: oldestId,
      encodedToken: encoded,
      agentVersion: "0.146.1"
    }, ports),
    /does not match this terminal/u
  );
  assert.deepEqual(events, []);

  assert.deepEqual(await revalidateNativeThreadCandidate({
    terminal,
    nativeThreadId: newestId,
    encodedToken: encoded,
    agentVersion: "0.146.1"
  }, ports), token);
  assert.deepEqual(events, [
    "terminal:provider",
    "terminal:revalidate"
  ]);
});

test("snapshot terminal observation resolves workspace before evidence and keeps mismatch short-circuits", () => {
  const trace: string[] = [];
  const terminalControl = new Proxy(terminal.terminalControl, {
    get(target, property, receiver) {
      trace.push(property === "currentPath"
        ? "terminal:current-path"
        : `terminal:evidence:${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  assert.doesNotThrow(() => assertResumeSnapshotMatchesTerminal(
    resumeSnapshot(),
    {
      conversationId: terminal.conversationId,
      agent: terminal.agent,
      terminalControl
    },
    () => {
      trace.push("cwd");
      throw new Error("cwd must stay lazy");
    }
  ));
  assert.equal(trace[0], "terminal:current-path");
  assert.equal(trace.includes("cwd"), false);
  assert.ok(trace.some((event) => event.startsWith("terminal:evidence:")));

  const fallbackTrace: string[] = [];
  const fallbackControl = new Proxy({
    ...terminal.terminalControl,
    currentPath: undefined
  }, {
    get(target, property, receiver) {
      fallbackTrace.push(property === "currentPath"
        ? "terminal:current-path"
        : `terminal:evidence:${String(property)}`);
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => assertResumeSnapshotMatchesTerminal(
      resumeSnapshot(),
      {
        conversationId: terminal.conversationId,
        agent: terminal.agent,
        terminalControl: fallbackControl
      },
      () => {
        fallbackTrace.push("cwd");
        throw new Error("cwd exploded");
      }
    ),
    /cwd exploded/u
  );
  assert.deepEqual(fallbackTrace, ["terminal:current-path", "cwd"]);

  for (const changed of [
    { terminal_id: "another-terminal" },
    { agent: "claude" }
  ]) {
    let workspaceObserved = false;
    const changedSnapshot = new Proxy(resumeSnapshot(changed), {
      get(target, property, receiver) {
        if (property === "workspace") {
          workspaceObserved = true;
          throw new Error("snapshot workspace must remain short-circuited");
        }
        return Reflect.get(target, property, receiver);
      }
    });
    assert.throws(
      () => assertResumeSnapshotMatchesTerminal(
        changedSnapshot,
        {
          conversationId: terminal.conversationId,
          agent: terminal.agent,
          terminalControl: terminal.terminalControl
        },
        () => workspace
      ),
      /resume selection terminal, process, or workspace changed/u
    );
    assert.equal(workspaceObserved, false);
  }
});

test("snapshot expiry parses before the clock and never calls a clock after parse failure", () => {
  const trace: string[] = [];
  const expiresAt = {
    [Symbol.toPrimitive]() {
      trace.push("expires:parse");
      return "2999-08-15T00:05:00.000Z";
    }
  };
  const tracedSnapshot = new Proxy(resumeSnapshot(), {
    get(target, property, receiver) {
      if (property === "expires_at") {
        trace.push("expires:read");
        return expiresAt;
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.doesNotThrow(() => assertResumeSnapshotNotExpired(
    tracedSnapshot,
    () => {
      trace.push("clock");
      return 0;
    }
  ));
  assert.deepEqual(trace, ["expires:read", "expires:parse", "clock"]);

  const failureTrace: string[] = [];
  const throwingSnapshot = new Proxy(resumeSnapshot(), {
    get(target, property, receiver) {
      if (property === "expires_at") {
        failureTrace.push("expires:read");
        return {
          [Symbol.toPrimitive]() {
            failureTrace.push("expires:parse");
            throw new Error("expiry parse exploded");
          }
        };
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => assertResumeSnapshotNotExpired(throwingSnapshot, () => {
      failureTrace.push("clock");
      return 0;
    }),
    /expiry parse exploded/u
  );
  assert.deepEqual(failureTrace, ["expires:read", "expires:parse"]);
});

test("snapshot fingerprints preserve fail-closed evaluation and rollout key order", () => {
  let rowsObserved = false;
  const snapshot = new Proxy(resumeSnapshot({
    candidate_snapshot_fingerprint: "not-the-current-fingerprint"
  }), {
    get(target, property, receiver) {
      if (property === "rows" || property === "snapshot_id") {
        rowsObserved = true;
        throw new Error("rows must remain short-circuited");
      }
      return Reflect.get(target, property, receiver);
    }
  });
  assert.throws(
    () => assertResumeSnapshotCandidates(snapshot, [{
      native_thread_id: newestId,
      candidate_token: "candidate-token",
      agent: "codex",
      workspace,
      resumable: true
    }]),
    /candidates changed or reordered/u
  );
  assert.equal(rowsObserved, false);

  const actionTrace: string[] = [];
  const actionSnapshot = new Proxy(resumeSnapshot({
    terminal_action_fingerprint: "not-the-current-fingerprint"
  }), {
    get(target, property, receiver) {
      if (property === "terminal_action_fingerprint") {
        actionTrace.push("snapshot:fingerprint");
      }
      return Reflect.get(target, property, receiver);
    }
  });
  const ledger = new Proxy({ action: "resume" }, {
    ownKeys(target) {
      actionTrace.push("ledger:fingerprint");
      return Reflect.ownKeys(target);
    }
  });
  assert.throws(
    () => assertResumeSnapshotActionFingerprint(actionSnapshot, ledger),
    /terminal action history changed/u
  );
  assert.deepEqual(actionTrace, [
    "ledger:fingerprint",
    "snapshot:fingerprint"
  ]);

  const committed = binding("binding-current", currentId, 2);
  const orderedRollout = {
    fd: "12u",
    device: "1",
    inode: "2",
    path: "/private/current.jsonl"
  };
  const reorderedRollout = {
    path: "/private/current.jsonl",
    inode: "2",
    device: "1",
    fd: "12u"
  };
  const after = {
    ...committed,
    native_process: { ...committed.native_process, rollout: orderedRollout }
  };
  assert.equal(lifecycleAfterBindingMatchesCurrent(after, {
    ...after,
    native_process: { ...after.native_process, rollout: orderedRollout }
  }), true);
  assert.equal(lifecycleAfterBindingMatchesCurrent(after, {
    ...after,
    native_process: { ...after.native_process, rollout: reorderedRollout }
  }), false);
});

test("query runtime stays filesystem-neutral and the CLI adapter resolves Store paths lazily", () => {
  const querySource = fs.readFileSync(
    path.resolve("src/native-thread-lifecycle-query-service.ts"),
    "utf8"
  );
  const policySource = fs.readFileSync(
    path.resolve("src/native-thread-resume-snapshot-policy.ts"),
    "utf8"
  );
  assert.match(
    querySource,
    /from "\.\/native-thread-resume-snapshot-policy\.js"/u
  );
  assert.doesNotMatch(querySource, /native-thread-resume-snapshot\.js/u);
  assert.doesNotMatch(
    policySource,
    /node:fs|session-store|terminal-agent-bridge|terminal-dispatch-ledger/u
  );

  const adapterSource = fs.readFileSync(
    path.resolve("src/native-thread-lifecycle-cli-adapter.ts"),
    "utf8"
  );
  const start = adapterSource.indexOf(
    "  queryPorts(options: NativeLifecycleCliOptions):"
  );
  const end = adapterSource.indexOf(
    "  async rootActiveProcesses(",
    start
  );
  const factory = adapterSource.slice(start, end);
  assert.match(
    factory,
    /resolvedStoreDir \?\?=[\s\S]*this\.ports\.state\.storeDir\(options\)/u
  );
  assert.doesNotMatch(factory, /path\.resolve\(this\.ports\.state\.storeDir/u);
  assert.equal(
    factory.match(/this\.ports\.state\.storeDir\(options\)/gu)?.length,
    1
  );
  assert.equal(factory.match(/storeDir\(\)/gu)?.length, 4);
  assert.doesNotMatch(
    factory,
    /listManagedSessions\(storeDir\)|loadNativeThreadTransition\(storeDir,/u
  );
});

test("Store authority and terminal ownership errors precede Session observation", async () => {
  const invalidEvents: string[] = [];
  await assert.rejects(
    assertNativeThreadHasExclusiveOwnership({
      terminalControl: terminal.terminalControl,
      agent: "codex",
      currentPid: terminal.pid,
      nativeThreadId: "not-a-thread"
    }, queryPorts(invalidEvents)),
    /exact thread UUID/u
  );
  assert.deepEqual(invalidEvents, []);

  const storeEvents: string[] = [];
  await assert.rejects(
    assertNativeThreadHasExclusiveOwnership({
      terminalControl: terminal.terminalControl,
      agent: "codex",
      currentPid: terminal.pid,
      nativeThreadId: newestId
    }, queryPorts(storeEvents, { authorityError: "wrong Store" })),
    /wrong Store/u
  );
  assert.deepEqual(storeEvents, ["store:authority"]);

  const ownerEvents: string[] = [];
  await assert.rejects(
    assertNativeThreadHasExclusiveOwnership({
      terminalControl: terminal.terminalControl,
      agent: "codex",
      currentPid: terminal.pid,
      nativeThreadId: newestId
    }, queryPorts(ownerEvents, {
      activeProcess: { pid: 9999, cwd: workspace },
      activeIdentity: {
        sessionId: newestId,
        processUuid: "other-process",
        processBirth: "other-birth",
        evidence: "codex_rollout_fd",
        rollout: {
          fd: "12u",
          path: "/private/other.jsonl",
          device: "1",
          inode: "2"
        }
      }
    })),
    /already active in another codex process/u
  );
  assert.deepEqual(ownerEvents, [
    "store:authority",
    "terminal:list-processes",
    "terminal:resolve-identity"
  ]);
});

test("previous resume reads the exact committed transition revision once", () => {
  const before = binding("binding-before", oldestId, 1);
  const after = binding("binding-after", currentId, 2);
  const transition = committedTransition(before, after);
  const session = managedSession(after, transition.transition_id);
  const candidate: NativeThreadCandidate = {
    native_thread_id: oldestId,
    candidate_token: "candidate-token",
    agent: "codex",
    workspace,
    managed_session_id: transition.source_session_id,
    resumable: true
  };
  const events: string[] = [];
  const ports = queryPorts(events, { sessions: [session], transition });
  assert.equal(previousCommittedResumeCandidate({
    terminal,
    currentSession: session,
    candidates: [candidate]
  }, ports)?.native_thread_id, oldestId);
  assert.deepEqual(events, [`store:load-transition:${transition.transition_id}`]);

  const stale = { ...transition, status: "verified" as const, revision: 5 };
  assert.equal(previousCommittedResumeCandidate({
    terminal,
    currentSession: session,
    candidates: [candidate]
  }, queryPorts([], { transition: stale })), undefined);
});

function resumeSnapshot(
  overrides: Partial<NativeThreadResumeSnapshot> = {}
): NativeThreadResumeSnapshot {
  return {
    schema: "agent-knock-knock/native-thread-resume-snapshot",
    version: 1,
    snapshot_id: "rs_AAAAAAAAAAAAAAAAAAAAAA",
    store_key: "store-key",
    selection_scope: "query-test",
    created_at: "2026-08-15T00:00:00.000Z",
    expires_at: "2999-08-15T00:05:00.000Z",
    terminal_id: terminal.conversationId,
    agent: terminal.agent,
    workspace,
    terminal_control: {
      target: terminal.terminalControl.target,
      pane_pid: terminal.terminalControl.panePid
    },
    expected_binding_token: "binding-token",
    terminal_action_fingerprint: "a".repeat(64),
    candidate_snapshot_fingerprint: "b".repeat(64),
    rows: [],
    ...overrides
  };
}

interface QueryPortFixture {
  runningVersion?: () => string | undefined;
  candidates?: readonly TerminalThreadLifecycleCandidate[];
  sessions?: readonly ManagedSessionState[];
  transition?: NativeThreadTransition;
  authorityError?: string;
  storeError?: string;
  activeProcess?: { pid: number; cwd?: string };
  activeIdentity?: {
    sessionId: string;
    processUuid?: string;
    processBirth?: string;
    evidence: string;
    rollout?: { fd: string; path: string; device: string; inode: string };
  };
}

function queryPorts(
  events: string[],
  fixture: QueryPortFixture = {}
): NativeThreadLifecycleQueryPorts {
  const provider: TerminalThreadLifecycleCandidateProvider = {
    async listThreadLifecycleCandidates() {
      events.push("terminal:list-candidates");
      return fixture.candidates ?? [];
    },
    async revalidateThreadLifecycleCandidate(candidate) {
      events.push("terminal:revalidate");
      return { status: "valid", candidate: "candidateToken" in candidate
        ? candidate
        : undefined };
    }
  };
  return {
    cwd: () => workspace,
    listManagedSessions: () => {
      events.push("store:list-sessions");
      if (fixture.storeError) throw new Error(fixture.storeError);
      return fixture.sessions ?? [];
    },
    loadNativeThreadTransition: (transitionId) => {
      events.push(`store:load-transition:${transitionId}`);
      if (!fixture.transition) throw new Error("missing transition");
      return fixture.transition;
    },
    blockingTurns: () => [],
    assertStoreAuthority: () => {
      events.push("store:authority");
      if (fixture.authorityError) throw new Error(fixture.authorityError);
    },
    runningVersion: (value) => {
      events.push("terminal:version");
      return fixture.runningVersion
        ? fixture.runningVersion()
        : value.agent === "codex"
          ? "0.146.1"
          : undefined;
    },
    candidateProvider: () => {
      events.push("terminal:provider");
      return provider;
    },
    sessionOwnerIsConclusivelyInactive: () => false,
    rootActiveProcesses: async () => {
      events.push("terminal:list-processes");
      return fixture.activeProcess ? [fixture.activeProcess] : [];
    },
    resolveProcessIdentity: async () => {
      events.push("terminal:resolve-identity");
      return fixture.activeIdentity;
    },
    loadClaudeAgentRows: () => [],
    workspaceRelationship: (expected, actual) =>
      expected === actual ? "same" : "different"
  };
}

function candidateToken(
  nativeThreadId: string
): TerminalThreadLifecycleCandidateToken {
  return {
    schema: "agent-knock-knock/thread-candidate-token",
    version: 1,
    agent: "codex",
    nativeThreadId,
    cwd: workspace,
    source: "codex_rollout",
    agentVersion: "0.146.1",
    fileToken: {
      path: `/private/${nativeThreadId}.jsonl`,
      device: "1",
      inode: "2",
      size: 100,
      mtimeMs: 200
    },
    metadataFingerprint: `fingerprint-${nativeThreadId}`
  };
}

function lifecycleCandidate(
  nativeThreadId: string,
  updatedAtMs: number
): TerminalThreadLifecycleCandidate {
  return {
    ...candidateToken(nativeThreadId),
    rootInteractive: true,
    updatedAtMs,
    candidateToken: candidateToken(nativeThreadId)
  };
}

function binding(
  bindingId: string,
  nativeThreadId: string,
  generation: number
): ManagedTerminalBinding {
  return {
    binding_id: bindingId,
    generation,
    terminal_id: terminal.conversationId,
    terminal_control: terminal.terminalControl,
    native_thread_id: nativeThreadId,
    native_process: {
      pid: terminal.pid,
      process_uuid: "codex-process",
      process_birth: "birth",
      evidence: "codex_status_card"
    },
    bound_at: "2026-08-15T00:00:00.000Z",
    last_verified_at: "2026-08-15T00:00:00.000Z"
  };
}

function managedSession(
  terminalBinding: ManagedTerminalBinding,
  transitionId: string
): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    revision: 7,
    session_id: "session-current",
    agent: "codex",
    workspace,
    status: "bound",
    binding: terminalBinding,
    lineage: { created_by: "new_thread" },
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z",
    last_transition_id: transitionId
  };
}

function committedTransition(
  before: ManagedTerminalBinding,
  after: ManagedTerminalBinding
): NativeThreadTransition {
  return {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    revision: 6,
    transition_id: "transition-before-to-current",
    operation: "new_thread",
    status: "committed",
    terminal_id: terminal.conversationId,
    agent: "codex",
    workspace,
    source_session_id: "session-before",
    source_expected_revision: 3,
    target_session_id: "session-current",
    target_expected_revision: null,
    target_native_thread_id: after.native_thread_id,
    before_native_thread_id: before.native_thread_id as string,
    before_process_uuid: "codex-process",
    before_process_birth: "birth",
    before_binding: before,
    after_binding: after,
    adapter_version: "0.146.1",
    command_fingerprint: "f".repeat(64),
    dispatcher_pid: 999,
    prepared_at: "2026-08-15T00:00:00.000Z",
    dispatching_at: "2026-08-15T00:00:01.000Z",
    submitted_at: "2026-08-15T00:00:02.000Z",
    verified_at: "2026-08-15T00:00:03.000Z",
    committed_at: "2026-08-15T00:00:04.000Z"
  };
}

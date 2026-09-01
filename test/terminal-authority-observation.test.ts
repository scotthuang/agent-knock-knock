import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateSourceRootAuthorityMatches,
  classifyTerminalBindingConflict
} from "../src/terminal-binding-authority.js";
import {
  decideTerminalDispatchOwnership,
  decideTerminalSendAuthority
} from "../src/terminal-dispatch-policy.js";
import {
  deferredCandidateSourceTurnHistory,
  deferredCodexForegroundDispatchSnapshot,
  observeDeferredCodexAuthority,
  type DeferredForegroundAuthorityAdapterPorts
} from "../src/deferred-foreground-authority-cli-adapter.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import {
  createConversation,
  type Conversation
} from "../src/protocol.js";
import {
  assertSafeTerminalSend,
  selectRootTerminalProcesses
} from "../src/terminal-authority-policy.js";
import type { TerminalBridgeStatus } from "../src/terminal-agent-bridge.js";
import {
  createTerminalEndpointRef,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  tmuxTerminalRouteKey,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0101";
const THREAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102";
const TMUX_SOCKET = "/private/tmp/tmux-501/default";

test("root terminal selection follows unclassified ancestors", () => {
  const terminalControl = canonicalTmuxControl({ target: "durable:0.0" });
  const nested = {
    agent: "codex" as const,
    pid: 60350,
    ppid: 60344,
    terminalControl
  };
  const root = {
    agent: "codex" as const,
    pid: 15306,
    ppid: 24473,
    terminalControl
  };

  assert.deepEqual(
    selectRootTerminalProcesses(
      [nested, root],
      [
        nested,
        { pid: 60344, ppid: 59970 },
        { pid: 59970, ppid: 15306 },
        root
      ]
    ),
    [root]
  );
});

function canonicalTmuxControl({
  target,
  paneId = "%3",
  panePid = 4_584
}: {
  target: string;
  paneId?: string;
  panePid?: number;
}): TerminalControlRef {
  const [session = target, route = "0.0"] = target.split(":", 2);
  const [windowText = "0", paneText = "0"] = route.split(".", 2);
  const control: TerminalControlRef = {
    kind: "tmux",
    target,
    socketPath: TMUX_SOCKET,
    session,
    window: Number(windowText),
    pane: Number(paneText),
    panePid,
    currentCommand: "codex",
    currentPath: "/repo",
    capabilities: ["screen_status", "send_keys"]
  };
  const endpointKey = `socket:${TMUX_SOCKET}`;
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey,
      resourceKey: `pane-id:${paneId}`
    },
    route: {
      routeKey: tmuxTerminalRouteKey(endpointKey, target, TMUX_SOCKET),
      label: target,
      currentCommand: control.currentCommand,
      currentPath: control.currentPath
    },
    processAnchorPid: panePid,
    capabilities: control.capabilities,
    providerRef: control
  });
  return control;
}

function deferredAuthorityPorts(
  ledger: Record<string, any> | undefined,
  {
    turns = [],
    attention = () => false
  }: {
    turns?: Conversation[];
    attention?: (turn: Conversation) => boolean;
  } = {}
): DeferredForegroundAuthorityAdapterPorts {
  return {
    turn: {
      terminalControl: () => undefined,
      storeDir: () => undefined,
      turnsForSession: () => turns,
      needsAttention: attention,
      readEvents: () => []
    },
    ledger: {
      load: () => ledger,
      matchesControl: (candidate, control, options) =>
        terminalControlEvidenceMatches(
          candidate?.terminal_endpoint ?? candidate?.terminal_control,
          control,
          options
        ),
      processAnchor: (candidate) => {
        const evidence = candidate.terminal_endpoint ??
          candidate.terminal_control;
        const anchor = Number(
          evidence?.process_anchor_pid ??
          evidence?.pane_pid ??
          evidence?.panePid
        );
        return Number.isSafeInteger(anchor) && anchor > 0
          ? anchor
          : undefined;
      }
    },
    transition: {
      hasUnresolved: () => false,
      hasAny: () => false
    }
  };
}

function candidateTurn({
  id,
  bindingId,
  bindingGeneration,
  nativeThreadId,
  status = "idle",
  gatewayMethod = "sessions_send",
  callbackStatus = "delivered",
  submissionStatus,
  userRequest = "managed request"
}: {
  id: string;
  bindingId: string;
  bindingGeneration: number;
  nativeThreadId: string;
  status?: Conversation["status"];
  gatewayMethod?: string | null;
  callbackStatus?: string | null;
  submissionStatus?: string;
  userRequest?: string;
}): Conversation {
  return {
    ...createConversation({
      userRequest,
      sessionId: "session-binding-history",
      turnId: id,
      workspace: "/repo",
      executorKind: "codex",
      now: new Date("2026-08-21T03:00:00.000Z")
    }),
    status,
    terminal_binding_id: bindingId,
    terminal_binding_generation: bindingGeneration,
    native_thread_id: nativeThreadId,
    gateway_method: gatewayMethod ?? undefined,
    callback_delivery: callbackStatus
      ? { status: callbackStatus }
      : undefined,
    native_session_takeover: submissionStatus
      ? { terminal_bridge_submission: { status: submissionStatus } }
      : undefined
  };
}

function legacyCandidateTurn({
  id,
  status = "closed",
  callbackStatus = "delivered",
  submissionStatus = "submitted",
  withStrongProcessIdentity = true
}: {
  id: string;
  status?: Conversation["status"];
  callbackStatus?: string | null;
  submissionStatus?: string;
  withStrongProcessIdentity?: boolean;
}): Conversation {
  const control = session("legacy-fixture").binding!.terminal_control;
  return {
    ...candidateTurn({
      id,
      bindingId: "unused-legacy-binding",
      bindingGeneration: 1,
      nativeThreadId: THREAD_B,
      status,
      callbackStatus,
      submissionStatus
    }),
    terminal_binding_id: undefined,
    terminal_binding_generation: undefined,
    native_thread_id: undefined,
    native_session_takeover: {
      native_session_id: "terminal:v2:tmux:codex:work:0.0:4100",
      terminal_control: control,
      terminal_agent_pid: 4_100,
      terminal_agent_session_id: THREAD_B,
      terminal_agent_process_uuid: "codex-pid:4100:birth:12345",
      terminal_agent_process_birth: "12345",
      ...(withStrongProcessIdentity
        ? {
            terminal_agent_rollout: {
              fd: "21",
              device: "1",
              inode: "100",
              path: "/repo/legacy.jsonl"
            }
          }
        : {}),
      terminal_bridge_submission: {
        message_id: `message-${id}`,
        status: submissionStatus
      }
    }
  };
}

function session(
  id: string,
  overrides: Partial<ManagedSessionState> = {}
): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: id,
    revision: 1,
    agent: "codex",
    workspace: "/repo",
    status: "bound",
    binding: {
      binding_id: `binding-${id}`,
      generation: 1,
      terminal_id: "terminal:v2:tmux:codex:work:0.0:4100",
      terminal_control: {
        kind: "tmux",
        target: "work:0.0",
        socketPath: "/tmp/tmux/default",
        session: "work",
        window: 0,
        pane: 0,
        panePid: 4_000,
        currentCommand: "codex",
        currentPath: "/repo",
        capabilities: ["screen_status", "send_keys"]
      },
      native_thread_id: THREAD_A,
      native_process: {
        pid: 4_100,
        process_uuid: "codex-pid:4100:birth:12345",
        process_birth: "12345",
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

test("binding conflict classification preserves legacy priority and lazy Turns", () => {
  const bound = session("session-bound");
  let turnReads = 0;
  const statusMismatch = {
    session: bound,
    processRelationship: "same" as const,
    liveNativeThreadId: THREAD_B,
    statusCardNativeThreadId: THREAD_B,
    get managedTurnCount(): number {
      turnReads += 1;
      return 0;
    }
  };
  assert.equal(
    classifyTerminalBindingConflict(statusMismatch),
    "live_external_thread_change"
  );
  assert.equal(turnReads, 0, "status-card mismatch must not inspect Turns");

  const orphan = session("session-orphan", {
    binding: {
      ...bound.binding!,
      native_thread_id: undefined,
      native_process: {
        ...bound.binding!.native_process,
        rollout: undefined
      }
    }
  });
  assert.equal(classifyTerminalBindingConflict({
    session: orphan,
    processRelationship: "same",
    managedTurnCount: 0
  }), "provisional_orphan");
  assert.equal(classifyTerminalBindingConflict({
    session: bound,
    processRelationship: "different"
  }), "stale_process_incarnation");
  assert.equal(classifyTerminalBindingConflict({
    session: bound,
    processRelationship: "unverifiable",
    liveNativeThreadId: THREAD_B
  }), "unverifiable");
});

test("dispatch ownership stages ledger and owner observations lazily", () => {
  const cases = [
    {
      name: "absent",
      decision: decideTerminalDispatchOwnership("absent"),
      state: "none",
      basis: "absent"
    },
    {
      name: "resolved",
      decision: decideTerminalDispatchOwnership("resolved"),
      state: "none",
      basis: "resolved"
    },
    {
      name: "stale process",
      decision: decideTerminalDispatchOwnership(
        "stale_process_incarnation"
      ),
      state: "none",
      basis: "stale_process_incarnation"
    },
    {
      name: "active exact asks for owner",
      decision: decideTerminalDispatchOwnership("active"),
      state: "needs_owner"
    },
    {
      name: "released owner",
      decision: decideTerminalDispatchOwnership("active", "released"),
      state: "none",
      basis: "released_owner"
    },
    {
      name: "exact owner",
      decision: decideTerminalDispatchOwnership("active", "current"),
      state: "current"
    }
  ];
  for (const fixture of cases) {
    assert.equal(fixture.decision.state, fixture.state, fixture.name);
    assert.equal("basis" in fixture.decision
      ? fixture.decision.basis
      : undefined, fixture.basis, fixture.name);
  }
});

test("resolved canonical dispatch authority survives a route-only tmux renumber", () => {
  const before = canonicalTmuxControl({ target: "workspace:0.1" });
  const after = canonicalTmuxControl({ target: "workspace:0.0" });
  const movedAgain = canonicalTmuxControl({ target: "workspace:2.0" });
  const ledger = {
    status: "resolved",
    resolved_at: "2026-08-21T02:00:00.000Z",
    terminal_endpoint: terminalControlEvidence(before),
    terminal_control: {
      kind: before.kind,
      target: before.target,
      socket_path: before.socketPath,
      pane_pid: before.panePid,
      current_path: before.currentPath
    }
  };

  const snapshot = deferredCodexForegroundDispatchSnapshot(
    deferredAuthorityPorts(ledger),
    after
  );
  const snapshotAfterAnotherMove = deferredCodexForegroundDispatchSnapshot(
    deferredAuthorityPorts(ledger),
    movedAgain
  );

  assert.equal(snapshot.status, "resolved");
  assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/u);
  assert.deepEqual(snapshotAfterAnotherMove, snapshot);
  assert.equal(
    (ledger.terminal_endpoint as Record<string, any>).target,
    "workspace:0.1",
    "read-only authority must not rewrite the historical dispatch route"
  );
});

test("resolved dispatch route tolerance remains closed to noncanonical and changed authority", () => {
  const before = canonicalTmuxControl({ target: "workspace:0.1" });
  const after = canonicalTmuxControl({ target: "workspace:0.0" });
  const resolved = {
    status: "resolved",
    resolved_at: "2026-08-21T02:00:00.000Z",
    terminal_endpoint: terminalControlEvidence(before)
  };
  const fixtures = [
    {
      name: "active ledger",
      ledger: { ...resolved, status: "agent_accepted" },
      control: after
    },
    {
      name: "uncertain ledger",
      ledger: { ...resolved, status: "uncertain" },
      control: after
    },
    {
      name: "different stable pane",
      ledger: resolved,
      control: canonicalTmuxControl({
        target: "workspace:0.0",
        paneId: "%4"
      })
    },
    {
      name: "different process anchor",
      ledger: resolved,
      control: canonicalTmuxControl({
        target: "workspace:0.0",
        panePid: before.panePid + 1
      })
    },
    {
      name: "legacy route-only evidence",
      ledger: {
        status: "resolved",
        resolved_at: "2026-08-21T02:00:00.000Z",
        terminal_control: {
          kind: "tmux",
          target: before.target,
          socket_path: before.socketPath,
          pane_pid: before.panePid
        }
      },
      control: after
    }
  ];

  for (const fixture of fixtures) {
    assert.throws(
      () => deferredCodexForegroundDispatchSnapshot(
        deferredAuthorityPorts(fixture.ledger),
        fixture.control
      ),
      /does not have exact resolved dispatch authority/u,
      fixture.name
    );
  }
});

test("candidate history scopes authority to the current binding generation", () => {
  const base = session("session-binding-history");
  const source: ManagedSessionState = {
    ...base,
    binding: {
      ...base.binding!,
      binding_id: "binding-current",
      generation: 5,
      native_thread_id: THREAD_A,
      native_process: {
        ...base.binding!.native_process,
        rollout: {
          fd: "21",
          device: "1",
          inode: "101",
          path: "/repo/current.jsonl"
        }
      }
    }
  };
  const legacyWithoutPersistedBinding = legacyCandidateTurn({
    id: "turn-legacy-delivered"
  });
  const acceptedWithoutCallback = candidateTurn({
    id: "turn-prior-accepted-without-callback",
    bindingId: "binding-prior-3",
    bindingGeneration: 3,
    nativeThreadId: THREAD_B,
    status: "closed",
    callbackStatus: null,
    submissionStatus: "agent_accepted"
  });
  acceptedWithoutCallback.native_session_takeover = {
    ...(acceptedWithoutCallback.native_session_takeover as Record<string, any>),
    terminal_bridge_submission: {
      message_id: "message-prior-accepted",
      status: "agent_accepted"
    },
    terminal_bridge_submission_receipts: [{
      message_id: "message-prior-accepted",
      status: "agent_accepted"
    }]
  };
  const oldCallbackAndSubmissionDebt = candidateTurn({
    id: "turn-prior-callback-debt",
    bindingId: "binding-prior-4",
    bindingGeneration: 4,
    nativeThreadId: THREAD_B,
    status: "closed",
    callbackStatus: "failed",
    submissionStatus: "uncertain"
  });
  const oldCancelled = candidateTurn({
    id: "turn-prior-cancelled",
    bindingId: "binding-prior-4",
    bindingGeneration: 4,
    nativeThreadId: THREAD_B,
    status: "cancelled",
    callbackStatus: null,
    submissionStatus: "agent_accepted"
  });
  const current = candidateTurn({
    id: "turn-current",
    bindingId: "binding-current",
    bindingGeneration: 5,
    nativeThreadId: THREAD_A
  });
  const turns = [
    legacyWithoutPersistedBinding,
    acceptedWithoutCallback,
    oldCallbackAndSubmissionDebt,
    oldCancelled,
    current
  ];
  const ports = deferredAuthorityPorts(undefined, {
    turns,
    attention: (turn) => turn.turn_id === oldCallbackAndSubmissionDebt.turn_id
  });

  const history = deferredCandidateSourceTurnHistory(
    ports,
    "/store",
    source
  );
  assert.deepEqual(history?.map((turn) => turn.turn_id), ["turn-current"]);
  assert.equal(history?.[0].binding_id, "binding-current");
  assert.equal(history?.[0].binding_generation, 5);
  assert.equal(history?.[0].native_thread_id, THREAD_A);

  const changedCurrent = {
    ...current,
    user_request: "mutated current-generation request"
  };
  const changedHistory = deferredCandidateSourceTurnHistory(
    deferredAuthorityPorts(undefined, {
      turns: [
        legacyWithoutPersistedBinding,
        acceptedWithoutCallback,
        oldCallbackAndSubmissionDebt,
        oldCancelled,
        changedCurrent
      ],
      attention: (turn) => turn.turn_id === oldCallbackAndSubmissionDebt.turn_id
    }),
    "/store",
    source
  );
  assert.notEqual(
    changedHistory?.[0].turn_fingerprint,
    history?.[0].turn_fingerprint,
    "the complete current-generation Turn remains fingerprinted"
  );

  const frozenObservation = observeDeferredCodexAuthority(ports, {
    mode: "boundary_transitioning",
    storeDir: "/store",
    context: {
      terminalId: source.binding!.terminal_id,
      terminalControl: source.binding!.terminal_control,
      pid: source.binding!.native_process.pid,
      workspace: source.workspace
    },
    sourceSession: source,
    candidateInventory: {
      schema: "agent-knock-knock/codex-open-root-rollout-inventory",
      version: 1,
      status: "verified_absent",
      pid: source.binding!.native_process.pid,
      processUuid: "different-process",
      processBirth: "different-birth",
      roots: [],
      inventoryFingerprint: "not-authoritative-for-this-test"
    },
    abandonment: "never",
    fixedSourceRolloutAuthority: "present",
    fixedDispatchSnapshot: { status: "none", fingerprint: "none" }
  });
  assert.deepEqual(
    frozenObservation?.sourceTurnHistory?.map((turn) => turn.turn_id),
    ["turn-current"],
    "the frozen boundary uses the same binding-generation scope"
  );
});

test("candidate history rejects ambiguous or live binding epochs", () => {
  const base = session("session-binding-history");
  const source: ManagedSessionState = {
    ...base,
    binding: {
      ...base.binding!,
      binding_id: "binding-current",
      generation: 5,
      native_thread_id: THREAD_A
    }
  };
  const current = candidateTurn({
    id: "turn-current",
    bindingId: "binding-current",
    bindingGeneration: 5,
    nativeThreadId: THREAD_A
  });
  const partialLegacy = legacyCandidateTurn({
    id: "turn-partial-legacy"
  });
  partialLegacy.terminal_binding_id = "binding-partial";
  const fixtures: Array<{ name: string; turn: Conversation }> = [
    {
      name: "non-released prior Turn",
      turn: candidateTurn({
        id: "turn-prior-stalled",
        bindingId: "binding-prior",
        bindingGeneration: 4,
        nativeThreadId: THREAD_B,
        status: "stalled"
      })
    },
    {
      name: "same generation with another binding",
      turn: candidateTurn({
        id: "turn-same-generation",
        bindingId: "binding-other",
        bindingGeneration: 5,
        nativeThreadId: THREAD_B
      })
    },
    {
      name: "future binding generation",
      turn: candidateTurn({
        id: "turn-future-binding",
        bindingId: "binding-future",
        bindingGeneration: 6,
        nativeThreadId: THREAD_B
      })
    },
    {
      name: "partial legacy binding identity",
      turn: partialLegacy
    },
    {
      name: "quarantined legacy migration",
      turn: legacyCandidateTurn({
        id: "turn-quarantined-legacy",
        withStrongProcessIdentity: false
      })
    }
  ];

  for (const fixture of fixtures) {
    const history = deferredCandidateSourceTurnHistory(
      deferredAuthorityPorts(undefined, {
        turns: [fixture.turn, current]
      }),
      "/store",
      source
    );
    assert.equal(history, undefined, fixture.name);
  }

  const generationOneSource: ManagedSessionState = {
    ...source,
    binding: { ...source.binding!, generation: 1 }
  };
  assert.equal(deferredCandidateSourceTurnHistory(
    deferredAuthorityPorts(undefined, {
      turns: [legacyCandidateTurn({ id: "turn-legacy-not-earlier" })]
    }),
    "/store",
    generationOneSource
  ), undefined, "a migrated legacy generation must be strictly earlier");
});

test("candidate history keeps current-generation callback and attention gates", () => {
  const base = session("session-binding-history");
  const source: ManagedSessionState = {
    ...base,
    binding: {
      ...base.binding!,
      binding_id: "binding-current",
      generation: 5,
      native_thread_id: THREAD_A
    }
  };
  const fixtures: Array<{
    name: string;
    turn: Conversation;
    attention?: boolean;
  }> = [
    {
      name: "pending callback",
      turn: candidateTurn({
        id: "turn-current-pending",
        bindingId: "binding-current",
        bindingGeneration: 5,
        nativeThreadId: THREAD_A,
        callbackStatus: "pending"
      })
    },
    {
      name: "failed callback",
      turn: candidateTurn({
        id: "turn-current-failed",
        bindingId: "binding-current",
        bindingGeneration: 5,
        nativeThreadId: THREAD_A,
        callbackStatus: "failed"
      })
    },
    {
      name: "accepted without callback",
      turn: candidateTurn({
        id: "turn-current-accepted-without-callback",
        bindingId: "binding-current",
        bindingGeneration: 5,
        nativeThreadId: THREAD_A,
        status: "closed",
        callbackStatus: null,
        submissionStatus: "agent_accepted"
      })
    },
    {
      name: "uncertain undelivered submission",
      turn: candidateTurn({
        id: "turn-current-uncertain",
        bindingId: "binding-current",
        bindingGeneration: 5,
        nativeThreadId: THREAD_A,
        callbackStatus: null,
        submissionStatus: "uncertain"
      })
    },
    {
      name: "attention",
      turn: candidateTurn({
        id: "turn-current-attention",
        bindingId: "binding-current",
        bindingGeneration: 5,
        nativeThreadId: THREAD_A
      }),
      attention: true
    }
  ];
  for (const fixture of fixtures) {
    assert.equal(deferredCandidateSourceTurnHistory(
      deferredAuthorityPorts(undefined, {
        turns: [fixture.turn],
        attention: () => fixture.attention === true
      }),
      "/store",
      source
    ), undefined, fixture.name);
  }
});

test("send authority preserves verified, external, deferred precedence", () => {
  const decision = decideTerminalSendAuthority({
    ownership: "conflict",
    verifiedEmpty: true,
    verifiedEmptyToken: "verified-token",
    externalHandoff: true,
    externalToken: "external-token",
    deferred: true,
    deferredToken: "deferred-token"
  });
  assert.deepEqual(decision, {
    mode: "verified_empty",
    token: "verified-token"
  });
  assert.deepEqual(decideTerminalSendAuthority({
    ownership: "conflict",
    externalHandoff: true,
    externalToken: "external-token",
    deferred: true,
    deferredToken: "deferred-token"
  }), { mode: "external_handoff", token: "external-token" });
  assert.deepEqual(decideTerminalSendAuthority({
    ownership: "none",
    deferred: true,
    deferredToken: "deferred-token"
  }), { mode: "deferred", token: "deferred-token" });
});

test("candidate root authority rejects split proofs and status-card abandonment", () => {
  const sourceRollout = {
    fd: "21",
    device: "1",
    inode: "101",
    path: "/repo/source.jsonl"
  };
  const root = (sessionId: string, inode: string) => ({
    sessionId,
    processUuid: "codex-pid:4100:birth:12345",
    processBirth: "12345",
    rollout: { ...sourceRollout, inode }
  });
  const splitRoots = [root(THREAD_A, "202"), root(THREAD_B, "101")];
  assert.equal(candidateSourceRootAuthorityMatches(
    splitRoots,
    THREAD_A,
    sourceRollout,
    "present"
  ), false);
  assert.equal(candidateSourceRootAuthorityMatches(
    splitRoots,
    THREAD_A,
    sourceRollout,
    "explicitly_abandoned_predecessor"
  ), false);
  assert.equal(candidateSourceRootAuthorityMatches(
    [root(THREAD_A, "101")],
    THREAD_A,
    sourceRollout,
    "present"
  ), true);
  assert.equal(candidateSourceRootAuthorityMatches(
    [],
    THREAD_A,
    sourceRollout,
    "explicitly_abandoned_predecessor"
  ), true);
  assert.equal(candidateSourceRootAuthorityMatches(
    splitRoots,
    THREAD_A,
    undefined,
    "explicitly_abandoned_predecessor"
  ), false, "status-card-only sources cannot become abandoned candidates");
});

test("safe terminal send keeps status getter and rejection priority", () => {
  const trace: string[] = [];
  assert.throws(
    () => assertSafeTerminalSend("codex", undefined),
    /Codex terminal status is unavailable/u
  );
  const unreachable = {
    provider: "tmux",
    target: "work:0.0",
    agent: "codex",
    capabilities: {},
    get approval_state() {
      trace.push("approval");
      return { blocked: true, reason: "must remain lower priority" };
    },
    get reachable() {
      trace.push("reachable");
      return false;
    },
    get activity_state() {
      trace.push("activity");
      return "working";
    }
  } as unknown as TerminalBridgeStatus;
  assert.throws(
    () => assertSafeTerminalSend("codex", unreachable),
    /Codex terminal status is unavailable/u
  );
  assert.deepEqual(trace, ["approval", "approval", "reachable"]);

  assert.throws(() => assertSafeTerminalSend("claude", {
    ...unreachable,
    reachable: true,
    approval_state: {
      scanned: true,
      blocked: true,
      approvable: true,
      reason: "approval required"
    }
  }), /approval required/u);
  assert.throws(() => assertSafeTerminalSend("codex", {
    ...unreachable,
    reachable: true,
    approval_state: { scanned: true, blocked: false, approvable: false },
    activity_state: "working"
  }), /Codex terminal is working, not idle/u);
  assert.doesNotThrow(() => assertSafeTerminalSend("codex", {
    ...unreachable,
    reachable: true,
    approval_state: { scanned: true, blocked: false, approvable: false },
    activity_state: "idle"
  }));
});

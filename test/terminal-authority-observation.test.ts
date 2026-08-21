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
  deferredCodexForegroundDispatchSnapshot,
  type DeferredForegroundAuthorityAdapterPorts
} from "../src/deferred-foreground-authority-cli-adapter.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import { assertSafeTerminalSend } from "../src/terminal-authority-policy.js";
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
  ledger: Record<string, any> | undefined
): DeferredForegroundAuthorityAdapterPorts {
  return {
    turn: {
      terminalControl: () => undefined,
      storeDir: () => undefined,
      turnsForSession: () => [],
      needsAttention: () => false,
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

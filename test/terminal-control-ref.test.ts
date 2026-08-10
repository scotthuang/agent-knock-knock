import test from "node:test";
import assert from "node:assert/strict";
import {
  associateTerminalEndpointEvidence,
  createTerminalEndpointRef,
  hasCanonicalTerminalEndpoint,
  sameTerminalControlIncarnation,
  sameTerminalControlRoute,
  sameTerminalEndpointIdentity,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  tmuxTerminalRouteKey,
  type HerdrTerminalControlRef,
  type TerminalControlRef,
  type TerminalEndpointRef,
  type TmuxTerminalControlRef
} from "../src/terminal-control-ref.js";

function herdrControl(
  overrides: Partial<HerdrTerminalControlRef> = {}
): HerdrTerminalControlRef {
  return {
    kind: "herdr",
    target: "default:w1:p1",
    socketPath: "/Users/me/.config/herdr/herdr.sock",
    session: "default",
    sessionDir: "/Users/me/.config/herdr",
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    terminalId: "term_0123456789abcd",
    panePid: 5_196,
    currentCommand: "claude",
    currentPath: "/repo",
    capabilities: ["screen_status", "send_keys"],
    ...overrides
  };
}

function tmuxControl(
  overrides: Partial<TmuxTerminalControlRef> = {}
): TmuxTerminalControlRef {
  return {
    kind: "tmux",
    target: "work:0.0",
    socketPath: "/private/tmp/tmux-501/default",
    session: "work",
    window: 0,
    pane: 0,
    panePid: 4_200,
    currentCommand: "codex",
    currentPath: "/repo",
    capabilities: ["screen_status", "send_keys"],
    ...overrides
  };
}

function canonicalEndpoint(options: {
  endpointKey: string;
  resourceKey: string;
  routeKey?: string;
  target?: string;
  panePid?: number;
  socketPath?: string;
}): TerminalEndpointRef {
  const target = options.target ?? "work:0.0";
  const panePid = options.panePid ?? 4_200;
  const providerRef = tmuxControl({
    target,
    panePid,
    socketPath: options.socketPath
  });
  return createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey: options.endpointKey,
      resourceKey: options.resourceKey
    },
    route: {
      routeKey: options.routeKey ?? tmuxTerminalRouteKey(
        options.endpointKey,
        target,
        options.socketPath
      ),
      label: target,
      currentCommand: providerRef.currentCommand,
      currentPath: providerRef.currentPath
    },
    processAnchorPid: panePid,
    capabilities: providerRef.capabilities,
    providerRef
  });
}

test("canonical identity does not collide for the same route and PID in different endpoints", () => {
  const left = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-a",
    resourceKey: "pane-id:%1",
    routeKey: "shared-route",
    socketPath: undefined,
    panePid: 9_001
  });
  const right = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-b",
    resourceKey: "pane-id:%1",
    routeKey: "shared-route",
    socketPath: undefined,
    panePid: 9_001
  });

  assert.notEqual(
    terminalEndpointIdentityKey(left),
    terminalEndpointIdentityKey(right)
  );
  assert.equal(sameTerminalEndpointIdentity(left, right), false);
  assert.equal(sameTerminalControlRoute(left, right), false);
  assert.equal(sameTerminalControlIncarnation(left, right), false);
});

test("a stable resource keeps its identity when its current route changes", () => {
  const before = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-a",
    resourceKey: "pane-id:%7",
    routeKey: "route:work:0.0",
    target: "work:0.0",
    socketPath: "/tmp/tmux-a",
    panePid: 9_002
  });
  const after = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-a",
    resourceKey: "pane-id:%7",
    routeKey: "route:renamed:2.1",
    target: "renamed:2.1",
    socketPath: "/tmp/tmux-a",
    panePid: 9_002
  });

  assert.equal(sameTerminalEndpointIdentity(before, after), true);
  assert.equal(
    terminalEndpointIdentityKey(before),
    terminalEndpointIdentityKey(after)
  );
  assert.equal(sameTerminalControlRoute(before, after), false);
  assert.equal(sameTerminalControlIncarnation(before, after), true);
});

test("a process-anchor change is an incarnation drift, not a resource change", () => {
  const before = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-a",
    resourceKey: "pane-id:%9",
    routeKey: "route:work:0.0",
    panePid: 9_003
  });
  const after = canonicalEndpoint({
    endpointKey: "socket:/tmp/tmux-a",
    resourceKey: "pane-id:%9",
    routeKey: "route:work:0.0",
    panePid: 9_004
  });

  assert.equal(sameTerminalEndpointIdentity(before, after), true);
  assert.equal(sameTerminalControlRoute(before, after), true);
  assert.equal(sameTerminalControlIncarnation(before, after), false);
});

test("canonical endpoint evidence survives JSON round-trip and restores a control ref", () => {
  const original = canonicalEndpoint({
    endpointKey: "socket:/private/tmp/tmux-501/default",
    resourceKey: "pane-id:%12",
    target: "work:0.1",
    socketPath: "/private/tmp/tmux-501/default",
    panePid: 9_005
  });
  const roundTrippedEvidence = JSON.parse(JSON.stringify(
    terminalControlEvidence(original.providerRef as TerminalControlRef)
  ));
  const restoredControl = JSON.parse(JSON.stringify(
    original.providerRef
  )) as TerminalControlRef;

  assert.equal(hasCanonicalTerminalEndpoint(restoredControl), false);
  associateTerminalEndpointEvidence(restoredControl, roundTrippedEvidence);

  assert.equal(hasCanonicalTerminalEndpoint(restoredControl), true);
  assert.deepEqual(
    terminalEndpointIdentityFromEvidence(roundTrippedEvidence),
    original.identity
  );
  assert.equal(sameTerminalEndpointIdentity(original, restoredControl), true);
  assert.equal(sameTerminalControlRoute(original, restoredControl), true);
  assert.equal(sameTerminalControlIncarnation(original, restoredControl), true);
  assert.equal(
    terminalControlEvidenceMatches(roundTrippedEvidence, restoredControl, {
      requireCurrentRoute: true
    }),
    true
  );
});

test("Herdr control refs carry intrinsic canonical identity across JSON round-trips", () => {
  const original = herdrControl();
  const evidence = JSON.parse(JSON.stringify(terminalControlEvidence(original)));
  const restored = JSON.parse(JSON.stringify(original)) as HerdrTerminalControlRef;

  assert.equal(hasCanonicalTerminalEndpoint(original), true);
  assert.equal(hasCanonicalTerminalEndpoint(restored), true);
  assert.deepEqual(terminalEndpointFromControlRef(restored).identity, {
    providerKind: "herdr",
    endpointKey: "socket:/Users/me/.config/herdr/herdr.sock",
    resourceKey: "terminal-id:term_0123456789abcd"
  });
  assert.deepEqual(
    terminalEndpointIdentityFromEvidence(evidence),
    terminalEndpointFromControlRef(original).identity
  );
  assert.equal(
    terminalControlEvidenceMatches(evidence, restored, {
      requireCurrentRoute: true,
      requireProcessAnchor: true
    }),
    true
  );
  assert.doesNotThrow(() => associateTerminalEndpointEvidence(restored, evidence));
});

test("Herdr stable identity survives pane moves while route and incarnation fences remain exact", () => {
  const before = herdrControl();
  const moved = herdrControl({
    target: "default:w2:p7",
    workspaceId: "w2",
    tabId: "w2:t3",
    paneId: "w2:p7"
  });
  const restarted = herdrControl({ panePid: 9_999 });
  const otherServer = herdrControl({
    socketPath: "/Users/me/.config/herdr/sessions/other/herdr.sock"
  });

  assert.equal(sameTerminalEndpointIdentity(before, moved), true);
  assert.equal(sameTerminalControlRoute(before, moved), false);
  assert.equal(sameTerminalControlIncarnation(before, moved), true);
  assert.equal(sameTerminalEndpointIdentity(before, restarted), true);
  assert.equal(sameTerminalControlIncarnation(before, restarted), false);
  assert.equal(sameTerminalEndpointIdentity(before, otherServer), false);
});

test("Herdr endpoint evidence rejects route, resource, and process-anchor tampering", () => {
  const control = herdrControl();
  const evidence = terminalControlEvidence(control);
  for (const tampered of [
    { ...evidence, terminal_id: "term_other" },
    { ...evidence, pane_id: "w1:p9" },
    { ...evidence, process_anchor_pid: 9_999 }
  ]) {
    assert.equal(terminalControlEvidenceMatches(tampered, control, {
      requireCurrentRoute: true,
      requireProcessAnchor: true
    }), false);
  }
});

test("legacy refs fall back to the exact target, socket, and pane PID tuple", () => {
  const legacy = tmuxControl({
    target: "legacy:3.2",
    socketPath: "/tmp/legacy-tmux",
    session: "legacy",
    window: 3,
    pane: 2,
    panePid: 9_006
  });
  const exactCopy = JSON.parse(JSON.stringify(legacy)) as TerminalControlRef;
  const changedTarget = tmuxControl({
    ...legacy,
    target: "other:3.2"
  });
  const changedSocket = tmuxControl({
    ...legacy,
    socketPath: "/tmp/other-tmux"
  });
  const changedPid = tmuxControl({
    ...legacy,
    panePid: 9_007
  });
  const legacyEvidence = JSON.parse(JSON.stringify({
    kind: "tmux",
    target: legacy.target,
    socket_path: legacy.socketPath,
    pane_pid: legacy.panePid
  }));

  assert.equal(hasCanonicalTerminalEndpoint(legacy), false);
  assert.match(
    terminalEndpointFromControlRef(legacy).identity.resourceKey,
    /^legacy:/u
  );
  assert.equal(sameTerminalEndpointIdentity(legacy, exactCopy), true);
  assert.equal(sameTerminalControlRoute(legacy, exactCopy), true);
  assert.equal(sameTerminalControlIncarnation(legacy, exactCopy), true);

  assert.equal(sameTerminalEndpointIdentity(legacy, changedTarget), false);
  assert.equal(sameTerminalControlRoute(legacy, changedSocket), false);
  assert.equal(sameTerminalControlIncarnation(legacy, changedPid), false);
  assert.equal(
    terminalControlEvidenceMatches(legacyEvidence, exactCopy, {
      requireCurrentRoute: true
    }),
    true
  );
  assert.equal(terminalControlEvidenceMatches(legacyEvidence, changedTarget), false);
  assert.equal(terminalControlEvidenceMatches(legacyEvidence, changedSocket), false);
  assert.equal(terminalControlEvidenceMatches(legacyEvidence, changedPid), false);
});

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
  type TerminalControlRef,
  type TerminalEndpointRef
} from "../src/terminal-control-ref.js";

function tmuxControl(
  overrides: Partial<TerminalControlRef> = {}
): TerminalControlRef {
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

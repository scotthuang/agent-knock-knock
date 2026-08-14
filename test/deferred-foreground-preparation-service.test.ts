import assert from "node:assert/strict";
import test from "node:test";

import type { DeferredForegroundApplicationScope } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundBindingBoundary } from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import {
  deferredForegroundBoundaryProjection,
  deferredForegroundConcreteBoundary,
  deferredForegroundTransferMatchesTerminal,
  projectDeferredForegroundTerminalFacts
} from "../src/deferred-foreground-preparation-cli-adapter.js";
import {
  prepareDeferredForegroundBinding,
  type DeferredForegroundFreshAuthority,
  type DeferredForegroundPreparationPorts
} from "../src/deferred-foreground-preparation-service.js";
import {
  terminalBindingFrom,
  type ManagedSessionState
} from "../src/managed-session.js";
import type { ResolvedTerminalConversation } from
  "../src/terminal-agent-bridge.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";

const NOW = "2026-08-15T00:00:00.000Z";
const CONTROL: TerminalControlRef = {
  kind: "herdr",
  target: "w1:p1",
  socketPath: "/tmp/herdr-session/herdr.sock",
  sessionDir: "/tmp/herdr-session",
  workspaceId: "w1",
  tabId: "t1",
  paneId: "p1",
  terminalId: "term-1",
  session: "w1",
  panePid: 5102,
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};
const RESOLVED_TERMINAL = {
  conversationId: "terminal-1",
  agent: "codex",
  pid: 5102,
  legacy: false,
  adapter: { broadCapability: "must-not-cross-service-boundary" },
  terminalControl: CONTROL
} as unknown as ResolvedTerminalConversation;
const TERMINAL_KEYS = [
  "agent",
  "canonicalEndpoint",
  "conversationId",
  "endpoint",
  "pid",
  "resourceKey",
  "target",
  "workspace"
];
const REQUEST_KEYS = [
  "allowImplicitFreshAuthority",
  "expectedTerminalToken",
  "nativeIdentityVerifiedAbsent",
  "requestText",
  "scope",
  "sourceSession",
  "terminal"
];
const BOUNDARY_KEYS = [
  "previousDispatchSnapshot",
  "processBirth",
  "processUuid",
  "sourceBoundBindingToken",
  "sourceBoundRevision",
  "sourceKind",
  "sourceRolloutAuthority",
  "sourceSessionId",
  "targetSessionId",
  "terminal",
  "transferId"
];

function sourceSession(): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "source-1",
    revision: 3,
    agent: "codex",
    workspace: "/workspace",
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: "terminal-1",
      terminalControl: CONTROL,
      pid: 5102,
      nativeThreadId: "11111111-1111-4111-8111-111111111111",
      processUuid: "process-1",
      processBirth: "birth-1",
      evidence: "codex_status_card+process_birth",
      generation: 1,
      now: new Date(NOW)
    }),
    lineage: { created_by: "attach" },
    created_at: NOW,
    updated_at: NOW
  };
}

function harness(expectedToken: string): {
  request: Parameters<typeof prepareDeferredForegroundBinding>[0];
  ports: DeferredForegroundPreparationPorts;
  trace: string[];
  saved: DeferredForegroundTransfer[];
} {
  const trace: string[] = [];
  const saved: DeferredForegroundTransfer[] = [];
  const freshAuthority: DeferredForegroundFreshAuthority = {
    sourceKind: "status_card_only",
    sourceRolloutAuthority: "present",
    dispatchSnapshot: { status: "none", fingerprint: "b".repeat(64) },
    exactSource: true
  };
  const scope = {
    listTransfers: () => {
      trace.push("transfer:list");
      return [];
    },
    saveTransfer: (transfer: DeferredForegroundTransfer, revision: number | null) => {
      assert.equal(revision, null);
      trace.push("transfer:save");
      saved.push(transfer);
      return { ...transfer, revision: 1 };
    }
  } as unknown as DeferredForegroundApplicationScope;
  const ports: DeferredForegroundPreparationPorts = {
    authority: {
      processIncarnation: (pid) => {
        assert.equal(pid, 5102);
        trace.push("authority:process");
        return { processUuid: "process-1", processBirth: "birth-1" };
      },
      observeFresh: (input) => {
        assert.deepEqual(Object.keys(input).sort(), [
          "candidateInventory",
          "liveIncarnation",
          "sourceSession"
        ]);
        trace.push("authority:observe-fresh");
        return freshAuthority;
      },
      revalidate: async (_activeScope, boundary) => {
        assert.deepEqual(Object.keys(boundary.terminal).sort(), TERMINAL_KEYS);
        assert.equal("adapter" in boundary.terminal, false);
        assert.equal("terminalControl" in boundary.terminal, false);
        trace.push("authority:revalidate");
      },
      assertExclusive: async () => {
        trace.push("authority:exclusive");
      },
      candidateInventoryUnclaimed: () => true,
      abandonmentStillFresh: () => true,
      transferMatchesTerminal: () => false
    },
    identity: {
      targetSessionId: () => {
        trace.push("identity:target");
        return "target-1";
      },
      transferId: () => {
        trace.push("identity:transfer");
        return "transfer-1";
      },
      captureCandidateAnchor: () => {
        throw new Error("candidate anchor is not expected");
      },
      bindingToken: ({ authority }) => {
        assert.equal(authority, freshAuthority);
        trace.push("authority:fresh-token");
        return "fresh-list-token";
      },
      requestHash: () => {
        trace.push("identity:request-hash");
        return "c".repeat(64);
      }
    },
    runtime: {
      now: () => {
        trace.push("clock:now");
        return new Date(NOW);
      },
      pid: () => {
        trace.push("runtime:pid");
        return 99;
      },
      log: () => trace.push("runtime:log")
    }
  };
  return {
    request: {
      scope,
      terminal: projectDeferredForegroundTerminalFacts(RESOLVED_TERMINAL),
      sourceSession: sourceSession(),
      nativeIdentityVerifiedAbsent: true,
      requestText: "ordinary task",
      expectedTerminalToken: expectedToken,
      allowImplicitFreshAuthority: false
    },
    ports,
    trace,
    saved
  };
}

test("preparation projects data-only terminal facts and revalidates before CAS publish", async () => {
  const recording = harness("fresh-list-token");
  assert.deepEqual(Object.keys(recording.request).sort(), REQUEST_KEYS);
  assert.deepEqual(
    Object.keys(recording.request.terminal).sort(),
    TERMINAL_KEYS
  );
  const boundary = await prepareDeferredForegroundBinding(
    recording.request,
    recording.ports
  );
  assert.ok(boundary);
  assert.deepEqual(Object.keys(boundary).sort(), BOUNDARY_KEYS);
  assert.equal("adapter" in boundary, false);
  assert.equal("terminalControl" in boundary, false);
  assert.deepEqual(Object.keys(boundary.terminal).sort(), TERMINAL_KEYS);
  assert.deepEqual(recording.trace, [
    "authority:process",
    "authority:observe-fresh",
    "authority:fresh-token",
    "identity:target",
    "identity:transfer",
    "authority:revalidate",
    "authority:exclusive",
    "transfer:list",
    "identity:request-hash",
    "runtime:pid",
    "clock:now",
    "transfer:save"
  ]);
  assert.equal(recording.saved.length, 1);
  assert.equal(recording.saved[0].revision, undefined);

  const concrete = deferredForegroundConcreteBoundary(
    boundary,
    RESOLVED_TERMINAL
  );
  const projected = deferredForegroundBoundaryProjection(concrete);
  assert.equal(projected, boundary);
  projected.sourceReservedRevision = 4;
  projected.targetPreparedRevision = 1;
  assert.equal(
    deferredForegroundBoundaryProjection(concrete).sourceReservedRevision,
    4
  );
  assert.equal(
    deferredForegroundBoundaryProjection(concrete).targetPreparedRevision,
    1
  );
  assert.equal(deferredForegroundTransferMatchesTerminal({
    ...recording.saved[0],
    process_pid: 999_999
  }, RESOLVED_TERMINAL), true);
});

test("stale list token still performs fresh observation but never reaches mutation", async () => {
  const recording = harness("stale-list-token");
  await assert.rejects(
    prepareDeferredForegroundBinding(recording.request, recording.ports),
    /fresh exact terminal token advertised by AKK list/u
  );
  assert.deepEqual(recording.trace, [
    "authority:process",
    "authority:observe-fresh",
    "authority:fresh-token"
  ]);
  assert.deepEqual(recording.saved, []);
});

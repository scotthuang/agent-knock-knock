import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyManagedSessionBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";
import {
  canonicalMutationResource,
  capabilityGatedRepositoryOperation,
  capabilityGatedRepositoryPairOperation
} from "../src/mutation-transaction.js";
import {
  reconcileTerminalBinding,
  type BindingReconciliationPorts,
  type BindingReconciliationResult
} from "../src/terminal-binding-reconciliation-service.js";
import type {
  TerminalAgentAdapter,
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalBridgeStatus
} from "../src/terminal-agent-bridge.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 123,
  currentCommand: "codex",
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};
const ADAPTER = {} as TerminalAgentAdapter;
const STATUS: TerminalBridgeStatus = {
  provider: "fixture",
  target: CONTROL.target,
  agent: "codex",
  reachable: true,
  capabilities: {
    processDiscovery: true,
    screenStatus: true,
    terminalApproval: false,
    screenCompletion: false,
    durableCompletion: false,
    cancellation: false
  },
  activity_state: "idle",
  activity_reason: "fixture idle",
  approval_state: {
    scanned: true,
    blocked: false,
    approvable: false
  },
  screen: {}
};
const IDENTITY = {
  sessionId: "11111111-1111-4111-8111-111111111111",
  evidence: "fixture"
};

function terminal(control = CONTROL): ResolvedTerminalConversation {
  return {
    conversationId: "tmux:codex:akk:0.0:456",
    agent: "codex",
    pid: 456,
    legacy: false,
    adapter: ADAPTER,
    terminalControl: control
  };
}

function boundSession(): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-conflict",
    revision: 7,
    agent: "codex",
    workspace: "/workspace",
    status: "bound",
    binding: {
      binding_id: "binding-conflict",
      generation: 1,
      terminal_id: "tmux:codex:akk:0.0:456",
      terminal_control: CONTROL,
      native_thread_id: "22222222-2222-4222-8222-222222222222",
      native_process: {
        pid: 456,
        process_uuid: "codex-pid:456:birth:fixture",
        process_birth: "fixture",
        evidence: "fixture"
      },
      bound_at: "2026-08-14T00:00:00.000Z",
      last_verified_at: "2026-08-14T00:00:00.000Z"
    },
    lineage: { created_by: "attach" },
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z"
  };
}

function fixture(options: {
  changeSessionDuringStatus?: boolean;
  presenterError?: Error;
} = {}) {
  const events: string[] = [];
  const store = { session: boundSession() };
  const initialTerminal = terminal();
  const resolutions = [terminal(), terminal()];
  let presented: BindingReconciliationResult | undefined;
  const sessions = {
    load: capabilityGatedRepositoryOperation(
      ["storeWriter"] as const,
      "storeWriter",
      (resource: typeof store, sessionId: string) => {
        events.push("load-session");
        assert.equal(sessionId, resource.session.session_id);
        return resource.session;
      }
    ),
    save: capabilityGatedRepositoryOperation(
      ["storeWriter"] as const,
      "storeWriter",
      (
        resource: typeof store,
        state: ManagedSessionState,
        saveOptions: { expectedRevision: number }
      ) => {
        events.push("save-session");
        assert.equal(resource.session.revision, saveOptions.expectedRevision);
        resource.session = { ...state, revision: saveOptions.expectedRevision + 1 };
        return resource.session;
      }
    )
  };
  const recover = capabilityGatedRepositoryPairOperation(
    ["terminal", "storeWriter"] as const,
    ["terminal", "storeWriter"] as const,
    async (
      lockedControl: TerminalControlRef,
      lockedStore: typeof store,
      observed: ResolvedTerminalConversation
    ) => {
      events.push("recover");
      assert.equal(lockedControl, CONTROL);
      assert.equal(lockedStore, store);
      assert.equal(observed.conversationId, initialTerminal.conversationId);
      assert.equal(observed.terminalControl, CONTROL);
    }
  );
  const ports = {
    transaction: {
      locks: {
        resources: {
          terminal: canonicalMutationResource("terminal", CONTROL),
          storeWriter: canonicalMutationResource("store", store)
        },
        acquireTerminal: () => {
          events.push("acquire-terminal");
          return () => events.push("release-terminal");
        },
        withStoreWriter: async <Result>(operation: () => Promise<Result>) => {
          events.push("acquire-writer");
          try {
            return await operation();
          } finally {
            events.push("release-writer");
          }
        }
      },
      recover,
      loadSession: sessions.load,
      saveSession: sessions.save
    },
    terminal: {
      resolve: async () => {
        events.push(`resolve-${resolutions.length === 2 ? "current" : "final"}`);
        return resolutions.shift()!;
      },
      sameIncarnation: (left, right) => {
        events.push("same-incarnation");
        return left === right;
      },
      identity: async () => {
        events.push("identity");
        return IDENTITY;
      },
      prepareStatus: () => {
        events.push("prepare-status");
        return async () => {
          events.push("status");
          if (options.changeSessionDuringStatus) {
            store.session = { ...store.session, revision: 8 };
          }
          return STATUS;
        };
      },
      assertReady: () => events.push("assert-ready")
    },
    authority: {
      dispatchIsFree: () => (events.push("dispatch"), true),
      sessionClaimsTerminal: () => (events.push("session-claim"), true),
      terminalTokenMatches: (_terminal, _identity, token) =>
        (events.push("terminal-token"), token === "terminal-token"),
      hasUnresolvedTransition: () =>
        (events.push("transition-blocker"), false),
      blockingTurn: () => (events.push("turn-blocker"), undefined),
      conflictKind: () =>
        (events.push("conflict"), "live_external_thread_change" as const)
    },
    now: () => (events.push("now"), "2026-08-14T01:02:03.000Z"),
    present: (result) => {
      events.push("present");
      presented = result;
      if (options.presenterError) throw options.presenterError;
    }
  } satisfies BindingReconciliationPorts<
    ResolvedTerminalConversation,
    TerminalBridgeStatus
  >;
  return {
    events,
    store,
    ports,
    request: {
      initialTerminal,
      conflictingSessionId: store.session.session_id,
      expectedSessionRevision: 7,
      expectedBindingToken: legacyManagedSessionBindingToken(store.session),
      expectedTerminalToken: "terminal-token"
    },
    presented: () => presented
  };
}

test("binding reconciliation preserves fresh authority, CAS, presentation, and release order", async () => {
  const subject = fixture();
  await reconcileTerminalBinding(subject.request, subject.ports);
  assert.deepEqual(subject.events, [
    "acquire-terminal", "acquire-writer", "resolve-current", "same-incarnation",
    "recover", "dispatch", "load-session", "session-claim", "identity",
    "terminal-token", "prepare-status", "transition-blocker", "turn-blocker", "resolve-final",
    "same-incarnation", "status", "assert-ready", "identity", "terminal-token",
    "load-session", "conflict", "now", "save-session", "present",
    "release-writer", "release-terminal"
  ]);
  assert.equal(subject.store.session.status, "detached");
  assert.equal(subject.store.session.revision, 8);
  const presented = subject.presented();
  assert.ok(presented);
  assert.equal(presented.terminal.conversationId, "tmux:codex:akk:0.0:456");
  assert.equal(presented.terminal.terminalControl.target, "akk:0.0");
  assert.equal(presented.detached.session_id, "session-conflict");
  assert.equal(presented.detached.binding?.binding_id, "binding-conflict");
  assert.equal(presented.detached.revision, 8);
  assert.equal(presented.conflictKind, "live_external_thread_change");
});

test("binding reconciliation rejects a fresh locked Session revision change before decision", async () => {
  const subject = fixture({ changeSessionDuringStatus: true });
  await assert.rejects(
    reconcileTerminalBinding(subject.request, subject.ports),
    /managed Session binding changed during reconciliation/u
  );
  assert.equal(subject.events.includes("conflict"), false);
  assert.equal(subject.events.includes("save-session"), false);
  assert.deepEqual(subject.events.slice(-2), ["release-writer", "release-terminal"]);
});

test("binding reconciliation releases both locks after a presenter failure", async () => {
  const subject = fixture({ presenterError: new Error("presenter failed") });
  await assert.rejects(
    reconcileTerminalBinding(subject.request, subject.ports),
    /presenter failed/u
  );
  assert.deepEqual(subject.events.slice(-3), [
    "present", "release-writer", "release-terminal"
  ]);
  assert.equal(subject.store.session.status, "detached");
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createTerminalIdentityAuthorityCliAdapter,
  type CreateTerminalIdentityAuthorityCliAdapterInput
} from "../src/terminal-identity-authority-cli-adapter.js";
import {
  codexCompanionSet,
  exactLifecycleIdentity,
  verifiedEmptySourceSnapshotMatches
} from "../src/terminal-identity-authority-service.js";
import { StaticTerminalProcessSource } from
  "../src/terminal-process-source.js";
import { StaticTerminalControlProvider } from
  "../src/terminal-control-provider.js";
import { createProductionTerminalAgentRegistry } from
  "../src/terminal-agent-registry.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import { saveManagedSession } from "../src/session-store.js";
import { terminalBindingFrom } from "../src/managed-session.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { associateTerminalEndpointEvidence, terminalControlEvidence } from
  "../src/terminal-control-ref.js";

function adapter(
  environment: Partial<
    CreateTerminalIdentityAuthorityCliAdapterInput["environment"]
  > = {},
  customize: (ports: CreateTerminalIdentityAuthorityCliAdapterInput) => void =
    () => undefined
) {
  const unexpected = (): never => {
    throw new Error("unexpected identity adapter port call");
  };
  const ports: CreateTerminalIdentityAuthorityCliAdapterInput = {
    runtime: {
      createBridge: unexpected,
      createControlProvider: unexpected,
      createProcessSource: () => new StaticTerminalProcessSource([]),
      createAgentRegistry: unexpected,
      observeNativeIdentity: async () => ({
        status: "verified_absent",
        evidence: "native_identity_resolver_verified_absent"
      }),
      probeCodexCurrentThread: async () => unexpected()
    },
    store: {
      terminalControlFromTakeover: () => undefined,
      storeDir: () => "/tmp/identity-store",
      storeDirForStatePath: () => "/tmp/identity-store",
      storeDirForConversation: () => undefined,
      withWriter: (_storeDir, operation) => operation(),
      turnsForSession: () => [],
      turnMatchesTerminal: () => false,
      isDiscoverableTurn: () => false,
      readEvents: () => [],
      loadLedger: () => undefined,
      ledgerMatchesControl: () => false,
      ledgerProcessAnchor: () => undefined,
      acquireStateLock: unexpected,
      loadTurn: unexpected,
      saveTurn: unexpected,
      appendEvent: unexpected
    },
    authority: {
      assertTurnBindingCurrent: unexpected,
      assertManagedSessionCanStartTurn: unexpected,
      assertNativeThreadHasExclusiveOwnership: async () => unexpected(),
      assertSafeTerminalSend: unexpected,
      assertTerminalLifecycleReady: unexpected,
      provisionalManagedBindingTurnCount: () => undefined,
      managedTurnNeedsAttention: () => false,
      hasUnresolvedNativeTransition: () => false,
      hasAnyNativeTransition: () => false
    },
    environment: {
      cwd: () => "/tmp/identity-workspace",
      now: () => new Date("2026-08-15T00:00:00.000Z"),
      isProcessAlive: () => true,
      workspaceMatches: () => true,
      ...environment
    },
    completion: { requiresExactBoundCodexCompletion: () => false }
  };
  customize(ports);
  assert.deepEqual(Object.keys(ports).sort(), [
    "authority", "completion", "environment", "runtime", "store"
  ]);
  return createTerminalIdentityAuthorityCliAdapter(ports);
}

test("identity facts preserve lifecycle fallback and malformed fail-closed rules", () => {
  assert.deepEqual(exactLifecycleIdentity({
    agent: "codex",
    pid: 41,
    identity: { sessionId: "native-41", evidence: "status_card" },
    codexIncarnation: {
      processUuid: "codex-pid:41:birth:first",
      processBirth: "first"
    }
  }), {
    sessionId: "native-41",
    evidence: "status_card",
    processBirth: "first",
    processUuid: "codex-pid:41:birth:first"
  });
  assert.throws(() => exactLifecycleIdentity({
    agent: "claude",
    pid: 42,
    identity: { sessionId: "native-42", evidence: "agents_json" }
  }), /Claude lifecycle process incarnation is unavailable for pid 42/u);
  assert.equal(verifiedEmptySourceSnapshotMatches({
    expectedStatus: "detached",
    currentStatus: "detached",
    expectedRevision: 3,
    currentRevision: 4,
    expectedBindingToken: "binding-a",
    currentBindingToken: "binding-a"
  }), false);
});

test("companion selection keeps the primary fence and deterministic uniqueness", () => {
  const first = {
    sessionId: "11111111-1111-4111-8111-111111111111",
    processUuid: "codex-pid:51:birth:one",
    processBirth: "one",
    rollout: { fd: "7", device: "1", inode: "2", path: "/tmp/one" }
  };
  const second = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    processUuid: "codex-pid:51:birth:one",
    processBirth: "one",
    rollout: { fd: "8", device: "1", inode: "3", path: "/tmp/two" }
  };
  assert.deepEqual(codexCompanionSet({
    primary: first,
    candidates: [first, second, second]
  }), { primary: first, additional: [second] });
});

test("runtime identity requires the exact binding and adds committed companions lazily", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-identity-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = terminalControl();
  const processIdentity = {
    pid: 101,
    processUuid: "codex-process-101",
    processBirth: "birth-101",
    rollout: { fd: "7", device: "1", inode: "2", path: "/tmp/rollout-101" }
  };
  const oldBinding = terminalBindingFrom({
    terminalId: "terminal:v2:tmux:codex:%1:101", terminalControl: control,
    ...processIdentity,
    nativeThreadId: "11111111-1111-4111-8111-111111111111",
    evidence: "test", generation: 1,
    now: new Date("2026-08-20T00:00:00.000Z")
  });
  saveManagedSession(root, {
    schema: "agent-knock-knock/session", version: 1,
    session_id: "managed-old", agent: "codex", workspace: "/workspace",
    status: "detached", binding: oldBinding,
    detached_at: "2026-08-20T00:00:01.000Z",
    lineage: { created_by: "attach" },
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:01.000Z"
  }, { expectedRevision: null });
  const nativeThreadId = "22222222-2222-4222-8222-222222222222";
  const binding = terminalBindingFrom({
    terminalId: "terminal:v2:tmux:codex:%1:101", terminalControl: control,
    ...processIdentity, nativeThreadId, evidence: "test", generation: 2,
    now: new Date("2026-08-20T00:00:02.000Z")
  });
  saveManagedSession(root, {
    schema: "agent-knock-knock/session", version: 1,
    session_id: "managed-main", agent: "codex", workspace: "/workspace",
    status: "bound", binding, lineage: { created_by: "attach" },
    created_at: "2026-08-20T00:00:02.000Z",
    updated_at: "2026-08-20T00:00:02.000Z"
  }, { expectedRevision: null });
  const conversation = {
    ...createConversation({
      userRequest: "fallback request", sessionId: "managed-main",
      turnId: "turn-main", executorKind: "codex",
      now: new Date("2026-08-20T00:00:03.000Z")
    }),
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: binding.generation,
    native_session_takeover: {
      terminal_agent_identity_protocol: 1,
      terminal_agent_pid: processIdentity.pid,
      terminal_agent_session_id: nativeThreadId,
      terminal_agent_process_uuid: processIdentity.processUuid,
      terminal_agent_process_birth: processIdentity.processBirth,
      terminal_agent_rollout: processIdentity.rollout,
      terminal_bridge_request_text: "takeover request",
      terminal_bridge_request_hash: "request-hash",
      terminal_bridge_started_at: "2026-08-20T00:00:03.000Z"
    }
  } satisfies Conversation;
  const facade = adapter({}, (ports) => {
    ports.store.storeDirForConversation = () => root;
  });
  const runtime = facade.terminalRuntimeIdentityForConversation(conversation, control);
  assert.equal(runtime.pid, processIdentity.pid);
  assert.deepEqual(runtime.allowedPreMaterializationNativeIdentity, {
    sessionId: oldBinding.native_thread_id,
    processUuid: processIdentity.processUuid,
    processBirth: processIdentity.processBirth,
    rollout: processIdentity.rollout
  });
  assert.deepEqual(runtime.allowedAdditionalNativeIdentities, []);
  assert.deepEqual(facade.terminalDurableRequestForConversation(
    conversation, control), {
    sessionId: nativeThreadId,
    cwd: undefined,
    requestText: "takeover request",
    requestHash: "request-hash",
    startedAt: "2026-08-20T00:00:03.000Z",
    context: {
      conversation,
      nativeTakeover: conversation.native_session_takeover,
      ...runtime
    }
  });

  const stale = facade.terminalRuntimeIdentityForConversation({
    ...conversation, terminal_binding_generation: binding.generation + 1
  }, control);
  assert.equal("allowedAdditionalNativeIdentities" in stale, false);
});

test("endpoint refinement persists only matching canonical incarnation evidence", () => {
  const control = terminalControl();
  associateTerminalEndpointEvidence(control, terminalControlEvidence(control));
  const stored = { ...control };
  let saved: Conversation | undefined;
  const facade = adapter({}, (ports) => {
    ports.store.terminalControlFromTakeover = () => stored;
    ports.store.saveTurn = (_path, conversation) => { saved = conversation; };
  });
  const conversation = {
    ...createConversation({
      userRequest: "refine", sessionId: "managed-refine", turnId: "turn-refine",
      executorKind: "codex", now: new Date("2026-08-20T00:00:00.000Z")
    }),
    native_session_takeover: { terminal_control: stored }
  } satisfies Conversation;
  const refined = facade.refineTerminalTurnEndpoint({
    conversation, statePath: "/store/turn-refine/state.json", terminalControl: control
  });
  assert.equal(saved, refined);
  const endpoint = (refined.native_session_takeover as Record<string, unknown>)
    .terminal_endpoint as Record<string, unknown>;
  assert.equal(endpoint.schema, "agent-knock-knock/terminal-endpoint");
  assert.equal(endpoint.version, 1);
  assert.equal(endpoint.kind, "tmux");
  assert.equal(endpoint.target, "%1");
  assert.equal(endpoint.socket_path, "/tmp/tmux.sock");
  assert.equal(endpoint.pane_pid, 100);
});

test("legacy identity migration keeps writer, lock, event, and log order", async () => {
  const trace: string[] = [];
  const fixture = legacyMigrationFixture(trace);
  const result = await runCliCommandExecution("identity-migration", {}, {
    runtimeLog: (_level, event) => {
      if (event === "terminal_agent_identity_migrated") trace.push(`log:${event}`);
    }
  }, async () => {
    const migrated = await fixture.facade.migrateLegacyTerminalAgentIdentity({
      conversation: fixture.conversation,
      statePath: "/store/turn-legacy/state.json",
      logPath: "/store/turn-legacy/events.ndjson",
      options: {}
    });
    assert.equal(
      (migrated.native_session_takeover as Record<string, unknown>)
        .terminal_agent_pid,
      101
    );
  });
  assert.deepEqual(result, { exitCode: 0, stdout: "" });
  assert.deepEqual(trace, [
    "writer", "lock", "load", "save", "unlock", "writer-release", "event",
    "log:terminal_agent_identity_migrated"
  ]);
});

test("legacy identity migration downgrades only observation failure to warning", async () => {
  const trace: string[] = [];
  const fixture = legacyMigrationFixture(trace, "observation");
  await runCliCommandExecution("identity-migration", {}, {
    runtimeLog: (_level, event) => {
      if (event === "legacy_terminal_agent_identity_migration_failed") {
        trace.push(`log:${event}`);
      }
    }
  }, async () => {
    const result = await fixture.facade.migrateLegacyTerminalAgentIdentity({
      conversation: fixture.conversation,
      statePath: "/store/turn-legacy/state.json",
      logPath: "/store/turn-legacy/events.ndjson",
      options: {}
    });
    assert.equal(result, fixture.conversation);
  });
  assert.deepEqual(trace, ["log:legacy_terminal_agent_identity_migration_failed"]);
});

test("legacy identity migration propagates writer, save, and event failures after cleanup", async () => {
  for (const failure of ["writer", "save", "event"] as const) {
    const trace: string[] = [];
    const fixture = legacyMigrationFixture(trace, failure);
    await assert.rejects(() => runCliCommandExecution("identity-migration", {}, {
      runtimeLog: (_level, event) => {
        if (event === "terminal_agent_identity_migrated") trace.push(`log:${event}`);
      }
    }, async () => {
      await fixture.facade.migrateLegacyTerminalAgentIdentity({
        conversation: fixture.conversation,
        statePath: "/store/turn-legacy/state.json",
        logPath: "/store/turn-legacy/events.ndjson",
        options: {}
      });
    }), new RegExp(`${failure} failed`, "u"));
    assert.equal(trace.includes("unlock"), failure !== "writer");
    assert.equal(trace.some((entry) => entry.startsWith("log:")), false);
    if (failure === "writer") {
      assert.deepEqual(trace, ["writer"]);
    } else if (failure === "save") {
      assert.deepEqual(trace, [
        "writer", "lock", "load", "save", "unlock", "writer-release"
      ]);
    } else {
      assert.deepEqual(trace, [
        "writer", "lock", "load", "save", "unlock", "writer-release", "event"
      ]);
    }
  }
});

function terminalControl(): TerminalControlRef {
  return {
    kind: "tmux", target: "%1", socketPath: "/tmp/tmux.sock",
    session: "work", window: 0, pane: 1, panePid: 100,
    currentCommand: "codex", currentPath: "/workspace",
    capabilities: ["screen_status", "send_keys", "durable_completion"]
  };
}

function legacyMigrationFixture(
  trace: string[],
  failure?: "observation" | "writer" | "save" | "event"
): { facade: ReturnType<typeof adapter>; conversation: Conversation } {
  const control = terminalControl();
  const nativeSessionId = "33333333-3333-4333-8333-333333333333";
  const conversation = {
    ...createConversation({
      userRequest: "legacy migration", sessionId: "managed-legacy",
      turnId: "turn-legacy", executorKind: "codex",
      now: new Date("2026-08-20T00:00:00.000Z")
    }),
    native_session_takeover: {
      native_session_id: nativeSessionId,
      terminal_control: control
    }
  } satisfies Conversation;
  let stored: Conversation = conversation;
  const terminalProvider = new StaticTerminalControlProvider({ panes: [{
    kind: "tmux", target: "%1", socketPath: "/tmp/tmux.sock",
    session: "work", window: 0, pane: 1, panePid: 100,
    currentCommand: "codex", currentPath: "/workspace"
  }] });
  const facade = adapter({
    now: () => new Date("2026-08-20T00:00:01.000Z")
  }, (ports) => {
    ports.runtime.createAgentRegistry = () =>
      createProductionTerminalAgentRegistry();
    ports.runtime.createProcessSource = () => failure === "observation"
      ? { listProcessSnapshots: async () => { throw new Error("observation failed"); } }
      : new StaticTerminalProcessSource([
          { pid: 100, ppid: 1, command: "tmux: server" },
          { pid: 101, ppid: 100, command: `codex resume ${nativeSessionId}` }
        ]);
    ports.runtime.createControlProvider = () => terminalProvider;
    ports.store.terminalControlFromTakeover = () => control;
    ports.store.withWriter = (_storeDir, operation) => {
      trace.push("writer");
      if (failure === "writer") throw new Error("writer failed");
      try {
        return operation();
      } finally {
        trace.push("writer-release");
      }
    };
    ports.store.acquireStateLock = () => {
      trace.push("lock");
      return () => trace.push("unlock");
    };
    ports.store.loadTurn = () => { trace.push("load"); return stored; };
    ports.store.saveTurn = (_path, next) => {
      trace.push("save");
      if (failure === "save") throw new Error("save failed");
      stored = next;
    };
    ports.store.appendEvent = () => {
      trace.push("event");
      if (failure === "event") throw new Error("event failed");
    };
  });
  return { facade, conversation };
}

test("process-birth lookup stays lazy and async-execution isolated", async () => {
  const first = adapter();
  const second = adapter();
  const trace: string[] = [];
  assert.equal(Object.isFrozen(first), true);

  const [left, right] = await Promise.all([
    runCliCommandExecution("identity-left", {}, {
      codexProcessBirthForPid: (pid) => {
        trace.push(`left:${pid}`);
        return "left-birth";
      }
    }, async () => {
      assert.deepEqual(first.codexProcessIncarnationForPid(71), {
        processUuid: "codex-pid:71:birth:left-birth",
        processBirth: "left-birth",
        evidence: "codex_process_birth"
      });
    }),
    runCliCommandExecution("identity-right", {}, {
      codexProcessBirthForPid: (pid) => {
        trace.push(`right:${pid}`);
        return "right-birth";
      }
    }, async () => {
      assert.deepEqual(second.codexProcessIncarnationForPid(72), {
        processUuid: "codex-pid:72:birth:right-birth",
        processBirth: "right-birth",
        evidence: "codex_process_birth"
      });
    })
  ]);
  assert.deepEqual(left, { exitCode: 0, stdout: "" });
  assert.deepEqual(right, { exitCode: 0, stdout: "" });
  assert.deepEqual(trace.sort(), ["left:71", "right:72"]);

  trace.length = 0;
  await runCliCommandExecution("identity-lazy", {}, {
    codexProcessBirthForPid: (pid) => {
      trace.push(`unexpected:${pid}`);
      return "unused";
    }
  }, async () => {
    assert.deepEqual(first.exactLifecycleProcessIdentity({
      conversationId: "codex-terminal:73",
      agent: "codex",
      pid: 73,
      legacy: false,
      terminalControl: {
        kind: "tmux",
        target: "work:0.0",
        panePid: 73
      }
    } as never, {
      sessionId: "native-73",
      processBirth: "stored-birth",
      evidence: "status_card"
    }), {
      sessionId: "native-73",
      processBirth: "stored-birth",
      processUuid: "codex-pid:73:birth:stored-birth",
      evidence: "status_card"
    });
  });
  assert.deepEqual(trace, []);
});

test("the data-only identity service has no infrastructure authority", () => {
  const source = fs.readFileSync(
    path.resolve("src/terminal-identity-authority-service.ts"),
    "utf8"
  );
  for (const forbidden of [
    "node:fs",
    "node:path",
    "JSON.parse",
    "ManagedSessionState",
    "ResolvedTerminalConversation",
    "TerminalProcessSource",
    "Record<string, any>",
    "lock"
  ]) {
    assert.equal(source.includes(forbidden), false, forbidden);
  }
});

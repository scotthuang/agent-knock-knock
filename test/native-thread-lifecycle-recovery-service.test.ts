import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createCodexTerminalAgentAdapter } from
  "../src/codex-terminal-agent-adapter.js";
import {
  managedSessionRevision,
  nativeThreadCommandFingerprint,
  type ManagedSessionState,
  type ManagedTerminalBinding,
  type NativeThreadTransition,
  type NativeThreadTransitionStatus
} from "../src/managed-session.js";
import {
  reconcileLifecycleDispatchLedger,
  type NativeThreadLifecycleRecoveryPorts,
  type NativeThreadLifecycleRecoveryTerminalFacts
} from "../src/native-thread-lifecycle-recovery-service.js";
import {
  lifecycleRecoveryTerminalFacts,
  observeClaudeLifecycleRecovery,
  observeCodexLifecycleRecovery
} from "../src/native-thread-lifecycle-recovery-adapter.js";
import {
  canonicalMutationResource,
  withCanonicalMutationLocks,
  type CanonicalMutationResources,
  type CanonicalMutationScopes
} from "../src/mutation-transaction.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import {
  nativeThreadLifecycleLedger,
  type TerminalDispatchLedgerDocument
} from "../src/terminal-dispatch-ledger-codec.js";

const BEFORE_ID = "11111111-1111-4111-8111-111111111111";
const AFTER_ID = "22222222-2222-4222-8222-222222222222";
const TRANSITION_ID = "transition-recovery-recording";
const STORE_DIR = "/canonical/recovery-store";
const CONTROL = {
  kind: "tmux" as const,
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 100,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys", "durable_completion"]
} satisfies TerminalControlRef;
const ADAPTER = createCodexTerminalAgentAdapter();
const AGENT_VERSION = "0.146.0";
const CAPABILITY = ADAPTER.probeThreadLifecycle?.(AGENT_VERSION);
assert.equal(CAPABILITY?.status, "supported");
const PLAN = CAPABILITY?.status === "supported"
  ? ADAPTER.planThreadLifecycle?.({ kind: "new_thread" }, CAPABILITY)
  : undefined;
assert.ok(PLAN);

const BEFORE_ROLLOUT = {
  fd: "7",
  device: "1",
  inode: "11",
  path: "/workspace/project/before.jsonl"
};
const AFTER_ROLLOUT = {
  fd: "8",
  device: "1",
  inode: "12",
  path: "/workspace/project/after.jsonl"
};
const BEFORE_BINDING: ManagedTerminalBinding = {
  binding_id: "binding-before",
  generation: 1,
  terminal_id: "terminal:v2:fixture",
  terminal_control: CONTROL,
  native_thread_id: BEFORE_ID,
  native_process: {
    pid: 200,
    process_uuid: "codex-pid:200:birth:before",
    process_birth: "before",
    rollout: BEFORE_ROLLOUT,
    evidence: "rollout_fd"
  },
  bound_at: "2026-08-15T00:00:00.000Z",
  last_verified_at: "2026-08-15T00:00:00.000Z"
};
const AFTER_BINDING: ManagedTerminalBinding = {
  ...BEFORE_BINDING,
  binding_id: "binding-after",
  generation: 2,
  native_thread_id: AFTER_ID,
  native_process: {
    ...BEFORE_BINDING.native_process,
    process_uuid: "codex-pid:200:birth:before",
    rollout: AFTER_ROLLOUT,
    evidence: "rollout_fd+verified"
  },
  bound_at: "2026-08-15T00:00:01.000Z",
  last_verified_at: "2026-08-15T00:00:01.000Z"
};
const SOURCE: ManagedSessionState = {
  schema: "agent-knock-knock/session",
  version: 1,
  session_id: "session-source",
  revision: 2,
  agent: "codex",
  workspace: "/workspace/project",
  status: "transitioning",
  binding: BEFORE_BINDING,
  lineage: { created_by: "attach" },
  created_at: "2026-08-15T00:00:00.000Z",
  updated_at: "2026-08-15T00:00:00.000Z",
  last_transition_id: TRANSITION_ID
};
const TARGET: ManagedSessionState = {
  ...SOURCE,
  session_id: "session-target",
  revision: 1,
  status: "bound",
  binding: AFTER_BINDING,
  lineage: {
    created_by: "new_thread",
    previous_session_id: SOURCE.session_id,
    transition_id: TRANSITION_ID
  }
};
const TERMINAL: NativeThreadLifecycleRecoveryTerminalFacts = {
  conversationId: "terminal:v2:fixture",
  agent: "codex",
  pid: 200,
  terminalControl: CONTROL
};
const AFTER_IDENTITY = {
  sessionId: AFTER_ID,
  processUuid: AFTER_BINDING.native_process.process_uuid,
  processBirth: AFTER_BINDING.native_process.process_birth,
  rollout: AFTER_ROLLOUT,
  evidence: "rollout_fd+verified"
};

function transition(status: NativeThreadTransitionStatus): NativeThreadTransition {
  return {
    schema: "agent-knock-knock/native-thread-transition",
    version: 1,
    transition_id: TRANSITION_ID,
    revision: 3,
    operation: "new_thread",
    status,
    terminal_id: TERMINAL.conversationId,
    agent: "codex",
    workspace: CONTROL.currentPath,
    source_session_id: SOURCE.session_id,
    source_expected_revision: 1,
    target_session_id: TARGET.session_id,
    target_expected_revision: null,
    before_native_thread_id: BEFORE_ID,
    before_process_uuid: "codex-pid:200:birth:before",
    before_process_birth: "before",
    before_process_rollout: BEFORE_ROLLOUT,
    before_binding: BEFORE_BINDING,
    adapter_version: AGENT_VERSION,
    command_fingerprint: nativeThreadCommandFingerprint(
      JSON.stringify(PLAN!.steps)
    ),
    dispatcher_pid: 999,
    prepared_at: "2026-08-15T00:00:00.000Z",
    ...(status === "dispatching"
      ? { dispatching_at: "2026-08-15T00:00:01.000Z" }
      : {}),
    ...(status === "verified" || status === "committed"
      ? {
          submitted_at: "2026-08-15T00:00:01.000Z",
          verified_at: "2026-08-15T00:00:02.000Z",
          after_binding: AFTER_BINDING
        }
      : {}),
    ...(status === "committed"
      ? { committed_at: "2026-08-15T00:00:03.000Z" }
      : {})
  };
}

function ledgerFor(
  value: NativeThreadTransition
): TerminalDispatchLedgerDocument {
  if (value.status === "prepared") {
    return nativeThreadLifecycleLedger(value, STORE_DIR, {
      phase: "command_prepared",
      previous: undefined
    });
  }
  if (value.status === "dispatching") {
    return nativeThreadLifecycleLedger(value, STORE_DIR, {
      phase: "command_dispatching",
      previous: undefined
    });
  }
  return nativeThreadLifecycleLedger(value, STORE_DIR, {
    phase: "verified",
    binding: value.before_binding
  });
}

type RecordingOptions = Readonly<{
  events: string[];
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
  durable: NativeThreadTransition;
  ledger: TerminalDispatchLedgerDocument;
  dispatcherAlive?: boolean;
  storeMatches?: boolean;
}>;

function recordingPorts(options: RecordingOptions): {
  ports: NativeThreadLifecycleRecoveryPorts;
  scopedCalls: () => number;
} {
  let scopedCalls = 0;
  let durable = options.durable;
  let source = SOURCE;
  let currentLedger = options.ledger;
  const scoped = <Args extends unknown[], Result>(
    event: string,
    operation: (...args: Args) => Result
  ) => (
    scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    ...args: Args
  ): Result => {
    assert.equal(scopes, options.scopes);
    assert.equal(resources, options.resources);
    scopedCalls += 1;
    options.events.push(event);
    return operation(...args);
  };
  const unexpected = (event: string) => (): never => {
    throw new Error(`unexpected recovery port: ${event}`);
  };
  const ports: NativeThreadLifecycleRecoveryPorts = {
    authority: {
      bind: scoped("authority:bind", () => ({ terminalControl: CONTROL }))
    },
    persistence: {
      listNativeThreadTransitions: scoped("transition:list", () => []),
      loadManagedSession: scoped("session:load", (id) => {
        assert.equal(id, SOURCE.session_id);
        return source;
      }),
      tryLoadManagedSession: scoped("session:try-load", (id) => {
        if (id === SOURCE.session_id) return source;
        assert.equal(id, TARGET.session_id);
        return undefined;
      }),
      loadNativeThreadTransition: scoped("transition:load", (id) => {
        assert.equal(id, TRANSITION_ID);
        return durable;
      }),
      saveManagedSession: scoped("session:save", (state, expectation) => {
        assert.equal(expectation.expectedRevision, managedSessionRevision(state));
        source = { ...state, revision: managedSessionRevision(state) + 1 };
        options.events.push(`session:status:${state.status}`);
        return source;
      }),
      saveNativeThreadTransition: scoped(
        "transition:save",
        (value, expectation) => {
          assert.equal(expectation.expectedRevision, value.revision);
          options.events.push(`transition:status:${value.status}`);
          durable = { ...value, revision: (value.revision ?? 0) + 1 };
          return durable;
        }
      ),
      commitVerified: scoped("session:commit", (value) => {
        assert.equal(value.status, "verified");
        return TARGET;
      }),
      loadLedger: scoped("ledger:load", () => currentLedger),
      buildLedger: scoped("ledger:build", unexpected("ledger:build")),
      saveLedger: scoped("ledger:save", (value, phase, expectation) => {
        assert.equal(expectation.expectedTransitionId, TRANSITION_ID);
        options.events.push(`ledger:phase:${phase.phase}`);
        currentLedger = {
          ...currentLedger,
          transition_id: value.transition_id,
          status: phase.phase === "uncertain" ? "uncertain" : "resolved"
        };
      }),
      saveFailClosedLedger: scoped(
        "ledger:fail-closed",
        (value, transitionId, _now, reason) => {
          assert.equal(transitionId, TRANSITION_ID);
          options.events.push(`ledger:reason:${reason}`);
          currentLedger = { ...value, status: "uncertain", reason };
        }
      )
    },
    terminal: {
      recoverDeferred: scoped("deferred:recover", async () => {}),
      sameTerminalIncarnation: scoped("terminal:incarnation", () => true),
      aliasMatches: scoped("terminal:alias", () => true),
      workspaceMatches: scoped("terminal:workspace", () => true),
      resolveIdentity: scoped("identity:resolve", async () => AFTER_IDENTITY),
      observeExternalHandoff: scoped(
        "handoff:observe",
        async () => AFTER_IDENTITY
      ),
      assertExclusive: scoped("ownership:before", async () => {}),
      assertTargetExclusive: scoped("ownership:target", async () => {}),
      exactIdentity: scoped("identity:exact", () => AFTER_IDENTITY),
      isProcessAlive: scoped(
        "process:alive",
        () => options.dispatcherAlive === true
      ),
      recordedStoreMatches: scoped(
        "store:match",
        () => options.storeMatches !== false
      ),
      recordMatchesControl: scoped("terminal:record", () => true),
      runningVersion: scoped("adapter:version", () => AGENT_VERSION),
      probeThreadLifecycle: scoped("adapter:probe", () => ({
        status: CAPABILITY!.status
      })),
      planThreadLifecycle: scoped("adapter:plan", () => ({
        steps: PLAN!.steps
      })),
      observeThreadLifecycle: scoped(
        "terminal:observe",
        async () => unexpected("terminal:observe")()
      ),
      prepareProbeBridge: scoped("terminal:prepare-probe", () => {}),
      status: scoped("terminal:status", async () => ({
        reachable: true,
        activityState: "idle" as const,
        approvalBlocked: false,
        composerVisible: true,
        composerEmpty: true,
        screenDigest: "digest"
      })),
      clearInputLine: scoped(
        "terminal:clear",
        async () => unexpected("terminal:clear")()
      ),
      submitCodexStatusProbe: scoped(
        "terminal:probe",
        async () => unexpected("terminal:probe")()
      ),
      assertResumedCodexCandidate: scoped(
        "identity:resume-candidate",
        unexpected("identity:resume-candidate")
      ),
      codexKnownRoots: scoped("identity:roots", () => ({
        primary: {
          sessionId: BEFORE_ID,
          processUuid: "codex-pid:200:birth:before",
          processBirth: "before",
          rollout: BEFORE_ROLLOUT
        },
        additional: []
      })),
      codexCompanionsExcludingPreferred: scoped(
        "identity:companions",
        (roots) => roots
      ),
      codexProcessBirth: scoped("process:birth", () => "before"),
      nativeIdentityMatches: scoped("identity:match", () => true)
    },
    runtime: {
      now: () => {
        options.events.push("clock");
        return new Date("2026-08-15T00:00:03.000Z");
      },
      sleep: async () => unexpected("sleep")()
    }
  };
  return { ports, scopedCalls: () => scopedCalls };
}

type Scenario = Readonly<{
  name: string;
  status: "prepared" | "dispatching" | "verified";
  dispatcherAlive?: boolean;
  storeMatches?: boolean;
  expected: readonly string[];
}>;

const SCENARIOS: readonly Scenario[] = [
  {
    name: "live dispatcher short-circuit",
    status: "prepared",
    dispatcherAlive: true,
    expected: ["authority:bind", "process:alive"]
  },
  {
    name: "wrong Store fail-closed before transition load",
    status: "prepared",
    storeMatches: false,
    expected: [
      "authority:bind", "process:alive", "store:match", "clock",
      "ledger:fail-closed",
      "ledger:reason:native thread transition belongs to another Store",
      "ledger:load"
    ]
  },
  {
    name: "prepared rollback",
    status: "prepared",
    expected: [
      "authority:bind", "process:alive", "store:match", "transition:load",
      "clock", "terminal:record", "terminal:incarnation", "terminal:alias",
      "terminal:workspace", "adapter:version", "adapter:probe", "adapter:plan",
      "ownership:before", "session:try-load", "session:try-load",
      "session:save", "session:status:bound", "transition:save",
      "transition:status:aborted", "ledger:save", "ledger:phase:resolved",
      "ledger:load"
    ]
  },
  {
    name: "possible-input quarantine",
    status: "dispatching",
    expected: [
      "authority:bind", "process:alive", "store:match", "transition:load",
      "clock", "terminal:record", "terminal:incarnation", "terminal:alias",
      "terminal:workspace", "adapter:version", "adapter:probe", "adapter:plan",
      "transition:save", "transition:status:uncertain", "session:try-load",
      "session:save", "session:status:quarantined", "ledger:save",
      "ledger:phase:uncertain", "ledger:load"
    ]
  },
  {
    name: "verified roll-forward",
    status: "verified",
    expected: [
      "authority:bind", "process:alive", "store:match", "transition:load",
      "clock", "terminal:record", "terminal:incarnation", "terminal:alias",
      "terminal:workspace", "adapter:version", "adapter:probe", "adapter:plan",
      "terminal:alias", "terminal:prepare-probe", "terminal:status",
      "identity:roots", "identity:companions", "identity:resolve",
      "identity:exact", "ownership:target", "session:commit",
      "transition:save", "transition:status:committed", "ledger:save",
      "ledger:phase:resolved_with_binding", "ledger:load"
    ]
  }
];

test("lifecycle recovery preserves the scoped reconciliation recording table", async () => {
  for (const scenario of SCENARIOS) {
    const events: string[] = [];
    const durable = transition(scenario.status);
    const ledger = ledgerFor(durable);
    await withCanonicalMutationLocks({
      resources: {
        terminal: canonicalMutationResource("terminal-key", CONTROL),
        storeWriter: canonicalMutationResource(STORE_DIR, STORE_DIR)
      },
      acquireTerminal: () => () => {},
      withStoreWriter: async (operation) => operation()
    }, async (scopes, resources) => {
      const recording = recordingPorts({
        events,
        scopes,
        resources,
        durable,
        ledger,
        dispatcherAlive: scenario.dispatcherAlive,
        storeMatches: scenario.storeMatches
      });
      await reconcileLifecycleDispatchLedger({
        terminal: TERMINAL,
        ledger
      }, scopes, resources, recording.ports);
      assert.equal(
        recording.scopedCalls(),
        events.filter((event) => event !== "clock" &&
          !event.startsWith("session:status:") &&
          !event.startsWith("transition:status:") &&
          !event.startsWith("ledger:phase:") &&
          !event.startsWith("ledger:reason:"))
          .length,
        scenario.name
      );
    });
    assert.deepEqual(events, scenario.expected, scenario.name);
  }
});

test("lifecycle recovery keeps raw terminal capability outside the service", () => {
  const source = fs.readFileSync(
    "src/native-thread-lifecycle-recovery-service.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /terminal-agent-bridge|TerminalAgentAdapter|TerminalBridgeStatus|\.adapter\(\)|screen\.excerpt/u
  );
  assert.doesNotMatch(
    source,
    /(?:codex|claude)Composer(?:Visible|Empty)|isExactClaudeIdleComposer|[›»❯]/u
  );

  const claude = source.slice(
    source.indexOf("async function probeManualClaudeLifecycleRecoveryIdentity"),
    source.indexOf("async function resolveManualCodexLifecycleStatusIdentity")
  );
  const observations = [...claude.matchAll(/observeThreadLifecycle/gu)]
    .map((match) => match.index);
  const statuses = [
    ...claude.matchAll(/status\(\{ kind: "physical" \}\)/gu)
  ].map((match) => match.index);
  assert.equal(observations.length, 2);
  assert.equal(statuses.length, 2);
  assert.ok(observations.every((position, index) => position < statuses[index]));

  const core = fs.readFileSync("src/cli-core.ts", "utf8");
  assert.equal(
    [...core.matchAll(
      /const serviceTerminal = lifecycleRecoveryTerminalFacts\(fresh\.terminal\);/gu
    )].length,
    2
  );
  assert.equal(
    [...core.matchAll(/\{ terminal: serviceTerminal(?:,| \})/gu)].length,
    2
  );
  assert.doesNotMatch(
    core,
    /(?:recoverLifecycleFenceBeforeMutationService|reconcileLifecycleDispatchLedgerService)\(\s*\{\s*terminal:\s*fresh\.terminal/gu
  );
});

test("core-side lifecycle request projection strips the runtime adapter", () => {
  const projected = lifecycleRecoveryTerminalFacts({
    ...TERMINAL,
    legacy: false,
    adapter: ADAPTER
  });
  assert.deepEqual(Object.keys(projected), [
    "conversationId",
    "agent",
    "pid",
    "terminalControl"
  ]);
  assert.equal(Object.hasOwn(projected, "adapter"), false);
  assert.equal(Object.hasOwn(projected, "legacy"), false);
});

test("Claude lifecycle adapter loads rows before observation", async () => {
  const events: string[] = [];
  const result = await observeClaudeLifecycleRecovery({
    operation: { kind: "new_thread" },
    pid: 200,
    processStartedAt: 123,
    cwd: "/workspace/project",
    loadRows: () => {
      events.push("rows");
      return [{ pid: 200, sessionId: BEFORE_ID }];
    },
    observe: (request) => {
      events.push("observe");
      assert.equal(request.agentRows?.[0]?.sessionId, BEFORE_ID);
      return { status: "observed", nativeThreadId: BEFORE_ID, idle: true };
    }
  });
  assert.deepEqual(events, ["rows", "observe"]);
  assert.equal(result.kind, "claude_agents");
});

test("Codex lifecycle adapter observes only after one fresh status", async () => {
  const events: string[] = [];
  const result = await observeCodexLifecycleRecovery({
    operation: { kind: "new_thread" },
    observationBaselineDigest: "before",
    status: async () => {
      events.push("status");
      return {
        provider: "tmux",
        target: CONTROL.target,
        agent: "codex",
        reachable: true,
        capabilities: ADAPTER.capabilities,
        activity_state: "idle",
        activity_reason: "idle",
        approval_state: {
          scanned: true,
          blocked: false,
          approvable: false
        },
        screen: { digest: "after", excerpt: `status ${AFTER_ID}\n› ` }
      };
    },
    observe: (request) => {
      events.push("observe");
      assert.match(request.screen ?? "", new RegExp(AFTER_ID, "u"));
      return { status: "observed", nativeThreadId: AFTER_ID };
    }
  });
  assert.deepEqual(events, ["status", "observe"]);
  assert.equal(result.kind, "codex_status");
  if (result.kind === "codex_status") {
    assert.equal(result.status.screenDigest, "after");
    assert.equal(result.observation?.nativeThreadId, AFTER_ID);
  }
});

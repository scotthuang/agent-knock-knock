import test from "node:test";
import assert from "node:assert/strict";
import type {
  TerminalNativeIdentityFence,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleAgentRow,
  TerminalThreadLifecyclePlan
} from "../src/terminal-agent-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge,
  TerminalBridgeStatus
} from "../src/terminal-agent-bridge.js";
import {
  isCompleteNativeRollout as canonicalCompleteNativeRollout,
  type TerminalNativeIdentity
} from "../src/terminal-binding-authority.js";
import {
  codexIdentityFence,
  isCompleteNativeRollout as dispatchCompleteNativeRollout,
  nativeIdentityMatchesCodexPreMaterialization
} from "../src/terminal-dispatch-execution.js";
import type { NativeThreadVerificationRequest } from
  "../src/native-thread-transition-settlement-service.js";
import {
  assertResumedNativeThreadMatchesCandidate,
  nativeThreadIdentityFence,
  nativeThreadIdentityMatchesFence,
  prepareNativeThreadVerification,
  verifyNativeThreadTransition,
  type NativeThreadVerificationAdapterPorts
} from "../src/native-thread-transition-verification-adapter.js";

const BEFORE_THREAD = "11111111-1111-4111-8111-111111111111";
const AFTER_THREAD = "22222222-2222-4222-8222-222222222222";
const COMPANION_THREAD = "33333333-3333-4333-8333-333333333333";
const FENCE = {
  sessionId: BEFORE_THREAD,
  processUuid: "codex-pid:123:birth:before",
  processBirth: "before",
  rollout: {
    fd: "7",
    device: "1",
    inode: "2",
    path: "/tmp/rollout.jsonl"
  }
};
const COMPANION: TerminalNativeIdentityFence = {
  ...FENCE,
  sessionId: COMPANION_THREAD,
  rollout: { ...FENCE.rollout, fd: "8", inode: "3" }
};
const AFTER_IDENTITY: TerminalNativeIdentity = {
  sessionId: AFTER_THREAD,
  processUuid: "codex-pid:123:birth:after",
  processBirth: "after",
  rollout: {
    fd: "9",
    device: "1",
    inode: "4",
    path: "/tmp/after-rollout.jsonl"
  },
  evidence: "codex_status_card+rollout_fd"
};
const NEW_THREAD_PLAN: TerminalThreadLifecyclePlan = {
  operation: { kind: "new_thread" },
  behaviorProfile: "fixture",
  steps: [
    {
      kind: "transition",
      command: "/clear",
      effect: "thread_transition",
      requiresIdle: true
    },
    {
      kind: "identity_probe_after",
      command: "/status",
      effect: "read_only",
      requiresIdle: true
    }
  ],
  command: "/clear",
  identityProbeCommand: "/status",
  expectedResult: { kind: "different_native_thread" }
};
const TERMINAL_CONTROL = {
  kind: "tmux" as const,
  target: "akk:0.0",
  session: "akk",
  window: 0,
  pane: 0,
  panePid: 123,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys"] as const
};

type LeakedRequestAuthority = Extract<
  keyof NativeThreadVerificationRequest,
  "agent" | "terminalPid"
>;
const REQUEST_HAS_NO_SECOND_TERMINAL_AUTHORITY:
  [LeakedRequestAuthority] extends [never] ? true : false = true;

function idleStatus(digest: string, excerpt = ""): TerminalBridgeStatus {
  return {
    provider: "fixture",
    target: TERMINAL_CONTROL.target,
    agent: "codex",
    reachable: true,
    capabilities: Object.freeze({}),
    activity_state: "idle",
    activity_reason: "idle",
    approval_state: {
      scanned: true,
      blocked: false,
      approvable: false
    },
    screen: { digest, excerpt }
  } as TerminalBridgeStatus;
}

function basePorts(
  bridge: TerminalAgentBridge,
  events: string[] = []
): NativeThreadVerificationAdapterPorts {
  return {
    createBridge: () => {
      events.push("bridge:create");
      return bridge;
    },
    loadClaudeAgentRows: () => [],
    runningVersion: () => "0.146.0",
    runtimeForIdentity: (identity) => ({
      nativeSessionId: identity.sessionId
    }),
    emptyRuntime: () => ({}),
    physicalRuntime: () => ({}),
    resolveIdentity: async () => undefined,
    sleep: async () => {
      events.push("sleep");
    }
  };
}

test("an observed identity without rollout evidence does not match or throw", () => {
  assert.equal(nativeThreadIdentityMatchesFence({
    sessionId: FENCE.sessionId,
    evidence: "codex_status_card"
  }, FENCE), false);
});

test("a null observation does not match an exact native identity fence", () => {
  assert.equal(nativeThreadIdentityMatchesFence(undefined, FENCE), false);
});

test("lifecycle and dispatch exports share the canonical identity helpers", () => {
  assert.equal(nativeThreadIdentityFence, codexIdentityFence);
  assert.equal(
    nativeThreadIdentityMatchesFence,
    nativeIdentityMatchesCodexPreMaterialization
  );
  assert.equal(
    canonicalCompleteNativeRollout,
    dispatchCompleteNativeRollout
  );
});

test("malformed rollout values fail closed with stable lifecycle errors", async (t) => {
  const expected = {
    path: FENCE.rollout.path,
    device: FENCE.rollout.device,
    inode: FENCE.rollout.inode
  };
  const stableMismatch = (error: unknown): boolean =>
    error instanceof Error &&
    !(error instanceof TypeError) &&
    error.message ===
      "the resumed Codex rollout does not match the revalidated candidate file identity";
  const malformedRollouts: readonly unknown[] = [
    7,
    null,
    {
      fd: 7,
      device: "1",
      inode: "2",
      path: "/tmp/rollout.jsonl"
    },
    {
      fd: "7",
      device: "1",
      inode: "2",
      path: { value: "/tmp/rollout.jsonl" }
    },
    {
      fd: "7",
      device: "1",
      inode: "2",
      path: "   "
    }
  ];
  for (const [index, rollout] of malformedRollouts.entries()) {
    await t.test(`malformed rollout ${index + 1}`, () => {
      const identity = {
        sessionId: FENCE.sessionId,
        processUuid: FENCE.processUuid,
        processBirth: FENCE.processBirth,
        rollout,
        evidence: "malformed_fixture"
      } as unknown as TerminalNativeIdentity;
      assert.equal(nativeThreadIdentityFence(identity), undefined);
      assert.equal(nativeThreadIdentityMatchesFence(identity, FENCE), false);
      assert.throws(
        () => assertResumedNativeThreadMatchesCandidate(identity, expected),
        stableMismatch
      );
    });
  }
  assert.throws(
    () => assertResumedNativeThreadMatchesCandidate(
      AFTER_IDENTITY,
      { ...expected, path: 42 } as unknown as typeof expected
    ),
    stableMismatch
  );
  assert.throws(
    () => assertResumedNativeThreadMatchesCandidate(
      { ...AFTER_IDENTITY, rollout: 7 } as unknown as TerminalNativeIdentity,
      undefined
    ),
    /Codex resume is missing its revalidated rollout token/u
  );
});

test("verification requests carry no second agent or PID authority", () => {
  assert.equal(REQUEST_HAS_NO_SECOND_TERMINAL_AUTHORITY, true);
});

test("Codex verification orders one probe before companion-bound observations", async () => {
  const events: string[] = [];
  let statusCount = 0;
  const bridge = {
    status: async (agent: string) => {
      statusCount += 1;
      events.push(`status:${agent}:${statusCount}`);
      return statusCount === 1
        ? idleStatus("transition-visible")
        : idleStatus(`fresh-${statusCount}`, `Session ID: ${AFTER_THREAD}`);
    },
    submitCodexStatusProbe: async () => {
      events.push("probe:submit");
      return {
        observationBaselineDigest: "probe-baseline",
        observationScrollbackLines: 240
      };
    }
  } as unknown as TerminalAgentBridge;
  const terminal = {
    conversationId: "terminal:v2:fixture",
    agent: "codex",
    pid: 123,
    legacy: false,
    terminalControl: TERMINAL_CONTROL,
    adapter: {
      observeThreadLifecycle: () => {
        events.push("lifecycle:observe");
        return {
          status: "verified",
          nativeThreadId: AFTER_THREAD,
          idle: true,
          evidence: "codex_status_card"
        };
      }
    }
  } as unknown as ResolvedTerminalConversation;
  const ports: NativeThreadVerificationAdapterPorts = {
    ...basePorts(bridge, events),
    resolveIdentity: async (
      preferredSessionId,
      allowedCompanionIdentity,
      allowedAdditionalIdentities
    ) => {
      events.push("identity:resolve");
      assert.equal(preferredSessionId, AFTER_THREAD);
      assert.equal(allowedCompanionIdentity, COMPANION);
      assert.deepEqual(allowedAdditionalIdentities, []);
      return AFTER_IDENTITY;
    }
  };
  const observed = await verifyNativeThreadTransition({
    operation: { kind: "new_thread" },
    plan: NEW_THREAD_PLAN,
    beforeIdentity: {
      sessionId: BEFORE_THREAD,
      processUuid: FENCE.processUuid,
      processBirth: FENCE.processBirth,
      evidence: "codex_status_card"
    },
    allowedCompanionIdentity: COMPANION,
    initialScreenDigest: "before-dispatch"
  }, terminal, ports);
  assert.deepEqual(observed, {
    ...AFTER_IDENTITY,
    evidence: "codex_status_card"
  });
  assert.deepEqual(events, [
    "bridge:create",
    "status:codex:1",
    "probe:submit",
    "sleep",
    "status:codex:2",
    "lifecycle:observe",
    "identity:resolve",
    "sleep",
    "status:codex:3",
    "lifecycle:observe",
    "identity:resolve"
  ]);
});

test("Claude verification reads exact rows before each status observation", async () => {
  const events: string[] = [];
  const rows: readonly TerminalThreadLifecycleAgentRow[] = [{
    pid: 777,
    sessionId: AFTER_THREAD,
    startedAt: 1234,
    status: "idle"
  }];
  const bridge = {
    status: async (agent: string, _control: unknown, options: {
      runtime?: TerminalRuntimeIdentity;
    }) => {
      events.push(`status:${agent}`);
      assert.equal(
        options.runtime?.nativeSessionId,
        AFTER_THREAD
      );
      return idleStatus("claude-idle");
    }
  } as unknown as TerminalAgentBridge;
  const terminal = {
    conversationId: "terminal:v2:claude-fixture",
    agent: "claude",
    pid: 777,
    legacy: false,
    terminalControl: {
      ...TERMINAL_CONTROL,
      panePid: 777,
      currentCommand: "claude"
    },
    adapter: {
      observeThreadLifecycle: (request: {
        pid?: number;
        agentRows?: readonly TerminalThreadLifecycleAgentRow[];
      }) => {
        events.push("lifecycle:observe");
        assert.equal(request.pid, 777);
        assert.equal(request.agentRows, rows);
        return {
          status: "verified",
          nativeThreadId: AFTER_THREAD,
          idle: true,
          evidence: "claude_agents_exact_pid"
        };
      }
    }
  } as unknown as ResolvedTerminalConversation;
  const ports: NativeThreadVerificationAdapterPorts = {
    ...basePorts(bridge, events),
    loadClaudeAgentRows: () => {
      events.push("rows:load");
      return rows;
    }
  };
  const observed = await verifyNativeThreadTransition({
    operation: { kind: "new_thread" },
    plan: NEW_THREAD_PLAN,
    beforeIdentity: {
      sessionId: BEFORE_THREAD,
      processStartedAt: 1234,
      evidence: "claude_agents_exact_pid"
    }
  }, terminal, ports);
  assert.equal(observed.sessionId, AFTER_THREAD);
  assert.equal(observed.processUuid, "claude-pid:777:started:1234");
  assert.deepEqual(events, [
    "bridge:create",
    "rows:load",
    "lifecycle:observe",
    "status:claude",
    "sleep",
    "rows:load",
    "lifecycle:observe",
    "status:claude"
  ]);
});

test("preparation without revalidation invokes its plan and status synchronously", async () => {
  const events: string[] = [];
  let resolveStatus: ((status: TerminalBridgeStatus) => void) | undefined;
  const pendingStatus = new Promise<TerminalBridgeStatus>((resolve) => {
    resolveStatus = resolve;
  });
  const bridge = {
    status: () => {
      events.push("status:invoke");
      return pendingStatus;
    }
  } as unknown as TerminalAgentBridge;
  const terminal = {
    conversationId: "terminal:v2:claude-prepare",
    agent: "claude",
    pid: 777,
    legacy: false,
    terminalControl: {
      ...TERMINAL_CONTROL,
      panePid: 777,
      currentCommand: "claude"
    },
    adapter: {
      observeThreadLifecycle: () => ({
        status: "observed",
        nativeThreadId: BEFORE_THREAD,
        idle: true
      })
    }
  } as unknown as ResolvedTerminalConversation;
  const prepared = prepareNativeThreadVerification({
    operation: { kind: "new_thread" },
    expectedBindingToken: "binding-token",
    bindingTokens: ["binding-token"],
    capabilities: {
      status: "supported",
      newThread: true,
      resumeExact: true,
      reason: "supported"
    },
    beforeIdentity: {
      sessionId: BEFORE_THREAD,
      processStartedAt: 1234,
      evidence: "claude_agents_exact_pid"
    }
  }, terminal, {
    ...basePorts(bridge, events),
    plan: () => {
      events.push("plan");
      return NEW_THREAD_PLAN;
    },
    assertReady: () => {
      events.push("ready:assert");
    },
    finalizeIdentity: (identity) => identity
  });
  assert.deepEqual(events, ["plan", "bridge:create", "status:invoke"]);
  assert.ok(resolveStatus);
  resolveStatus(idleStatus("prepared"));
  await prepared;
  assert.deepEqual(events, [
    "plan",
    "bridge:create",
    "status:invoke",
    "ready:assert"
  ]);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cliDependencies,
  runCliCommandExecution
} from "../src/cli-runtime-context.js";
import {
  unmanagedTerminalBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";
import {
  CODEX_FOREGROUND_IDENTIFICATION_SCROLLBACK_LINES,
  CODEX_FOREGROUND_IDENTIFICATION_TTL_MS,
  createNativeThreadLifecycleCliAdapter,
  type CreateNativeThreadLifecycleCliAdapterInput
} from "../src/native-thread-lifecycle-cli-adapter.js";
import type { TerminalNativeIdentity } from
  "../src/terminal-binding-authority.js";
import type { LifecycleTerminalObservation } from
  "../src/native-thread-lifecycle-query-service.js";
import {
  terminalUserExplicitModelControlBindingToken,
  terminalUserExplicitModelControlResidualEntryBindingToken,
  terminalUserExplicitModelControlRepairBindingToken
} from "../src/terminal-model-control.js";
import type {
  TerminalAgentAdapter,
  TerminalControlRef,
  TerminalThreadLifecycleCandidateProvider
} from "../src/terminal-agent-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import type { TerminalRuntimeCliAdapter } from
  "../src/terminal-runtime-cli-adapter.js";

const NATIVE_ID = "11111111-1111-4111-8111-111111111111";
const TMUX_CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "work:0.0",
  session: "work",
  window: 0,
  pane: 0,
  panePid: 42,
  currentPath: "/workspace/project",
  capabilities: ["send_keys"]
};
const HERDR_CONTROL: TerminalControlRef = {
  kind: "herdr",
  target: "workspace/tab/pane/terminal",
  socketPath: "/tmp/herdr.sock",
  session: "workspace",
  workspaceId: "workspace",
  tabId: "tab",
  paneId: "pane",
  terminalId: "terminal",
  panePid: 42,
  currentPath: "/workspace/project",
  capabilities: ["send_keys"]
};

function terminal(
  agent: "codex" | "claude" = "codex",
  terminalControl: TerminalControlRef = TMUX_CONTROL
): ResolvedTerminalConversation {
  return {
    conversationId: `${agent}-terminal:42`,
    agent,
    pid: 42,
    legacy: false,
    adapter: {} as TerminalAgentAdapter,
    terminalControl
  };
}

function session(agent: "codex" | "claude" = "claude"):
  ManagedSessionState {
  const now = "2026-08-20T00:00:00.000Z";
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    revision: 1,
    session_id: "session-42",
    agent,
    workspace: "/workspace/project",
    status: "bound",
    binding: {
      binding_id: "binding-42",
      generation: 1,
      terminal_id: `${agent}-terminal:42`,
      terminal_control: TMUX_CONTROL,
      native_thread_id: NATIVE_ID,
      native_process: {
        pid: 42,
        process_uuid: `${agent}-process-42`,
        process_birth: "birth-42",
        evidence: "test"
      },
      bound_at: now,
      last_verified_at: now
    },
    lineage: { created_by: "attach" },
    created_at: now,
    updated_at: now
  };
}

function supportedAdapter(): TerminalAgentAdapter {
  return {
    agent: "codex",
    displayName: "Codex",
    capabilities: {
      processDiscovery: true,
      screenStatus: true,
      terminalApproval: false,
      screenCompletion: false,
      durableCompletion: false,
      cancellation: false
    },
    cancelKeys: [],
    classifyProcess: () => undefined,
    inspectScreen: () => ({
      activity: { state: "idle", reason: "test" },
      approval: { blocked: false, approvable: false, reason: "idle" },
      screenExcerpt: ""
    }),
    probeThreadLifecycle: (version) => ({
      status: "supported",
      agentVersion: version,
      behaviorProfile: "test-profile",
      newThread: true,
      resumeExact: true,
      reason: "supported"
    }),
    probeNativeInspection: (version) => ({
      status: "supported",
      agentVersion: version,
      behaviorProfile: "test-profile",
      statusInspection: true,
      reason: "supported"
    }),
    planNativeInspection: () => ({
      operation: { kind: "status" },
      behaviorProfile: "test-profile",
      command: "/status",
      effect: "read_only",
      requiresIdle: true,
      composer: { kind: "exact", minimumStableMs: 0, maximumSettleMs: 0 },
      expectedResult: { kind: "native_status", presentation: "inline" }
    })
  };
}

function runtime(
  adapter: TerminalAgentAdapter,
  bridge?: TerminalAgentBridge,
  events: string[] = [],
  agentVersion = "1.2.3"
): TerminalRuntimeCliAdapter {
  const unexpected = (): never => {
    throw new Error("unexpected lifecycle runtime call");
  };
  return {
    createControlProviderRegistry: unexpected,
    createControlProvider: unexpected,
    createProcessSource: unexpected,
    loadClaudeAgentRows: () => [],
    createAgentRegistry: () => ({
      require: () => {
        events.push("runtime:registry");
        return adapter;
      }
    } as never),
    createBridge: () => bridge ?? unexpected(),
    createAgentSessionProvider: unexpected,
    createThreadLifecycleCandidateProvider: () =>
      cliDependencies().codexThreadLifecycleProvider ?? unexpected(),
    listActiveSessionsWithTerminalControl: unexpected,
    codexModelCatalogForRunningProcess: unexpected,
    agentVersionForRunningProcess: () => {
      events.push("runtime:version");
      return agentVersion;
    }
  };
}

function facade(input: {
  events?: string[];
  adapter?: TerminalAgentAdapter;
  bridge?: TerminalAgentBridge;
  currentSession?: ManagedSessionState;
  print?: (value: unknown) => void;
  processIncarnation?: () => { processUuid: string; processBirth: string };
  physicalProcessIncarnation?: () => {
    processUuid: string;
    processBirth: string;
  };
  agentVersion?: string;
  storeDir?: string;
  resolveCurrent?: () => Promise<TerminalNativeIdentity | undefined>;
  runtimeForLiveIdentity?: (input: {
    terminal: LifecycleTerminalObservation;
    identity?: TerminalNativeIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }) => Record<string, unknown>;
} = {}) {
  const events = input.events ?? [];
  const unexpected = (): never => {
    throw new Error("unexpected lifecycle adapter port call");
  };
  const adapter = input.adapter ?? supportedAdapter();
  const ports: CreateNativeThreadLifecycleCliAdapterInput = {
    runtime: {
      forOptions: () => runtime(
        adapter,
        input.bridge,
        events,
        input.agentVersion
      ),
      sleep: async () => undefined
    },
    identity: {
      resolveCurrent: async () => {
        events.push("identity:resolve");
        if (input.resolveCurrent) return input.resolveCurrent();
        return {
          sessionId: NATIVE_ID,
          processUuid: "codex-process-42",
          processBirth: "birth-42",
          evidence: "test"
        };
      },
      managedContext: () => {
        events.push("identity:context");
        return { companions: { additional: [] } };
      },
      boundSession: () => {
        events.push("session:bound");
        return input.currentSession;
      },
      materializeSession: unexpected,
      refineSession: unexpected,
      logicalIdentity: ({ observedIdentity }) => {
        events.push("identity:logical");
        return observedIdentity;
      },
      companionSet: () => {
        events.push("identity:companions");
        return { additional: [] };
      },
      processIncarnation: () => {
        events.push("identity:incarnation");
        return (input.processIncarnation ?? (() => ({
          processUuid: "codex-pid:42:birth:fixed",
          processBirth: "fixed"
        })))();
      },
      physicalProcessIncarnation: () => {
        events.push("identity:physical-incarnation");
        return (input.physicalProcessIncarnation ??
          input.processIncarnation ?? (() => ({
            processUuid: "process-pid:42:birth:fixed",
            processBirth: "fixed"
          })))();
      },
      runtimeForLiveIdentity: (value) =>
        input.runtimeForLiveIdentity?.(value) ?? ({ pid: 42 }),
      ownerIsInactive: () => true,
      assertCodexComposerReady: async () => {
        events.push("composer:ready");
      }
    },
    state: {
      storeDir: () => {
        events.push("store:dir");
        return input.storeDir ?? "/tmp/native-lifecycle-store";
      },
      inspectStore: () => ({ writable: true }),
      runtimeDir: () => "/tmp/native-lifecycle-runtime",
      acquireTerminal: () => {
        events.push("lock:acquire");
        return () => events.push("lock:release");
      },
      loadLedger: () => undefined,
      managedTurns: () => [],
      terminalBlockingTurns: () => [],
      hasUnresolvedTransition: () => false,
      dispatchOwnership: () => ({ state: "none" }),
      assertNativeThreadStoreAuthority: unexpected,
      orphanedForRecovery: () => undefined
    },
    output: {
      cwd: () => "/workspace/project",
      print: input.print ?? (() => undefined)
    }
  };
  assert.deepEqual(Object.keys(ports), [
    "runtime", "identity", "state", "output"
  ]);
  return createNativeThreadLifecycleCliAdapter(ports);
}

test("binding tokens preserve exact bytes, order, and incarnation getters", () => {
  const events: string[] = [];
  const lifecycle = facade({ events });
  const tokens = lifecycle.lifecycleBindingTokens({
    terminal: terminal("codex", HERDR_CONTROL)
  });
  assert.deepEqual(tokens, [
    "a8bb6add8f50e39dfbe49a46d30ffd18662152576b9e9092e63e67eea2c26079",
    "d7981298355a77eeab85b215be8ac8707aca9ffe4ecc5a67401aa1ed5ac0f517"
  ]);
  assert.deepEqual(events, ["identity:incarnation", "identity:incarnation"]);
  assert.equal(Object.isFrozen(lifecycle), true);
});

test("current snapshot has one sequencing owner and returns data-only facts", async () => {
  const events: string[] = [];
  const currentSession = session("codex");
  const lifecycle = facade({ events, currentSession });
  const snapshot = await lifecycle.currentSnapshot({}, terminal("codex"));
  assert.deepEqual(events, [
    "store:dir",
    "identity:context",
    "identity:resolve",
    "session:bound",
    "identity:logical",
    "identity:companions",
    "runtime:version",
    "runtime:registry"
  ]);
  assert.deepEqual(Object.keys(snapshot), [
    "identity",
    "runtimeIdentity",
    "codexCompanions",
    "session",
    "version",
    "capabilities",
    "bindingToken",
    "bindingTokens"
  ]);
  assert.equal(Object.hasOwn(snapshot, "adapter"), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(snapshot.session, currentSession);
});

test("native inspection dispatches Enter once, revalidates, and presents under lock", async () => {
  const events: string[] = [];
  const inspectionTerminal = terminal("codex");
  const adapter = supportedAdapter();
  let observationCount = 0;
  const bridge = {
    resolveConversationId: async () => inspectionTerminal,
    resolveStoredTerminal: async () => {
      events.push("terminal:resolve");
      return inspectionTerminal;
    },
    status: async () => ({
      provider: "tmux",
      target: TMUX_CONTROL.target,
      agent: "codex",
      reachable: true,
      capabilities: adapter.capabilities,
      activity_state: "idle",
      activity_reason: "test",
      approval_state: { scanned: true, blocked: false, approvable: false },
      screen: { excerpt: "›" }
    }),
    submitNativeInspection: async (
      _agent: unknown,
      _control: unknown,
      _plan: unknown,
      options: { beforeEnter(): Promise<void> }
    ) => {
      events.push("submit:enter");
      await options.beforeEnter();
      return {
        enterCount: 1,
        materialization: "exact",
        preEnterScreenDigest: "before",
        preEnterEvidenceInventory: []
      };
    },
    observeNativeInspection: async () => {
      observationCount += 1;
      events.push(`observe:${observationCount}`);
      return {
        status: await (bridge as never as TerminalAgentBridge).status(
          "codex", TMUX_CONTROL
        ),
        screenDigest: "after",
        observation: {
          status: "observed",
          nativeThreadId: NATIVE_ID,
          observedAgentVersion: "1.2.3",
          evidence: "status_card",
          evidenceFingerprint: "stable-result",
          screenFingerprint: "after",
          result: {
            kind: "native_status",
            nativeThreadId: NATIVE_ID,
            agentVersion: "1.2.3",
            fields: [],
            excerpt: "status"
          }
        }
      };
    }
  } as unknown as TerminalAgentBridge;
  let printed = false;
  const lifecycle = facade({
    events,
    adapter,
    bridge,
    print: () => {
      events.push("output:print");
      printed = true;
    }
  });
  const expectedBindingToken = lifecycle.lifecycleBindingTokens({
    terminal: inspectionTerminal,
    identity: {
      sessionId: NATIVE_ID,
      processUuid: "codex-process-42",
      processBirth: "birth-42",
      evidence: "test"
    }
  })[0];
  events.length = 0;
  await lifecycle.runInspect({
    terminal: inspectionTerminal.conversationId,
    inspection: "status",
    expectedBindingToken
  });
  assert.equal(printed, true);
  assert.equal(events.filter((event) => event === "submit:enter").length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("observe:")), [
    "observe:1", "observe:2"
  ]);
  assert.equal(events.filter((event) => event === "identity:resolve").length, 3);
  assert.ok(events.indexOf("output:print") < events.indexOf("lock:release"));
  assert.equal(events.at(-1), "lock:release");
});

test("Codex foreground identification bypasses ambiguous native resolution and emits one ephemeral proof", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-identify-foreground-")
  );
  try {
    const events: string[] = [];
    const control: TerminalControlRef = {
      ...TMUX_CONTROL,
      currentPath: fs.realpathSync(tempDir),
      capabilities: ["send_keys", "screen_status"]
    };
    const foregroundTerminal = terminal("codex", control);
    const adapter = supportedAdapter();
    const processIncarnation = {
      processUuid: "process-pid:42:birth:foreground",
      processBirth: "foreground"
    };
    const postProbeScreenDigest = "b".repeat(64);
    const statusOptions: Array<{
      scrollbackLines?: number;
      runtime?: Record<string, unknown>;
    }> = [];
    let observationCount = 0;
    let enterCount = 0;
    const bridge = {
      resolveConversationId: async () => foregroundTerminal,
      resolveStoredTerminal: async (
        _agent: unknown,
        _pid: unknown,
        _control: unknown,
        runtimeIdentity: Record<string, unknown>
      ) => {
        events.push("terminal:resolve");
        assert.equal(runtimeIdentity.nativeSessionId, undefined);
        assert.equal(runtimeIdentity.nativeProcessUuid, undefined);
        assert.equal(runtimeIdentity.nativeProcessBirth, undefined);
        return foregroundTerminal;
      },
      status: async (
        _agent: unknown,
        _control: unknown,
        options: {
          scrollbackLines?: number;
          runtime?: Record<string, unknown>;
        }
      ) => {
        statusOptions.push(options);
        return {
          provider: "tmux",
          target: control.target,
          agent: "codex",
          reachable: true,
          capabilities: adapter.capabilities,
          activity_state: "idle",
          activity_reason: "exact idle fixture",
          approval_state: {
            scanned: true,
            blocked: false,
            approvable: false
          },
          screen: { excerpt: "›", digest: postProbeScreenDigest }
        };
      },
      submitNativeInspection: async (
        _agent: unknown,
        _control: unknown,
        _plan: unknown,
        options: { beforeEnter(): Promise<void> }
      ) => {
        events.push("submit:text");
        await options.beforeEnter();
        enterCount += 1;
        events.push("submit:enter");
        return {
          enterCount: 1,
          materialization: {
            kind: "exact_slash_composer",
            digest: "private-materialization-digest",
            stableForMs: 100,
            stableCaptures: 2
          },
          preEnterScreenDigest: "before",
          preEnterEvidenceInventory: []
        };
      },
      observeNativeInspection: async (
        _agent: unknown,
        _control: unknown,
        _request: unknown,
        options: { scrollbackLines?: number }
      ) => {
        observationCount += 1;
        events.push(`observe:${observationCount}`);
        assert.equal(
          options.scrollbackLines,
          CODEX_FOREGROUND_IDENTIFICATION_SCROLLBACK_LINES
        );
        return {
          status: {
            provider: "tmux",
            target: control.target,
            agent: "codex",
            reachable: true,
            capabilities: adapter.capabilities,
            activity_state: "idle",
            activity_reason: "fresh status",
            approval_state: {
              scanned: true,
              blocked: false,
              approvable: false
            },
            screen: { excerpt: "›", digest: postProbeScreenDigest }
          },
          screenDigest: `sha256:${postProbeScreenDigest}`,
          observation: {
            status: "observed",
            nativeThreadId: NATIVE_ID,
            observedAgentVersion: "1.2.3",
            evidence: "codex_status_card",
            evidenceFingerprint: `sha256:${"a".repeat(64)}`,
            screenFingerprint: `sha256:${postProbeScreenDigest}`,
            result: {
              kind: "native_status",
              nativeThreadId: NATIVE_ID,
              agentVersion: "1.2.3",
              fields: [],
              excerpt: "bounded status"
            }
          }
        };
      }
    } as unknown as TerminalAgentBridge;
    let output: Record<string, unknown> | undefined;
    const lifecycle = facade({
      events,
      adapter,
      bridge,
      processIncarnation: () => ({
        processUuid: "codex-pid:42:birth:foreground",
        processBirth: "foreground"
      }),
      physicalProcessIncarnation: () => processIncarnation,
      print: (value) => {
        events.push("output:print");
        output = value as Record<string, unknown>;
      }
    });
    const expectedTerminalToken = unmanagedTerminalBindingToken({
      terminalId: foregroundTerminal.conversationId,
      terminalControl: control,
      agent: "codex",
      pid: foregroundTerminal.pid,
      workspace: control.currentPath ?? "",
      ...processIncarnation
    });

    await lifecycle.runIdentifyForeground({
      terminal: foregroundTerminal.conversationId,
      expectedTerminalToken
    });

    assert.equal(enterCount, 1);
    assert.equal(observationCount, 2);
    assert.equal(
      events.filter((event) => event === "identity:resolve").length,
      0,
      "multi-rollout native identity resolution must not gate the physical probe"
    );
    assert.equal(events.at(-1), "lock:release");
    assert.ok(events.indexOf("output:print") < events.indexOf("lock:release"));
    assert.ok(statusOptions.length >= 2);
    assert.equal(
      statusOptions.every((options) =>
        options.scrollbackLines ===
          CODEX_FOREGROUND_IDENTIFICATION_SCROLLBACK_LINES
      ),
      true
    );
    const foregroundProof = output?.foreground_proof as Record<string, unknown>;
    assert.equal(foregroundProof.scope, "ephemeral_diagnostic_only");
    assert.equal(foregroundProof.grants_authority, false);
    assert.equal(foregroundProof.ttl_ms, CODEX_FOREGROUND_IDENTIFICATION_TTL_MS);
    assert.equal(
      Date.parse(String(foregroundProof.expires_at)) -
        Date.parse(String(foregroundProof.observed_at)),
      CODEX_FOREGROUND_IDENTIFICATION_TTL_MS
    );
    const publicJson = JSON.stringify(output);
    assert.doesNotMatch(
      publicJson,
      /expectedTerminalToken|expected_terminal_token|processUuid|process_uuid|digest|raw.screen/iu
    );
    assert.equal(output?.store_mutation, false);
    assert.equal(output?.session_created, false);
    assert.equal(output?.turn_created, false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex foreground identification rejects a questionnaire or stale physical token before input", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-identify-foreground-blocked-")
  );
  try {
    const control: TerminalControlRef = {
      ...TMUX_CONTROL,
      currentPath: fs.realpathSync(tempDir),
      capabilities: ["send_keys", "screen_status"]
    };
    const foregroundTerminal = terminal("codex", control);
    const adapter = supportedAdapter();
    const processIncarnation = {
      processUuid: "codex-pid:42:birth:blocked",
      processBirth: "blocked"
    };
    let inputCount = 0;
    const questionnaireBridge = {
      resolveConversationId: async () => foregroundTerminal,
      resolveStoredTerminal: async () => foregroundTerminal,
      status: async () => ({
        provider: "tmux",
        target: control.target,
        agent: "codex",
        reachable: true,
        capabilities: adapter.capabilities,
        activity_state: "idle",
        activity_reason: "questionnaire fixture",
        approval_state: {
          scanned: true,
          blocked: false,
          approvable: false
        },
        screen: { excerpt: "›", digest: "questionnaire-screen" },
        interaction_state: { state: "pending" },
        submitNativeInspection: async () => {
          inputCount += 1;
          throw new Error("must not submit")
        }
      }),
      submitNativeInspection: async () => {
        inputCount += 1;
        throw new Error("must not submit");
      }
    } as unknown as TerminalAgentBridge;
    const expectedTerminalToken = unmanagedTerminalBindingToken({
      terminalId: foregroundTerminal.conversationId,
      terminalControl: control,
      agent: "codex",
      pid: foregroundTerminal.pid,
      workspace: control.currentPath ?? "",
      ...processIncarnation
    });
    await assert.rejects(
      facade({
        adapter,
        bridge: questionnaireBridge,
        processIncarnation: () => processIncarnation
      }).runIdentifyForeground({
        terminal: foregroundTerminal.conversationId,
        expectedTerminalToken
      }),
      /questionnaire response/u
    );
    assert.equal(inputCount, 0);

    await assert.rejects(
      facade({
        adapter,
        bridge: questionnaireBridge,
        processIncarnation: () => processIncarnation
      }).runIdentifyForeground({
        terminal: foregroundTerminal.conversationId,
        expectedTerminalToken: "stale-token"
      }),
      /physical terminal token is stale/u
    );
    assert.equal(inputCount, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex 0.154 zero-rollout model options consume the dedicated physical authority", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-zero-rollout-model-control-")
  );
  try {
    const events: string[] = [];
    const control: TerminalControlRef = {
      ...HERDR_CONTROL,
      currentPath: fs.realpathSync(tempDir),
      capabilities: ["send_keys", "screen_status"]
    };
    const foregroundTerminal = terminal("codex", control);
    const modelAdapter: TerminalAgentAdapter = {
      ...supportedAdapter(),
      probeModelControl: (version) => ({
        status: version === "0.154.0" ? "supported" : "unsupported",
        agentVersion: version,
        behaviorProfile: version === "0.154.0"
          ? "codex-model-control-0.154.0"
          : undefined,
        scope: version === "0.154.0"
          ? "current_and_new_sessions"
          : undefined,
        modelSelection: version === "0.154.0",
        reasoningEffortSelection: version === "0.154.0",
        reason: version === "0.154.0" ? "verified" : "unsupported"
      }),
      planModelControl: (capability) => {
        assert.equal(capability.behaviorProfile, "codex-model-control-0.154.0");
        return {
          behaviorProfile: "codex-model-control-0.154.0",
          command: "/model",
          scope: "current_and_new_sessions",
          requiresIdle: true,
          requiresExactEmptyComposer: true
        };
      }
    };
    const catalog = {
      agent: "codex" as const,
      agentVersion: "0.154.0",
      behaviorProfile: "codex-model-control-0.154.0" as const,
      scope: "current_and_new_sessions" as const,
      current: { model: "gpt-6-astra", reasoningEffort: "ultra" as const },
      models: [{
        id: "gpt-5.6-terra",
        label: "GPT-5.6 Terra",
        reasoningEfforts: ["low", "medium", "high"] as const
      }],
      catalogFingerprint: "f".repeat(64)
    };
    let modelOptionsCalls = 0;
    let residualContinuationCalls = 0;
    let setModelCalls = 0;
    let repairModelControlCalls = 0;
    let irreversibleInputSteps = 0;
    const bridge = {
      resolveConversationId: async () => foregroundTerminal,
      resolveStoredTerminal: async () => foregroundTerminal,
      status: async () => ({
        provider: "tmux",
        target: control.target,
        agent: "codex",
        reachable: true,
        capabilities: modelAdapter.capabilities,
        activity_state: "idle",
        activity_reason: "exact empty prompt",
        screen_state: "idle",
        screen_reason: "exact empty prompt",
        approval_state: {
          scanned: true,
          blocked: false,
          approvable: false
        },
        screen: { excerpt: "›", digest: "idle-screen" }
      }),
      modelOptions: async (
        _agent: unknown,
        _terminalControl: unknown,
        _agentVersion: unknown,
        _plan: unknown,
        options: {
          beforeInput?: () => void | Promise<void>;
          initialResidual?: {
            state: "recoverable";
            kind: "profiled_command_popup" | "bare_command";
            fingerprint: string;
          };
        }
      ) => {
        modelOptionsCalls += 1;
        if (options.initialResidual) {
          residualContinuationCalls += 1;
          assert.equal(options.initialResidual.fingerprint, "e".repeat(64));
        }
        await options.beforeInput?.();
        irreversibleInputSteps += 1;
        events.push("bridge:model-options");
        return { terminalControl: control, catalog };
      },
      setModel: async (
        _agent: unknown,
        _terminalControl: unknown,
        _agentVersion: unknown,
        _plan: unknown,
        expectedCatalogFingerprint: string,
        request: { model: string; reasoningEffort: "high" },
        options: { beforeInput?: () => void | Promise<void> }
      ) => {
        setModelCalls += 1;
        assert.equal(expectedCatalogFingerprint, catalog.catalogFingerprint);
        await options.beforeInput?.();
        irreversibleInputSteps += 1;
        events.push("bridge:set-model");
        return {
          terminalControl: control,
          outcome: "changed" as const,
          scope: "current_and_new_sessions" as const,
          defaultsChanged: true,
          requested: request,
          effective: request,
          newSessionDefaults: request,
          doNotRetry: false
        };
      },
      inspectModelControlResidual: async () => ({
        state: "recoverable" as const,
        kind: "profiled_command_popup" as const,
        fingerprint: "e".repeat(64),
        terminalControl: control
      }),
      repairModelControlResidual: async (
        _agent: unknown,
        _terminalControl: unknown,
        _agentVersion: unknown,
        _plan: unknown,
        expectedResidualFingerprint: string,
        options: { beforeInput?: () => void | Promise<void> }
      ) => {
        repairModelControlCalls += 1;
        assert.equal(expectedResidualFingerprint, "e".repeat(64));
        await options.beforeInput?.();
        return {
          terminalControl: control,
          outcome: "repaired" as const,
          terminalInputAttempted: true,
          composerPostcondition: "empty" as const,
          doNotRetry: false
        };
      }
    } as unknown as TerminalAgentBridge;
    const incarnation = {
      processUuid: "process-pid:42:birth:model-control",
      processBirth: "model-control"
    };
    const runtimeRequests: Array<{
      expectedEmptyNativeSession?: boolean;
      physicalOnly?: boolean;
    }> = [];
    const outputs: Record<string, unknown>[] = [];
    const lifecycle = facade({
      events,
      adapter: modelAdapter,
      bridge,
      agentVersion: "0.154.0",
      storeDir: tempDir,
      resolveCurrent: async () => undefined,
      processIncarnation: () => ({
        processUuid: "codex-pid:42:birth:model-control",
        processBirth: "model-control"
      }),
      physicalProcessIncarnation: () => incarnation,
      runtimeForLiveIdentity: (request) => {
        runtimeRequests.push(request);
        return { pid: foregroundTerminal.pid };
      },
      print: (value) => {
        outputs.push(value as Record<string, unknown>);
      }
    });
    const expectedBindingToken =
      terminalUserExplicitModelControlBindingToken({
        terminalId: foregroundTerminal.conversationId,
        terminalControl: control,
        pid: foregroundTerminal.pid,
        workspace: control.currentPath ?? "",
        ...incarnation,
        agentVersion: "0.154.0",
        behaviorProfile: "codex-model-control-0.154.0"
      });

    await lifecycle.runModelOptions({
      terminal: foregroundTerminal.conversationId,
      expectedBindingToken
    });
    const optionsOutput = outputs[0];

    const expectedResidualEntryToken =
      terminalUserExplicitModelControlResidualEntryBindingToken({
        terminalId: foregroundTerminal.conversationId,
        terminalControl: control,
        pid: foregroundTerminal.pid,
        workspace: control.currentPath ?? "",
        ...incarnation,
        agentVersion: "0.154.0",
        behaviorProfile: "codex-model-control-0.154.0",
        residualKind: "profiled_command_popup",
        residualFingerprint: "e".repeat(64)
      });
    await lifecycle.runModelOptions({
      terminal: foregroundTerminal.conversationId,
      expectedBindingToken: expectedResidualEntryToken
    });
    const residualOptionsOutput = outputs[1];
    await assert.rejects(
      lifecycle.runModelOptions({
        terminal: foregroundTerminal.conversationId,
        expectedBindingToken: "stale-token"
      }),
      /residual changed after it was listed/u
    );
    assert.equal(
      modelOptionsCalls,
      2,
      "stale residual-entry authority must cause zero terminal input"
    );

    await lifecycle.runSetModel({
      terminal: foregroundTerminal.conversationId,
      expectedBindingToken,
      expectedCatalogFingerprint: catalog.catalogFingerprint,
      model: "gpt-5.6-terra",
      reasoningEffort: "high"
    });
    const setOutput = outputs[2];

    const expectedRepairToken =
      terminalUserExplicitModelControlRepairBindingToken({
        terminalId: foregroundTerminal.conversationId,
        terminalControl: control,
        pid: foregroundTerminal.pid,
        workspace: control.currentPath ?? "",
        ...incarnation,
        agentVersion: "0.154.0",
        behaviorProfile: "codex-model-control-0.154.0",
        residualKind: "profiled_command_popup",
        residualFingerprint: "e".repeat(64)
      });
    await lifecycle.runRepairModelControl({
      terminal: foregroundTerminal.conversationId,
      expectedBindingToken: expectedRepairToken
    });
    const repairOutput = outputs[3];
    assert.equal(repairModelControlCalls, 1);
    assert.equal(repairOutput?.outcome, "repaired");
    assert.equal(repairOutput?.composer_postcondition, "empty");
    assert.equal(repairOutput?.do_not_retry, false);
    await assert.rejects(
      lifecycle.runRepairModelControl({
        terminal: foregroundTerminal.conversationId,
        expectedBindingToken: "stale-token"
      }),
      /residual changed after it was listed/u
    );
    assert.equal(
      repairModelControlCalls,
      1,
      "stale repair authority must cause zero additional input"
    );

    let driftResolveCount = 0;
    const driftLifecycle = facade({
      events,
      adapter: modelAdapter,
      bridge,
      agentVersion: "0.154.0",
      storeDir: tempDir,
      resolveCurrent: async () => {
        driftResolveCount += 1;
        return driftResolveCount === 1
          ? undefined
          : {
              sessionId: NATIVE_ID,
              processUuid: "codex-pid:42:birth:model-control",
              processBirth: "model-control",
              evidence: "new rollout appeared"
            };
      },
      processIncarnation: () => ({
        processUuid: "codex-pid:42:birth:model-control",
        processBirth: "model-control"
      }),
      physicalProcessIncarnation: () => incarnation,
      runtimeForLiveIdentity: () => ({ pid: foregroundTerminal.pid })
    });
    await assert.rejects(
      driftLifecycle.runModelOptions({
        terminal: foregroundTerminal.conversationId,
        expectedBindingToken
      }),
      /binding or coding-agent version changed|current native Session changed/u
    );

    assert.equal(modelOptionsCalls, 3);
    assert.equal(residualContinuationCalls, 1);
    assert.equal(setModelCalls, 1);
    assert.equal(
      irreversibleInputSteps,
      3,
      "a rollout appearing at the final fence must cause zero additional input"
    );
    assert.equal(
      runtimeRequests.every((request) =>
        request.expectedEmptyNativeSession === true &&
        request.physicalOnly !== true
      ),
      true,
      "zero-rollout execution must retain the exact-empty native Session fence"
    );
    assert.equal(optionsOutput?.terminal_id, foregroundTerminal.conversationId);
    assert.equal(optionsOutput?.catalog_fingerprint, catalog.catalogFingerprint);
    const actions = optionsOutput?.available_actions as Record<string, unknown>;
    const setModel = actions.set_model as Record<string, unknown>;
    const args = setModel.arguments as Record<string, unknown>;
    assert.equal(args.expected_binding_token, expectedBindingToken);
    const residualActions = residualOptionsOutput?.available_actions as
      Record<string, unknown>;
    const residualSetModel = residualActions.set_model as
      Record<string, unknown>;
    const residualArgs = residualSetModel.arguments as Record<string, unknown>;
    assert.equal(
      residualArgs.expected_binding_token,
      expectedBindingToken,
      "successful continuation must mint the ordinary set-model boundary"
    );
    assert.notEqual(
      residualArgs.expected_binding_token,
      expectedResidualEntryToken
    );
    assert.equal(setOutput?.outcome, "changed");
    assert.deepEqual(setOutput?.effective, {
      model: "gpt-5.6-terra",
      reasoning_effort: "high"
    });
    assert.deepEqual(setOutput?.new_session_defaults, {
      model: "gpt-5.6-terra",
      reasoning_effort: "high"
    });
    assert.equal(events.at(-1), "lock:release");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Codex candidate providers stay lazy and async-execution isolated", async () => {
  const lifecycle = facade();
  const left = candidateProvider("left");
  const right = candidateProvider("right");
  const [leftRun, rightRun] = await Promise.all([
    runCliCommandExecution("native-left", {}, {
      codexThreadLifecycleProvider: left
    }, async () => {
      assert.equal(lifecycle.queryPorts({}).candidateProvider("codex"), left);
    }),
    runCliCommandExecution("native-right", {}, {
      codexThreadLifecycleProvider: right
    }, async () => {
      assert.equal(lifecycle.queryPorts({}).candidateProvider("codex"), right);
    })
  ]);
  assert.deepEqual(leftRun, { exitCode: 0, stdout: "" });
  assert.deepEqual(rightRun, { exitCode: 0, stdout: "" });
});

test("public boundaries expose no raw any and cli-core owns no lifecycle state machine", () => {
  const declaration = fs.readFileSync(
    new URL("../src/native-thread-lifecycle-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(declaration, /\bany\b|Record<[^>]*any/u);
  const core = fs.readFileSync(path.resolve("src/cli-core.ts"), "utf8");
  for (const name of [
    "currentLifecycleSnapshot",
    "runListResumableThreads",
    "runNativeInspect",
    "nativeInspectionRuntime",
    "codexLatentClearResumeObservation"
  ]) {
    assert.doesNotMatch(core, new RegExp(`(?:async )?function ${name}\\(`, "u"));
  }
  assert.doesNotMatch(core, /snapshot\.adapter/u);
  assert.match(
    core,
    /terminalDispatchRecovery\.assertNativeThreadStoreAuthority/u
  );
  assert.match(core, /terminalDispatchRecovery\.orphanedForRecovery/u);
});

function candidateProvider(label: string): TerminalThreadLifecycleCandidateProvider {
  return {
    listThreadLifecycleCandidates: async () => [],
    revalidateThreadLifecycleCandidate: async () => ({
      status: "unavailable",
      reason: label
    })
  };
}

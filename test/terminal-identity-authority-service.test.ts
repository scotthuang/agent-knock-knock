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
import { listNativeThreadTransitions, loadManagedSession, saveManagedSession } from "../src/session-store.js";
import { terminalBindingFrom, type ManagedSessionState } from "../src/managed-session.js";
import { createNativeThreadLifecycleCliAdapter } from "../src/native-thread-lifecycle-cli-adapter.js";
import { createNativeThreadTransitionApplication } from "../src/native-thread-transition-application.js";
import { canonicalMutationResource } from "../src/mutation-transaction.js";
import { withStoreWriterLeaseAsync } from "../src/store.js";
import type { TerminalNativeIdentity } from "../src/terminal-binding-authority.js";
import type { TerminalAgentBridge, ResolvedTerminalConversation } from "../src/terminal-agent-bridge.js";
import type { TerminalRuntimeCliAdapter } from "../src/terminal-runtime-cli-adapter.js";
import { fingerprint } from "../src/terminal-submission-facts.js";
import { terminalBridgeRequestFingerprint } from
  "../src/terminal-dispatch-receipt.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { associateTerminalEndpointEvidence, terminalControlEvidence, terminalRuntimeResourceKey } from
  "../src/terminal-control-ref.js";
import { terminalPreSendRuntime } from
  "../src/terminal-command-send-preflight.js";
import type { TerminalControlSendRequest } from
  "../src/terminal-dispatch-composition.js";
import { CODEX_ASTRA_STYLED_COMPOSER_PHASES } from
  "./support/codex-astra-styled-composer.js";

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

test("candidate acceptance carries the running process version through production Composer readiness", async () => {
  const control = terminalControl();
  const conversation = createConversation({
    userRequest: "candidate acceptance",
    sessionId: "managed-candidate",
    turnId: "turn-candidate",
    executorKind: "codex",
    now: new Date("2026-09-21T00:00:00.000Z")
  });
  const request = {
    transaction: {} as TerminalControlSendRequest["transaction"],
    options: {},
    conversation,
    nextConversation: conversation,
    executor: conversation.executor,
    message: { id: "candidate-message" } as TerminalControlSendRequest["message"],
    postSendCodexCandidateAnchor: {} as NonNullable<
      TerminalControlSendRequest["postSendCodexCandidateAnchor"]
    >
  } satisfies TerminalControlSendRequest;
  for (const version of ["0.155.1", undefined, "0.155.2"]) {
    const observations: Array<[string, number]> = [];
    const provider = new StaticTerminalControlProvider({
      panes: [{
        kind: "tmux", target: "%1", socketPath: "/tmp/tmux.sock",
        session: "work", window: 0, pane: 1, panePid: 100,
        currentCommand: "codex", currentPath: "/workspace"
      }],
      screens: { "%1": CODEX_ASTRA_STYLED_COMPOSER_PHASES[0] }
    });
    const facade = adapter({}, (ports) => {
      ports.runtime.agentVersionForRunningProcess = (agent, pid) => {
        observations.push([agent, pid]);
        return version;
      };
      ports.runtime.createControlProvider = () => provider;
      ports.runtime.createAgentRegistry = () => createProductionTerminalAgentRegistry();
    });
    const runtime = terminalPreSendRuntime({
      request,
      terminalControl: control,
      terminalAgentPid: 101
    }, {
      terminalRuntimeForLiveIdentity: facade.terminalRuntimeForLiveIdentity,
      terminalRuntimeIdentityForConversation: () => {
        throw new Error("candidate acceptance must use the physical runtime branch");
      }
    });
    assert.deepEqual(observations, [["codex", 101]], "observe the agent PID, not the pane PID");
    assert.equal(runtime.agentVersion, version);
    assert.equal(runtime.nativeSessionId, undefined);
    assert.equal(runtime.requireNativeRolloutIdentity, false);
    const ready = facade.assertCodexComposerReadyForAutomatedInput({
      options: {}, terminalControl: control, runtime
    });
    if (version === "0.155.1") await assert.doesNotReject(ready);
    else await assert.rejects(ready, /non-placeholder input/u);
    assert.deepEqual(provider.sentKeys, [], "readiness must never send terminal input");
    await assert.rejects(facade.assertCodexComposerReadyForAutomatedInput({
      options: {}, terminalControl: control
    }), /non-placeholder input/u, "native lifecycle callers remain outside the managed opt-in");
  }
});

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
      terminal_bridge_started_at: "2026-08-20T00:00:03.000Z",
      terminal_bridge_interaction_dispatch: {
        state: "uncertain",
        interaction_id: "ti_example",
        interaction_prompt_fingerprint: "a".repeat(64)
      }
    }
  } satisfies Conversation;
  const facade = adapter({}, (ports) => {
    ports.store.storeDirForConversation = () => root;
    ports.runtime.agentVersionForRunningProcess = (agent, pid) => {
      assert.equal(agent, "codex");
      assert.equal(pid, processIdentity.pid);
      return "0.153.4";
    };
  });
  const runtime = facade.terminalRuntimeIdentityForConversation(conversation, control);
  assert.equal(runtime.pid, processIdentity.pid);
  assert.equal(runtime.turnId, "turn-main");
  assert.equal(runtime.agentVersion, "0.153.4");
  assert.equal(runtime.interactionDispatchState, "uncertain");
  assert.equal(runtime.interactionDispatchInteractionId, "ti_example");
  assert.equal(runtime.interactionDispatchPromptFingerprint, "a".repeat(64));
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

test("active candidate-set Turn projects only its frozen baseline roots as monitor companions", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-candidate-runtime-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = terminalControl();
  const processIdentity = {
    pid: 101,
    processUuid: "codex-process-101",
    processBirth: "birth-101"
  };
  const acceptedThreadId = "22222222-2222-4222-8222-222222222222";
  const acceptedRollout = {
    fd: "8", device: "1", inode: "3", path: "/tmp/accepted-rollout"
  };
  const baselineThreadId = "11111111-1111-4111-8111-111111111111";
  const baselineRollout = {
    fd: "7", device: "1", inode: "2", path: "/tmp/baseline-rollout"
  };
  const binding = terminalBindingFrom({
    terminalId: "terminal:v2:tmux:codex:%1:101",
    terminalControl: control,
    ...processIdentity,
    rollout: acceptedRollout,
    nativeThreadId: acceptedThreadId,
    evidence: "test",
    generation: 1,
    now: new Date("2026-08-20T00:00:02.000Z")
  });
  saveManagedSession(root, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "managed-candidate",
    agent: "codex",
    workspace: "/workspace",
    status: "bound",
    binding,
    lineage: { created_by: "attach" },
    created_at: "2026-08-20T00:00:02.000Z",
    updated_at: "2026-08-20T00:00:02.000Z"
  }, { expectedRevision: null });
  const anchorBase = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 3 as const,
    process_uuid: processIdentity.processUuid,
    process_birth: processIdentity.processBirth,
    captured_at: "2026-08-20T00:00:01.000Z",
    mode: "candidate_set" as const,
    native_thread_binding: "post_submission" as const,
    file_existed: false as const,
    offset_bytes: 0 as const,
    zero_file_baseline: false,
    inventory_pid: processIdentity.pid,
    inventory_cwd: "/workspace",
    inventory_fingerprint: "a".repeat(64),
    candidate_rollouts: [{
      native_thread_id: baselineThreadId,
      rollout: baselineRollout,
      offset_bytes: 10
    }, {
      // A request may be accepted by a root that was already in the frozen
      // inventory. The bound root itself is never also a companion.
      native_thread_id: acceptedThreadId,
      rollout: acceptedRollout,
      offset_bytes: 20
    }]
  };
  const requestText = "candidate request";
  const anchor = {
    ...anchorBase,
    anchor_fingerprint: fingerprint(anchorBase)
  };
  const acceptanceBase = {
    source: "codex_rollout" as const,
    kind: "native_user_turn" as const,
    nativeThreadId: acceptedThreadId,
    requestHash: terminalBridgeRequestFingerprint(requestText),
    acceptanceId: "33333333-3333-4333-8333-333333333333",
    anchorFingerprint: anchor.anchor_fingerprint
  };
  const conversation = {
    ...createConversation({
      userRequest: requestText,
      sessionId: "managed-candidate",
      turnId: "turn-candidate",
      executorKind: "codex",
      now: new Date("2026-08-20T00:00:03.000Z")
    }),
    status: "waiting_for_agent" as const,
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: binding.generation,
    native_thread_id: acceptedThreadId,
    native_session_takeover: {
      terminal_agent_identity_protocol: 1,
      terminal_agent_pid: processIdentity.pid,
      terminal_agent_session_id: acceptedThreadId,
      terminal_agent_process_uuid: processIdentity.processUuid,
      terminal_agent_process_birth: processIdentity.processBirth,
      terminal_agent_rollout: acceptedRollout,
      source_cwd: "/workspace",
      terminal_bridge_message_id: "message-candidate",
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash:
        terminalBridgeRequestFingerprint(requestText),
      terminal_bridge_submission: {
        status: "agent_accepted",
        message_id: "message-candidate",
        request_hash: terminalBridgeRequestFingerprint(requestText),
        binding_id: binding.binding_id,
        binding_generation: binding.generation,
        native_thread_id: acceptedThreadId,
        acceptance_evidence: {
          ...acceptanceBase,
          evidenceFingerprint: fingerprint(acceptanceBase)
        }
      },
      codex_rollout_acceptance_anchor: anchor
    }
  } satisfies Conversation;
  const facade = adapter({}, (ports) => {
    ports.store.storeDirForConversation = () => root;
  });

  const runtime = facade.terminalRuntimeIdentityForConversation(
    conversation,
    control
  );
  assert.deepEqual(runtime.allowedPreMaterializationNativeIdentity, {
    sessionId: baselineThreadId,
    processUuid: processIdentity.processUuid,
    processBirth: processIdentity.processBirth,
    rollout: baselineRollout
  });
  assert.deepEqual(runtime.allowedAdditionalNativeIdentities, []);
  assert.equal(
    runtime.allowedPreMaterializationNativeIdentity?.sessionId ===
      acceptedThreadId,
    false
  );
});

test("candidate-set Turn companion projection rejects invalid or mismatched authority", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-candidate-fence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = terminalControl();
  const processIdentity = {
    pid: 101,
    processUuid: "codex-process-101",
    processBirth: "birth-101",
    rollout: {
      fd: "8", device: "1", inode: "3", path: "/tmp/accepted-rollout"
    }
  };
  const acceptedThreadId = "22222222-2222-4222-8222-222222222222";
  const binding = terminalBindingFrom({
    terminalId: "terminal:v2:tmux:codex:%1:101",
    terminalControl: control,
    ...processIdentity,
    nativeThreadId: acceptedThreadId,
    evidence: "test",
    generation: 1,
    now: new Date("2026-08-20T00:00:02.000Z")
  });
  saveManagedSession(root, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "managed-candidate-fence",
    agent: "codex",
    workspace: "/workspace",
    status: "bound",
    binding,
    lineage: { created_by: "attach" },
    created_at: "2026-08-20T00:00:02.000Z",
    updated_at: "2026-08-20T00:00:02.000Z"
  }, { expectedRevision: null });
  const validAnchorBase = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 3 as const,
    process_uuid: processIdentity.processUuid,
    process_birth: processIdentity.processBirth,
    captured_at: "2026-08-20T00:00:01.000Z",
    mode: "candidate_set" as const,
    native_thread_binding: "post_submission" as const,
    file_existed: false as const,
    offset_bytes: 0 as const,
    zero_file_baseline: false,
    inventory_pid: processIdentity.pid,
    inventory_cwd: "/workspace",
    inventory_fingerprint: "a".repeat(64),
    candidate_rollouts: [{
      native_thread_id: "11111111-1111-4111-8111-111111111111",
      rollout: {
        fd: "7", device: "1", inode: "2", path: "/tmp/baseline-rollout"
      },
      offset_bytes: 10
    }]
  };
  const requestText = "candidate request";
  const conversationFor = (
    anchorBase: typeof validAnchorBase,
    options: {
      status?: Conversation["status"];
      identityProtocol?: number;
      sourceCwd?: string;
      anchorFingerprint?: string;
      submissionStatus?: string;
      takeoverMessageId?: string;
      submissionMessageId?: string;
      takeoverRequestHash?: string;
      submissionRequestHash?: string;
      submissionBindingId?: string;
      submissionBindingGeneration?: number;
      submissionNativeThreadId?: string;
      evidenceAnchorFingerprint?: string;
      evidenceNativeThreadId?: string;
      evidenceFingerprint?: string;
      runtimeRollout?: typeof processIdentity.rollout;
    } = {}
  ): Conversation => {
    const anchor = {
      ...anchorBase,
      anchor_fingerprint:
        options.anchorFingerprint ?? fingerprint(anchorBase)
    };
    const evidenceBase = {
      source: "codex_rollout" as const,
      kind: "native_user_turn" as const,
      nativeThreadId:
        options.evidenceNativeThreadId ?? acceptedThreadId,
      requestHash: terminalBridgeRequestFingerprint(requestText),
      acceptanceId: "33333333-3333-4333-8333-333333333333",
      anchorFingerprint:
        options.evidenceAnchorFingerprint ?? anchor.anchor_fingerprint
    };
    return {
      ...createConversation({
        userRequest: requestText,
        sessionId: "managed-candidate-fence",
        turnId: "turn-candidate-fence",
        executorKind: "codex",
        now: new Date("2026-08-20T00:00:03.000Z")
      }),
      status: options.status ?? "waiting_for_agent",
      terminal_binding_id: binding.binding_id,
      terminal_binding_generation: binding.generation,
      native_thread_id: acceptedThreadId,
      native_session_takeover: {
        terminal_agent_identity_protocol: options.identityProtocol ?? 1,
        terminal_agent_pid: processIdentity.pid,
        terminal_agent_session_id: acceptedThreadId,
        terminal_agent_process_uuid: processIdentity.processUuid,
        terminal_agent_process_birth: processIdentity.processBirth,
        terminal_agent_rollout:
          options.runtimeRollout ?? processIdentity.rollout,
        source_cwd: options.sourceCwd ?? "/workspace",
        terminal_bridge_message_id:
          options.takeoverMessageId ?? "message-candidate-fence",
        terminal_bridge_request_text: requestText,
        terminal_bridge_request_hash: options.takeoverRequestHash ??
          terminalBridgeRequestFingerprint(requestText),
        terminal_bridge_submission: {
          status: options.submissionStatus ?? "agent_accepted",
          message_id:
            options.submissionMessageId ?? "message-candidate-fence",
          request_hash: options.submissionRequestHash ??
            terminalBridgeRequestFingerprint(requestText),
          binding_id: options.submissionBindingId ?? binding.binding_id,
          binding_generation:
            options.submissionBindingGeneration ?? binding.generation,
          native_thread_id:
            options.submissionNativeThreadId ?? acceptedThreadId,
          acceptance_evidence: {
            ...evidenceBase,
            evidenceFingerprint:
              options.evidenceFingerprint ?? fingerprint(evidenceBase)
          }
        },
        codex_rollout_acceptance_anchor: anchor
      }
    };
  };
  const facade = adapter({
    workspaceMatches: (configured, candidate) =>
      path.resolve(String(configured)) === path.resolve(String(candidate))
  }, (ports) => {
    ports.store.storeDirForConversation = () => root;
  });
  const mutations: Array<{
    label: string;
    anchor: typeof validAnchorBase;
    options?: Parameters<typeof conversationFor>[1];
    control?: TerminalControlRef;
  }> = [
    {
      label: "pid",
      anchor: { ...validAnchorBase, inventory_pid: processIdentity.pid + 1 }
    },
    {
      label: "process UUID",
      anchor: { ...validAnchorBase, process_uuid: "another-process" }
    },
    {
      label: "process birth",
      anchor: { ...validAnchorBase, process_birth: "another-birth" }
    },
    {
      label: "cwd",
      anchor: { ...validAnchorBase, inventory_cwd: "/another-workspace" }
    },
    {
      label: "fingerprint",
      anchor: validAnchorBase,
      options: { anchorFingerprint: "f".repeat(64) }
    },
    {
      label: "released Turn",
      anchor: validAnchorBase,
      options: { status: "idle" }
    },
    {
      label: "pre-acceptance submission",
      anchor: validAnchorBase,
      options: { submissionStatus: "enter_dispatched" }
    },
    {
      label: "non-strict identity protocol",
      anchor: validAnchorBase,
      options: { identityProtocol: 0 }
    },
    {
      label: "message id",
      anchor: validAnchorBase,
      options: { submissionMessageId: "another-message" }
    },
    {
      label: "request hash",
      anchor: validAnchorBase,
      options: { submissionRequestHash: "d".repeat(64) }
    },
    {
      label: "takeover request hash",
      anchor: validAnchorBase,
      options: { takeoverRequestHash: "e".repeat(64) }
    },
    {
      label: "binding id",
      anchor: validAnchorBase,
      options: { submissionBindingId: "another-binding" }
    },
    {
      label: "binding generation",
      anchor: validAnchorBase,
      options: { submissionBindingGeneration: binding.generation + 1 }
    },
    {
      label: "submission thread",
      anchor: validAnchorBase,
      options: {
        submissionNativeThreadId: "44444444-4444-4444-8444-444444444444"
      }
    },
    {
      label: "runtime rollout",
      anchor: validAnchorBase,
      options: {
        runtimeRollout: {
          ...processIdentity.rollout,
          path: "/tmp/another-accepted-rollout"
        }
      }
    },
    {
      label: "bound rollout alias",
      anchor: {
        ...validAnchorBase,
        candidate_rollouts: [{
          native_thread_id: "11111111-1111-4111-8111-111111111111",
          rollout: processIdentity.rollout,
          offset_bytes: 10
        }]
      }
    },
    {
      label: "acceptance anchor",
      anchor: validAnchorBase,
      options: { evidenceAnchorFingerprint: "b".repeat(64) }
    },
    {
      label: "acceptance thread",
      anchor: validAnchorBase,
      options: {
        evidenceNativeThreadId: "44444444-4444-4444-8444-444444444444"
      }
    },
    {
      label: "acceptance fingerprint",
      anchor: validAnchorBase,
      options: { evidenceFingerprint: "c".repeat(64) }
    },
    {
      label: "Turn source cwd",
      anchor: validAnchorBase,
      options: { sourceCwd: "/another-workspace" }
    },
    {
      label: "terminal cwd",
      anchor: validAnchorBase,
      control: { ...control, currentPath: "/another-workspace" }
    }
  ];
  for (const candidate of mutations) {
    const runtime = facade.terminalRuntimeIdentityForConversation(
      conversationFor(candidate.anchor, candidate.options),
      candidate.control ?? control
    );
    assert.equal(
      runtime.allowedPreMaterializationNativeIdentity,
      undefined,
      candidate.label
    );
    assert.deepEqual(
      runtime.allowedAdditionalNativeIdentities,
      [],
      candidate.label
    );
  }
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

type ClaudeRestartCase = "dead" | "reused_pid" | "live" | "unknown" | "missing_identity" |
  "source_transition" | "source_transition_race" | "source_turn" | "foreign_store" | "revision_race";

function claudeRestartFixture(root: string, scenario: ClaudeRestartCase = "dead") {
  const events: string[] = [];
  const oldPid = scenario === "reused_pid" ? 202 : 101;
  const currentPid = 202;
  const startedAt = 1_793_185_422_337;
  const nativeThreadId = "11111111-1111-4111-8111-111111111111";
  const control: TerminalControlRef = {
    kind: "tmux", target: "restart:0.0", session: "restart", window: 0, pane: 0,
    panePid: 100, currentPath: root, currentCommand: "claude",
    capabilities: ["screen_status", "send_keys", "durable_completion"]
  };
  const agentAdapter = createProductionTerminalAgentRegistry().require("claude");
  const current: ResolvedTerminalConversation = {
    conversationId: `terminal:v2:tmux:claude:restart:0.0:${currentPid}`,
    agent: "claude", pid: currentPid, legacy: false, terminalControl: control, adapter: agentAdapter
  };
  const identity: TerminalNativeIdentity = {
    sessionId: nativeThreadId, processStartedAt: startedAt,
    ...(scenario === "missing_identity" ? {} : { processUuid: `claude-pid:${currentPid}:started:${startedAt}` }),
    evidence: "claude_agents_exact_pid"
  };
  let currentIdentity = identity;
  const outputs: Array<Record<string, unknown>> = [];
  saveManagedSession(root, {
    schema: "agent-knock-knock/session", version: 1, session_id: "session-restarted-claude",
    agent: "claude", workspace: root, status: "bound",
    binding: terminalBindingFrom({
      terminalId: `terminal:v2:tmux:claude:restart:0.0:${oldPid}`,
      terminalControl: control, pid: oldPid, nativeThreadId,
      processUuid: `claude-pid:${oldPid}:started:1793180000000`,
      evidence: "claude_agents_exact_pid", generation: 1,
      now: new Date("2026-10-28T10:53:44.791Z")
    }),
    lineage: { created_by: "attach" }, created_at: "2026-10-28T10:53:44.791Z",
    updated_at: "2026-10-28T10:53:44.791Z"
  }, { expectedRevision: null });
  const original = loadManagedSession(root, "session-restarted-claude");
  const assertStore = () => {
    events.push("store-authority");
    if (scenario === "foreign_store") throw new Error("native Store authority conflict; no input sent");
  };
  let lifecycle: ReturnType<typeof createNativeThreadLifecycleCliAdapter>;
  let transitionPending = scenario === "source_transition";
  const authority = adapter({
    cwd: () => root,
    now: () => new Date("2026-10-28T11:10:00.000Z"),
    isProcessAlive: () => {
      if (scenario === "unknown") throw new Error("owner process observation unavailable");
      return scenario === "live" || oldPid === currentPid;
    }
  }, (ports) => {
    ports.store.storeDir = () => root;
    ports.authority.assertManagedSessionCanStartTurn = () => {
      events.push("source-turn-check");
      if (scenario === "source_turn") throw new Error("Session has an unresolved Turn; inspect Status");
    };
    ports.authority.hasUnresolvedNativeTransition = () => transitionPending;
    ports.authority.assertNativeThreadHasExclusiveOwnership = async request => {
      events.push("exclusive");
      await lifecycle.assertExclusive(request);
      if (scenario === "source_transition_race") transitionPending = true;
      if (scenario === "revision_race") saveManagedSession(root, {
        ...loadManagedSession(root, original.session_id), updated_at: "2026-10-28T11:09:59.000Z"
      }, { expectedRevision: original.revision! });
    };
  });
  const rows = () => [{
    pid: currentPid, cwd: root, sessionId: currentIdentity.sessionId, startedAt,
    kind: "interactive", status: "idle"
  }];
  const bridge = {
    resolveConversationId: async () => current,
    resolveStoredTerminal: async () => current,
    status: async () => {
      events.push("idle-screen");
      return {
        reachable: true, activity_state: "idle", activity_reason: "current idle Composer",
        approval_state: { scanned: true, blocked: false, approvable: false },
        screen: { excerpt: `${"─".repeat(60)}\n❯\n${"─".repeat(60)}\n  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents` }
      };
    },
    send: async (_agent: unknown, _control: unknown, command: string) => {
      events.push("terminal-input");
      assert.equal(command, "/clear");
      const source = loadManagedSession(root, original.session_id);
      assert.equal(source.status, "transitioning");
      assert.equal(source.binding?.generation, 2, "recover the old process before terminal input");
      currentIdentity = { ...identity, sessionId: "22222222-2222-4222-8222-222222222222" };
    }
  } as unknown as TerminalAgentBridge;
  const runtime = {
    createBridge: () => bridge,
    createAgentRegistry: () => createProductionTerminalAgentRegistry(),
    agentVersionForRunningProcess: () => "2.1.295",
    loadClaudeAgentRows: () => rows()
  } as unknown as TerminalRuntimeCliAdapter;
  lifecycle = createNativeThreadLifecycleCliAdapter({
    runtime: { forOptions: () => runtime, sleep: async () => undefined },
    identity: {
      resolveCurrent: async () => currentIdentity,
      managedContext: () => ({ companions: { additional: [] } }),
      boundSession: input => authority.boundManagedSessionForTerminal(input),
      materializeSession: input => authority.materializeCurrentManagedSession(input),
      refineSession: input => input.session,
      logicalIdentity: input => authority.logicalIdentityForManagedSession(input),
      companionSet: () => ({ additional: [] }),
      processIncarnation: () => { throw new Error("unexpected Codex identity fallback"); },
      physicalProcessIncarnation: () => { throw new Error("unexpected physical identity fallback"); },
      runtimeForLiveIdentity: input => authority.terminalRuntimeForLiveIdentity(input),
      ownerIsInactive: input => authority.managedSessionOwnerIsConclusivelyInactive(input),
      assertCodexComposerReady: async () => { throw new Error("unexpected Codex Composer check"); },
      ...{
        reattachSession: async (input: Parameters<typeof authority.reattachManagedSessionForNativeIdentity>[0]) => {
          events.push("reattach");
          return authority.reattachManagedSessionForNativeIdentity(input);
        }
      }
    },
    state: {
      storeDir: () => root, inspectStore: () => ({ writable: true }), runtimeDir: () => path.join(root, "runtime"),
      acquireTerminal: () => () => undefined, loadLedger: () => undefined,
      managedTurns: () => [], terminalBlockingTurns: () => [],
      hasUnresolvedTransition: () => transitionPending,
      dispatchOwnership: () => ({ state: "none" }), assertNativeThreadStoreAuthority: assertStore,
      orphanedForRecovery: () => undefined
    },
    output: { cwd: () => root, print: () => undefined }
  });
  const unexpected = (): never => { throw new Error("unexpected lifecycle mutation"); };
  const application = createNativeThreadTransitionApplication({
    runtime: {
      now: () => new Date("2026-10-28T11:10:00.000Z"), nowMs: () => 1_793_185_800_000,
      pid: () => process.pid, cwd: () => root, sleep: async () => undefined,
      env: () => undefined, exit: unexpected,
      log: () => undefined, print: value => outputs.push(value as Record<string, unknown>), summarizeError: error => ({ length: String(error).length })
    },
    lifecycle: {
      facade: lifecycle, runtime: () => runtime, resolveIdentity: async () => currentIdentity,
      runtimeForIdentity: input => authority.terminalRuntimeForLiveIdentity(input),
      exactIdentity: (terminal, value) => authority.exactLifecycleProcessIdentity(terminal, value),
      assertComposerReady: async () => undefined
    },
    state: {
      storeDir: () => root, runtimeDir: () => path.join(root, "runtime"), loadLedger: () => undefined,
      reconcilePrepared: (_control, ledger) => ledger, reconcileIncarnation: (_control, ledger) => ledger,
      recordMatchesControl: () => false,
      lifecycleLedger: { save: () => events.push("prepared-ledger") } as never,
      ordinaryOwnerStatus: () => undefined, blockingTurns: () => [], managedTurns: () => [],
      hasUnresolvedTransition: () => transitionPending, dispatchOwnership: () => ({ state: "none" })
    },
    authority: {
      sessionClaimsTerminal: (session, terminal) => authority.managedSessionClaimsResolvedTerminal(session, terminal),
      conflictKind: input => authority.managedBindingConflictKindForResolvedTerminal(input),
      ownerIsInactive: input => authority.managedSessionOwnerIsConclusivelyInactive(input as never),
      observeExternal: unexpected, recoverDeferred: async () => undefined,
      knownRoots: () => ({ additional: [] }), codexProcessBirth: unexpected,
      processAlive: () => false, workspaceMatches: (left, right) => left === right
    },
    mutation: {
      locks: () => ({
        resources: {
          terminal: canonicalMutationResource(terminalRuntimeResourceKey(control), control),
          storeWriter: canonicalMutationResource(root, root)
        },
        acquireTerminal: () => { events.push("terminal-lock"); return () => events.push("unlock"); },
        withStoreWriter: operation => withStoreWriterLeaseAsync(root, operation)
      }),
      authenticate: () => ({ terminalControl: control, storeDir: root }),
      loadSession: (_scopes, _resources, id) => loadManagedSession(root, id),
      saveSession: (_scopes, _resources, state, options) => saveManagedSession(root, state, options)
    }
  });
  return { root, events, outputs, original, current, identity, authority, lifecycle, application };
}

for (const scenario of ["dead", "reused_pid"] as const) {
  test(`Claude new_thread recovers a ${scenario} process claim and commits using the original List token`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-restart-lifecycle-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = claudeRestartFixture(root, scenario);
    const listed = await fixture.lifecycle.currentSnapshot({}, fixture.current);
    assert.equal(listed.session, undefined, "an old process is not the current bound Session");
    await fixture.application.runNewThread({
      terminal: fixture.current.conversationId, expectedBindingToken: listed.bindingToken, storeDir: root
    });
    const rebound = loadManagedSession(root, fixture.original.session_id);
    assert.equal(rebound.session_id, fixture.original.session_id);
    assert.equal(rebound.revision, 4, "reattach, transition, then detach the preserved source");
    assert.equal(rebound.status, "detached");
    assert.equal(rebound.binding?.generation, 2);
    assert.equal(rebound.binding?.native_process.pid, fixture.current.pid);
    assert.equal(rebound.binding?.native_process.process_uuid, fixture.identity.processUuid);
    assert.equal(rebound.binding?.native_thread_id, fixture.identity.sessionId);
    const transitions = listNativeThreadTransitions(root);
    assert.equal(transitions.length, 1);
    assert.equal(transitions[0].status, "committed");
    assert.equal(transitions[0].source_session_id, fixture.original.session_id);
    assert.equal(transitions[0].source_expected_revision, 2);
    assert.ok(fixture.events.indexOf("idle-screen") < fixture.events.indexOf("reattach"));
    assert.equal(fixture.events.filter(event => event === "terminal-input").length, 1);
    assert.equal(fixture.outputs.at(-1)?.status, "committed");
    assert.equal(fixture.outputs.at(-1)?.previous_session_id, fixture.original.session_id);
    const refreshed = await fixture.lifecycle.currentSnapshot({}, fixture.current);
    assert.equal(refreshed.bindingTokens.includes(listed.bindingToken), false,
      "the old unmanaged token is not a persistent alias for the rebound Session");
  });
}

for (const [scenario, error] of [
  ["live", /still bound|live or unverifiable/u],
  ["unknown", /owner process observation unavailable/u],
  ["missing_identity", /process incarnation|generation/u],
  ["source_transition", /unresolved.*transition|lifecycle recovery/u],
  ["source_transition_race", /unresolved.*transition|lifecycle recovery/u],
  ["source_turn", /unresolved Turn/u],
  ["foreign_store", /Store authority conflict/u],
  ["revision_race", /changed before raw reattach/u]
] as const) {
  test(`Claude restart recovery preserves ${scenario} authority without writing terminal input`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-restart-fence-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const fixture = claudeRestartFixture(root, scenario);
    if (scenario === "missing_identity") {
      const listed = await fixture.lifecycle.currentSnapshot({}, fixture.current);
      await assert.rejects(fixture.application.runNewThread({
        terminal: fixture.current.conversationId, expectedBindingToken: listed.bindingToken, storeDir: root
      }), error);
      assert.equal(fixture.events.includes("reattach"), false);
    } else {
      await assert.rejects(fixture.authority.reattachManagedSessionForNativeIdentity({
        options: { storeDir: root }, terminal: fixture.current, identity: fixture.identity, storeDir: root
      }), error);
    }
    const preserved = loadManagedSession(root, fixture.original.session_id);
    assert.deepEqual(preserved.binding, fixture.original.binding);
    assert.equal(preserved.revision, scenario === "revision_race" ? 2 : 1);
    assert.equal(fixture.events.includes("terminal-input"), false);
    assert.equal(listNativeThreadTransitions(root).length, 0);
  });
}

test("Claude lifecycle rejects a stale displayed token before rebinding an exited owner", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-claude-restart-token-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = claudeRestartFixture(root);
  await assert.rejects(fixture.application.runNewThread({
    terminal: fixture.current.conversationId, expectedBindingToken: "stale-token", storeDir: root
  }), /binding changed after it was listed/u);
  assert.deepEqual(loadManagedSession(root, fixture.original.session_id), fixture.original);
  assert.equal(fixture.events.includes("reattach"), false);
  assert.equal(fixture.events.includes("terminal-input"), false);
});

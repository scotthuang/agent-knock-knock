import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import type {
  TerminalBridgeStatus
} from "../src/terminal-agent-bridge.js";
import {
  collectTerminalListTerminalFacts,
  type EffectiveTerminalListState,
  type TerminalListState,
  type TerminalNativeListIdentityFacts
} from "../src/terminal-list-facts.js";
import type { TerminalModelControlCapabilities } from
  "../src/terminal-model-control.js";

const terminalControl: TerminalControlRef = {
  kind: "tmux",
  target: "facts:0.0",
  session: "facts",
  window: 0,
  pane: 0,
  panePid: 400,
  currentPath: "/workspace/facts",
  capabilities: ["screen_status", "send_keys"]
};

const session: ActiveTerminalProcess = {
  pid: 404,
  ppid: 400,
  command: "codex",
  cwd: "/workspace/facts",
  agent: "codex",
  kind: "codex_cli",
  confidence: "high",
  reason: "fixture",
  terminalControl
};

const statusSnapshot = {
  approval_state: {
    scanned: true,
    blocked: false,
    approvable: false,
    reason: "no approval prompt"
  },
  activity_state: "idle",
  activity_reason: "exact idle fixture",
  screen: { excerpt: "› " }
} as TerminalBridgeStatus;

const observedState: TerminalListState = {
  approval_state: statusSnapshot.approval_state,
  activity_state: "idle",
  activity_reason: "exact idle fixture",
  screen_state: "idle",
  screen_reason: "exact idle fixture",
  screen_excerpt: "› ",
  _terminal_status_snapshot: statusSnapshot
};

const effectiveState: EffectiveTerminalListState = {
  ...observedState,
  native_identity_state: "verified_absent",
  durable_activity_state: "unknown",
  durable_activity_reason: "no rollout"
};

const nativeFacts: TerminalNativeListIdentityFacts = {
  nativeIdentityObservation: {
    status: "verified_absent",
    evidence: "native_identity_resolver_verified_absent"
  },
  authorityNativeIdentityObservation: {
    status: "verified_absent",
    evidence: "native_identity_resolver_verified_absent"
  },
  codexOpenRootRolloutInventory: {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory",
    version: 1,
    status: "verified_absent",
    pid: 404,
    processUuid: "codex-pid:404:birth:birth-404",
    processBirth: "birth-404",
    roots: [],
    inventoryFingerprint: "a".repeat(64)
  },
  nativeProcessUuid: "codex-pid:404:birth:birth-404",
  nativeProcessBirth: "birth-404",
  nativeProcessEvidence: "codex_open_root_rollout_inventory"
};

test("terminal facts have no Store, action-policy, or public presentation edge", () => {
  const source = fs.readFileSync(
    "src/terminal-list-facts.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /from "\.\/(?:store|session-store|terminal-action-projection|terminal-list-renderer)\.js"/u
  );
  assert.doesNotMatch(
    source,
    /\b(?:available_actions|expected_binding_token|expected_terminal_token)\b/u
  );
});

test("per-terminal facts sample every observation once and reuse model capability", async () => {
  const calls = new Map<string, number>();
  const count = (name: string) => calls.set(name, (calls.get(name) ?? 0) + 1);
  const modelCapability: TerminalModelControlCapabilities = {
    status: "supported",
    agentVersion: "0.154.0",
    behaviorProfile: "codex-model-control-0.154.0",
    scope: "current_and_new_sessions",
    modelSelection: true,
    reasoningEffortSelection: true,
    reason: "fixture"
  };
  const adapter = {
    agent: "codex",
    displayName: "Codex",
    capabilities: {},
    cancelKeys: [],
    classifyProcess: () => undefined,
    inspectScreen: () => ({
      activity: { state: "idle", reason: "fixture" },
      approval: {
        blocked: false,
        approvable: false,
        reason: "fixture"
      }
    }),
    observeThreadLifecycle: () => {
      count("status-card");
      return { status: "missing" as const };
    },
    probeThreadLifecycle: () => {
      count("lifecycle-capability");
      return {
        status: "supported" as const,
        agentVersion: "0.154.0",
        newThread: true,
        resumeExact: true,
        reason: "fixture"
      };
    },
    probeNativeInspection: () => {
      count("native-inspection-capability");
      return {
        status: "supported" as const,
        agentVersion: "0.154.0",
        statusInspection: true,
        reason: "fixture"
      };
    },
    probeModelControl: () => {
      count("model-control-capability");
      return modelCapability;
    }
  } as unknown as TerminalAgentAdapter;

  const facts = await collectTerminalListTerminalFacts({
    session,
    terminalControl,
    terminalId: "terminal:v2:tmux:codex:facts:0.0:404",
    childPids: [405],
    adapter,
    ports: {
      observeStatus: async (agentVersion) => {
        count("status");
        assert.equal(agentVersion, "0.154.0");
        return observedState;
      },
      observeNativeIdentity: async (terminalId) => {
        count("native-identity");
        assert.equal(
          terminalId,
          "terminal:v2:tmux:codex:facts:0.0:404"
        );
        return nativeFacts;
      },
      projectEffectiveState: ({ terminalState, native }) => {
        count("effective-state");
        assert.equal(terminalState, observedState);
        assert.equal(native, nativeFacts);
        return effectiveState;
      },
      observeAgentVersion: () => {
        count("agent-version");
        return "0.154.0";
      },
      observeTerminalHasBlockingTurn: () => {
        count("blocking-turn");
        return false;
      },
      observeComposer: async (state) => {
        count("composer");
        assert.equal(state, effectiveState);
        return {
          automatedInputComposerReady: true,
          userExplicitComposerReady: true,
          inputOwnerBlocked: false
        };
      },
      observePhysicalProcessIncarnation: () => {
        count("physical-process");
        return {
          processUuid: "process-pid:404:birth:birth-404",
          processBirth: "birth-404",
          evidence: "process_birth"
        };
      },
      observeLatentClearResume: () => {
        count("latent-clear-resume");
        return undefined;
      },
      observeModelControlResidual: async (input) => {
        count("model-control-residual");
        assert.equal(input.modelControlCapability, modelCapability);
        assert.equal(input.zeroRolloutVerified, true);
        assert.equal(input.terminalHasInteraction, false);
        return {
          state: "recoverable",
          kind: "model_surface",
          fingerprint: "b".repeat(64),
          terminalControl
        };
      },
      projectStatusSnapshot: (status, projection) => {
        count("status-projection");
        assert.equal(status, statusSnapshot);
        assert.equal(projection, effectiveState);
        return status;
      }
    }
  });

  assert.deepEqual(Object.fromEntries(calls), {
    status: 1,
    "native-identity": 1,
    "effective-state": 1,
    "status-projection": 1,
    "status-card": 1,
    "agent-version": 1,
    "lifecycle-capability": 1,
    "native-inspection-capability": 1,
    "model-control-capability": 1,
    "latent-clear-resume": 1,
    "blocking-turn": 1,
    composer: 1,
    "physical-process": 1,
    "model-control-residual": 1
  });
  assert.equal(facts.status.observed.approval_state.scanned, true);
  assert.equal(facts.status.snapshot, statusSnapshot);
  assert.equal(facts.status.projected.activity_state, "unknown");
  assert.match(facts.status.projected.activity_reason, /model-control surface/u);
  assert.equal(facts.codex.zeroRolloutModelControlVerified, true);
  assert.equal(facts.runtime.modelControlCapability, modelCapability);
  assert.ok(Object.isFrozen(facts));
  assert.ok(Object.isFrozen(facts.physical));
  assert.ok(Object.isFrozen(facts.status));
  assert.ok(Object.isFrozen(facts.runtime));
  assert.ok(Object.isFrozen(facts.composer));
  assert.ok(Object.isFrozen(facts.store));
  assert.ok(Object.isFrozen(facts.codex));
});

test("facts preserve an ordinary effective state when no model surface is observed", async () => {
  const adapter = {
    agent: "codex",
    observeThreadLifecycle: () => ({ status: "missing" }),
    probeModelControl: () => ({
      status: "unsupported",
      modelSelection: false,
      reasoningEffortSelection: false,
      reason: "unsupported fixture"
    })
  } as unknown as TerminalAgentAdapter;
  const facts = await collectTerminalListTerminalFacts({
    session,
    terminalControl,
    terminalId: "terminal:v2:tmux:codex:facts:0.0:404",
    childPids: [],
    adapter,
    ports: {
      observeStatus: async () => observedState,
      observeNativeIdentity: async () => nativeFacts,
      projectEffectiveState: () => effectiveState,
      observeAgentVersion: () => "0.154.0",
      observeTerminalHasBlockingTurn: () => false,
      observeComposer: async () => ({
        automatedInputComposerReady: true,
        userExplicitComposerReady: true,
        inputOwnerBlocked: false
      }),
      observePhysicalProcessIncarnation: () => ({
        processUuid: "process-pid:404:birth:birth-404",
        processBirth: "birth-404"
      }),
      observeLatentClearResume: () => undefined,
      observeModelControlResidual: async () => undefined,
      projectStatusSnapshot: (status) => status
    }
  });

  assert.equal(facts.status.projected, effectiveState);
  assert.equal(facts.modelControlResidual, undefined);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type { ExecutorKind } from "../src/executors.js";
import {
  decideTerminalListActions,
  type TerminalListActionSubject
} from "../src/terminal-list-action-policy.js";
import type {
  EffectiveTerminalListState,
  TerminalListTerminalFacts
} from "../src/terminal-list-facts.js";
import type { TerminalControlRef } from
  "../src/terminal-control-ref.js";
import { terminalModelControlProfileFor } from
  "../src/terminal-model-control.js";

const SESSION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0101";

const control: TerminalControlRef = {
  kind: "herdr",
  target: "default:w1:p4",
  socketPath: "/tmp/herdr.sock",
  session: "default",
  sessionDir: "/tmp/herdr-session",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-4",
  terminalId: "pty-4",
  panePid: 41,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: [
    "screen_status", "send_keys", "terminal_approval", "terminal_cancel"
  ]
};

function subject(overrides: Partial<TerminalListActionSubject> = {}) {
  return {
    exactTerminalRow: true,
    processState: "active",
    terminalControl: control,
    agent: "codex" as ExecutorKind,
    pid: 42,
    ...overrides
  };
}

function terminalState(overrides: Partial<EffectiveTerminalListState> = {}) {
  return {
    approval_state: {
      scanned: true,
      blocked: false,
      approvable: false,
      reason: "no approval prompt"
    },
    activity_state: "idle",
    activity_reason: "exact idle fixture",
    screen_state: "idle",
    screen_reason: "exact idle fixture",
    native_identity_state: "resolved",
    durable_activity_state: "idle",
    durable_activity_reason: "fixture",
    ...overrides
  } as EffectiveTerminalListState;
}

function facts(overrides: {
  state?: Partial<EffectiveTerminalListState>;
  automatedInputComposerReady?: boolean;
  userExplicitComposerReady?: boolean;
  hasInteraction?: boolean;
  terminalHasBlockingTurn?: boolean;
  hasOrphanedDispatch?: boolean;
  lifecycleSupported?: boolean;
  inspectionSupported?: boolean;
  modelControlSupported?: boolean;
  zeroRolloutVerified?: boolean;
  exactIdentity?: boolean;
  residual?: TerminalListTerminalFacts["modelControlResidual"];
} = {}): TerminalListTerminalFacts {
  const state = terminalState(overrides.state);
  const exactIdentity = overrides.exactIdentity === false
    ? undefined
    : {
        sessionId: SESSION_ID,
        processUuid: "process-uuid",
        processBirth: "process-birth",
        rollout: {
          fd: "21",
          device: "1",
          inode: "101",
          path: "/workspace/project/rollout.jsonl"
        },
        evidence: "fixture"
      };
  return {
    physical: {
      terminalId: "terminal:v2:herdr:codex:default:w1:p4:42",
      childPids: [],
      processIncarnation: {
        processUuid: "process-uuid",
        processBirth: "process-birth"
      }
    },
    status: {
      observed: state,
      effective: state,
      projected: state,
      hasInteraction: overrides.hasInteraction ?? false
    },
    native: {
      nativeIdentityObservation: exactIdentity
        ? { status: "resolved", identity: exactIdentity }
        : { status: "verified_absent", evidence: "fixture" },
      nativeAgentIdentity: exactIdentity,
      authorityNativeIdentityObservation: exactIdentity
        ? { status: "resolved", identity: exactIdentity }
        : { status: "verified_absent", evidence: "fixture" },
      authorityNativeAgentIdentity: exactIdentity,
      nativeProcessUuid: "process-uuid",
      nativeProcessBirth: "process-birth"
    },
    runtime: {
      agentVersion: "0.154.0",
      lifecycleCapability: {
        status: overrides.lifecycleSupported === false
          ? "unsupported" : "supported",
        agentVersion: "0.154.0",
        newThread: overrides.lifecycleSupported !== false,
        resumeExact: overrides.lifecycleSupported !== false,
        reason: "fixture"
      },
      nativeInspectionCapability: {
        status: overrides.inspectionSupported === false
          ? "unsupported" : "supported",
        agentVersion: "0.154.0",
        statusInspection: overrides.inspectionSupported !== false,
        reason: "fixture"
      },
      modelControlCapability: overrides.modelControlSupported === false
        ? {
            status: "unsupported",
            agentVersion: "0.154.0",
            modelSelection: false,
            reasoningEffortSelection: false,
            reason: "fixture"
          }
        : {
            status: "supported",
            agentVersion: "0.154.0",
            behaviorProfile: "codex-model-control-0.154.0",
            scope: "current_and_new_sessions",
            modelSelection: true,
            reasoningEffortSelection: true,
            reason: "fixture"
          },
      modelControlProfile: terminalModelControlProfileFor("codex", "0.154.0"),
      compatibilityWarnings: []
    },
    composer: {
      automatedInputComposerReady:
        overrides.automatedInputComposerReady ?? true,
      userExplicitComposerReady: overrides.userExplicitComposerReady ?? true
    },
    store: {
      terminalHasBlockingTurn: overrides.terminalHasBlockingTurn ?? false,
      hasOrphanedDispatch: overrides.hasOrphanedDispatch ?? false
    },
    codex: {
      zeroRolloutModelControlVerified:
        overrides.zeroRolloutVerified ?? false
    },
    modelControlResidual: overrides.residual
  } as TerminalListTerminalFacts;
}

test("List action policy is observation-, Store-, token-, and presentation-free", () => {
  const source = fs.readFileSync("src/terminal-list-action-policy.ts", "utf8");
  assert.doesNotMatch(source, /from "\.\/(?:store|session-store)\.js"/u);
  assert.doesNotMatch(
    source,
    /\b(?:captureTerminal|captureScreen|sendKeys|send_keys)\s*\(/u
  );
  assert.doesNotMatch(
    source,
    /(?:BindingToken\(|expected_binding_token|expected_terminal_token|available_actions)/u
  );
});

test("idle exact Codex decisions preserve lifecycle, Send, Watch, and model control", () => {
  const decision = decideTerminalListActions({
    subject: subject(),
    facts: facts()
  });
  assert.deepEqual(decision.commands, {
    send: true,
    approve: false,
    status: true,
    cancel: true,
    close: false,
    new_thread: true,
    list_resumable_threads: true,
    native_inspect: true,
    identify_foreground: false,
    identify_and_send: false,
    watch: true
  });
  assert.equal(decision.terminalUserExplicitSend.eligible, true);
  assert.deepEqual(decision.modelControl, {
    availability: "open_from_empty",
    authority: "native_session",
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42"
  });
});

test("zero-rollout Codex retains physical Send and model-control decisions", () => {
  const decision = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      exactIdentity: false,
      zeroRolloutVerified: true,
      state: { native_identity_state: "verified_absent" }
    })
  });
  assert.equal(decision.terminalUserExplicitSend.eligible, true);
  assert.equal(decision.commands.identify_foreground, true);
  assert.deepEqual(decision.modelControl, {
    availability: "open_from_empty",
    authority: "zero_rollout_physical",
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42"
  });
});

test("interaction, blocking Turn, and orphan ownership fail closed by action", () => {
  const questionnaire = decideTerminalListActions({
    subject: subject(),
    facts: facts({ hasInteraction: true })
  });
  assert.equal(questionnaire.commands.watch, true);
  assert.equal(questionnaire.commands.native_inspect, true);
  assert.equal(questionnaire.terminalUserExplicitSend.eligible, false);
  assert.equal(questionnaire.modelControl.availability, "unavailable");

  const blocking = decideTerminalListActions({
    subject: subject(),
    facts: facts({ terminalHasBlockingTurn: true })
  });
  assert.equal(blocking.commands.send, false);
  assert.equal(blocking.commands.new_thread, false);
  assert.equal(blocking.commands.list_resumable_threads, true);
  assert.equal(blocking.commands.native_inspect, false);
  assert.equal(blocking.commands.watch, true);
  assert.equal(blocking.terminalUserExplicitSend.eligible, true);
  assert.equal(blocking.modelControl.availability, "unavailable");

  const orphaned = decideTerminalListActions({
    subject: subject(),
    facts: facts({ hasOrphanedDispatch: true })
  });
  assert.equal(orphaned.commands.close, true);
  assert.equal(orphaned.commands.native_inspect, false);
  assert.equal(orphaned.modelControl.availability, "unavailable");
});

test("busy and approval states suppress input actions but retain user-priority Send", () => {
  const working = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      state: { activity_state: "working", screen_state: "working" }
    })
  });
  assert.equal(working.commands.send, false);
  assert.equal(working.commands.new_thread, false);
  assert.equal(working.commands.native_inspect, false);
  assert.equal(working.commands.watch, true);
  assert.equal(working.terminalUserExplicitSend.eligible, true);

  const approval = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      state: {
        approval_state: {
          scanned: true,
          blocked: true,
          approvable: true,
          reason: "fixture approval"
        }
      }
    })
  });
  assert.equal(approval.commands.send, false);
  assert.equal(approval.commands.new_thread, false);
  assert.equal(approval.commands.native_inspect, false);
  assert.equal(approval.terminalUserExplicitSend.eligible, false);
  assert.equal(approval.modelControl.availability, "unavailable");
});

test("transport and Composer boundaries preserve user-explicit Send policy", () => {
  const noTransport = decideTerminalListActions({
    subject: subject({
      terminalControl: { ...control, capabilities: ["screen_status"] }
    }),
    facts: facts()
  });
  assert.equal(noTransport.commands.watch, true);
  assert.equal(noTransport.commands.native_inspect, false);
  assert.equal(noTransport.terminalUserExplicitSend.eligible, false);
  assert.deepEqual(noTransport.modelControl, {
    availability: "unavailable",
    reason: "transport_unavailable"
  });

  const codexUnknownComposer = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      automatedInputComposerReady: false,
      userExplicitComposerReady: false
    })
  });
  assert.equal(codexUnknownComposer.terminalUserExplicitSend.eligible, true);
  assert.equal(codexUnknownComposer.commands.native_inspect, false);
  assert.equal(codexUnknownComposer.commands.new_thread, false);
  assert.deepEqual(codexUnknownComposer.modelControl, {
    availability: "unavailable",
    reason: "surface_unavailable"
  });

  const claudeUnknownComposer = decideTerminalListActions({
    subject: subject({
      agent: "claude",
      terminalControl: { ...control, currentCommand: "claude" }
    }),
    facts: facts({
      automatedInputComposerReady: false,
      userExplicitComposerReady: false
    })
  });
  assert.equal(claudeUnknownComposer.terminalUserExplicitSend.eligible, true);
  assert.equal(claudeUnknownComposer.commands.native_inspect, false);
  assert.equal(claudeUnknownComposer.commands.new_thread, false);
});

test("diagnostic sparkle idle never grants exact-empty input actions", () => {
  const decision = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      state: {
        activity_state: "idle",
        screen_state: "idle",
        durable_activity_state: "idle"
      },
      automatedInputComposerReady: false,
      userExplicitComposerReady: true
    })
  });

  assert.equal(decision.commands.status, true);
  assert.equal(decision.commands.watch, true);
  assert.equal(decision.terminalUserExplicitSend.eligible, true);
  assert.equal(decision.commands.native_inspect, false);
  assert.equal(decision.commands.new_thread, false);
  assert.equal(decision.commands.identify_foreground, false);
  assert.equal(decision.commands.identify_and_send, false);
  assert.deepEqual(decision.modelControl, {
    availability: "unavailable",
    reason: "surface_unavailable"
  });
});

test("durable idle never upgrades an unknown screen to input authority", () => {
  const decision = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      state: {
        activity_state: "unknown",
        screen_state: "unknown",
        durable_activity_state: "idle"
      },
      automatedInputComposerReady: false,
      userExplicitComposerReady: true
    })
  });

  assert.equal(decision.commands.status, true);
  assert.equal(decision.commands.watch, true);
  assert.equal(decision.terminalUserExplicitSend.eligible, true);
  assert.equal(decision.commands.native_inspect, false);
  assert.equal(decision.commands.new_thread, false);
  assert.equal(decision.modelControl.availability, "unavailable");
});

test("residual policy distinguishes continuation from cleanup without authority", () => {
  const continuation = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      residual: {
        state: "recoverable",
        kind: "bare_command",
        fingerprint: "a".repeat(64),
        terminalControl: control
      }
    })
  });
  assert.deepEqual(continuation.modelControl, {
    availability: "residual_continuation",
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42"
  });

  const repair = decideTerminalListActions({
    subject: subject(),
    facts: facts({
      state: { activity_state: "unknown" },
      residual: {
        state: "recoverable",
        kind: "model_surface",
        fingerprint: "b".repeat(64),
        terminalControl: control
      }
    })
  });
  assert.deepEqual(repair.modelControl, {
    availability: "repair_only",
    terminalId: "terminal:v2:herdr:codex:default:w1:p4:42"
  });
  assert.equal(
    repair.terminalUserExplicitSend.eligible,
    false,
    "an open model picker owns input and must not advertise Send"
  );
});

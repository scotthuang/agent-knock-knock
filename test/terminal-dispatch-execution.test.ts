import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createConversation, type Conversation } from "../src/protocol.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { TerminalInputNotStartedError } from
  "../src/terminal-agent-bridge.js";
import type { TerminalNativeIdentity } from
  "../src/terminal-binding-authority.js";
import {
  TerminalDispatchExecutionService,
  type TerminalDispatchExecutionPorts
} from "../src/terminal-dispatch-execution.js";
import {
  fingerprint,
  type CodexCandidateSetRolloutAcceptanceAnchor,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence
} from "../src/terminal-submission-facts.js";

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_TEXT = "Inspect the exact dispatch boundary.\n";
const REQUEST_HASH = sha256(REQUEST_TEXT);
const TERMINAL_CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "%7",
  socketPath: "/tmp/tmux.sock",
  session: "akk",
  window: 1,
  pane: 2,
  panePid: 5102,
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};
const IDENTITY: TerminalNativeIdentity = {
  sessionId: THREAD_ID,
  processUuid: "process-a",
  processBirth: "birth-a",
  rollout: {
    fd: "8",
    device: "1",
    inode: "42",
    path: "/tmp/rollout-a.jsonl"
  },
  evidence: "test_exact_identity"
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundAnchor(): CodexRolloutAcceptanceAnchor {
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 1 as const,
    mode: "pre_materialization" as const,
    native_thread_id: THREAD_ID,
    process_uuid: "process-a",
    process_birth: "birth-a",
    captured_at: "2026-08-15T01:00:00.000Z",
    file_existed: false,
    offset_bytes: 0,
    expected_empty_native_session: true as const
  };
  return { ...base, anchor_fingerprint: fingerprint(base) };
}

function candidateAnchor(): CodexCandidateSetRolloutAcceptanceAnchor {
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 3 as const,
    mode: "candidate_set" as const,
    native_thread_binding: "post_submission" as const,
    process_uuid: "process-a",
    process_birth: "birth-a",
    captured_at: "2026-08-15T01:00:00.000Z",
    file_existed: false as const,
    offset_bytes: 0 as const,
    zero_file_baseline: true,
    inventory_pid: 5102,
    inventory_cwd: "/workspace",
    inventory_fingerprint: "a".repeat(64),
    candidate_rollouts: []
  };
  return { ...base, anchor_fingerprint: fingerprint(base) };
}

function evidence(
  source: TerminalSubmissionAcceptanceEvidence["source"] = "codex_rollout"
): TerminalSubmissionAcceptanceEvidence {
  const base = {
    source,
    kind: "native_user_turn" as const,
    nativeThreadId: THREAD_ID,
    requestHash: REQUEST_HASH,
    acceptanceId: "acceptance-a",
    acceptedAt: "2026-08-15T01:00:01.000Z",
    anchorFingerprint: "b".repeat(64)
  };
  return { ...base, evidenceFingerprint: fingerprint(base) };
}

function conversation(
  executorKind: "codex" | "claude" = "codex",
  anchor: CodexRolloutAcceptanceAnchor = boundAnchor()
): Conversation {
  const created = createConversation({
    userRequest: "Inspect dispatch",
    sessionId: "session-a",
    turnId: "turn-a",
    executorKind,
    now: new Date("2026-08-15T00:59:00.000Z")
  });
  return {
    ...created,
    status: "waiting_for_agent",
    native_thread_id: THREAD_ID,
    state_path: "/store-a/conversations/turn-a/state.json",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-a",
      terminal_bridge_request_text: REQUEST_TEXT,
      terminal_bridge_request_hash: REQUEST_HASH,
      terminal_agent_pid: 5102,
      terminal_agent_identity_protocol: 1,
      terminal_agent_session_id: THREAD_ID,
      terminal_agent_process_uuid: "process-a",
      terminal_agent_process_birth: "birth-a",
      terminal_agent_rollout: IDENTITY.rollout,
      codex_rollout_acceptance_anchor: anchor
    }
  };
}

interface HarnessOverrides {
  resolveCodex?: TerminalDispatchExecutionPorts["native"]["resolveCodex"];
  captureCodex?: TerminalDispatchExecutionPorts["acceptance"]["captureCodex"];
  detectCodexCandidates?:
    TerminalDispatchExecutionPorts["acceptance"]["detectCodexCandidates"];
  detectBoundCodex?:
    TerminalDispatchExecutionPorts["acceptance"]["detectBoundCodex"];
  detectClaude?: TerminalDispatchExecutionPorts["acceptance"]["detectClaude"];
  assertTurnCurrent?:
    TerminalDispatchExecutionPorts["authority"]["assertTurnCurrent"];
  proveExactDraftStillPresent?:
    TerminalDispatchExecutionPorts["terminal"]["proveExactDraftStillPresent"];
}

function harness(overrides: HarnessOverrides = {}) {
  const trace: string[] = [];
  let nowMs = 0;
  const ports: TerminalDispatchExecutionPorts = {
    clock: {
      now: () => new Date("2026-08-15T01:00:00.000Z"),
      nowMs: () => nowMs,
      sleep: async (milliseconds) => {
        trace.push(`sleep:${milliseconds}`);
        nowMs += milliseconds;
      }
    },
    native: {
      resolveCodex: overrides.resolveCodex ?? (async () => {
        trace.push("resolve:codex");
        return IDENTITY;
      }),
      inspectCodexOpenRoots: async () => {
        trace.push("inventory:codex");
        return {
          schema: "agent-knock-knock/codex-open-root-rollout-inventory",
          version: 1,
          status: "verified_absent",
          pid: 5102,
          processUuid: "process-a",
          processBirth: "birth-a",
          cwd: "/workspace",
          roots: [],
          inventoryFingerprint: "a".repeat(64)
        };
      },
      claudeRows: () => [],
      codexProcessIncarnation: () => ({
        processUuid: "process-a",
        processBirth: "birth-a"
      })
    },
    acceptance: {
      captureCodex: overrides.captureCodex ?? (() => {
        trace.push("capture:codex");
        return boundAnchor();
      }),
      detectCodexCandidates: overrides.detectCodexCandidates ?? (() => {
        trace.push("detect:candidates");
        return { status: "pending", inspected_candidates: 0, exact_matches: 0 };
      }),
      detectBoundCodex: overrides.detectBoundCodex ?? (() => {
        trace.push("detect:bound");
        return undefined;
      }),
      detectClaude: overrides.detectClaude ?? (() => {
        trace.push("detect:claude");
        return undefined;
      })
    },
    terminal: {
      proveExactDraftStillPresent:
        overrides.proveExactDraftStillPresent ?? (async () => {
          trace.push("draft:prove");
          return false;
        })
    },
    authority: {
      assertTurnCurrent: overrides.assertTurnCurrent ?? ((_owner, operation) => {
        trace.push(`authority:${operation}`);
      })
    }
  };
  return {
    trace,
    service: new TerminalDispatchExecutionService(undefined, ports)
  };
}

test("preflight owner reads, replay, and stale evidence preserve precedence", () => {
  const { service, trace } = harness();
  assert.equal(service.preflightRequiresOwner(undefined, false), false);
  assert.equal(service.preflightRequiresOwner({ status: "prepared" }, false), false);
  assert.equal(service.preflightRequiresOwner({ status: "submitted" }, false), true);
  assert.equal(service.preflightRequiresOwner({ status: "submitted" }, true), false);

  const owner = conversation();
  const ledger = {
    status: "agent_accepted",
    request_hash: REQUEST_HASH,
    conversation_id: owner.conversation_id,
    message_id: "message-a",
    acceptance_evidence: evidence()
  };
  const common = {
    ledger,
    owner,
    conversation: owner,
    requestHash: REQUEST_HASH,
    requestText: REQUEST_TEXT,
    messageId: "message-a",
    terminalTarget: TERMINAL_CONTROL.target,
    ledgerLifecycle: false,
    statePathMatches: true,
    continuingTurnResponse: false
  };
  const replay = service.evaluatePreflight(common);
  assert.equal(replay.action, "replay");
  assert.equal(replay.action === "replay" && replay.accepted, true);

  const stale = service.evaluatePreflight({
    ...common,
    ledger: { ...ledger, acceptance_evidence: { ...evidence(), requestHash: "c".repeat(64) } }
  });
  assert.equal(stale.action === "replay" && stale.acceptanceInvalid, true);
  assert.throws(
    () => service.evaluatePreflight({ ...common, statePathMatches: false }),
    /still owned by active AKK conversation/u
  );
  assert.deepEqual(trace, []);
});

test("transport hooks preserve boundary order and one Enter stage", async () => {
  const { service, trace } = harness();
  const lifecycle = service.transportLifecycle({
    deferredBinding: {
      verify: async (empty) => { trace.push(`verify:${empty}`); },
      begin: (at) => { trace.push(`begin:${at}`); },
      advance: (stage, at) => { trace.push(`advance:${stage}:${at}`); }
    },
    recordStage: async (stage, at, afterDurable) => {
      trace.push(`durable:${stage}:before:${at}`);
      await afterDurable();
      trace.push(`durable:${stage}:after:${at}`);
    }
  });
  assert.equal(lifecycle.requireExactComposerBeforeEnter, true);
  await lifecycle.beforeText?.();
  await lifecycle.onTransportStage({ stage: "text_injected" });
  await lifecycle.beforeEnter?.();
  await lifecycle.onTransportStage({ stage: "enter_dispatched" });
  assert.equal(trace.filter((item) => item.includes("enter_dispatched:before")).length, 1);
  assert.deepEqual(trace, [
    "verify:true",
    "begin:2026-08-15T01:00:00.000Z",
    "durable:text_injected:before:2026-08-15T01:00:00.000Z",
    "advance:text_injected:2026-08-15T01:00:00.000Z",
    "verify:false",
    "durable:text_injected:after:2026-08-15T01:00:00.000Z",
    "verify:false",
    "durable:enter_dispatched:before:2026-08-15T01:00:00.000Z",
    "advance:enter_dispatched:2026-08-15T01:00:00.000Z",
    "durable:enter_dispatched:after:2026-08-15T01:00:00.000Z"
  ]);
});

test("not-started before text differs from the same error after text", async () => {
  for (const failure of ["before_text", "before_enter"] as const) {
    const { service, trace } = harness();
    let verification = 0;
    const lifecycle = service.transportLifecycle({
      observedHandoff: {
        verify: async () => {
          verification += 1;
          trace.push(`verify:${verification}`);
          if (
            failure === "before_text" && verification === 1 ||
            failure === "before_enter" && verification === 3
          ) {
            throw new TerminalInputNotStartedError(failure);
          }
        }
      },
      recordStage: async (stage, _at, afterDurable) => {
        trace.push(`stage:${stage}`);
        await afterDurable();
      }
    });
    await assert.rejects(async () => {
      await lifecycle.beforeText?.();
      await lifecycle.onTransportStage({ stage: "text_injected" });
      await lifecycle.beforeEnter?.();
      await lifecycle.onTransportStage({ stage: "enter_dispatched" });
    }, TerminalInputNotStartedError);
    assert.equal(trace.includes("stage:enter_dispatched"), false);
    assert.equal(
      trace.includes("stage:text_injected"),
      failure === "before_enter"
    );
  }
});

test("Codex capture and polling observe a late durable ACK in port order", async () => {
  let detections = 0;
  const accepted = evidence();
  const { service, trace } = harness({
    captureCodex(request) {
      trace.push(`capture:${request.mode}`);
      return boundAnchor();
    },
    detectBoundCodex() {
      detections += 1;
      trace.push(`detect:bound:${detections}`);
      return detections === 2 ? accepted : undefined;
    }
  });
  const anchor = service.captureCodexAcceptanceAnchor({
    currentIdentity: IDENTITY,
    needsPostSendNativeBinding: false
  });
  assert.equal(anchor?.version, 1);
  const result = await service.pollAcceptance({
    executor: "codex",
    conversation: conversation("codex", anchor!),
    terminalControl: TERMINAL_CONTROL,
    timeoutMs: 30,
    pollIntervalMs: 10,
    scrollbackLines: 120
  });
  assert.deepEqual(result, { outcome: "agent_accepted", evidence: accepted });
  assert.deepEqual(trace, [
    "capture:existing",
    "authority:monitor",
    "resolve:codex",
    "detect:bound:1",
    "sleep:10",
    "authority:monitor",
    "resolve:codex",
    "detect:bound:2"
  ]);
});

test("persistent Codex pending distinguishes exact draft proof from no proof", async () => {
  for (const fixture of [
    { name: "present", draftPresent: true, outcome: "not_accepted" },
    { name: "not_proven", draftPresent: false, outcome: "pending_acceptance" }
  ] as const) {
    const { service, trace } = harness({
      proveExactDraftStillPresent: async () => {
        trace.push(`draft:${fixture.name}`);
        return fixture.draftPresent;
      }
    });
    const result = await service.pollAcceptance({
      executor: "codex",
      conversation: conversation(),
      terminalControl: TERMINAL_CONTROL,
      timeoutMs: 10,
      pollIntervalMs: 10,
      scrollbackLines: 120
    });
    assert.equal(result.outcome, fixture.outcome, fixture.name);
    assert.deepEqual(trace, [
      "authority:monitor",
      "resolve:codex",
      "detect:bound",
      "sleep:10",
      "authority:monitor",
      "resolve:codex",
      "detect:bound",
      `draft:${fixture.name}`
    ]);
  }
});

test("Codex candidate uncertainty short-circuits polling without draft proof", async () => {
  const anchor = candidateAnchor();
  const { service, trace } = harness({
    detectCodexCandidates() {
      trace.push("detect:candidates:uncertain");
      return {
        status: "uncertain",
        code: "candidate_inventory_changed",
        reason: "candidate inventory changed",
        inspected_candidates: 0,
        exact_matches: 0
      };
    }
  });
  assert.equal(service.captureCodexAcceptanceAnchor({
    needsPostSendNativeBinding: true,
    candidateSetAnchor: anchor
  }), anchor);
  const result = await service.pollAcceptance({
    executor: "codex",
    conversation: conversation("codex", anchor),
    terminalControl: TERMINAL_CONTROL,
    timeoutMs: 30,
    pollIntervalMs: 10,
    scrollbackLines: 120
  });
  assert.equal(result.outcome, "uncertain");
  assert.match(result.outcome === "uncertain" ? result.reason : "", /candidate inventory changed/u);
  assert.deepEqual(trace, [
    "authority:monitor",
    "inventory:codex",
    "detect:candidates:uncertain"
  ]);
});

test("Claude acceptance uses its typed detector and skips Codex ports", async () => {
  const accepted = evidence("claude_transcript");
  const { service, trace } = harness({
    detectClaude() {
      trace.push("detect:claude:accepted");
      return accepted;
    }
  });
  const result = await service.pollAcceptance({
    executor: "claude",
    conversation: conversation("claude"),
    terminalControl: TERMINAL_CONTROL,
    timeoutMs: 30,
    pollIntervalMs: 10,
    scrollbackLines: 120
  });
  assert.deepEqual(result, { outcome: "agent_accepted", evidence: accepted });
  assert.deepEqual(trace, ["authority:monitor", "detect:claude:accepted"]);
});

test("native identity observations distinguish present, absent, and unavailable", async () => {
  const cases = [
    { name: "present", resolve: async () => IDENTITY, status: "resolved" },
    { name: "absent", resolve: async () => undefined, status: "verified_absent" },
    {
      name: "unavailable",
      resolve: async () => { throw new Error("resolver unavailable"); },
      status: "unavailable"
    }
  ] as const;
  for (const fixture of cases) {
    const { service } = harness({ resolveCodex: fixture.resolve });
    const observation = await service.observeCurrentNativeIdentity({
      agent: "codex",
      pid: 5102,
      cwd: "/workspace"
    });
    assert.equal(observation.status, fixture.status, fixture.name);
  }
});

test("Turn authority revalidation precedes identity comparison and detection", async () => {
  const { service, trace } = harness();
  service.assertTurnIdentity({
    conversation: conversation(),
    currentIdentity: IDENTITY,
    operation: "send to"
  });
  assert.throws(() => service.assertTurnIdentity({
    conversation: conversation(),
    currentIdentity: { ...IDENTITY, sessionId: "22222222-2222-4222-8222-222222222222" },
    operation: "send to"
  }), /native agent session identity changed/u);
  await service.detectAcceptance({
    executor: "codex",
    conversation: conversation(),
    terminalControl: TERMINAL_CONTROL
  });
  assert.deepEqual(trace, [
    "authority:send to",
    "authority:send to",
    "authority:monitor",
    "resolve:codex",
    "detect:bound"
  ]);

  const missingHash = conversation();
  delete (missingHash.native_session_takeover as Record<string, unknown>)
    .terminal_bridge_request_hash;
  const before = trace.length;
  await assert.rejects(
    () => service.detectAcceptance({
      executor: "codex",
      conversation: missingHash,
      terminalControl: TERMINAL_CONTROL
    }),
    /request hash is unavailable/u
  );
  assert.equal(trace.length, before);
});

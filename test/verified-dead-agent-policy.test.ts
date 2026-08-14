import test from "node:test";
import assert from "node:assert/strict";
import {
  decideAcceptedTurnDeadAgentStall,
  decideVerifiedDeadAgentCompletion,
  decideVerifiedDeadAgentProcess,
  reconcileVerifiedDeadAgentAuthority,
  selectVerifiedDeadAgentEvent,
  validateStoredVerifiedDeadAgentAuthority,
  validateVerifiedDeadAgentEventAuthority,
  verifiedDeadTerminalAgentProcessEvidenceId,
  type VerifiedDeadAgentAuthorityContext,
  type VerifiedDeadAgentAuthorityDecision,
  type VerifiedDeadTerminalAgentProcessProof
} from "../src/verified-dead-agent-policy.js";
import {
  terminalControlEvidence,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";

function authorityFixture(): {
  proof: VerifiedDeadTerminalAgentProcessProof;
  disposition: Record<string, unknown>;
  context: VerifiedDeadAgentAuthorityContext;
  event: Record<string, unknown>;
} {
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target: "akk:0.1",
    session: "akk",
    window: 0,
    pane: 1,
    panePid: 4200,
    currentPath: "/repo/project",
    capabilities: ["send_keys", "screen_status"]
  };
  const proof: VerifiedDeadTerminalAgentProcessProof = {
    kind: "exact_pid_absent_from_complete_process_inventory",
    agent: "codex",
    pid: 4300,
    process_uuid: "codex-pid:4300:birth:exact",
    process_birth: "exact",
    conversation_id: "turn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    terminal_control: terminalControl,
    terminal_endpoint: terminalControlEvidence(terminalControl),
    binding_id: "binding-1",
    binding_generation: 2,
    message_id: "message-1",
    observed_at: "2026-08-14T03:04:05.000Z"
  };
  const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(proof);
  const disposition = {
    status: "verified_dead",
    proof,
    evidence_id: evidenceId,
    recorded_at: proof.observed_at
  };
  const context: VerifiedDeadAgentAuthorityContext = {
    terminalControl,
    conversation: {
      agent: "codex",
      conversationId: proof.conversation_id,
      sessionId: proof.session_id,
      turnId: proof.turn_id,
      bindingId: proof.binding_id,
      bindingGeneration: proof.binding_generation
    },
    session: {
      status: "bound",
      agent: "codex",
      workspaceMatchesConversation: true,
      binding: {
        terminalControl,
        pid: proof.pid,
        processUuid: proof.process_uuid,
        processBirth: proof.process_birth,
        bindingId: proof.binding_id,
        generation: proof.binding_generation
      }
    },
    takeover: {
      pid: proof.pid,
      processUuid: proof.process_uuid,
      processBirth: proof.process_birth,
      bindingId: proof.binding_id,
      bindingGeneration: proof.binding_generation,
      messageId: proof.message_id
    },
    submission: {
      status: "agent_accepted",
      sessionId: proof.session_id,
      turnId: proof.turn_id,
      messageId: proof.message_id,
      bindingId: proof.binding_id,
      bindingGeneration: proof.binding_generation
    }
  };
  return {
    proof,
    disposition,
    context,
    event: {
      event: "terminal_agent_process_verified_dead",
      conversation_id: proof.conversation_id,
      ts: proof.observed_at,
      evidence_id: evidenceId,
      proof
    }
  };
}

test("process-death evidence id binds immutable authority but not observation routing", () => {
  const { proof } = authorityFixture();
  const evidenceId = verifiedDeadTerminalAgentProcessEvidenceId(proof);
  assert.match(evidenceId, /^[a-f0-9]{64}$/u);
  assert.equal(
    verifiedDeadTerminalAgentProcessEvidenceId({
      ...proof,
      observed_at: "2027-01-01T00:00:00.000Z",
      terminal_control: {
        ...proof.terminal_control,
        currentPath: "/a/new/route"
      }
    }),
    evidenceId
  );
  assert.notEqual(
    verifiedDeadTerminalAgentProcessEvidenceId({
      ...proof,
      binding_generation: proof.binding_generation + 1
    }),
    evidenceId
  );
});

test("stored process-death authority fails closed on every mutable binding class", () => {
  const fixture = authorityFixture();
  assert.deepEqual(validateStoredVerifiedDeadAgentAuthority({
    disposition: {},
    context: fixture.context
  }), { status: "absent" });
  assert.equal(validateStoredVerifiedDeadAgentAuthority({
    disposition: fixture.disposition,
    context: fixture.context
  }).status, "valid");

  const invalidCases: Array<[string, () => {
    disposition: unknown;
    context: VerifiedDeadAgentAuthorityContext;
  }]> = [
    ["missing proof", () => ({
      disposition: { ...fixture.disposition, proof: undefined },
      context: fixture.context
    })],
    ["missing Session", () => ({
      disposition: fixture.disposition,
      context: { ...fixture.context, session: undefined }
    })],
    ["workspace mismatch", () => ({
      disposition: fixture.disposition,
      context: {
        ...fixture.context,
        session: { ...fixture.context.session!, workspaceMatchesConversation: false }
      }
    })],
    ["process incarnation mismatch", () => ({
      disposition: fixture.disposition,
      context: {
        ...fixture.context,
        takeover: { ...fixture.context.takeover!, processUuid: "reused-pid" }
      }
    })],
    ["submission mismatch", () => ({
      disposition: fixture.disposition,
      context: {
        ...fixture.context,
        submission: { ...fixture.context.submission!, status: "prepared" }
      }
    })],
    ["recorded timestamp mismatch", () => ({
      disposition: {
        ...fixture.disposition,
        recorded_at: "2026-08-14T03:04:06.000Z"
      },
      context: fixture.context
    })],
    ["evidence id mismatch", () => ({
      disposition: { ...fixture.disposition, evidence_id: "0".repeat(64) },
      context: fixture.context
    })]
  ];
  for (const [name, createInput] of invalidCases) {
    const decision = validateStoredVerifiedDeadAgentAuthority(createInput());
    assert.equal(decision.status, "invalid", name);
    assert.match(
      decision.status === "invalid" ? decision.reason : "",
      /no longer matches the exact Turn, Session, terminal, or submission binding/u,
      name
    );
  }
});

test("append-only process-death event selection and reconciliation are exact", () => {
  const fixture = authorityFixture();
  assert.deepEqual(selectVerifiedDeadAgentEvent({
    events: [],
    conversationId: fixture.proof.conversation_id
  }), { status: "absent" });
  assert.deepEqual(selectVerifiedDeadAgentEvent({
    events: [fixture.event, fixture.event],
    conversationId: fixture.proof.conversation_id
  }), {
    status: "invalid",
    reason: "the process-death event history is ambiguous"
  });
  assert.deepEqual(selectVerifiedDeadAgentEvent({
    events: [{ ...fixture.event, evidence_id: "bad" }],
    conversationId: fixture.proof.conversation_id
  }), {
    status: "invalid",
    reason: "the process-death event proof is malformed"
  });

  const candidate = selectVerifiedDeadAgentEvent({
    events: [fixture.event],
    conversationId: fixture.proof.conversation_id
  });
  assert.equal(candidate.status, "candidate");
  assert.ok(candidate.status === "candidate");
  const eventAuthority = validateVerifiedDeadAgentEventAuthority({
    candidate,
    context: fixture.context
  });
  const storedAuthority = validateStoredVerifiedDeadAgentAuthority({
    disposition: fixture.disposition,
    context: fixture.context
  });
  assert.equal(eventAuthority.status, "valid");
  assert.deepEqual(reconcileVerifiedDeadAgentAuthority({
    stored: storedAuthority,
    event: eventAuthority
  }), storedAuthority);
  assert.deepEqual(reconcileVerifiedDeadAgentAuthority({
    stored: { status: "absent" },
    event: eventAuthority
  }), eventAuthority);
  assert.deepEqual(reconcileVerifiedDeadAgentAuthority({
    stored: storedAuthority,
    event: { status: "absent" }
  }), {
    status: "invalid",
    reason:
      "the persisted process-death disposition has no exact append-only event"
  });
});

test("managed close and reconciliation share one persisted-or-observed process decision", () => {
  const { proof } = authorityFixture();
  const valid: VerifiedDeadAgentAuthorityDecision = {
    status: "valid",
    proof,
    evidenceId: verifiedDeadTerminalAgentProcessEvidenceId(proof),
    recordedAt: proof.observed_at
  };
  const cases: Array<[string, Parameters<typeof decideVerifiedDeadAgentProcess>[0], unknown]> = [
    ["persisted", { persistedAuthority: valid }, {
      status: "verified_dead",
      proof,
      source: "persisted"
    }],
    ["absent", { persistedAuthority: { status: "absent" } }, {
      status: "absent"
    }],
    ["alive", {
      persistedAuthority: { status: "absent" },
      observation: { status: "alive", pid: proof.pid }
    }, { status: "alive", pid: proof.pid }],
    ["unverifiable", {
      persistedAuthority: { status: "absent" },
      observation: { status: "unverifiable", reason: "inventory incomplete" }
    }, { status: "unverifiable", reason: "inventory incomplete" }],
    ["fresh proof", {
      persistedAuthority: { status: "absent" },
      observation: { status: "verified_dead", proof }
    }, { status: "verified_dead", proof, source: "observation" }],
    ["invalid persisted proof wins", {
      persistedAuthority: { status: "invalid", reason: "bad evidence" },
      observation: { status: "verified_dead", proof }
    }, { status: "invalid", reason: "bad evidence" }]
  ];
  for (const [name, input, expected] of cases) {
    assert.deepEqual(decideVerifiedDeadAgentProcess(input), expected, name);
  }
});

test("accepted Turn stall applicability requires exact acceptance and resolved transfer", () => {
  const accepted = {
    conversationStatus: "waiting_for_agent",
    terminalBridge: true,
    messageId: "message-1",
    submissionStatus: "agent_accepted",
    submissionMessageId: "message-1"
  };
  assert.deepEqual(decideAcceptedTurnDeadAgentStall(accepted), {
    status: "applicable"
  });
  for (const input of [
    { ...accepted, conversationStatus: "stalled" },
    { ...accepted, terminalBridge: false },
    { ...accepted, submissionStatus: "enter_dispatched" },
    { ...accepted, submissionMessageId: "another-message" }
  ]) {
    assert.deepEqual(decideAcceptedTurnDeadAgentStall(input), {
      status: "not_applicable"
    });
  }
  assert.deepEqual(decideAcceptedTurnDeadAgentStall({
    ...accepted,
    deferredTransferId: "transfer-1"
  }), {
    status: "requires_deferred_transfer",
    transferId: "transfer-1"
  });
  assert.deepEqual(decideAcceptedTurnDeadAgentStall({
    ...accepted,
    deferredTransferId: "transfer-1",
    deferredTransferStatus: "resolved"
  }), { status: "applicable" });
  assert.deepEqual(decideAcceptedTurnDeadAgentStall({
    ...accepted,
    deferredTransferId: "transfer-1",
    deferredTransferStatus: "prepared"
  }), { status: "not_applicable" });
});

test("durable completion reducer preserves the recovery table", () => {
  assert.deepEqual(decideVerifiedDeadAgentCompletion({
    status: "present",
    completion: { output: "done" }
  }), {
    action: "complete",
    completion: { output: "done" }
  });
  assert.deepEqual(decideVerifiedDeadAgentCompletion({ status: "absent" }), {
    action: "stall",
    completionObservation: "absent",
    resultReason: "bound_agent_process_verified_dead"
  });
  assert.deepEqual(decideVerifiedDeadAgentCompletion({
    status: "unverifiable",
    reason: "transcript unavailable"
  }), {
    action: "stall",
    completionObservation: "unverifiable",
    resultReason:
      "bound_agent_process_verified_dead_completion_unverifiable"
  });
});

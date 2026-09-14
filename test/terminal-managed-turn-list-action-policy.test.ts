import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  decideManagedTurnListActions,
  type ManagedTurnListActionFacts
} from "../src/terminal-managed-turn-list-action-policy.js";

function facts(
  overrides: Partial<ManagedTurnListActionFacts> = {}
): ManagedTurnListActionFacts {
  return {
    status: "waiting_for_openclaw",
    agent: "codex",
    terminalBridgeAdvertised: true,
    terminalBridgeReady: true,
    managedApprovalPending: false,
    renewEligible: false,
    retryCallbackEligible: false,
    retrySubmissionCandidate: false,
    approvalState: {
      blocked: false,
      approvable: false
    },
    ...overrides
  };
}

test("managed Turn action policy has no Store, terminal, authority, or presentation edge", () => {
  const source = fs.readFileSync(
    "src/terminal-managed-turn-list-action-policy.ts",
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /from "\.\/(?:store|session-store|terminal-list-renderer)\.js"/u
  );
  assert.doesNotMatch(
    source,
    /\b(?:captureScreen|sendKeys|sendText|BindingToken|available_actions)\b/u
  );
});

test("waiting managed Turn decides response, approval choices, cancel, and close once", () => {
  const decision = decideManagedTurnListActions(facts({
    retryCallbackEligible: true,
    approvalState: {
      blocked: false,
      approvable: true,
      fingerprint: "approval-fingerprint",
      choices: [
        { decision: "approve_once", label: "Yes" },
        { decision: "reject", label: "No" },
        { decision: "always", label: "Never expose" }
      ]
    }
  }));

  assert.equal(decision.respond, true);
  assert.deepEqual(decision.approval, {
    available: true,
    choices: [
      { decision: "approve_once", label: "Yes" },
      { decision: "reject", label: "No" }
    ]
  });
  assert.equal(decision.cancel, true);
  assert.equal(decision.retryCallback, true);
  assert.equal(decision.close.available, true);
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.approval));
});

test("managed approval reservation blocks response and cancel until the prompt is actionable", () => {
  const decision = decideManagedTurnListActions(facts({
    status: "waiting_for_agent",
    managedApprovalPending: true,
    approvalState: { blocked: true, approvable: false }
  }));

  assert.equal(decision.respond, false);
  assert.equal(decision.approval.available, false);
  assert.equal(decision.cancel, false);
  assert.equal(decision.close.available, true);
});

test("stalled Codex recovery decisions preserve retry and close authority fields", () => {
  const decision = decideManagedTurnListActions(facts({
    status: "stalled",
    renewEligible: true,
    retryCallbackEligible: true,
    retrySubmissionCandidate: true,
    orphanedTerminalDispatch: {
      message_id: " message-1 ",
      transition_id: " transition-1 "
    }
  }));

  assert.equal(decision.respond, false);
  assert.equal(decision.renew, true);
  assert.equal(decision.retryCallback, true);
  assert.equal(decision.retrySubmission, true);
  assert.deepEqual(decision.close, {
    available: true,
    expectedMessageId: " message-1 ",
    expectedTransitionId: " transition-1 "
  });
});

test("agent, bridge, fingerprint, decision mode, and final status reject unsafe actions", () => {
  const claudeWrongMode = decideManagedTurnListActions(facts({
    agent: "claude",
    retrySubmissionCandidate: true,
    approvalState: {
      blocked: false,
      approvable: true,
      fingerprint: "approval-fingerprint",
      decision_mode: "transcript"
    }
  }));
  assert.equal(claudeWrongMode.approval.available, false);
  assert.equal(claudeWrongMode.retrySubmission, false);

  const noAdvertisedBridge = decideManagedTurnListActions(facts({
    terminalBridgeAdvertised: false,
    approvalState: {
      blocked: false,
      approvable: true,
      fingerprint: "approval-fingerprint"
    }
  }));
  assert.equal(noAdvertisedBridge.approval.available, false);

  const closed = decideManagedTurnListActions(facts({ status: "closed" }));
  assert.equal(closed.respond, false);
  assert.equal(closed.cancel, false);
  assert.equal(closed.close.available, false);
});

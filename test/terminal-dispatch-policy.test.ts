import test from "node:test";
import assert from "node:assert/strict";
import {
  decideTerminalDispatchPreflight,
  decideTerminalDispatchReplayAcceptance,
  terminalDispatchPreflightRequiresOwner,
  type TerminalDispatchLedgerFacts,
  type TerminalDispatchOwnerFacts
} from "../src/terminal-dispatch-policy.js";

const ordinary = (
  status?: string
): TerminalDispatchLedgerFacts => ({
  status,
  lifecycle: false,
  transitionId: undefined,
  ownerConversationId: "turn-owner"
});

const activeOwner = (
  overrides: Partial<TerminalDispatchOwnerFacts> = {}
): TerminalDispatchOwnerFacts => ({
  conversationId: "turn-owner",
  status: "waiting_for_agent",
  released: false,
  continuingSameTurn: false,
  exactReplay: false,
  ...overrides
});

test("owner reads remain lazy behind lifecycle and receipt-status precedence", () => {
  const cases: Array<{
    name: string;
    ledger: TerminalDispatchLedgerFacts;
    expected: boolean;
  }> = [
    { name: "no ledger", ledger: ordinary(), expected: false },
    { name: "resolved ordinary", ledger: ordinary("resolved"), expected: false },
    {
      name: "resolved lifecycle",
      ledger: { ...ordinary("resolved"), lifecycle: true },
      expected: false
    },
    { name: "prepared ordinary", ledger: ordinary("prepared"), expected: false },
    { name: "submitted ordinary", ledger: ordinary("submitted"), expected: true },
    {
      name: "enter dispatched ordinary",
      ledger: ordinary("enter_dispatched"),
      expected: true
    },
    {
      name: "accepted ordinary",
      ledger: ordinary("agent_accepted"),
      expected: true
    },
    {
      name: "submitted lifecycle",
      ledger: {
        ...ordinary("submitted"),
        lifecycle: true,
        transitionId: "transition-1"
      },
      expected: false
    }
  ];

  for (const fixture of cases) {
    assert.equal(
      terminalDispatchPreflightRequiresOwner(fixture.ledger),
      fixture.expected,
      fixture.name
    );
  }
});

test("lifecycle rejection wins before every ordinary dispatch decision", () => {
  for (const status of [
    "prepared",
    "submitted",
    "enter_dispatched",
    "agent_accepted"
  ]) {
    assert.deepEqual(decideTerminalDispatchPreflight({
      ledger: {
        ...ordinary(status),
        lifecycle: true,
        transitionId: "transition-1"
      },
      owner: activeOwner({ exactReplay: true })
    }), {
      action: "reject",
      reason: "unresolved_lifecycle",
      status,
      transitionId: "transition-1"
    }, status);
  }
});

test("terminal-level unresolved statuses reject without owner facts", () => {
  for (const status of [
    "prepared",
    "text_injected",
    "dispatching",
    "uncertain",
    "not_accepted"
  ]) {
    assert.deepEqual(decideTerminalDispatchPreflight({
      ledger: ordinary(status)
    }), {
      action: "reject",
      reason: "terminal_level_dispatch",
      status,
      ownerConversationId: "turn-owner"
    }, status);
  }
});

test("active receipt statuses require an available owner", () => {
  for (const status of [
    "submitted",
    "enter_dispatched",
    "agent_accepted"
  ]) {
    assert.deepEqual(decideTerminalDispatchPreflight({
      ledger: ordinary(status)
    }), {
      action: "reject",
      reason: "owner_unavailable",
      status
    }, status);
  }
});

test("released and same-turn owners proceed before replay matching", () => {
  assert.deepEqual(decideTerminalDispatchPreflight({
    ledger: ordinary("submitted"),
    owner: activeOwner({ released: true, exactReplay: true })
  }), {
    action: "proceed",
    basis: "released_owner"
  });
  assert.deepEqual(decideTerminalDispatchPreflight({
    ledger: ordinary("submitted"),
    owner: activeOwner({ continuingSameTurn: true, exactReplay: true })
  }), {
    action: "proceed",
    basis: "continuing_same_turn"
  });
});

test("exact active requests replay at the ledger proof level", () => {
  for (const proofLevel of [
    "submitted",
    "enter_dispatched",
    "agent_accepted"
  ] as const) {
    assert.deepEqual(decideTerminalDispatchPreflight({
      ledger: ordinary(proofLevel),
      owner: activeOwner({ exactReplay: true })
    }), {
      action: "replay",
      proofLevel
    }, proofLevel);
  }
});

test("a different request remains fenced by its active owner", () => {
  assert.deepEqual(decideTerminalDispatchPreflight({
    ledger: ordinary("submitted"),
    owner: activeOwner()
  }), {
    action: "reject",
    reason: "active_owner",
    status: "submitted",
    ownerConversationId: "turn-owner",
    ownerStatus: "waiting_for_agent"
  });
});

test("resolved, aborted and unknown ledger statuses do not block dispatch", () => {
  for (const status of [undefined, "resolved", "aborted", "verified", "future"]) {
    assert.deepEqual(decideTerminalDispatchPreflight({
      ledger: ordinary(status),
      owner: activeOwner()
    }), {
      action: "proceed",
      basis: "no_blocking_dispatch"
    }, String(status));
  }
});

test("replay acceptance preserves delivered and invalid facts independently", () => {
  const cases = [
    {
      delivered: true,
      submissionOutcome: "agent_accepted",
      expected: { accepted: true, invalid: false }
    },
    {
      delivered: false,
      submissionOutcome: "pending_acceptance",
      expected: { accepted: false, invalid: false }
    },
    {
      delivered: false,
      submissionOutcome: "uncertain",
      expected: { accepted: false, invalid: true }
    },
    {
      delivered: true,
      submissionOutcome: "uncertain",
      expected: { accepted: true, invalid: true }
    }
  ];

  for (const fixture of cases) {
    assert.deepEqual(
      decideTerminalDispatchReplayAcceptance(fixture),
      fixture.expected
    );
  }
});

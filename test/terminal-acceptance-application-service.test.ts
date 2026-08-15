import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalAcceptanceApplicationService,
  type TerminalAcceptanceApplicationPorts,
  type TerminalAcceptanceTurnFacts
} from "../src/terminal-acceptance-application-service.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "../src/terminal-submission-facts.js";

interface Turn {
  id: string;
  facts: TerminalAcceptanceTurnFacts;
}

const EVIDENCE: TerminalSubmissionAcceptanceEvidence = {
  source: "codex_rollout",
  kind: "native_user_turn",
  nativeThreadId: "00000000-0000-4000-8000-000000000001",
  requestHash: "a".repeat(64),
  acceptanceId: "acceptance-1",
  anchorFingerprint: "b".repeat(64),
  evidenceFingerprint: "c".repeat(64)
};

function turn(overrides: Partial<TerminalAcceptanceTurnFacts> = {}): Turn {
  return {
    id: "turn-1",
    facts: {
      turnStatus: "waiting_for_agent",
      messageId: "msg-1",
      submissionStatus: "enter_dispatched",
      requestText: "implement the change",
      enterDispatchedAtMs: 1_000,
      codexAnchorVersion: 2,
      ...overrides
    }
  };
}

test("virgin acceptance closes binding before the second detector and commit", async () => {
  const events: string[] = [];
  let recoveries = 0;
  const ports: TerminalAcceptanceApplicationPorts<Turn> = {
    clock: { nowMs: () => 2_000 },
    binding: {
      recover: async (current) => {
        recoveries += 1;
        events.push(`recover:${recoveries}`);
        return {
          turn: current,
          state: recoveries === 1 ? "pending" : "recovered"
        };
      }
    },
    acceptance: {
      detect: async () => {
        events.push("detect");
        return EVIDENCE;
      }
    },
    terminal: {
      proveExactDraftStillPresent: async () => {
        throw new Error("accepted input must not inspect the composer");
      }
    },
    repository: {
      commit: async ({ turn: current, expected, resolution }) => {
        events.push(`commit:${resolution.outcome}`);
        assert.equal(expected.messageId, "msg-1");
        assert.deepEqual(resolution, {
          outcome: "agent_accepted",
          evidence: EVIDENCE
        });
        return current;
      }
    }
  };
  const result = await new TerminalAcceptanceApplicationService(ports)
    .reconcile({ executor: "codex", turn: turn(), project: (item) => item.facts });
  assert.deepEqual(events, [
    "recover:1",
    "detect",
    "recover:2",
    "detect",
    "commit:agent_accepted"
  ]);
  assert.equal(result.outcome, "accepted");
});

test("possible input remains pending and never becomes a replayable abort", async () => {
  const events: string[] = [];
  const current = turn({ codexAnchorVersion: 1 });
  const service = new TerminalAcceptanceApplicationService<Turn>({
    clock: { nowMs: () => 2_000 },
    binding: {
      recover: async (value) => {
        events.push("recover");
        return { turn: value, state: "not_applicable" };
      }
    },
    acceptance: {
      detect: async () => {
        events.push("detect");
        return undefined;
      }
    },
    terminal: {
      proveExactDraftStillPresent: async () => {
        events.push("draft:false");
        return false;
      }
    },
    repository: {
      commit: async () => {
        throw new Error("pending possible input must not commit or replay");
      }
    }
  });
  assert.deepEqual(
    await service.reconcile({
      executor: "codex",
      turn: current,
      project: (item) => item.facts
    }),
    { outcome: "pending" }
  );
  assert.deepEqual(events, ["recover", "detect", "draft:false"]);
});

test("only exact persisted draft proof commits not_accepted", async () => {
  const events: string[] = [];
  const current = turn({ codexAnchorVersion: 1 });
  const service = new TerminalAcceptanceApplicationService<Turn>({
    clock: { nowMs: () => 2_000 },
    binding: {
      recover: async (value) => ({ turn: value, state: "not_applicable" })
    },
    acceptance: { detect: async () => undefined },
    terminal: {
      proveExactDraftStillPresent: async (_turn, requestText) => {
        events.push(`draft:${requestText}`);
        return true;
      }
    },
    repository: {
      commit: async ({ turn: value, resolution }) => {
        events.push(`commit:${resolution.outcome}`);
        assert.deepEqual(resolution, {
          outcome: "not_accepted",
          reason: "the exact managed draft remains in the terminal composer"
        });
        return value;
      }
    }
  });
  const result = await service.reconcile({
    executor: "codex",
    turn: current,
    project: (item) => item.facts
  });
  assert.equal(result.outcome, "not_accepted");
  assert.deepEqual(events, [
    "draft:implement the change",
    "commit:not_accepted"
  ]);
});

test("detector and binding errors retain priority over message validation", async () => {
  const current = turn({ messageId: undefined });
  const service = new TerminalAcceptanceApplicationService<Turn>({
    clock: { nowMs: () => 2_000 },
    binding: {
      recover: async (value) => ({ turn: value, state: "not_applicable" })
    },
    acceptance: {
      detect: async () => {
        throw new Error("detector failed first");
      }
    },
    terminal: { proveExactDraftStillPresent: async () => false },
    repository: { commit: async ({ turn: value }) => value }
  });
  await assert.rejects(
    service.reconcile({
      executor: "codex",
      turn: current,
      project: (item) => item.facts
    }),
    /detector failed first/u
  );
});

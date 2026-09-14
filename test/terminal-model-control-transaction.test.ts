import assert from "node:assert/strict";
import test from "node:test";

import {
  decideTerminalModelControlFailure,
  reduceTerminalModelControlTransactionPhase
} from "../src/terminal-model-control-transaction.js";

test("model-control transaction phase is monotonic across reversible and commit input", () => {
  let phase = reduceTerminalModelControlTransactionPhase(
    "no_input",
    "reversible_input_attempted"
  );
  assert.equal(phase, "reversible_input");
  phase = reduceTerminalModelControlTransactionPhase(
    phase,
    "reversible_input_attempted"
  );
  assert.equal(phase, "reversible_input");
  phase = reduceTerminalModelControlTransactionPhase(phase, "commit_attempted");
  assert.equal(phase, "commit_attempted");
  phase = reduceTerminalModelControlTransactionPhase(
    phase,
    "reversible_input_attempted"
  );
  assert.equal(phase, "commit_attempted");
  phase = reduceTerminalModelControlTransactionPhase(
    phase,
    "postcondition_proven"
  );
  assert.equal(phase, "postcondition_proven");
  assert.throws(
    () => reduceTerminalModelControlTransactionPhase(
      phase,
      "reversible_input_attempted"
    ),
    /cannot accept input after its postcondition/u
  );
});

test("model-control failure policy separates reversible exit from commit uncertainty", () => {
  assert.deepEqual(
    decideTerminalModelControlFailure("no_input", "not_attempted"),
    {
      unwind: false,
      outcome: "throw",
      doNotRetry: false,
      residualRepair: "none"
    }
  );
  assert.deepEqual(
    decideTerminalModelControlFailure("reversible_input", "not_attempted"),
    {
      unwind: true,
      outcome: "throw",
      doNotRetry: false,
      residualRepair: "none"
    }
  );
  assert.deepEqual(
    decideTerminalModelControlFailure("reversible_input", "proven"),
    {
      unwind: false,
      outcome: "throw",
      doNotRetry: false,
      residualRepair: "none"
    }
  );
  assert.deepEqual(
    decideTerminalModelControlFailure("commit_attempted", "proven"),
    {
      unwind: false,
      outcome: "uncertain",
      doNotRetry: true,
      residualRepair: "none"
    }
  );
  assert.deepEqual(
    decideTerminalModelControlFailure("reversible_input", "failed"),
    {
      unwind: false,
      outcome: "uncertain",
      doNotRetry: true,
      residualRepair: "fresh_inspection_required"
    }
  );
});

import test from "node:test";
import assert from "node:assert/strict";
import {
  reduceTerminalZeroInputAbort,
  type TerminalZeroInputAbortBlocker,
  type TerminalZeroInputFailureKind
} from "../src/terminal-dispatch-abort.js";

test("zero-input abort reduction preserves retry and blocker precedence", () => {
  const cases: Array<{
    name: string;
    dispatchLedgerRestored: boolean;
    rawAttachRolledBack: boolean;
    abortedStatePersisted: boolean;
    blocker?: TerminalZeroInputAbortBlocker;
  }> = [
    {
      name: "durable",
      dispatchLedgerRestored: true,
      rawAttachRolledBack: true,
      abortedStatePersisted: true
    },
    {
      name: "ledger restore",
      dispatchLedgerRestored: false,
      rawAttachRolledBack: false,
      abortedStatePersisted: false,
      blocker: "dispatch_ledger_restore"
    },
    {
      name: "raw attach rollback",
      dispatchLedgerRestored: true,
      rawAttachRolledBack: false,
      abortedStatePersisted: false,
      blocker: "raw_attach_rollback"
    },
    {
      name: "state persistence",
      dispatchLedgerRestored: true,
      rawAttachRolledBack: true,
      abortedStatePersisted: false,
      blocker: "aborted_state_persistence"
    }
  ];
  for (const failureKind of ["setup", "transport"] satisfies
    TerminalZeroInputFailureKind[]) {
    for (const current of cases) {
      const outcome = reduceTerminalZeroInputAbort({
        failureKind,
        dispatchLedgerRestored: current.dispatchLedgerRestored,
        rawAttachRolledBack: current.rawAttachRolledBack,
        abortedStatePersisted: current.abortedStatePersisted
      });
      assert.deepEqual(
        outcome,
        current.blocker
          ? {
              failureKind,
              disposition: "inspect",
              safeToRetry: false,
              blocker: current.blocker
            }
          : { failureKind, disposition: "retry", safeToRetry: true },
        `${failureKind}: ${current.name}`
      );
    }
  }
});

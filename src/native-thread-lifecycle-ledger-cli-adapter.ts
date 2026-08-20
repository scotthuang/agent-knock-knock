import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import { nonBlankString } from "./value-guards.js";

export interface NativeThreadLifecycleLedgerRepository {
  load(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  save(terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument): void;
}

export interface NativeThreadLifecycleLedgerAuthority {
  ordinaryOwnerIsReleased(
    ledger: TerminalDispatchLedgerDocument
  ): boolean;
}

export interface NativeThreadLifecycleLedgerExpectation {
  expectedTransitionId: string | null;
  expectedStatus?: string;
}

export interface NativeThreadLifecycleLedgerCliAdapter {
  save(terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument,
    expectation: NativeThreadLifecycleLedgerExpectation): void;
}

/**
 * Own lifecycle-ledger CAS at the CLI persistence boundary. The application
 * supplies already-encoded documents; only this adapter may compare them with
 * the live terminal ledger and write the replacement bytes.
 */
export function createNativeThreadLifecycleLedgerCliAdapter(
  input: Readonly<{
    repository: NativeThreadLifecycleLedgerRepository;
    authority: NativeThreadLifecycleLedgerAuthority;
  }>
): NativeThreadLifecycleLedgerCliAdapter {
  return Object.freeze({
    save(terminalControl, ledger, expectation): void {
      assertLifecycleIdentity(ledger);
      const current = input.repository.load(terminalControl);
      assertExpectedTransition(
        terminalControl,
        current,
        expectation,
        input.authority
      );
      assertExpectedStatus(terminalControl, current, expectation);
      input.repository.save(terminalControl, ledger);
    }
  });
}

function assertLifecycleIdentity(ledger: TerminalDispatchLedgerDocument): void {
  const transitionId = nonBlankString(ledger.transition_id);
  if (
    ledger.kind !== "lifecycle" ||
    !transitionId ||
    nonBlankString(ledger.generation_id) !== transitionId
  ) {
    throw new Error("lifecycle dispatch ledger requires one transition identity");
  }
}

function assertExpectedTransition(terminalControl: TerminalControlRef,
  current: TerminalDispatchLedgerDocument | undefined,
  expectation: NativeThreadLifecycleLedgerExpectation,
  authority: NativeThreadLifecycleLedgerAuthority): void {
  if (expectation.expectedTransitionId === null) {
    if (
      current &&
      current.status !== "resolved" &&
      (
        current.kind === "lifecycle" ||
        !authority.ordinaryOwnerIsReleased(current)
      )
    ) {
      throw new Error(
        `terminal ${terminalControl.target} dispatch generation changed before lifecycle prepare`
      );
    }
    return;
  }
  if (
    current?.kind !== "lifecycle" ||
    nonBlankString(current.transition_id) !== expectation.expectedTransitionId ||
    nonBlankString(current.generation_id) !== expectation.expectedTransitionId
  ) {
    throw new Error(
      `terminal ${terminalControl.target} lifecycle transition identity changed; ` +
      "refresh list before recovery"
    );
  }
}

function assertExpectedStatus(terminalControl: TerminalControlRef,
  current: TerminalDispatchLedgerDocument | undefined,
  expectation: NativeThreadLifecycleLedgerExpectation): void {
  if (
    expectation.expectedStatus !== undefined &&
    String(current?.status) !== expectation.expectedStatus
  ) {
    throw new Error(
      `terminal ${terminalControl.target} lifecycle status changed from ` +
      `${expectation.expectedStatus} to ${String(current?.status)}`
    );
  }
}

import {
  deferredZeroInputChronology,
  type DeferredZeroInputChronology,
  type DeferredZeroInputChronologyFacts
} from "./terminal-handoff-facts.js";

/** Pure use-case decisions; adapters retain terminal and persistence details. */
export class TerminalHandoffApplicationService {
  zeroInputChronology(
    facts: DeferredZeroInputChronologyFacts
  ): DeferredZeroInputChronology {
    return deferredZeroInputChronology(facts);
  }

  authorityChecksPass(checks: readonly (() => boolean)[]): boolean {
    for (const check of checks) if (!check()) return false;
    return true;
  }

  assertAuthority(
    checks: readonly (() => boolean)[],
    message: string
  ): void {
    if (!this.authorityChecksPass(checks)) throw new Error(message);
  }
}

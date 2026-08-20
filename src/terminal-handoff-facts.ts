export interface DeferredZeroInputChronologyFacts {
  inputStage: string;
  dispatchStartedAt?: string;
  inputNotStartedAt?: string;
  dispatchStartedAtMs?: number;
  inputNotStartedAtMs?: number;
}

export interface DeferredZeroInputChronology {
  safe: boolean;
  dispatchIntentProvedNotStarted: boolean;
}

export function deferredZeroInputChronology(
  facts: DeferredZeroInputChronologyFacts
): DeferredZeroInputChronology {
  const abortedBeforeDispatchIntent = facts.inputStage === "none" &&
    facts.dispatchStartedAt === undefined &&
    facts.inputNotStartedAt === undefined;
  const dispatchIntentProvedNotStarted =
    facts.inputStage === "dispatch_started" &&
    facts.dispatchStartedAt !== undefined &&
    facts.inputNotStartedAt !== undefined &&
    Boolean(facts.dispatchStartedAtMs) &&
    Boolean(facts.inputNotStartedAtMs) &&
    Number(facts.inputNotStartedAtMs) >= Number(facts.dispatchStartedAtMs);
  return {
    safe: abortedBeforeDispatchIntent || dispatchIntentProvedNotStarted,
    dispatchIntentProvedNotStarted
  };
}

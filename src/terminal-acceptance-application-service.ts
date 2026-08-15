import type { ExecutorKind } from "./executors.js";
import type { TerminalSubmissionAcceptanceEvidence } from
  "./terminal-submission-facts.js";

export type VirginBindingRecoveryState =
  | "not_applicable"
  | "already_bound"
  | "pending"
  | "recovered";

export interface TerminalAcceptanceTurnFacts {
  turnStatus: string;
  messageId?: string;
  submissionStatus?: string;
  requestText: string;
  enterDispatchedAtMs?: number;
  codexAnchorVersion?: number;
}

export interface TerminalAcceptanceBindingRecovery<Turn> {
  turn: Turn;
  state: VirginBindingRecoveryState;
}

export type TerminalAcceptanceResolution =
  | {
      outcome: "agent_accepted";
      evidence: TerminalSubmissionAcceptanceEvidence;
    }
  | { outcome: "not_accepted"; reason: string };

export interface TerminalAcceptanceApplicationPorts<Turn> {
  clock: {
    nowMs(): number;
  };
  binding: {
    recover(turn: Turn): Promise<TerminalAcceptanceBindingRecovery<Turn>>;
  };
  acceptance: {
    detect(
      executor: ExecutorKind,
      turn: Turn
    ): Promise<TerminalSubmissionAcceptanceEvidence | undefined>;
  };
  terminal: {
    proveExactDraftStillPresent(turn: Turn, requestText: string): Promise<boolean>;
  };
  repository: {
    commit(input: {
      turn: Turn;
      expected: TerminalAcceptanceTurnFacts;
      resolution: TerminalAcceptanceResolution;
    }): Promise<Turn>;
  };
}

export type TerminalAcceptanceApplicationResult<Turn> =
  | { outcome: "accepted"; turn: Turn }
  | { outcome: "pending" }
  | { outcome: "not_accepted"; turn: Turn };

/**
 * Owns the monotonic acceptance polling order while concrete terminal and
 * repository resources remain outside the service boundary.
 */
export class TerminalAcceptanceApplicationService<Turn> {
  readonly #ports: TerminalAcceptanceApplicationPorts<Turn>;

  constructor(ports: TerminalAcceptanceApplicationPorts<Turn>) {
    this.#ports = ports;
  }

  async reconcile(input: {
    executor: ExecutorKind;
    turn: Turn;
    project(turn: Turn): TerminalAcceptanceTurnFacts;
  }): Promise<TerminalAcceptanceApplicationResult<Turn>> {
    let recovery = await this.#ports.binding.recover(input.turn);
    let turn = recovery.turn;
    let evidence = await this.#ports.acceptance.detect(input.executor, turn);
    let facts = input.project(turn);

    if (
      evidence &&
      facts.codexAnchorVersion === 2 &&
      recovery.state === "not_applicable"
    ) {
      throw new Error(
        "virgin Codex acceptance appeared without a recoverable Session/Turn binding"
      );
    }
    if (
      evidence &&
      facts.codexAnchorVersion === 2 &&
      recovery.state === "pending"
    ) {
      recovery = await this.#ports.binding.recover(turn);
      if (
        recovery.state !== "recovered" &&
        recovery.state !== "already_bound"
      ) {
        return { outcome: "pending" };
      }
      turn = recovery.turn;
      evidence = await this.#ports.acceptance.detect(input.executor, turn);
      if (!evidence) {
        return { outcome: "pending" };
      }
      facts = input.project(turn);
    }

    if (!facts.messageId) {
      throw new Error("terminal acceptance monitor lost its exact message identity");
    }
    let notAcceptedReason: string | undefined;
    if (!evidence) {
      const oldEnough = facts.enterDispatchedAtMs !== undefined &&
        this.#ports.clock.nowMs() - facts.enterDispatchedAtMs >= 250;
      if (
        oldEnough &&
        await this.#ports.terminal.proveExactDraftStillPresent(
          turn,
          facts.requestText
        )
      ) {
        notAcceptedReason =
          "the exact managed draft remains in the terminal composer";
      }
      if (!notAcceptedReason) {
        return { outcome: "pending" };
      }
    }

    const committed = await this.#ports.repository.commit({
      turn,
      expected: facts,
      resolution: notAcceptedReason
        ? { outcome: "not_accepted", reason: notAcceptedReason }
        : { outcome: "agent_accepted", evidence: evidence as TerminalSubmissionAcceptanceEvidence }
    });
    return notAcceptedReason
      ? { outcome: "not_accepted", turn: committed }
      : { outcome: "accepted", turn: committed };
  }
}

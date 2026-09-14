import {
  isActiveConversationStatus
} from "./protocol.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export interface ManagedTurnListRuntimeActionFacts {
  readonly terminalBridgeReady: boolean;
  readonly managedApprovalPending: boolean;
  readonly renewEligible: boolean;
  readonly retryCallbackEligible: boolean;
  readonly retrySubmissionCandidate: boolean;
}

export interface ManagedTurnListActionFacts
  extends ManagedTurnListRuntimeActionFacts {
  readonly status: unknown;
  readonly agent: unknown;
  readonly terminalBridgeAdvertised: boolean;
  readonly approvalState?: Readonly<Record<string, unknown>>;
  readonly orphanedTerminalDispatch?: Readonly<Record<string, unknown>>;
}

export interface ManagedTurnApprovalChoiceDecision {
  readonly decision: "approve_once" | "reject";
  readonly label?: string;
}

export type ManagedTurnApprovalActionDecision =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly choices: readonly ManagedTurnApprovalChoiceDecision[];
    };

export type ManagedTurnCloseActionDecision =
  | { readonly available: false }
  | {
      readonly available: true;
      readonly expectedMessageId?: string;
      readonly expectedTransitionId?: string;
    };

export interface ManagedTurnListActionDecision {
  readonly status: true;
  readonly respond: boolean;
  readonly approval: ManagedTurnApprovalActionDecision;
  readonly cancel: boolean;
  readonly renew: boolean;
  readonly retryCallback: boolean;
  readonly retrySubmission: boolean;
  readonly close: ManagedTurnCloseActionDecision;
}

/**
 * Decide managed-Turn action availability from an already-sampled projection.
 * This policy performs no Store/terminal reads, mints no authority, and emits no
 * public JSON. Mutation execution continues to revalidate fresh authority.
 */
export function decideManagedTurnListActions(
  facts: ManagedTurnListActionFacts
): ManagedTurnListActionDecision {
  const approvalState = facts.approvalState ?? {};
  const waitingForOpenClaw = facts.status === "waiting_for_openclaw";
  const approvalEligible =
    facts.terminalBridgeAdvertised &&
    isActiveConversationStatus(facts.status) &&
    facts.terminalBridgeReady &&
    waitingForOpenClaw &&
    (
      facts.agent !== "claude" ||
      approvalState.decision_mode === "keys"
    ) &&
    approvalState.approvable === true &&
    stringValue(approvalState.fingerprint) !== undefined;
  const closeAvailable = facts.status !== "closed";
  const orphanedDispatch = facts.orphanedTerminalDispatch;

  return Object.freeze({
    status: true as const,
    respond:
      waitingForOpenClaw &&
      facts.terminalBridgeReady &&
      !facts.managedApprovalPending &&
      approvalState.blocked !== true,
    approval: approvalEligible
      ? Object.freeze({
          available: true as const,
          choices: managedApprovalChoices(approvalState)
        })
      : Object.freeze({ available: false as const }),
    cancel:
      facts.terminalBridgeReady &&
      ["waiting_for_agent", "waiting_for_openclaw"].includes(
        String(facts.status)
      ) &&
      !(
        facts.managedApprovalPending &&
        approvalState.approvable !== true
      ),
    renew: facts.renewEligible,
    retryCallback: facts.retryCallbackEligible,
    retrySubmission:
      facts.agent === "codex" && facts.retrySubmissionCandidate,
    close: closeAvailable
      ? Object.freeze({
          available: true as const,
          expectedMessageId: stringValue(orphanedDispatch?.message_id),
          expectedTransitionId: stringValue(orphanedDispatch?.transition_id)
        })
      : Object.freeze({ available: false as const })
  });
}

function managedApprovalChoices(
  approvalState: Readonly<Record<string, unknown>>
): readonly ManagedTurnApprovalChoiceDecision[] {
  if (!Array.isArray(approvalState.choices)) {
    return Object.freeze([Object.freeze({
      decision: "approve_once" as const,
      label: stringValue(approvalState.label)
    })]);
  }
  return Object.freeze(approvalState.choices.flatMap((choice) =>
    isRecord(choice) &&
      (choice.decision === "approve_once" || choice.decision === "reject")
      ? [Object.freeze({
          decision: choice.decision,
          label: stringValue(choice.label)
        })]
      : []
  ));
}

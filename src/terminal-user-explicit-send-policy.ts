import type { ExecutorKind } from "./executors.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalEndpointFromControlRef,
  type TerminalControlRef
} from "./terminal-control-ref.js";

export interface TerminalUserExplicitSendFacts {
  readonly exactTerminalRow: boolean;
  readonly terminalId?: string;
  readonly processState?: string;
  readonly terminalControl?: TerminalControlRef;
  readonly agent?: ExecutorKind;
  readonly pid?: number;
  readonly processUuid?: string;
  readonly processBirth?: string;
  readonly approvalScanned: boolean;
  readonly approvalBlocked: boolean;
  readonly interactionActive?: boolean;
  readonly userExplicitComposerReady: boolean;
}

export type TerminalUserExplicitSendEligibility =
  | { readonly eligible: false }
  | {
      readonly eligible: true;
      readonly terminalId: string;
      readonly terminalControl: TerminalControlRef;
      readonly agent: ExecutorKind;
      readonly pid: number;
      readonly workspace: string;
      readonly processUuid: string;
      readonly processBirth: string;
    };

/** Decide physical user-Send eligibility without generating private authority. */
export function decideTerminalUserExplicitSendEligibility(
  facts: TerminalUserExplicitSendFacts
): TerminalUserExplicitSendEligibility {
  const terminalId = nonBlank(facts.terminalId);
  const control = facts.terminalControl;
  const processUuid = nonBlank(facts.processUuid);
  const processBirth = nonBlank(facts.processBirth);
  if (
    !facts.exactTerminalRow ||
    !terminalId ||
    facts.processState !== "active" ||
    !control ||
    !hasCanonicalTerminalEndpoint(control) ||
    !control.capabilities.includes("send_keys") ||
    !control.capabilities.includes("screen_status") ||
    !facts.approvalScanned ||
    facts.approvalBlocked ||
    facts.interactionActive === true ||
    !facts.agent ||
    !Number.isSafeInteger(facts.pid) ||
    Number(facts.pid) <= 1 ||
    !processUuid ||
    !processBirth
  ) {
    return { eligible: false };
  }
  const endpoint = terminalEndpointFromControlRef(control);
  if (
    !Number.isSafeInteger(endpoint.processAnchorPid) ||
    Number(endpoint.processAnchorPid) <= 1
  ) {
    return { eligible: false };
  }
  return {
    eligible: true,
    terminalId,
    terminalControl: control,
    agent: facts.agent,
    pid: Number(facts.pid),
    workspace: control.currentPath ?? "",
    processUuid,
    processBirth
  };
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

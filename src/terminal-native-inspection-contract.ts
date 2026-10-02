import type {
  ExecutorKind
} from "./executors.js";
import type {
  TerminalAgentAdapter,
  TerminalNativeInspectionEvidenceInventoryEntry,
  TerminalNativeInspectionObservation,
  TerminalNativeInspectionPlan,
  TerminalRuntimeIdentity,
  TerminalScreenInspection
} from "./terminal-agent-adapter.js";

import {
  type TerminalControlRef
} from "./terminal-control-ref.js";

export type NativeInspectionSubmissionStage =
  | "not_started"
  | "text_injected"
  | "enter_uncertain";

/** Machine-readable reason for a closed native-inspection submission failure. */
export type NativeInspectionSubmissionDiagnostic =
  | "unsupported_profile"
  | "capability_unavailable"
  | "identity_unverified"
  | "composer_not_ready"
  | "viewport_too_narrow"
  | "viewport_unavailable"
  | "text_delivery_unproven"
  | "composer_viewport_truncated"
  | "composer_not_exact"
  | "composer_drift"
  | "evidence_unproven"
  | "enter_uncertain";

export type TerminalNativeInspectionMaterializationKind =
  | "exact_slash_composer"
  | "exact_slash_popup";

export interface TerminalNativeInspectionMaterializationEvidence {
  kind: TerminalNativeInspectionMaterializationKind;
  digest: string;
  stableForMs: number;
  stableCaptures: number;
}

export interface TerminalNativeInspectionBeforeEnterContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  plan: TerminalNativeInspectionPlan;
  preEnterScreenDigest: string;
  materialization: TerminalNativeInspectionMaterializationEvidence;
}

export interface TerminalNativeInspectionOptions {
  runtime?: TerminalRuntimeIdentity;
  /** Private, in-lock paginated status read; public native inspection stays idle-only. */
  allowWorkingCodexStatus?: true;
  /**
   * Gives the CLI one final in-lock authorization point for its Store binding
   * and action-token fences. The bridge recaptures the exact composer and
   * revalidates terminal identity again after this hook before pressing Enter.
   */
  beforeEnter?: (
    context: TerminalNativeInspectionBeforeEnterContext
  ) => void | Promise<void>;
}

export interface TerminalNativeInspectionResult {
  stage: "enter_dispatched";
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  command: string;
  behaviorProfile: string;
  preEnterScreenDigest: string;
  preEnterEvidenceInventory:
    readonly TerminalNativeInspectionEvidenceInventoryEntry[];
  materialization: TerminalNativeInspectionMaterializationEvidence;
  enterCount: 1;
}

export interface TerminalCodexStatusProbeResult
  extends TerminalNativeInspectionResult {
  agent: "codex";
  /** Identity-fenced ANSI capture proving an empty/dim placeholder composer. */
  preTextScreenDigest: string;
  /**
   * Bare SHA-256 of the final pre-Enter 240-line capture. This deliberately
   * matches `status().screen.digest` when observed with the returned depth.
   */
  observationBaselineDigest: string;
  /** Capture depth required for same-domain post-Enter freshness checks. */
  observationScrollbackLines: 240;
}

export interface TerminalNativeInspectionBeforeDismissContext {
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  plan: TerminalNativeInspectionPlan;
  evidenceFingerprint: string;
}

export interface TerminalNativeInspectionDismissalOptions {
  runtime?: TerminalRuntimeIdentity;
  scrollbackLines?: number;
  beforeDismiss?: (
    context: TerminalNativeInspectionBeforeDismissContext
  ) => void | Promise<void>;
}

export interface TerminalNativeInspectionDismissalResult {
  stage: "dismiss_dispatched";
  agent: ExecutorKind;
  terminalControl: TerminalControlRef;
  keys: readonly string[];
  dismissCount: 1;
}

export interface TerminalNativeInspectionTransportObservationResult<TStatus> {
  terminalControl: TerminalControlRef;
  status: TStatus;
  /** Same raw-screen fingerprint format used by adapter stale checks. */
  screenDigest: string;
  observation: TerminalNativeInspectionObservation;
}

export interface TerminalNativeInspectionCapture {
  terminalControl: TerminalControlRef;
  screen: string;
  inspection: TerminalScreenInspection;
}

export interface TerminalNativeInspectionRuntime<TStatus> {
  captureInspection: (
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    options: {
      runtime?: TerminalRuntimeIdentity;
      scrollbackLines?: number;
    }
  ) => Promise<TerminalNativeInspectionCapture>;
  verifyIdentity: (
    agent: ExecutorKind,
    terminalControl: TerminalControlRef,
    runtime?: TerminalRuntimeIdentity
  ) => Promise<TerminalControlRef>;
  statusFromInspection: (
    adapter: TerminalAgentAdapter,
    terminalControl: TerminalControlRef,
    inspection: TerminalScreenInspection,
    options: {
      screen?: string;
      runtime?: TerminalRuntimeIdentity;
    }
  ) => TStatus;
  nowMs: () => number;
  sleep: (milliseconds: number) => Promise<void>;
}

/**
 * A fail-closed native-inspection submission result.
 *
 * Only `not_started` proves that a caller may safely retry. Once text has
 * reached the composer, or Enter has been attempted, automated retries could
 * duplicate input or execute a different command after terminal drift.
 */
export class NativeInspectionSubmissionError extends Error {
  readonly code = "AKK_NATIVE_INSPECTION_SUBMISSION_FAILED";
  readonly doNotRetry: boolean;

  constructor(
    readonly stage: NativeInspectionSubmissionStage,
    message: string,
    options: {
      cause?: unknown;
      diagnostic?: NativeInspectionSubmissionDiagnostic;
    } = {}
  ) {
    super(message, options);
    this.name = "NativeInspectionSubmissionError";
    this.doNotRetry = stage !== "not_started";
    this.diagnostic = options.diagnostic;
  }

  readonly diagnostic?: NativeInspectionSubmissionDiagnostic;
}

export class NativeInspectionDiagnosticError extends Error {
  constructor(
    readonly diagnostic: NativeInspectionSubmissionDiagnostic,
    message: string,
    options: { cause?: unknown } = {}
  ) {
    super(message, options);
    this.name = "NativeInspectionDiagnosticError";
  }
}

/** A verified modal could not be dismissed across one exact key attempt. */
export class NativeInspectionDismissalError extends Error {
  readonly code = "AKK_NATIVE_INSPECTION_DISMISSAL_FAILED";
  readonly doNotRetry = true;

  constructor(message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = "NativeInspectionDismissalError";
  }
}

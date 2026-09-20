import type { TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalSendOptions } from "./terminal-text-submission-bridge.js";

export type TerminalUserExplicitSendDisposition =
  "replaced_current_composer";

export interface TerminalUserExplicitSendReservationContext {
  terminalControl: TerminalControlRef;
  text: string;
}

export interface TerminalUserExplicitSendOptions {
  runtime?: TerminalRuntimeIdentity;
  beforeMutationReservation: (
    context: TerminalUserExplicitSendReservationContext
  ) => void | Promise<void>;
  onComposerClearDispatched?: (
    context: TerminalUserExplicitSendReservationContext
  ) => void | Promise<void>;
  onTransportStage?: TerminalSendOptions["onTransportStage"];
}

export interface TerminalUserExplicitSendResult {
  stage: "enter_dispatched";
  terminalControl: TerminalControlRef;
  disposition: TerminalUserExplicitSendDisposition;
  clearCount: 1;
  textInjectionCount: 1;
  enterCount: 1;
}

export type TerminalCodexUserExplicitSendDisposition =
  TerminalUserExplicitSendDisposition;
export type TerminalCodexUserExplicitSendReservationContext =
  TerminalUserExplicitSendReservationContext;
export type TerminalCodexUserExplicitSendOptions =
  TerminalUserExplicitSendOptions;
export type TerminalCodexUserExplicitSendResult =
  TerminalUserExplicitSendResult;

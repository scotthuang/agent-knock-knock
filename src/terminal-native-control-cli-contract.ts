import type { ManagedSessionState } from "./managed-session.js";
import type { LifecycleTerminalObservation } from
  "./native-thread-lifecycle-query-service.js";
import type {
  ResolvedTerminalConversation,
  TerminalBridgeStatus
} from "./terminal-agent-bridge.js";

export type TerminalNativeControlCliOptions = Readonly<Record<string, unknown>>;

/** Shared physical-terminal safety boundary; it grants no native task identity. */
export interface TerminalNativeControlCliBoundary {
  resolveLifecycleTerminal(options: TerminalNativeControlCliOptions):
    Promise<ResolvedTerminalConversation>;
  assertSameInspectionTerminal(
    expected: LifecycleTerminalObservation,
    actual: LifecycleTerminalObservation,
    stage: string
  ): void;
  assertInspectionReady(input: {
    options: TerminalNativeControlCliOptions;
    terminal: LifecycleTerminalObservation;
    terminalStatus?: TerminalBridgeStatus;
    session?: ManagedSessionState;
  }): void;
  assertForegroundHasNoLifecycleTransition(
    options: TerminalNativeControlCliOptions,
    terminal: LifecycleTerminalObservation
  ): void;
}

import type { Conversation } from "./protocol.js";
import type { CodexPreMaterializationIdentity } from
  "./terminal-authority-policy.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  TerminalCommandCliPorts
} from "./terminal-command-cli-ports.js";

type RetryPort<Name extends keyof TerminalCommandCliPorts> = Pick<
  TerminalCommandCliPorts,
  Name
>;

interface TerminalSubmissionRetryLocalPorts {
  durableTerminalInputDispatched(conversation: Conversation): boolean;
  terminalAcceptanceCompanionFences(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): {
    allowedCompanionIdentity?: CodexPreMaterializationIdentity;
    allowedAdditionalIdentities?: CodexPreMaterializationIdentity[];
  };
  validateStoredTerminalSubmissionMatch(input: {
    owner: Conversation;
    receipt: Record<string, any>;
    options: Record<string, any>;
    terminalControl: TerminalControlRef;
    requestText: string;
    requestHash: string;
    expectedStoreDir: string;
    expectedSessionId?: string;
    expectedTurnId?: string;
    expectedMessageType: "task" | "answer";
    expectedStatePath?: string;
  }): Record<string, any> | undefined;
}

export type TerminalSubmissionRetryReconciliationPorts =
  RetryPort<
    | "deferredForegroundApplication"
    | "deferredForegroundRecoveryAdapterPorts"
    | "required"
    | "startTerminalBridgeMonitorForConversation"
    | "terminalBridgeRequestFingerprint"
    | "terminalBridgeRuntimeKey"
    | "terminalControlFromTakeover"
    | "terminalDispatchRecordMatchesControl"
    | "withTerminalBridgeSubmission"
    | "mutationDispatchLedger"
  > & TerminalSubmissionRetryLocalPorts;

export type TerminalSubmissionRetryApplicationPorts =
  RetryPort<
    | "assertDeferredCodexForegroundBindingBoundary"
    | "createTerminalAgentBridge"
    | "deferredForegroundRecoveryAdapterPorts"
    | "loadConversationFromOptions"
    | "required"
    | "startTerminalBridgeMonitorForConversation"
    | "terminalControlFromTakeover"
    | "terminalDispatchExecution"
    | "terminalRuntimeIdentityForConversation"
    | "terminalWriterMutationLocks"
    | "withTerminalDispatchStateScope"
  > & Pick<
    TerminalSubmissionRetryLocalPorts,
    "terminalAcceptanceCompanionFences"
  >;

export type TerminalSubmissionRetryTransportPorts =
  RetryPort<
    | "deferredForegroundApplication"
    | "deferredForegroundRecoveryAdapterPorts"
    | "required"
    | "startTerminalBridgeMonitorForConversation"
    | "terminalRuntimeIdentityForConversation"
    | "withTerminalBridgeSubmission"
    | "mutationDispatchLedger"
  > & Pick<
    TerminalSubmissionRetryLocalPorts,
    "terminalAcceptanceCompanionFences"
  >;

export type TerminalSubmissionRetryPorts =
  TerminalSubmissionRetryReconciliationPorts &
  TerminalSubmissionRetryApplicationPorts &
  TerminalSubmissionRetryTransportPorts;

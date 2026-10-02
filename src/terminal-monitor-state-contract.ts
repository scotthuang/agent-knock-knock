/** Monitor invocation contracts and shared state access. */
import type { Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { TerminalMonitorDeferralPorts } from "./terminal-monitor-application-service.js";
import type { TerminalMonitorEligibility } from "./terminal-monitor-reconciliation-eligibility.js";
import type {
  TerminalMonitorStatePaths,
  TerminalMonitorStateReconciliation
} from "./terminal-monitor-state-reconciliation-service.js";
import type {
  TerminalDispatchRepositoryCliAdapter
} from "./terminal-dispatch-repository-cli-adapter.js";
import type {
  TerminalDispatchRecoveryCliFacade
} from "./terminal-dispatch-recovery-cli-adapter.js";
import type { TerminalAcceptanceCliFacade } from "./terminal-acceptance-cli-adapter.js";
import type { TerminalHandoffCliFacade } from "./terminal-handoff-cli-adapter.js";
import type {
  createTerminalIdentityAuthorityCliAdapter
} from "./terminal-identity-authority-cli-adapter.js";
import type { CallbackCliFacade } from "./callback-cli-adapter.js";
import { isRecord } from "./value-guards.js";

export type MonitorCliOptions = Record<string, unknown>;

type IdentityAuthority = ReturnType<
  typeof createTerminalIdentityAuthorityCliAdapter
>;

export type Release = () => void;

export const COLLATERAL_STALL_REASON =
  "a newer terminal submission has an uncertain outcome; inspect the shared terminal pane before continuing";

export interface TerminalMonitorStateCliDependencies {
  dispatch: {
    repository: TerminalDispatchRepositoryCliAdapter;
    recovery: TerminalDispatchRecoveryCliFacade;
  };
  acceptance: Pick<
    TerminalAcceptanceCliFacade,
    "markUncertain" | "reconcileMonitor" | "recoverVirgin" |
      "storeDirForConversation"
  >;
  authority: {
    identity: Pick<
      IdentityAuthority,
      "migrateLegacyTerminalAgentIdentity" |
        "terminalRuntimeIdentityForConversation" |
        "terminalDurableRequestForConversation"
    >;
    handoff: Pick<
      TerminalHandoffCliFacade,
      "recoverDeferredCodexForegroundTransferBeforeMutation"
    >;
    assertBindingCurrent(
      conversation: Conversation,
      operation: string
    ): void;
    terminalControlForConversation(
      conversation: Conversation
    ): TerminalControlRef | undefined;
    createBridge(options: MonitorCliOptions): TerminalAgentBridge;
  };
  callbacks: Pick<
    CallbackCliFacade,
    "reconcileDelivery" | "prepareApprovalNotification" |
      "prepareInteractionNotification" | "runPrepared" |
      "emitPreparedResult" | "prepareStallNotification"
  >;
  runtime: {
    isProcessAlive(pid: number): boolean;
    storeDir(options: MonitorCliOptions): string;
    print(value: Record<string, unknown>): void;
    bindingSuperseded(error: unknown):
      | { code: string; message: string }
      | undefined;
    approvalTtlMs: number;
    callbackRetryLimit: number;
  };
}

export interface TerminalMonitorStateCliAdapter {
  runService(input: {
    options: MonitorCliOptions;
    statePath: string;
    logPath: string;
    initialConversation: Conversation;
    expectedTerminalMessageId: string;
    lifecycle: { startedRecorded: boolean };
    configuration(): {
      pollIntervalMs: number;
      timeoutMinutes: number;
      hardTimeoutMinutes: number;
    };
    terminalBridge(): TerminalAgentBridge;
  }): Promise<void>;
  deferralPorts(paths: TerminalMonitorStatePaths): TerminalMonitorDeferralPorts;
  reconcileCollateral(storeDir: string, conversationId?: string): Promise<
    TerminalBridgeCollateralStallReconciliation
  >;
  stallOther(input: {
    storeDir: string;
    terminalControl: TerminalControlRef;
    currentConversationId: string;
    uncertainMessageId: string;
  }): string[];
  statePaths(
    listed: Conversation,
    storeDir: string
  ): TerminalMonitorStatePaths;
  reconcileState(input: {
    options: MonitorCliOptions;
    storeDir: string;
    listed: Conversation;
    paths: TerminalMonitorStatePaths;
    includeCallbackRecovery: boolean;
  }): Promise<TerminalMonitorStateReconciliation>;
  eligibility(conversation: Conversation): TerminalMonitorEligibility;
  prepareLaunch(input: {
    statePath: string;
    expectedMessageId: string;
    requireWaitingForAgentStatus?: boolean;
    activeOwner(
      statePath: string,
      terminalMessageId: string
    ): { ownerPid?: number } | undefined;
    monitorLockVersion: number;
  }): TerminalMonitorLaunchPreparation;
}

export type TerminalMonitorLaunchPreparation =
  | {
      prepared: false;
      alreadyRunning: boolean;
      reason: string;
      ownerPid?: number;
    }
  | {
      prepared: true;
      conversation: Conversation;
      terminalControl: TerminalControlRef;
      inactivityTimeoutMinutes: number;
      hardTimeoutMinutes: number;
    };

export interface TerminalBridgeCollateralStallReconciliation {
  checked: number;
  repaired: number;
  skipped: number;
  errors: string[];
  items: Record<string, unknown>[];
}

export function takeoverFor(conversation: Conversation): Record<string, unknown> {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : {};
}

import type { CallbackExecutionResult, PreparedCallback } from
  "./callback-outbox-service.js";
import type { Conversation } from "./protocol.js";
import type {
  MonitorVerifiedDeadResult
} from "./terminal-monitor-application-service.js";
import type {
  TerminalMonitorEligibility
} from "./terminal-monitor-reconciliation-eligibility.js";

export interface TerminalMonitorStatePaths {
  statePath: string;
  logPath: string;
}

export interface TerminalMonitorCallbackRecovery {
  handled: boolean;
  conversationId?: string;
  status?: string;
  reason?: string;
  monitorPid?: number | null;
  attempt?: number;
  attemptPid?: number;
  leaseExpiresAt?: string;
  nextAttemptAt?: string;
}

export interface TerminalMonitorLocalCompletion {
  handled: boolean;
  recovered?: boolean;
  reason?: string;
}

export interface TerminalMonitorStateReconciliationPorts {
  state: {
    isTerminalBridge(conversation: Conversation): boolean;
  };
  completion: {
    settleLocal(
      storeDir: string,
      paths: TerminalMonitorStatePaths
    ): TerminalMonitorLocalCompletion;
    verifiedDead(input: {
      storeDir: string;
      paths: TerminalMonitorStatePaths;
      conversation: Conversation;
    }): Promise<MonitorVerifiedDeadResult>;
  };
  callbacks: {
    reconcile(
      storeDir: string,
      paths: TerminalMonitorStatePaths,
      delayMs?: unknown
    ): TerminalMonitorCallbackRecovery;
    run(
      prepared: PreparedCallback,
      options: { emit: false }
    ): CallbackExecutionResult;
  };
  authority: {
    migrateIdentity(
      listed: Conversation,
      paths: TerminalMonitorStatePaths
    ): Promise<Conversation>;
    recoverDeferred(
      storeDir: string,
      conversation: Conversation,
      paths: TerminalMonitorStatePaths
    ): Promise<Conversation>;
    recoverVirgin(
      conversation: Conversation,
      paths: TerminalMonitorStatePaths
    ): Promise<Conversation>;
    assertBindingCurrent(storeDir: string, conversation: Conversation): void;
    eligibility(conversation: Conversation): TerminalMonitorEligibility;
  };
}

export type TerminalMonitorStateItem = Readonly<{
  conversation_id?: string;
  status?: string;
  reason?: string;
  delivered?: boolean;
  monitor_pid?: number | null;
  attempt?: number;
  attempt_pid?: number;
  lease_expires_at?: string;
  next_attempt_at?: string;
}>;

export type TerminalMonitorStateReconciliation =
  | { kind: "ignored" }
  | {
      kind: "handled";
      counter: "launched" | "alreadyRunning" | "skipped";
      item: TerminalMonitorStateItem;
    }
  | {
      kind: "candidate";
      conversation: Conversation;
      eligibility: Extract<TerminalMonitorEligibility, { eligible: true }>;
    };

/**
 * Reconcile durable monitor facts before process-owner supervision begins.
 * Every port closes over its invocation-local adapter resources; this service
 * receives and returns data only and never observes a terminal resource.
 */
export async function reconcileTerminalMonitorStateCandidate(input: {
  storeDir: string;
  listed: Conversation;
  paths: TerminalMonitorStatePaths;
  includeCallbackRecovery: boolean;
  callbackRetryDelayMs?: unknown;
  ports: TerminalMonitorStateReconciliationPorts;
}): Promise<TerminalMonitorStateReconciliation> {
  const local = input.ports.completion.settleLocal(input.storeDir, input.paths);
  if (local.handled) {
    return handled("skipped", input.listed.conversation_id, {
      status: local.recovered ? "recovered" : "skipped",
      reason: local.reason
    });
  }

  if (input.includeCallbackRecovery) {
    const callback = input.ports.callbacks.reconcile(
      input.storeDir,
      input.paths,
      input.callbackRetryDelayMs
    );
    if (callback.handled) {
      return callbackRecoveryResult(callback);
    }
  }

  if (!input.ports.state.isTerminalBridge(input.listed)) {
    return { kind: "ignored" };
  }

  let conversation = await input.ports.authority.migrateIdentity(
    input.listed,
    input.paths
  );
  const dead = await input.ports.completion.verifiedDead({
    storeDir: input.storeDir,
    paths: input.paths,
    conversation
  });
  const deadResult = settleVerifiedDead(input, conversation, dead);
  if (deadResult) {
    return deadResult;
  }

  conversation = await input.ports.authority.recoverDeferred(
    input.storeDir,
    conversation,
    input.paths
  );
  conversation = await input.ports.authority.recoverVirgin(
    conversation,
    input.paths
  );
  input.ports.authority.assertBindingCurrent(input.storeDir, conversation);
  const eligibility = input.ports.authority.eligibility(conversation);
  return eligibility.eligible
    ? { kind: "candidate", conversation, eligibility }
    : handled("skipped", conversation.conversation_id, {
        status: "skipped",
        reason: eligibility.reason
      });
}

function settleVerifiedDead(
  input: Parameters<typeof reconcileTerminalMonitorStateCandidate>[0],
  conversation: Conversation,
  dead: MonitorVerifiedDeadResult
): Extract<TerminalMonitorStateReconciliation, { kind: "handled" }> | undefined {
  if (dead.completionPreparation) {
    const preparation = dead.completionPreparation;
    if (!preparation.claimed) {
      return handled("skipped", conversation.conversation_id, {
        status: "skipped",
        reason: preparation.reason
      });
    }
    const result = input.ports.callbacks.run(preparation.prepared, {
      emit: false
    });
    return handled("skipped", conversation.conversation_id, {
      status: "recovered",
      reason: "bound_agent_process_dead_completion_recovered",
      delivered: result.delivered
    });
  }
  return dead.stalled
    ? handled("skipped", conversation.conversation_id, {
        status: "stalled",
        reason: dead.reason
      })
    : undefined;
}

function callbackRecoveryResult(
  recovery: TerminalMonitorCallbackRecovery
): Extract<TerminalMonitorStateReconciliation, { kind: "handled" }> {
  return {
    kind: "handled",
    counter: recovery.status === "launched"
      ? "launched"
      : recovery.status === "already_running"
        ? "alreadyRunning"
        : "skipped",
    item: {
      conversation_id: recovery.conversationId,
      status: recovery.status,
      reason: recovery.reason,
      ...(recovery.monitorPid === undefined
        ? {}
        : { monitor_pid: recovery.monitorPid }),
      ...(recovery.attempt === undefined
        ? {}
        : { attempt: recovery.attempt }),
      ...(recovery.attemptPid === undefined
        ? {}
        : { attempt_pid: recovery.attemptPid }),
      ...(recovery.leaseExpiresAt === undefined
        ? {}
        : { lease_expires_at: recovery.leaseExpiresAt }),
      ...(recovery.nextAttemptAt === undefined
        ? {}
        : { next_attempt_at: recovery.nextAttemptAt })
    }
  };
}

function handled(
  counter: "launched" | "alreadyRunning" | "skipped",
  conversationId: string,
  detail: Omit<TerminalMonitorStateItem, "conversation_id">
): Extract<TerminalMonitorStateReconciliation, { kind: "handled" }> {
  return {
    kind: "handled",
    counter,
    item: { conversation_id: conversationId, ...detail }
  };
}

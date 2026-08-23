import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import type {
  CallbackExecutionResult,
  PreparedCallback
} from "../src/callback-outbox-service.js";
import type { Conversation } from "../src/protocol.js";
import type { MonitorVerifiedDeadResult } from
  "../src/terminal-monitor-application-service.js";
import {
  deferredUserAbandonmentCollateralAction,
  settleDeferredUserAbandonmentBeforeMonitorMutation
} from "../src/terminal-monitor-state-cli-adapter.js";
import type { TerminalMonitorEligibility } from
  "../src/terminal-monitor-reconciliation-eligibility.js";
import {
  reconcileTerminalMonitorStateCandidate,
  type TerminalMonitorCallbackRecovery,
  type TerminalMonitorLocalCompletion,
  type TerminalMonitorStatePaths,
  type TerminalMonitorStateReconciliationPorts
} from "../src/terminal-monitor-state-reconciliation-service.js";

const STORE_DIR = "/store/exact";
const PATHS: TerminalMonitorStatePaths = {
  statePath: "/store/exact/conversations/turn-1/state.json",
  logPath: "/store/exact/conversations/turn-1/events.ndjson"
};
const CONTROL = {
  kind: "tmux" as const,
  target: "akk:0.1",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4200,
  currentPath: "/workspace",
  capabilities: []
};

function compiledMonitorStateSource(startToken: string, endToken: string): string {
  const source = fs.readFileSync(
    new URL("../src/terminal-monitor-state-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf(startToken);
  const end = source.indexOf(endToken, start + startToken.length);
  assert.notEqual(start, -1, `missing ${startToken}`);
  assert.notEqual(end, -1, `missing ${endToken}`);
  return source.slice(start, end);
}

function assertSourceOrder(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered token ${token}`);
    cursor = found + token.length;
  }
}

function conversation(id: string): Conversation {
  return {
    session_id: "session-1",
    turn_id: id,
    conversation_id: id,
    user_request: "continue",
    openclaw_session: "openclaw-1",
    claude_session: "codex-1",
    executor: {
      kind: "codex",
      actor: "codex",
      session: "codex-1",
      display_name: "Codex",
      transport: "tmux"
    },
    workspace: "/workspace",
    status: "waiting_for_agent",
    response_rounds_used: 0,
    soft_limit: 5,
    hard_limit: 10,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    state_path: PATHS.statePath,
    event_log_path: PATHS.logPath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-1"
    }
  };
}

function eligible(): Extract<TerminalMonitorEligibility, { eligible: true }> {
  return {
    eligible: true,
    nativeTakeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-1"
    },
    terminalMessageId: "message-1",
    terminalControl: CONTROL,
    runtime: { pid: 4201, cwd: "/workspace" },
    inactivityTimeoutMinutes: 60,
    hardTimeoutMinutes: 720,
    inactivityDeadlineAtMs: 1,
    hardDeadlineAtMs: 2
  };
}

function prepared(owner: Conversation): PreparedCallback {
  return {
    outcome: "record_only",
    conversation: owner,
    message: {
      id: "callback-1",
      ts: owner.updated_at,
      conversation_id: owner.conversation_id,
      session_id: owner.session_id,
      turn_id: owner.turn_id,
      from: "codex",
      to: "openclaw",
      type: "done",
      requires_response: false,
      round: 0,
      max_rounds: owner.soft_limit,
      body: "done",
      metadata: { completion_bytes: 4096 }
    }
  };
}

function callbackResult(owner: Conversation): CallbackExecutionResult {
  return {
    delivered: true,
    duplicate: false,
    conversation: owner,
    message: { id: "callback-1" }
  };
}

function portsFixture(trace: string[]) {
  const listed = conversation("turn-1");
  const migrated = conversation("turn-migrated");
  const retried = conversation("turn-retried");
  const deferred = conversation("turn-deferred");
  const finalized = conversation("turn-retry-finalized");
  const virgin = conversation("turn-virgin");
  const eligibility = eligible();
  const ports: TerminalMonitorStateReconciliationPorts = {
    state: {
      isTerminalBridge: (candidate) => {
        assert.strictEqual(candidate, listed);
        trace.push("terminal-bridge");
        return true;
      }
    },
    completion: {
      settleLocal: (storeDir, paths) => {
        assert.equal(storeDir, STORE_DIR);
        assert.strictEqual(paths, PATHS);
        trace.push("local");
        return { handled: false };
      },
      verifiedDead: async (input) => {
        assert.equal(input.storeDir, STORE_DIR);
        assert.strictEqual(input.paths, PATHS);
        assert.strictEqual(input.conversation, retried);
        trace.push("verified-dead");
        return { stalled: false, conversation: retried };
      }
    },
    callbacks: {
      reconcile: (storeDir, paths, delayMs) => {
        assert.equal(storeDir, STORE_DIR);
        assert.strictEqual(paths, PATHS);
        assert.equal(delayMs, 37);
        trace.push("callback-reconcile");
        return { handled: false };
      },
      run: () => {
        throw new Error("unexpected callback execution");
      }
    },
    authority: {
      migrateIdentity: async (candidate, paths) => {
        assert.strictEqual(candidate, listed);
        assert.strictEqual(paths, PATHS);
        trace.push("migrate");
        return migrated;
      },
      recoverSubmissionRetry: async (storeDir, candidate, paths) => {
        assert.equal(storeDir, STORE_DIR);
        assert.strictEqual(paths, PATHS);
        if (candidate === migrated) {
          trace.push("submission-retry");
          return retried;
        }
        assert.strictEqual(candidate, deferred);
        trace.push("submission-retry-finalize");
        return finalized;
      },
      recoverDeferred: async (storeDir, candidate, paths) => {
        assert.equal(storeDir, STORE_DIR);
        assert.strictEqual(candidate, retried);
        assert.strictEqual(paths, PATHS);
        trace.push("deferred");
        return deferred;
      },
      recoverVirgin: async (candidate, paths) => {
        assert.strictEqual(candidate, finalized);
        assert.strictEqual(paths, PATHS);
        trace.push("virgin");
        return virgin;
      },
      assertBindingCurrent: (storeDir, candidate) => {
        assert.equal(storeDir, STORE_DIR);
        assert.strictEqual(candidate, virgin);
        trace.push("binding");
      },
      eligibility: (candidate) => {
        assert.strictEqual(candidate, virgin);
        trace.push("eligibility");
        return eligibility;
      }
    }
  };
  return {
    listed, migrated, retried, deferred, finalized, virgin, eligibility, ports
  };
}

async function reconcile(
  listed: Conversation,
  ports: TerminalMonitorStateReconciliationPorts,
  includeCallbackRecovery = true
) {
  return reconcileTerminalMonitorStateCandidate({
    storeDir: STORE_DIR,
    listed,
    paths: PATHS,
    includeCallbackRecovery,
    callbackRetryDelayMs: 37,
    ports
  });
}

test("monitor state reconciliation preserves exact order and resource identity", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  let resourcesActive = true;
  const originalEligibility = fixture.ports.authority.eligibility;
  fixture.ports.authority.eligibility = (candidate) => {
    assert.equal(resourcesActive, true);
    const result = originalEligibility(candidate);
    resourcesActive = false;
    return result;
  };

  const result = await reconcile(fixture.listed, fixture.ports);

  assert.deepEqual(trace, [
    "local",
    "callback-reconcile",
    "terminal-bridge",
    "migrate",
    "submission-retry",
    "verified-dead",
    "deferred",
    "submission-retry-finalize",
    "virgin",
    "binding",
    "eligibility"
  ]);
  assert.equal(resourcesActive, false);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    kind: "candidate",
    conversation: fixture.virgin,
    eligibility: fixture.eligibility
  });
});

test("user abandonment startup settlement is idempotent and has no live or callback ports", async () => {
  const initial = conversation("turn-abandoning");
  const released = {
    ...initial,
    status: "closed" as const,
    disposition: "user_abandoned_management"
  };
  let status: "user_abandoning" | "user_abandoned" = "user_abandoning";
  const trace: string[] = [];
  let liveCalls = 0;
  let callbackCalls = 0;
  const recover = async () => {
    trace.push("recover-no-live");
    status = "user_abandoned";
    return released;
  };
  const observeStatus = () => {
    trace.push(`observe:${status}`);
    return status;
  };

  const first = await settleDeferredUserAbandonmentBeforeMonitorMutation({
    conversation: initial,
    observeStatus,
    recover
  });
  const replay = await settleDeferredUserAbandonmentBeforeMonitorMutation({
    conversation: released,
    observeStatus,
    recover
  });

  assert.deepEqual(first, { action: "released", conversation: released });
  assert.deepEqual(replay, { action: "released", conversation: released });
  assert.deepEqual(trace, [
    "observe:user_abandoning",
    "recover-no-live",
    "observe:user_abandoned",
    "observe:user_abandoned"
  ]);
  assert.equal(liveCalls, 0);
  assert.equal(callbackCalls, 0);
  void liveCalls;
  void callbackCalls;
});

test("collateral repair rechecks a close intent after an outer normal gate", () => {
  let status: "target_prepared" | "user_abandoning" = "target_prepared";
  let repairs = 0;
  let recoveries = 0;
  assert.equal(deferredUserAbandonmentCollateralAction(status), "repair");

  // The close intent wins before the writer/state transaction resumes.
  status = "user_abandoning";
  const lockedAction = deferredUserAbandonmentCollateralAction(status);
  if (lockedAction === "repair") {
    repairs += 1;
  } else if (lockedAction === "recover") {
    recoveries += 1;
  }
  assert.equal(lockedAction, "recover");
  assert.equal(repairs, 0);
  assert.equal(recoveries, 1);
  assert.equal(
    deferredUserAbandonmentCollateralAction("user_abandoned"),
    "released"
  );
});

test("user abandonment preflight precedes every monitor startup side effect", () => {
  const runService = compiledMonitorStateSource(
    "async runService(",
    "deferralPorts("
  );
  assertSourceOrder(runService, [
    "recoverDeferredUserAbandonmentBeforeMutation",
    'startup.action === "released"',
    "runTerminalMonitorService"
  ]);
  const reconcileState = compiledMonitorStateSource(
    "async reconcileState(",
    "#stateReconciliationPorts("
  );
  assertSourceOrder(reconcileState, [
    "recoverDeferredUserAbandonmentBeforeMutation",
    'startup.action === "released"',
    "reconcileTerminalMonitorStateCandidate"
  ]);
  const submissionRetry = compiledMonitorStateSource(
    "async #recoverSubmissionRetry(",
    "async #recoverDeferred("
  );
  assertSourceOrder(submissionRetry, [
    "#linkedDeferredUserAbandonmentStatus",
    "loadTerminalSubmissionRetry",
    "dispatch.repository.acquire",
    "withStoreWriterLeaseAsync",
    "loadState(paths.statePath)",
    "#linkedDeferredUserAbandonmentStatus",
    "loadTerminalSubmissionRetry"
  ]);
  const eligibility = compiledMonitorStateSource(
    "eligibility(conversation)",
    "async reconcileState("
  );
  assertSourceOrder(eligibility, [
    "#linkedDeferredUserAbandonmentStatus",
    "terminalMonitorReconciliationEligibility",
    "dispatch.repository.load"
  ]);
  const abandonment = compiledMonitorStateSource(
    "async recoverDeferredUserAbandonmentBeforeMutation(",
    "#stateReconciliationPorts("
  );
  assertSourceOrder(abandonment, [
    "loadDeferredForegroundTransfer",
    "recoverDeferredForegroundUserAbandonmentBeforeMutation",
    "loadState"
  ]);
  assert.doesNotMatch(
    abandonment,
    /createBridge|resolveStoredTerminal|callbacks|recoverSubmissionRetry|verifiedDead|dispatch\.repository\.acquire/u
  );

  const collateral = compiledMonitorStateSource(
    "async reconcileCollateral(",
    "#appendCollateralRepairEvent("
  );
  assertSourceOrder(collateral, [
    "withStoreWriterLeaseAsync",
    "#stateFileLock.acquire",
    "loadState(statePath)",
    "#linkedDeferredUserAbandonmentStatus",
    "deferredUserAbandonmentCollateralAction",
    'abandonmentAction !== "repair"',
    "#exactCollateralRepairEvidence",
    "#persistCollateralRepair"
  ]);
});

test("callback and verified-dead transactions fence deferred abandonment under fresh locks", () => {
  const callback = fs.readFileSync(
    new URL("../src/callback-outbox-service.js", import.meta.url),
    "utf8"
  );
  const callbackStart = callback.indexOf("function reconcileCallbackDelivery(");
  const callbackEnd = callback.indexOf(
    "function runCallbackRetryMonitor(",
    callbackStart
  );
  const callbackTransaction = callback.slice(callbackStart, callbackEnd);
  assertSourceOrder(callbackTransaction, [
    "ports.state.withTransaction",
    "ports.state.load(statePath)",
    '!["pending", "failed"].includes',
    "ports.authority.assertNoDeferredTransfer",
    "ports.retry.startMonitor",
    "ports.state.save"
  ]);

  const recovery = fs.readFileSync(
    new URL("../src/terminal-dispatch-recovery-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const verifiedStart = recovery.indexOf("async #withVerifiedDeadLocks(");
  const verifiedEnd = recovery.indexOf(
    "#withLocalCompletionTransaction(",
    verifiedStart
  );
  const verifiedTransaction = recovery.slice(verifiedStart, verifiedEnd);
  assertSourceOrder(verifiedTransaction, [
    "repository.acquire",
    "withStoreWriterLeaseAsync",
    "#stateFileLock.acquire",
    "loadState(request.statePath)",
    "acceptedTurnCanBeStalled(request.storeDir, current)",
    "operation({"
  ]);
});

test("startup retry recovery preserves terminal outcomes and finalizes accepted crash lags", () => {
  const recovery = compiledMonitorStateSource(
    "async #recoverSubmissionRetry(",
    "async #recoverDeferred("
  );
  assertSourceOrder(recovery, [
    "decideTerminalSubmissionRetryStartup",
    'startup.action === "finalize_accepted"',
    "finalizeTerminalSubmissionRetryStartupAccepted",
    'startup.action === "repair_terminal_ledger"',
    "reconcileTerminalSubmissionRetryStartupTerminalLedger",
    'startup.action === "repair_terminal_state"',
    "reconcileTerminalSubmissionRetryStartupTerminalState",
    'startup.action === "no_change"',
    "return conversation",
    "const projection",
    "terminalSubmissionRetryMonitorEpoch"
  ]);
  const accepted = compiledMonitorStateSource(
    "function finalizeTerminalSubmissionRetryStartupAccepted(",
    "function mirrorDeferredSubmissionRetryEnter("
  );
  assertSourceOrder(accepted, [
    "loadDeferredForegroundTransfer",
    'transfer.status !== "resolved"',
    "saveState",
    "saveTerminalSubmissionRetry",
    "input.saveLedger",
    'terminal_input_sent: false'
  ]);
});

test("local completion short-circuits lazily with the legacy getter order", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  const listed = fixture.listed as Conversation & { conversation_id: string };
  Object.defineProperty(listed, "conversation_id", {
    enumerable: true,
    get() {
      trace.push("listed.conversation_id");
      return "turn-1";
    }
  });
  const local = Object.defineProperties({}, {
    handled: getter("local.handled", true),
    recovered: getter("local.recovered", true),
    reason: getter("local.reason", "local_completion_recovered")
  }) as TerminalMonitorLocalCompletion;
  fixture.ports.completion.settleLocal = () => {
    trace.push("local");
    return local;
  };

  const result = await reconcile(listed, fixture.ports);

  assert.deepEqual(trace, [
    "local",
    "local.handled",
    "listed.conversation_id",
    "local.recovered",
    "local.reason"
  ]);
  assert.deepEqual(result, {
    kind: "handled",
    counter: "skipped",
    item: {
      conversation_id: "turn-1",
      status: "recovered",
      reason: "local_completion_recovered"
    }
  });

  function getter<T>(label: string, value: T): PropertyDescriptor {
    return {
      enumerable: true,
      get() {
        trace.push(label);
        return value;
      }
    };
  }
});

test("callback recovery preserves getter order plus explicit zero and null facts", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  const recovery = Object.defineProperties({}, {
    handled: getter("callback.handled", true),
    conversationId: getter("callback.conversationId", "turn-callback"),
    status: getter("callback.status", "already_running"),
    reason: getter("callback.reason", "retry_in_flight"),
    monitorPid: getter("callback.monitorPid", null),
    attempt: getter("callback.attempt", 0),
    attemptPid: getter("callback.attemptPid", undefined),
    leaseExpiresAt: getter(
      "callback.leaseExpiresAt",
      "2026-08-20T00:00:01.000Z"
    ),
    nextAttemptAt: getter("callback.nextAttemptAt", undefined)
  }) as TerminalMonitorCallbackRecovery;
  fixture.ports.callbacks.reconcile = (storeDir, paths, delayMs) => {
    assert.equal(storeDir, STORE_DIR);
    assert.strictEqual(paths, PATHS);
    assert.equal(delayMs, 37);
    trace.push("callback-reconcile");
    return recovery;
  };

  const result = await reconcile(fixture.listed, fixture.ports);

  assert.deepEqual(trace, [
    "local",
    "callback-reconcile",
    "callback.handled",
    "callback.status",
    "callback.status",
    "callback.conversationId",
    "callback.status",
    "callback.reason",
    "callback.monitorPid",
    "callback.monitorPid",
    "callback.attempt",
    "callback.attempt",
    "callback.attemptPid",
    "callback.leaseExpiresAt",
    "callback.leaseExpiresAt",
    "callback.nextAttemptAt"
  ]);
  assert.deepEqual(result, {
    kind: "handled",
    counter: "alreadyRunning",
    item: {
      conversation_id: "turn-callback",
      status: "already_running",
      reason: "retry_in_flight",
      monitor_pid: null,
      attempt: 0,
      lease_expires_at: "2026-08-20T00:00:01.000Z"
    }
  });

  function getter<T>(label: string, value: T): PropertyDescriptor {
    return {
      enumerable: true,
      get() {
        trace.push(label);
        return value;
      }
    };
  }
});

test("verified-dead recovery forwards prepared byte facts before later authority", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  const callback = prepared(fixture.retried);
  const preparation = Object.defineProperties({}, {
    claimed: getter("completion.claimed", true),
    conversation: getter("completion.conversation", fixture.retried),
    prepared: getter("completion.prepared", callback)
  });
  const dead = Object.defineProperties({
    conversation: fixture.retried
  }, {
    completionPreparation: getter(
      "dead.completionPreparation",
      preparation
    ),
    stalled: getter("dead.stalled", false)
  }) as MonitorVerifiedDeadResult;
  fixture.ports.completion.verifiedDead = async () => {
    trace.push("verified-dead");
    return dead;
  };
  fixture.ports.callbacks.run = (received, options) => {
    trace.push("callback-run");
    assert.strictEqual(received, callback);
    assert.deepEqual(options, { emit: false });
    assert.equal(received.message.metadata.completion_bytes, 4096);
    const result = callbackResult(fixture.retried);
    Object.defineProperty(result, "delivered", getter("result.delivered", true));
    return result;
  };

  const result = await reconcile(fixture.listed, fixture.ports, false);

  assert.deepEqual(trace, [
    "local",
    "terminal-bridge",
    "migrate",
    "submission-retry",
    "verified-dead",
    "dead.completionPreparation",
    "dead.completionPreparation",
    "completion.claimed",
    "completion.prepared",
    "callback-run",
    "result.delivered"
  ]);
  assert.deepEqual(result, {
    kind: "handled",
    counter: "skipped",
    item: {
      conversation_id: fixture.retried.conversation_id,
      status: "recovered",
      reason: "bound_agent_process_dead_completion_recovered",
      delivered: true
    }
  });

  function getter<T>(label: string, value: T): PropertyDescriptor {
    return {
      enumerable: true,
      configurable: true,
      get() {
        trace.push(label);
        return value;
      }
    };
  }
});

test("port failures propagate unchanged and suppress all later observations", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  const failure = new Error("deferred resource expired");
  fixture.ports.authority.recoverDeferred = async () => {
    trace.push("deferred");
    throw failure;
  };

  await assert.rejects(
    reconcile(fixture.listed, fixture.ports, false),
    (error: unknown) => error === failure
  );
  assert.deepEqual(trace, [
    "local",
    "terminal-bridge",
    "migrate",
    "submission-retry",
    "verified-dead",
    "deferred"
  ]);
});

test("service and CLI declarations retain narrow canonical facade boundaries", () => {
  const serviceDeclaration = fs.readFileSync(new URL(
    "../src/terminal-monitor-state-reconciliation-service.d.ts",
    import.meta.url
  ), "utf8");
  const adapterDeclaration = fs.readFileSync(new URL(
    "../src/terminal-monitor-state-cli-adapter.d.ts",
    import.meta.url
  ), "utf8");
  const adapterSource = fs.readFileSync(new URL(
    "../../src/terminal-monitor-state-cli-adapter.ts",
    import.meta.url
  ), "utf8");
  const coreSource = fs.readFileSync(new URL(
    "../../src/cli-core.ts",
    import.meta.url
  ), "utf8");
  const servicePorts = boundary(
    serviceDeclaration,
    "export interface TerminalMonitorStateReconciliationPorts",
    "export type TerminalMonitorStateItem"
  );
  const adapterDependencies = boundary(
    adapterDeclaration,
    "export interface TerminalMonitorStateCliDependencies",
    "export interface TerminalMonitorStateCliAdapter"
  );
  assert.deepEqual(
    [...servicePorts.matchAll(/^    (state|completion|callbacks|authority):/gmu)]
      .map((match) => match[1]),
    ["state", "completion", "callbacks", "authority"]
  );
  assert.deepEqual(
    [...adapterDependencies.matchAll(
      /^    (dispatch|acceptance|authority|callbacks|runtime):/gmu
    )].map((match) => match[1]),
    ["dispatch", "acceptance", "authority", "callbacks", "runtime"]
  );
  assert.doesNotMatch(
    serviceDeclaration,
    /node:|\bStore\b|\bSession\b|ResolvedTerminalConversation|TerminalAgentAdapter|Record<[^>]*\bany\b|\block\b/u
  );
  assert.match(adapterDeclaration, /callbacks: Pick<CallbackCliFacade,/u);
  assert.doesNotMatch(
    adapterSource,
    /callbackOutboxService|openClawCallbackTransport|runPreparedCallback|emitPreparedCallbackResult/u
  );
  assert.doesNotMatch(
    adapterSource,
    /deliverGatewayMethod|deliverChatSend|#deliverStalledNotification/u
  );
  assert.match(adapterSource, /prepareStallNotification/u);
  assert.match(adapterSource, /callbackOutboxLane: "notification"/u);
  const composition = boundary(
    coreSource,
    "const terminalMonitorStateCliFacade =",
    "function agentVersionForRunningProcess"
  );
  assert.match(composition, /callbacks: callbackCliFacade/u);
  assert.match(composition, /recovery: terminalDispatchRecovery/u);
  assert.match(composition, /handoff: terminalHandoffCliFacade/u);

  function boundary(source: string, startToken: string, endToken: string) {
    const start = source.indexOf(startToken);
    const end = source.indexOf(endToken, start + startToken.length);
    assert.notEqual(start, -1, `missing ${startToken}`);
    assert.notEqual(end, -1, `missing ${endToken}`);
    return source.slice(start, end);
  }
});

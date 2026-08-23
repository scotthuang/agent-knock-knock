import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type {
  CallbackExecutionResult,
  PreparedCallback
} from "../src/callback-outbox-service.js";
import {
  pathsForDeferredForegroundTransfer,
  saveDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../src/deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import {
  ensureStoreWritable,
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";
import {
  createTerminalMonitorStateCliAdapter,
  type TerminalMonitorStateCliDependencies
} from "../src/terminal-monitor-state-cli-adapter.js";
import type { MonitorVerifiedDeadResult } from
  "../src/terminal-monitor-application-service.js";
import type { TerminalMonitorEligibility } from
  "../src/terminal-monitor-reconciliation-eligibility.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";
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

const DEFERRED_CONTROL: TerminalControlRef = {
  kind: "herdr",
  target: "workspace-1:pane-1",
  session: "workspace-1",
  socketPath: "/tmp/akk-monitor-close-herdr.sock",
  sessionDir: "/tmp/akk-monitor-close-herdr",
  workspaceId: "workspace-1",
  tabId: "tab-1",
  paneId: "pane-1",
  terminalId: "terminal-1",
  panePid: 4242,
  currentCommand: "codex",
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};

interface DeferredCloseFenceCounters {
  terminalLockAcquires: number;
  terminalResolutions: number;
  handoffRecoveries: number;
}

function persistedMonitorConversation(input: {
  storeDir: string;
  status: "waiting_for_agent" | "closed";
  disposition?: "user_abandoned_management";
  transferId: string;
  includeTerminalAuthority: boolean;
}): { conversation: Conversation; paths: TerminalMonitorStatePaths } {
  const paths = pathsForConversation("turn-monitor-close", input.storeDir);
  const base = createConversation({
    userRequest: "continue monitoring",
    sessionId: "session-monitor-close",
    turnId: "turn-monitor-close",
    executorKind: "codex",
    workspace: "/workspace",
    now: new Date("2026-08-24T00:00:00.000Z")
  });
  const terminalAuthority = input.includeTerminalAuthority
    ? {
        terminal_agent_pid: 4242,
        terminal_control: DEFERRED_CONTROL
      }
    : {};
  const conversation: Conversation = {
    ...base,
    status: input.status,
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(input.status === "closed"
      ? {
          closed_at: "2026-08-24T00:00:01.000Z",
          close_reason: "closed by request"
        }
      : {}),
    store_dir: path.resolve(input.storeDir),
    conversation_dir: path.resolve(path.dirname(paths.statePath)),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-monitor-close",
      deferred_foreground_transfer_id: input.transferId,
      ...terminalAuthority
    }
  };
  saveState(paths.statePath, conversation);
  return { conversation: loadState(paths.statePath), paths };
}

function preparedDeferredTransfer(
  storeDir: string,
  transferId: string
): DeferredForegroundTransfer {
  const sourceBinding = terminalBindingFrom({
    terminalId: "terminal:v2:herdr:codex:workspace-1:pane-1:4242",
    terminalControl: DEFERRED_CONTROL,
    pid: 4242,
    nativeThreadId: "00000000-0000-4000-8000-000000000424",
    processUuid: "codex-pid:4242:birth:monitor-close",
    processBirth: "monitor-close",
    evidence: "codex_status_card+process_birth",
    generation: 1,
    now: new Date("2026-08-24T00:00:00.000Z")
  });
  return saveDeferredForegroundTransfer(storeDir, {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 1,
    transfer_id: transferId,
    status: "prepared",
    input_stage: "none",
    terminal_id: sourceBinding.terminal_id,
    terminal_endpoint: sourceBinding.terminal_endpoint!,
    process_pid: 4242,
    process_uuid: "codex-pid:4242:birth:monitor-close",
    process_birth: "monitor-close",
    workspace: "/workspace",
    source_session_id: "session-source-monitor-close",
    source_expected_revision: 1,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-source-monitor-close",
      status: "bound",
      binding: sourceBinding
    }),
    source_before_binding: sourceBinding,
    target_session_id: "session-monitor-close",
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: "a".repeat(64),
    request_hash: "b".repeat(64),
    dispatcher_pid: 7331,
    prepared_at: "2026-08-24T00:00:00.000Z"
  }, { expectedRevision: null });
}

function deferredCloseFenceFacade(input: {
  storeDir: string;
  counters: DeferredCloseFenceCounters;
  beforeTerminalLock?: () => void;
}) {
  return createTerminalMonitorStateCliAdapter({
    dispatch: {
      repository: {
        acquire: () => {
          input.counters.terminalLockAcquires += 1;
          input.beforeTerminalLock?.();
          return () => {};
        }
      },
      recovery: {
        settleLocalCompletion: () => ({ handled: false }),
        stallAccepted: async (request: { conversation: Conversation }) => ({
          stalled: false,
          conversation: request.conversation
        })
      }
    },
    acceptance: {
      storeDirForConversation: () => input.storeDir,
      recoverVirgin: async (request: { conversation: Conversation }) => {
        const takeover = {
          ...(request.conversation.native_session_takeover as
            Record<string, unknown>)
        };
        delete takeover.deferred_foreground_transfer_id;
        return {
          outcome: "not_accepted",
          conversation: {
            ...request.conversation,
            native_session_takeover: takeover
          }
        };
      }
    },
    authority: {
      identity: {
        migrateLegacyTerminalAgentIdentity: async (request: {
          conversation: Conversation;
        }) => request.conversation
      },
      handoff: {
        recoverDeferredCodexForegroundTransferBeforeMutation: async () => {
          input.counters.handoffRecoveries += 1;
        }
      },
      assertBindingCurrent: () => {},
      terminalControlForConversation: () => undefined,
      createBridge: () => ({
        resolveStoredTerminal: async () => {
          input.counters.terminalResolutions += 1;
          throw new Error("closed deferred recovery must not read terminal");
        }
      })
    },
    callbacks: {},
    runtime: {
      isProcessAlive: () => true,
      storeDir: () => input.storeDir,
      print: () => {},
      bindingSuperseded: () => undefined,
      approvalTtlMs: 60_000,
      callbackRetryLimit: 3
    }
  } as unknown as TerminalMonitorStateCliDependencies);
}

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

test("explicit user Close short-circuits every monitor recovery port", async () => {
  const trace: string[] = [];
  const fixture = portsFixture(trace);
  const listed: Conversation = {
    ...fixture.listed,
    status: "closed",
    disposition: "user_abandoned_management",
    callback_expected: false,
    closed_at: "2026-08-20T00:00:01.000Z",
    close_reason: "closed by request",
    updated_at: "2026-08-20T00:00:01.000Z"
  };

  const result = await reconcile(listed, fixture.ports);

  assert.deepEqual(trace, []);
  assert.deepEqual(result, {
    kind: "handled",
    counter: "skipped",
    item: {
      conversation_id: "turn-1",
      status: "skipped",
      reason: "explicit_user_close_released_management"
    }
  });
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

test("monitor launch preparation acquires Store writer before Turn state", () => {
  const preparation = compiledMonitorStateSource(
    "    prepareLaunch(input) {",
    "    #persistMonitorLockVersion("
  );
  assertSourceOrder(preparation, [
    "withStoreWriterLease(storeDir",
    "#stateFileLock.acquire(`${input.statePath}.lock`)",
    "#persistMonitorLockVersion("
  ]);
});

test("explicit user-abandoned Close fences deferred recovery before terminal authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-close-fence-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const transferId = "deferred-transfer-monitor-close-outer";
  const fixture = persistedMonitorConversation({
    storeDir,
    status: "closed",
    disposition: "user_abandoned_management",
    transferId,
    includeTerminalAuthority: false
  });
  const before = fs.readFileSync(fixture.paths.statePath);
  const counters: DeferredCloseFenceCounters = {
    terminalLockAcquires: 0,
    terminalResolutions: 0,
    handoffRecoveries: 0
  };
  const facade = deferredCloseFenceFacade({ storeDir, counters });

  const result = await facade.reconcileState({
    options: {},
    storeDir,
    listed: fixture.conversation,
    paths: fixture.paths,
    includeCallbackRecovery: false
  });

  assert.equal(result.kind, "handled");
  assert.deepEqual(counters, {
    terminalLockAcquires: 0,
    terminalResolutions: 0,
    handoffRecoveries: 0
  });
  assert.deepEqual(fs.readFileSync(fixture.paths.statePath), before);
});

test("Close winning the canonical deferred-recovery lock race prevents terminal I/O", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-monitor-close-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const transferId = "deferred-transfer-monitor-close-race";
  const fixture = persistedMonitorConversation({
    storeDir,
    status: "waiting_for_agent",
    transferId,
    includeTerminalAuthority: true
  });
  preparedDeferredTransfer(storeDir, transferId);
  const transferPath = pathsForDeferredForegroundTransfer(
    transferId,
    storeDir
  ).statePath;
  const transferBefore = fs.readFileSync(transferPath);
  const counters: DeferredCloseFenceCounters = {
    terminalLockAcquires: 0,
    terminalResolutions: 0,
    handoffRecoveries: 0
  };
  let closedBytes: Buffer | undefined;
  const facade = deferredCloseFenceFacade({
    storeDir,
    counters,
    beforeTerminalLock: () => {
      const current = loadState(fixture.paths.statePath);
      saveState(fixture.paths.statePath, {
        ...current,
        status: "closed",
        disposition: "user_abandoned_management",
        closed_at: "2026-08-24T00:00:01.000Z",
        close_reason: "closed by request",
        updated_at: "2026-08-24T00:00:01.000Z"
      });
      closedBytes = fs.readFileSync(fixture.paths.statePath);
    }
  });

  const result = await facade.reconcileState({
    options: {},
    storeDir,
    listed: fixture.conversation,
    paths: fixture.paths,
    includeCallbackRecovery: false
  });

  assert.equal(result.kind, "handled");
  assert.deepEqual(counters, {
    terminalLockAcquires: 1,
    terminalResolutions: 0,
    handoffRecoveries: 0
  });
  assert.ok(closedBytes);
  assert.deepEqual(fs.readFileSync(fixture.paths.statePath), closedBytes);
  assert.deepEqual(fs.readFileSync(transferPath), transferBefore);
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

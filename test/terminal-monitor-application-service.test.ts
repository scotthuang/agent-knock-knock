import test from "node:test";
import assert from "node:assert/strict";
import type {
  CallbackExecutionResult,
  PreparedCallback
} from "../src/callback-outbox-service.js";
import type { Conversation } from "../src/protocol.js";
import type {
  TerminalCompletionEvidence,
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import type {
  TerminalBridgeStatus,
  TerminalMonitorPoll
} from "../src/terminal-agent-bridge.js";
import {
  pollTerminalMonitor,
  reconcileMonitorAcceptance,
  recordMonitorApprovalNotification,
  recoverPreparedMonitorSubmission,
  terminalMonitorStoreOperationTimeout
} from "../src/terminal-monitor-cli-adapter.js";
import {
  runTerminalMonitor,
  runTerminalMonitorWithStoreDeferral,
  type TerminalMonitorServicePorts
} from "../src/terminal-monitor-application-service.js";
import { isRecord } from "../src/value-guards.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "monitor:0.1",
  session: "monitor",
  window: 0,
  pane: 1,
  panePid: 4242,
  currentPath: "/workspace",
  capabilities: []
};

const COMPLETION: TerminalCompletionEvidence = {
  source: "durable",
  outcome: "success",
  text: "done",
  id: "completion-1",
  metadata: { context_match: "exact" }
};

function conversation(
  takeover: Record<string, unknown> = {},
  status: Conversation["status"] = "waiting_for_agent"
): Conversation {
  return {
    session_id: "session-1",
    turn_id: "turn-1",
    conversation_id: "turn-1",
    user_request: "do work",
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
    status,
    response_rounds_used: 0,
    soft_limit: 5,
    hard_limit: 10,
    created_at: "1970-01-01T00:00:00.000Z",
    updated_at: "1970-01-01T00:00:00.000Z",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-1",
      terminal_bridge_started_at: "1970-01-01T00:00:00.000Z",
      terminal_bridge_last_activity_at: "1970-01-01T00:00:00.000Z",
      ...takeover
    }
  };
}

function status(
  approvalState: TerminalBridgeStatus["approval_state"] = {
    scanned: true,
    blocked: false,
    approvable: false
  }
): TerminalBridgeStatus {
  return {
    provider: "tmux",
    target: CONTROL.target,
    agent: "codex",
    reachable: true,
    capabilities: {} as TerminalBridgeStatus["capabilities"],
    activity_state: "idle",
    activity_reason: "idle",
    approval_state: approvalState,
    screen: { digest: "screen-1" }
  };
}

function fakePrepared(owner: Conversation): PreparedCallback {
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
      metadata: {}
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

function fakePorts(
  trace: string[],
  initial: Conversation
): TerminalMonitorServicePorts {
  let current = initial;
  return {
    state: {
      load: () => {
        trace.push("state.load");
        return current;
      },
      appendEvent: (event) => trace.push(`event:${event.event}`),
      markStalled: (reason) => {
        trace.push("state.markStalled");
        current = { ...current, status: "stalled", stalled_reason: reason };
        return current;
      },
      persistActivity: (input) => {
        trace.push("state.persistActivity");
        current = input.conversation;
        return current;
      },
      persistDetectorDiagnostic: () => ({ conversation: current }),
      markApprovalPromptCleared: () => ({
        conversation: current,
        marked: false
      }),
      recordApprovalNotification: () => {
        trace.push("approval.record");
        return { conversation: current, duplicate: true, stale: false };
      }
    },
    authority: {
      initialize: () => {},
      terminalControl: () => CONTROL,
      submission: (owner) => {
        const takeover = isRecord(owner.native_session_takeover)
          ? owner.native_session_takeover
          : undefined;
        return isRecord(takeover?.terminal_bridge_submission)
          ? takeover.terminal_bridge_submission
          : undefined;
      },
      isWaitingForAgent: (value) => value === "waiting_for_agent",
      isProcessAlive: () => false,
      markAcceptanceUncertain: ({ conversation: owner }) => owner,
      reconcileAcceptance: async (input) => input.apply({ outcome: "pending" }),
      recoverPreparedSubmission: async ({ conversation: owner }) => owner,
      assertBindingCurrent: () => trace.push("binding.assert"),
      bindingSuperseded: () => undefined,
      storeOperationTimeout: () => undefined,
      storeLeaseTimeout: () => undefined,
      poll: async () => {
        throw new Error("test did not provide a monitor poll");
      }
    },
    callbacks: {
      prepareCompletion: ({ conversation: owner }) => {
        trace.push("completion.prepare");
        return {
          claimed: true,
          conversation: owner,
          prepared: fakePrepared(owner)
        };
      },
      verifiedDead: async () => {
        trace.push("death.verify");
        return { stalled: false, conversation: current };
      },
      run: (prepared) => {
        trace.push("callback.run");
        return callbackResult(prepared.conversation);
      },
      emit: () => trace.push("callback.emit")
    },
    runtime: {
      now: () => {
        trace.push("clock.now");
        return new Date(0);
      },
      nowMs: () => {
        trace.push("clock.nowMs");
        return 0;
      },
      pid: () => 99,
      sleep: () => trace.push("sleep"),
      log: (_level, event) => trace.push(`log:${event}`),
      exitAfterApprovalCallback: () => false,
      exit: (code) => {
        throw new Error(`unexpected exit ${code}`);
      }
    },
    presentation: {
      emit: (result) => trace.push(`present:${result.kind}`)
    }
  };
}

const CONFIGURATION = {
  pollIntervalMs: 50,
  timeoutMinutes: 5,
  hardTimeoutMinutes: 60,
  activityPersistIntervalMs: 1_000
};

test("replaced generation exits before configuration and effect initialization", async () => {
  const trace: string[] = [];
  const owner = conversation({ terminal_bridge_message_id: "message-2" });
  const ports = fakePorts(trace, owner);
  ports.authority.initialize = () => trace.push("authority.initialize");

  await runTerminalMonitor({
    initialConversation: owner,
    expectedTerminalMessageId: "message-1",
    configuration: () => {
      trace.push("configuration");
      return CONFIGURATION;
    },
    lifecycle: { startedRecorded: false },
    ports
  });

  assert.ok(!trace.includes("configuration"));
  assert.ok(!trace.includes("authority.initialize"));
  assert.ok(trace.includes("present:generation_replaced"));
});

test("monitor application preserves poll -> activity -> stable completion callback order", async () => {
  const trace: string[] = [];
  const owner = conversation();
  const ports = fakePorts(trace, owner);
  let polls = 0;
  ports.authority.poll = async () => {
    trace.push(`poll:${++polls}`);
    return {
      kind: "observed",
      poll: { status: status(), completion: COMPLETION }
    };
  };

  await runTerminalMonitor({
    initialConversation: owner,
    expectedTerminalMessageId: "message-1",
    configuration: () => CONFIGURATION,
    lifecycle: { startedRecorded: true },
    ports
  });

  assert.equal(polls, 2);
  assert.deepEqual(
    trace.filter((item) =>
      item.startsWith("poll:") ||
      ["completion.prepare", "callback.run", "death.verify"].includes(item)
    ),
    ["poll:1", "poll:2", "completion.prepare", "callback.run"]
  );
});

test("monitor application reconciles a live dispatcher before any terminal poll", async () => {
  const trace: string[] = [];
  const waiting = conversation({
    terminal_bridge_submission: {
      message_id: "message-1",
      status: "text_injected",
      dispatcher_pid: 7331
    }
  });
  const stopped = { ...waiting, status: "idle" as const };
  const ports = fakePorts(trace, waiting);
  let loads = 0;
  ports.state.load = () => {
    trace.push("state.load");
    return loads++ === 0 ? waiting : stopped;
  };
  ports.authority.isProcessAlive = (pid) => {
    trace.push(`process:${pid}`);
    return true;
  };
  ports.authority.poll = async () => {
    trace.push("poll");
    return { kind: "observed", poll: { status: status() } };
  };

  await runTerminalMonitor({
    initialConversation: waiting,
    expectedTerminalMessageId: "message-1",
    configuration: () => CONFIGURATION,
    lifecycle: { startedRecorded: true },
    ports
  });

  assert.deepEqual(trace.filter((item) =>
    item === "state.load" || item === "sleep" || item === "poll" ||
    item.startsWith("process:") || item.startsWith("present:")
  ), [
    "state.load",
    "process:7331",
    "sleep",
    "state.load",
    "present:conversation_no_longer_waiting"
  ]);
});

test("acceptance reconciliation applies every terminal outcome before lock release", async () => {
  for (const outcome of ["not_accepted", "uncertain"] as const) {
    const trace: string[] = [];
    const owner = conversation({
      terminal_bridge_submission: {
        message_id: "message-1",
        status: "enter_dispatched",
        dispatcher_pid: 7331
      }
    });
    const ports = fakePorts(trace, owner);
    ports.authority.markAcceptanceUncertain = ({ conversation: current }) => {
      trace.push("uncertain.write");
      return current;
    };
    ports.authority.reconcileAcceptance = (input) =>
      reconcileMonitorAcceptance({
        terminalControl: input.terminalControl,
        acquireTerminal: () => {
          trace.push("terminal.acquire");
          return () => trace.push("terminal.release");
        },
        reconcile: async () => {
          trace.push("acceptance.reconcile");
          if (outcome === "uncertain") {
            throw new Error("acceptance failed");
          }
          return { outcome: "not_accepted", conversation: owner };
        },
        apply: input.apply,
        recover: input.recover
      });

    await runTerminalMonitor({
      initialConversation: owner,
      expectedTerminalMessageId: "message-1",
      configuration: () => CONFIGURATION,
      lifecycle: { startedRecorded: true },
      ports
    });

    assert.deepEqual(trace.filter((item) =>
      item.startsWith("terminal.") ||
      item === "acceptance.reconcile" ||
      item === "uncertain.write" ||
      item.startsWith("present:submission_")
    ), outcome === "not_accepted"
      ? [
          "terminal.acquire",
          "acceptance.reconcile",
          "present:submission_not_accepted",
          "terminal.release"
        ]
      : [
          "terminal.acquire",
          "acceptance.reconcile",
          "uncertain.write",
          "present:submission_uncertain",
          "terminal.release"
        ]);
  }
});

test("pending acceptance releases the terminal lock before poll backoff", async () => {
  const trace: string[] = [];
  const owner = conversation({
    terminal_bridge_submission: {
      message_id: "message-1",
      status: "enter_dispatched",
      dispatcher_pid: 7331
    }
  });
  const stopped = { ...owner, status: "idle" as const };
  const ports = fakePorts(trace, owner);
  let loads = 0;
  ports.state.load = () => loads++ === 0 ? owner : stopped;
  ports.authority.reconcileAcceptance = (input) =>
    reconcileMonitorAcceptance({
      terminalControl: input.terminalControl,
      acquireTerminal: () => {
        trace.push("terminal.acquire");
        return () => trace.push("terminal.release");
      },
      reconcile: async () => {
        trace.push("acceptance.reconcile");
        return { outcome: "pending" };
      },
      apply: input.apply,
      recover: input.recover
    });

  await runTerminalMonitor({
    initialConversation: owner,
    expectedTerminalMessageId: "message-1",
    configuration: () => CONFIGURATION,
    lifecycle: { startedRecorded: true },
    ports
  });

  assert.deepEqual(trace.filter((item) =>
    item.startsWith("terminal.") || item === "acceptance.reconcile" ||
    item === "sleep"
  ), [
    "terminal.acquire",
    "acceptance.reconcile",
    "terminal.release",
    "sleep"
  ]);
});

test("one poll snapshot feeds diagnostics, approval, completion, and timeout", async () => {
  const trace: string[] = [];
  const owner = conversation();
  const ports = fakePorts(trace, owner);
  let polls = 0;
  ports.authority.poll = async () => {
    const cycle = ++polls;
    trace.push(`poll:${cycle}`);
    const terminalStatus = {
      ...status(),
      screen: {
        get digest() {
          trace.push(`screen:${cycle}`);
          return "screen-1";
        }
      }
    };
    const completion = {
      ...COMPLETION,
      get metadata() {
        trace.push(`metadata:${cycle}`);
        return { context_match: "exact" };
      }
    };
    return {
      kind: "observed",
      poll: {
        get status() {
          trace.push(`status:${cycle}`);
          return terminalStatus;
        },
        completion
      }
    };
  };

  await runTerminalMonitor({
    initialConversation: owner,
    expectedTerminalMessageId: "message-1",
    configuration: () => CONFIGURATION,
    lifecycle: { startedRecorded: true },
    ports
  });

  assert.deepEqual(trace.filter((item) =>
    /^(poll|status|screen|metadata):/u.test(item)
  ), [
    "poll:1",
    "status:1",
    "screen:1",
    "metadata:1",
    "metadata:1",
    "metadata:1",
    "metadata:1",
    "poll:2",
    "status:2",
    "screen:2",
    "metadata:2",
    "metadata:2",
    "metadata:2",
    "metadata:2"
  ]);
});

test("verified death probe runs before a fresh timeout clock read", async () => {
  const trace: string[] = [];
  const owner = conversation();
  const ports = fakePorts(trace, owner);
  const clock = [0, 70_000];
  ports.runtime.nowMs = () => {
    const value = clock.shift() ?? 70_000;
    trace.push(`clock.nowMs:${value}`);
    return value;
  };
  ports.authority.poll = async () => {
    trace.push("poll");
    return { kind: "observed", poll: { status: status() } };
  };

  await runTerminalMonitor({
    initialConversation: owner,
    expectedTerminalMessageId: "message-1",
    configuration: () => ({ ...CONFIGURATION, hardTimeoutMinutes: 1 }),
    lifecycle: { startedRecorded: true },
    ports
  });

  const selected = trace.filter((item) =>
    item === "poll" || item === "death.verify" ||
    item === "clock.nowMs:70000" || item === "state.markStalled" ||
    item === "event:terminal_bridge_hard_timeout_reached"
  );
  assert.deepEqual(selected, [
    "poll",
    "death.verify",
    "clock.nowMs:70000",
    "event:terminal_bridge_hard_timeout_reached",
    "state.markStalled"
  ]);
});

test("question and error approval paths retain their opposite fingerprint/event order", async () => {
  for (const kind of ["question", "error"] as const) {
    const trace: string[] = [];
    const owner = conversation();
    const ports = fakePorts(trace, owner);
    const approval = {
      scanned: true,
      blocked: true,
      approvable: kind === "question",
      get fingerprint() {
        trace.push("fingerprint.read");
        return "approval-fingerprint";
      }
    } as TerminalBridgeStatus["approval_state"];
    ports.authority.poll = async () => ({
      kind: "observed",
      poll: { status: status(approval) }
    });

    await runTerminalMonitor({
      initialConversation: owner,
      expectedTerminalMessageId: "message-1",
      configuration: () => CONFIGURATION,
      lifecycle: { startedRecorded: true },
      ports
    });

    const eventIndex = trace.findIndex((item) =>
      item.startsWith("event:terminal_bridge_approval_")
    );
    const reads = trace
      .map((item, index) => item === "fingerprint.read" ? index : -1)
      .filter((index) => index >= 0);
    assert.ok(eventIndex >= 0);
    if (kind === "question") {
      assert.ok(reads.length >= 2);
      assert.ok(reads.at(-1)! < eventIndex);
    } else {
      assert.equal(reads.length, 1);
      assert.ok(eventIndex < reads[0]);
    }
    assert.ok(eventIndex < trace.indexOf("approval.record"));
  }
});

test("approval adapter maps the executor actor into callback preparation", () => {
  const owner = conversation();
  let preparedActor: string | undefined;
  const result = recordMonitorApprovalNotification({
    conversation: owner,
    executor: owner.executor,
    terminalControl: CONTROL,
    terminalStatus: status(),
    currentMessageId: "message-1",
    fingerprint: "approval-1",
    kind: "question",
    ports: {
      record: ({ onRecorded }) => ({
        conversation: owner,
        duplicate: false,
        stale: false,
        recorded: onRecorded(owner)
      }),
      prepare: (input) => {
        preparedActor = input.actor;
        return { prepared: fakePrepared(owner) };
      },
      approvalInstructions: () => "approve?",
      approvalCandidate: () => ({ request_id: "request-1" })
    }
  });

  assert.equal(preparedActor, "codex");
  assert.equal(result.recorded?.prepared?.conversation, owner);
});

test("raw lock timeout retries outside the service without duplicating monitor start", async () => {
  const trace: string[] = [];
  const owner = conversation();
  const lifecycle = { startedRecorded: false };
  const ports = fakePorts(trace, owner);
  let bindingChecks = 0;
  ports.authority.assertBindingCurrent = () => {
    trace.push("binding.assert");
    if (++bindingChecks === 1) {
      throw Object.assign(new Error("raw file lock timeout"), {
        code: "LOCK_TIMEOUT"
      });
    }
  };
  ports.authority.storeOperationTimeout = terminalMonitorStoreOperationTimeout;
  ports.authority.poll = async () => ({
    kind: "fenced",
    ledgerStatus: "prepared"
  });

  await runTerminalMonitorWithStoreDeferral({
    initialConversation: owner,
    terminalMessageId: "message-1",
    run: () => runTerminalMonitor({
      initialConversation: owner,
      expectedTerminalMessageId: "message-1",
      configuration: () => CONFIGURATION,
      lifecycle,
      ports
    }).then(() => undefined),
    ports: {
      state: ports.state,
      authority: {
        terminalControl: ports.authority.terminalControl,
        bindingSuperseded: ports.authority.bindingSuperseded,
        storeOperationTimeout: ports.authority.storeOperationTimeout
      },
      runtime: ports.runtime,
      presentation: ports.presentation
    }
  });

  assert.equal(lifecycle.startedRecorded, true);
  assert.equal(
    trace.filter((item) =>
      item === "event:terminal_bridge_monitor_started"
    ).length,
    1
  );
  assert.ok(trace.includes("log:terminal_bridge_monitor_binding_check_failed"));
  assert.ok(trace.includes("log:terminal_bridge_monitor_store_operation_deferred"));
  assert.ok(!trace.includes("log:terminal_bridge_monitor_binding_check_deferred"));
});

test("prepared recovery releases state, writer, and terminal locks in legacy order", async () => {
  const trace: string[] = [];
  const owner = conversation({
    terminal_bridge_submission: {
      message_id: "message-1",
      status: "prepared",
      prepared_at: "1970-01-01T00:00:00.000Z"
    }
  });

  const recovered = await recoverPreparedMonitorSubmission({
    conversation: owner,
    statePath: "/store/state.json",
    logPath: "/store/events.ndjson",
    terminalControl: CONTROL,
    currentMessageId: "message-1",
    dispatcherPid: 7331,
    ports: {
      acquireTerminal: () => {
        trace.push("terminal.acquire");
        return () => trace.push("terminal.release");
      },
      withWriter: async (use) => {
        trace.push("writer.acquire");
        try {
          return await use();
        } finally {
          trace.push("writer.release");
        }
      },
      acquireState: () => {
        trace.push("state.acquire");
        return () => trace.push("state.release");
      },
      loadConversation: () => {
        trace.push("state.load");
        return owner;
      },
      loadLedger: () => {
        trace.push("ledger.load");
        return {
          message_id: "message-1",
          status: "submitted",
          submitted_at: "1970-01-01T00:00:01.000Z"
        };
      },
      saveLedger: () => trace.push("ledger.save"),
      saveConversation: () => trace.push("state.save"),
      submission: (candidate) => {
        trace.push("submission.read");
        const takeover = isRecord(candidate.native_session_takeover)
          ? candidate.native_session_takeover
          : undefined;
        return isRecord(takeover?.terminal_bridge_submission)
          ? takeover.terminal_bridge_submission
          : undefined;
      },
      applySubmission: (mutation) => {
        trace.push(`submission.apply:${mutation.status}`);
        return {
          ...mutation.conversation,
          native_session_takeover: {
            ...(isRecord(mutation.conversation.native_session_takeover)
              ? mutation.conversation.native_session_takeover
              : {}),
            terminal_bridge_submission: {
              message_id: mutation.messageId,
              status: mutation.status
            }
          }
        };
      },
      requestFingerprint: () => "request-hash",
      now: () => new Date(0),
      appendEvent: () => trace.push("event"),
      stallCollateral: () => trace.push("collateral")
    }
  });

  assert.equal(
    (recovered.native_session_takeover as Record<string, unknown>)
      .terminal_bridge_submission instanceof Object,
    true
  );
  assert.deepEqual(trace, [
    "terminal.acquire",
    "writer.acquire",
    "ledger.load",
    "state.acquire",
    "state.load",
    "submission.read",
    "submission.apply:submitted",
    "state.save",
    "state.release",
    "submission.read",
    "writer.release",
    "terminal.release"
  ]);
});

test("fresh poll retry releases the terminal lock and performs no terminal I/O", async () => {
  const trace: string[] = [];
  const listed = conversation();
  const changed = { ...listed, updated_at: "1970-01-01T00:00:01.000Z" };
  const result = await pollTerminalMonitor({
    conversation: listed,
    terminalControl: CONTROL,
    currentMessageId: "message-1",
    executor: listed.executor,
    screenChangedSinceSend: false,
    scrollbackLines: 120,
    terminalBridge: {
      monitorPoll: async () => {
        trace.push("terminal.poll");
        return { status: status() } as TerminalMonitorPoll;
      }
    } as never,
    onFenced: () => trace.push("present:fenced"),
    ports: {
      acquireTerminal: () => {
        trace.push("terminal.acquire");
        return () => trace.push("terminal.release");
      },
      reconcileLedger: () => undefined,
      loadLedger: () => undefined,
      saveLedger: () => trace.push("ledger.save"),
      submission: () => undefined,
      loadConversation: () => changed,
      terminalControl: () => CONTROL,
      sameIncarnation: () => true,
      runtime: () => ({ pid: 4242 }),
      durableRequest: () => ({ context: {} }),
      appendEvent: () => trace.push("event"),
      now: () => new Date(0)
    }
  });

  assert.deepEqual(result, { kind: "retry", conversation: changed });
  assert.deepEqual(trace, ["terminal.acquire", "terminal.release"]);
});

test("dispatch fencing is presented before the poll terminal lock releases", async () => {
  const trace: string[] = [];
  const owner = conversation();
  const result = await pollTerminalMonitor({
    conversation: owner,
    terminalControl: CONTROL,
    currentMessageId: "message-1",
    executor: owner.executor,
    screenChangedSinceSend: false,
    scrollbackLines: 120,
    terminalBridge: {} as never,
    onFenced: () => trace.push("present:fenced"),
    ports: {
      acquireTerminal: () => {
        trace.push("terminal.acquire");
        return () => trace.push("terminal.release");
      },
      reconcileLedger: (_control, ledger) => ledger,
      loadLedger: () => ({
        message_id: "message-1",
        status: "uncertain"
      }),
      saveLedger: () => trace.push("ledger.save"),
      submission: () => undefined,
      loadConversation: () => owner,
      terminalControl: () => CONTROL,
      sameIncarnation: () => true,
      runtime: () => ({ pid: 4242 }),
      durableRequest: () => ({ context: {} }),
      appendEvent: () => trace.push("event:fenced"),
      now: () => new Date(0)
    }
  });

  assert.deepEqual(result, { kind: "fenced", ledgerStatus: "uncertain" });
  assert.deepEqual(trace, [
    "terminal.acquire",
    "event:fenced",
    "present:fenced",
    "terminal.release"
  ]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { callbackRouteFingerprintForConversation } from
  "../src/callback-route-authority.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import type { Conversation } from "../src/protocol.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "../src/terminal-agent-adapter.js";
import {
  terminalMonitorReconciliationEligibility,
  type TerminalMonitorEligibilityObservation,
  type TerminalMonitorEligibilityRequest
} from "../src/terminal-monitor-reconciliation-eligibility.js";
import { captureCodexRolloutAcceptanceAnchor } from
  "../src/terminal-submission-acceptance.js";
import {
  fingerprint,
  validateCodexRolloutAcceptanceAnchor
} from "../src/terminal-submission-facts.js";

const terminalControl: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.1",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4200,
  currentPath: "/repo/project",
  capabilities: ["screen_status"]
};
const legacyAnchor = captureCodexRolloutAcceptanceAnchor({
  processUuid: "codex-process-1",
  processBirth: "codex-birth-1",
  mode: "pre_materialization",
  expectedEmptyNativeSession: true,
  now: new Date("2026-08-14T00:00:00.000Z")
});
const exactNativeThreadId = "0198a050-3e9b-72b0-8000-000000000001";

function fingerprintedAnchor(base: Record<string, unknown>) {
  return { ...base, anchor_fingerprint: fingerprint(base) };
}

function candidateSetAnchor(
  rolloutField: Record<string, unknown>,
  overrides: Record<string, unknown> = {}
) {
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor",
    version: 3,
    process_uuid: "codex-process-1",
    process_birth: "codex-birth-1",
    captured_at: "2026-08-14T00:00:00.000Z",
    mode: "candidate_set",
    native_thread_binding: "post_submission",
    file_existed: false,
    offset_bytes: 0,
    zero_file_baseline: false,
    inventory_pid: 4201,
    inventory_fingerprint: "a".repeat(64),
    candidate_rollouts: [{
      native_thread_id: exactNativeThreadId,
      offset_bytes: 0,
      ...rolloutField
    }],
    ...overrides
  };
  return fingerprintedAnchor(base);
}

function boundAnchor(rolloutField: Record<string, unknown>) {
  const base = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor",
    version: 1,
    native_thread_id: exactNativeThreadId,
    process_uuid: "codex-process-1",
    process_birth: "codex-birth-1",
    captured_at: "2026-08-14T00:00:00.000Z",
    mode: "existing",
    file_existed: true,
    offset_bytes: 0,
    ...rolloutField
  };
  return fingerprintedAnchor(base);
}

function assertControlledDecoderError(value: unknown, message: string) {
  assert.throws(
    () => validateCodexRolloutAcceptanceAnchor(value),
    (error: unknown) => {
      assert.equal(error instanceof TypeError, false);
      assert.ok(error instanceof Error);
      assert.equal(error.name, "Error");
      assert.equal(error.message, message);
      return true;
    }
  );
}

interface FixtureOptions {
  conversation?: Record<string, unknown>;
  takeover?: Record<string, unknown>;
  status?: Conversation["status"];
  statePath?: string;
  conversationStoreDir?: string | null;
  control?: TerminalControlRef | null;
  storeDir?: string | null;
  storeError?: Error;
  ledger?: Record<string, unknown> | null;
  ledgerStatePathError?: Error;
  submission?: Record<string, unknown>;
  runtime?: TerminalRuntimeIdentity;
  transfer?: Partial<DeferredForegroundTransfer>;
  invalidDeadline?: boolean;
}

interface ReadCounts {
  control: number;
  dispatch: number;
  store: number;
  submission: number;
  runtime: number;
  deferred: number;
  deadline: number;
}

function dispatchLedger(overrides: Record<string, unknown> = {}) {
  return {
    status: "enter_dispatched",
    message_id: "message-1",
    conversation_id: "turn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    state_path: "/store/state.json",
    store_dir: "/store",
    binding_id: "binding-1",
    binding_generation: 3,
    terminal_control: terminalControl,
    ...overrides
  };
}

function fixture(options: FixtureOptions = {}) {
  const reads: ReadCounts = {
    control: 0,
    dispatch: 0,
    store: 0,
    submission: 0,
    runtime: 0,
    deferred: 0,
    deadline: 0
  };
  const propertyTrace: string[] = [];
  const deadlineTrace: string[] = [];
  const takeover: Record<string, unknown> = {
    terminal_bridge: true,
    terminal_bridge_message_id: "message-1",
    terminal_bridge_inactivity_timeout_minutes: 60,
    terminal_bridge_hard_timeout_minutes: 720,
    ...options.takeover
  };
  Object.defineProperties(takeover, {
    terminal_bridge_submission: {
      enumerable: true,
      get() {
        reads.submission += 1;
        return options.submission ?? {
          message_id: "message-1",
          status: "enter_dispatched"
        };
      }
    },
    terminal_bridge_started_at: deadline("started", "2026-08-14T00:00:00.000Z"),
    terminal_bridge_last_activity_at: deadline(
      "last_activity", "2026-08-14T00:01:00.000Z"
    ),
    terminal_bridge_inactivity_deadline_at: deadline(
      "inactivity_deadline",
      options.invalidDeadline ? "invalid" : "2026-08-14T01:01:00.000Z"
    ),
    terminal_bridge_hard_deadline_at: deadline(
      "hard_deadline", "2026-08-14T12:00:00.000Z"
    )
  });
  function deadline(label: string, value: string) {
    return {
      enumerable: true,
      get() {
        reads.deadline += 1;
        deadlineTrace.push(`get:${label}`);
        return {
          [Symbol.toPrimitive]() {
            deadlineTrace.push(`validate:${label}`);
            return value;
          }
        };
      }
    };
  }
  const conversation = {
    session_id: "session-1",
    turn_id: "turn-1",
    conversation_id: "turn-1",
    status: options.status ?? "waiting_for_agent",
    state_path: options.statePath ?? "/store/state.json",
    ...(options.conversationStoreDir === null
      ? {}
      : { store_dir: options.conversationStoreDir ?? "/store" }),
    terminal_binding_id: "binding-1",
    terminal_binding_generation: 3,
    ...options.conversation,
    native_session_takeover: takeover
  } as unknown as Conversation;
  const rawLedger = options.ledger === null
    ? undefined
    : options.ledger ?? dispatchLedger();
  const ledger = rawLedger
    ? Object.defineProperties({}, Object.getOwnPropertyDescriptors(rawLedger)) as
      Record<string, unknown>
    : undefined;
  if (ledger) {
    const statePath = Object.getOwnPropertyDescriptor(rawLedger, "state_path")?.value;
    Object.defineProperty(ledger, "state_path", {
      enumerable: true,
      get() {
        propertyTrace.push("ledger.state_path");
        if (options.ledgerStatePathError) throw options.ledgerStatePathError;
        return statePath;
      }
    });
  }
  const observations = {
    control: () => {
      reads.control += 1;
      return {
        kind: "control" as const,
        terminalControl: options.control === null ? undefined : terminalControl
      };
    },
    dispatch: () => {
      reads.dispatch += 1;
      return { kind: "dispatch" as const, ledger };
    },
    store: () => {
      reads.store += 1;
      if (options.storeError) {
        throw options.storeError;
      }
      return {
        kind: "store" as const,
        storeDir: options.storeDir === null ? undefined : "/store"
      };
    },
    runtime: () => {
      reads.runtime += 1;
      return {
        kind: "runtime" as const,
        runtime: options.runtime ?? { pid: 4201, cwd: "/repo/project" }
      };
    },
    deferred: () => {
      reads.deferred += 1;
      return {
        kind: "deferred" as const,
        transfer: {
          status: "resolved",
          ...options.transfer
        } as DeferredForegroundTransfer
      };
    }
  };
  return {
    conversation, takeover, reads, observations, propertyTrace, deadlineTrace
  };
}

function decide(
  candidate: ReturnType<typeof fixture>,
  allowed: TerminalMonitorEligibilityRequest["kind"][]
) {
  const generator = terminalMonitorReconciliationEligibility(candidate.conversation);
  const trace: string[] = [];
  let step = generator.next();
  while (!step.done) {
    const request = step.value;
    trace.push(request.kind);
    assert.equal(request.kind, allowed.shift(), "unexpected observation request");
    const observation = candidate.observations[request.kind]();
    step = generator.next(observation as TerminalMonitorEligibilityObservation);
  }
  assert.deepEqual(allowed, []);
  return { result: step.value, trace };
}

test("startup monitor reuses the shared waiting status policy before observations", () => {
  const cases: Array<[Conversation["status"], boolean]> = [
    ["created", true],
    ["running", true],
    ["waiting_for_agent", true],
    ["cancelling", true],
    ["waiting_for_openclaw", false],
    ["idle", false],
    ["stalled", false],
    ["callback_pending", false],
    ["callback_failed", false],
    ["failed", false],
    ["closed", false],
    ["cancelled", false]
  ];

  for (const [status, waiting] of cases) {
    const candidate = fixture({
      status,
      takeover: { terminal_bridge_message_id: undefined }
    });
    const actual = decide(candidate, waiting ? ["control"] : []);
    assert.deepEqual(actual.result, waiting
      ? { eligible: false, reason: "terminal_bridge_identity_missing" }
      : { eligible: false, reason: `conversation_status_${status}` }, status);
    assert.deepEqual(actual.trace, waiting ? ["control"] : [], status);
    assert.deepEqual(candidate.reads, {
      control: waiting ? 1 : 0,
      dispatch: 0,
      store: 0,
      submission: 0,
      runtime: 0,
      deferred: 0,
      deadline: 0
    }, status);
  }
});

test("startup monitor eligibility preserves candidate priority and lazy short circuits", () => {
  const cases: Array<{
    name: string;
    candidate: ReturnType<typeof fixture>;
    trace: TerminalMonitorEligibilityRequest["kind"][];
    reason: string;
    reads: ReadCounts;
  }> = [
    {
      name: "non bridge wins before every observation",
      candidate: fixture({
        takeover: { terminal_bridge: false },
        statePath: "\0malformed",
        conversationStoreDir: null
      }),
      trace: [],
      reason: "not_terminal_bridge",
      reads: {
        control: 0, dispatch: 0, store: 0, submission: 0,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "status wins before missing identity",
      candidate: fixture({
        status: "failed",
        takeover: { terminal_bridge_message_id: undefined },
        statePath: "\0malformed",
        conversationStoreDir: null
      }),
      trace: [],
      reason: "conversation_status_failed",
      reads: {
        control: 0, dispatch: 0, store: 0, submission: 0,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "identity wins before dispatch and Store",
      candidate: fixture({ control: null }),
      trace: ["control"],
      reason: "terminal_bridge_identity_missing",
      reads: {
        control: 1, dispatch: 0, store: 0, submission: 0,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "missing message still observes terminal control before identity decision",
      candidate: fixture({
        takeover: { terminal_bridge_message_id: undefined }
      }),
      trace: ["control"],
      reason: "terminal_bridge_identity_missing",
      reads: {
        control: 1, dispatch: 0, store: 0, submission: 0,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "dispatch wins before submission runtime deferred and deadline",
      candidate: fixture({
        ledger: { status: "uncertain" },
        submission: { message_id: "message-1", status: "not_accepted" },
        runtime: {},
        takeover: {
          deferred_foreground_transfer_id: "transfer-1",
          codex_rollout_acceptance_anchor: legacyAnchor
        },
        transfer: { status: "uncertain" },
        invalidDeadline: true
      }),
      trace: ["control", "dispatch", "store"],
      reason: "terminal_dispatch_uncertain",
      reads: {
        control: 1, dispatch: 1, store: 1, submission: 0,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "submission wins before runtime deferred and deadline",
      candidate: fixture({
        submission: { message_id: "message-1", status: "not_accepted" },
        runtime: {},
        takeover: {
          deferred_foreground_transfer_id: "transfer-1",
          codex_rollout_acceptance_anchor: legacyAnchor
        },
        transfer: { status: "uncertain" },
        invalidDeadline: true
      }),
      trace: ["control", "dispatch", "store"],
      reason: "terminal_submission_not_accepted",
      reads: {
        control: 1, dispatch: 1, store: 1, submission: 2,
        runtime: 0, deferred: 0, deadline: 0
      }
    },
    {
      name: "runtime wins before deferred and deadline",
      candidate: fixture({
        runtime: {},
        takeover: { deferred_foreground_transfer_id: "transfer-1" },
        transfer: { status: "uncertain" },
        invalidDeadline: true
      }),
      trace: ["control", "dispatch", "store", "runtime"],
      reason: "terminal_agent_identity_missing",
      reads: {
        control: 1, dispatch: 1, store: 1, submission: 2,
        runtime: 1, deferred: 0, deadline: 0
      }
    },
    {
      name: "deferred wins before deadline",
      candidate: fixture({
        takeover: {
          deferred_foreground_transfer_id: "transfer-1",
          codex_rollout_acceptance_anchor: legacyAnchor
        },
        transfer: { status: "uncertain" },
        invalidDeadline: true
      }),
      trace: ["control", "dispatch", "store", "runtime", "store", "deferred"],
      reason: "deferred_foreground_transfer_uncertain",
      reads: {
        control: 1, dispatch: 1, store: 2, submission: 2,
        runtime: 1, deferred: 1, deadline: 0
      }
    },
    {
      name: "deadline is last",
      candidate: fixture({ invalidDeadline: true }),
      trace: ["control", "dispatch", "store", "runtime", "store"],
      reason: "terminal_bridge_deadline_metadata_missing",
      reads: {
        control: 1, dispatch: 1, store: 2, submission: 2,
        runtime: 1, deferred: 0, deadline: 4
      }
    }
  ];
  for (const entry of cases) {
    const actual = decide(entry.candidate, [...entry.trace]);
    assert.deepEqual(actual.result, { eligible: false, reason: entry.reason }, entry.name);
    assert.deepEqual(actual.trace, entry.trace, entry.name);
    assert.deepEqual(entry.candidate.reads, entry.reads, entry.name);
    assert.deepEqual(Object.keys(actual.result), ["eligible", "reason"]);
  }
});

test("startup monitor launch eligibility requests exact stages and omits absent fields", () => {
  const candidate = fixture({
    status: "created",
    takeover: { deferred_foreground_transfer_id: "transfer-1" }
  });
  const actual = decide(candidate, [
    "control", "dispatch", "store", "runtime", "store", "deferred"
  ]);
  assert.deepEqual(actual.trace, [
    "control", "dispatch", "store", "runtime", "store", "deferred"
  ]);
  assert.equal(actual.result.eligible, true);
  assert.deepEqual(Object.keys(actual.result), [
    "eligible",
    "nativeTakeover",
    "terminalMessageId",
    "terminalControl",
    "runtime",
    "inactivityTimeoutMinutes",
    "hardTimeoutMinutes",
    "inactivityDeadlineAtMs",
    "hardDeadlineAtMs"
  ]);
  if (!actual.result.eligible) assert.fail("fixture must be eligible");
  assert.deepEqual(actual.result.runtime, { pid: 4201, cwd: "/repo/project" });
  assert.equal(
    actual.result.inactivityDeadlineAtMs,
    Date.parse("2026-08-14T01:01:00.000Z")
  );
  assert.equal(
    actual.result.hardDeadlineAtMs,
    Date.parse("2026-08-14T12:00:00.000Z")
  );
  assert.equal("reason" in actual.result, false);
  assert.equal(Object.values(actual.result).some((value) => value === undefined), false);
});

test("startup monitor rejects receipt and ledger route authority mismatch", () => {
  const routeA = `sha256:${"a".repeat(64)}`;
  const routeB = `sha256:${"b".repeat(64)}`;
  const cases = [
    {
      ledger: dispatchLedger({ callback_route_fingerprint: routeA }),
      submission: {
        message_id: "message-1",
        status: "enter_dispatched",
        callback_route_fingerprint: routeB
      }
    },
    {
      ledger: dispatchLedger({ callback_route_fingerprint: routeA }),
      submission: { message_id: "message-1", status: "enter_dispatched" }
    },
    {
      ledger: dispatchLedger(),
      submission: {
        message_id: "message-1",
        status: "enter_dispatched",
        callback_route_fingerprint: null
      }
    }
  ];
  for (const entry of cases) {
    const candidate = fixture(entry);
    const actual = decide(candidate, ["control", "dispatch", "store"]);
    assert.deepEqual(actual.result, {
      eligible: false,
      reason: "terminal_dispatch_callback_route_authority_mismatch"
    });
    assert.equal(candidate.reads.runtime, 0);
  }

  const matching = fixture({
    ledger: dispatchLedger({ callback_route_fingerprint: routeA }),
    submission: {
      message_id: "message-1",
      status: "enter_dispatched",
      callback_route_fingerprint: routeA
    }
  });
  assert.equal(decide(matching, [
    "control", "dispatch", "store", "runtime", "store"
  ]).result.eligible, true);
});

test("startup monitor admits only exact callback authority crash windows", () => {
  const callbackFields = {
    gateway_method: "agent-knock-knock.callback",
    gateway_session: "agent:controller:restart"
  };
  const routeAuthority = callbackRouteFingerprintForConversation(callbackFields)!;
  const positive = [
    {
      name: "routed prepared state after ledger-first submitted write",
      conversation: callbackFields,
      submission: { message_id: "message-1", status: "prepared" },
      ledger: dispatchLedger({
        status: "submitted",
        callback_route_fingerprint: routeAuthority
      })
    },
    {
      name: "no-route prepared state after ledger-first accepted write",
      submission: { message_id: "message-1", status: "prepared" },
      ledger: dispatchLedger({
        status: "agent_accepted",
        callback_route_fingerprint: null
      })
    },
    {
      name: "routed enter-dispatched state after ledger-first legacy upgrade",
      conversation: callbackFields,
      submission: { message_id: "message-1", status: "enter_dispatched" },
      ledger: dispatchLedger({
        status: "agent_accepted",
        callback_route_fingerprint: routeAuthority
      })
    },
    {
      name: "no-route enter-dispatched state after ledger-first legacy upgrade",
      submission: { message_id: "message-1", status: "enter_dispatched" },
      ledger: dispatchLedger({
        status: "agent_accepted",
        callback_route_fingerprint: null
      })
    },
    {
      name: "routed accepted state after state-first acceptance write",
      conversation: callbackFields,
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: routeAuthority
      },
      ledger: dispatchLedger({ status: "enter_dispatched" })
    },
    {
      name: "no-route accepted state after state-first acceptance write",
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: null
      },
      ledger: dispatchLedger({ status: "enter_dispatched" })
    },
    {
      name: "routed accepted state after state-first accepted-ledger upgrade",
      conversation: callbackFields,
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: routeAuthority
      },
      ledger: dispatchLedger({ status: "agent_accepted" })
    },
    {
      name: "no-route accepted state after state-first accepted-ledger upgrade",
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: null
      },
      ledger: dispatchLedger({ status: "agent_accepted" })
    }
  ];
  for (const entry of positive) {
    const candidate = fixture(entry);
    const actual = decide(candidate, [
      "control", "dispatch", "store", "runtime", "store"
    ]);
    assert.equal(actual.result.eligible, true, entry.name);
  }

  const negative = [
    {
      name: "prepared ledger authority redirects from the current route",
      conversation: callbackFields,
      submission: { message_id: "message-1", status: "prepared" },
      ledger: dispatchLedger({
        status: "submitted",
        callback_route_fingerprint: `sha256:${"b".repeat(64)}`
      })
    },
    {
      name: "prepared exception excludes enter-dispatched ledger",
      submission: { message_id: "message-1", status: "prepared" },
      ledger: dispatchLedger({
        status: "enter_dispatched",
        callback_route_fingerprint: null
      })
    },
    {
      name: "prepared exception excludes a different receipt message",
      submission: { message_id: "message-2", status: "prepared" },
      ledger: dispatchLedger({
        status: "submitted",
        callback_route_fingerprint: null
      })
    },
    {
      name: "lagging accepted ledger redirects from the current route",
      conversation: callbackFields,
      submission: { message_id: "message-1", status: "enter_dispatched" },
      ledger: dispatchLedger({
        status: "agent_accepted",
        callback_route_fingerprint: `sha256:${"b".repeat(64)}`
      })
    },
    {
      name: "accepted state authority redirects from the current route",
      conversation: callbackFields,
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: `sha256:${"b".repeat(64)}`
      },
      ledger: dispatchLedger({ status: "enter_dispatched" })
    },
    {
      name: "accepted exception excludes submitted ledger",
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: null
      },
      ledger: dispatchLedger({ status: "submitted" })
    },
    {
      name: "lagging accepted exception excludes submitted state",
      submission: { message_id: "message-1", status: "submitted" },
      ledger: dispatchLedger({
        status: "agent_accepted",
        callback_route_fingerprint: null
      })
    },
    {
      name: "accepted exception excludes malformed declared authority",
      submission: {
        message_id: "message-1",
        status: "agent_accepted",
        callback_route_fingerprint: "invalid"
      },
      ledger: dispatchLedger({ status: "enter_dispatched" })
    }
  ];
  for (const entry of negative) {
    const candidate = fixture(entry);
    const actual = decide(candidate, ["control", "dispatch", "store"]);
    assert.deepEqual(actual.result, {
      eligible: false,
      reason: "terminal_dispatch_callback_route_authority_mismatch"
    }, entry.name);
    assert.equal(candidate.reads.runtime, 0, entry.name);
  }
});

test("startup monitor reads dispatch state path only after prior identity predicates", () => {
  const cases = [
    {
      name: "missing ledger", ledger: null,
      reason: "terminal_dispatch_missing_or_generation_replaced"
    },
    {
      name: "message", ledger: dispatchLedger({ message_id: "other" }),
      reason: "terminal_dispatch_enter_dispatched"
    },
    {
      name: "control",
      ledger: dispatchLedger({
        terminal_control: { ...terminalControl, target: "other:0.1" }
      }),
      reason: "terminal_dispatch_enter_dispatched"
    },
    {
      name: "conversation", ledger: dispatchLedger({ conversation_id: "other" }),
      reason: "terminal_dispatch_enter_dispatched"
    },
    {
      name: "session", ledger: dispatchLedger({ session_id: "other" }),
      reason: "terminal_dispatch_enter_dispatched"
    },
    {
      name: "turn", ledger: dispatchLedger({ turn_id: "other" }),
      reason: "terminal_dispatch_enter_dispatched"
    }
  ] as const;
  for (const entry of cases) {
    const candidate = fixture({
      ledger: entry.ledger,
      ledgerStatePathError: new Error("state_path getter observed")
    });
    const actual = decide(candidate, ["control", "dispatch", "store"]);
    assert.deepEqual(actual.result, {
      eligible: false,
      reason: entry.reason
    }, entry.name);
    assert.deepEqual(Object.keys(actual.result), ["eligible", "reason"], entry.name);
    assert.deepEqual(candidate.propertyTrace, [], entry.name);
  }

  const candidate = fixture({
    ledgerStatePathError: new Error("state_path getter observed")
  });
  assert.throws(
    () => decide(candidate, ["control", "dispatch", "store"]),
    { message: "state_path getter observed" }
  );
  assert.deepEqual(candidate.propertyTrace, ["ledger.state_path"]);
});

test("startup monitor evaluates all deadline validators in exact order", () => {
  const expectedTrace = [
    "get:started", "validate:started",
    "get:last_activity", "validate:last_activity",
    "get:inactivity_deadline", "validate:inactivity_deadline",
    "get:hard_deadline", "validate:hard_deadline"
  ];
  const candidates = [
    fixture({ invalidDeadline: true }),
    fixture({ takeover: { terminal_bridge_inactivity_timeout_minutes: 0 } })
  ];
  for (const candidate of candidates) {
    const actual = decide(candidate, [
      "control", "dispatch", "store", "runtime", "store"
    ]);
    assert.deepEqual(actual.result, {
      eligible: false,
      reason: "terminal_bridge_deadline_metadata_missing"
    });
    assert.deepEqual(candidate.deadlineTrace, expectedTrace);
  }
});

test("startup monitor derives Store before classifying an invalid dispatch ledger", () => {
  const candidate = fixture({
    ledger: { status: "uncertain" },
    statePath: "\0malformed",
    conversationStoreDir: null,
    storeError: new Error("malformed state path")
  });
  assert.throws(
    () => decide(candidate, ["control", "dispatch", "store"]),
    /malformed state path/u
  );
  assert.deepEqual(candidate.reads, {
    control: 1,
    dispatch: 1,
    store: 1,
    submission: 0,
    runtime: 0,
    deferred: 0,
    deadline: 0
  });
});

test("Codex anchor decoder rejects non-record rollout fields without TypeError", () => {
  const validRollout = {
    fd: "12u",
    device: "16777231",
    inode: "42001",
    path: "/tmp/rollout.jsonl"
  };
  const rolloutCases = [
    { name: "missing", field: {} },
    { name: "null", field: { rollout: null } },
    { name: "primitive", field: { rollout: 42 } }
  ];

  assertControlledDecoderError(
    candidateSetAnchor(
      { rollout: validRollout },
      { inventory_cwd: 4201 }
    ),
    "candidate-set Codex acceptance anchor is inconsistent"
  );
  for (const entry of rolloutCases) {
    assertControlledDecoderError(
      candidateSetAnchor(entry.field),
      "Codex candidate-set rollout entry is invalid"
    );
    assertControlledDecoderError(
      boundAnchor(entry.field),
      "Codex rollout acceptance anchor file state is inconsistent"
    );
  }
});

test("startup monitor eligibility rejects out-of-order observations explicitly", () => {
  const candidate = fixture();
  const generator = terminalMonitorReconciliationEligibility(candidate.conversation);
  const first = generator.next();
  assert.equal(first.done, false);
  assert.equal(first.value.kind, "control");
  if (first.value.kind === "control") {
    assert.equal(first.value.nativeTakeover, candidate.takeover);
  }
  assert.throws(
    () => generator.next({ kind: "dispatch", ledger: {} }),
    {
      name: "Error",
      message: "terminal monitor eligibility expected control observation"
    }
  );

  const missing = terminalMonitorReconciliationEligibility(candidate.conversation);
  const missingFirst = missing.next();
  assert.equal(missingFirst.done, false);
  assert.equal(missingFirst.value.kind, "control");
  assert.throws(
    () => missing.next(undefined as never),
    {
      name: "Error",
      message: "terminal monitor eligibility expected control observation"
    }
  );
});

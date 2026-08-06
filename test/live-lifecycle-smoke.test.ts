import test from "node:test";
import assert from "node:assert/strict";
import {
  AkkClientInvocationError,
  runLifecycleMatrix,
  runLifecycleScenario,
  type AkkClient,
  type AkkInvocationOptions,
  type LifecycleScenarioConfig,
  type LifecycleSmokeAgent
} from "../src/live-lifecycle-smoke.js";

const THREAD_A = "11111111-1111-4111-8111-111111111111";
const THREAD_B = "22222222-2222-4222-8222-222222222222";
const SESSION_A = "session-a";
const SESSION_A_MATERIALIZED = "session-a-materialized";
const SESSION_B = "session-b";
const TURN_B = "turn-b-1";
const STATE_PATH = "/private/akk/session-b/state.json";
const EVENT_LOG_PATH = "/private/akk/session-b/events.jsonl";

interface ScriptedCall {
  command: string;
  args: string[];
  options: AkkInvocationOptions;
  result?: unknown;
  error?: Error;
}

class ScriptedAkkClient implements AkkClient {
  readonly calls: Array<{
    command: string;
    args: string[];
    options: AkkInvocationOptions;
  }> = [];
  private readonly script: ScriptedCall[];

  constructor(script: readonly ScriptedCall[]) {
    this.script = [...script];
  }

  async invoke(
    command: string,
    args: readonly string[],
    options: AkkInvocationOptions
  ): Promise<unknown> {
    const expected = this.script.shift();
    assert.ok(expected, `unexpected AKK call: ${command} ${args.join(" ")}`);
    assert.equal(command, expected.command);
    assert.deepEqual([...args], expected.args);
    assert.deepEqual(options, expected.options);
    this.calls.push({ command, args: [...args], options: { ...options } });
    if (expected.error) {
      throw expected.error;
    }
    return structuredClone(expected.result);
  }

  assertComplete(): void {
    assert.equal(
      this.script.length,
      0,
      `${this.script.length} scripted AKK call(s) were not consumed`
    );
  }
}

interface ScenarioFixture {
  config: LifecycleScenarioConfig;
  nonce: string;
  terminalId: string;
  calls: ScriptedCall[];
}

function scenarioFixture(
  agent: LifecycleSmokeAgent,
  { managedStart = false }: { managedStart?: boolean } = {}
): ScenarioFixture {
  const target = agent === "codex" ? "akk:codex.0" : "akk:claude.0";
  const panePid = agent === "codex" ? 4101 : 4201;
  const agentPid = agent === "codex" ? 5101 : 5201;
  const version = agent === "codex" ? "0.42.0" : "2.7.1";
  const terminalId = `terminal:v2:tmux:${agent}:${target}:${panePid}`;
  const nonce = `nonce-${agent}`;
  const start = terminalRow({
    agent,
    target,
    panePid,
    agentPid,
    version,
    terminalId,
    nativeThreadId: THREAD_A,
    sessionId: managedStart ? SESSION_A : null,
    bindingId: managedStart ? "binding-a-1" : null,
    bindingGeneration: managedStart ? 1 : null,
    bindingFence: managedStart ? "fence-a-1" : "fence-a-unmanaged",
    turnCount: 0
  });
  const afterNew = terminalRow({
    agent,
    target,
    panePid,
    agentPid,
    version,
    terminalId,
    nativeThreadId: THREAD_B,
    sessionId: SESSION_B,
    bindingId: "binding-b-1",
    bindingGeneration: 1,
    bindingFence: "fence-b-1",
    turnCount: 0
  });
  const afterTurn = terminalRow({
    agent,
    target,
    panePid,
    agentPid,
    version,
    terminalId,
    nativeThreadId: THREAD_B,
    sessionId: SESSION_B,
    bindingId: "binding-b-1",
    bindingGeneration: 1,
    bindingFence: "fence-b-after-turn",
    turnCount: 1,
    recentTurn: { conversation_id: TURN_B, status: "idle" }
  });
  const restoredSessionId = managedStart ? SESSION_A : SESSION_A_MATERIALIZED;
  const restoredBindingGeneration = managedStart ? 2 : 1;
  const final = terminalRow({
    agent,
    target,
    panePid,
    agentPid,
    version,
    terminalId,
    nativeThreadId: THREAD_A,
    sessionId: restoredSessionId,
    bindingId: managedStart ? "binding-a-2" : "binding-a-1",
    bindingGeneration: restoredBindingGeneration,
    bindingFence: managedStart ? "fence-a-2" : "fence-a-1",
    turnCount: 0
  });
  const read = { kind: "read" as const, timeoutMs: 60_000 };
  const mutation = { kind: "mutation" as const, timeoutMs: 120_000 };
  const monitor = { kind: "mutation" as const, timeoutMs: 600_000 };
  const calls: ScriptedCall[] = [
    {
      command: "list",
      args: ["--all", "--terminal-debug"],
      options: read,
      result: { terminals: [start] }
    },
    {
      command: "new-thread",
      args: [
        "--terminal",
        terminalId,
        "--expected-binding-token",
        managedStart ? "fence-a-1" : "fence-a-unmanaged",
        "--require-restorable-origin"
      ],
      options: mutation,
      result: transition({
        operation: "new_thread",
        terminalId,
        transitionId: `transition-new-${agent}`,
        previousSessionId: managedStart ? SESSION_A : null,
        sessionId: SESSION_B,
        previousNativeThreadId: THREAD_A,
        nativeThreadId: THREAD_B,
        bindingId: "binding-b-1",
        bindingGeneration: 1
      })
    },
    {
      command: "list",
      args: ["--all", "--terminal-debug"],
      options: read,
      result: { terminals: [afterNew] }
    },
    {
      command: "send",
      args: [
        "--session",
        SESSION_B,
        "--message",
        `AKK lifecycle smoke sentinel ${nonce}: acknowledge completion without modifying files.`,
        "--background",
        "--disable-terminal-bridge-monitor"
      ],
      options: mutation,
      result: {
        session_id: SESSION_B,
        turn_id: TURN_B,
        delivered: true,
        status: "async_pending",
        background: true,
        delivery_receipt: "submitted",
        conversation: {
          session_id: SESSION_B,
          turn_id: TURN_B,
          state_path: STATE_PATH,
          event_log_path: EVENT_LOG_PATH
        }
      }
    },
    {
      command: "monitor",
      args: [
        "--terminal-bridge",
        "--record-only",
        "--state",
        STATE_PATH,
        "--log",
        EVENT_LOG_PATH,
        "--poll-interval-ms",
        "500",
        "--agent-timeout-minutes",
        "5",
        "--agent-hard-timeout-minutes",
        "10"
      ],
      options: monitor,
      result: {
        delivered: false,
        duplicate: false,
        conversation: {
          session_id: SESSION_B,
          turn_id: TURN_B,
          status: "idle",
          state_path: STATE_PATH,
          event_log_path: EVENT_LOG_PATH
        },
        message: {
          type: "done",
          body: `completed ${nonce}`,
          session_id: SESSION_B,
          turn_id: TURN_B
        }
      }
    },
    {
      command: "list",
      args: ["--all", "--terminal-debug"],
      options: read,
      result: { terminals: [afterTurn] }
    },
    {
      command: "list-resumable-threads",
      args: ["--terminal", terminalId],
      options: read,
      result: {
        terminal_id: terminalId,
        agent,
        workspace: "/private/workspace",
        current_session_id: SESSION_B,
        current_native_thread_id: THREAD_B,
        expected_binding_token: "fence-b-after-turn",
        threads: [
          {
            native_thread_id: THREAD_A,
            candidate_token: `candidate-${agent}`,
            active_elsewhere: false,
            resumable: true,
            ...(managedStart ? { managed_session_id: SESSION_A } : {}),
            available_actions: {
              resume_thread: {
                arguments: {
                  terminal_id: terminalId,
                  native_thread_id: THREAD_A,
                  expected_binding_token: "fence-b-after-turn",
                  candidate_token: `candidate-${agent}`
                }
              }
            }
          }
        ]
      }
    },
    {
      command: "resume-thread",
      args: [
        "--terminal",
        terminalId,
        "--native-thread",
        THREAD_A,
        "--expected-binding-token",
        "fence-b-after-turn",
        "--candidate-token",
        `candidate-${agent}`
      ],
      options: mutation,
      result: transition({
        operation: "resume_thread",
        terminalId,
        transitionId: `transition-resume-${agent}`,
        previousSessionId: SESSION_B,
        sessionId: restoredSessionId,
        previousNativeThreadId: THREAD_B,
        nativeThreadId: THREAD_A,
        bindingId: managedStart ? "binding-a-2" : "binding-a-1",
        bindingGeneration: restoredBindingGeneration
      })
    },
    {
      command: "list",
      args: ["--all", "--terminal-debug"],
      options: read,
      result: { terminals: [final] }
    }
  ];
  return {
    config: {
      agent,
      target,
      expectedPanePid: panePid,
      expectedAgentVersion: version
    },
    nonce,
    terminalId,
    calls
  };
}

function terminalRow(input: {
  agent: LifecycleSmokeAgent;
  target: string;
  panePid: number;
  agentPid: number;
  version: string;
  terminalId: string;
  nativeThreadId: string;
  sessionId: string | null;
  bindingId: string | null;
  bindingGeneration: number | null;
  bindingFence: string;
  turnCount: number;
  recentTurn?: Record<string, unknown>;
}): Record<string, unknown> {
  const managed = input.sessionId
    ? {
        session_id: input.sessionId,
        current_turn: null,
        recent_turn: input.recentTurn ?? null,
        history: [],
        turn_count: input.turnCount,
        binding_status: "bound",
        binding_id: input.bindingId,
        binding_generation: input.bindingGeneration,
        binding_token: input.bindingFence,
        native_thread_id: input.nativeThreadId
      }
    : {
        session_id: null,
        current_turn: null,
        recent_turn: null,
        history: [],
        turn_count: input.turnCount
      };
  return {
    id: input.terminalId,
    source: "terminal",
    agent: input.agent,
    process_state: "active",
    pid: input.agentPid,
    workspace: "/private/workspace",
    native_agent_session_id: input.nativeThreadId,
    native_agent_process_uuid: `process-${input.agent}`,
    native_agent_process_birth: input.agent === "claude"
      ? null
      : "2026-08-06T00:00:00.000Z",
    agent_version: input.version,
    native_thread_lifecycle: {
      status: "supported",
      agentVersion: input.version,
      behaviorProfile: `${input.agent}-profile-v1`,
      newThread: true,
      resumeExact: true,
      candidateDiscovery: true
    },
    lifecycle_binding_token: input.bindingFence,
    terminal_control: {
      target: input.target,
      panePid: input.panePid
    },
    approval_state: {
      scanned: true,
      blocked: false,
      approvable: false
    },
    activity_state: "idle",
    management_state: input.sessionId ? "managed" : "unmanaged",
    managed,
    available_actions: {
      new_thread: {
        arguments: {
          terminal_id: input.terminalId,
          expected_binding_token: input.bindingFence
        }
      },
      list_resumable_threads: {
        arguments: { terminal_id: input.terminalId }
      },
      send: input.sessionId
        ? {
            arguments: { session_id: input.sessionId }
          }
        : {
            arguments: { selector: input.terminalId },
            missing_required: ["message"]
          }
    }
  };
}

function transition(input: {
  operation: "new_thread" | "resume_thread";
  terminalId: string;
  transitionId: string;
  previousSessionId: string | null;
  sessionId: string;
  previousNativeThreadId: string;
  nativeThreadId: string;
  bindingId: string;
  bindingGeneration: number;
}): Record<string, unknown> {
  return {
    status: "committed",
    transition_id: input.transitionId,
    operation: input.operation,
    terminal_id: input.terminalId,
    previous_session_id: input.previousSessionId,
    session_id: input.sessionId,
    previous_native_thread_id: input.previousNativeThreadId,
    native_thread_id: input.nativeThreadId,
    binding_id: input.bindingId,
    binding_generation: input.bindingGeneration,
    turn_created: false
  };
}

function dependencies(client: AkkClient, nonces: readonly string[]) {
  const pending = [...nonces];
  let time = 1_786_000_000_000;
  return {
    client,
    now: () => time++,
    sleep: async (milliseconds: number) => {
      time += milliseconds;
    },
    nonce: () => {
      const nonce = pending.shift();
      assert.ok(nonce, "unexpected nonce request");
      return nonce;
    }
  };
}

function rowFrom(call: ScriptedCall): Record<string, any> {
  const root = call.result as { terminals: Array<Record<string, any>> };
  return root.terminals[0];
}

test("runs the strict Codex lifecycle chain once and emits only allowlisted evidence", async () => {
  const fixture = scenarioFixture("codex", { managedStart: false });
  const initialSend = rowFrom(fixture.calls[0]).available_actions.send;
  const candidate = (
    fixture.calls[6].result as { threads: Array<Record<string, unknown>> }
  ).threads[0];
  assert.deepEqual(initialSend.missing_required, ["message"]);
  assert.equal(initialSend.arguments.session_id, undefined);
  assert.equal(candidate.managed_session_id, undefined);
  const client = new ScriptedAkkClient(fixture.calls);
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [fixture.nonce])
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.steps.map((step) => step.name), [
    "preflight",
    "new_thread",
    "send",
    "wait_completion",
    "list_resumable_threads",
    "resume_thread",
    "final_verify"
  ]);
  assert.equal(result.start?.session_id, null);
  assert.equal(result.start?.binding_generation, null);
  assert.equal(result.new_thread?.previous_session_id, null);
  assert.equal(result.active_after_new?.binding_generation, 1);
  assert.deepEqual(result.resume_candidate, {
    native_thread_id: THREAD_A,
    managed_session_id: null,
    exact_candidate_count: 1,
    resumable: true,
    active_elsewhere: false,
    fresh_candidate_token_present: true
  });
  assert.equal(result.turn?.turn_count_after, 1);
  assert.equal(result.resume_thread?.session_id, SESSION_A_MATERIALIZED);
  assert.notEqual(result.resume_thread?.session_id, SESSION_B);
  assert.equal(result.final?.session_id, SESSION_A_MATERIALIZED);
  assert.equal(result.final?.binding_generation, 1);
  assert.equal(client.calls.filter((call) => call.command === "monitor").length, 1);
  assert.equal(client.calls.filter((call) => call.command === "new-thread").length, 1);
  assert.equal(client.calls.filter((call) => call.command === "resume-thread").length, 1);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(fixture.nonce), false);
  assert.equal(serialized.includes(STATE_PATH), false);
  assert.equal(serialized.includes(EVENT_LOG_PATH), false);
  assert.equal(serialized.includes("candidate-codex"), false);
  client.assertComplete();
});

test(
  "materializes a persisted Codex unmanaged origin from the committed New probe",
  async () => {
    const fixture = scenarioFixture("codex", { managedStart: false });
    delete rowFrom(fixture.calls[0]).native_agent_session_id;
    const client = new ScriptedAkkClient(fixture.calls);
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [fixture.nonce])
    );

    assert.equal(result.status, "passed");
    assert.equal(result.start?.native_thread_id, THREAD_A);
    assert.equal(result.start?.session_id, null);
    assert.equal(result.new_thread?.previous_native_thread_id, THREAD_A);
    assert.equal(result.final?.native_thread_id, THREAD_A);
    assert.equal(
      client.calls.filter((call) => call.command === "new-thread").length,
      1
    );
    client.assertComplete();
  }
);

test("missing native identity remains fail-closed outside the deferred Codex origin", async (t) => {
  await t.test("Claude unmanaged preflight", async () => {
    const fixture = scenarioFixture("claude", { managedStart: false });
    rowFrom(fixture.calls[0]).native_agent_session_id = null;
    const client = new ScriptedAkkClient([fixture.calls[0]]);
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [])
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "preflight_native_identity");
    assert.equal(
      client.calls.some((call) => call.command === "new-thread"),
      false
    );
    client.assertComplete();
  });

  await t.test("managed Codex preflight", async () => {
    const fixture = scenarioFixture("codex", { managedStart: true });
    rowFrom(fixture.calls[0]).native_agent_session_id = null;
    const client = new ScriptedAkkClient([fixture.calls[0]]);
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [])
    );

    assert.equal(result.status, "failed");
    assert.equal(result.error_code, "preflight_native_identity");
    assert.equal(
      client.calls.some((call) => call.command === "new-thread"),
      false
    );
    client.assertComplete();
  });

  await t.test("managed Codex snapshot after New", async () => {
    const fixture = scenarioFixture("codex", { managedStart: false });
    rowFrom(fixture.calls[0]).native_agent_session_id = null;
    rowFrom(fixture.calls[2]).native_agent_session_id = null;
    const client = new ScriptedAkkClient(fixture.calls.slice(0, 3));
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [])
    );

    assert.equal(result.status, "uncertain");
    assert.equal(result.error_code, "preflight_native_identity");
    assert.equal(result.start, undefined);
    assert.equal(client.calls.some((call) => call.command === "send"), false);
    client.assertComplete();
  });
});

test("deferred Codex origin identity fails closed on invalid New evidence", async (t) => {
  await t.test("missing previous native thread", async () => {
    const fixture = scenarioFixture("codex");
    rowFrom(fixture.calls[0]).native_agent_session_id = null;
    delete (fixture.calls[1].result as Record<string, unknown>)
      .previous_native_thread_id;
    const client = new ScriptedAkkClient(fixture.calls.slice(0, 2));
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [])
    );

    assert.equal(result.status, "uncertain");
    assert.equal(result.error_code, "new_thread_invalid");
    assert.equal(result.start, undefined);
    assert.equal(
      client.calls.filter((call) => call.command === "new-thread").length,
      1
    );
    assert.equal(client.calls.some((call) => call.command === "send"), false);
    client.assertComplete();
  });

  await t.test("New reports the same native thread before and after", async () => {
    const fixture = scenarioFixture("codex");
    rowFrom(fixture.calls[0]).native_agent_session_id = null;
    (fixture.calls[1].result as Record<string, unknown>)
      .previous_native_thread_id = THREAD_B;
    const client = new ScriptedAkkClient(fixture.calls.slice(0, 3));
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [])
    );

    assert.equal(result.status, "uncertain");
    assert.equal(result.error_code, "new_thread_invalid");
    assert.equal(result.start, undefined);
    assert.equal(
      client.calls.filter((call) => call.command === "new-thread").length,
      1
    );
    assert.equal(client.calls.some((call) => call.command === "send"), false);
    client.assertComplete();
  });
});

test("known Codex origin must match the native thread proved by New", async () => {
  const fixture = scenarioFixture("codex");
  (fixture.calls[1].result as Record<string, unknown>)
    .previous_native_thread_id = "33333333-3333-4333-8333-333333333333";
  const client = new ScriptedAkkClient(fixture.calls.slice(0, 2));
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [])
  );

  assert.equal(result.status, "uncertain");
  assert.equal(result.error_code, "new_thread_invalid");
  assert.equal(result.start?.native_thread_id, THREAD_A);
  assert.equal(
    client.calls.filter((call) => call.command === "new-thread").length,
    1
  );
  assert.equal(client.calls.some((call) => call.command === "send"), false);
  client.assertComplete();
});

test(
  "accepts structurally exact completion when the model does not echo the sentinel",
  async () => {
    const fixture = scenarioFixture("claude");
    const monitor = fixture.calls[4].result as {
      message: Record<string, unknown>;
    };
    monitor.message.body = "Lifecycle probe completed successfully.";
    const client = new ScriptedAkkClient(fixture.calls);
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [fixture.nonce])
    );

    assert.equal(result.status, "passed");
    assert.equal(result.steps.at(3)?.name, "wait_completion");
    assert.equal(result.steps.at(3)?.status, "passed");
    assert.equal(
      client.calls.filter((call) => call.command === "monitor").length,
      1
    );
    assert.equal(
      client.calls.filter((call) => call.command === "resume-thread").length,
      1
    );
    client.assertComplete();
  }
);

test("requires Resume to name the managed B source Session", async () => {
  const fixture = scenarioFixture("codex");
  const resume = fixture.calls[7].result as Record<string, unknown>;
  resume.previous_session_id = null;
  const client = new ScriptedAkkClient(fixture.calls.slice(0, 8));
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [fixture.nonce])
  );

  assert.equal(result.status, "uncertain");
  assert.equal(result.error_code, "resume_thread_invalid");
  assert.equal(result.resume_thread, undefined);
  assert.equal(client.calls.length, 8);
  assert.equal(client.calls.at(-1)?.command, "resume-thread");
  client.assertComplete();
});

test("restores a managed start by reusing its Session at generation plus one", async () => {
  const fixture = scenarioFixture("codex", { managedStart: true });
  const candidate = (
    fixture.calls[6].result as { threads: Array<Record<string, unknown>> }
  ).threads[0];
  assert.equal(candidate.managed_session_id, SESSION_A);
  const client = new ScriptedAkkClient(fixture.calls);
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [fixture.nonce])
  );

  assert.equal(result.status, "passed");
  assert.equal(result.start?.session_id, SESSION_A);
  assert.equal(result.start?.binding_generation, 1);
  assert.equal(result.new_thread?.previous_session_id, SESSION_A);
  assert.equal(result.resume_candidate?.managed_session_id, SESSION_A);
  assert.equal(result.resume_thread?.previous_session_id, SESSION_B);
  assert.equal(result.resume_thread?.session_id, SESSION_A);
  assert.equal(result.final?.session_id, SESSION_A);
  assert.equal(result.final?.binding_generation, 2);
  client.assertComplete();
});

test("accepts a null Claude process birth while fencing on its process UUID", async () => {
  const fixture = scenarioFixture("claude");
  const client = new ScriptedAkkClient(fixture.calls);
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [fixture.nonce])
  );

  assert.equal(result.status, "passed");
  assert.equal(result.start?.process_birth, null);
  assert.equal(result.final?.process_birth, null);
  assert.equal(result.start?.process_uuid, "process-claude");
  client.assertComplete();
});

test("runs the Codex and Claude matrix sequentially", async () => {
  const codex = scenarioFixture("codex");
  const claude = scenarioFixture("claude");
  const client = new ScriptedAkkClient([...codex.calls, ...claude.calls]);
  const result = await runLifecycleMatrix(
    [codex.config, claude.config],
    dependencies(client, [codex.nonce, claude.nonce])
  );

  assert.equal(result.status, "passed");
  assert.deepEqual(result.scenarios.map((entry) => entry.agent), [
    "codex",
    "claude"
  ]);
  assert.equal(result.scenarios.every((entry) => entry.status === "passed"), true);
  client.assertComplete();
});

test("preflight rejects unsafe or incomplete pane state before mutation", async (t) => {
  const cases: Array<{
    name: string;
    errorCode: string;
    mutate: (row: Record<string, any>) => void;
  }> = [
    {
      name: "version drift",
      errorCode: "preflight_agent_version",
      mutate: (row) => { row.agent_version = "unexpected"; }
    },
    {
      name: "working pane",
      errorCode: "preflight_not_idle",
      mutate: (row) => { row.activity_state = "working"; }
    },
    {
      name: "approval scan missing",
      errorCode: "preflight_approval",
      mutate: (row) => { row.approval_state.scanned = false; }
    },
    {
      name: "current turn",
      errorCode: "preflight_unresolved_turn",
      mutate: (row) => { row.managed.current_turn = { status: "running" }; }
    },
    {
      name: "failed callback in history",
      errorCode: "preflight_unresolved_turn",
      mutate: (row) => {
        row.managed.history = [{ status: "callback_failed" }];
      }
    },
    {
      name: "orphan dispatch",
      errorCode: "preflight_management",
      mutate: (row) => { row.orphaned_terminal_dispatch = { status: "uncertain" }; }
    },
    {
      name: "management conflict",
      errorCode: "preflight_management",
      mutate: (row) => {
        row.management_state = "conflict";
        row.management_conflict = { reason: "conflict" };
      }
    },
    {
      name: "unmanaged Session slot omitted",
      errorCode: "preflight_management",
      mutate: (row) => { delete row.managed.session_id; }
    },
    {
      name: "unsupported lifecycle",
      errorCode: "preflight_capability",
      mutate: (row) => { row.native_thread_lifecycle.status = "unsupported"; }
    },
    {
      name: "missing Codex process birth",
      errorCode: "preflight_process_identity",
      mutate: (row) => { row.native_agent_process_birth = null; }
    },
    {
      name: "malformed native thread identity",
      errorCode: "preflight_native_identity",
      mutate: (row) => { row.native_agent_session_id = "not-a-uuid"; }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const fixture = scenarioFixture("codex");
      entry.mutate(rowFrom(fixture.calls[0]));
      const client = new ScriptedAkkClient([fixture.calls[0]]);
      const result = await runLifecycleScenario(
        fixture.config,
        dependencies(client, [])
      );
      assert.equal(result.status, "failed");
      assert.equal(result.error_code, entry.errorCode);
      assert.deepEqual(result.steps.map((step) => step.name), ["preflight"]);
      assert.equal(client.calls.length, 1);
      client.assertComplete();
    });
  }
});

test("preflight rejects every residual unmanaged binding field", async (t) => {
  const residuals: Array<[string, unknown]> = [
    ["session_short_ref", "session-a"],
    ["binding_status", "bound"],
    ["binding_id", "stale-binding"],
    ["binding_generation", 1],
    ["native_thread_id", THREAD_A],
    ["binding_token", "stale-fence"]
  ];

  for (const [field, value] of residuals) {
    await t.test(field, async () => {
      const fixture = scenarioFixture("codex");
      rowFrom(fixture.calls[0]).managed[field] = value;
      const client = new ScriptedAkkClient([fixture.calls[0]]);
      const result = await runLifecycleScenario(
        fixture.config,
        dependencies(client, [])
      );

      assert.equal(result.status, "failed");
      assert.equal(result.error_code, "preflight_management");
      assert.deepEqual(result.steps.map((step) => step.name), ["preflight"]);
      assert.equal(client.calls.length, 1);
      client.assertComplete();
    });
  }
});

test("a mutation failure is uncertain, is never retried, and stops that pane", async (t) => {
  for (const entry of [
    { name: "new-thread", index: 1 },
    { name: "send", index: 3 },
    { name: "resume-thread", index: 7 }
  ]) {
    await t.test(entry.name, async () => {
      const fixture = scenarioFixture("codex");
      fixture.calls[entry.index] = {
        ...fixture.calls[entry.index],
        result: undefined,
        error: new AkkClientInvocationError("timeout")
      };
      const expected = fixture.calls.slice(0, entry.index + 1);
      const client = new ScriptedAkkClient(expected);
      const result = await runLifecycleScenario(
        fixture.config,
        dependencies(client, entry.index >= 3 ? [fixture.nonce] : [])
      );

      assert.equal(result.status, "uncertain");
      assert.equal(result.error_code, "client_timeout");
      assert.equal(result.recovery, "inspect_selected_pane_do_not_retry");
      assert.equal(
        client.calls.filter((call) => call.command === entry.name).length,
        1
      );
      assert.equal(client.calls.length, entry.index + 1);
      client.assertComplete();
    });
  }
});

test("monitor timeout, nonzero, and malformed outcomes are uncertain and never resume", async (t) => {
  for (const failureKind of ["timeout", "nonzero", "malformed"] as const) {
    await t.test(failureKind, async () => {
      const fixture = scenarioFixture("claude");
      fixture.calls[4] = {
        ...fixture.calls[4],
        result: undefined,
        error: new AkkClientInvocationError(failureKind)
      };
      const client = new ScriptedAkkClient(fixture.calls.slice(0, 5));
      const result = await runLifecycleScenario(
        fixture.config,
        dependencies(client, [fixture.nonce])
      );

      assert.equal(result.status, "uncertain");
      assert.equal(result.error_code, `client_${failureKind}`);
      assert.equal(client.calls.filter((call) => call.command === "monitor").length, 1);
      assert.equal(client.calls.some((call) => call.command === "resume-thread"), false);
      client.assertComplete();
    });
  }

  await t.test("malformed success JSON", async () => {
    const fixture = scenarioFixture("codex");
    fixture.calls[4] = { ...fixture.calls[4], result: { delivered: false } };
    const client = new ScriptedAkkClient(fixture.calls.slice(0, 5));
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [fixture.nonce])
    );
    assert.equal(result.status, "uncertain");
    assert.equal(result.error_code, "monitor_invalid");
    assert.equal(client.calls.some((call) => call.command === "resume-thread"), false);
    client.assertComplete();
  });

  await t.test("empty done message", async () => {
    const fixture = scenarioFixture("claude");
    const monitor = fixture.calls[4].result as {
      message: Record<string, unknown>;
    };
    monitor.message.body = "   ";
    const client = new ScriptedAkkClient(fixture.calls.slice(0, 5));
    const result = await runLifecycleScenario(
      fixture.config,
      dependencies(client, [fixture.nonce])
    );
    assert.equal(result.status, "uncertain");
    assert.equal(result.error_code, "monitor_invalid");
    assert.equal(client.calls.some((call) => call.command === "resume-thread"), false);
    client.assertComplete();
  });
});

test("send bookkeeping warning is uncertain and never starts the monitor", async () => {
  const fixture = scenarioFixture("codex");
  const sendResult = fixture.calls[3].result as Record<string, unknown>;
  sendResult.bookkeeping_warning = "post-submit persistence incomplete";
  const client = new ScriptedAkkClient(fixture.calls.slice(0, 4));
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [fixture.nonce])
  );

  assert.equal(result.status, "uncertain");
  assert.equal(result.error_code, "send_uncertain");
  assert.equal(client.calls.filter((call) => call.command === "send").length, 1);
  assert.equal(client.calls.some((call) => call.command === "monitor"), false);
  client.assertComplete();
});

test("identity drift after new-thread is uncertain and prevents send", async () => {
  const fixture = scenarioFixture("codex");
  rowFrom(fixture.calls[2]).pid += 1;
  const client = new ScriptedAkkClient(fixture.calls.slice(0, 3));
  const result = await runLifecycleScenario(
    fixture.config,
    dependencies(client, [])
  );

  assert.equal(result.status, "uncertain");
  assert.equal(result.error_code, "identity_drift");
  assert.equal(client.calls.some((call) => call.command === "send"), false);
  client.assertComplete();
});

test("a partial matrix is failed, while any uncertain scenario dominates", async (t) => {
  await t.test("failed plus passed", async () => {
    const failed = scenarioFixture("codex");
    rowFrom(failed.calls[0]).activity_state = "working";
    const passed = scenarioFixture("claude");
    const client = new ScriptedAkkClient([
      failed.calls[0],
      ...passed.calls
    ]);
    const result = await runLifecycleMatrix(
      [failed.config, passed.config],
      dependencies(client, [passed.nonce])
    );
    assert.equal(result.status, "failed");
    assert.deepEqual(result.scenarios.map((entry) => entry.status), [
      "failed",
      "passed"
    ]);
    client.assertComplete();
  });

  await t.test("uncertain plus passed", async () => {
    const uncertain = scenarioFixture("codex");
    uncertain.calls[1] = {
      ...uncertain.calls[1],
      result: undefined,
      error: new AkkClientInvocationError("nonzero")
    };
    const passed = scenarioFixture("claude");
    const client = new ScriptedAkkClient([
      ...uncertain.calls.slice(0, 2),
      ...passed.calls
    ]);
    const result = await runLifecycleMatrix(
      [uncertain.config, passed.config],
      dependencies(client, [passed.nonce])
    );
    assert.equal(result.status, "uncertain");
    assert.deepEqual(result.scenarios.map((entry) => entry.status), [
      "uncertain",
      "passed"
    ]);
    client.assertComplete();
  });
});

test("matrix refuses duplicate pane selectors before touching either pane", async () => {
  const codex = scenarioFixture("codex");
  const duplicate = {
    ...scenarioFixture("claude").config,
    target: codex.config.target
  };
  const client = new ScriptedAkkClient([]);
  const result = await runLifecycleMatrix(
    [codex.config, duplicate],
    dependencies(client, [])
  );

  assert.equal(result.status, "failed");
  assert.equal(result.scenarios.length, 2);
  assert.equal(
    result.scenarios.every((entry) =>
      entry.status === "failed" &&
      entry.error_code === "configuration_invalid" &&
      entry.steps.length === 1 &&
      entry.steps[0].name === "preflight"
    ),
    true
  );
  assert.equal(client.calls.length, 0);
  client.assertComplete();
});

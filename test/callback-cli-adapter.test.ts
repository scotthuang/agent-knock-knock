import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as callbackCliAdapter from "../src/callback-cli-adapter.js";
import {
  createCallbackCliFacade,
  type CallbackCliDependencies,
  type CallbackCliOptions
} from "../src/callback-cli-adapter.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  createCallbackEnvelope,
  createLegacyOpenClawCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import { createOpenClawManagedCallbackCliAdapter } from
  "../src/openclaw-managed-callback-cli-adapter.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createConversation,
  createMessage,
  type Conversation,
  type ConversationStatus
} from "../src/protocol.js";
import {
  loadState,
  logPathForStatePath,
  pathsForConversation,
  saveState
} from "../src/store.js";

const NOW = new Date("2026-08-20T01:02:03.004Z");
const CALLBACK_ROUTE: CallbackRouteV1 = {
  schema: CALLBACK_ROUTE_SCHEMA,
  version: CALLBACK_ROUTE_VERSION,
  transport: "test_callback_transport_v1",
  profile_id: "test-profile",
  profile_revision: "revision-1",
  controller_session_id: "controller-session",
  capabilities: { wake: false, respond: true }
};

test("OpenClaw managed callback composition resolves one immutable attempt", () => {
  const conversation = createConversation({
    userRequest: "resolve callback composition",
    sessionId: "session-openclaw-composition",
    turnId: "turn-openclaw-composition",
    executorKind: "codex",
    executorSession: "codex-openclaw-composition",
    workspace: "/workspace/project",
    now: NOW
  });
  const message = createMessage({
    conversation,
    id: "message-openclaw-composition",
    from: "codex",
    to: "openclaw",
    type: "done",
    body: "complete",
    requiresResponse: false,
    now: NOW
  });
  const route = createLegacyOpenClawCallbackRoute({
    controllerSessionId: "controller-openclaw-composition",
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin: "/opt/openclaw",
    gatewayUrl: "ws://127.0.0.1:18789"
  });
  const envelope = createCallbackEnvelope({
    route,
    source: {
      kind: "managed_turn",
      session_id: "session-openclaw-composition",
      turn_id: "turn-openclaw-composition",
      conversation_id: conversation.conversation_id
    },
    event: {
      id: message.id,
      type: message.type,
      body: message.body,
      requires_response: message.requires_response,
      metadata: message.metadata
    }
  });
  const adapter = createOpenClawManagedCallbackCliAdapter({
    now: () => NOW,
    environment: () => ({}),
    redactConversation: () => ({}),
    textSummary: (value) => value,
    log: () => undefined
  });

  const resolved = adapter.resolve({
    options: {
      callbackRoute: route,
      gatewayMethod: "agent-knock-knock.callback",
      gatewaySession: route.controller_session_id,
      openclawSession: route.controller_session_id,
      openclawBin: "/opt/openclaw",
      gatewayUrl: "ws://127.0.0.1:18789"
    },
    statePath: "/store/state.json",
    logPath: "/store/events.ndjson",
    conversation,
    message,
    attempt: { number: 2, id: "attempt-openclaw-composition" },
    route,
    envelope
  });

  assert.deepEqual(resolved.route, route);
  assert.strictEqual(resolved.envelope, envelope);
  assert.deepEqual(resolved.attempt, {
    number: 2,
    id: "attempt-openclaw-composition"
  });
  assert.strictEqual(resolved.context?.conversation, conversation);
  assert.strictEqual(resolved.context?.message, message);
  assert.deepEqual(resolved.context?.legacyOptions, {
    gatewayMethod: "agent-knock-knock.callback",
    gatewaySession: route.controller_session_id,
    openclawSession: route.controller_session_id,
    openclawBin: "/opt/openclaw",
    gatewayUrl: "ws://127.0.0.1:18789",
    token: undefined
  });
});

function storedConversation(storeDir: string, name: string): {
  conversation: Conversation;
  statePath: string;
  logPath: string;
} {
  const created = createConversation({
    userRequest: name,
    sessionId: `session-${name}`,
    turnId: `turn-${name}`,
    executorKind: "codex",
    executorSession: `codex-${name}`,
    workspace: "/workspace/project",
    now: NOW
  });
  const paths = pathsForConversation(created.conversation_id, storeDir);
  const conversation: Conversation = {
    ...created,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath
  };
  saveState(paths.statePath, conversation);
  return { conversation, statePath: paths.statePath, logPath: paths.logPath };
}

function dependencies(events: string[]): CallbackCliDependencies {
  return {
    state: {
      acquireFileLock(lockPath) {
        events.push(`state:acquire:${path.basename(lockPath)}`);
        return () => events.push(`state:release:${path.basename(lockPath)}`);
      },
      loadConversation(options) {
        events.push("load-conversation");
        const statePath = String(options.state);
        return {
          conversation: loadState(statePath),
          statePath,
          logPath: logPathForStatePath(statePath)
        };
      },
      readEvents() {
        events.push("read-events");
        return [];
      },
      withWriter(_storeDir, operation) {
        events.push("writer:acquire");
        try {
          return operation();
        } finally {
          events.push("writer:release");
        }
      }
    },
    authority: {
      assertNoDeferredTransfer() {
        events.push("assert:no-deferred");
      },
      assertBindingCurrent() {
        events.push("assert:binding");
      },
      resolveCompletionDispatch() {
        events.push("resolve:completion-dispatch");
        return true;
      }
    },
    retry: {
      startMonitor() {
        events.push("start:retry-monitor");
        return { pid: 8102 };
      },
      isProcessAlive() {
        events.push("observe:process");
        return false;
      },
      attemptLeaseMs: 120_000,
      delaysMs: [5_000, 15_000, 60_000, 60_000]
    },
    delivery: {
      transport: {
        kind: "test_callback_transport_v1",
        deliver(input) {
          events.push(`transport:deliver:${input.envelope.event.id}`);
          const outcome: CallbackAttemptOutcome = {
            disposition: "accepted",
            accepted_at: NOW.toISOString(),
            acceptance_id: input.envelope.delivery_id,
            evidence: {
              delivery_kind: "test_callback_transport_v1",
              injection_status: "accepted",
              wake_status: "not_required"
            }
          };
          input.reportCheckpoint?.(outcome);
          return outcome;
        }
      },
      resolve(input) {
        events.push("transport:resolve");
        assert.ok(input.route);
        assert.ok(input.envelope);
        assert.ok(Number.isSafeInteger(input.attempt.number));
        assert.equal(typeof input.attempt.id, "string");
        return {
          route: input.route,
          envelope: input.envelope,
          attempt: input.attempt,
          context: {
            statePath: input.statePath,
            logPath: input.logPath,
            conversation: input.conversation,
            message: input.message
          }
        };
      }
    },
    runtime: {
      textSummary: (value) => value
    }
  };
}

async function runFacadeCommand(
  facade: ReturnType<typeof createCallbackCliFacade>,
  command: "callback" | "retry-callback",
  options: CallbackCliOptions,
  events: string[]
) {
  return runCliCommandExecution(command, options, {
    now: () => NOW,
    pid: 7102,
    stdout: () => events.push("output"),
    runtimeLog: () => undefined
  }, async () => {
    if (command === "callback") facade.runCallback(options);
    else facade.runRetryCallback(options);
  });
}

test("callback transaction releases state then writer before presentation", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-adapter-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const stored = storedConversation(storeDir, "fresh");
  const events: string[] = [];
  const facade = createCallbackCliFacade(dependencies(events));
  const execution = await runFacadeCommand(facade, "callback", {
    state: stored.statePath,
    recordOnly: true,
    messageJson: JSON.stringify({
      from: "codex", to: "openclaw", type: "done", body: "complete"
    })
  }, events);

  assert.equal(execution.exitCode, 0);
  assert.equal(loadState(stored.statePath).status, "idle");
  assert.deepEqual(events, [
    "writer:acquire",
    `state:acquire:${path.basename(stored.statePath)}.lock`,
    "assert:no-deferred",
    "read-events",
    "assert:binding",
    `state:release:${path.basename(stored.statePath)}.lock`,
    "writer:release",
    "output"
  ]);
});

test("accepted retry fences a fresh Turn under writer authority before recovery", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-retry-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const stored = storedConversation(storeDir, "retry");
  const message = createMessage({
    conversation: stored.conversation,
    id: "message-retry",
    from: "codex",
    to: "openclaw",
    type: "done",
    body: "accepted before observation",
    now: NOW
  });
  saveState(stored.statePath, {
    ...stored.conversation,
    status: "waiting_for_agent",
    callback_delivery: {
      status: "pending",
      attempts: 1,
      message,
      injection: { status: "accepted", accepted_at: NOW.toISOString() },
      wake: { status: "not_required" }
    }
  });
  const events: string[] = [];
  const facade = createCallbackCliFacade(dependencies(events));
  const execution = await runFacadeCommand(facade, "retry-callback", {
    state: stored.statePath
  }, events);

  assert.equal(execution.exitCode, 0);
  assert.equal(
    (loadState(stored.statePath).callback_delivery as { status?: string }).status,
    "delivered"
  );
  assert.deepEqual(events, [
    "load-conversation",
    "writer:acquire",
    "assert:no-deferred",
    "writer:release",
    "writer:acquire",
    `state:acquire:${path.basename(stored.statePath)}.lock`,
    `state:release:${path.basename(stored.statePath)}.lock`,
    "writer:release",
    "output"
  ]);
});

test("generic callback delivery durably fences an accepted checkpoint before a later error", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-generic-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const stored = storedConversation(storeDir, "generic");
  const events: string[] = [];
  const injected = dependencies(events);
  injected.delivery.transport = {
    kind: CALLBACK_ROUTE.transport,
    deliver(input) {
      events.push("transport:deliver");
      const pending = loadState(stored.statePath).callback_delivery as {
        attempts?: number;
        attempt_id?: string;
      };
      assert.deepEqual(input.attempt, {
        number: pending.attempts,
        id: pending.attempt_id
      });
      const outcome: CallbackAttemptOutcome = {
        disposition: "accepted",
        accepted_at: NOW.toISOString(),
        acceptance_id: "generic-acceptance-id",
        evidence: {
          legacy_delivery: {
            kind: "compatible_delivery",
            injection: {
              status: "accepted",
              injection_id: "transport-specific-injection-id",
              accepted_at: NOW.toISOString()
            },
            wake: { status: "not_required" }
          }
        }
      };
      input.reportCheckpoint?.(outcome);
      const checkpoint = loadState(stored.statePath).callback_delivery as {
        injection?: { injection_id?: string };
        attempt_outcome?: { disposition?: string };
      };
      assert.equal(
        checkpoint.injection?.injection_id,
        "transport-specific-injection-id"
      );
      assert.equal(checkpoint.attempt_outcome?.disposition, "accepted");
      throw new Error("post-acceptance observation failed");
    }
  };
  const facade = createCallbackCliFacade(injected);
  const execution = await runFacadeCommand(facade, "callback", {
    state: stored.statePath,
    callbackRoute: CALLBACK_ROUTE,
    disableCallbackRetry: true,
    messageJson: JSON.stringify({
      from: "codex", to: "openclaw", type: "done", body: "complete"
    })
  }, events);

  assert.equal(execution.exitCode, 0);
  const delivery = loadState(stored.statePath).callback_delivery as {
    status?: string;
    injection?: { injection_id?: string };
    attempt_outcome?: { disposition?: string };
  };
  assert.equal(delivery.status, "delivered");
  assert.equal(
    delivery.injection?.injection_id,
    "transport-specific-injection-id"
  );
  assert.equal(delivery.attempt_outcome?.disposition, "accepted");
  assert.ok(events.indexOf("transport:resolve") < events.indexOf("transport:deliver"));
});

test("generic callback transport contract violations fail closed without retry", async (t) => {
  for (const testCase of ["throw", "malformed"] as const) {
    await t.test(testCase, async (subtest) => {
      const storeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), `akk-callback-${testCase}-`)
      );
      subtest.after(() => fs.rmSync(
        storeDir,
        { recursive: true, force: true }
      ));
      const stored = storedConversation(storeDir, testCase);
      const injected = dependencies([]);
      injected.delivery.transport = {
        kind: CALLBACK_ROUTE.transport,
        deliver() {
          if (testCase === "throw") {
            throw new Error("transport may already have performed a side effect");
          }
          return {} as CallbackAttemptOutcome;
        }
      };
      const facade = createCallbackCliFacade(injected);
      await assert.rejects(
        runFacadeCommand(facade, "callback", {
          state: stored.statePath,
          callbackRoute: CALLBACK_ROUTE,
          disableCallbackRetry: true,
          messageJson: JSON.stringify({
            from: "codex", to: "openclaw", type: "done", body: "complete"
          })
        }, []),
        /callback transport uncertain: callback_transport_contract_violation/u
      );
      const delivery = loadState(stored.statePath).callback_delivery as {
        attempt_outcome?: { disposition?: string; error_code?: string };
      };
      assert.deepEqual(delivery.attempt_outcome, {
        disposition: "uncertain",
        error_code: "callback_transport_contract_violation",
        observed_at: NOW.toISOString()
      });
      assert.equal(facade.retryDisposition(delivery).state, "uncertain");
    });
  }
});

test("callback resolver failure is permanent before transport invocation", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-callback-resolve-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const stored = storedConversation(storeDir, "resolve");
  const injected = dependencies([]);
  let invoked = false;
  injected.delivery.resolve = () => {
    throw new Error("profile is unavailable");
  };
  injected.delivery.transport = {
    kind: CALLBACK_ROUTE.transport,
    deliver() {
      invoked = true;
      throw new Error("must not be invoked");
    }
  };
  const facade = createCallbackCliFacade(injected);
  await assert.rejects(
    runFacadeCommand(facade, "callback", {
      state: stored.statePath,
      callbackRoute: CALLBACK_ROUTE,
      disableCallbackRetry: true,
      messageJson: JSON.stringify({
        from: "codex", to: "openclaw", type: "done", body: "complete"
      })
    }, []),
    /callback transport permanent_failure: callback_route_resolution_failed/u
  );
  assert.equal(invoked, false);
  const delivery = loadState(stored.statePath).callback_delivery as {
    attempt_outcome?: { disposition?: string; error_code?: string };
  };
  assert.deepEqual(delivery.attempt_outcome, {
    disposition: "permanent_failure",
    error_code: "callback_route_resolution_failed"
  });
  assert.equal(facade.retryDisposition(delivery).state, "permanent_failure");
});

test("factory-only async-local runtime restores nested facade capability sets", () => {
  assert.deepEqual(Object.keys(callbackCliAdapter), ["createCallbackCliFacade"]);
  const events: string[] = [];
  let facadeB: ReturnType<typeof createCallbackCliFacade>;
  const dependenciesA = dependencies(events);
  dependenciesA.retry.isProcessAlive = (pid) => {
    events.push(`A:process:${pid}`);
    assert.equal(facadeB.retryDisposition(pendingDelivery(22)).state, "retryable");
    events.push("A:resumed");
    return false;
  };
  const dependenciesB = dependencies(events);
  dependenciesB.retry.isProcessAlive = (pid) => {
    events.push(`B:process:${pid}`);
    return false;
  };
  const facadeA = createCallbackCliFacade(dependenciesA);
  facadeB = createCallbackCliFacade(dependenciesB);

  assert.equal(facadeA.retryDisposition(pendingDelivery(11)).state, "retryable");
  assert.equal(facadeB.retryDisposition(pendingDelivery(33)).state, "retryable");
  assert.deepEqual(events, [
    "A:process:11", "B:process:22", "A:resumed", "B:process:33"
  ]);
});

test("callback validates state before enumerating any other option getter", () => {
  const facade = createCallbackCliFacade(dependencies([]));
  const reads: string[] = [];
  const lateError = new Error("late getter must stay late");
  const options = (state: string | undefined) => new Proxy(
    Object.defineProperties({}, {
      state: {
        enumerable: true,
        get: () => (reads.push("state"), state)
      },
      late: {
        enumerable: true,
        get: () => {
          reads.push("late");
          throw lateError;
        }
      }
    }),
    {
      ownKeys(target) {
        reads.push("ownKeys");
        return Reflect.ownKeys(target);
      }
    }
  ) as CallbackCliOptions;

  assert.throws(
    () => facade.runCallback(options(undefined)),
    /--state is required/u
  );
  assert.deepEqual(reads, ["state"]);

  reads.length = 0;
  assert.throws(
    () => facade.runCallback(options("/store/turn/state.json")),
    (error) => error === lateError
  );
  assert.deepEqual(reads, ["state", "ownKeys", "state", "late"]);
});

function pendingDelivery(pid: number) {
  return {
    status: "pending",
    attempts: 1,
    attempt_pid: pid,
    message: { id: `message-${pid}` }
  };
}

function compiledSource(): string {
  return fs.readFileSync(
    new URL("../src/callback-cli-adapter.js", import.meta.url), "utf8"
  );
}

function compiledFunctionSource(name: string, nextName: string): string {
  const source = compiledSource();
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `missing ${name}`);
  assert.notEqual(end, -1, `missing ${nextName}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered token ${token}`);
    cursor = found + token.length;
  }
}

test("compiled facade preserves command, lock, delivery, and redaction order", () => {
  assertOrdered(compiledFunctionSource("runRetryCallback", "runCallbackTransaction"), [
    "loadConversation", "withWriter", "loadState", "assertNoDeferredTransfer",
    "callbackOutboxService().retry"
  ]);
  assertOrdered(compiledFunctionSource("runCallbackTransaction", "callbackOutboxService"), [
    "withWriter", "acquireFileLock", "prepareLockedCallback", "releaseState",
    "runPreparedCallback"
  ]);
  assertOrdered(compiledFunctionSource("prepareLockedCallback", "emitPreparedCallbackResult"), [
    "required(options.messageJson", "callbackOutboxService().prepare"
  ]);
  assertOrdered(compiledFunctionSource("deliverCallbackViaTransport", "callbackDeliveryOutcome"), [
    "runtime.delivery.resolve", "input.onAccepted", "input.onProgress",
    "runtime.delivery.transport.deliver"
  ]);
});

test("public facade declarations are typed and retain only five port groups", () => {
  const declaration = fs.readFileSync(
    new URL("../src/callback-cli-adapter.d.ts", import.meta.url), "utf8"
  );
  const source = fs.readFileSync(
    new URL("../../src/callback-cli-adapter.ts", import.meta.url), "utf8"
  );
  const serviceSource = fs.readFileSync(
    new URL("../../src/callback-outbox-service.ts", import.meta.url), "utf8"
  );
  const compositionSource = fs.readFileSync(
    new URL("../../src/cli-core.ts", import.meta.url), "utf8"
  );
  const openClawCompositionSource = fs.readFileSync(
    new URL(
      "../../src/openclaw-managed-callback-cli-adapter.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.doesNotMatch(declaration, /\bany\b|Record<[^>]*\bany\b|ResolvedTerminalConversation/u);
  assert.doesNotMatch(source, /from ["']\.\/cli-core\.js["']|\blet\s+runtime\b/u);
  assert.doesNotMatch(source, /createOpenClawCallbackTransport/u);
  assert.match(source, /new AsyncLocalStorage<CallbackCliDependencies>/u);
  const dependencyBoundary = source.slice(
    source.indexOf("export interface CallbackCliDependencies"),
    source.indexOf("\ntype CallbackOutboxService =")
  );
  assert.deepEqual(
    [...dependencyBoundary.matchAll(/^  (state|authority|retry|delivery|runtime):/gmu)]
      .map((match) => match[1]),
    ["state", "authority", "retry", "delivery", "runtime"]
  );
  assert.doesNotMatch(serviceSource, /\bterminal:\s*\{|ports\.terminal\b/u);
  assert.doesNotMatch(compositionSource, /createOpenClawCallbackTransport/u);
  assert.match(
    compositionSource,
    /delivery:\s*managedCallbackDelivery/u
  );
  assert.match(
    compositionSource,
    /createHostProfileCallbackTransport/u
  );
  assert.match(
    compositionSource,
    /legacyTransport:\s*managedOpenClawCallbackDelivery\.transport/u
  );
  assert.match(
    openClawCompositionSource,
    /createOpenClawCallbackTransport/u
  );
  assert.match(
    openClawCompositionSource,
    /return Object\.freeze\(\{ transport, resolve \}\)/u
  );
  for (const method of [
    "retryDisposition", "reconcileDelivery", "runRetryMonitor",
    "prepareApprovalNotification", "prepareStallNotification",
    "prepareTerminalCompletion", "runPrepared"
  ]) {
    assert.match(declaration, new RegExp(`\\b${method}\\b`, "u"));
  }
});

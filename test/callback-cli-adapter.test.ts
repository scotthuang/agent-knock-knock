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
    runtime: {
      classifyProcessFailure: () => undefined,
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
    `state:acquire:${path.basename(stored.statePath)}.lock`,
    `state:release:${path.basename(stored.statePath)}.lock`,
    "output"
  ]);
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
  assertOrdered(compiledFunctionSource("recordCallbackProcessDelivery", "openClawCallbackTransport"), [
    "appendEvent", "redactString(delivery.stdout)", "cliRuntimeLog"
  ]);
});

test("public facade declarations are typed and retain only four port groups", () => {
  const declaration = fs.readFileSync(
    new URL("../src/callback-cli-adapter.d.ts", import.meta.url), "utf8"
  );
  const source = fs.readFileSync(
    new URL("../../src/callback-cli-adapter.ts", import.meta.url), "utf8"
  );
  const serviceSource = fs.readFileSync(
    new URL("../../src/callback-outbox-service.ts", import.meta.url), "utf8"
  );
  assert.doesNotMatch(declaration, /\bany\b|Record<[^>]*\bany\b|ResolvedTerminalConversation/u);
  assert.doesNotMatch(source, /from ["']\.\/cli-core\.js["']|\blet\s+runtime\b/u);
  assert.match(source, /new AsyncLocalStorage<CallbackCliDependencies>/u);
  const dependencyBoundary = source.slice(
    source.indexOf("export interface CallbackCliDependencies"),
    source.indexOf("\ntype CallbackOutboxService =")
  );
  assert.deepEqual(
    [...dependencyBoundary.matchAll(/^  (state|authority|retry|runtime):/gmu)]
      .map((match) => match[1]),
    ["state", "authority", "retry", "runtime"]
  );
  assert.doesNotMatch(serviceSource, /\bterminal:\s*\{|ports\.terminal\b/u);
  for (const method of [
    "retryDisposition", "reconcileDelivery", "runRetryMonitor",
    "prepareApprovalNotification", "prepareTerminalCompletion", "runPrepared"
  ]) {
    assert.match(declaration, new RegExp(`\\b${method}\\b`, "u"));
  }
});

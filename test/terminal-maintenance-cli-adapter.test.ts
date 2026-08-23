import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API as TypeScriptApi } from "typescript/unstable/sync";
import {
  isBinaryExpression,
  isCaseClause,
  isCatchClause,
  isConditionalExpression,
  isDoStatement,
  isForInStatement,
  isForOfStatement,
  isForStatement,
  isFunctionLikeDeclaration,
  isIfStatement,
  isWhileStatement,
  type FunctionLikeDeclaration,
  type Node,
  type SourceFile
} from "typescript/unstable/ast";

import * as terminalMaintenanceCliAdapter from
  "../src/terminal-maintenance-cli-adapter.js";
import {
  createTerminalMaintenanceCliFacade,
  type TerminalMaintenanceAuthorityPorts,
  type TerminalMaintenanceCliDependencies,
  type TerminalMaintenanceIdentityPorts,
  type TerminalMaintenanceRepositoryPorts,
  type TerminalMaintenanceRuntimePorts
} from "../src/terminal-maintenance-cli-adapter.js";
import {
  canonicalMutationResource
} from "../src/mutation-transaction.js";
import {
  createConversation,
  type Conversation
} from "../src/protocol.js";
import {
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";
import { readNdjsonLog } from "../src/transcript.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import type {
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";

const NOW = new Date("2026-08-20T01:02:03.004Z");

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
}

function deferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

function strictPorts<Ports extends object>(
  implemented: Partial<Ports>,
  label: string
): Ports {
  return new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`unexpected ${label} port ${String(property)}`);
    }
  }) as Ports;
}

function conversation(name: string, status: Conversation["status"]): Conversation {
  return {
    ...createConversation({
      userRequest: name,
      sessionId: `session-${name}`,
      turnId: `turn-${name}`,
      executorKind: "codex",
      executorSession: `codex-${name}`,
      workspace: "/workspace/project",
      now: NOW
    }),
    status
  };
}

function isolationDependencies(
  marker: "A" | "B",
  events: string[],
  gate: DeferredGate
): TerminalMaintenanceCliDependencies {
  const closed = conversation(marker.toLowerCase(), "closed");
  const runtime = strictPorts<TerminalMaintenanceRuntimePorts>({
    defaultAgentTimeoutMinutes: 60,
    defaultAgentHardTimeoutMinutes: 720,
    loadConversation() {
      events.push(`${marker}:load`);
      return {
        conversation: closed,
        statePath: `/store/${marker}/state.json`,
        logPath: `/store/${marker}/events.ndjson`
      };
    }
  }, `${marker}:runtime`);
  const identity = strictPorts<TerminalMaintenanceIdentityPorts>({
    async migrateLegacyTerminalAgentIdentity(input) {
      events.push(`${marker}:migrate:before`);
      await gate.promise;
      events.push(`${marker}:migrate:after`);
      return input.conversation;
    }
  }, `${marker}:identity`);
  return {
    runtime,
    identity,
    authority: strictPorts({}, `${marker}:authority`),
    repository: strictPorts({}, `${marker}:repository`)
  };
}

function terminal(marker: string): ResolvedTerminalConversation {
  return {
    conversationId: `terminal:tmux:${marker}:0.0:4242`,
    agent: "codex",
    pid: 4242,
    legacy: false,
    adapter: {},
    terminalControl: {
      kind: "tmux",
      target: `${marker}:0.0`,
      session: marker,
      window: 0,
      pane: 0,
      panePid: 4242,
      capabilities: []
    }
  } as unknown as ResolvedTerminalConversation;
}

function rawCancelDependencies(
  events: string[],
  stop: Error
): TerminalMaintenanceCliDependencies {
  const resolved = terminal("raw");
  const runtime = strictPorts<TerminalMaintenanceRuntimePorts>({
    defaultAgentTimeoutMinutes: 60,
    defaultAgentHardTimeoutMinutes: 720,
    storeDir() {
      events.push("store");
      return "/store/raw";
    },
    createBridge() {
      events.push("bridge");
      return {
        async cancel() {
          events.push("cancel");
          throw stop;
        }
      } as unknown as TerminalAgentBridge;
    }
  }, "raw runtime");
  const identity = strictPorts<TerminalMaintenanceIdentityPorts>({
    async resolveTerminalConversationFromOptions() {
      events.push("resolve");
      return resolved;
    }
  }, "raw identity");
  const authority = strictPorts<TerminalMaintenanceAuthorityPorts>({
    assertTerminalHasNoNonterminalDeferredForegroundTransfer() {
      events.push("assert:no-deferred");
    }
  }, "raw authority");
  const repository = strictPorts<TerminalMaintenanceRepositoryPorts>({
    terminalWriterLocks(_storeDir, terminalControl) {
      events.push("locks");
      return {
        resources: {
          terminal: canonicalMutationResource("terminal", terminalControl),
          storeWriter: canonicalMutationResource("store", "/store/raw")
        },
        acquireTerminal() {
          events.push("terminal:acquire");
          return () => events.push("terminal:release");
        },
        async withStoreWriter(operation) {
          events.push("writer:acquire");
          try {
            return await operation();
          } finally {
            events.push("writer:release");
          }
        }
      };
    }
  }, "raw repository");
  return { runtime, identity, authority, repository };
}

function managedCancelDependencies(
  stored: { conversation: Conversation; statePath: string; logPath: string },
  terminalControl: TerminalControlRef,
  events: string[],
  input: {
    commandStoreDir: string;
    stateStoreDir: string;
    failures: Readonly<{
      terminalAcquire?: Error;
      stateAcquire?: Error;
      writerAcquire?: Error;
      operation?: Error;
      writerRelease?: Error;
      stateRelease?: Error;
      terminalRelease?: Error;
    }>;
  }
): TerminalMaintenanceCliDependencies {
  const runtime = strictPorts<TerminalMaintenanceRuntimePorts>({
    defaultAgentTimeoutMinutes: 60,
    defaultAgentHardTimeoutMinutes: 720,
    loadConversation() {
      events.push("load");
      return stored;
    },
    storeDir() {
      events.push(`command-store:${input.commandStoreDir}`);
      return input.commandStoreDir;
    }
  }, "managed runtime");
  const identity = strictPorts<TerminalMaintenanceIdentityPorts>({
    async resolveTerminalConversationFromOptions() {
      events.push("resolve");
      return undefined;
    },
    async migrateLegacyTerminalAgentIdentity(input) {
      events.push("migrate");
      return input.conversation;
    }
  }, "managed identity");
  const authority = strictPorts<TerminalMaintenanceAuthorityPorts>({
    assertManagedTerminalDispatchOwner(ownerInput) {
      events.push(`assert:owner:${ownerInput.storeDir}`);
      assert.equal(ownerInput.storeDir, input.stateStoreDir);
      if (input.failures.operation) throw input.failures.operation;
    }
  }, "managed authority");
  const repository = strictPorts<TerminalMaintenanceRepositoryPorts>({
    acquireTerminalLock(storeDir, control, options) {
      events.push(`terminal:acquire:${storeDir}`);
      assert.equal(storeDir, input.commandStoreDir);
      assert.equal(control.target, terminalControl.target);
      assert.deepEqual(options, { timeoutMs: 30000 });
      if (input.failures.terminalAcquire) {
        throw input.failures.terminalAcquire;
      }
      return () => {
        events.push(`terminal:release:${storeDir}`);
        if (input.failures.terminalRelease) {
          throw input.failures.terminalRelease;
        }
      };
    },
    acquireFileLock(lockPath) {
      events.push(`state:acquire:${lockPath}`);
      assert.equal(lockPath, `${stored.statePath}.lock`);
      if (input.failures.stateAcquire) throw input.failures.stateAcquire;
      return () => {
        events.push(`state:release:${lockPath}`);
        if (input.failures.stateRelease) throw input.failures.stateRelease;
      };
    },
    async withStoreWriterLease(storeDir, operation) {
      events.push(`writer:acquire:${storeDir}`);
      assert.equal(storeDir, input.stateStoreDir);
      if (input.failures.writerAcquire) throw input.failures.writerAcquire;
      try {
        return await operation();
      } finally {
        events.push(`writer:release:${storeDir}`);
        if (input.failures.writerRelease) {
          throw input.failures.writerRelease;
        }
      }
    }
  }, "managed repository");
  return { runtime, identity, authority, repository };
}

function compiledFunctionSource(name: string, nextToken: string): string {
  const source = fs.readFileSync(
    new URL("../src/terminal-maintenance-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(nextToken, start + 1);
  assert.notEqual(start, -1, `${name} must remain in the maintenance facade`);
  assert.notEqual(end, -1, `${nextToken} must follow ${name}`);
  return source.slice(start, end);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered wiring token: ${token}`);
    cursor = found + token.length;
  }
}

function approximateComplexity(
  root: FunctionLikeDeclaration,
  sourceFile: SourceFile
): number {
  let value = 1;
  const visit = (node: Node): void => {
    if (node !== root && isFunctionLikeDeclaration(node)) return;
    if (
      isIfStatement(node) || isConditionalExpression(node) ||
      isCatchClause(node) || isForStatement(node) ||
      isForInStatement(node) || isForOfStatement(node) ||
      isWhileStatement(node) || isDoStatement(node) || isCaseClause(node)
    ) {
      value += 1;
    }
    if (
      isBinaryExpression(node) &&
      ["&&", "||", "??"].includes(node.operatorToken.getText(sourceFile))
    ) {
      value += 1;
    }
    node.forEachChild(visit);
  };
  root.body?.forEachChild(visit);
  return value;
}

test("maintenance facade exports one factory and isolates concurrent runtimes", async (t) => {
  assert.deepEqual(
    Object.keys(terminalMaintenanceCliAdapter),
    ["createTerminalMaintenanceCliFacade"]
  );
  const events: string[] = [];
  const gateA = deferredGate();
  const gateB = deferredGate();
  t.after(() => {
    gateA.release();
    gateB.release();
  });
  const facadeA = createTerminalMaintenanceCliFacade(
    isolationDependencies("A", events, gateA)
  );
  const facadeB = createTerminalMaintenanceCliFacade(
    isolationDependencies("B", events, gateB)
  );
  const renewA = facadeA.runRenew({});
  const renewB = facadeB.runRenew({});
  assert.deepEqual(events, [
    "A:load", "A:migrate:before", "B:load", "B:migrate:before"
  ]);
  gateB.release();
  await assert.rejects(renewB, /cannot renew turn-b; conversation is closed/u);
  gateA.release();
  await assert.rejects(renewA, /cannot renew turn-a; conversation is closed/u);
  assert.deepEqual(events, [
    "A:load", "A:migrate:before", "B:load", "B:migrate:before",
    "B:migrate:after", "A:migrate:after"
  ]);
});

test("raw cancel releases writer and terminal scopes after bridge failure", async () => {
  const events: string[] = [];
  const stop = new Error("stop after cancel dispatch");
  const facade = createTerminalMaintenanceCliFacade(
    rawCancelDependencies(events, stop)
  );
  await assert.rejects(facade.runCancel({}), (error) => error === stop);
  assert.deepEqual(events, [
    "resolve", "store", "locks", "terminal:acquire", "writer:acquire",
    "assert:no-deferred", "bridge", "cancel", "writer:release",
    "terminal:release"
  ]);
});

test("managed cancel retains distinct command and state Store lock keys", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-maintenance-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const control: TerminalControlRef = {
    kind: "tmux", target: "managed:0.0", session: "managed",
    window: 0, pane: 0, panePid: 4242, capabilities: []
  };
  const initial = conversation("managed", "waiting_for_agent");
  const paths = pathsForConversation(initial.conversation_id, storeDir);
  const stored: Conversation = {
    ...initial,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_control: control
    }
  };
  saveState(paths.statePath, stored);
  const events: string[] = [];
  const stop = new Error("stop at owner fence");
  const commandStoreDir = "/wrong-command-store";
  assert.notEqual(commandStoreDir, paths.storeDir);
  const facade = createTerminalMaintenanceCliFacade(
    managedCancelDependencies({
      conversation: stored,
      statePath: paths.statePath,
      logPath: paths.logPath
    }, control, events, {
      commandStoreDir,
      stateStoreDir: paths.storeDir,
      failures: { operation: stop }
    })
  );
  await assert.rejects(facade.runCancel({}), (error) => error === stop);
  assert.deepEqual(events, [
    "resolve", "load", "migrate",
    `command-store:${commandStoreDir}`,
    `terminal:acquire:${commandStoreDir}`,
    `writer:acquire:${paths.storeDir}`,
    `state:acquire:${paths.statePath}.lock`,
    `assert:owner:${paths.storeDir}`,
    `state:release:${paths.statePath}.lock`,
    `writer:release:${paths.storeDir}`,
    `terminal:release:${commandStoreDir}`
  ]);
});

test("managed cancel preserves parent acquire and release error priority", async (t) => {
  const stateStoreDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "akk-maintenance-errors-")
  );
  t.after(() => fs.rmSync(stateStoreDir, { recursive: true, force: true }));
  const control: TerminalControlRef = {
    kind: "tmux", target: "managed-errors:0.0", session: "managed-errors",
    window: 0, pane: 0, panePid: 4242, capabilities: []
  };
  const initial = conversation("managed-errors", "waiting_for_agent");
  const paths = pathsForConversation(initial.conversation_id, stateStoreDir);
  const stored: Conversation = {
    ...initial,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_control: control
    }
  };
  saveState(paths.statePath, stored);
  const commandStoreDir = "/wrong-error-command-store";
  assert.notEqual(commandStoreDir, paths.storeDir);
  const errors = {
    terminalAcquire: new Error("terminal acquire"),
    stateAcquire: new Error("state acquire"),
    writerAcquire: new Error("writer acquire"),
    operation: new Error("operation"),
    writerRelease: new Error("writer release"),
    stateRelease: new Error("state release"),
    terminalRelease: new Error("terminal release")
  } as const;
  const stateAcquire = `state:acquire:${paths.statePath}.lock`;
  const stateRelease = `state:release:${paths.statePath}.lock`;
  const terminalAcquire = `terminal:acquire:${commandStoreDir}`;
  const terminalRelease = `terminal:release:${commandStoreDir}`;
  const writerAcquire = `writer:acquire:${paths.storeDir}`;
  const writerRelease = `writer:release:${paths.storeDir}`;
  const prefix = [
    "resolve", "load", "migrate", `command-store:${commandStoreDir}`
  ];
  const cases: ReadonlyArray<{
    name: string;
    failures: Parameters<typeof managedCancelDependencies>[3]["failures"];
    expectedError: Error;
    tail: string[];
  }> = [
    {
      name: "terminal acquire fails before an owned scope exists",
      failures: { terminalAcquire: errors.terminalAcquire },
      expectedError: errors.terminalAcquire,
      tail: [terminalAcquire]
    },
    {
      name: "state acquire failure releases only terminal",
      failures: { stateAcquire: errors.stateAcquire },
      expectedError: errors.stateAcquire,
      tail: [
        terminalAcquire, writerAcquire, stateAcquire,
        writerRelease, terminalRelease
      ]
    },
    {
      name: "writer acquire failure releases only terminal",
      failures: { writerAcquire: errors.writerAcquire },
      expectedError: errors.writerAcquire,
      tail: [terminalAcquire, writerAcquire, terminalRelease]
    },
    {
      name: "writer release overrides the operation error",
      failures: {
        operation: errors.operation,
        writerRelease: errors.writerRelease
      },
      expectedError: errors.writerRelease,
      tail: [
        terminalAcquire, writerAcquire, stateAcquire,
        `assert:owner:${paths.storeDir}`, stateRelease,
        writerRelease, terminalRelease
      ]
    },
    {
      name: "state release overrides the operation error",
      failures: {
        operation: errors.operation,
        stateRelease: errors.stateRelease
      },
      expectedError: errors.stateRelease,
      tail: [
        terminalAcquire, writerAcquire, stateAcquire,
        `assert:owner:${paths.storeDir}`, stateRelease,
        writerRelease, terminalRelease
      ]
    },
    {
      name: "terminal release overrides the operation error",
      failures: {
        operation: errors.operation,
        terminalRelease: errors.terminalRelease
      },
      expectedError: errors.terminalRelease,
      tail: [
        terminalAcquire, writerAcquire, stateAcquire,
        `assert:owner:${paths.storeDir}`, stateRelease,
        writerRelease, terminalRelease
      ]
    },
    {
      name: "terminal release has final priority during a failed unwind",
      failures: {
        operation: errors.operation,
        writerRelease: errors.writerRelease,
        stateRelease: errors.stateRelease,
        terminalRelease: errors.terminalRelease
      },
      expectedError: errors.terminalRelease,
      tail: [
        terminalAcquire, writerAcquire, stateAcquire,
        `assert:owner:${paths.storeDir}`, stateRelease,
        writerRelease, terminalRelease
      ]
    }
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const events: string[] = [];
      const facade = createTerminalMaintenanceCliFacade(
        managedCancelDependencies({
          conversation: stored,
          statePath: paths.statePath,
          logPath: paths.logPath
        }, control, events, {
          commandStoreDir,
          stateStoreDir: paths.storeDir,
          failures: scenario.failures
        })
      );
      await assert.rejects(
        facade.runCancel({}),
        (error) => error === scenario.expectedError
      );
      assert.deepEqual(events, [...prefix, ...scenario.tail]);
    });
  }
});

test("explicit Close persists user intent when linked cleanup is missing", async (t) => {
  const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-user-close-"));
  t.after(() => fs.rmSync(storeDir, { recursive: true, force: true }));
  const initial = conversation("user-close", "stalled");
  const paths = pathsForConversation(initial.conversation_id, storeDir);
  const closeControl: TerminalControlRef = {
    kind: "tmux",
    target: "renumbered:0.0",
    session: "renumbered",
    window: 0,
    pane: 0,
    panePid: 4242,
    capabilities: []
  };
  const stored: Conversation = {
    ...initial,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    callback_expected: true,
    callback_delivery: {
      status: "pending",
      attempts: 1,
      message: { id: "callback-user-close" }
    },
    callback_notification_delivery: {
      status: "failed",
      attempts: 1,
      message: { id: "notification-user-close" }
    },
    native_session_takeover: {
      terminal_bridge: true,
      terminal_control: closeControl,
      terminal_bridge_message_id: "message-after-route-renumber",
      deferred_foreground_transfer_id: "deferred-transfer-missing"
    }
  };
  saveState(paths.statePath, stored);
  const legacyStored = JSON.parse(
    fs.readFileSync(paths.statePath, "utf8")
  ) as Record<string, unknown>;
  delete legacyStored.store_dir;
  delete legacyStored.conversation_dir;
  delete legacyStored.state_path;
  delete legacyStored.event_log_path;
  fs.writeFileSync(paths.statePath, `${JSON.stringify(legacyStored)}\n`, {
    mode: 0o600
  });
  const facade = createTerminalMaintenanceCliFacade({
    runtime: strictPorts<TerminalMaintenanceRuntimePorts>({
      loadConversation() {
        return {
          conversation: {
            ...loadState(paths.statePath),
            store_dir: path.resolve(paths.storeDir),
            conversation_dir: path.resolve(paths.conversationDir),
            state_path: path.resolve(paths.statePath),
            event_log_path: path.resolve(paths.logPath)
          },
          statePath: paths.statePath,
          logPath: paths.logPath
        };
      },
      textSummary(value) {
        return String(value);
      }
    }, "user-close runtime"),
    identity: strictPorts<TerminalMaintenanceIdentityPorts>({
      async resolveTerminalConversationFromOptions() {
        return undefined;
      }
    }, "user-close identity"),
    authority: strictPorts({}, "user-close authority"),
    repository: strictPorts<TerminalMaintenanceRepositoryPorts>({
      acquireFileLock() {
        return () => {};
      },
      async withStoreWriterLease(_storeDir, operation) {
        return operation();
      },
      resolveDispatch(control, request) {
        assert.equal(control.target, closeControl.target);
        assert.equal(
          request.expectedMessageId,
          "message-after-route-renumber"
        );
        throw new Error("malformed terminal dispatch receipt history");
      }
    }, "user-close repository")
  });

  const execution = await runCliCommandExecution(
    "close",
    { turn: initial.conversation_id },
    { now: () => NOW },
    () => facade.runClose({
      turn: initial.conversation_id,
      reason: "user chose to release AKK management"
    })
  );
  const output = JSON.parse(execution.stdout) as Record<string, any>;
  const closed = loadState(paths.statePath);
  assert.equal(closed.status, "closed");
  assert.equal(closed.disposition, "user_abandoned_management");
  assert.equal(closed.callback_expected, false);
  assert.equal(closed.close_reason, "user chose to release AKK management");
  assert.equal(closed.store_dir, path.resolve(paths.storeDir));
  assert.equal(closed.conversation_dir, path.resolve(paths.conversationDir));
  assert.equal(closed.state_path, path.resolve(paths.statePath));
  assert.equal(closed.event_log_path, path.resolve(paths.logPath));
  assert.equal(
    (closed.callback_delivery as Record<string, unknown>).status,
    "superseded"
  );
  assert.equal(
    (closed.callback_notification_delivery as Record<string, unknown>).status,
    "superseded"
  );
  assert.equal(output.closed, true);
  assert.equal(output.management_released, true);
  assert.equal(output.terminal_input_sent, false);
  assert.equal(output.coding_agent_stopped, false);
  assert.equal(output.tmux_pane_closed, false);
  assert.equal(output.terminal_dispatch_resolved, false);
  assert.ok((output.warnings as unknown[]).some((warning) =>
    /linked_transfer_missing/u.test(String(warning))
  ));
  assert.ok((output.warnings as unknown[]).some((warning) =>
    /malformed terminal dispatch receipt history/u.test(String(warning))
  ));
  const events = readNdjsonLog(paths.logPath);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    ts: NOW.toISOString(),
    conversation_id: initial.conversation_id,
    event: "conversation_closed",
    status: "closed",
    reason: "user chose to release AKK management",
    disposition: "user_abandoned_management",
    terminal_input_sent: false,
    coding_agent_stopped: false,
    tmux_pane_closed: false
  });
});

test("maintenance command wiring preserves validation and durable order", () => {
  const renew = compiledFunctionSource("runRenew", "function runCancel");
  assertOrdered(renew, [
    "loadConversationFromOptions(options)",
    "migrateLegacyTerminalAgentIdentity({",
    "conversation.status === \"closed\"",
    "isVerifiedDeadTerminalAgentProcess(conversation)",
    "terminalBridgeSubmission(conversation)",
    "createTerminalControlProvider(options)",
    "withStoreWriterLease(writerStoreDir",
    "acquireFileLock(`${statePath}.lock`)",
    "loadState(statePath)",
    "assertTurnBindingCurrent(current, \"renew\")",
    "saveState(statePath, renewed)",
    "appendEvent(logPath, {",
    "startTerminalBridgeMonitorForConversation({",
    "appendEvent(logPath, {",
    "printJson({"
  ]);

  const cancel = compiledFunctionSource(
    "runCancel",
    "function runTerminalConversationCancel"
  );
  assertOrdered(cancel, [
    "resolveTerminalConversationFromOptions(options)",
    "runTerminalConversationCancel({",
    "loadConversationFromOptions(options)",
    "migrateLegacyTerminalAgentIdentity({",
    "runTerminalControlCancel({"
  ]);

  const managedCancel = compiledFunctionSource(
    "runTerminalControlCancel",
    "function runObservedHandoffClose"
  );
  assertOrdered(managedCancel, [
    "acquireTerminalBridgeSendLock(",
    "storeDirFromOptions(options)",
    "pathsForConversationDir(",
    "withStoreWriterLease(writerStoreDir",
    "acquireFileLock(`${statePath}.lock`)",
    "loadState(statePath)",
    "assertManagedTerminalDispatchOwner({",
    "createTerminalAgentBridge(options).cancel(",
    "appendEvent(logPath, {",
    "saveState(statePath, nextConversation)",
    "printJson({",
    "releaseStateLock()",
    "releaseTerminalLock()"
  ]);

  const observedClose = compiledFunctionSource(
    "runObservedHandoffClose",
    "function runClose"
  );
  assertOrdered(observedClose, [
    "loadManagedSession(storeDir, sourceSessionId)",
    "resolveStoredTerminal(",
    "withCanonicalMutationLocks(",
    "mutationConversationStore.load(",
    "mutationManagedSessions.load(",
    "resolveCurrentNativeAgentSessionIdentity({",
    "observedExternalHandoffIdentity({",
    "observedHandoffAuthorityToken({",
    "mutationDispatchLedger.load(",
    "activeTurnHandoffDecisionToken({",
    "mutationConversationStore.save(",
    "mutationDispatchLedger.resolve(",
    "mutationConversationStore.appendEvent(",
    "printJson({"
  ]);

  const close = compiledFunctionSource(
    "runClose",
    "function assertGenericCloseDoesNotBypassObservedHandoff"
  );
  assertOrdered(close, [
    "resolveTerminalConversationFromOptions(options)",
    "runTerminalDispatchClose({",
    "loadConversationFromOptions(options)",
    "acquireFileLock(`${statePath}.lock`)",
    "saveExplicitUserCloseState(statePath, closed)",
    "cleanupDeferredForegroundUserClose({",
    "resolveTerminalBridgeDispatchLedger(",
    "appendExplicitUserCloseEvent(logPath, {",
    "printJson({",
    "withStoreWriterLeaseAsync(closeStoreDir, closeWithFreshState)"
  ]);
  assert.doesNotMatch(close, /runObservedHandoffClose|acquireTerminalBridgeSendLock/u);

  const dispatchClose = compiledFunctionSource(
    "runTerminalDispatchClose",
    "const terminalMaintenanceOperations"
  );
  assertOrdered(dispatchClose, [
    "withCanonicalMutationLocks(",
    "mutationDispatchLedger.reconcileIncarnation(",
    "loadDeferredForegroundTransfer(",
    "isRecoverableTerminalDispatchStatus(String(ledger.status))",
    "terminalDispatchLedgerLooksLifecycle(ledger)",
    "mutationDispatchLedger.reconcile(",
    "loadTerminalDispatchLedgerOwner(ledger)",
    "mutationDispatchLedger.save(",
    "runtimeLog(\"info\", \"terminal_dispatch_explicitly_resolved\"",
    "printJson({"
  ]);
});

test("maintenance adapter declarations keep unknown options and no raw authorities", () => {
  const declaration = fs.readFileSync(
    new URL("../src/terminal-maintenance-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    declaration,
    /TerminalMaintenanceCliOptions = Readonly<Record<string, unknown>>/u
  );
  assert.match(declaration, /createTerminalMaintenanceCliFacade/u);
  assert.doesNotMatch(declaration, /\bany\b/u);

  const source = fs.readFileSync(
    path.resolve("src/terminal-maintenance-cli-adapter.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /\bany\b/u);
  assert.doesNotMatch(source, /JSON\.(?:parse|stringify)/u);
  assert.doesNotMatch(source, /ResolvedTerminal.*capabilit/iu);
});

test("maintenance functions remain below the hard LOC and complexity gates", () => {
  const api = new TypeScriptApi({ cwd: process.cwd() });
  const configPath = path.resolve("tsconfig.json");
  try {
    const project = api.updateSnapshot({ openProjects: [configPath] })
      .getProject(configPath);
    assert.ok(project);
    const sourceFile = project.program.getSourceFile(path.resolve(
      "src/terminal-maintenance-cli-adapter.ts"
    ));
    assert.ok(sourceFile);
    const metrics: Array<{ span: number; complexity: number }> = [];
    const visit = (node: Node): void => {
      if (isFunctionLikeDeclaration(node) && node.body) {
        const line = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile)
        ).line + 1;
        const end = sourceFile.getLineAndCharacterOfPosition(node.end).line + 1;
        metrics.push({
          span: end - line + 1,
          complexity: approximateComplexity(node, sourceFile)
        });
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
    assert.equal(Math.max(...metrics.map((entry) => entry.span)), 222);
    assert.equal(Math.max(...metrics.map((entry) => entry.complexity)), 29);
    assert.ok(metrics.every((entry) => entry.span < 500));
    assert.ok(metrics.every((entry) => entry.complexity < 50));
  } finally {
    api.close();
  }
});

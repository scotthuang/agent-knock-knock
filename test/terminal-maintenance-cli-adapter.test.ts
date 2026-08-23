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
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import type { DeferredForegroundApplicationScope } from
  "../src/deferred-foreground-boundary.js";
import { terminalControlEvidence } from "../src/terminal-control-ref.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  createConversation,
  type Conversation
} from "../src/protocol.js";
import {
  appendEvent,
  pathsForConversation,
  saveState
} from "../src/store.js";
import { readNdjsonLog } from "../src/transcript.js";
import type {
  TerminalControlRef
} from "../src/terminal-agent-adapter.js";
import type {
  ResolvedTerminalConversation,
  TerminalAgentBridge
} from "../src/terminal-agent-bridge.js";
import { createTerminalWatchCliAdapter } from
  "../src/terminal-watch-cli-adapter.js";

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

type UserAbandonmentCrashStage =
  | "intent" | "turn" | "ledger" | "source" | "target" | "event" |
    "final";

function userAbandonmentCloseFixture(input: {
  malformedLedger?: boolean;
  malformedCallbackStart?: boolean;
  crashOnce?: UserAbandonmentCrashStage;
  closeReason?: string;
  preexistingEvent?: "conflict" | "duplicate";
  recoveryNow?: Date;
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-close-abandon-fast-"));
  const storeDir = path.join(root, "store");
  const control: TerminalControlRef = {
    kind: "tmux",
    target: "abandon:0.0",
    session: "abandon",
    window: 0,
    pane: 0,
    panePid: 4242,
    currentCommand: "codex",
    currentPath: "/workspace/project",
    capabilities: []
  };
  const base = conversation("abandon", "waiting_for_agent");
  const paths = pathsForConversation(base.conversation_id, storeDir);
  let currentConversation: Conversation = {
    ...base,
    callback_expected: true,
    callback_delivery: {
      status: "pending",
      attempts: 1,
      attempt_pid: 7331,
      message: { id: "callback-1" },
      ...(input.malformedCallbackStart
        ? { transport_started_at: NOW.toISOString() }
        : {})
    },
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_control: control,
      deferred_foreground_transfer_id: "transfer-abandon",
      terminal_bridge_message_id: "message-abandon",
      terminal_bridge_request_hash: "c".repeat(64)
    }
  };
  saveState(paths.statePath, currentConversation);
  let transfer: DeferredForegroundTransfer = {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 2,
    transfer_id: "transfer-abandon",
    revision: 7,
    status: "target_prepared",
    input_stage: "none",
    terminal_id: "terminal-abandon",
    terminal_endpoint: terminalControlEvidence(control),
    process_pid: 4242,
    process_uuid: "process-abandon",
    process_birth: "birth-abandon",
    workspace: "/workspace/project",
    source_session_id: "source-abandon",
    source_expected_revision: 3,
    source_binding_token: "a".repeat(64),
    source_before_binding: {} as
      DeferredForegroundTransfer["source_before_binding"],
    source_kind: "status_card_only",
    target_session_id: currentConversation.session_id,
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: "b".repeat(64),
    target_prepared_revision: 1,
    target_prepared_status: "transitioning",
    target_prepared_last_transition_id: "transfer-abandon",
    target_prepared_binding_token: "f".repeat(64),
    target_before_binding: {} as
      DeferredForegroundTransfer["target_before_binding"],
    request_hash: "c".repeat(64),
    dispatcher_pid: 8111,
    prepared_at: NOW.toISOString(),
    target_prepared_at: NOW.toISOString(),
    message_id: "message-abandon",
    turn_id: currentConversation.conversation_id,
    state_path: paths.statePath
  };
  let ledger: Record<string, unknown> | undefined = {
    version: 2,
    terminal_endpoint: terminalControlEvidence(control),
    status: "prepared",
    generation_id: transfer.message_id,
    conversation_id: transfer.turn_id,
    session_id: transfer.target_session_id,
    turn_id: transfer.turn_id,
    message_id: transfer.message_id,
    message_type: "task",
    request_hash: input.malformedLedger ? "wrong-request" : transfer.request_hash,
    prepared_at: transfer.prepared_at,
    store_dir: paths.storeDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    deferred_foreground_transfer_id: transfer.transfer_id,
    dispatcher_pid: transfer.dispatcher_pid,
    callback_expected: true
  };
  const trace: string[] = [];
  if (input.preexistingEvent) {
    const event = {
      ts: input.preexistingEvent === "conflict"
        ? "2026-08-15T04:05:07.000Z"
        : NOW.toISOString(),
      conversation_id: currentConversation.conversation_id,
      event: "conversation_closed",
      status: "closed",
      reason: input.closeReason ?? "closed by request",
      disposition: "user_abandoned_management",
      transfer_id: transfer.transfer_id,
      terminal_input_sent: false,
      coding_agent_stopped: false,
      management_release_pending: true
    };
    appendEvent(paths.logPath, event);
    if (input.preexistingEvent === "duplicate") {
      appendEvent(paths.logPath, event);
    }
  }
  let sourceReleased = false;
  let targetReleased = false;
  const failures = new Set<UserAbandonmentCrashStage>(
    input.crashOnce ? [input.crashOnce] : []
  );
  const crash = (stage: UserAbandonmentCrashStage): void => {
    if (!failures.delete(stage)) return;
    throw new Error(`simulated crash after ${stage}`);
  };
  const scope = {} as DeferredForegroundApplicationScope;
  const dependencies: TerminalMaintenanceCliDependencies = {
    runtime: strictPorts<TerminalMaintenanceRuntimePorts>({
      defaultAgentTimeoutMinutes: 60,
      defaultAgentHardTimeoutMinutes: 720,
      loadConversation() {
        trace.push("turn:load-listed");
        return {
          conversation: currentConversation,
          statePath: paths.statePath,
          logPath: paths.logPath
        };
      }
    }, "abandon runtime"),
    identity: strictPorts<TerminalMaintenanceIdentityPorts>({
      async resolveTerminalConversationFromOptions() {
        return undefined;
      }
    }, "abandon identity"),
    authority: strictPorts<TerminalMaintenanceAuthorityPorts>({
      exactTargetDeferredForegroundTransfer() {
        trace.push(`transfer:exact:${transfer.status}`);
        return transfer;
      },
      loadTerminalDispatchLedgerOwner() {
        return currentConversation;
      }
    }, "abandon authority"),
    repository: strictPorts<TerminalMaintenanceRepositoryPorts>({
      terminalWriterStateLocks(_storeDir, terminalControl, statePath, logPath) {
        return {
          resources: {
            terminal: canonicalMutationResource("terminal", terminalControl),
            storeWriter: canonicalMutationResource("store", storeDir),
            state: canonicalMutationResource(statePath, { statePath, logPath })
          },
          acquireTerminal() {
            trace.push("lock:terminal");
            return () => trace.push("unlock:terminal");
          },
          async withStoreWriter(operation) {
            trace.push("lock:writer");
            try {
              return await operation();
            } finally {
              trace.push("unlock:writer");
            }
          },
          acquireState() {
            trace.push("lock:state");
            return () => trace.push("unlock:state");
          }
        };
      },
      conversationLoad() {
        trace.push("turn:load-locked");
        return currentConversation;
      },
      conversationSave(_scopes, _resources, next) {
        currentConversation = next;
        saveState(paths.statePath, next);
        trace.push("turn:save");
        crash("turn");
      },
      conversationAppendEvent(_scopes, _resources, event) {
        appendEvent(paths.logPath, event);
        trace.push("event:append");
        crash("event");
      },
      ledgerLoad() {
        trace.push("ledger:load");
        return ledger;
      },
      ledgerSave(_scopes, _resources, next) {
        ledger = next;
        trace.push("ledger:save");
        crash("ledger");
      },
      deferredScope() {
        return scope;
      },
      deferredApplication() {
        return {
          beginUserAbandonment(request) {
            trace.push("transfer:intent");
            if (transfer.status === "target_prepared") {
              transfer = {
                ...transfer,
                revision: Number(transfer.revision) + 1,
                status: "user_abandoning",
                user_abandonment_disposition: "user_abandoned_management",
                user_abandonment_origin_status: "target_prepared",
                user_abandonment_origin_revision: transfer.revision,
                user_abandonment_turn_id: request.turnId,
                user_abandonment_turn_fingerprint: request.turnFingerprint,
                user_abandonment_requested_at: request.requestedAt,
                user_abandonment_close_reason: request.closeReason,
                user_abandonment_ledger_disposition:
                  request.ledgerDisposition,
                user_abandonment_ledger_fingerprint:
                  request.ledgerFingerprint
              };
              crash("intent");
            }
            return transfer;
          },
          completeUserAbandonment(request) {
            if (transfer.status === "user_abandoned") {
              request.assertCloseEvent();
              return transfer;
            }
            if (!sourceReleased) {
              sourceReleased = true;
              trace.push("session:release-source");
              crash("source");
            }
            if (!targetReleased) {
              targetReleased = true;
              trace.push("session:release-target");
              crash("target");
            }
            request.ensureCloseEvent();
            transfer = {
              ...transfer,
              revision: Number(transfer.revision) + 1,
              status: "user_abandoned",
              user_abandonment_completed_at: NOW.toISOString(),
              user_abandonment_source_disposition: "detached",
              user_abandonment_source_fingerprint: "1".repeat(64),
              user_abandonment_target_disposition: "detached",
              user_abandonment_target_fingerprint: "2".repeat(64)
            };
            trace.push("transfer:final");
            crash("final");
            return transfer;
          }
        };
      }
    }, "abandon repository")
  };
  const facade = createTerminalMaintenanceCliFacade(dependencies);
  let invocationCount = 0;
  return {
    root,
    paths,
    trace,
    conversation: () => currentConversation,
    transfer: () => transfer,
    ledger: () => ledger,
    removeFinalTerminalControl() {
      const takeover = currentConversation.native_session_takeover as
        Record<string, unknown>;
      const { terminal_control: _terminalControl, ...withoutControl } =
        takeover;
      currentConversation = {
        ...currentConversation,
        native_session_takeover: withoutControl
      };
      saveState(paths.statePath, currentConversation);
    },
    rollbackFinalCallbackReceipt() {
      currentConversation = {
        ...currentConversation,
        callback_delivery: {
          status: "pending",
          attempts: 1,
          attempt_pid: 7331,
          message: { id: "callback-1" }
        }
      };
      saveState(paths.statePath, currentConversation);
    },
    rollbackFinalLedgerReceipt() {
      ledger = ledger
        ? {
            ...ledger,
            status: "prepared",
            resolved_at: undefined,
            dispatcher_pid: 8111,
            callback_expected: true,
            reason: undefined
          }
        : ledger;
    },
    rollbackFinalOperationalReceipts() {
      this.rollbackFinalCallbackReceipt();
      this.rollbackFinalLedgerReceipt();
    },
    async run() {
      const invocationNow = invocationCount > 0 && input.recoveryNow
        ? input.recoveryNow
        : NOW;
      invocationCount += 1;
      return runCliCommandExecution("close", {}, {
        now: () => invocationNow,
        env: {}
      }, () => facade.runClose({
        ...(input.closeReason ? { reason: input.closeReason } : {})
      }));
    }
  };
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
    `state:acquire:${paths.statePath}.lock`,
    `writer:acquire:${paths.storeDir}`,
    `assert:owner:${paths.storeDir}`,
    `writer:release:${paths.storeDir}`,
    `state:release:${paths.statePath}.lock`,
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
      tail: [terminalAcquire, stateAcquire, terminalRelease]
    },
    {
      name: "writer acquire failure releases state then terminal",
      failures: { writerAcquire: errors.writerAcquire },
      expectedError: errors.writerAcquire,
      tail: [
        terminalAcquire, stateAcquire, writerAcquire,
        stateRelease, terminalRelease
      ]
    },
    {
      name: "writer release overrides the operation error",
      failures: {
        operation: errors.operation,
        writerRelease: errors.writerRelease
      },
      expectedError: errors.writerRelease,
      tail: [
        terminalAcquire, stateAcquire, writerAcquire,
        `assert:owner:${paths.storeDir}`, writerRelease,
        stateRelease, terminalRelease
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
        terminalAcquire, stateAcquire, writerAcquire,
        `assert:owner:${paths.storeDir}`, writerRelease,
        stateRelease, terminalRelease
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
        terminalAcquire, stateAcquire, writerAcquire,
        `assert:owner:${paths.storeDir}`, writerRelease,
        stateRelease, terminalRelease
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
        terminalAcquire, stateAcquire, writerAcquire,
        `assert:owner:${paths.storeDir}`, writerRelease,
        stateRelease, terminalRelease
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

test("managed deferred close preflights malformed ledger before any durable write", async (t) => {
  const fixture = userAbandonmentCloseFixture({ malformedLedger: true });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await assert.rejects(fixture.run(), /neither its exact generation/u);
  assert.equal(
    fixture.trace.some((entry) => [
      "transfer:intent",
      "turn:save",
      "ledger:save",
      "session:release-source",
      "session:release-target",
      "event:append",
      "transfer:final"
    ].includes(entry)),
    false
  );
  assert.equal(fixture.transfer().status, "target_prepared");
  assert.equal(fixture.conversation().status, "waiting_for_agent");
});

test("managed deferred close preflights malformed callback start before intent", async (t) => {
  const fixture = userAbandonmentCloseFixture({
    malformedCallbackStart: true
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    fixture.run(),
    /callback transport-start authority is invalid/u
  );
  assert.equal(
    fixture.trace.some((entry) => [
      "transfer:intent",
      "turn:save",
      "ledger:save",
      "session:release-source",
      "session:release-target",
      "event:append",
      "transfer:final"
    ].includes(entry)),
    false
  );
  assert.equal(fixture.transfer().status, "target_prepared");
  assert.equal(fixture.conversation().status, "waiting_for_agent");
  assert.equal(fixture.ledger()?.status, "prepared");
  assert.equal(fs.existsSync(fixture.paths.logPath), false);
});

test("managed deferred close preflights conflicting events before intent", async (t) => {
  for (const preexistingEvent of ["conflict", "duplicate"] as const) {
    await t.test(preexistingEvent, async () => {
      const fixture = userAbandonmentCloseFixture({ preexistingEvent });
      try {
        await assert.rejects(
          fixture.run(),
          preexistingEvent === "duplicate"
            ? /duplicate user abandonment close events/u
            : /close event conflicts/u
        );
        assert.equal(
          fixture.trace.some((entry) => [
            "transfer:intent",
            "turn:save",
            "ledger:save",
            "session:release-source",
            "session:release-target",
            "transfer:final"
          ].includes(entry)),
          false
        );
        assert.equal(fixture.transfer().status, "target_prepared");
        assert.equal(fixture.conversation().status, "waiting_for_agent");
        assert.equal(fixture.ledger()?.status, "prepared");
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("managed deferred close orders intent, Turn, ledger, Sessions, event, and final", async (t) => {
  const fixture = userAbandonmentCloseFixture({});
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await fixture.run();
  const output = JSON.parse(result.stdout);
  assert.equal(output.disposition, "user_abandoned_management");
  assert.equal(output.coding_agent_stopped, false);
  assert.equal(output.terminal_input_sent, false);
  assert.equal(output.management_released, true);
  assert.equal(fixture.transfer().status, "user_abandoned");
  assert.equal(fixture.ledger()?.status, "resolved");
  assert.equal(fixture.ledger()?.callback_expected, false);
  assert.equal(
    (fixture.conversation().callback_delivery as Record<string, unknown>)
      .status,
    "superseded"
  );
  assertOrdered(fixture.trace.join("\n"), [
    "lock:terminal",
    "lock:writer",
    "lock:state",
    "ledger:load",
    "transfer:intent",
    "turn:save",
    "ledger:save",
    "session:release-source",
    "session:release-target",
    "event:append",
    "transfer:final",
    "unlock:state",
    "unlock:writer",
    "unlock:terminal"
  ]);
  const events = readNdjsonLog(fixture.paths.logPath).filter((event) =>
    event.event === "conversation_closed" &&
    event.disposition === "user_abandoned_management"
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.management_release_pending, true);
  assert.equal(events[0]?.management_released, undefined);
  assert.equal(events[0]?.terminal_input_sent, false);
  assert.equal(events[0]?.coding_agent_stopped, false);
});

test("fresh Watch starts after managed deferred close reaches its final release", async (t) => {
  const fixture = userAbandonmentCloseFixture({});
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await fixture.run();
  assert.equal(fixture.transfer().status, "user_abandoned");

  const rolloutPath = path.join(fixture.root, "watch-rollout.jsonl");
  const nativeThreadId = "019f0000-0000-7000-8000-000000000901";
  const nativeTurnId = "019f0000-0000-7000-8000-000000000902";
  fs.writeFileSync(rolloutPath, [
    {
      timestamp: "2026-08-20T01:02:00.000Z",
      type: "session_meta",
      payload: {
        id: nativeThreadId,
        cwd: fixture.root,
        originator: "codex-tui",
        source: "cli",
        cli_version: "0.148.0"
      }
    },
    {
      timestamp: "2026-08-20T01:02:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: nativeTurnId }
    },
    {
      timestamp: "2026-08-20T01:02:01.010Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "keep coding after AKK close" }],
        internal_chat_message_metadata_passthrough: { turn_id: nativeTurnId }
      }
    },
    {
      timestamp: "2026-08-20T01:02:01.011Z",
      type: "event_msg",
      payload: { type: "user_message", message: "keep coding after AKK close" }
    }
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  const stat = fs.statSync(rolloutPath);
  const terminalId = "terminal:v2:tmux:codex:abandon:0.0:4242";
  const terminal = {
    id: terminalId,
    source: "terminal",
    agent: "codex",
    pid: 4242,
    workspace: fixture.root,
    cwd: fixture.root,
    native_agent_session_id: nativeThreadId,
    native_agent_process_uuid: "codex-pid:4242:birth:watch-after-close",
    native_agent_process_birth: "watch-after-close",
    native_agent_rollout: {
      fd: "12r",
      device: String(stat.dev),
      inode: String(stat.ino),
      path: rolloutPath
    },
    agent_version: "0.148.0",
    lifecycle_binding_token: "9".repeat(64),
    activity_state: "working",
    approval_state: { blocked: false, approvable: false },
    terminal_control: {
      kind: "tmux",
      target: "abandon:0.0",
      session: "abandon",
      window: 0,
      pane: 0,
      panePid: 4242,
      currentCommand: "codex",
      currentPath: fixture.root,
      capabilities: ["screen_status", "durable_completion"]
    },
    available_actions: {
      watch: {
        tool: "agent_knock_knock_watch",
        arguments: { terminal_id: terminalId },
        requires_user_intent: true
      }
    }
  };
  const printed: unknown[] = [];
  const watch = createTerminalWatchCliAdapter({
    acquireFileLock: () => () => undefined,
    acquireTerminalLock: () => () => undefined,
    observeExactTerminal: async () => ({
      state: "available",
      rawTerminal: terminal,
      terminal,
      summary: {}
    }),
    loadClaudeAgentRows: () => [],
    now: () => NOW,
    randomUUID: () => "00000000-0000-4000-8000-000000000903",
    storeDirFromOptions: () => fixture.paths.storeDir,
    terminalDispatchOwnership: () => ({ state: "none" }),
    terminalIncarnationBlockingTurns: () =>
      fixture.transfer().status === "user_abandoned"
        ? []
        : [fixture.conversation()],
    printJson: (value) => printed.push(value)
  });

  await watch.runWatch({
    terminal: terminalId,
    openclawSession: "agent:main:main",
    storeDir: fixture.paths.storeDir
  });
  assert.equal(watch.listPublicWatches(fixture.paths.storeDir).length, 1);
  assert.equal(
    (printed.at(-1) as { watch?: { status?: string } }).watch?.status,
    "active"
  );
});

test("managed deferred close recovers every durable crash window idempotently", async (t) => {
  for (const stage of [
    "intent",
    "turn",
    "ledger",
    "source",
    "target",
    "event",
    "final"
  ] as const) {
    await t.test(stage, async () => {
      const fixture = userAbandonmentCloseFixture({ crashOnce: stage });
      try {
        await assert.rejects(
          fixture.run(),
          new RegExp(`simulated crash after ${stage}`, "u")
        );
        const recovered = await fixture.run();
        const output = JSON.parse(recovered.stdout);
        assert.equal(output.management_released, true);
        assert.equal(output.coding_agent_stopped, false);
        assert.equal(output.terminal_input_sent, false);
        assert.equal(fixture.transfer().status, "user_abandoned");
        assert.equal(fixture.ledger()?.status, "resolved");
        assert.equal(
          readNdjsonLog(fixture.paths.logPath).filter((event) =>
            event.event === "conversation_closed" &&
            event.disposition === "user_abandoned_management"
          ).length,
          1
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("managed deferred close freezes a custom reason across intent recovery", async (t) => {
  const fixture = userAbandonmentCloseFixture({
    crashOnce: "intent",
    closeReason: "operator explicitly released AKK management",
    recoveryNow: new Date("2026-08-15T05:05:06.000Z")
  });
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await assert.rejects(fixture.run(), /simulated crash after intent/u);
  assert.equal(
    fixture.transfer().user_abandonment_close_reason,
    "operator explicitly released AKK management"
  );
  const recovered = await fixture.run();
  assert.equal(JSON.parse(recovered.stdout).management_released, true);
  assert.equal(
    fixture.conversation().close_reason,
    "operator explicitly released AKK management"
  );
  assert.equal(fixture.conversation().closed_at, NOW.toISOString());
  const closeEvent = readNdjsonLog(fixture.paths.logPath).find((event) =>
    event.event === "conversation_closed" &&
    event.transfer_id === fixture.transfer().transfer_id
  );
  assert.equal(
    closeEvent?.reason,
    "operator explicitly released AKK management"
  );
  assert.equal(closeEvent?.ts, NOW.toISOString());
});

test("final user abandonment replay fails closed when its close event is missing", async (t) => {
  const fixture = userAbandonmentCloseFixture({});
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await fixture.run();
  fs.rmSync(fixture.paths.logPath);
  fixture.rollbackFinalOperationalReceipts();
  fixture.trace.length = 0;
  await assert.rejects(
    fixture.run(),
    /final user abandonment is missing its exact close event/u
  );
  assert.equal(fs.existsSync(fixture.paths.logPath), false);
  assert.equal(
    fixture.trace.some((entry) => [
      "transfer:intent",
      "turn:save",
      "ledger:save",
      "session:release-source",
      "session:release-target",
      "event:append",
      "transfer:final"
    ].includes(entry)),
    false
  );
  assert.equal(fixture.transfer().status, "user_abandoned");
  assert.equal(
    (fixture.conversation().callback_delivery as Record<string, unknown>)
      .status,
    "pending"
  );
  assert.equal(fixture.ledger()?.status, "prepared");
});

test("final user abandonment replay never repairs callback or ledger receipts", async (t) => {
  for (const receipt of ["callback", "ledger"] as const) {
    await t.test(receipt, async () => {
      const fixture = userAbandonmentCloseFixture({});
      try {
        await fixture.run();
        if (receipt === "callback") fixture.rollbackFinalCallbackReceipt();
        else fixture.rollbackFinalLedgerReceipt();
        fixture.trace.length = 0;
        await assert.rejects(
          fixture.run(),
          receipt === "callback"
            ? /callback abandonment fence after finalization/u
            : /final dispatch ledger abandonment receipt changed/u
        );
        assert.equal(
          fixture.trace.some((entry) => [
            "turn:save",
            "ledger:save",
            "session:release-source",
            "session:release-target",
            "event:append",
            "transfer:final"
          ].includes(entry)),
          false
        );
        assert.equal(fixture.transfer().status, "user_abandoned");
        assert.equal(
          (fixture.conversation().callback_delivery as Record<string, unknown>)
            .status,
          receipt === "callback" ? "pending" : "superseded"
        );
        assert.equal(
          fixture.ledger()?.status,
          receipt === "ledger" ? "prepared" : "resolved"
        );
      } finally {
        fs.rmSync(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("final user abandonment with lost terminal authority never falls through to generic close", async (t) => {
  const fixture = userAbandonmentCloseFixture({});
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  await fixture.run();
  fixture.removeFinalTerminalControl();
  fixture.trace.length = 0;
  const stateBefore = fs.readFileSync(fixture.paths.statePath, "utf8");
  const eventBefore = fs.readFileSync(fixture.paths.logPath, "utf8");
  const ledgerBefore = JSON.stringify(fixture.ledger());
  await assert.rejects(
    fixture.run(),
    /lost its final deferred user abandonment authority/u
  );
  assert.equal(fs.readFileSync(fixture.paths.statePath, "utf8"), stateBefore);
  assert.equal(fs.readFileSync(fixture.paths.logPath, "utf8"), eventBefore);
  assert.equal(JSON.stringify(fixture.ledger()), ledgerBefore);
  assert.equal(fixture.transfer().status, "user_abandoned");
  assert.equal(fixture.trace.some((entry) => [
    "turn:save",
    "ledger:save",
    "session:release-source",
    "session:release-target",
    "event:append",
    "transfer:final"
  ].includes(entry)), false);
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
    "acquireFileLock(`${statePath}.lock`)",
    "pathsForConversationDir(",
    "withStoreWriterLease(writerStoreDir",
    "loadState(statePath)",
    "assertManagedTerminalDispatchOwner({",
    "createTerminalAgentBridge(options).cancel(",
    "appendEvent(logPath, {",
    "saveState(statePath, nextConversation)",
    "printJson({",
    "releaseStateLock?.()",
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
    "runObservedHandoffClose({",
    "deferredUserAbandonmentCloseRoute(options, loaded)",
    "acquireTerminalBridgeSendLock(",
    "assertConversationHasNoNonterminalDeferredForegroundTransfer({",
    "exactVerifiedDeadTerminalAgentProcessAuthority({",
    "assertGenericCloseDoesNotBypassObservedHandoff({",
    "saveState(statePath, closed)",
    "resolveTerminalBridgeDispatchLedger(currentTerminalControl, {",
    "appendEvent(logPath, {",
    "printJson({"
  ]);

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
    assert.equal(Math.max(...metrics.map((entry) => entry.span)), 265);
    assert.equal(Math.max(...metrics.map((entry) => entry.complexity)), 32);
    assert.ok(metrics.every((entry) => entry.span < 500));
    assert.ok(metrics.every((entry) => entry.complexity < 50));
  } finally {
    api.close();
  }
});

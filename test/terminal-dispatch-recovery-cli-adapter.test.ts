import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { createConversation } from "../src/protocol.js";
import {
  createTerminalDispatchRecoveryCliAdapter
} from "../src/terminal-dispatch-recovery-cli-adapter.js";
import type {
  TerminalDispatchRepositoryCliAdapter
} from "../src/terminal-dispatch-repository-cli-adapter.js";
import {
  createTerminalDispatchRepositoryCliAdapter
} from "../src/terminal-dispatch-repository-cli-adapter.js";
import {
  constructTerminalDispatchLedgerDocument,
  type TerminalDispatchLedgerDocument
} from "../src/terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeRequestFingerprint
} from "../src/terminal-dispatch-receipt.js";
import {
  createTerminalEndpointRef,
  terminalControlEvidence,
  terminalEndpointFromControlRef,
  type TerminalControlRef
} from "../src/terminal-control-ref.js";
import { ensureStoreWritable } from "../src/store.js";

const NOW = new Date("2026-08-15T04:05:06.000Z");
const PRIOR_AT = "2026-08-15T04:00:00.000Z";
const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "akk:0.1",
  socketPath: "/private/tmp/tmux-501/default",
  session: "akk",
  window: 0,
  pane: 1,
  panePid: 4200,
  currentPath: "/repo/project",
  capabilities: ["send_keys", "screen_status"]
};

function conversationPaths(root: string) {
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const conversationDir = path.join(storeDir, "conversations", "turn-1");
  const statePath = path.join(conversationDir, "state.json");
  const logPath = path.join(conversationDir, "events.ndjson");
  fs.mkdirSync(conversationDir, { recursive: true });
  return { storeDir, statePath, logPath };
}

function writeConversation(
  statePath: string,
  conversation: ReturnType<typeof createConversation>
): void {
  fs.writeFileSync(
    statePath,
    `${JSON.stringify(conversation, null, 2)}\n`,
    { mode: 0o600 }
  );
}

function acceptedConversation(input: {
  statePath: string;
  logPath: string;
  messageId?: string;
  submissionSessionId?: string;
  receiptHistory?: unknown;
}) {
  const messageId = input.messageId ?? "message-1";
  const requestText = "recover this exact terminal Turn";
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  const submission = {
    status: "agent_accepted",
    session_id: input.submissionSessionId ?? "session-1",
    turn_id: "turn-1",
    message_id: messageId,
    binding_id: "binding-1",
    binding_generation: 1,
    request_hash: requestHash,
    prepared_at: PRIOR_AT,
    text_injected_at: PRIOR_AT,
    enter_dispatched_at: PRIOR_AT,
    agent_accepted_at: PRIOR_AT,
    acceptance_evidence: { poison: "must remain lazy" }
  };
  return {
    ...createConversation({
      userRequest: requestText,
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      now: NOW
    }),
    status: "waiting_for_agent" as const,
    state_path: input.statePath,
    event_log_path: input.logPath,
    terminal_binding_id: "binding-1",
    terminal_binding_generation: 1,
    native_thread_id: "11111111-1111-4111-8111-111111111111",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: messageId,
      terminal_bridge_request_text: requestText,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts:
        input.receiptHistory ?? [submission]
    }
  };
}

function basicAcceptedLedger(input: {
  storeDir: string;
  statePath: string;
  logPath: string;
  requestHash?: string;
}): TerminalDispatchLedgerDocument {
  return {
    status: "agent_accepted",
    generation_id: "message-1",
    conversation_id: "turn-1",
    session_id: "session-1",
    turn_id: "turn-1",
    message_id: "message-1",
    request_hash: input.requestHash ?? terminalBridgeRequestFingerprint(
      "recover this exact terminal Turn"
    ),
    state_path: input.statePath,
    store_dir: input.storeDir,
    event_log_path: input.logPath,
    binding_id: "binding-1",
    binding_generation: 1,
    native_thread_id: "11111111-1111-4111-8111-111111111111",
    executor_kind: "codex",
    callback_expected: false,
    terminal_endpoint: {},
    terminal_submission_receipts: "poison"
  };
}

function associateCanonicalControl(): void {
  const routeKey = terminalEndpointFromControlRef(CONTROL).route.routeKey;
  createTerminalEndpointRef({
    identity: {
      providerKind: "tmux",
      endpointKey: "socket:/private/tmp/tmux-501/default",
      resourceKey: "pane-id:%42"
    },
    route: {
      routeKey,
      label: CONTROL.target,
      currentPath: CONTROL.currentPath
    },
    processAnchorPid: CONTROL.panePid,
    capabilities: CONTROL.capabilities,
    providerRef: CONTROL
  });
}

test("transaction adapter releases state and writer before terminal after reload error", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-recovery-transaction-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const conversationDir = path.join(storeDir, "conversations", "turn-1");
  const statePath = path.join(conversationDir, "state.json");
  const logPath = path.join(conversationDir, "events.ndjson");
  fs.mkdirSync(conversationDir, { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    ...createConversation({
      userRequest: "recover local terminal completion",
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      now: new Date("2026-08-15T04:05:06.000Z")
    }),
    status: "idle",
    native_session_takeover: {
      terminal_bridge_completion_claim: {
        callback_message_id: "callback-1",
        completion_fingerprint: "fingerprint-1",
        completion_id: "completion-1",
        claimed_at: "2026-08-15T04:05:06.000Z",
        outcome: "success"
      }
    }
  }, null, 2)}\n`, { mode: 0o600 });

  const trace: string[] = [];
  const repository = {
    acquire() {
      trace.push("terminal:acquire");
      fs.writeFileSync(statePath, "{", "utf8");
      return () => {
        assert.equal(fs.existsSync(`${statePath}.lock`), false);
        assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
        trace.push("terminal:release");
      };
    }
  } as unknown as TerminalDispatchRepositoryCliAdapter;
  const facade = createTerminalDispatchRecoveryCliAdapter({
    repository,
    authority: {
      terminalControl: () => CONTROL,
      assertTurnBindingCurrent: () => undefined,
      storeDirForConversation: () => storeDir
    },
    observation: {
      process: async () => ({ status: "unverifiable", reason: "unused" }),
      completion: async () => ({ status: "unverifiable", reason: "unused" })
    },
    completion: {
      prepare: () => {
        throw new Error("unused completion preparation");
      }
    },
    runtime: { isProcessAlive: () => false }
  });

  await runCliCommandExecution("recovery-transaction-test", {}, {
    runtimeLog: () => undefined
  }, async () => {
    assert.throws(
      () => facade.settleLocalCompletion({ storeDir, statePath, logPath }),
      SyntaxError
    );
  });

  assert.deepEqual(trace, ["terminal:acquire", "terminal:release"]);
  assert.equal(fs.existsSync(`${statePath}.lock`), false);
  assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
});

test("prepared owner mismatch observes neither clock nor Store binding facts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-prepared-lazy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { statePath, logPath } = conversationPaths(root);
  writeConversation(statePath, {
    ...createConversation({
      userRequest: "mismatched owner",
      sessionId: "session-other",
      turnId: "turn-other",
      executorKind: "codex",
      now: NOW
    }),
    state_path: statePath,
    event_log_path: logPath
  });
  let clockReads = 0;
  let storeReads = 0;
  let repositoryWrites = 0;
  const ledger: TerminalDispatchLedgerDocument = {
    status: "prepared",
    conversation_id: "turn-1",
    message_id: "message-1",
    dispatcher_pid: 999_999,
    state_path: statePath,
    event_log_path: logPath
  };
  const repository = {
    save() {
      repositoryWrites += 1;
      throw new Error("owner mismatch must not write the repository");
    },
    load() {
      throw new Error("owner mismatch must not reload the repository");
    }
  } as unknown as TerminalDispatchRepositoryCliAdapter;
  const facade = createTerminalDispatchRecoveryCliAdapter({
    repository,
    authority: {
      terminalControl: () => CONTROL,
      assertTurnBindingCurrent: () => undefined,
      storeDirForConversation: () => {
        storeReads += 1;
        throw new Error("owner mismatch must not project Store binding facts");
      }
    },
    observation: {
      process: async () => ({ status: "unverifiable", reason: "unused" }),
      completion: async () => ({ status: "unverifiable", reason: "unused" })
    },
    completion: {
      prepare: () => {
        throw new Error("unused completion preparation");
      }
    },
    runtime: { isProcessAlive: () => false }
  });
  await runCliCommandExecution("prepared-lazy-test", {}, {
    now: () => {
      clockReads += 1;
      throw new Error("prepared keep path must not read the clock");
    },
    pid: process.pid,
    runtimeLog: () => undefined
  }, async () => {
    assert.equal(facade.reconcilePrepared(CONTROL, ledger), ledger);
  });
  assert.equal(clockReads, 0);
  assert.equal(storeReads, 0);
  assert.equal(repositoryWrites, 0);
});

test("prepared recovery replaces the prior durable generation with parent-exact bytes", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-prepared-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { storeDir, statePath, logPath } = conversationPaths(root);
  const runtimeDir = path.join(root, "runtime");
  const priorMessageId = "message-prior";
  const currentMessageId = "message-current";
  const requestText = "restore the prior durable generation";
  const requestHash = terminalBridgeRequestFingerprint(requestText);
  const submission = {
    status: "submitted",
    session_id: "session-1",
    turn_id: "turn-1",
    message_id: priorMessageId,
    message_type: "task",
    binding_id: "binding-1",
    binding_generation: 2,
    native_thread_id: "11111111-1111-4111-8111-111111111111",
    request_hash: requestHash,
    prepared_at: PRIOR_AT,
    submitted_at: PRIOR_AT,
    dispatcher_pid: 4102,
    last_proven_stage: "enter_dispatched"
  };
  writeConversation(statePath, {
    ...createConversation({
      userRequest: requestText,
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      now: NOW
    }),
    status: "waiting_for_agent",
    state_path: statePath,
    event_log_path: logPath,
    terminal_binding_id: "binding-1",
    terminal_binding_generation: 2,
    native_thread_id: "11111111-1111-4111-8111-111111111111",
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: priorMessageId,
      terminal_bridge_request_text: requestText,
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    }
  });
  associateCanonicalControl();

  await runCliCommandExecution("prepared-replace-test", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: runtimeDir },
    now: () => NOW,
    pid: process.pid,
    runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    const preparedLedger: TerminalDispatchLedgerDocument = {
      binding_id: "binding-current",
      binding_generation: 3,
      native_thread_id: "22222222-2222-4222-8222-222222222222",
      store_dir: storeDir,
      executor_kind: "codex",
      status: "prepared",
      generation_id: currentMessageId,
      conversation_id: "turn-1",
      session_id: "session-1",
      turn_id: "turn-1",
      message_id: currentMessageId,
      message_type: "task",
      request_hash: terminalBridgeRequestFingerprint("new generation"),
      prepared_at: NOW.toISOString(),
      dispatcher_pid: 999_999,
      state_path: statePath,
      event_log_path: logPath,
      callback_expected: false,
      previous_generation_id: priorMessageId
    };
    repository.save(CONTROL, preparedLedger);
    const previousLedger = repository.load(CONTROL);
    const facade = createTerminalDispatchRecoveryCliAdapter({
      repository,
      authority: {
        terminalControl: () => CONTROL,
        assertTurnBindingCurrent: () => undefined,
        storeDirForConversation: () => storeDir
      },
      observation: {
        process: async () => ({ status: "unverifiable", reason: "unused" }),
        completion: async () => ({ status: "unverifiable", reason: "unused" })
      },
      completion: {
        prepare: () => {
          throw new Error("unused completion preparation");
        }
      },
      runtime: { isProcessAlive: () => false }
    });
    const restored = facade.reconcilePrepared(CONTROL, previousLedger);
    assert.equal(restored?.generation_id, priorMessageId);
    assert.equal(restored?.previous_generation_id, undefined);

    const expectedIncoming: TerminalDispatchLedgerDocument = {
      binding_id: "binding-1",
      binding_generation: 2,
      native_thread_id: "11111111-1111-4111-8111-111111111111",
      store_dir: path.resolve(storeDir),
      message_type: "task",
      executor_kind: "codex",
      openclaw_session: "agent:main:main",
      status: "submitted",
      generation_id: priorMessageId,
      conversation_id: "turn-1",
      message_id: priorMessageId,
      request_hash: requestHash,
      prepared_at: PRIOR_AT,
      submitted_at: PRIOR_AT,
      dispatcher_pid: null,
      state_path: statePath,
      event_log_path: logPath,
      callback_expected: false,
      reason:
        "restored the prior durable generation after a pre-submit dispatcher exit"
    };
    const expected = constructTerminalDispatchLedgerDocument({
      previousLedger,
      incomingLedger: expectedIncoming,
      version: 2,
      terminalKey: repository.runtimeKey(CONTROL),
      terminalControl: {
        kind: CONTROL.kind,
        target: CONTROL.target,
        socket_path: CONTROL.socketPath ?? null,
        pane_pid: CONTROL.panePid ?? null,
        current_path: CONTROL.currentPath ?? null
      },
      terminalEndpoint: terminalControlEvidence(CONTROL)
    });
    const ledgerPath = path.join(
      repository.runtimeDir(),
      "terminal-dispatch",
      `terminal-dispatch-${repository.runtimeKey(CONTROL)}.json`
    );
    const raw = fs.readFileSync(ledgerPath, "utf8");
    assert.equal(raw, `${JSON.stringify(expected, null, 2)}\n`);
    assert.deepEqual(Object.keys(JSON.parse(raw) as Record<string, unknown>),
      Object.keys(expected));
    assert.equal(raw.includes('"previous_generation_id"'), false);
  });
});

test("verified-dead recovery short-circuits state, ledger, receipts, and acceptance", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-verified-stages-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { storeDir, statePath, logPath } = conversationPaths(root);

  await runCliCommandExecution("verified-stage-test", {}, {
    now: () => NOW,
    pid: process.pid,
    runtimeLog: () => undefined
  }, async () => {
    async function runScenario(input: {
      conversation: ReturnType<typeof acceptedConversation>;
      expectedConversationId?: string;
      ledger?: TerminalDispatchLedgerDocument;
    }) {
      writeConversation(statePath, input.conversation);
      const calls = {
        acquire: 0,
        load: 0,
        matches: 0,
        anchor: 0,
        binding: 0,
        storeDir: 0,
        observation: 0
      };
      const repository = {
        acquire() {
          calls.acquire += 1;
          return () => undefined;
        },
        load() {
          calls.load += 1;
          return input.ledger;
        },
        matchesControl() {
          calls.matches += 1;
          return true;
        },
        processAnchor() {
          calls.anchor += 1;
          return CONTROL.panePid;
        }
      } as unknown as TerminalDispatchRepositoryCliAdapter;
      const facade = createTerminalDispatchRecoveryCliAdapter({
        repository,
        authority: {
          terminalControl: () => CONTROL,
          assertTurnBindingCurrent: () => {
            calls.binding += 1;
          },
          storeDirForConversation: () => {
            calls.storeDir += 1;
            return storeDir;
          }
        },
        observation: {
          process: async () => {
            calls.observation += 1;
            throw new Error("process observation must remain lazy");
          },
          completion: async () => {
            calls.observation += 1;
            throw new Error("completion observation must remain lazy");
          }
        },
        completion: {
          prepare: () => {
            throw new Error("completion preparation must remain lazy");
          }
        },
        runtime: { isProcessAlive: () => false }
      });
      const result = await facade.stallAccepted({
        options: {},
        storeDir,
        statePath,
        logPath,
        expectedConversationId: input.expectedConversationId ?? "turn-1",
        expectedMessageId: "message-1"
      });
      return { result, calls };
    }

    const early = await runScenario({
      conversation: acceptedConversation({ statePath, logPath }),
      expectedConversationId: "turn-other"
    });
    assert.equal(early.result.reason, "dead_process_stall_not_applicable");
    assert.deepEqual(early.calls, {
      acquire: 0, load: 0, matches: 0, anchor: 0,
      binding: 0, storeDir: 0, observation: 0
    });

    const basic = await runScenario({
      conversation: acceptedConversation({ statePath, logPath })
    });
    assert.equal(basic.result.reason, "dead_process_stall_dispatch_changed");
    assert.deepEqual(basic.calls, {
      acquire: 1, load: 1, matches: 0, anchor: 0,
      binding: 1, storeDir: 0, observation: 0
    });

    const state = await runScenario({
      conversation: acceptedConversation({
        statePath,
        logPath,
        submissionSessionId: "session-other",
        receiptHistory: "poison"
      }),
      ledger: basicAcceptedLedger({ storeDir, statePath, logPath })
    });
    assert.equal(
      state.result.reason,
      "dead_process_stall_dispatch_changed: verified-dead Turn turn-1 has no exact accepted submission authority"
    );
    assert.deepEqual(state.calls, {
      acquire: 1, load: 1, matches: 1, anchor: 1,
      binding: 2, storeDir: 0, observation: 0
    });

    const ledger = await runScenario({
      conversation: acceptedConversation({
        statePath,
        logPath,
        receiptHistory: "poison"
      }),
      ledger: basicAcceptedLedger({
        storeDir,
        statePath,
        logPath,
        requestHash: "wrong-ledger-request-hash"
      })
    });
    assert.equal(
      ledger.result.reason,
      "dead_process_stall_dispatch_changed: verified-dead Turn turn-1 no longer owns one exact terminal dispatch receipt"
    );
    assert.deepEqual(ledger.calls, {
      acquire: 1, load: 2, matches: 1, anchor: 1,
      binding: 2, storeDir: 1, observation: 0
    });
  });
});

test("failed state-claim release is retried by the enclosing finally", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-state-release-retry-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { storeDir, statePath, logPath } = conversationPaths(root);
  writeConversation(statePath, acceptedConversation({ statePath, logPath }));
  const trace: string[] = [];
  const repository = {
    acquire() {
      trace.push("terminal:acquire");
      return () => trace.push("terminal:release");
    },
    load() {
      throw new Error("basic ledger must remain after the binding fence");
    }
  } as unknown as TerminalDispatchRepositoryCliAdapter;
  const facade = createTerminalDispatchRecoveryCliAdapter({
    repository,
    authority: {
      terminalControl: () => CONTROL,
      assertTurnBindingCurrent: () => {
        throw new Error("binding changed before recovery");
      },
      storeDirForConversation: () => {
        throw new Error("Store facts must remain after the binding fence");
      }
    },
    observation: {
      process: async () => ({ status: "unverifiable", reason: "unused" }),
      completion: async () => ({ status: "unverifiable", reason: "unused" })
    },
    completion: {
      prepare: () => {
        throw new Error("unused completion preparation");
      }
    },
    runtime: { isProcessAlive: () => false }
  });

  const stateLockPath = `${statePath}.lock`;
  const originalUnlink = fs.unlinkSync;
  let stateReleaseAttempts = 0;
  Object.defineProperty(fs, "unlinkSync", {
    configurable: true,
    writable: true,
    value(filePath: fs.PathLike) {
      if (String(filePath) === stateLockPath) {
        stateReleaseAttempts += 1;
        trace.push(`state:release:${stateReleaseAttempts}`);
        if (stateReleaseAttempts === 1) {
          throw Object.assign(new Error("state release failed once"), {
            code: "EIO"
          });
        }
      }
      return originalUnlink(filePath);
    }
  });
  try {
    await runCliCommandExecution("state-release-retry-test", {}, {
      now: () => NOW,
      pid: process.pid,
      runtimeLog: () => undefined
    }, async () => {
      await assert.rejects(
        facade.stallAccepted({
          options: {},
          storeDir,
          statePath,
          logPath,
          expectedConversationId: "turn-1",
          expectedMessageId: "message-1"
        }),
        /state release failed once/u
      );
    });
  } finally {
    Object.defineProperty(fs, "unlinkSync", {
      configurable: true,
      writable: true,
      value: originalUnlink
    });
  }
  assert.deepEqual(trace, [
    "terminal:acquire",
    "state:release:1",
    "state:release:2",
    "terminal:release"
  ]);
  assert.equal(fs.existsSync(stateLockPath), false);
  assert.equal(fs.existsSync(path.join(storeDir, ".akk-writer.lock")), false);
});

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as terminalCommandCliAdapter from
  "../src/terminal-command-cli-adapter.js";
import type { TerminalCommandCliDependencies } from
  "../src/terminal-command-cli-adapter.js";
import type { ResolvedTerminalConversation } from
  "../src/terminal-agent-bridge.js";
import type { TerminalAgentBridge } from
  "../src/terminal-agent-bridge.js";
import type {
  CanonicalMutationResources,
  CanonicalMutationScopes,
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "../src/mutation-transaction.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { loadState, pathsForConversation, saveState } from "../src/store.js";
import {
  saveTerminalSubmissionRetry,
  terminalSubmissionRetryPath,
  TERMINAL_SUBMISSION_RETRY_SCHEMA,
  TERMINAL_SUBMISSION_RETRY_VERSION
} from "../src/terminal-submission-retry-service.js";

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

type TerminalCommandPorts = TerminalCommandCliDependencies["ports"];

function compiledFunctionSource(
  name: string,
  nextName: string
): string {
  const source = fs.readFileSync(
    new URL("../src/terminal-command-cli-adapter.js", import.meta.url),
    "utf8"
  );
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start + 1);
  assert.notEqual(start, -1, `${name} must remain in the facade adapter`);
  assert.notEqual(end, -1, `${nextName} must follow ${name}`);
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

function facadeDependencies(
  marker: "A" | "B",
  events: string[],
  resolutionGate: DeferredGate
): TerminalCommandCliDependencies {
  const terminal = {
    conversationId: `terminal:tmux:${marker.toLowerCase()}:0.0:42`,
    agent: "codex",
    pid: 42,
    legacy: false,
    adapter: {},
    terminalControl: {
      kind: "tmux",
      target: `${marker.toLowerCase()}:0.0`,
      session: marker.toLowerCase(),
      window: 0,
      pane: 0,
      panePid: 42,
      capabilities: []
    }
  } as unknown as ResolvedTerminalConversation;
  const implemented = {
    required<Value>(
      value: Value | null | undefined,
      label: string
    ): Value {
      events.push(`${marker}:required:${label}`);
      if (value === undefined || value === null) {
        throw new Error(label);
      }
      return value;
    },
    async resolveTerminalConversationFromOptions() {
      events.push(`${marker}:resolve:before`);
      await resolutionGate.promise;
      events.push(`${marker}:resolve:after`);
      return terminal;
    },
    assertExpectedHandoffTokenUsesExactTerminalSelector() {
      events.push(`${marker}:selector`);
    }
  } satisfies Partial<TerminalCommandPorts>;
  const ports = new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`unexpected terminal command port ${String(property)}`);
    }
  }) as unknown as TerminalCommandPorts;
  return {
    ports
  };
}

test("terminal command facade preserves fake-port order and isolates async runtimes", async (t) => {
  assert.deepEqual(
    Object.keys(terminalCommandCliAdapter),
    ["createTerminalCommandCliFacade"]
  );
  const events: string[] = [];
  const gateA = deferredGate();
  const gateB = deferredGate();
  t.after(() => {
    gateA.release();
    gateB.release();
  });
  const facadeA = terminalCommandCliAdapter.createTerminalCommandCliFacade(
    facadeDependencies("A", events, gateA)
  );
  const facadeB = terminalCommandCliAdapter.createTerminalCommandCliFacade(
    facadeDependencies("B", events, gateB)
  );

  const sendA = facadeA.runSend({ message: "alpha", background: false });
  const sendB = facadeB.runSend({ message: "beta", background: false });
  assert.deepEqual(events, [
    "A:required:--message is required",
    "A:resolve:before",
    "B:required:--message is required",
    "B:resolve:before"
  ]);

  gateB.release();
  await assert.rejects(sendB, /raw terminal sends require --background/u);
  assert.deepEqual(events.slice(-2), ["B:resolve:after", "B:selector"]);
  gateA.release();
  await assert.rejects(sendA, /raw terminal sends require --background/u);
  assert.deepEqual(events, [
    "A:required:--message is required",
    "A:resolve:before",
    "B:required:--message is required",
    "B:resolve:before",
    "B:resolve:after",
    "B:selector",
    "A:resolve:after",
    "A:selector"
  ]);
});

test("exact Turn submission retry rejects mixed send options before terminal resolution", async () => {
  const events: string[] = [];
  const gate = deferredGate();
  const facade = terminalCommandCliAdapter.createTerminalCommandCliFacade(
    facadeDependencies("A", events, gate)
  );
  await assert.rejects(
    facade.runSend({ turn: "turn-1", message: "caller-controlled text" }),
    /exact submission recovery form.*--message/u
  );
  assert.deepEqual(events, ["A:required:--turn is required"]);
});

test("closed Turn fences new and resumed submission retry before I/O or sidecar advance", async () => {
  for (const resumed of [false, true]) {
    const sandbox = fs.mkdtempSync(path.join(
      os.tmpdir(),
      resumed ? "akk-closed-retry-resumed-" : "akk-closed-retry-new-"
    ));
    const storeDir = path.join(sandbox, "store");
    const turnId = resumed ? "turn-closed-resumed" : "turn-closed-new";
    const sessionId = `session-${turnId}`;
    const paths = pathsForConversation(turnId, storeDir);
    const terminalControl = {
      kind: "tmux" as const,
      target: "closed-retry:0.0",
      session: "closed-retry",
      window: 0,
      pane: 0,
      panePid: 42,
      capabilities: ["send_keys" as const, "screen_status" as const]
    };
    const openConversation: Conversation = {
      ...createConversation({
        userRequest: "retry the uncertain submission",
        sessionId,
        turnId,
        openclawSession: `agent:main:${turnId}`,
        executorKind: "codex",
        now: new Date("2026-08-24T01:00:00.000Z")
      }),
      status: "stalled",
      store_dir: paths.storeDir,
      conversation_dir: paths.conversationDir,
      event_log_path: paths.logPath,
      state_path: paths.statePath,
      native_session_takeover: {
        terminal_bridge: true,
        terminal_agent_pid: 42,
        terminal_bridge_message_id: "message-closed-retry",
        terminal_bridge_request_text: "retry the uncertain submission",
        terminal_control: terminalControl
      },
      updated_at: "2026-08-24T01:00:01.000Z"
    };
    try {
      saveState(paths.statePath, openConversation);
      if (resumed) {
        saveTerminalSubmissionRetry(paths.statePath, {
          schema: TERMINAL_SUBMISSION_RETRY_SCHEMA,
          version: TERMINAL_SUBMISSION_RETRY_VERSION,
          revision: 1,
          attempt_id: "submission-retry-existing",
          mode: "replacement_send",
          state: "replacement_reserved",
          store_dir: paths.storeDir,
          state_path: paths.statePath,
          session_id: sessionId,
          turn_id: turnId,
          original_message_id: "message-closed-retry",
          active_message_id: "message-closed-retry",
          request_hash: "a".repeat(64),
          terminal_target: terminalControl.target,
          callback_route_fingerprint: null,
          deferred_foreground_transfer_id: null,
          reserved_at: "2026-08-24T01:00:01.000Z",
          updated_at: "2026-08-24T01:00:01.000Z"
        }, null);
      }
      const closedConversation: Conversation = {
        ...openConversation,
        status: "closed",
        closed_at: "2026-08-24T01:00:02.000Z",
        close_reason: "closed by request",
        updated_at: "2026-08-24T01:00:02.000Z"
      };
      saveState(paths.statePath, closedConversation);
      const retryPath = terminalSubmissionRetryPath(paths.statePath);
      const stateBefore = fs.readFileSync(paths.statePath, "utf8");
      const retryBefore = fs.existsSync(retryPath)
        ? fs.readFileSync(retryPath, "utf8")
        : undefined;
      const effects: string[] = [];
      const bridge = {
        async resolveStoredTerminal() {
          effects.push("terminal-read");
          return {
            conversationId: "terminal:closed-retry:0.0:42",
            agent: "codex",
            pid: 42,
            legacy: false,
            adapter: {},
            terminalControl
          };
        },
        async observeCodexComposer() {
          effects.push("composer-read");
          throw new Error("closed retry reached composer observation");
        },
        async submitExactCodexDraft() {
          effects.push("terminal-enter");
          throw new Error("closed retry reached Enter transport");
        },
        async send() {
          effects.push("terminal-text");
          throw new Error("closed retry reached text transport");
        }
      } as unknown as TerminalAgentBridge;
      const implemented = {
        required<Value>(value: Value | null | undefined, label: string): Value {
          if (value === undefined || value === null) throw new Error(label);
          return value;
        },
        loadConversationFromOptions() {
          return {
            conversation: loadState(paths.statePath),
            statePath: paths.statePath,
            logPath: paths.logPath
          };
        },
        terminalControlFromTakeover() {
          return terminalControl;
        },
        createTerminalAgentBridge() {
          return bridge;
        },
        terminalRuntimeIdentityForConversation() {
          return {};
        },
        terminalWriterMutationLocks() {
          return {
            resources: {
              terminal: { key: terminalControl.target, value: terminalControl },
              storeWriter: { key: paths.storeDir, value: paths.storeDir }
            },
            acquireTerminal() {
              effects.push("terminal-lock");
              return () => effects.push("terminal-unlock");
            },
            async withStoreWriter<Result>(
              operation: () => Promise<Result>
            ): Promise<Result> {
              effects.push("writer-lock");
              try {
                return await operation();
              } finally {
                effects.push("writer-unlock");
              }
            }
          };
        },
        async withTerminalDispatchStateScope<Result>(
          scopes: CanonicalMutationScopes,
          resources: CanonicalMutationResources,
          statePath: string,
          logPath: string,
          operation: (
            lockedScopes: CanonicalStateMutationScopes,
            lockedResources: CanonicalStateMutationResources
          ) => Promise<Result>
        ): Promise<Result> {
          effects.push("state-lock");
          const lockedScopes = {
            ...scopes,
            state: Object.freeze({})
          } as CanonicalStateMutationScopes;
          const lockedResources = {
            ...resources,
            state: {
              key: statePath,
              value: { statePath, logPath }
            }
          } as CanonicalStateMutationResources;
          try {
            return await operation(lockedScopes, lockedResources);
          } finally {
            effects.push("state-unlock");
          }
        }
      } satisfies Partial<TerminalCommandPorts>;
      const ports = new Proxy(implemented, {
        get(target, property, receiver) {
          if (Reflect.has(target, property)) {
            return Reflect.get(target, property, receiver);
          }
          throw new Error(`unexpected closed retry port ${String(property)}`);
        }
      }) as unknown as TerminalCommandPorts;
      const facade = terminalCommandCliAdapter.createTerminalCommandCliFacade({
        ports
      });
      const options = { turn: turnId, storeDir };
      const execution = await runCliCommandExecution(
        "send",
        options,
        {},
        () => facade.runSend(options)
      );
      const result = JSON.parse(execution.stdout);
      assert.equal(result.terminal_input_sent, false);
      assert.equal(result.conversation.status, "closed");
      assert.match(result.reason, /explicitly closed.*no retry state was changed/u);
      assert.deepEqual(effects, [
        "terminal-read",
        "terminal-lock",
        "writer-lock",
        "state-lock",
        "state-unlock",
        "writer-unlock",
        "terminal-unlock"
      ]);
      assert.equal(fs.readFileSync(paths.statePath, "utf8"), stateBefore);
      assert.equal(
        fs.existsSync(retryPath) ? fs.readFileSync(retryPath, "utf8") : undefined,
        retryBefore
      );
    } finally {
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  }
});

test("exact Turn retry wires durable authority before composer input", () => {
  const command = compiledFunctionSource(
    "runTerminalSubmissionRetry",
    "runTerminalSubmissionExactDraftEnter"
  );
  assertOrdered(command, [
    "resolveStoredTerminal",
    "terminalControlsShareIncarnation",
    "withCanonicalMutationLocks",
    "withTerminalDispatchStateScope",
    "runTerminalSubmissionRetryLocked"
  ]);
  const authority = compiledFunctionSource(
    "loadTerminalSubmissionRetryLockedAuthority",
    "assertTerminalSubmissionRetryLedgerAuthority"
  );
  assertOrdered(authority, [
    "bindTerminalDispatchRoute",
    "assertTerminalSubmissionRetryTurnOpen",
    "loadTerminalSubmissionRetry",
    "validateStoredTerminalSubmissionMatch",
    "mutationDispatchLedger.load",
    "exactTerminalSubmissionRetryDeferredTransferId",
    "assertTerminalSubmissionRetryAttemptIdentity",
    "assertTerminalSubmissionRetryGeneration"
  ]);
  const deferred = compiledFunctionSource(
    "prepareTerminalSubmissionRetryDeferredContext",
    "assertTerminalSubmissionRetryDeferredTransferAuthority"
  );
  assertOrdered(deferred, [
    "assertTerminalSubmissionRetryDeferredMirrorCanReconcile",
    "reconcileTerminalSubmissionRetryLedgerPrefix",
    "reconcileTerminalSubmissionRetryDeferredTransfer",
    "assertTerminalSubmissionRetryDeferredTransferAuthority",
    "assertTransferAuthority",
    "assertTerminalSubmissionRetryDeferredMirror"
  ]);
  const noInput = compiledFunctionSource(
    "runTerminalSubmissionRetryNoInputRecovery",
    "runTerminalSubmissionRetryDecision"
  );
  assertOrdered(noInput, [
    "reconcileTerminalSubmissionRetryDeferredPending",
    "recoverPartialTerminalSubmissionRetryAcceptance",
    "terminalSubmissionRetryIsEligible",
    "recoverTerminalSubmissionRetryAcceptance",
    "finishPendingTerminalSubmissionRetry",
    "terminalSubmissionRetryHasInputAuthority"
  ]);
  const decision = compiledFunctionSource(
    "runTerminalSubmissionRetryDecision",
    "runTerminalSubmissionRetryLocked"
  );
  assertOrdered(decision, [
    "assertDeferredCodexForegroundBindingBoundary",
    "observeCodexComposer",
    "decideTerminalSubmissionRetry",
    "runTerminalSubmissionReplacement",
    "runTerminalSubmissionExactDraftEnter"
  ]);
  const locked = compiledFunctionSource(
    "runTerminalSubmissionRetryLocked",
    "runTerminalSubmissionRetry"
  );
  assertOrdered(locked, [
    "loadExactTerminalSubmissionRetryTurn",
    'freshConversation.status === "closed"',
    "return",
    "loadTerminalSubmissionRetryLockedAuthority",
    "prepareTerminalSubmissionRetryDeferredContext",
    "terminalDispatchExecution",
    "runTerminalSubmissionRetryNoInputRecovery",
    "runTerminalSubmissionRetryDecision"
  ]);
  assert.equal(
    [authority, deferred, noInput, decision, locked, command]
      .join("\n")
      .includes("plannedDeferredReplacement"),
    false,
    "a reserved replacement must not bypass acceptance-first recovery"
  );
  const replacement = compiledFunctionSource(
    "runTerminalSubmissionReplacement",
    "runSend"
  );
  const closedFence = compiledFunctionSource(
    "assertTerminalSubmissionRetryTurnOpen",
    "saveTerminalSubmissionRetryForOpenTurn"
  );
  assertOrdered(closedFence, [
    "loadExactTerminalSubmissionRetryTurn",
    'conversation.status === "closed"',
    "retry state was changed"
  ]);
  const sidecarFence = compiledFunctionSource(
    "saveTerminalSubmissionRetryForOpenTurn",
    "loadTerminalSubmissionRetryLockedAuthority"
  );
  assertOrdered(sidecarFence, [
    "assertTerminalSubmissionRetryTurnOpen",
    "saveTerminalSubmissionRetry("
  ]);
  assertOrdered(replacement, [
    "requireExactEmptyComposerAfterBeforeText",
    "beforeText",
    "assertTerminalSubmissionRetryTurnOpen",
    'saveAttempt("replacement_text_reserved"',
    "beforeEnter",
    "assertTerminalSubmissionRetryTurnOpen",
    'saveAttempt("enter_reserved"',
    "onTransportStage",
    "assertTerminalSubmissionRetryTurnOpen",
    'saveAttempt("replacement_text_injected"',
    'saveAttempt("enter_dispatched"'
  ]);
  assert.match(
    compiledFunctionSource(
      "terminalSubmissionRetryAccepted",
      "terminalSubmissionRetryTerminalOutcome"
    ),
    /terminal_input_sent: input\.terminalInputSent/u
  );
  const terminalOutcome = compiledFunctionSource(
    "terminalSubmissionRetryTerminalOutcome",
    "finalizeDeferredTerminalSubmissionRetryAccepted"
  );
  assert.match(terminalOutcome, /safeToRetry: false/u);
  assert.match(terminalOutcome, /safe_to_retry: false/u);
  assert.match(terminalOutcome, /terminal_input_sent: true/u);
  const exactDraft = compiledFunctionSource(
    "runTerminalSubmissionExactDraftEnter",
    "runTerminalSubmissionReplacement"
  );
  assertOrdered(exactDraft, [
    "const reserveEnter",
    "assertTerminalSubmissionRetryTurnOpen",
    "saveTerminalSubmissionRetryForOpenTurn",
    "submitExactCodexDraft",
    "assertTerminalSubmissionRetryTurnOpen",
    'state: "enter_dispatched"'
  ]);
  assertOrdered(exactDraft, [
    "recoverAcceptedDeferredForegroundDispatch",
    "finalizeDeferredTerminalSubmissionRetryAccepted",
    "pollAcceptance",
    "terminalSubmissionRetryAccepted",
    "terminalInputSent: true",
    "terminalSubmissionRetryTerminalOutcome"
  ]);
  assertOrdered(replacement, [
    "recoverAcceptedDeferredForegroundDispatch",
    "finalizeDeferredTerminalSubmissionRetryAccepted",
    "pollAcceptance",
    "terminalSubmissionRetryAccepted",
    "terminalInputSent: true",
    "terminalSubmissionRetryTerminalOutcome"
  ]);
});

test("callback auto approval rejects a different Turn before migration or terminal I/O", async () => {
  const events: string[] = [];
  const statePath = "/private/store/conversations/turn-b/state.json";
  const conversation = {
    ...createConversation({
      userRequest: "approve B",
      sessionId: "session-b",
      turnId: "turn-b",
      openclawSession: "agent:main:b",
      executorKind: "codex"
    }),
    state_path: statePath
  };
  const implemented = {
    async resolveTerminalConversationFromOptions() {
      events.push("resolve-terminal");
      return undefined;
    },
    loadConversationFromOptions() {
      events.push("load-state");
      return {
        conversation,
        statePath,
        logPath: "/private/store/conversations/turn-b/events.ndjson"
      };
    }
  } satisfies Partial<TerminalCommandPorts>;
  const ports = new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`unexpected terminal command port ${String(property)}`);
    }
  }) as unknown as TerminalCommandPorts;
  const facade = terminalCommandCliAdapter.createTerminalCommandCliFacade({
    ports
  });

  await assert.rejects(
    facade.runApprove({
      autoApproved: true,
      expectedCallbackConversationId: "turn-a",
      expectedCallbackSessionId: "session-a",
      expectedCallbackTurnId: "turn-a",
      expectedCallbackMessageId: "message-a",
      expectedCallbackOpenclawSession: "agent:main:a"
    }),
    /does not match the selected Turn state; no state was changed/u
  );
  assert.deepEqual(events, ["resolve-terminal", "load-state"]);
});

test("callback auto approval rechecks the persisted outbox under the state lock", () => {
  const runApprove = compiledFunctionSource(
    "runApprove",
    "runManagedApprovalDispatch"
  );
  assertOrdered(runApprove, [
    "loadConversationFromOptions(options)",
    "assertAutoApprovalCallbackRoute({",
    "migrateLegacyTerminalAgentIdentity({"
  ]);

  const dispatch = compiledFunctionSource(
    "runManagedApprovalDispatch",
    "assertAutoApprovalCallbackAuthority"
  );
  assertOrdered(dispatch, [
    "loadState(statePath)",
    "assertAutoApprovalCallbackAuthority({",
    "assertManagedTerminalDispatchOwner({",
    "createTerminalAgentBridge(options).approve("
  ]);

  const authority = compiledFunctionSource(
    "assertAutoApprovalCallbackAuthority",
    "autoApprovalCallbackAuthorityFromOptions"
  );
  for (const evidence of [
    "callback_message_id",
    'delivery?.kind !== "approval_notification"',
    "callbackMessage?.conversation_id",
    "callbackMessage?.session_id",
    "callbackMessage?.turn_id",
    "callbackMetadata?.approval_fingerprint",
    "callbackCandidate?.fingerprint",
    "callbackApprovalState?.fingerprint"
  ]) {
    assert.match(authority, new RegExp(evidence.replace(/[?.]/gu, "\\$&"), "u"));
  }
});

test("provenance-bound callback replay remains receipt-only after the Turn closes", async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-replay-"));
  const storeDir = path.join(sandbox, "store");
  const sessionId = "session-approval-replay";
  const turnId = "turn-approval-replay";
  const messageId = "message-approval-replay";
  const openclawSession = "agent:main:approval-replay";
  const fingerprint = "a".repeat(64);
  const resolvedAt = "2026-08-22T03:00:00.000Z";
  const paths = pathsForConversation(turnId, storeDir);
  const terminalControl = {
    kind: "tmux" as const,
    target: "approval-replay:0.0",
    session: "approval-replay",
    window: 0,
    pane: 0,
    panePid: 42,
    capabilities: []
  };
  const callbackMessage = {
    id: messageId,
    conversation_id: turnId,
    session_id: sessionId,
    turn_id: turnId,
    from: "claude",
    to: "openclaw",
    type: "question",
    requires_response: true,
    round: 1,
    ts: "2026-08-22T02:59:00.000Z",
    body: "Approve the current command?",
    metadata: {
      source: "terminal_bridge",
      reason: "approval_required",
      approval_fingerprint: fingerprint,
      approval_candidate: {
        agent: "claude",
        kind: "run_command",
        fingerprint
      },
      terminal_status: {
        approval_state: { approvable: true, fingerprint }
      }
    }
  };
  const conversation = {
    ...createConversation({
      userRequest: "approve once",
      sessionId,
      turnId,
      openclawSession,
      executorKind: "claude",
      executorSession: "claude-approval-replay",
      now: new Date("2026-08-22T02:58:00.000Z")
    }),
    status: "waiting_for_agent" as const,
    gateway_session: openclawSession,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: messageId,
      terminal_bridge_last_approval_message_id: messageId,
      terminal_bridge_last_approval_fingerprint: fingerprint,
      terminal_bridge_approval_resolved_at: resolvedAt
    },
    callback_delivery: {
      kind: "approval_notification",
      status: "failed",
      attempts: 1,
      message: callbackMessage
    },
    updated_at: resolvedAt
  };
  const events: string[] = [];
  try {
    saveState(paths.statePath, conversation);
    const implemented = {
      async resolveTerminalConversationFromOptions() {
        events.push("resolve-terminal");
        return undefined;
      },
      loadConversationFromOptions() {
        events.push("load-state");
        return {
          conversation: loadState(paths.statePath),
          statePath: paths.statePath,
          logPath: paths.logPath
        };
      },
      async migrateLegacyTerminalAgentIdentity(input: {
        conversation: Conversation;
      }) {
        events.push("migrate");
        return input.conversation;
      },
      terminalControlFromTakeover() {
        return terminalControl;
      },
      parseJsonOption(value: unknown) {
        return JSON.parse(String(value));
      },
      acquireTerminalBridgeSendLock() {
        events.push("terminal-lock");
        return () => events.push("terminal-unlock");
      },
      acquireFileLock() {
        events.push("state-lock");
        return () => events.push("state-unlock");
      },
      storeDirFromOptions() {
        return storeDir;
      },
      assertManagedTerminalDispatchOwner() {
        events.push("owner-verified");
      }
    } satisfies Partial<TerminalCommandPorts>;
    const ports = new Proxy(implemented, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        throw new Error(`unexpected terminal command port ${String(property)}`);
      }
    }) as unknown as TerminalCommandPorts;
    const facade = terminalCommandCliAdapter.createTerminalCommandCliFacade({
      ports
    });
    const options = {
      state: paths.statePath,
      storeDir,
      autoApproved: true,
      autoApprovalPolicyJson: JSON.stringify({ enabled: true, rules: [] }),
      expectedApprovalFingerprint: fingerprint,
      expectedCallbackConversationId: turnId,
      expectedCallbackSessionId: sessionId,
      expectedCallbackTurnId: turnId,
      expectedCallbackMessageId: messageId,
      expectedCallbackOpenclawSession: openclawSession
    };
    const execution = await runCliCommandExecution(
      "approve",
      options,
      {},
      () => facade.runApprove(options)
    );
    const result = JSON.parse(execution.stdout);
    assert.equal(result.approved, false);
    assert.equal(result.already_approved, true);
    assert.equal(result.blocked, false);
    assert.equal(result.monitor_pid, undefined);
    assert.deepEqual(events, [
      "resolve-terminal",
      "load-state",
      "migrate",
      "terminal-lock",
      "state-lock",
      "state-unlock",
      "terminal-unlock"
    ]);

    saveState(paths.statePath, {
      ...conversation,
      status: "closed",
      closed_at: "2026-08-22T03:01:00.000Z",
      close_reason: "task completed after approval",
      updated_at: "2026-08-22T03:01:00.000Z"
    });
    events.length = 0;
    const closedExecution = await runCliCommandExecution(
      "approve",
      options,
      {},
      () => facade.runApprove(options)
    );
    const closedResult = JSON.parse(closedExecution.stdout);
    assert.equal(closedResult.already_approved, true);
    assert.equal(closedResult.conversation.status, "closed");
    assert.equal(events.includes("owner-verified"), false);

    saveState(paths.statePath, {
      ...conversation,
      status: "closed",
      closed_at: "2026-08-22T03:01:00.000Z",
      close_reason: "task completed after approval",
      native_session_takeover: {
        ...conversation.native_session_takeover,
        terminal_bridge_last_approval_fingerprint: "b".repeat(64)
      },
      updated_at: "2026-08-22T03:01:00.000Z"
    });
    events.length = 0;
    await assert.rejects(
      runCliCommandExecution(
        "approve",
        options,
        {},
        () => facade.runApprove(options)
      ),
      /no longer matches the locked Turn receipt/u
    );
    assert.equal(events.includes("owner-verified"), false);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test("facade wiring preserves replay validation and presentation priority", () => {
  const activeReplay = compiledFunctionSource(
    "replayExactActiveTerminalSubmission",
    "storedReceiptTerminalBoundaryMismatch"
  );
  assertOrdered(activeReplay, [
    "loadTerminalBridgeDispatchLedger(terminalControl)",
    "terminalLedgerReceiptHistory(loadedLedger)",
    "replayReceiptConflicts(",
    "activeReplayLedgerConflicts({",
    "replayExactStoredTerminalSubmission({",
    "durableReceiptCannotDispatchAgain("
  ]);
  assertOrdered(activeReplay, [
    "readNdjsonLog(logPath)",
    "replayLoggedMessageMismatch(",
    "body: requestText",
    "printJson({",
    "return true"
  ]);

  const storedReplay = compiledFunctionSource(
    "replayExactStoredTerminalSubmission",
    "assertNoUnresolvedTerminalBridgeSubmission"
  );
  assertOrdered(storedReplay, [
    "const allMatches =",
    "const validatedMatches = allMatches.map(",
    "validateStoredTerminalSubmissionMatch({",
    "const matches = validatedMatches.filter("
  ]);
  assertOrdered(storedReplay, [
    "body: requestText",
    "printJson({",
    "return true"
  ]);

  const managedSend = compiledFunctionSource(
    "runManagedSessionSend",
    "runRespond"
  );
  assertOrdered(managedSend, [
    "await withCanonicalMutationLocks(",
    "async (scopes, resources) => {",
    "replayExactActiveTerminalSubmission({"
  ]);
});

test("facade delegates possible-input and approval uncertainty without releasing presentation locks", () => {
  const transportFailure = compiledFunctionSource(
    "presentTerminalDispatchTransportFailure",
    "runTerminalDispatchTransport"
  );
  assertOrdered(transportFailure, [
    "!progress.textInjectedAt",
    "error instanceof TerminalInputNotStartedError",
    "application.recordZeroInputAbort({",
    "return",
    "application.applyUncertain(",
    "do_not_retry: true",
    "presentTerminalUncertain({"
  ]);

  const approval = compiledFunctionSource(
    "runManagedApprovalDispatch",
    "runTerminalConversationApprove"
  );
  assertOrdered(approval, [
    "acquireTerminalBridgeSendLock(",
    "beforeKeyDispatch:",
    "state: \"reserved\"",
    "saveState(statePath, reservedConversation)"
  ]);
  assert.ok(
    approval.lastIndexOf("printJson({") <
      approval.lastIndexOf("releaseApprovalTerminalLock()"),
    "approval presentation must finish before the terminal lock is released"
  );
});

test("terminal dispatch composition exposes a narrow unknown-valued options boundary", () => {
  const source = fs.readFileSync(
    new URL("../../src/terminal-dispatch-composition.ts", import.meta.url),
    "utf8"
  );
  const declaration = fs.readFileSync(
    new URL("../src/terminal-dispatch-composition.d.ts", import.meta.url),
    "utf8"
  );
  const expectedProperties = [
    "agentHardTimeoutMinutes",
    "agentTimeoutMinutes",
    "claudeHome",
    "scrollbackLines",
    "terminalAcceptancePollIntervalMs",
    "terminalAcceptanceTimeoutMs"
  ];
  for (const [label, text] of [["source", source], ["declaration", declaration]]) {
    assert.doesNotMatch(text, /\bany\b|Record<[^>]*\bany\b/u, label);
    const start = text.indexOf("export interface TerminalControlSendOptions");
    const end = text.indexOf("export interface TerminalControlSendRequest", start);
    assert.notEqual(start, -1, `${label} options boundary is present`);
    assert.notEqual(end, -1, `${label} request follows its options boundary`);
    const boundary = text.slice(start, end);
    assert.match(boundary, /extends Record<string, unknown>/u, label);
    assert.deepEqual(
      [...boundary.matchAll(/^\s+(\w+)\?:/gmu)].map((match) => match[1]),
      expectedProperties,
      `${label} options list`
    );
  }
});

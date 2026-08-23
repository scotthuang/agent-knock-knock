import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import {
  loadDeferredForegroundTransfer,
  saveDeferredForegroundTransfer,
  type DeferredForegroundTransfer
} from "../src/deferred-foreground-transfer.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom
} from "../src/managed-session.js";
import {
  canonicalMutationResource,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes
} from "../src/mutation-transaction.js";
import { createConversation, type Conversation } from "../src/protocol.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { loadState, pathsForConversation, saveState } from "../src/store.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { terminalSubmissionRetryPath } from
  "../src/terminal-submission-retry-service.js";

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

interface RetryAbandonmentFixture {
  storeDir: string;
  statePath: string;
  logPath: string;
  control: TerminalControlRef;
  conversation: Conversation;
  transfer: DeferredForegroundTransfer;
}

function createRetryAbandonmentFixture(root: string): RetryAbandonmentFixture {
  const storeDir = path.join(root, "store");
  const turnId = "turn-retry-abandonment";
  const sessionId = "session-retry-abandonment";
  const paths = pathsForConversation(turnId, storeDir);
  const control: TerminalControlRef = {
    kind: "herdr",
    target: "retry-abandonment:pane-1",
    session: "retry-abandonment",
    socketPath: path.join(root, "herdr.sock"),
    sessionDir: root,
    workspaceId: "retry-abandonment",
    tabId: "tab-1",
    paneId: "pane-1",
    terminalId: "terminal-1",
    panePid: 200,
    currentPath: "/workspace/retry-abandonment",
    capabilities: ["screen_status", "send_keys"]
  };
  const terminalId =
    "terminal:v2:herdr:codex:retry-abandonment:pane-1:200";
  const processUuid = "codex-pid:200:birth:retry-abandonment";
  const processBirth = "retry-abandonment";
  const preparedAt = "2026-08-23T01:00:00.000Z";
  const sourceBinding = terminalBindingFrom({
    terminalId,
    terminalControl: control,
    pid: 200,
    nativeThreadId: "00000000-0000-4000-8000-000000000501",
    processUuid,
    processBirth,
    evidence: "codex_status_card+process_birth",
    generation: 1,
    now: new Date(preparedAt)
  });
  const targetBinding = terminalBindingFrom({
    terminalId,
    terminalControl: control,
    pid: 200,
    processUuid,
    processBirth,
    evidence: "codex_process_birth",
    generation: 1,
    now: new Date(preparedAt)
  });
  const requestText = "retry only if management is still active";
  const requestHash = createHash("sha256").update(requestText).digest("hex");
  let transfer = saveDeferredForegroundTransfer(storeDir, {
    schema: "agent-knock-knock/deferred-foreground-transfer",
    version: 1,
    transfer_id: "deferred-transfer-retry-abandonment",
    status: "prepared",
    input_stage: "none",
    terminal_id: terminalId,
    terminal_endpoint: sourceBinding.terminal_endpoint!,
    process_pid: 200,
    process_uuid: processUuid,
    process_birth: processBirth,
    workspace: "/workspace/retry-abandonment",
    source_session_id: "session-retry-source",
    source_expected_revision: 1,
    source_binding_token: managedSessionBindingToken({
      session_id: "session-retry-source",
      status: "bound",
      binding: sourceBinding
    }),
    source_before_binding: sourceBinding,
    target_session_id: sessionId,
    target_expected_revision: null,
    previous_dispatch_status: "none",
    previous_dispatch_fingerprint: createHash("sha256")
      .update("no previous retry dispatch")
      .digest("hex"),
    request_hash: requestHash,
    dispatcher_pid: 999,
    prepared_at: preparedAt
  }, { expectedRevision: null });
  transfer = saveDeferredForegroundTransfer(storeDir, {
    ...transfer,
    status: "source_reserved",
    source_reserved_at: "2026-08-23T01:00:01.000Z"
  }, { expectedRevision: transfer.revision! });
  transfer = saveDeferredForegroundTransfer(storeDir, {
    ...transfer,
    status: "target_prepared",
    target_prepared_at: "2026-08-23T01:00:02.000Z",
    target_prepared_revision: 1,
    target_prepared_status: "transitioning",
    target_prepared_last_transition_id: transfer.transfer_id,
    target_prepared_binding_token: managedSessionBindingToken({
      session_id: sessionId,
      status: "transitioning",
      binding: targetBinding
    }),
    target_before_binding: targetBinding,
    message_id: "message-retry-abandonment",
    turn_id: turnId,
    state_path: paths.statePath
  }, { expectedRevision: transfer.revision! });
  const conversation = {
    ...createConversation({
      userRequest: requestText,
      sessionId,
      turnId,
      executorKind: "codex"
    }),
    status: "stalled" as const,
    workspace: transfer.workspace,
    store_dir: storeDir,
    conversation_dir: paths.conversationDir,
    state_path: paths.statePath,
    event_log_path: paths.logPath,
    native_session_takeover: {
      agent: "codex",
      native_session_id: terminalId,
      terminal_agent_pid: transfer.process_pid,
      terminal_agent_process_uuid: transfer.process_uuid,
      terminal_agent_process_birth: transfer.process_birth,
      source_cwd: transfer.workspace,
      terminal_control: control,
      terminal_endpoint: transfer.terminal_endpoint,
      terminal_bridge: true,
      terminal_bridge_message_id: transfer.message_id,
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash: transfer.request_hash,
      deferred_foreground_transfer_id: transfer.transfer_id
    }
  };
  saveState(paths.statePath, conversation);
  return {
    storeDir,
    statePath: paths.statePath,
    logPath: paths.logPath,
    control,
    conversation,
    transfer
  };
}

function persistRetryManagementAbandonment(
  fixture: RetryAbandonmentFixture,
  final: boolean
): DeferredForegroundTransfer {
  let transfer = loadDeferredForegroundTransfer(
    fixture.storeDir,
    fixture.transfer.transfer_id
  );
  if (transfer.status === "target_prepared") {
    const fingerprint = createHash("sha256")
      .update("exact retry management abandonment")
      .digest("hex");
    transfer = saveDeferredForegroundTransfer(fixture.storeDir, {
      ...transfer,
      status: "user_abandoning",
      user_abandonment_disposition: "user_abandoned_management",
      user_abandonment_origin_status: "target_prepared",
      user_abandonment_origin_revision: transfer.revision,
      user_abandonment_turn_id: transfer.turn_id,
      user_abandonment_turn_fingerprint: fingerprint,
      user_abandonment_requested_at: "2026-08-23T01:00:03.000Z",
      user_abandonment_close_reason: "closed by explicit user request",
      user_abandonment_ledger_disposition: "absent",
      user_abandonment_ledger_fingerprint: fingerprint
    }, { expectedRevision: transfer.revision! });
  }
  if (final && transfer.status === "user_abandoning") {
    const fingerprint = transfer.user_abandonment_turn_fingerprint!;
    transfer = saveDeferredForegroundTransfer(fixture.storeDir, {
      ...transfer,
      status: "user_abandoned",
      user_abandonment_completed_at: "2026-08-23T01:00:04.000Z",
      user_abandonment_source_disposition: "already_released",
      user_abandonment_source_fingerprint: fingerprint,
      user_abandonment_target_disposition: "already_released",
      user_abandonment_target_fingerprint: fingerprint
    }, { expectedRevision: transfer.revision! });
  }
  return transfer;
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

test("send --turn abandonment fence precedes every retry sidecar state and terminal I/O", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-send-retry-abandonment-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createRetryAbandonmentFixture(root);
  const sidecarPath = terminalSubmissionRetryPath(fixture.statePath);
  const events: string[] = [];
  const implemented = {
    required<Value>(value: Value | null | undefined, label: string): Value {
      if (value === undefined || value === null) throw new Error(label);
      return value;
    },
    loadConversationFromOptions() {
      events.push("load-conversation");
      return {
        conversation: loadState(fixture.statePath),
        statePath: fixture.statePath,
        logPath: fixture.logPath
      };
    },
    terminalControlFromTakeover() {
      events.push("stored-control");
      return fixture.control;
    },
    createTerminalAgentBridge() {
      events.push("terminal-bridge");
      throw new Error("abandonment fence must precede terminal resolution");
    },
    terminalWriterMutationLocks() {
      events.push("mutation-locks");
      throw new Error("settled abandonment must precede mutation locks");
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
  const sidecarStates = [
    undefined,
    "replacement_reserved",
    "replacement_text_reserved",
    "enter_reserved",
    "enter_dispatched",
    "agent_accepted"
  ] as const;

  for (const final of [false, true]) {
    persistRetryManagementAbandonment(fixture, final);
    for (const sidecarState of sidecarStates) {
      if (sidecarState === undefined) {
        fs.rmSync(sidecarPath, { force: true });
      } else {
        fs.writeFileSync(
          sidecarPath,
          `${JSON.stringify({ state: sidecarState, sentinel: true })}\n`,
          { mode: 0o600 }
        );
      }
      const before = fs.existsSync(sidecarPath)
        ? fs.readFileSync(sidecarPath, "utf8")
        : undefined;
      events.length = 0;
      await assert.rejects(
        facade.runSend({ turn: "turn-retry-abandonment" }),
        final
          ? /management is released.*settled\/closed.*no terminal input was sent/u
          : /management abandonment cleanup is in progress.*no terminal input was sent/u
      );
      assert.equal(
        fs.existsSync(sidecarPath)
          ? fs.readFileSync(sidecarPath, "utf8")
          : undefined,
        before,
        `${String(sidecarState ?? "absent")} sidecar must remain byte-identical`
      );
      assert.deepEqual(events, ["load-conversation", "stored-control"]);
    }
  }
});

test("send --turn rechecks abandonment intent under canonical locks", async (t) => {
  const root = fs.mkdtempSync(path.join(
    os.tmpdir(),
    "akk-send-retry-abandonment-race-"
  ));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = createRetryAbandonmentFixture(root);
  const sidecarPath = terminalSubmissionRetryPath(fixture.statePath);
  const sentinel = `${JSON.stringify({
    state: "enter_reserved",
    sentinel: "close-won"
  })}\n`;
  fs.writeFileSync(sidecarPath, sentinel, { mode: 0o600 });
  const events: string[] = [];
  const implemented = {
    required<Value>(value: Value | null | undefined, label: string): Value {
      if (value === undefined || value === null) throw new Error(label);
      return value;
    },
    loadConversationFromOptions() {
      events.push("load-conversation");
      return {
        conversation: loadState(fixture.statePath),
        statePath: fixture.statePath,
        logPath: fixture.logPath
      };
    },
    terminalControlFromTakeover() {
      events.push("stored-control");
      return fixture.control;
    },
    terminalWriterMutationLocks() {
      return {
        resources: {
          terminal: canonicalMutationResource(
            "terminal:retry-abandonment",
            fixture.control
          ),
          storeWriter: canonicalMutationResource(
            path.resolve(fixture.storeDir),
            path.resolve(fixture.storeDir)
          )
        },
        acquireTerminal: () => {
          events.push("terminal-lock:close-intent");
          persistRetryManagementAbandonment(fixture, false);
          return () => events.push("terminal-unlock");
        },
        withStoreWriter: async <Result>(
          operation: () => Promise<Result>
        ): Promise<Result> => {
          events.push("writer-lock");
          return operation();
        }
      };
    },
    async withTerminalDispatchStateScope<Result>(
      scopes: CanonicalMutationScopes,
      resources: CanonicalMutationResources,
      _statePath: string,
      _logPath: string,
      operation: (
        scopes: CanonicalStateMutationScopes,
        resources: CanonicalStateMutationResources
      ) => Promise<Result>
    ): Promise<Result> {
      events.push("state-lock");
      return operation(
        scopes as CanonicalStateMutationScopes,
        resources as CanonicalStateMutationResources
      );
    },
    createTerminalAgentBridge() {
      events.push("terminal-bridge");
      throw new Error("locked abandonment fence must precede terminal I/O");
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
    facade.runSend({ turn: "turn-retry-abandonment" }),
    /management abandonment cleanup is in progress.*no terminal input was sent/u
  );
  assert.equal(fs.readFileSync(sidecarPath, "utf8"), sentinel);
  assert.deepEqual(events, [
    "load-conversation",
    "stored-control",
    "terminal-lock:close-intent",
    "writer-lock",
    "state-lock",
    "stored-control",
    "terminal-unlock"
  ]);
});

test("exact Turn retry wires durable authority before composer input", () => {
  const command = compiledFunctionSource(
    "runTerminalSubmissionRetry",
    "runTerminalSubmissionExactDraftEnter"
  );
  assertOrdered(command, [
    "assertTerminalSubmissionRetryNotUserAbandoned",
    "withCanonicalMutationLocks",
    "withTerminalDispatchStateScope",
    "loadState(statePath)",
    "assertTerminalSubmissionRetryNotUserAbandoned",
    "resolveStoredTerminal",
    "terminalControlsShareIncarnation",
    "runTerminalSubmissionRetryLocked"
  ]);
  const authority = compiledFunctionSource(
    "loadTerminalSubmissionRetryLockedAuthority",
    "assertTerminalSubmissionRetryLedgerAuthority"
  );
  assertOrdered(authority, [
    "bindTerminalDispatchRoute",
    "loadState",
    "assertTerminalSubmissionRetryNotUserAbandoned",
    "loadTerminalSubmissionRetry",
    "validateStoredTerminalSubmissionMatch",
    "mutationDispatchLedger.load",
    "exactTerminalSubmissionRetryDeferredTransferId",
    "assertTerminalSubmissionRetryAttemptIdentity",
    "assertTerminalSubmissionRetryGeneration"
  ]);
  const abandonment = compiledFunctionSource(
    "assertTerminalSubmissionRetryNotUserAbandoned",
    "loadTerminalSubmissionRetryLockedAuthority"
  );
  assertOrdered(abandonment, [
    "loadDeferredForegroundTransfer",
    'transfer.status !== "user_abandoning"',
    'transfer.status !== "user_abandoned"',
    "terminalControlEvidenceMatches",
    'transfer.status === "user_abandoning"',
    "settled/closed"
  ]);
  assert.doesNotMatch(
    abandonment,
    /loadTerminalSubmissionRetry|saveTerminalSubmissionRetry|createTerminalAgentBridge|resolveStoredTerminal|observeCodexComposer|sendText|sendEnter/u
  );
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
  assertOrdered(replacement, [
    "requireExactEmptyComposerAfterBeforeText",
    "beforeText",
    'saveAttempt("replacement_text_reserved"',
    "beforeEnter",
    'saveAttempt("enter_reserved"',
    "onTransportStage",
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

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
import { createConversation, type Conversation } from "../src/protocol.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { loadState, pathsForConversation, saveState } from "../src/store.js";

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

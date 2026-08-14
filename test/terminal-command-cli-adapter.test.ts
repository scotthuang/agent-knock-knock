import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import * as terminalCommandCliAdapter from
  "../src/terminal-command-cli-adapter.js";
import type { TerminalCommandCliDependencies } from
  "../src/terminal-command-cli-adapter.js";
import type { ResolvedTerminalConversation } from
  "../src/terminal-agent-bridge.js";

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
    ports,
    policy: { terminalDispatchReleaseStatuses: new Set() }
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

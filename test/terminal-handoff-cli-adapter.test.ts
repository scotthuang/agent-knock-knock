import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import * as terminalHandoffCliAdapter from
  "../src/terminal-handoff-cli-adapter.js";
import type { TerminalHandoffCliDependencies } from
  "../src/terminal-handoff-cli-adapter.js";
import { TerminalHandoffApplicationService } from
  "../src/terminal-handoff-application-service.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import type { Conversation } from "../src/protocol.js";
import type { TerminalRuntimeIdentity } from
  "../src/terminal-agent-adapter.js";
import type { ResolvedTerminalConversation, TerminalAgentBridge,
  TerminalBridgeStatus } from "../src/terminal-agent-bridge.js";

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

function unavailableGroup(label: string): unknown {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`unexpected ${label} capability ${String(property)}`);
    }
  });
}

function resolvedTerminal(marker: "A" | "B"): ResolvedTerminalConversation {
  return {
    conversationId: `terminal:tmux:${marker.toLowerCase()}:0.0:42`,
    agent: "claude",
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
      currentPath: "/workspace/project",
      capabilities: []
    }
  } as unknown as ResolvedTerminalConversation;
}

function facadeDependencies(
  marker: "A" | "B",
  events: string[],
  gate: DeferredGate
): TerminalHandoffCliDependencies {
  const status = {
    reachable: true,
    activity_state: "idle",
    activity_reason: "direct-test",
    approval_state: { blocked: false },
    screen: { excerpt: "" }
  } as unknown as TerminalBridgeStatus;
  const runtime = {
    createBridge() {
      events.push(`${marker}:bridge`);
      return {
        async status() {
          events.push(`${marker}:status:before`);
          await gate.promise;
          events.push(`${marker}:status:after`);
          return status;
        }
      } as unknown as TerminalAgentBridge;
    },
  } satisfies Partial<TerminalHandoffCliDependencies["runtime"]>;
  const identity = {
    terminalRuntimeForLiveIdentity() {
      events.push(`${marker}:runtime-identity`);
      return {} as TerminalRuntimeIdentity;
    }
  } satisfies Partial<TerminalHandoffCliDependencies["identity"]>;
  const authority = {
    assertSafeSend() {
      events.push(`${marker}:safe-send`);
    }
  } satisfies Partial<TerminalHandoffCliDependencies["authority"]>;
  return {
    runtime: new Proxy(runtime, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(`unexpected ${marker} runtime ${String(property)}`);
      }
    }) as unknown as TerminalHandoffCliDependencies["runtime"],
    identity: new Proxy(identity, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(`unexpected ${marker} identity ${String(property)}`);
      }
    }) as unknown as TerminalHandoffCliDependencies["identity"],
    acceptance: unavailableGroup(`${marker} acceptance`) as
      TerminalHandoffCliDependencies["acceptance"],
    authority: new Proxy(authority, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(`unexpected ${marker} authority ${String(property)}`);
      }
    }) as unknown as TerminalHandoffCliDependencies["authority"],
    repository: unavailableGroup(`${marker} repository`) as
      TerminalHandoffCliDependencies["repository"]
  };
}

function compiledSource(): string {
  return fs.readFileSync(
    new URL("../src/terminal-handoff-cli-adapter.js", import.meta.url),
    "utf8"
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

test("handoff facade exposes one factory and isolates async capability recordings", async (t) => {
  assert.deepEqual(Object.keys(terminalHandoffCliAdapter), [
    "createTerminalHandoffCliFacade"
  ]);
  const events: string[] = [];
  const gateA = deferredGate();
  const gateB = deferredGate();
  t.after(() => {
    gateA.release();
    gateB.release();
  });
  const facadeA = terminalHandoffCliAdapter.createTerminalHandoffCliFacade(
    facadeDependencies("A", events, gateA)
  );
  const facadeB = terminalHandoffCliAdapter.createTerminalHandoffCliFacade(
    facadeDependencies("B", events, gateB)
  );
  const identityA = { sessionId: "thread-a", evidence: "direct-test" };
  const identityB = { sessionId: "thread-b", evidence: "direct-test" };

  const observeA = facadeA.observedExternalHandoffIdentity({
    options: {}, terminal: resolvedTerminal("A"),
    sourceSession: {} as ManagedSessionState, resolvedIdentity: identityA
  });
  const observeB = facadeB.observedExternalHandoffIdentity({
    options: {}, terminal: resolvedTerminal("B"),
    sourceSession: {} as ManagedSessionState, resolvedIdentity: identityB
  });
  assert.deepEqual(events, [
    "A:bridge", "A:runtime-identity", "A:status:before",
    "B:bridge", "B:runtime-identity", "B:status:before"
  ]);
  gateB.release();
  assert.equal((await observeB).identity, identityB);
  gateA.release();
  assert.equal((await observeA).identity, identityA);
  assert.deepEqual(events.slice(-4), [
    "B:status:after", "B:safe-send", "A:status:after", "A:safe-send"
  ]);

  const sharedOptions = { expectedTerminalToken: "fresh-token" };
  const terminalA = resolvedTerminal("A");
  const terminalB = resolvedTerminal("B");
  facadeA.rememberOriginalExpectedTerminalSelector(
    sharedOptions,
    terminalA.conversationId
  );
  facadeB.rememberOriginalExpectedTerminalSelector(
    sharedOptions,
    terminalB.conversationId
  );
  assert.doesNotThrow(() =>
    facadeA.assertExpectedHandoffTokenUsesExactTerminalSelector({
      options: sharedOptions,
      terminal: terminalA
    })
  );
  assert.doesNotThrow(() =>
    facadeB.assertExpectedHandoffTokenUsesExactTerminalSelector({
      options: sharedOptions,
      terminal: terminalB
    })
  );
});

test("safe retry keeps getter and thrown-error priority before repository access", () => {
  const events: string[] = [];
  const gate = deferredGate();
  gate.release();
  const facade = terminalHandoffCliAdapter.createTerminalHandoffCliFacade(
    facadeDependencies("A", events, gate)
  );
  const skippedSafeGetter = Object.defineProperties({}, {
    status: { get: () => (events.push("receipt:status"), "pending") },
    safe_to_retry: { get: () => {
      events.push("receipt:safe");
      throw new Error("must stay lazy");
    } }
  });
  assert.equal(facade.assertSafeAbortedTerminalRetryBinding({
    owner: {} as Conversation,
    receipt: skippedSafeGetter,
    storeDir: "/unread",
    terminalControl: {} as never,
    messageId: "message-1"
  }), undefined);
  assert.deepEqual(events, ["receipt:status"]);

  const exactError = new Error("safe getter wins");
  const failingSafeGetter = Object.defineProperties({}, {
    status: { get: () => (events.push("receipt:status:aborted"), "aborted") },
    safe_to_retry: { get: () => {
      events.push("receipt:safe:error");
      throw exactError;
    } }
  });
  assert.throws(() => facade.assertSafeAbortedTerminalRetryBinding({
    owner: {} as Conversation,
    receipt: failingSafeGetter,
    storeDir: "/unread",
    terminalControl: {} as never,
    messageId: "message-1"
  }), (error) => error === exactError);
  assert.deepEqual(events.slice(-2), [
    "receipt:status:aborted",
    "receipt:safe:error"
  ]);
});

test("neutral handoff facts preserve exact zero-input and thunk error semantics", () => {
  const application = new TerminalHandoffApplicationService();
  assert.deepEqual(application.zeroInputChronology({ inputStage: "none" }), {
    safe: true,
    dispatchIntentProvedNotStarted: false
  });
  assert.deepEqual(application.zeroInputChronology({
    inputStage: "dispatch_started",
    dispatchStartedAt: "2026-08-15T00:00:00.000Z",
    inputNotStartedAt: "2026-08-15T00:00:01.000Z",
    dispatchStartedAtMs: 1,
    inputNotStartedAtMs: 2
  }), { safe: true, dispatchIntentProvedNotStarted: true });
  assert.equal(application.zeroInputChronology({
    inputStage: "text_injected",
    dispatchStartedAt: "2026-08-15T00:00:00.000Z",
    dispatchStartedAtMs: 1
  }).safe, false);

  const trace: string[] = [];
  assert.equal(application.authorityChecksPass([
    () => (trace.push("first"), false),
    () => {
      trace.push("forbidden");
      throw new Error("must not run");
    }
  ]), false);
  assert.deepEqual(trace, ["first"]);
  const exactError = new Error("original authority error");
  assert.throws(() => application.authorityChecksPass([
    () => true,
    () => { throw exactError; }
  ]), (error) => error === exactError);
});

test("compiled byte witness preserves retry route, receipt, chronology, and hash order", () => {
  const retry = compiledFunctionSource(
    "safeAbortedDeferredRetrySourceSession",
    "exactSafeAbortedRecoveredSessionMatches"
  );
  assertOrdered(retry, [
    "loadDeferredForegroundTransfer(storeDir, transferId)",
    "terminalBridgeSubmission(owner)",
    "terminalBridgeSubmissionReceipts(owner)",
    "pathsForConversation(owner.conversation_id, storeDir)",
    "zeroInputChronology({",
    "terminalControlsShareIncarnation(ownerControl, terminalControl)",
    "terminalControlEvidenceMatches(",
    "terminal_bridge_request_hash",
    "transfer.request_hash",
    "canonicalJson(matchingReceipts[0]) === canonicalJson(submission)",
    "canonicalJson(submission) === canonicalJson(receipt)",
    "loadTerminalBridgeDispatchLedger(terminalControl)",
    "assertDeferredForegroundResolvedZeroInputLedger("
  ]);
});

test("handoff writes and recovery capabilities retain monotonic lock order", () => {
  const adoption = compiledFunctionSource(
    "maybeAdoptObservedExternalThread",
    "assertObservedHandoffTransportBoundary"
  );
  assertOrdered(adoption, [
    "status: \"prepared\"",
    "saveNativeThreadTransition(storeDir, transition",
    "phase: \"prepared\"",
    "status: \"transitioning\"",
    "observedExternalHandoffIdentity({",
    "status: \"verified\"",
    "phase: \"verified\"",
    "commitVerifiedLifecycleTransition(",
    "status: \"committed\"",
    "phase: \"resolved_with_binding\""
  ]);
  assertOrdered(adoption.slice(adoption.indexOf("catch (error)")), [
    "loadNativeThreadTransition(storeDir, transitionId)",
    "durable.status === \"verified\"",
    "throw error",
    "status: \"uncertain\""
  ]);

  const beforeMutation = compiledFunctionSource(
    "recoverDeferredCodexForegroundTransferBeforeMutation",
    "withDeferredForegroundRecoveryScope"
  );
  assertOrdered(beforeMutation, [
    "terminalWriterMutationLocks(",
    "withCanonicalMutationLocks({",
    "acquireTerminal:",
    "recoverDeferredCodexForegroundTransferWhileWriterLease({"
  ]);
  const recoveryScope = compiledFunctionSource(
    "withDeferredForegroundRecoveryScope",
    "matchingDeferredForegroundTransfers"
  );
  assertOrdered(recoveryScope, [
    "if (!transfer.state_path)",
    "bindDeferredForegroundWriterScope(scopes, resources)",
    "path.resolve(transfer.state_path)",
    "withTerminalDispatchStateScope(",
    "bindDeferredForegroundApplicationScope(stateScopes, stateResources)"
  ]);
});

test("service declarations stay neutral and composition directly uses identity authority", () => {
  for (const file of [
    "terminal-handoff-application-service.js",
    "terminal-handoff-facts.js"
  ]) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source,
      /node:fs|node:path|\.\/store\.js|\.\/session-store\.js|Record<[^>]*any/u);
  }
  const declaration = fs.readFileSync(
    new URL("../src/terminal-handoff-application-service.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(declaration,
    /node:fs|node:path|Record<[^>]*any|ManagedSession|ResolvedTerminal/u);
  const core = fs.readFileSync(new URL("../src/cli-core.js", import.meta.url), "utf8");
  const start = core.indexOf("const terminalHandoffCliFacade =");
  const end = core.indexOf("const {", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const composition = core.slice(start, end);
  assert.match(composition, /identity:\s*terminalIdentityAuthority/u);
  assert.doesNotMatch(composition,
    /processIncarnation:|exactLifecycleIdentity:|bindingConflict:/u);
  const adapterDeclaration = fs.readFileSync(
    new URL("../src/terminal-handoff-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(adapterDeclaration, /TerminalHandoffIdentityPorts/u);
});

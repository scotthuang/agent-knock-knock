import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  bindDeferredForegroundApplicationScope,
  bindDeferredForegroundWriterScope
} from "../src/deferred-foreground-capability.js";
import * as capabilityExports from
  "../src/deferred-foreground-capability.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary
} from
  "../src/deferred-foreground-boundary.js";
import type { DeferredForegroundTransfer } from
  "../src/deferred-foreground-transfer.js";
import type { ManagedSessionState } from "../src/managed-session.js";
import {
  canonicalMutationResource,
  withCanonicalMutationLocks
} from "../src/mutation-transaction.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { terminalControlEvidence, terminalRuntimeResourceKey } from
  "../src/terminal-control-ref.js";

const CONTROL: TerminalControlRef = {
  kind: "tmux",
  target: "%7",
  socketPath: "/tmp/tmux.sock",
  session: "akk",
  window: 1,
  pane: 2,
  panePid: 5102,
  currentPath: "/workspace",
  capabilities: ["screen_status", "send_keys"]
};

function boundary(
  terminalControl: TerminalControlRef = CONTROL
): DeferredForegroundBindingBoundary {
  return {
    terminal: {
      conversationId: "terminal-1",
      agent: "codex",
      pid: 5102,
      workspace: "/workspace",
      target: terminalControl.target,
      resourceKey: terminalRuntimeResourceKey(terminalControl),
      endpoint: terminalControlEvidence(terminalControl),
      canonicalEndpoint: true
    },
    transferId: "transfer-1",
    targetSessionId: "target-1",
    sourceSessionId: "source-1",
    sourceBoundRevision: 1,
    sourceBoundBindingToken: "a".repeat(64),
    processUuid: "process-1",
    processBirth: "birth-1",
    previousDispatchSnapshot: {
      status: "none",
      fingerprint: "b".repeat(64)
    },
    sourceKind: "status_card_only",
    sourceRolloutAuthority: "present"
  };
}

function transfer(statePath?: string): DeferredForegroundTransfer {
  return { state_path: statePath } as DeferredForegroundTransfer;
}

test("writer capability binds one terminal and Store and expires after callback", async () => {
  const trace: string[] = [];
  const storeDir = `/tmp/akk-capability-${randomUUID()}`;
  const resources = {
    terminal: canonicalMutationResource(
      terminalRuntimeResourceKey(CONTROL),
      CONTROL
    ),
    storeWriter: canonicalMutationResource(storeDir, storeDir)
  };
  let leaked: DeferredForegroundApplicationScope | undefined;
  await withCanonicalMutationLocks({
    resources,
    acquireTerminal: () => {
      trace.push("acquire:terminal");
      return () => trace.push("release:terminal");
    },
    withStoreWriter: async <Result>(operation: () => Promise<Result>) => {
      trace.push("acquire:writer");
      try {
        return await operation();
      } finally {
        trace.push("release:writer");
      }
    }
  }, async (scopes, bound) => {
    leaked = bindDeferredForegroundWriterScope(scopes, bound);
    assert.deepEqual(leaked.listTransfers(), []);
    leaked.assertBoundary(boundary());
  });
  assert.deepEqual(trace, [
    "acquire:terminal",
    "acquire:writer",
    "release:writer",
    "release:terminal"
  ]);
  assert.ok(leaked);
  const expired = leaked;
  const expiredCalls: Array<() => unknown> = [
    () => expired.loadTransfer("transfer-1"),
    () => expired.listTransfers(),
    () => expired.saveTransfer(transfer(), null),
    () => expired.loadSession("session-1"),
    () => expired.tryLoadSession("session-1"),
    () => expired.saveSession({} as ManagedSessionState, null),
    () => expired.assertBoundary(boundary()),
    () => expired.transferBelongsToTurn(transfer()),
    () => expired.terminalMatches(transfer(), boundary()),
    () => expired.withTurnStatePath(transfer()),
    () => expired.sameInvocation(expired)
  ];
  for (const call of expiredCalls) {
    assert.throws(call, /requires active authentic terminal scope/u);
  }
});

test("application scope implementation has no public construction path", () => {
  assert.equal("DeferredForegroundApplicationScope" in capabilityExports, false);
  if (false) {
    // @ts-expect-error the concrete scope implementation is module-private
    new capabilityExports.DeferredForegroundApplicationScope({});
  }
});

test("state capability accepts only its canonical Turn route", async () => {
  const storeDir = `/tmp/akk-capability-${randomUUID()}`;
  const statePath = `${storeDir}/conversations/turn-1/state.json`;
  const logPath = `${storeDir}/conversations/turn-1/events.ndjson`;
  const resources = {
    terminal: canonicalMutationResource(
      terminalRuntimeResourceKey(CONTROL),
      CONTROL
    ),
    storeWriter: canonicalMutationResource(storeDir, storeDir),
    state: canonicalMutationResource(statePath, { statePath, logPath })
  };
  await withCanonicalMutationLocks({
    resources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
      operation(),
    acquireState: () => () => undefined
  }, async (scopes, bound) => {
    const capability = bindDeferredForegroundApplicationScope(scopes, bound);
    assert.equal(capability.transferBelongsToTurn(transfer()), true);
    assert.equal(
      capability.transferBelongsToTurn(transfer(statePath)),
      true
    );
    assert.equal(
      capability.transferBelongsToTurn(
        transfer(`${storeDir}/conversations/turn-2/state.json`)
      ),
      false
    );
    assert.equal(capability.withTurnStatePath(transfer()).state_path, statePath);
  });
});

test("capability rejects a changed terminal incarnation before repository I/O", async () => {
  const storeDir = `/tmp/akk-capability-${randomUUID()}`;
  const resources = {
    terminal: canonicalMutationResource(
      terminalRuntimeResourceKey(CONTROL),
      CONTROL
    ),
    storeWriter: canonicalMutationResource(storeDir, storeDir)
  };
  await withCanonicalMutationLocks({
    resources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
      operation()
  }, async (scopes, bound) => {
    const capability = bindDeferredForegroundWriterScope(scopes, bound);
    assert.throws(
      () => capability.assertBoundary(boundary({
        ...CONTROL,
        panePid: 9999
      })),
      /escaped its exact terminal capability/u
    );
  });
});

test("invalid terminal, Store, state, log, and resource keys fail before I/O", async () => {
  const storeDir = "/canonical/store-a";
  const statePath = `${storeDir}/conversations/turn-1/state.json`;
  const logPath = `${storeDir}/conversations/turn-1/events.ndjson`;
  const fixtures = [
    {
      name: "null terminal",
      control: null,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "object terminal",
      control: {},
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "terminal key",
      control: CONTROL,
      terminalKey: "terminal:wrong",
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "terminal process",
      control: { ...CONTROL, panePid: 1 },
      terminalKey: "terminal:invalid-process",
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "Store key",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: "/canonical/store-b",
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "null Store",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: null,
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "object Store",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: { storeDir },
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "relative Store",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: "relative/store-a",
      storeValue: "relative/store-a",
      stateKey: statePath,
      state: { statePath, logPath },
      error: /terminal\/writer capability is not canonical/u
    },
    {
      name: "null state",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: null,
      error: /state capability is invalid/u
    },
    {
      name: "object state",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: {},
      error: /state capability is invalid/u
    },
    {
      name: "relative state",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: "relative/conversations/turn-1/state.json",
      state: {
        statePath: "relative/conversations/turn-1/state.json",
        logPath: "relative/conversations/turn-1/events.ndjson"
      },
      error: /state does not belong to the active Store/u
    },
    {
      name: "cross-Store state",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: "/canonical/store-b/conversations/turn-1/state.json",
      state: {
        statePath: "/canonical/store-b/conversations/turn-1/state.json",
        logPath: "/canonical/store-b/conversations/turn-1/events.ndjson"
      },
      error: /state does not belong to the active Store/u
    },
    {
      name: "event log",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: {
        statePath,
        logPath: `${storeDir}/conversations/turn-2/events.ndjson`
      },
      error: /event log does not match its Turn state/u
    },
    {
      name: "null event log",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath: null },
      error: /state capability is invalid/u
    },
    {
      name: "object event log",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath: {} },
      error: /state capability is invalid/u
    },
    {
      name: "relative event log",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: statePath,
      state: { statePath, logPath: "relative/events.ndjson" },
      error: /event log does not match its Turn state/u
    },
    {
      name: "state key",
      control: CONTROL,
      terminalKey: terminalRuntimeResourceKey(CONTROL),
      storeKey: storeDir,
      storeValue: storeDir,
      stateKey: `${statePath}.wrong`,
      state: { statePath, logPath },
      error: /state resource key and value do not match/u
    }
  ];
  for (const fixture of fixtures) {
    let repositoryIo = 0;
    const state = fixture.state;
    const resources = {
      terminal: canonicalMutationResource(fixture.terminalKey, fixture.control),
      storeWriter: canonicalMutationResource(
        fixture.storeKey,
        fixture.storeValue
      ),
      state: canonicalMutationResource(fixture.stateKey, state)
    };
    await assert.rejects(withCanonicalMutationLocks({
      resources,
      acquireTerminal: () => () => undefined,
      withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
        operation(),
      acquireState: () => () => undefined
    }, async (scopes, bound) => {
      const capability = bindDeferredForegroundApplicationScope(scopes, bound);
      repositoryIo += 1;
      capability.listTransfers();
    }), fixture.error, fixture.name);
    assert.equal(repositoryIo, 0, fixture.name);
  }
});

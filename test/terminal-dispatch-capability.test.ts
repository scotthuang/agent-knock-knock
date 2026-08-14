import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalMutationResource,
  capabilityGatedRepositoryOperation,
  withCanonicalMutationLocks,
  withCanonicalStateMutationLock,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes
} from "../src/mutation-transaction.js";
import type { Conversation } from "../src/protocol.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import { terminalRuntimeResourceKey } from
  "../src/terminal-control-ref.js";
import {
  bindTerminalDispatchCapabilities,
  bindTerminalDispatchRoute,
  terminalDispatchStateLockPath,
  terminalDispatchStateMutationResource,
  terminalDispatchStateResourceForStore,
  withExactTerminalDispatchRoute,
  type TerminalDispatchCapabilityRepositories
} from "../src/terminal-dispatch-capability.js";
import type { TerminalDispatchAuditEvent } from
  "../src/terminal-dispatch-application.js";
import type { TerminalDispatchLedgerDocument } from
  "../src/terminal-dispatch-ledger-codec.js";

const terminal: TerminalControlRef = {
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
const terminalKey = terminalRuntimeResourceKey(terminal);
const resources = {
  terminal: canonicalMutationResource(terminalKey, terminal),
  storeWriter: canonicalMutationResource("/store-a", "/store-a"),
  state: canonicalMutationResource("/store-a/conversations/turn-a/state.json", {
    statePath: "/store-a/conversations/turn-a/state.json",
    logPath: "/store-a/conversations/turn-a/events.ndjson"
  })
};
const otherResources = {
  ...resources,
  state: canonicalMutationResource("/store-b/conversations/turn-a/state.json", {
    statePath: "/store-b/conversations/turn-a/state.json",
    logPath: "/store-b/conversations/turn-a/events.ndjson"
  })
};

function lockPorts(events: string[]) {
  return {
    resources,
    acquireTerminal: () => {
      events.push("acquire terminal");
      return () => events.push("release terminal");
    },
    withStoreWriter: async <Result>(operation: () => Promise<Result>) => {
      events.push("acquire writer");
      try {
        return await operation();
      } finally {
        events.push("release writer");
      }
    },
    acquireState: () => {
      events.push("acquire state");
      return () => events.push("release state");
    }
  };
}

function repositories(events: string[]): TerminalDispatchCapabilityRepositories {
  return {
    state: {
      save: capabilityGatedRepositoryOperation(
        ["storeWriter", "state"] as const,
        "state",
        (resource: { statePath: string }, _conversation: Conversation) => {
          events.push(`state ${resource.statePath}`);
        }
      )
    },
    ledger: {
      save: capabilityGatedRepositoryOperation(
        ["terminal", "storeWriter"] as const,
        "terminal",
        (control: TerminalControlRef, _ledger: TerminalDispatchLedgerDocument) => {
          events.push(`ledger ${control.target}`);
        }
      ),
      restore: capabilityGatedRepositoryOperation(
        ["terminal", "storeWriter", "state"] as const,
        "terminal",
        (control: TerminalControlRef) => {
          events.push(`restore ${control.target}`);
        }
      )
    },
    audit: {
      append: capabilityGatedRepositoryOperation(
        ["storeWriter", "state"] as const,
        "state",
        (resource: { logPath: string }, _event: TerminalDispatchAuditEvent) => {
          events.push(`event ${resource.logPath}`);
        }
      ),
      appendPreparedMessage: capabilityGatedRepositoryOperation(
        ["storeWriter", "state"] as const,
        "state",
        (resource: { logPath: string }) => {
          events.push(`prepared ${resource.logPath}`);
        }
      )
    },
    rollbackBeforeInput: capabilityGatedRepositoryOperation(
      ["terminal", "storeWriter", "state"] as const,
      "storeWriter",
      (storeDir: string) => {
        events.push(`rollback ${storeDir}`);
        return true;
      }
    )
  };
}

const local = {
  synchronizeStageProgress: () => undefined,
  audit: {
    log: () => undefined,
    recordBookkeepingFailure: () => undefined,
    recordPersistenceFailure: () => undefined
  }
};

test("dispatch ports bind exact resources and expire with their transaction", async () => {
  const events: string[] = [];
  let leaked: ReturnType<typeof bindTerminalDispatchCapabilities> | undefined;
  await withCanonicalMutationLocks(lockPorts(events), async (scopes, bound) => {
    leaked = bindTerminalDispatchCapabilities({
      scopes,
      resources: bound,
      repositories: repositories(events),
      local
    });
    leaked.applicationPorts.state.save({} as Conversation);
    leaked.applicationPorts.ledger.save({ status: "prepared" });
    leaked.applicationPorts.audit.append({
      ts: "2026-08-15T00:00:00.000Z",
      conversation_id: "turn-a",
      event: "prepared"
    });
    leaked.applicationPorts.audit.appendPreparedMessage();
    assert.equal(leaked.applicationPorts.rollbackBeforeInput(), true);
  });
  assert.throws(
    () => leaked?.applicationPorts.state.save({} as Conversation),
    /requires active authentic storeWriter scope/u
  );
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "state /store-a/conversations/turn-a/state.json",
    "ledger %7",
    "event /store-a/conversations/turn-a/events.ndjson",
    "prepared /store-a/conversations/turn-a/events.ndjson",
    "rollback /store-a",
    "release state",
    "release writer",
    "release terminal"
  ]);
});

test("dispatch state resources reject a different Store or event route", async () => {
  const outerResources = {
    terminal: resources.terminal,
    storeWriter: resources.storeWriter
  };
  await withCanonicalMutationLocks({
    resources: outerResources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
      operation()
  }, async (scopes, bound) => {
    let stateLockAcquires = 0;
    const deriveThenAcquire = (statePath: string, logPath: string) => {
      const resource = terminalDispatchStateMutationResource(
        scopes, bound, statePath, logPath
      );
      stateLockAcquires += 1;
      return resource;
    };
    assert.throws(
      () => deriveThenAcquire(
        "/store-b/conversations/turn-a/state.json",
        "/store-b/conversations/turn-a/events.ndjson"
      ),
      /state does not belong to the active Store/u
    );
    assert.throws(
      () => deriveThenAcquire(
        "/store-a/conversations/turn-a/state.json",
        "/store-a/conversations/turn-b/events.ndjson"
      ),
      /event log does not match its conversation state/u
    );
    assert.equal(stateLockAcquires, 0);
    const exact = deriveThenAcquire(
      "/store-a/conversations/turn-a/state.json",
      "/store-a/conversations/turn-a/events.ndjson"
    );
    assert.equal(exact.key, "/store-a/conversations/turn-a/state.json");
    assert.equal(stateLockAcquires, 1);
  });
});

test("static dispatch state resources reject wrong routes before lock acquire", () => {
  for (const fixture of [
    {
      statePath: "/store-b/conversations/turn-a/state.json",
      logPath: "/store-b/conversations/turn-a/events.ndjson",
      error: /state does not belong to the active Store/u
    },
    {
      statePath: "/store-a/conversations/turn-a/state.json",
      logPath: "/store-a/conversations/turn-b/events.ndjson",
      error: /event log does not match its conversation state/u
    }
  ]) {
    let acquired = false;
    assert.throws(() => {
      const resource = terminalDispatchStateResourceForStore(
        "/store-a", fixture.statePath, fixture.logPath
      );
      acquired = true;
      return resource;
    }, fixture.error);
    assert.equal(acquired, false);
  }
});

test("dispatch binding rejects wrong resources and mixed transactions", async () => {
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];
  await withCanonicalMutationLocks(
    lockPorts(firstEvents),
    async (outer, bound) => {
      assert.throws(
        () => bindTerminalDispatchCapabilities({
          scopes: outer,
          resources: otherResources as CanonicalStateMutationResources,
          repositories: repositories(firstEvents),
          local
        }),
        /requires active authentic state scope/u
      );
      await withCanonicalMutationLocks(
        lockPorts(secondEvents),
        async (inner) => {
          assert.throws(
            () => bindTerminalDispatchCapabilities({
              scopes: {
                terminal: outer.terminal,
                storeWriter: inner.storeWriter,
                state: inner.state
              } as CanonicalStateMutationScopes,
              resources: bound,
              repositories: repositories(firstEvents),
              local
            }),
            /scopes belong to different transactions/u
          );
        }
      );
    }
  );
});

test("authentic cross-Store state scope is rejected before repository I/O", async () => {
  const events: string[] = [];
  const outerResources = {
    terminal: resources.terminal,
    storeWriter: resources.storeWriter
  };
  await withCanonicalMutationLocks({
    resources: outerResources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
      operation()
  }, async (outerScopes, boundOuter) => {
    await withCanonicalStateMutationLock(
      outerScopes,
      boundOuter,
      {
        resource: otherResources.state,
        acquire: () => () => undefined
      },
      async (stateScopes, crossStoreResources) => {
        assert.throws(
          () => bindTerminalDispatchCapabilities({
            scopes: stateScopes,
            resources: crossStoreResources,
            repositories: repositories(events),
            local
          }),
          /state does not belong to the active Store/u
        );
      }
    );
  });
  assert.deepEqual(events, []);
});

test("dispatch binder rejects authentic forged resource key/value pairs", async () => {
  const fixtures = [
    {
      name: "terminal-key",
      resources: {
        ...resources,
        terminal: canonicalMutationResource(
          terminalRuntimeResourceKey({ ...terminal, target: "%8" }),
          terminal
        )
      },
      error: /terminal resource is invalid/u
    },
    {
      name: "writer",
      resources: {
        ...resources,
        storeWriter: canonicalMutationResource("/store-a", "/store-b")
      },
      error: /Store resource key and value do not match/u
    },
    {
      name: "state-key",
      resources: {
        ...resources,
        state: canonicalMutationResource(
          "/store-a/conversations/turn-b/state.json",
          resources.state.value
        )
      },
      error: /state resource key and value do not match/u
    },
    {
      name: "state-value",
      resources: {
        ...resources,
        state: canonicalMutationResource(resources.state.key, {
          statePath: "/store-b/conversations/turn-a/state.json",
          logPath: "/store-b/conversations/turn-a/events.ndjson"
        })
      },
      error: /state does not belong to the active Store/u
    }
  ] as const;
  for (const fixture of fixtures) {
    const events: string[] = [];
    await withCanonicalMutationLocks({
      resources: fixture.resources,
      acquireTerminal: () => () => undefined,
      withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
        operation(),
      acquireState: () => () => undefined
    }, async (scopes, bound) => {
      assert.throws(() => bindTerminalDispatchCapabilities({
        scopes,
        resources: bound,
        repositories: repositories(events),
        local
      }), fixture.error, fixture.name);
    });
    assert.deepEqual(events, [], fixture.name);
  }
});

test("dispatch binder rejects malformed authentic terminal values before I/O", async () => {
  for (const terminalValue of [null, "terminal-a"] as const) {
    const malformedResources = {
      ...resources,
      terminal: canonicalMutationResource(
        "terminal-a",
        terminalValue as unknown as TerminalControlRef
      )
    };
    const events: string[] = [];
    await withCanonicalMutationLocks({
      resources: malformedResources,
      acquireTerminal: () => () => undefined,
      withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
        operation(),
      acquireState: () => () => undefined
    }, async (scopes, bound) => {
      assert.throws(() => bindTerminalDispatchCapabilities({
        scopes,
        resources: bound,
        repositories: repositories(events),
        local
      }), /terminal resource is invalid/u);
    });
    assert.deepEqual(events, []);
  }
});

test("raw attach and post-input routes reject wrong Store or process before I/O", async () => {
  await withCanonicalMutationLocks(lockPorts([]), async (scopes, bound) => {
    const route = bindTerminalDispatchRoute(scopes, bound);
    const equivalentTerminal = { ...terminal };
    assert.equal(withExactTerminalDispatchRoute(route, {
      terminalControl: equivalentTerminal,
      terminalKey,
      storeDir: "/store-a",
      statePath: "/store-a/conversations/turn-a/state.json",
      logPath: "/store-a/conversations/turn-a/events.ndjson"
    }, () => "I/O"), "I/O");
    for (const fixture of [
      {
        name: "wrong-conversation-store",
        terminalControl: terminal,
        terminalKey,
        storeDir: "/store-b",
        statePath: "/store-b/conversations/turn-a/state.json",
        logPath: "/store-b/conversations/turn-a/events.ndjson"
      },
      {
        name: "wrong-deferred-store",
        terminalControl: equivalentTerminal,
        terminalKey,
        storeDir: "/store-b",
        statePath: "/store-b/conversations/turn-b/state.json",
        logPath: "/store-b/conversations/turn-b/events.ndjson"
      },
      {
        name: "wrong-deferred-process",
        terminalControl: { ...terminal, panePid: terminal.panePid + 1 },
        terminalKey,
        storeDir: "/store-a",
        statePath: "/store-a/conversations/turn-a/state.json",
        logPath: "/store-a/conversations/turn-a/events.ndjson"
      },
      {
        name: "wrong-terminal-key",
        terminalControl: equivalentTerminal,
        terminalKey: terminalRuntimeResourceKey({ ...terminal, target: "%8" }),
        storeDir: "/store-a",
        statePath: "/store-a/conversations/turn-a/state.json",
        logPath: "/store-a/conversations/turn-a/events.ndjson"
      }
    ] as const) {
      let ioStarted = false;
      assert.throws(() => {
        withExactTerminalDispatchRoute(route, fixture, () => {
          ioStarted = true;
        });
      }, /escaped its exact mutation route/u, fixture.name);
      assert.equal(ioStarted, false, fixture.name);
    }
  });
});

test("canonical state resource freezes the static lock target", () => {
  const resource = terminalDispatchStateResourceForStore(
    "/store-a",
    "/store-a/conversations/turn-a/../turn-a/state.json",
    "/store-a/conversations/turn-a/../turn-a/events.ndjson"
  );
  assert.equal(
    terminalDispatchStateLockPath(resource),
    "/store-a/conversations/turn-a/state.json.lock"
  );
});

test("dynamic state derivation rejects malformed writer values before lock I/O", async () => {
  const fixtures = [
    {
      name: "null",
      key: "/store-a",
      value: null,
      error: /Store resource is invalid/u
    },
    {
      name: "object",
      key: "/store-a",
      value: { storeDir: "/store-a" },
      error: /Store resource is invalid/u
    },
    {
      name: "relative",
      key: "/store-a",
      value: "store-a",
      error: /Store resource is not canonical/u
    },
    {
      name: "key-mismatch",
      key: "/store-b",
      value: "/store-a",
      error: /Store resource is not canonical/u
    }
  ] as const;
  for (const fixture of fixtures) {
    const malformedResources = {
      terminal: resources.terminal,
      storeWriter: canonicalMutationResource(
        fixture.key,
        fixture.value as unknown as string
      )
    };
    let stateLockAcquires = 0;
    await withCanonicalMutationLocks({
      resources: malformedResources,
      acquireTerminal: () => () => undefined,
      withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
        operation()
    }, async (scopes, bound) => {
      assert.throws(() => {
        terminalDispatchStateMutationResource(
          scopes,
          bound,
          "/store-a/conversations/turn-a/state.json",
          "/store-a/conversations/turn-a/events.ndjson"
        );
        stateLockAcquires += 1;
      }, fixture.error, fixture.name);
    });
    assert.equal(stateLockAcquires, 0, fixture.name);
  }
});

test("state resource derivation rejects mixed and released scopes before I/O", async () => {
  let leaked:
    | {
        scopes: CanonicalStateMutationScopes;
        resources: CanonicalStateMutationResources;
      }
    | undefined;
  await withCanonicalMutationLocks(lockPorts([]), async (outer, bound) => {
    leaked = { scopes: outer, resources: bound };
    await withCanonicalMutationLocks(lockPorts([]), async (inner) => {
      assert.throws(
        () => terminalDispatchStateMutationResource(
          {
            terminal: outer.terminal,
            storeWriter: inner.storeWriter
          },
          bound,
          "/store-a/conversations/turn-a/state.json",
          "/store-a/conversations/turn-a/events.ndjson"
        ),
        /scopes belong to different transactions/u
      );
    });
  });
  let ioStarted = false;
  assert.throws(() => {
    terminalDispatchStateMutationResource(
      leaked!.scopes,
      leaked!.resources,
      "/store-a/conversations/turn-a/state.json",
      "/store-a/conversations/turn-a/events.ndjson"
    );
    ioStarted = true;
  }, /requires active authentic terminal scope/u);
  assert.equal(ioStarted, false);
});

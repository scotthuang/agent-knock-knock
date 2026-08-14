import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalMutationResource,
  capabilityGatedRepositoryOperation,
  withCanonicalMutationLocks,
  type CanonicalMutationLockPorts,
  type CanonicalMutationScopes,
  type CanonicalStateMutationScopes
} from "../src/mutation-transaction.js";

const TEST_RESOURCES = {
  resources: {
    terminal: canonicalMutationResource("terminal-1", "terminal-1"),
    storeWriter: canonicalMutationResource("/store", "/store"),
    state: canonicalMutationResource("state.json", {
      statePath: "state.json", logPath: "events.ndjson"
    })
  }
} as const;
const OTHER_RESOURCES = {
  terminal: canonicalMutationResource("terminal-2", "terminal-2"),
  storeWriter: canonicalMutationResource("/other-store", "/other-store"),
  state: canonicalMutationResource("other-state.json", {
    statePath: "other-state.json", logPath: "other-events.ndjson"
  })
} as const;

function fixture({ withState = true } = {}): {
  events: string[];
  ports: CanonicalMutationLockPorts;
} {
  const events: string[] = [];
  return {
    events,
    ports: {
      ...TEST_RESOURCES,
      acquireTerminal: () => {
        events.push("acquire terminal");
        return () => events.push("release terminal");
      },
      withStoreWriter: async (operation) => {
        events.push("acquire writer");
        try {
          return await operation();
        } finally {
          events.push("release writer");
        }
      },
      ...(withState
        ? {
            acquireState: () => {
              events.push("acquire state");
              return () => events.push("release state");
            }
          }
        : {})
    }
  };
}

test("mutation lock shell acquires canonically and releases in reverse", async () => {
  const { events, ports } = fixture();

  const result = await withCanonicalMutationLocks(ports, async () => {
    events.push("operation");
    return "complete";
  });

  assert.equal(result, "complete");
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "operation",
    "release state",
    "release writer",
    "release terminal"
  ]);
});

test("mutation transaction skips only the absent state scope", async () => {
  const { events, ports } = fixture({ withState: false });
  await withCanonicalMutationLocks(ports, async () => {
    events.push("operation");
  });
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "operation",
    "release writer",
    "release terminal"
  ]);
});

test("every transaction receives fresh unforgeable scopes that expire", async () => {
  const repository = {
    load: capabilityGatedRepositoryOperation(
      ["storeWriter"] as const,
      "storeWriter",
      (_storeDir: string, sessionId: string) => ({ sessionId })
    )
  };
  let first: CanonicalMutationScopes | undefined;
  let second: CanonicalMutationScopes | undefined;

  await withCanonicalMutationLocks(
    fixture({ withState: false }).ports,
    async (scopes, resources) => {
      first = scopes;
      assert.deepEqual(repository.load(scopes, resources, "session-1"), {
        sessionId: "session-1"
      });
    }
  );
  await withCanonicalMutationLocks(
    fixture({ withState: false }).ports,
    async (scopes) => {
      second = scopes;
    }
  );

  assert.notEqual(first?.terminal, second?.terminal);
  assert.notEqual(first?.storeWriter, second?.storeWriter);
  assert.throws(
    () => repository.load(
      first as CanonicalMutationScopes,
      TEST_RESOURCES.resources,
      "session-1"
    ),
    /requires active authentic storeWriter scope/u
  );
  const forged = Object.freeze({}) as CanonicalMutationScopes["storeWriter"];
  assert.throws(
    () => repository.load(
      { storeWriter: forged },
      TEST_RESOURCES.resources,
      "session-1"
    ),
    /requires active authentic storeWriter scope/u
  );
});

test("repository adapters reject mixed transactions and the wrong scope kind", async () => {
  const repository = {
    save: capabilityGatedRepositoryOperation(
      ["terminal", "storeWriter"] as const,
      "terminal",
      (_terminal: string, _document: { status: string }) => undefined
    )
  };

  await withCanonicalMutationLocks(fixture({ withState: false }).ports, async (outer) => {
    await withCanonicalMutationLocks(
      fixture({ withState: false }).ports,
      async (inner) => {
        assert.throws(
          () => repository.save({
            terminal: outer.terminal,
            storeWriter: inner.storeWriter
          }, TEST_RESOURCES.resources, { status: "resolved" }),
          /scopes belong to different transactions/u
        );
        assert.throws(
          () => repository.save({
            terminal: inner.storeWriter as unknown as CanonicalMutationScopes["terminal"],
            storeWriter: inner.storeWriter
          }, TEST_RESOURCES.resources, { status: "resolved" }),
          /requires active authentic terminal scope/u
        );
      }
    );
  });
});

test("repository adapters reject authentic scopes for another resource", async () => {
  const writerLoad = capabilityGatedRepositoryOperation(
    ["storeWriter"] as const,
    "storeWriter",
    (storeDir: string) => storeDir
  );
  const terminalLoad = capabilityGatedRepositoryOperation(
    ["terminal"] as const,
    "terminal",
    (terminal: string) => terminal
  );
  const stateLoad = capabilityGatedRepositoryOperation(
    ["state"] as const,
    "state",
    (resource: { statePath: string }) => resource.statePath
  );

  const { ports } = fixture();
  await withCanonicalMutationLocks({
    ...ports,
    acquireState: ports.acquireState!
  }, async (scopes) => {
    assert.throws(
      () => writerLoad(scopes, OTHER_RESOURCES),
      /requires active authentic storeWriter scope/u
    );
    assert.throws(
      () => terminalLoad(scopes, OTHER_RESOURCES),
      /requires active authentic terminal scope/u
    );
    assert.throws(
      () => stateLoad(scopes, OTHER_RESOURCES),
      /requires active authentic state scope/u
    );
  });
});

test("pane-incarnation reconciliation writes only for its exact locked resources", async () => {
  const writes: string[] = [];
  const reconcileIncarnation = capabilityGatedRepositoryOperation(
    ["terminal", "storeWriter"] as const,
    "terminal",
    (terminal: string, recordedAnchor: number, currentAnchor: number) => {
      if (recordedAnchor !== currentAnchor) {
        writes.push(terminal);
      }
    }
  );

  await withCanonicalMutationLocks(
    fixture({ withState: false }).ports,
    async (scopes) => {
      reconcileIncarnation(scopes, TEST_RESOURCES.resources, 101, 202);
      assert.deepEqual(writes, ["terminal-1"]);
      assert.throws(
        () => reconcileIncarnation(
          scopes,
          { ...TEST_RESOURCES.resources, terminal: OTHER_RESOURCES.terminal },
          101,
          303
        ),
        /requires active authentic terminal scope/u
      );
      assert.throws(
        () => reconcileIncarnation(
          scopes,
          { ...TEST_RESOURCES.resources, storeWriter: OTHER_RESOURCES.storeWriter },
          101,
          303
        ),
        /requires active authentic storeWriter scope/u
      );
      assert.deepEqual(writes, ["terminal-1"]);
    }
  );
});

test("conversation writes invoke real ports only under active writer and state scopes", async () => {
  const { events, ports } = fixture();
  const repository = {
    load: capabilityGatedRepositoryOperation(
      ["state"] as const,
      "state",
      (resource: { statePath: string }) => {
        events.push(`load ${resource.statePath}`);
        return { status: "waiting" };
      }
    ),
    save: capabilityGatedRepositoryOperation(
      ["storeWriter", "state"] as const,
      "state",
      (resource: { statePath: string }, state: { status: string }) => {
        events.push(`save ${resource.statePath} ${state.status}`);
      }
    ),
    appendEvent: capabilityGatedRepositoryOperation(
      ["storeWriter", "state"] as const,
      "state",
      (resource: { logPath: string }, event: { event: string }) => {
        events.push(`append ${resource.logPath} ${event.event}`);
      }
    )
  };
  let leaked: CanonicalStateMutationScopes | undefined;
  await withCanonicalMutationLocks({
    resources: ports.resources,
    acquireTerminal: ports.acquireTerminal,
    withStoreWriter: ports.withStoreWriter,
    acquireState: ports.acquireState!
  }, async (scopes, resources) => {
    leaked = scopes;
    assert.deepEqual(repository.load(scopes, resources), {
      status: "waiting"
    });
    repository.save(scopes, resources, { status: "closed" });
    repository.appendEvent(scopes, resources, {
      event: "conversation_closed"
    });
  });
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "load state.json",
    "save state.json closed",
    "append events.ndjson conversation_closed",
    "release state",
    "release writer",
    "release terminal"
  ]);
  assert.throws(
    () => repository.load(
      leaked as CanonicalStateMutationScopes,
      TEST_RESOURCES.resources
    ),
    /requires active authentic state scope/u
  );
});

test("terminal acquisition errors propagate unchanged without releasing", async () => {
  const expected = new Error("terminal unavailable");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
    ...TEST_RESOURCES,
    acquireTerminal: () => {
      events.push("acquire terminal");
      throw expected;
    },
    withStoreWriter: async (operation) => operation()
  };

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => undefined),
    (error) => error === expected
  );
  assert.deepEqual(events, ["acquire terminal"]);
});

test("writer acquisition errors propagate unchanged after terminal release", async () => {
  const expected = new Error("writer unavailable");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
    ...TEST_RESOURCES,
    acquireTerminal: () => {
      events.push("acquire terminal");
      return () => events.push("release terminal");
    },
    withStoreWriter: async () => {
      events.push("acquire writer");
      throw expected;
    }
  };

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => undefined),
    (error) => error === expected
  );
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "release terminal"
  ]);
});

test("state acquisition errors unwind writer then terminal unchanged", async () => {
  const expected = new Error("state unavailable");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
    ...TEST_RESOURCES,
    acquireTerminal: () => {
      events.push("acquire terminal");
      return () => events.push("release terminal");
    },
    withStoreWriter: async (operation) => {
      events.push("acquire writer");
      try {
        return await operation();
      } finally {
        events.push("release writer");
      }
    },
    acquireState: () => {
      events.push("acquire state");
      throw expected;
    }
  };

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => undefined),
    (error) => error === expected
  );
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "release writer",
    "release terminal"
  ]);
});

test("operation errors propagate unchanged after every reverse release", async () => {
  const expected = new Error("business failure");
  const { events, ports } = fixture();

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => {
      events.push("operation");
      throw expected;
    }),
    (error) => error === expected
  );
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "operation",
    "release state",
    "release writer",
    "release terminal"
  ]);
});

test("asynchronous state acquisition rejection unwinds writer and terminal", async () => {
  const expected = new Error("async state unavailable");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
    ...TEST_RESOURCES,
    acquireTerminal: async () => {
      events.push("acquire terminal");
      return () => events.push("release terminal");
    },
    withStoreWriter: async (operation) => {
      events.push("acquire writer");
      try {
        return await operation();
      } finally {
        events.push("release writer");
      }
    },
    acquireState: async () => {
      events.push("acquire state");
      throw expected;
    }
  };

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => undefined),
    (error) => error === expected
  );
  assert.deepEqual(events, [
    "acquire terminal",
    "acquire writer",
    "acquire state",
    "release writer",
    "release terminal"
  ]);
});

test("every release is attempted and the outermost release error wins", async () => {
  const operationError = new Error("operation failed");
  const stateReleaseError = new Error("state release failed");
  const writerReleaseError = new Error("writer release failed");
  const terminalReleaseError = new Error("terminal release failed");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
    ...TEST_RESOURCES,
    acquireTerminal: () => () => {
      events.push("release terminal");
      throw terminalReleaseError;
    },
    withStoreWriter: async (operation) => {
      try {
        return await operation();
      } finally {
        events.push("release writer");
        throw writerReleaseError;
      }
    },
    acquireState: () => () => {
      events.push("release state");
      throw stateReleaseError;
    }
  };

  await assert.rejects(
    withCanonicalMutationLocks(ports, async () => {
      throw operationError;
    }),
    (error) => error === terminalReleaseError
  );
  assert.deepEqual(events, [
    "release state",
    "release writer",
    "release terminal"
  ]);
});

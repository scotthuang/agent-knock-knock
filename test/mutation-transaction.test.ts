import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityGatedRepositoryOperation,
  withCanonicalMutationLocks,
  type CanonicalMutationLockPorts,
  type CanonicalMutationScopes,
  type CanonicalStateMutationScopes,
  type TerminalMutationScope
} from "../src/mutation-transaction.js";

function fixture({ withState = true } = {}): {
  events: string[];
  ports: CanonicalMutationLockPorts;
} {
  const events: string[] = [];
  return {
    events,
    ports: {
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
      (_storeDir: string, sessionId: string) => ({ sessionId })
    )
  };
  let first: CanonicalMutationScopes | undefined;
  let second: CanonicalMutationScopes | undefined;

  await withCanonicalMutationLocks(
    fixture({ withState: false }).ports,
    async (scopes) => {
      first = scopes;
      assert.deepEqual(repository.load(scopes, "/store", "session-1"), {
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
    () => repository.load(first as CanonicalMutationScopes, "/store", "session-1"),
    /requires active authentic storeWriter scope/u
  );
  const forged = Object.freeze({}) as CanonicalMutationScopes["storeWriter"];
  assert.throws(
    () => repository.load({ storeWriter: forged }, "/store", "session-1"),
    /requires active authentic storeWriter scope/u
  );
});

test("repository adapters reject mixed transactions and the wrong scope kind", async () => {
  const repository = {
    save: capabilityGatedRepositoryOperation(
      ["terminal", "storeWriter"] as const,
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
          }, "terminal-1", { status: "resolved" }),
          /scopes belong to different transactions/u
        );
        assert.throws(
          () => repository.save({
            terminal: inner.storeWriter as unknown as TerminalMutationScope,
            storeWriter: inner.storeWriter
          }, "terminal-1", { status: "resolved" }),
          /requires active authentic terminal scope/u
        );
      }
    );
  });
});

test("conversation writes invoke real ports only under active writer and state scopes", async () => {
  const { events, ports } = fixture();
  const repository = {
    load: capabilityGatedRepositoryOperation(["state"] as const, (statePath: string) => {
      events.push(`load ${statePath}`);
      return { status: "waiting" };
    }),
    save: capabilityGatedRepositoryOperation(
      ["storeWriter", "state"] as const,
      (statePath: string, state: { status: string }) => {
        events.push(`save ${statePath} ${state.status}`);
      }
    ),
    appendEvent: capabilityGatedRepositoryOperation(
      ["storeWriter", "state"] as const,
      (logPath: string, event: { event: string }) => {
        events.push(`append ${logPath} ${event.event}`);
      }
    )
  };
  let leaked: CanonicalStateMutationScopes | undefined;
  await withCanonicalMutationLocks({
    acquireTerminal: ports.acquireTerminal,
    withStoreWriter: ports.withStoreWriter,
    acquireState: ports.acquireState!
  }, async (scopes) => {
    leaked = scopes;
    assert.deepEqual(repository.load(scopes, "state.json"), {
      status: "waiting"
    });
    repository.save(scopes, "state.json", { status: "closed" });
    repository.appendEvent(scopes, "events.ndjson", {
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
      "state.json"
    ),
    /requires active authentic state scope/u
  );
});

test("terminal acquisition errors propagate unchanged without releasing", async () => {
  const expected = new Error("terminal unavailable");
  const events: string[] = [];
  const ports: CanonicalMutationLockPorts = {
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

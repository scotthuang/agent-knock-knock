import test from "node:test";
import assert from "node:assert/strict";
import {
  withMutationTransaction,
  type MutationTransactionCapabilities,
  type MutationTransactionPorts
} from "../src/mutation-transaction.js";

function fixture({ withState = true } = {}): {
  events: string[];
  ports: MutationTransactionPorts;
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

test("mutation transaction acquires canonically and releases in reverse", async () => {
  const { events, ports } = fixture();
  let capabilities: MutationTransactionCapabilities | undefined;

  const result = await withMutationTransaction(ports, async (held) => {
    capabilities = held;
    events.push("operation");
    return "complete";
  });

  assert.equal(result, "complete");
  assert.ok(capabilities?.terminal);
  assert.ok(capabilities?.storeWriter);
  assert.ok(capabilities?.state);
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
  await withMutationTransaction(ports, async (held) => {
    assert.equal(held.state, undefined);
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

test("terminal acquisition errors propagate unchanged without releasing", async () => {
  const expected = new Error("terminal unavailable");
  const events: string[] = [];
  const ports: MutationTransactionPorts = {
    acquireTerminal: () => {
      events.push("acquire terminal");
      throw expected;
    },
    withStoreWriter: async (operation) => operation()
  };

  await assert.rejects(
    withMutationTransaction(ports, async () => undefined),
    (error) => error === expected
  );
  assert.deepEqual(events, ["acquire terminal"]);
});

test("writer acquisition errors propagate unchanged after terminal release", async () => {
  const expected = new Error("writer unavailable");
  const events: string[] = [];
  const ports: MutationTransactionPorts = {
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
    withMutationTransaction(ports, async () => undefined),
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
  const ports: MutationTransactionPorts = {
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
    withMutationTransaction(ports, async () => undefined),
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
    withMutationTransaction(ports, async () => {
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

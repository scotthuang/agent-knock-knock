import test from "node:test";
import assert from "node:assert/strict";
import {
  withCanonicalMutationLocks,
  type CanonicalMutationLockPorts
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

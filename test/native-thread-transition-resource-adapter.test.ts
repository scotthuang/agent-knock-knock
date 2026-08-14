import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { TerminalControlRef } from "../src/terminal-agent-adapter.js";
import {
  canonicalMutationResource,
  withCanonicalMutationLocks,
  type CanonicalMutationResources,
  type CanonicalMutationScopes
} from "../src/mutation-transaction.js";
import {
  nativeThreadTransitionResourceBoundOperation,
  type NativeThreadTransitionResourceBinding
} from "../src/native-thread-transition-resource-adapter.js";
import {
  terminalRuntimeResourceKey
} from "../src/terminal-control-ref.js";

const STORE_DIR = "/workspace/store";
const ACTIVE_TERMINAL = {
  kind: "herdr" as const,
  target: "workspace-old:tab-old:pane-old",
  socketPath: "/tmp/herdr.sock",
  session: "session-old",
  panePid: 401,
  currentCommand: "codex",
  currentPath: "/workspace/project",
  capabilities: ["screen_status", "send_keys"],
  workspaceId: "workspace-old",
  tabId: "tab-old",
  paneId: "pane-old",
  terminalId: "terminal-stable"
} satisfies TerminalControlRef;
const FRESH_MOVED_TERMINAL = {
  ...ACTIVE_TERMINAL,
  target: "workspace-new:tab-new:pane-new",
  session: "session-new",
  workspaceId: "workspace-new",
  tabId: "tab-new",
  paneId: "pane-new"
} satisfies TerminalControlRef;

function binding(
  overrides: Partial<NativeThreadTransitionResourceBinding> = {}
): NativeThreadTransitionResourceBinding {
  return {
    freshTerminal: FRESH_MOVED_TERMINAL,
    capturedStoreDir: STORE_DIR,
    ...overrides
  };
}

function resources(
  terminalValue: unknown = ACTIVE_TERMINAL,
  writerValue: unknown = STORE_DIR,
  terminalKey = terminalRuntimeResourceKey(ACTIVE_TERMINAL),
  writerKey = STORE_DIR
): CanonicalMutationResources {
  return {
    terminal: canonicalMutationResource(
      terminalKey,
      terminalValue as TerminalControlRef
    ),
    storeWriter: canonicalMutationResource(
      writerKey,
      writerValue as string
    )
  };
}

function lockPorts(transactionResources: CanonicalMutationResources) {
  return {
    resources: transactionResources,
    acquireTerminal: () => () => undefined,
    withStoreWriter: async <Result>(operation: () => Promise<Result>) =>
      operation()
  };
}

test("a same-incarnation route move writes bytes through the fresh terminal", async () => {
  const transactionResources = resources();
  const save = nativeThreadTransitionResourceBoundOperation(
    binding(),
    (freshTerminal, canonicalStoreDir, payload: string) => {
      assert.equal(freshTerminal.kind, "herdr");
      return Buffer.from(JSON.stringify({
        target: freshTerminal.target,
        pane_id: freshTerminal.kind === "herdr"
          ? freshTerminal.paneId
          : undefined,
        store_dir: canonicalStoreDir,
        payload
      }));
    }
  );
  const bytes = await withCanonicalMutationLocks(
    lockPorts(transactionResources),
    async (scopes, activeResources) =>
      save(scopes, activeResources, "resolved")
  );
  assert.equal(bytes.toString(), JSON.stringify({
    target: FRESH_MOVED_TERMINAL.target,
    pane_id: FRESH_MOVED_TERMINAL.paneId,
    store_dir: STORE_DIR,
    payload: "resolved"
  }));
});

test("invalid or released lifecycle capabilities perform zero scoped I/O", async (t) => {
  const calls = { verification: 0, ownership: 0, ledger: 0 };
  const operations = (resourceBinding: NativeThreadTransitionResourceBinding) => ({
    verification: nativeThreadTransitionResourceBoundOperation(
      resourceBinding,
      () => { calls.verification += 1; }
    ),
    ownership: nativeThreadTransitionResourceBoundOperation(
      resourceBinding,
      () => { calls.ownership += 1; }
    ),
    ledger: nativeThreadTransitionResourceBoundOperation(
      resourceBinding,
      () => { calls.ledger += 1; }
    )
  });
  const rejectActive = async (
    transactionResources: CanonicalMutationResources,
    resourceBinding: NativeThreadTransitionResourceBinding,
    pattern: RegExp
  ) => {
    await withCanonicalMutationLocks(
      lockPorts(transactionResources),
      async (scopes, activeResources) => {
        for (const operation of Object.values(operations(resourceBinding))) {
          assert.throws(
            () => operation(scopes, activeResources),
            pattern
          );
        }
      }
    );
  };

  await t.test("wrong terminal incarnation", async () => {
    await rejectActive(resources(), binding({
      freshTerminal: { ...FRESH_MOVED_TERMINAL, panePid: 999 }
    }), /terminal changed outside the active capability/u);
  });
  await t.test("captured Store mismatch", async () => {
    await rejectActive(
      resources(),
      binding({ capturedStoreDir: "/workspace/other-store" }),
      /Store changed outside the active writer capability/u
    );
  });
  await t.test("writer value is not a string", async () => {
    await rejectActive(
      resources(ACTIVE_TERMINAL, 42),
      binding(),
      /Store changed outside the active writer capability/u
    );
  });
  await t.test("writer value is a relative equivalent of its absolute key", async () => {
    await rejectActive(
      resources(
        ACTIVE_TERMINAL,
        path.relative(process.cwd(), STORE_DIR)
      ),
      binding(),
      /Store changed outside the active writer capability/u
    );
  });
  await t.test("terminal value is malformed", async () => {
    await rejectActive(
      resources(Object.freeze({})),
      binding(),
      /terminal changed outside the active capability/u
    );
  });
  await t.test("terminal key and value disagree", async () => {
    await rejectActive(
      resources(ACTIVE_TERMINAL, STORE_DIR, "terminal:wrong"),
      binding(),
      /terminal changed outside the active capability/u
    );
  });
  await t.test("writer key and value disagree", async () => {
    await rejectActive(
      resources(ACTIVE_TERMINAL, STORE_DIR, undefined, "/workspace/wrong"),
      binding(),
      /Store changed outside the active writer capability/u
    );
  });

  let releasedScopes: CanonicalMutationScopes | undefined;
  let releasedResources: CanonicalMutationResources | undefined;
  const validResources = resources();
  await withCanonicalMutationLocks(
    lockPorts(validResources),
    async (scopes, activeResources) => {
      releasedScopes = scopes;
      releasedResources = activeResources;
    }
  );
  const expiredScopes = releasedScopes;
  const expiredResources = releasedResources;
  assert.ok(expiredScopes);
  assert.ok(expiredResources);
  for (const operation of Object.values(operations(binding()))) {
    assert.throws(
      () => operation(expiredScopes, expiredResources),
      /requires active authentic terminal scope/u
    );
  }
  assert.deepEqual(calls, { verification: 0, ownership: 0, ledger: 0 });
});

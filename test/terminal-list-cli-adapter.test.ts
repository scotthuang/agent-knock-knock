import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import * as terminalListCliAdapter from "../src/terminal-list-cli-adapter.js";
import type {
  TerminalListAuthorityPorts,
  TerminalListCliDependencies,
  TerminalListDiscoveryPorts,
  TerminalListStoreObservationPorts
} from "../src/terminal-list-cli-adapter.js";

interface DeferredGate {
  promise: Promise<void>;
  release(): void;
}

function deferredGate(): DeferredGate {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    promise,
    release: () => release?.()
  };
}

function facadeDependencies(
  marker: "A" | "B",
  events: string[],
  monitorGate: DeferredGate,
  diagnosticsGate: DeferredGate
): TerminalListCliDependencies {
  const discovery = {
    createRuntimeTerminalAgentRegistry: () => ({
      get: () => undefined,
      list: () => []
    }),
    createTerminalControlProvider: () => ({
      diagnostics: async () => {
        events.push(`${marker}:diagnostics:before`);
        await diagnosticsGate.promise;
        events.push(`${marker}:diagnostics:after`);
        return {};
      }
    }),
    createTerminalAgentBridge: () => ({
      listProcesses: async () => []
    }),
    createTerminalProcessSource: () => {
      events.push(`${marker}:process-source`);
      return {
        listProcessSnapshots: async () => []
      };
    }
  } as unknown as TerminalListDiscoveryPorts;

  return {
    reconciliation: {
      reconcileMonitors: async () => {
        events.push(`${marker}:monitor:before`);
        await monitorGate.promise;
        events.push(`${marker}:monitor:after`);
        return {
          checked: 0,
          launched: 0,
          repaired: 0,
          collateral_stalls_checked: 0,
          collateral_stalls_skipped: 0,
          already_running: 0,
          skipped: 0,
          errors: 0,
          items: []
        };
      },
      reconcileIdleConversations: () => {
        events.push(`${marker}:idle`);
        return {
          checked: 0,
          closed: 0,
          skipped: 0,
          idle_timeout_minutes: 60
        };
      }
    },
    discovery,
    store: {
      isDiscoverableTmuxConversation: () => true,
      storeDirFromOptions: (options: { storeDir?: string }) =>
        String(options.storeDir)
    } as unknown as TerminalListStoreObservationPorts,
    authority: {} as TerminalListAuthorityPorts,
    policy: {
      approvalTtlMs: 60_000,
      selectorCommands: new Set(["status"]),
      rememberOriginalExpectedTerminalSelector: () => {
        events.push(`${marker}:selector`);
      }
    }
  };
}

test("terminal list facade isolates concurrent async runtimes and exports only its factory", async (t) => {
  assert.deepEqual(
    Object.keys(terminalListCliAdapter).sort(),
    ["createTerminalListCliFacade"]
  );

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "akk-list-facade-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const storeA = path.join(tempDir, "store-a");
  const storeB = path.join(tempDir, "store-b");
  const events: string[] = [];
  const monitorA = deferredGate();
  const monitorB = deferredGate();
  const diagnosticsA = deferredGate();
  const diagnosticsB = deferredGate();
  t.after(() => {
    monitorA.release();
    monitorB.release();
    diagnosticsA.release();
    diagnosticsB.release();
  });
  diagnosticsA.release();
  monitorB.release();

  const facadeA = terminalListCliAdapter.createTerminalListCliFacade(
    facadeDependencies("A", events, monitorA, diagnosticsA)
  );
  const facadeB = terminalListCliAdapter.createTerminalListCliFacade(
    facadeDependencies("B", events, monitorB, diagnosticsB)
  );

  const listPromise = runCliCommandExecution(
    "list",
    {},
    { runtimeLog: () => undefined },
    () => facadeA.runList({
      storeDir: storeA,
      reconcile: true,
      managedOnly: true
    })
  );
  const selectorPromise = runCliCommandExecution(
    "status",
    {},
    { runtimeLog: () => undefined },
    async () => {
      await assert.rejects(
        facadeB.resolveConversationSelectorOption("status", {
          storeDir: storeB,
          turn: "only",
          terminalDebug: true
        }),
        /no actionable/iu
      );
    }
  );

  for (let attempt = 0; attempt < 10 && events.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  assert.deepEqual(events, ["A:monitor:before", "B:diagnostics:before"]);
  diagnosticsB.release();
  await selectorPromise;
  monitorA.release();
  await listPromise;

  assert.deepEqual(events, [
    "A:monitor:before",
    "B:diagnostics:before",
    "B:diagnostics:after",
    "B:process-source",
    "A:monitor:after",
    "A:idle"
  ]);

  await facadeA.resolveConversationSelectorOption("status", {
    state: "already-resolved",
    expectedTerminalToken: "token-a"
  });
  await facadeB.resolveConversationSelectorOption("status", {
    state: "already-resolved",
    expectedTerminalToken: "token-b"
  });
  assert.deepEqual(events.slice(-2), ["A:selector", "B:selector"]);
});

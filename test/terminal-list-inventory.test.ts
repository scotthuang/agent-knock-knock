import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActiveTerminalProcess,
  TerminalAgentAdapterRegistry,
  TerminalControlRef,
  TerminalProcessSnapshot
} from "../src/terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "../src/terminal-agent-bridge.js";
import {
  collectTerminalListInventory,
  type TerminalListInventoryPorts
} from "../src/terminal-list-inventory.js";
import type { TerminalControlProvider } from
  "../src/terminal-control-provider.js";
import type { TerminalProcessSource } from
  "../src/terminal-process-source.js";

interface TestOptions {
  managedOnly?: boolean;
  noApprovalScan?: boolean;
  terminalDebug?: boolean;
}

const terminalControl: TerminalControlRef = {
  kind: "tmux",
  target: "demo:0.0",
  session: "demo",
  window: 0,
  pane: 0,
  panePid: 100,
  currentPath: "/workspace/demo",
  capabilities: ["screen_status", "send_keys"]
};

const snapshots: TerminalProcessSnapshot[] = [
  { pid: 100, ppid: 1, command: "zsh", cwd: "/workspace/demo" },
  { pid: 101, ppid: 100, command: "codex", cwd: "/workspace/demo" }
];

const active: ActiveTerminalProcess = {
  ...snapshots[1],
  agent: "codex",
  kind: "interactive",
  confidence: "high",
  reason: "test fixture",
  terminalControl
};

function inventoryFixture() {
  const log: Array<{ event: string; fields: Record<string, unknown> }> = [];
  let projected = 0;
  let processScans = 0;
  const adapter = {
    agent: "codex",
    capabilities: { processDiscovery: true },
    classifyProcess: (snapshot: TerminalProcessSnapshot) =>
      snapshot.pid === active.pid ? active : undefined
  };
  const registry = {
    get: (agent: string) => agent === "codex" ? adapter : undefined,
    list: () => [adapter]
  } as unknown as TerminalAgentAdapterRegistry;
  const bridge = {
    listProcesses: async () => [active],
    terminalConversationId: () => "terminal:v2:tmux:codex:demo:0.0:101"
  } as unknown as TerminalAgentBridge;
  const provider = {
    diagnostics: async () => ({ status: "ready" })
  } as unknown as TerminalControlProvider;
  const processSource = {
    listProcessSnapshots: async (
      predicate?: (snapshot: TerminalProcessSnapshot) => boolean
    ) => {
      processScans += 1;
      assert.equal(predicate?.(snapshots[1]), true);
      return snapshots;
    }
  } as TerminalProcessSource;
  const ports: TerminalListInventoryPorts<TestOptions> = {
    createRegistry: () => registry,
    createBridge: () => bridge,
    createProvider: () => provider,
    createProcessSource: () => processSource,
    projectTerminal: async ({ session }) => {
      projected += 1;
      return {
        id: bridge.terminalConversationId(session),
        agent: session.agent,
        pid: session.pid,
        terminal_control: terminalControl
      };
    },
    log: (_level, event, fields) => log.push({ event, fields })
  };
  return {
    ports,
    log,
    counts: () => ({ projected, processScans })
  };
}

test("terminal inventory scans and projects each selected physical pane once", async () => {
  const fixture = inventoryFixture();
  const result = await collectTerminalListInventory({
    options: { terminalDebug: true },
    ports: fixture.ports
  });

  assert.deepEqual(fixture.counts(), { projected: 1, processScans: 1 });
  assert.equal(result.terminalControlled.length, 1);
  assert.equal(result.terminalControlled[0].pid, 101);
  assert.deepEqual(result.summary, {
    enabled: true,
    agents: ["codex"],
    active_count: 1,
    terminal_count: 1,
    approval_scan: "enabled",
    diagnostics: { status: "ready" },
    error: undefined
  });
  assert.deepEqual(fixture.log, []);
});

test("independent terminal projections overlap without changing discovery order", { timeout: 1000 }, async () => {
  const fixture = inventoryFixture();
  const sessions = [active, { ...active, pid: 102, terminalControl: { ...terminalControl, panePid: 102, target: "demo:0.1", pane: 1 } }];
  fixture.ports.createBridge = () => ({ listProcesses: async () => sessions,
    terminalConversationId: (session: ActiveTerminalProcess) => `terminal-${session.pid}` }) as unknown as TerminalAgentBridge;
  let release: (() => void) | undefined;
  const secondStarted = new Promise<void>(resolve => { release = resolve; });
  fixture.ports.projectTerminal = async ({ session }) => {
    if (session.pid === active.pid) await secondStarted;
    else release!();
    return { id: `terminal-${session.pid}` };
  };
  const result = await collectTerminalListInventory({ options: {}, ports: fixture.ports });
  assert.deepEqual(result.terminalControlled.map(row => row.id), ["terminal-101", "terminal-102"]);
});

test("native target PID limits detail projection without substituting another live pane", async () => {
  const fixture = inventoryFixture();
  const missing = await collectTerminalListInventory({ options: {}, processPid: 999, ports: fixture.ports });
  assert.deepEqual(missing.terminalControlled, []);
  assert.equal(fixture.counts().projected, 0);
  const selected = await collectTerminalListInventory({ options: {}, processPid: 101, ports: fixture.ports });
  assert.equal(selected.terminalControlled.length, 1);
  assert.equal(fixture.counts().projected, 1);
});

test("exact inventory keeps all diagnostic stages on the same discovery snapshot", async () => {
  const fixture = inventoryFixture();
  const terminalId = "terminal:v2:tmux:codex:demo:0.0:101";
  const result = await collectTerminalListInventory({
    options: {},
    agentFilter: "codex",
    terminalId,
    ports: fixture.ports
  });

  assert.equal(result.terminalControlled[0].id, terminalId);
  assert.deepEqual(
    fixture.log.map((entry) => entry.fields.stage),
    ["started", "process_inventory", "process_classification_and_association",
      "complete"]
  );
  assert.deepEqual(fixture.counts(), { projected: 1, processScans: 1 });
});

test("managed-only inventory performs no terminal discovery", async () => {
  const fixture = inventoryFixture();
  const result = await collectTerminalListInventory({
    options: { managedOnly: true },
    ports: fixture.ports
  });

  assert.equal(result.summary.enabled, false);
  assert.deepEqual(result.terminalControlled, []);
  assert.deepEqual(fixture.counts(), { projected: 0, processScans: 0 });
});

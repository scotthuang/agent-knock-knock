import assert from "node:assert/strict";
import test from "node:test";

import {
  runTerminalApproval,
  type TerminalApprovalCliDependencies,
  type TerminalApprovalCliPorts
} from "../src/terminal-approval-cli-adapter.js";
import type { TerminalCommandTarget } from
  "../src/terminal-command-cli-ports.js";

function dependencies(
  implemented: Partial<TerminalApprovalCliPorts>,
  output: unknown[] = []
): TerminalApprovalCliDependencies {
  const ports = new Proxy(implemented, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(`unexpected approval port ${String(property)}`);
    }
  }) as TerminalApprovalCliPorts;
  return {
    ports,
    runtime: {
      now: () => new Date("2026-09-15T00:00:00.000Z"),
      nowMs: () => Date.parse("2026-09-15T00:00:00.000Z"),
      log: () => undefined,
      printJson: (value) => output.push(value)
    },
    defaults: {
      agentTimeoutMinutes: 60,
      agentHardTimeoutMinutes: 720,
      claudeScreenApprovalTtlMs: 10 * 60 * 1000
    }
  };
}

test("approval adapter rejects an unknown decision before resolving a target", async () => {
  await assert.rejects(
    runTerminalApproval(dependencies({}), {
      decision: "approve_forever" as never
    }),
    /--decision must be one of: approve_once, reject/u
  );
});

test("terminal-scoped automatic approval is rejected before terminal input", async () => {
  const events: string[] = [];
  const terminal = {
    conversationId: "terminal:tmux:approval:0.0:42",
    agent: "codex",
    pid: 42,
    legacy: false,
    adapter: {},
    terminalControl: {
      kind: "tmux",
      target: "approval:0.0",
      session: "approval",
      window: 0,
      pane: 0,
      panePid: 42,
      capabilities: []
    }
  } as unknown as TerminalCommandTarget;
  const ports = {
    async resolveTerminalConversationFromOptions() {
      events.push("resolve");
      return terminal;
    },
    assertExpectedHandoffTokenUsesExactTerminalSelector() {
      events.push("selector");
    }
  } satisfies Partial<TerminalApprovalCliPorts>;

  await assert.rejects(
    runTerminalApproval(dependencies(ports), {
      terminal: terminal.conversationId,
      autoApproved: true,
      decision: "approve_once"
    }),
    /automatic approval requires an exact managed Turn/u
  );
  assert.deepEqual(events, ["resolve", "selector"]);
});

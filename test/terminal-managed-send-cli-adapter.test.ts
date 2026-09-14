import assert from "node:assert/strict";
import test from "node:test";

import {
  runManagedRawTerminalSendAttempt,
  runManagedSessionSend,
  type TerminalManagedSendCliPorts,
  type TerminalManagedSendDependencies
} from "../src/terminal-managed-send-cli-adapter.js";
import type { TerminalCommandTarget } from
  "../src/terminal-command-cli-ports.js";

function dependencies(input: {
  ports?: Partial<TerminalManagedSendCliPorts>;
  events: string[];
}): TerminalManagedSendDependencies {
  const ports = new Proxy(input.ports ?? {}, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      input.events.push(`unexpected:${String(property)}`);
      throw new Error(`unexpected managed Send port ${String(property)}`);
    }
  }) as unknown as TerminalManagedSendCliPorts;
  return {
    ports,
    foregroundIdentificationAuthority: {
      clear: () => input.events.push("unexpected:foreground-clear"),
      current: () => undefined,
      remember: () => input.events.push("unexpected:foreground-remember"),
      assertCurrent: () => input.events.push("unexpected:foreground-assert")
    },
    replayExactActiveTerminalSubmission: () => {
      input.events.push("unexpected:replay");
      return false;
    },
    runTerminalControlSend: async () => {
      input.events.push("unexpected:terminal-input");
      throw new Error("terminal input must not start");
    },
    runtime: {
      now: () => new Date("2026-09-15T00:00:00.000Z")
    }
  };
}

const terminal = {
  conversationId: "terminal:v2:tmux:codex:managed-send:0.0:42",
  agent: "codex" as const,
  pid: 42,
  legacy: false,
  adapter: {},
  terminalControl: {
    kind: "tmux" as const,
    target: "managed-send:0.0",
    session: "managed-send",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: ["screen_status" as const, "send_keys" as const]
  }
} as unknown as TerminalCommandTarget;

test("managed Session Send rejects terminal authority before ports or input", async () => {
  const events: string[] = [];
  await assert.rejects(
    runManagedSessionSend(
      dependencies({ events }),
      { expectedTerminalToken: "terminal-authority" },
      "task"
    ),
    /--expected-terminal-token cannot be used with a managed Session/u
  );
  assert.deepEqual(events, []);
});

test("managed raw Send rejects non-background delivery before locks or input", async () => {
  const events: string[] = [];
  const attempt = { terminalControlSendInvoked: false };
  await assert.rejects(
    runManagedRawTerminalSendAttempt(
      dependencies({
        events,
        ports: {
          assertExpectedHandoffTokenUsesExactTerminalSelector: () => {
            events.push("selector");
          }
        }
      }),
      {},
      "task",
      terminal,
      false,
      attempt
    ),
    /raw terminal sends require --background/u
  );
  assert.deepEqual(events, ["selector"]);
  assert.equal(attempt.terminalControlSendInvoked, false);
});

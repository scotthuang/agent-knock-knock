import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { unmanagedTerminalBindingToken } from "../src/managed-session.js";
import {
  runHumanExplicitTerminalSend,
  type TerminalHumanExplicitSendCliPorts,
  type TerminalHumanExplicitSendDependencies
} from "../src/terminal-human-explicit-send-cli-adapter.js";
import type { TerminalCommandTarget } from
  "../src/terminal-command-cli-ports.js";

test(
  "human-explicit Send never falls back after managed input may have started",
  async (t) => {
    const sandbox = fs.mkdtempSync(
      path.join(os.tmpdir(), "akk-human-explicit-send-")
    );
    t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
    const workspace = path.join(sandbox, "workspace");
    const runtimeDir = path.join(sandbox, "runtime");
    fs.mkdirSync(workspace, { recursive: true });
    const terminalControl = {
      kind: "tmux" as const,
      target: "human-explicit:0.0",
      session: "human-explicit",
      window: 0,
      pane: 0,
      panePid: 42,
      currentPath: workspace,
      capabilities: ["screen_status" as const, "send_keys" as const]
    };
    const terminal = {
      conversationId: "terminal:v2:tmux:codex:human-explicit:0.0:42",
      agent: "codex" as const,
      pid: 42,
      legacy: false,
      adapter: {},
      terminalControl
    } as unknown as TerminalCommandTarget;
    const processUuid = "11111111-1111-4111-8111-111111111111";
    const processBirth = "2026-09-15T00:00:00.000Z";
    const expectedTerminalToken = unmanagedTerminalBindingToken({
      terminalId: terminal.conversationId,
      terminalControl,
      agent: "codex",
      pid: 42,
      workspace,
      processUuid,
      processBirth
    });
    const accessedPorts: string[] = [];
    let managedAttempts = 0;
    const implemented = {
      required<Value>(value: Value | null | undefined, label: string): Value {
        if (value === undefined || value === null) throw new Error(label);
        return value;
      },
      assertExpectedHandoffTokenUsesExactTerminalSelector() {},
      processIncarnationForPid() {
        return { processUuid, processBirth, evidence: "process_birth" as const };
      },
      terminalBridgeRuntimeKey() {
        return "tmux:human-explicit:0.0:42";
      }
    } satisfies Partial<TerminalHumanExplicitSendCliPorts>;
    const ports = new Proxy(implemented, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) {
          return Reflect.get(target, property, receiver);
        }
        accessedPorts.push(String(property));
        throw new Error(`unexpected port access: ${String(property)}`);
      }
    }) as unknown as TerminalHumanExplicitSendCliPorts;
    const dependencies: TerminalHumanExplicitSendDependencies = {
      ports,
      runtime: {
        env: () => ({ ...process.env, AKK_RUNTIME_DIR: runtimeDir }),
        now: () => new Date("2026-09-15T00:00:00.000Z"),
        log: () => {},
        printJson: () => {
          assert.fail("uncertain Send must not print a success receipt");
        },
        durableTerminalInputDispatched: () => false
      },
      managedSendAttempt: async (_options, _message, _terminal, _defer, attempt) => {
        managedAttempts += 1;
        attempt.terminalControlSendInvoked = true;
        throw new Error("input outcome unknown");
      }
    };

    await assert.rejects(
      runHumanExplicitTerminalSend(
        dependencies,
        {
          expectedTerminalToken,
          messageId: "message-possible-input"
        },
        "human request",
        terminal
      ),
      new RegExp(
        "managed terminal Send may already have started input; refusing an " +
        "automatic unmanaged fallback: input outcome unknown"
      )
    );
    assert.equal(managedAttempts, 1);
    assert.deepEqual(accessedPorts, []);
  }
);

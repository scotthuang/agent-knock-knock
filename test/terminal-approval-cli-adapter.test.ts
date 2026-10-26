import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import { terminalBindingFrom } from "../src/managed-session.js";
import { saveManagedSession } from "../src/session-store.js";
import { ensureStoreWritable, withStoreWriterLease } from "../src/store.js";
import { createTerminalDispatchRepositoryCliAdapter } from "../src/terminal-dispatch-repository-cli-adapter.js";
import { createTerminalListCliFacade, type TerminalListCliDependencies } from "../src/terminal-list-cli-adapter.js";
import type { ResolvedTerminalConversation } from "../src/terminal-agent-bridge.js";

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

test("resolved foreign Store authority offers no terminal approval and rejects untokened approval before input", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-approval-authority-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "source"), target = path.join(root, "target");
  ensureStoreWritable(source);
  ensureStoreWritable(target);
  const terminal = {
    conversationId: "terminal:tmux:foreign-approval:0.0:42", agent: "codex", pid: 42,
    legacy: false, adapter: {}, terminalControl: {
      kind: "tmux", target: "foreign-approval:0.0", session: "foreign-approval",
      socketPath: path.join(root, "tmux.sock"), window: 0, pane: 0, panePid: 42, capabilities: []
    }
  } as unknown as TerminalCommandTarget & ResolvedTerminalConversation;
  await runCliCommandExecution("approve", {}, {
    env: { ...process.env, AKK_RUNTIME_DIR: path.join(root, "runtime") }, runtimeLog: () => undefined
  }, async () => {
    const repository = createTerminalDispatchRepositoryCliAdapter();
    const now = new Date("2026-10-23T00:00:00.000Z");
    const binding = terminalBindingFrom({ terminalId: terminal.conversationId,
      terminalControl: terminal.terminalControl, pid: terminal.pid,
      nativeThreadId: "44444444-4444-4444-8444-444444444444", processUuid: "approval-process",
      processBirth: now.toISOString(), evidence: "fixture", generation: 1, now });
    saveManagedSession(source, { schema: "agent-knock-knock/session", version: 1,
      session_id: "session-foreign-approval", agent: "codex", workspace: root, status: "bound",
      binding, lineage: { created_by: "attach" }, created_at: now.toISOString(), updated_at: now.toISOString()
    }, { expectedRevision: null });
    withStoreWriterLease(source, () => repository.save(terminal.terminalControl, {
      status: "resolved", store_dir: source, session_id: "session-foreign-approval",
      native_thread_id: binding.native_thread_id, binding, dispatcher_pid: null, resolved_at: now.toISOString()
    }, { authorityTransfer: true }));
    const list = createTerminalListCliFacade({
      reconciliation: {}, discovery: {}, authority: {},
      policy: { approvalTtlMs: 60_000, selectorCommands: new Set(), rememberOriginalExpectedTerminalSelector: () => {} },
      store: { storeDirFromOptions: () => target, loadTerminalBridgeDispatchLedger: repository.load,
        terminalDispatchRecordMatchesControl: repository.matchesControl }
    } as unknown as TerminalListCliDependencies);
    const before = repository.load(terminal.terminalControl);
    const resolution = await list.resolveTerminalScopedCodexApproval({ options: {}, terminal });
    assert.equal(resolution.state, "blocked", "released dispatch must retain foreign Session authority");
    assert.equal("boundary" in resolution, false, "no approval token may be offered");
    let inputs = 0;
    await assert.rejects(runTerminalApproval(dependencies({
      resolveTerminalConversationFromOptions: async () => terminal,
      assertExpectedHandoffTokenUsesExactTerminalSelector: () => {},
      acquireTerminalBridgeSendLock: repository.acquire,
      storeDirFromOptions: () => target,
      terminalList: list,
      createTerminalAgentBridge: (() => ({ approve: async () => {
        inputs += 1;
        throw new Error("unexpected terminal input");
      } })) as unknown as TerminalApprovalCliPorts["createTerminalAgentBridge"]
    }), { terminal: terminal.conversationId, decision: "approve_once" }), /authoritative in another Store/u);
    assert.equal(inputs, 0);
    assert.deepEqual(repository.load(terminal.terminalControl), before);
  });
});

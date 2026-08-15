import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  createTerminalAcceptanceCliFacade,
  type TerminalAcceptanceCliDependencies
} from "../src/terminal-acceptance-cli-adapter.js";
import { terminalBindingFrom, type ManagedSessionState } from
  "../src/managed-session.js";

function compiledSource(): string {
  return fs.readFileSync(
    new URL("../src/terminal-acceptance-cli-adapter.js", import.meta.url),
    "utf8"
  );
}

function compiledCoreComposition(): string {
  const source = fs.readFileSync(
    new URL("../src/cli-core.js", import.meta.url),
    "utf8"
  );
  const from = source.indexOf("const terminalAcceptanceCliFacade =");
  const to = source.indexOf("const terminalDispatchExecution =", from);
  assert.notEqual(from, -1, "missing acceptance composition");
  assert.notEqual(to, -1, "missing acceptance facade aliases");
  return source.slice(from, to);
}

function sourceBetween(start: string, end: string): string {
  const source = compiledSource();
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return source.slice(from, to);
}

function assertOrdered(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const found = source.indexOf(token, cursor);
    assert.notEqual(found, -1, `missing ordered token ${token}`);
    cursor = found + token.length;
  }
}

test("acceptance adapter exposes one factory and keeps exact lock/write order", () => {
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  assert.deepEqual(Object.keys(facade), [
    "execution",
    "recoverVirgin",
    "reconcileMonitor",
    "markUncertain",
    "inspectCodexOpenRoots",
    "resolveNativeIdentity",
    "observeNativeIdentity",
    "assertTurnIdentity",
    "withNativeIdentity",
    "storeDirForConversation",
    "refineSessionIdentity",
    "persistSessionIdentity",
    "quarantineSession",
    "turnsForSession",
    "assertSessionCanStartTurn",
    "turnMatchesTerminal",
    "createManagedTurn"
  ]);
  assertOrdered(sourceBetween("async recoverVirgin(", "async #recoverVirginWithWriter"), [
    "acquireTerminalLock(",
    "#recoverVirginWithWriter({",
    "finally",
    "releaseTerminal()"
  ]);
  assertOrdered(sourceBetween(
    "async #recoverVirginWithWriter",
    "async #recoverVirginLocked"
  ), [
    "withStoreWriterLeaseAsync",
    "acquireStateLock(",
    "#recoverVirginLocked(input)",
    "finally",
    "releaseState()"
  ]);
  assertOrdered(sourceBetween(
    "#commitAcceptanceLocked(",
    "\n    #persistResolvedAcceptanceLedger("
  ), [
    "assertAcceptanceGeneration(",
    "resolvedAcceptanceConversation(",
    "reconcileLedger(",
    "saveState(",
    "#persistResolvedAcceptanceLedger(",
    "#appendResolvedAcceptanceEvent("
  ]);
  assertOrdered(sourceBetween(
    "#markUncertainLocked(",
    "\n    #persistUncertainLedger("
  ), [
    "applyTerminalBridgeSubmission({",
    "#persistUncertainLedger(",
    "saveState(",
    "appendEvent("
  ]);
  assertOrdered(sourceBetween("assertTurn: (identity)", "persistence:"), [
    "recoveredAt ??= cliNow().toISOString()",
    "this.assertTurnIdentity("
  ]);
  assertOrdered(sourceBetween(
    "    execution(options, bridge) {",
    "    async inspectCodexOpenRoots"
  ), [
    "let currentRuntime",
    "this.#dependencies.terminal.runtime(options)",
    "runtime().loadClaudeAgentRows",
    "runtime().createBridge()"
  ]);
  const composition = compiledCoreComposition();
  assertOrdered(composition, [
    "runtime: (options) => terminalRuntime(options)",
    "acquireTerminalLock: terminalDispatchRepository.acquire",
    "loadLedger: terminalDispatchRepository.load",
    "saveLedger: terminalDispatchRepository.save",
    "reconcileLedger: terminalDispatchRecovery.reconcilePrepared",
    "bindingFields: terminalDispatchRecovery.bindingFields"
  ]);
  assert.doesNotMatch(
    composition,
    /claudeRows:|bridge: createTerminalAgentBridge|loadTerminalBridgeDispatchLedger|reconcilePreparedTerminalDispatchLedger/u
  );
});

test("managed Turn creation preserves storage and binding JSON keys", () => {
  const control = {
    kind: "tmux" as const,
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const binding = terminalBindingFrom({
    terminalId: "terminal:tmux:akk:0.0:42",
    terminalControl: control,
    pid: 42,
    nativeThreadId: "00000000-0000-4000-8000-000000000001",
    processUuid: "codex-pid:42:birth:1",
    processBirth: "1",
    rollout: {
      fd: "7",
      device: "1",
      inode: "2",
      path: "/tmp/rollout.jsonl"
    },
    evidence: "codex_rollout_fd",
    generation: 7,
    now: new Date("2026-08-15T00:00:00.000Z")
  });
  const session: ManagedSessionState = {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-1",
    revision: 11,
    agent: "codex",
    workspace: "/workspace/project",
    status: "bound",
    binding,
    lineage: { created_by: "attach" },
    created_at: "2026-08-15T00:00:00.000Z",
    updated_at: "2026-08-15T00:00:00.000Z"
  };
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const created = facade.createManagedTurn({
    options: { storeDir: "/tmp/akk-acceptance-shape", messageId: "msg-1" },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control,
    managedSession: session
  });
  assert.deepEqual(Object.keys(created), [
    "conversation",
    "nextConversation",
    "statePath",
    "logPath",
    "executor",
    "message"
  ]);
  assert.equal(created.conversation.terminal_binding_id, binding.binding_id);
  assert.equal(created.conversation.terminal_binding_generation, 7);
  assert.equal(created.conversation.native_thread_id, binding.native_thread_id);
  assert.deepEqual(Object.keys(created.conversation).slice(-4), [
    "store_dir",
    "conversation_dir",
    "event_log_path",
    "state_path"
  ]);
  assert.equal(created.conversation.store_dir, "/tmp/akk-acceptance-shape");
  assert.equal(
    created.conversation.conversation_dir,
    `/tmp/akk-acceptance-shape/conversations/${created.conversation.turn_id}`
  );
  assert.equal(
    created.logPath,
    `${created.conversation.conversation_dir}/events.ndjson`
  );
  assert.equal(
    created.statePath,
    `${created.conversation.conversation_dir}/state.json`
  );
  const takeover = created.conversation.native_session_takeover as
    Record<string, unknown>;
  const normalized = { ...takeover, attached_at: "<time>" };
  assert.equal(JSON.stringify(normalized), JSON.stringify({
    agent: "codex",
    terminal_agent_identity_protocol: 1,
    native_session_id: "terminal:tmux:akk:0.0:42",
    terminal_agent_pid: 42,
    terminal_agent_expected_session_id: binding.native_thread_id,
    terminal_binding_id: binding.binding_id,
    terminal_binding_generation: 7,
    terminal_agent_process_uuid: binding.native_process.process_uuid,
    terminal_agent_process_birth: binding.native_process.process_birth,
    terminal_agent_rollout: binding.native_process.rollout,
    terminal_agent_identity_evidence: binding.native_process.evidence,
    source_cwd: "/workspace/project",
    source_title: "Terminal-controlled Codex akk:0.0",
    strategy: "terminal_control",
    attached_at: "<time>",
    takeover_match_kind: "raw_terminal_send",
    terminal_control: control,
    needs_bootstrap: false,
    terminal_bridge: true
  }));
  assert.equal(created.message.id, "msg-1");
  assert.equal(created.message.session_id, "session-1");
  assert.equal(created.message.turn_id, created.conversation.turn_id);
});

test("service declarations remain data-only and the facade exposes no raw any", () => {
  const declaration = fs.readFileSync(
    new URL("../src/terminal-acceptance-cli-adapter.d.ts", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    declaration,
    /\bany\b|Record<[^>]*any|ResolvedTerminalConversation/u
  );
  for (const file of [
    "terminal-acceptance-application-service.js",
    "managed-turn-recovery-service.js"
  ]) {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /node:fs|node:path|\.\/store\.js|\.\/session-store\.js|Record<[^>]*any|ResolvedTerminalConversation/u
    );
  }
});

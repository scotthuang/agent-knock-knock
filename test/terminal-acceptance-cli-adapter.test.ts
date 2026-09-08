import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTerminalAcceptanceCliFacade,
  type TerminalAcceptanceBridge,
  type TerminalAcceptanceCliDependencies
} from "../src/terminal-acceptance-cli-adapter.js";
import type { CodingAgentSessionProvider } from
  "../src/agent-session-provider.js";
import { callbackRouteFingerprintForConversation } from
  "../src/callback-route-authority.js";
import { runCliCommandExecution } from "../src/cli-runtime-context.js";
import {
  managedSessionBindingToken,
  terminalBindingFrom,
  type ManagedSessionState
} from
  "../src/managed-session.js";
import {
  CALLBACK_ROUTE_SCHEMA,
  CALLBACK_ROUTE_VERSION,
  type CallbackRouteV1
} from "../src/callback-transport.js";
import { createConversation, resolveExecutor } from "../src/protocol.js";
import { loadManagedSession, saveManagedSession } from
  "../src/session-store.js";
import type { TerminalControlRef } from
  "../src/terminal-agent-adapter.js";
import type { TerminalDispatchLedgerDocument } from
  "../src/terminal-dispatch-ledger-codec.js";
import {
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "../src/terminal-dispatch-receipt.js";
import { fingerprint } from "../src/terminal-submission-facts.js";
import {
  ensureStoreWritable,
  loadState,
  pathsForConversation,
  saveState
} from "../src/store.js";

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

const DETACHED_CLAIM_THREAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DETACHED_CLAIM_NEW_THREAD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DETACHED_CLAIM_PROCESS_UUID = "codex-pid:42:birth:1";
const DETACHED_CLAIM_PROCESS_BIRTH = "1";

function detachedClaimFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-detached-claim-"));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const terminalControl: TerminalControlRef = {
    kind: "tmux",
    target: "claim:0.0",
    session: "claim",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const sourceRollout = {
    fd: "7r", device: "11", inode: "22", path: "/tmp/claim-rollout.jsonl"
  };
  const candidateRollout = { ...sourceRollout, fd: "91r" };
  const acceptedIdentity = {
    sessionId: DETACHED_CLAIM_THREAD,
    processUuid: DETACHED_CLAIM_PROCESS_UUID,
    processBirth: DETACHED_CLAIM_PROCESS_BIRTH,
    rollout: { ...candidateRollout, fd: "92r" },
    evidence: "codex_candidate_set_rollout_acceptance"
  };
  const now = "2026-09-09T00:00:00.000Z";
  const source = saveManagedSession(storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-detached-source",
    agent: "codex",
    workspace: "/workspace/project",
    status: "detached",
    binding: terminalBindingFrom({
      terminalId: "terminal:tmux:claim:0.0:42",
      terminalControl,
      pid: 42,
      nativeThreadId: DETACHED_CLAIM_THREAD,
      processUuid: DETACHED_CLAIM_PROCESS_UUID,
      processBirth: DETACHED_CLAIM_PROCESS_BIRTH,
      rollout: sourceRollout,
      evidence: "codex_rollout_fd",
      generation: 4,
      now: new Date(now)
    }),
    lineage: { created_by: "attach" },
    created_at: now,
    updated_at: now,
    detached_at: now
  }, { expectedRevision: null });
  const target = saveManagedSession(storeDir, {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-provisional-target",
    agent: "codex",
    workspace: "/workspace/project",
    status: "bound",
    binding: terminalBindingFrom({
      terminalId: "terminal:tmux:claim:0.0:42",
      terminalControl,
      pid: 42,
      processUuid: DETACHED_CLAIM_PROCESS_UUID,
      processBirth: DETACHED_CLAIM_PROCESS_BIRTH,
      evidence: "codex_candidate_set_pre_submission",
      generation: 1,
      now: new Date(now)
    }),
    lineage: { created_by: "attach" },
    created_at: now,
    updated_at: now
  }, { expectedRevision: null });
  const anchorBase = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 3 as const,
    process_uuid: DETACHED_CLAIM_PROCESS_UUID,
    process_birth: DETACHED_CLAIM_PROCESS_BIRTH,
    captured_at: now,
    mode: "candidate_set" as const,
    native_thread_binding: "post_submission" as const,
    file_existed: false as const,
    offset_bytes: 0 as const,
    zero_file_baseline: false,
    inventory_pid: 42,
    inventory_cwd: "/workspace/project",
    inventory_fingerprint: "c".repeat(64),
    candidate_rollouts: [{
      native_thread_id: DETACHED_CLAIM_THREAD,
      rollout: candidateRollout,
      offset_bytes: 0
    }]
  };
  const anchor = { ...anchorBase, anchor_fingerprint: fingerprint(anchorBase) };
  const claim = {
    session_id: source.session_id,
    session_revision: source.revision as number,
    session_binding_token: managedSessionBindingToken(source),
    binding_id: source.binding?.binding_id as string,
    binding_generation: source.binding?.generation as number,
    native_thread_id: DETACHED_CLAIM_THREAD,
    process_uuid: DETACHED_CLAIM_PROCESS_UUID,
    process_birth: DETACHED_CLAIM_PROCESS_BIRTH,
    source_rollout: sourceRollout,
    candidate_rollout: candidateRollout
  };
  const claimSetBase = {
    schema: "agent-knock-knock/codex-detached-candidate-session-claims" as const,
    version: 1 as const,
    anchor_fingerprint: anchor.anchor_fingerprint,
    claims: [claim]
  };
  const conversation = {
    ...createConversation({
      userRequest: "continue the detached candidate",
      sessionId: target.session_id,
      turnId: "turn-detached-claim",
      executorKind: "codex",
      workspace: "/workspace/project",
      now: new Date(now)
    }),
    store_dir: path.resolve(storeDir),
    terminal_binding_id: target.binding?.binding_id,
    terminal_binding_generation: target.binding?.generation,
    native_session_takeover: {
      terminal_agent_pid: 42,
      codex_rollout_acceptance_anchor: anchor,
      codex_detached_candidate_session_claims: {
        ...claimSetBase,
        claims_fingerprint: fingerprint(claimSetBase)
      }
    }
  };
  const exclusiveCalls: Array<{
    allowedManagedSessionIds?: string[];
    excludedManagedSessionId: string;
    nativeThreadId: string;
  }> = [];
  const facade = createTerminalAcceptanceCliFacade({
    native: {
      assertExclusive: async (request) => {
        exclusiveCalls.push(request);
      }
    },
    authority: {
      isDiscoverableTurn: () => true,
      workspaceMatches: (configured, observed) =>
        path.resolve(String(configured)) === path.resolve(String(observed)),
      hasUnresolvedTransition: () => false
    }
  } as unknown as TerminalAcceptanceCliDependencies);
  return {
    root, storeDir, terminalControl, source, target, conversation,
    acceptedIdentity, exclusiveCalls, facade
  };
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
    "prepareSessionIdentityClaim",
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
    "loadState(",
    "isExplicitUserAbandonedManagementTurn(current)",
    "terminalBridgeSubmission(current)",
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

test("accepted source-less Codex candidate transfers one unchanged detached claim", async () => {
  const fixture = detachedClaimFixture();
  try {
    const prepare = () => fixture.facade.prepareSessionIdentityClaim({
      options: { storeDir: fixture.storeDir },
      conversation: fixture.conversation,
      terminalControl: fixture.terminalControl,
      identity: fixture.acceptedIdentity,
      storeDir: fixture.storeDir
    });
    await assert.rejects(
      runCliCommandExecution("detached-claim-source-scrub-crash", {}, {
        env: {
          ...process.env,
          AKK_TEST_EXIT_AFTER_DETACHED_SOURCE_SCRUB: "1"
        },
        exit: (code) => {
          throw new Error(`simulated exit ${code}`);
        }
      }, prepare),
      /simulated exit 86/u
    );
    const scrubbed = loadManagedSession(
      fixture.storeDir,
      fixture.source.session_id
    );
    assert.equal(scrubbed.status, "detached");
    assert.equal(scrubbed.revision, (fixture.source.revision as number) + 1);
    assert.equal(scrubbed.binding?.native_thread_id, undefined);
    assert.equal(scrubbed.binding?.native_process.rollout, undefined);
    assert.match(
      String(scrubbed.binding?.native_process.evidence),
      /source_less_candidate_predecessor_binding_scrubbed:session-provisional-target/u
    );
    await prepare();
    const target = fixture.facade.persistSessionIdentity({
      conversation: fixture.conversation,
      terminalControl: fixture.terminalControl,
      identity: fixture.acceptedIdentity,
      storeDir: fixture.storeDir
    });
    assert.equal(target?.binding?.native_thread_id, DETACHED_CLAIM_THREAD);
    assert.deepEqual(target?.binding?.native_process.rollout, {
      fd: "92r",
      device: "11",
      inode: "22",
      path: "/tmp/claim-rollout.jsonl"
    });
    assert.deepEqual(
      fixture.exclusiveCalls.map((call) => call.allowedManagedSessionIds),
      [[fixture.source.session_id], undefined]
    );
    const owners = [
      loadManagedSession(fixture.storeDir, fixture.source.session_id),
      loadManagedSession(fixture.storeDir, fixture.target.session_id)
    ].filter((session) =>
      session.binding?.native_thread_id === DETACHED_CLAIM_THREAD
    );
    assert.deepEqual(owners.map((session) => session.session_id), [
      fixture.target.session_id
    ]);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("an accepted unclaimed Codex root leaves detached candidate owners unchanged", async () => {
  const fixture = detachedClaimFixture();
  try {
    const unclaimedIdentity = {
      ...fixture.acceptedIdentity,
      sessionId: DETACHED_CLAIM_NEW_THREAD,
      rollout: {
        fd: "101r",
        device: "33",
        inode: "44",
        path: "/tmp/unclaimed-rollout.jsonl"
      }
    };
    await fixture.facade.prepareSessionIdentityClaim({
      options: { storeDir: fixture.storeDir },
      conversation: fixture.conversation,
      terminalControl: fixture.terminalControl,
      identity: unclaimedIdentity,
      storeDir: fixture.storeDir
    });
    const target = fixture.facade.persistSessionIdentity({
      conversation: fixture.conversation,
      terminalControl: fixture.terminalControl,
      identity: unclaimedIdentity,
      storeDir: fixture.storeDir
    });
    assert.deepEqual(
      loadManagedSession(fixture.storeDir, fixture.source.session_id),
      fixture.source
    );
    assert.equal(target?.binding?.native_thread_id, DETACHED_CLAIM_NEW_THREAD);
    assert.deepEqual(
      fixture.exclusiveCalls.map((call) => call.allowedManagedSessionIds),
      [undefined]
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("detached claim CAS drift rejects post-Enter ownership without target mutation", async () => {
  const fixture = detachedClaimFixture();
  try {
    const drifted = saveManagedSession(fixture.storeDir, {
      ...fixture.source,
      updated_at: "2026-09-09T00:00:01.000Z"
    }, { expectedRevision: fixture.source.revision as number });
    await assert.rejects(
      fixture.facade.prepareSessionIdentityClaim({
        options: { storeDir: fixture.storeDir },
        conversation: fixture.conversation,
        terminalControl: fixture.terminalControl,
        identity: fixture.acceptedIdentity,
        storeDir: fixture.storeDir
      }),
      /changed after dispatch reservation/u
    );
    assert.deepEqual(
      loadManagedSession(fixture.storeDir, fixture.source.session_id),
      drifted
    );
    assert.equal(
      loadManagedSession(fixture.storeDir, fixture.target.session_id)
        .binding?.native_thread_id,
      undefined
    );
    assert.deepEqual(fixture.exclusiveCalls, []);
    const ownerCommit = fs.readFileSync(
      new URL("../src/terminal-command-cli-adapter.js", import.meta.url),
      "utf8"
    );
    const start = ownerCommit.indexOf(
      "async function resolveTerminalDispatchSubmissionOwner"
    );
    const end = ownerCommit.indexOf(
      "function deferredTerminalInputNotStartedAt",
      start
    );
    const source = ownerCommit.slice(start, end);
    assertOrdered(source, [
      'rawPort("prepareManagedSessionNativeIdentityClaim")',
      "persistManagedSessionNativeIdentity({",
      "catch (error)",
      "bindingError =",
      "application.applyIdentityFailure("
    ]);
    assert.doesNotMatch(source, /retry_submission|sendUserExplicitCodex/u);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("managed Turn creation writes and inherits a generic callback route", () => {
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
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const created = facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-route",
      messageId: "msg-route-1",
      gatewayMethod: "agent-knock-knock.callback",
      gatewaySession: "agent:controller:one",
      openclawSession: "agent:controller:one",
      openclawBin: "/opt/openclaw"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control
  });

  assert.deepEqual(created.conversation.callback_route, {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: "openclaw_gateway_v1",
    profile_id: "legacy-openclaw-cli",
    profile_revision: created.conversation.callback_route?.profile_revision,
    controller_session_id: "agent:controller:one",
    capabilities: { wake: true, respond: true }
  });
  assert.equal(created.conversation.gateway_method, "agent-knock-knock.callback");
  assert.equal(created.conversation.gateway_session, "agent:controller:one");

  const inherited = facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-route",
      messageId: "msg-route-2"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "continue",
    terminalControl: control,
    previousTurn: created.conversation
  });
  assert.deepEqual(
    inherited.conversation.callback_route,
    created.conversation.callback_route
  );
  assert.equal(inherited.conversation.gateway_method, "agent-knock-knock.callback");
  assert.equal(inherited.conversation.gateway_session, "agent:controller:one");
});

test("trusted managed Turn options give an explicit generic route precedence", () => {
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
  const callbackRoute: CallbackRouteV1 = {
    schema: CALLBACK_ROUTE_SCHEMA,
    version: CALLBACK_ROUTE_VERSION,
    transport: "local_ipc_v1",
    profile_id: "trusted-local-controller",
    profile_revision: "revision-1",
    controller_session_id: "controller-local-one",
    capabilities: { wake: true, respond: true }
  };
  const facade = createTerminalAcceptanceCliFacade(
    {} as unknown as TerminalAcceptanceCliDependencies
  );
  const create = (route: CallbackRouteV1) => facade.createManagedTurn({
    options: {
      storeDir: "/tmp/akk-acceptance-generic-route",
      messageId: "msg-generic-route",
      callbackRoute: route,
      gatewayMethod: "legacy.callback",
      gatewaySession: "agent:legacy:controller"
    },
    conversationId: "terminal:tmux:akk:0.0:42",
    agent: "codex",
    pid: 42,
    messageBody: "implement it",
    terminalControl: control
  });

  assert.deepEqual(create(callbackRoute).conversation.callback_route, callbackRoute);
  assert.throws(
    () => create({ ...callbackRoute, version: 99 } as unknown as CallbackRouteV1),
    /unsupported callback_route version 99/u
  );
});

test("user-abandoned deferred acceptance is neutral without terminal I/O", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-accepted-close-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const conversationDir = path.join(storeDir, "conversations", "turn-closed");
  const statePath = path.join(conversationDir, "state.json");
  const logPath = path.join(conversationDir, "events.ndjson");
  const conversation = {
    ...createConversation({
      userRequest: "closed by user",
      sessionId: "session-closed",
      turnId: "turn-closed",
      executorKind: "codex",
      now: new Date("2026-08-15T00:00:00.000Z")
    }),
    status: "closed" as const,
    native_session_takeover: {
      deferred_foreground_transfer_id: "transfer-user-abandoned"
    }
  };
  let terminalReads = 0;
  const facade = createTerminalAcceptanceCliFacade({
    deferred: {
      loadTransfer: () => ({ status: "user_abandoned" })
    }
  } as unknown as TerminalAcceptanceCliDependencies);
  const result = await facade.reconcileMonitor({
    options: {},
    conversation,
    statePath,
    logPath,
    terminalControl: {
      kind: "tmux",
      target: "closed:0.0",
      session: "closed",
      window: 0,
      pane: 0,
      panePid: 42,
      capabilities: []
    },
    executor: resolveExecutor({ kind: "codex" }),
    terminalBridge: {
      async resolveStoredTerminal() {
        terminalReads += 1;
        throw new Error("user-abandoned acceptance must not read terminal");
      }
    } as unknown as TerminalAcceptanceBridge
  });
  assert.equal(result.outcome, "not_accepted");
  assert.equal("conversation" in result && result.conversation, conversation);
  assert.equal(terminalReads, 0);
});

test("monitor restart forwards exact Codex companion fences to the provider", async () => {
  const threadId = "11111111-1111-4111-8111-111111111111";
  const control: TerminalControlRef = {
    kind: "tmux",
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const primary = {
    sessionId: "22222222-2222-4222-8222-222222222222",
    processUuid: "codex-pid:42:birth:1",
    processBirth: "1",
    rollout: {
      fd: "8r",
      device: "1",
      inode: "42",
      path: "/tmp/codex-primary.jsonl"
    }
  };
  const additional = {
    sessionId: "33333333-3333-4333-8333-333333333333",
    processUuid: "codex-pid:42:birth:1",
    processBirth: "1",
    rollout: {
      fd: "9r",
      device: "1",
      inode: "43",
      path: "/tmp/codex-additional.jsonl"
    }
  };
  const anchorBase = {
    schema: "agent-knock-knock/codex-rollout-acceptance-anchor" as const,
    version: 1 as const,
    mode: "pre_materialization" as const,
    native_thread_id: threadId,
    process_uuid: "codex-pid:42:birth:1",
    process_birth: "1",
    captured_at: "2026-08-15T00:00:00.000Z",
    file_existed: false,
    offset_bytes: 0,
    expected_empty_native_session: true as const
  };
  const anchor = {
    ...anchorBase,
    anchor_fingerprint: fingerprint(anchorBase)
  };
  const requestText = "reconcile the exact dispatched request";
  const conversation = {
    ...createConversation({
      userRequest: requestText,
      sessionId: "session-1",
      turnId: "turn-1",
      executorKind: "codex",
      now: new Date("2026-08-15T00:00:00.000Z")
    }),
    status: "waiting_for_agent" as const,
    native_thread_id: threadId,
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-1",
      terminal_bridge_request_text: requestText,
      terminal_bridge_request_hash:
        terminalBridgeRequestFingerprint(requestText),
      terminal_agent_pid: 42,
      codex_rollout_acceptance_anchor: anchor,
      terminal_bridge_submission: {
        status: "enter_dispatched",
        message_id: "message-1",
        prepared_at: "2026-08-15T00:00:00.000Z",
        text_injected_at: "2026-08-15T00:00:01.000Z",
        enter_dispatched_at: "2026-08-15T00:00:02.000Z",
        last_proven_stage: "enter_dispatched"
      }
    }
  };
  let resolverArguments:
    Parameters<CodingAgentSessionProvider["resolveActiveSessionIdentityForPid"]>
      | undefined;
  const provider = {
    agent: "codex",
    resolveActiveSessionIdentityForPid: async (
      ...args: Parameters<
        CodingAgentSessionProvider["resolveActiveSessionIdentityForPid"]
      >
    ) => {
      resolverArguments = args;
      return undefined;
    }
  } as unknown as CodingAgentSessionProvider;
  let runtimeIdentityCalls = 0;
  const facade = createTerminalAcceptanceCliFacade({
    native: {
      codexProvider: () => provider
    },
    terminal: {
      runtimeIdentity: (observedConversation, observedControl) => {
        runtimeIdentityCalls += 1;
        assert.equal(observedConversation, conversation);
        assert.equal(observedControl, control);
        return {
          allowedPreMaterializationNativeIdentity: primary,
          allowedAdditionalNativeIdentities: [additional]
        };
      }
    },
    authority: {
      assertTurnCurrent: () => undefined,
      terminalControl: () => control
    }
  } as unknown as TerminalAcceptanceCliDependencies);
  const result = await facade.reconcileMonitor({
    options: {},
    conversation,
    statePath: "/tmp/akk-monitor-restart/store/conversations/turn-1/state.json",
    logPath: "/tmp/akk-monitor-restart/store/conversations/turn-1/events.ndjson",
    terminalControl: control,
    executor: resolveExecutor({ kind: "codex" }),
    terminalBridge: {
      proveExactDraftStillPresent: async () => false,
      resolveStoredTerminal: async () => {
        throw new Error("bound acceptance must not resolve a deferred terminal");
      }
    }
  });

  assert.equal(result.outcome, "pending");
  assert.equal(runtimeIdentityCalls >= 1, true);
  assert.deepEqual(resolverArguments, [
    42,
    "/workspace/project",
    threadId,
    { ...primary, evidence: "managed_transition_before_identity" },
    [{ ...additional, evidence: "managed_transition_ancestor_identity" }]
  ]);
});

test("acceptance uncertainty cannot revive an explicit Close that wins the Store lock", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "akk-acceptance-close-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storeDir = path.join(root, "store");
  ensureStoreWritable(storeDir);
  const paths = pathsForConversation("turn-close-race", storeDir);
  const submission = {
    message_id: "message-close-race",
    status: "enter_dispatched",
    prepared_at: "2026-08-24T00:00:00.000Z",
    text_injected_at: "2026-08-24T00:00:01.000Z",
    enter_dispatched_at: "2026-08-24T00:00:02.000Z",
    last_proven_stage: "enter_dispatched"
  };
  const stale = {
    ...createConversation({
      userRequest: "finish the task",
      sessionId: "session-close-race",
      turnId: "turn-close-race",
      executorKind: "codex",
      now: new Date("2026-08-24T00:00:00.000Z")
    }),
    status: "waiting_for_agent" as const,
    store_dir: path.resolve(storeDir),
    conversation_dir: path.resolve(paths.conversationDir),
    state_path: path.resolve(paths.statePath),
    event_log_path: path.resolve(paths.logPath),
    native_session_takeover: {
      terminal_bridge: true,
      terminal_bridge_message_id: "message-close-race",
      terminal_bridge_request_text: "finish the task",
      terminal_bridge_submission: submission,
      terminal_bridge_submission_receipts: [submission]
    }
  };
  const closed = {
    ...stale,
    status: "closed" as const,
    disposition: "user_abandoned_management",
    callback_expected: false,
    closed_at: "2026-08-24T00:00:03.000Z",
    close_reason: "closed by request",
    updated_at: "2026-08-24T00:00:03.000Z"
  };
  saveState(paths.statePath, closed);
  const before = fs.readFileSync(paths.statePath);
  let stateLocks = 0;
  let ledgerReads = 0;
  let ledgerWrites = 0;
  let terminalAuthorityReads = 0;
  const facade = createTerminalAcceptanceCliFacade({
    repository: {
      acquireStateLock: () => {
        stateLocks += 1;
        return () => undefined;
      },
      loadLedger: () => {
        ledgerReads += 1;
        return undefined;
      },
      saveLedger: () => { ledgerWrites += 1; }
    },
    authority: {
      terminalControl: () => {
        terminalAuthorityReads += 1;
        return undefined;
      }
    }
  } as unknown as TerminalAcceptanceCliDependencies);

  const raced = facade.markUncertain({
    conversation: stale,
    statePath: paths.statePath,
    logPath: paths.logPath,
    terminalControl: {
      kind: "tmux",
      target: "close-race:0.0",
      session: "close-race",
      window: 0,
      pane: 0,
      panePid: 4242,
      capabilities: []
    },
    reason: "stale acceptance observation"
  });

  assert.deepEqual(raced, loadState(paths.statePath));
  assert.equal(raced.status, "closed");
  assert.equal(raced.disposition, "user_abandoned_management");
  assert.equal(stateLocks, 1);
  assert.equal(ledgerReads, 0);
  assert.equal(ledgerWrites, 0);
  assert.equal(terminalAuthorityReads, 0);
  assert.deepEqual(fs.readFileSync(paths.statePath), before);
  assert.equal(fs.existsSync(paths.logPath), false);

  const outer = facade.markUncertain({
    conversation: raced,
    statePath: paths.statePath,
    logPath: paths.logPath,
    terminalControl: {
      kind: "tmux",
      target: "close-race:0.0",
      session: "close-race",
      window: 0,
      pane: 0,
      panePid: 4242,
      capabilities: []
    },
    reason: "already closed"
  });
  assert.strictEqual(outer, raced);
  assert.equal(stateLocks, 1);
});

test("legacy in-flight acceptance synchronizes callback route authority", async (t) => {
  const control: TerminalControlRef = {
    kind: "tmux",
    target: "akk:0.0",
    session: "akk",
    window: 0,
    pane: 0,
    panePid: 42,
    currentPath: "/workspace/project",
    capabilities: []
  };
  const requestText = "accept the exact legacy in-flight request";
  const requestHash = terminalBridgeRequestFingerprint(requestText) as string;
  const bridge = {
    proveExactDraftStillPresent: async () => false,
    resolveStoredTerminal: async () => {
      throw new Error("deferred resolution is not expected");
    }
  } as TerminalAcceptanceBridge;

  async function runCase(input: {
    name: string;
    routed: boolean;
    ledgerAuthority?: string | null;
    rejects?: boolean;
  }): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `akk-${input.name}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const storeDir = path.join(root, "store");
    ensureStoreWritable(storeDir);
    const conversationDir = path.join(storeDir, "conversations", "turn-1");
    const statePath = path.join(conversationDir, "state.json");
    const logPath = path.join(conversationDir, "events.ndjson");
    fs.mkdirSync(conversationDir, { recursive: true });
    const legacySubmission = {
      status: "enter_dispatched",
      message_id: "message-1",
      prepared_at: "2026-08-15T00:00:00.000Z",
      text_injected_at: "2026-08-15T00:00:01.000Z",
      enter_dispatched_at: "2026-08-15T00:00:02.000Z",
      last_proven_stage: "enter_dispatched"
    };
    const conversation = {
      ...createConversation({
        userRequest: requestText,
        sessionId: "session-1",
        turnId: "turn-1",
        executorKind: "claude",
        now: new Date("2026-08-15T00:00:00.000Z")
      }),
      status: "waiting_for_agent" as const,
      store_dir: storeDir,
      conversation_dir: conversationDir,
      state_path: statePath,
      event_log_path: logPath,
      ...(input.routed
        ? {
            gateway_method: "agent-knock-knock.callback",
            gateway_session: "agent:controller:one"
          }
        : {}),
      native_session_takeover: {
        terminal_bridge: true,
        terminal_bridge_message_id: "message-1",
        terminal_bridge_request_text: requestText,
        terminal_bridge_request_hash: requestHash,
        terminal_agent_expected_session_id: "session-1",
        terminal_bridge_submission: legacySubmission,
        terminal_bridge_submission_receipts: [legacySubmission]
      }
    };
    fs.writeFileSync(
      statePath,
      `${JSON.stringify(conversation, null, 2)}\n`,
      { mode: 0o600 }
    );
    const ledger: TerminalDispatchLedgerDocument = {
      status: "enter_dispatched",
      message_id: "message-1",
      ...(input.ledgerAuthority !== undefined
        ? { callback_route_fingerprint: input.ledgerAuthority }
        : {})
    };
    let savedLedger: TerminalDispatchLedgerDocument | undefined;
    const facade = createTerminalAcceptanceCliFacade({
      native: {
        codexProvider: () => ({}),
        codexProcessIncarnation: () => {
          throw new Error("Codex identity is not expected");
        },
        assertExclusive: async () => undefined
      },
      terminal: {
        runtime: () => ({
          loadClaudeAgentRows: () => [],
          createBridge: () => bridge
        }),
        durableRequest: () => {
          throw new Error("synthetic acceptance must not inspect transcripts");
        },
        runtimeIdentity: () => ({})
      },
      authority: {
        assertTurnCurrent: () => undefined,
        terminalControl: () => control,
        isDiscoverableTurn: () => true,
        workspaceMatches: () => true
      },
      repository: {
        acquireStateLock: () => () => undefined,
        acquireTerminalLock: () => () => undefined,
        loadLedger: () => ledger,
        saveLedger: (_terminalControl, next) => {
          savedLedger = next;
        },
        reconcileLedger: (_terminalControl, current) => current,
        bindingFields: () => ({})
      },
      deferred: {
        recover: async () => {
          throw new Error("deferred recovery is not expected");
        },
        loadAuthority: () => {
          throw new Error("deferred authority is not expected");
        },
        assertLedgerAuthority: () => {
          throw new Error("deferred authority is not expected");
        },
        loadTransfer: () => {
          throw new Error("deferred transfer is not expected");
        }
      }
    } as unknown as TerminalAcceptanceCliDependencies);
    const reconcile = () => facade.reconcileMonitor({
      options: {},
      conversation,
      statePath,
      logPath,
      terminalControl: control,
      executor: resolveExecutor({ kind: "claude" }),
      terminalBridge: bridge
    });
    await runCliCommandExecution(input.name, {}, {
      env: {
        ...process.env,
        AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE: "1",
        AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME: "accepted"
      },
      now: () => new Date("2026-08-15T00:00:03.000Z"),
      pid: process.pid,
      runtimeLog: () => undefined
    }, async () => {
      if (input.rejects) {
        await assert.rejects(
          reconcile,
          /callback route conflicts with its dispatch ledger/u
        );
        assert.equal(
          terminalBridgeSubmission(loadState(statePath))?.status,
          "enter_dispatched"
        );
        assert.equal(savedLedger, undefined);
        return;
      }
      const result = await reconcile();
      assert.equal(result.outcome, "accepted");
      const authority = callbackRouteFingerprintForConversation(conversation) ??
        null;
      assert.equal(
        terminalBridgeSubmission(loadState(statePath))
          ?.callback_route_fingerprint,
        authority
      );
      assert.equal(savedLedger?.callback_route_fingerprint, authority);
    });
  }

  await runCase({ name: "legacy-acceptance-routed", routed: true });
  await runCase({ name: "legacy-acceptance-no-route", routed: false });
  await runCase({
    name: "legacy-acceptance-route-mismatch",
    routed: true,
    ledgerAuthority: `sha256:${"f".repeat(64)}`,
    rejects: true
  });
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

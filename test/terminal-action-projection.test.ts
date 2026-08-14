import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  applySessionAuthorityToDispatch,
  decideTerminalSendAuthority,
  decideTerminalSessionAuthorityConflict,
  managedTurnNeedsAttention,
  selectTerminalAvailableActions,
  type TerminalActionSet,
  type TerminalSendAuthorityFacts
} from "../src/terminal-action-projection.js";
import {
  activeTurnHandoffDecisionToken,
  classifyManagedBindingConflict,
  deferredCodexForegroundBindingToken,
  nativeAgentIdentityMatchesTurn,
  nativeIdentityMatchesStoredTurn,
  processIncarnationRelationship,
  terminalControlAliasMatches,
  terminalControlSelectorKey,
  terminalControlsShareIncarnation,
  verifiedEmptyCodexHandoffToken,
  type StoredTurnNativeIdentityFacts,
  type TerminalNativeIdentity
} from "../src/terminal-authority-policy.js";
import {
  decideTerminalSendAuthority as decideFreshMutationSendAuthority
} from "../src/terminal-dispatch-policy.js";
import {
  classifyTerminalBindingConflict,
  isCompleteNativeRollout
} from "../src/terminal-binding-authority.js";
import {
  managedSessionBindingToken,
  unmanagedTerminalBindingToken,
  type ManagedSessionState
} from "../src/managed-session.js";
import type { CodexOpenRootRolloutInventory } from
  "../src/agent-session-provider.js";
import type { TerminalControlRef } from "../src/terminal-control-ref.js";
import {
  createConversation,
  executorForConversation,
  type Conversation
} from "../src/protocol.js";
import { isRecord, nonBlankString } from "../src/value-guards.js";

const THREAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaa0101";

const control: TerminalControlRef = {
  kind: "tmux",
  target: "work:0.0",
  socketPath: "/tmp/tmux/default",
  session: "work",
  window: 0,
  pane: 0,
  panePid: 4_000,
  currentCommand: "codex",
  currentPath: "/repo",
  capabilities: ["screen_status", "send_keys"]
};

const rollout = {
  fd: "21",
  device: "1",
  inode: "101",
  path: "/repo/source.jsonl"
};

function session(
  overrides: Partial<ManagedSessionState> = {}
): ManagedSessionState {
  return {
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-authority",
    revision: 3,
    agent: "codex",
    workspace: "/repo",
    status: "bound",
    binding: {
      binding_id: "binding-authority",
      generation: 2,
      terminal_id: "terminal:v2:tmux:codex:work:0.0:4100",
      terminal_control: control,
      native_thread_id: THREAD_A,
      native_process: {
        pid: 4_100,
        process_uuid: "codex-pid:4100:birth:12345",
        process_birth: "12345",
        rollout,
        evidence: "codex_rollout_fd"
      },
      bound_at: "2026-08-14T00:00:00.000Z",
      last_verified_at: "2026-08-14T00:00:00.000Z"
    },
    lineage: { created_by: "attach" },
    created_at: "2026-08-14T00:00:00.000Z",
    updated_at: "2026-08-14T00:00:00.000Z",
    ...overrides
  };
}

function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function legacySendAuthority(facts: TerminalSendAuthorityFacts) {
  if (facts.ownership === "current") return { mode: "current" as const };
  const verifiedEmpty = facts.verifiedEmpty ??
    facts.verifiedEmptyToken !== undefined;
  const externalHandoff = facts.externalHandoff ??
    facts.externalToken !== undefined;
  const deferred = facts.deferred ?? facts.deferredToken !== undefined;
  const conflictMode = verifiedEmpty
    ? { mode: "verified_empty" as const, token: facts.verifiedEmptyToken }
    : externalHandoff
      ? { mode: "external_handoff" as const, token: facts.externalToken }
      : deferred
        ? { mode: "deferred" as const, token: facts.deferredToken }
        : undefined;
  if (facts.ownership === "conflict") {
    return conflictMode ?? { mode: "conflict" as const };
  }
  if (deferred) return { mode: "deferred" as const, token: facts.deferredToken };
  return facts.managedSendSessionId
    ? { mode: "managed" as const, sessionId: facts.managedSendSessionId }
    : { mode: "raw" as const };
}

function legacyNativeIdentityMatch(
  facts: StoredTurnNativeIdentityFacts,
  current: TerminalNativeIdentity | undefined
): boolean {
  const strictClaude = facts.strictNativeIdentity && facts.agent === "claude";
  const strictCodex = facts.strictNativeIdentity && facts.agent === "codex";
  if (facts.strictNativeIdentity &&
      (!facts.storedSessionId || !current?.sessionId)) return false;
  if (strictClaude && (!facts.storedProcessUuid ||
      facts.storedProcessUuid !== current?.processUuid)) return false;
  const storedRollout = facts.storedRollout;
  const complete = (value: typeof storedRollout): boolean => Boolean(
    value?.fd && value.device && value.inode && value.path
  );
  if (strictCodex && (!facts.storedProcessUuid ||
      !facts.storedProcessBirth || !complete(storedRollout) ||
      !current?.processUuid || !current.processBirth ||
      !complete(current.rollout))) return false;
  const normalized = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim().length > 0 ? value : undefined;
  const rolloutMatches = !storedRollout || Boolean(current?.rollout &&
    normalized(storedRollout.fd) === normalized(current.rollout.fd) &&
    normalized(storedRollout.device) === normalized(current.rollout.device) &&
    normalized(storedRollout.inode) === normalized(current.rollout.inode) &&
    normalized(storedRollout.path) === normalized(current.rollout.path));
  return (!facts.storedSessionId ||
      facts.storedSessionId === current?.sessionId) &&
    (!facts.storedProcessUuid ||
      facts.storedProcessUuid === current?.processUuid) &&
    (!facts.storedProcessBirth ||
      facts.storedProcessBirth === current?.processBirth) &&
    rolloutMatches;
}

function legacyNativeAgentIdentityMatchesTurn(
  conversation: Conversation,
  currentIdentity: TerminalNativeIdentity | undefined
): boolean {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const sessionId = nonBlankString(takeover?.terminal_agent_session_id);
  const processUuid = nonBlankString(takeover?.terminal_agent_process_uuid);
  const processBirth = nonBlankString(takeover?.terminal_agent_process_birth);
  const rollout = takeover?.terminal_agent_rollout;
  const strict = Number(takeover?.terminal_agent_identity_protocol) === 1;
  const agent = executorForConversation(conversation).kind;
  if (strict && (!sessionId || !currentIdentity?.sessionId)) return false;
  if (
    strict && agent === "claude" &&
    (!processUuid || processUuid !== currentIdentity?.processUuid)
  ) return false;
  if (
    strict && agent === "codex" &&
    (!processUuid || !processBirth || !isCompleteNativeRollout(rollout) ||
      !currentIdentity?.processUuid || !currentIdentity.processBirth ||
      !isCompleteNativeRollout(currentIdentity.rollout))
  ) return false;
  return (!sessionId || sessionId === currentIdentity?.sessionId) &&
    (!processUuid || processUuid === currentIdentity?.processUuid) &&
    (!processBirth || processBirth === currentIdentity?.processBirth) &&
    (!isRecord(rollout) || legacyRolloutFieldsMatch(
      rollout,
      currentIdentity?.rollout
    ));
}

function legacyRolloutFieldsMatch(left: unknown, right: unknown): boolean {
  return isRecord(left) && isRecord(right) &&
    nonBlankString(left.fd) === nonBlankString(right.fd) &&
    nonBlankString(left.device) === nonBlankString(right.device) &&
    nonBlankString(left.inode) === nonBlankString(right.inode) &&
    nonBlankString(left.path) === nonBlankString(right.path);
}

function tracedNativeTurnFixture(input: {
  strict: boolean;
  storedSessionId?: string;
  throwRolloutFields: boolean;
}): { conversation: Conversation; trace: string[] } {
  const trace: string[] = [];
  const conversation = createConversation({
    userRequest: "fixture",
    executorKind: "codex"
  });
  const executor = conversation.executor;
  Object.defineProperty(conversation, "executor", {
    configurable: true,
    enumerable: true,
    get() {
      trace.push("executor");
      return executor;
    }
  });
  const storedRollout: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(rollout)) {
    Object.defineProperty(storedRollout, field, {
      configurable: true,
      enumerable: true,
      get() {
        trace.push(`rollout.${field}`);
        if (input.throwRolloutFields) {
          throw new Error(`rollout field ${field} must stay lazy`);
        }
        return value;
      }
    });
  }
  const takeover: Record<string, unknown> = {};
  const tracedValue = (name: string, value: unknown): PropertyDescriptor => ({
    configurable: true,
    enumerable: true,
    get() {
      trace.push(name);
      return value;
    }
  });
  Object.defineProperties(takeover, {
    terminal_agent_session_id: tracedValue(
      "session",
      input.storedSessionId
    ),
    terminal_agent_process_uuid: tracedValue(
      "process_uuid",
      "codex-pid:4100:birth:12345"
    ),
    terminal_agent_process_birth: tracedValue("process_birth", "12345"),
    terminal_agent_rollout: tracedValue("rollout", storedRollout),
    terminal_agent_identity_protocol: tracedValue(
      "protocol",
      input.strict ? 1 : undefined
    )
  });
  conversation.native_session_takeover = takeover;
  return { conversation, trace };
}

test("list and fresh mutation use one send-authority decision with old key order", () => {
  const fixtures: TerminalSendAuthorityFacts[] = [
    { ownership: "current" },
    {
      ownership: "conflict",
      verifiedEmptyToken: "verified",
      externalToken: "external",
      deferredToken: "deferred"
    },
    {
      ownership: "conflict",
      externalToken: "external",
      deferredToken: "deferred"
    },
    { ownership: "none", deferredToken: "deferred" },
    { ownership: "none", managedSendSessionId: "session-authority" },
    { ownership: "none" }
  ];
  for (const facts of fixtures) {
    const expected = JSON.stringify(legacySendAuthority(facts));
    assert.equal(JSON.stringify(decideTerminalSendAuthority(facts)), expected);
    assert.equal(
      JSON.stringify(decideFreshMutationSendAuthority(facts)),
      expected
    );
  }
});

test("available actions preserve legacy insertion order and approval-last rule", () => {
  const action = (id: string) => ({ id });
  const sessionActions: TerminalActionSet<{ id: string }> = {
    status: action("status"),
    send: action("raw-send"),
    close: action("close")
  };
  const actual = selectTerminalAvailableActions({
    ownership: "conflict",
    currentActions: {},
    sessionAwareRawActions: sessionActions,
    nonOwnerRawActions: sessionActions,
    authoritativeSendAction: action("verified-send"),
    reconcileBindingAction: action("reconcile"),
    terminalScopedApprovalAction: action("approval")
  });
  const legacy = {
    status: action("status"),
    close: action("close"),
    send: action("verified-send"),
    reconcile_binding: action("reconcile"),
    approve: action("approval")
  };
  assert.equal(JSON.stringify(actual), JSON.stringify(legacy));
  assert.deepEqual(Object.keys(actual), Object.keys(legacy));
});

test("Session authority conflict wins without consulting dispatch mismatch", () => {
  const bound = session();
  const conflict = decideTerminalSessionAuthorityConflict({
    unresolvedSessionClaims: [{
      ...bound,
      status: "transitioning",
      last_transition_id: "transition-1"
    }],
    conflictingBoundSessionClaims: [{
      session: bound,
      kind: "live_external_thread_change"
    }],
    matchingSessions: [bound, { ...bound, session_id: "session-second" }]
  });
  assert.equal(conflict?.reason,
    "a first-class managed Session has an unresolved lifecycle binding on this terminal");
  const ownership = applySessionAuthorityToDispatch({
    localOwnership: { state: "none" },
    sessionAuthorityConflict: conflict,
    authoritativeSession: bound,
    dispatchOwnerMismatch: { ownerSessionId: "wrong-owner" }
  });
  assert.equal(ownership.state, "conflict");
  assert.equal(
    ownership.state === "conflict" ? ownership.conflict : undefined,
    conflict
  );
});

test("canonical conflict classifier preserves old precedence and lazy Turn reads", () => {
  const bound = session();
  let turnReads = 0;
  const facts = {
    session: bound,
    processRelationship: "same" as const,
    liveNativeThreadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102",
    statusCardNativeThreadId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102",
    get managedTurnCount(): number {
      turnReads += 1;
      return 0;
    }
  };
  assert.equal(
    classifyManagedBindingConflict(facts),
    classifyTerminalBindingConflict(facts)
  );
  assert.equal(turnReads, 0);
  assert.equal(processIncarnationRelationship({
    binding: bound.binding!,
    livePid: 4_100,
    liveProcessUuid: "codex-pid:4100:birth:12345",
    liveProcessBirth: "12345"
  }), "same");
});

test("attention and stored-native policies preserve legacy results lazily", () => {
  const attentionFixtures = [
    { status: "running", callbackDeliveryStatus: "delivered" },
    { status: "idle", callbackDeliveryStatus: "pending" },
    { status: "failed", callbackDeliveryStatus: "delivered" }
  ];
  for (const facts of attentionFixtures) {
    const legacy = [
      "created", "running", "waiting_for_agent", "waiting_for_openclaw",
      "stalled", "callback_pending", "callback_failed", "cancelling"
    ].includes(facts.status) ||
      ["pending", "failed"].includes(facts.callbackDeliveryStatus);
    assert.equal(managedTurnNeedsAttention(facts), legacy);
  }
  assert.equal(managedTurnNeedsAttention({
    status: "running",
    get callbackDeliveryStatus(): string {
      throw new Error("blocking status must not inspect callback delivery");
    }
  }), true);

  const current: TerminalNativeIdentity = {
    sessionId: THREAD_A,
    processUuid: "codex-pid:4100:birth:12345",
    processBirth: "12345",
    rollout,
    evidence: "fixture"
  };
  const nativeFixtures: StoredTurnNativeIdentityFacts[] = [
    {
      strictNativeIdentity: true,
      agent: "codex",
      storedSessionId: THREAD_A,
      storedProcessUuid: current.processUuid,
      storedProcessBirth: current.processBirth,
      storedRollout: rollout
    },
    {
      strictNativeIdentity: true,
      agent: "claude",
      storedSessionId: THREAD_A,
      storedProcessUuid: "wrong-process"
    },
    {
      strictNativeIdentity: false,
      agent: "codex",
      storedSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102",
      storedRollout: rollout
    },
    {
      strictNativeIdentity: false,
      agent: "codex",
      storedSessionId: THREAD_A,
      storedRollout: {}
    }
  ];
  for (const facts of nativeFixtures) {
    assert.equal(
      nativeIdentityMatchesStoredTurn(facts, current),
      legacyNativeIdentityMatch(facts, current)
    );
  }
  const incompleteRollout: StoredTurnNativeIdentityFacts = {
    strictNativeIdentity: false,
    agent: "codex",
    storedSessionId: THREAD_A,
    storedRollout: {}
  };
  const currentWithoutRollout: TerminalNativeIdentity = {
    sessionId: THREAD_A,
    evidence: "fixture"
  };
  assert.equal(
    nativeIdentityMatchesStoredTurn(incompleteRollout, currentWithoutRollout),
    legacyNativeIdentityMatch(incompleteRollout, currentWithoutRollout)
  );
  const currentWithIncompleteRollout: TerminalNativeIdentity = {
    sessionId: THREAD_A,
    rollout: { fd: "", device: "", inode: "", path: "" },
    evidence: "fixture"
  };
  assert.equal(
    nativeIdentityMatchesStoredTurn(
      incompleteRollout,
      currentWithIncompleteRollout
    ),
    legacyNativeIdentityMatch(
      incompleteRollout,
      currentWithIncompleteRollout
    )
  );
});

test("Turn identity adapter preserves legacy reads and lazy rollout fields", () => {
  const cases = [
    {
      name: "strict missing session",
      strict: true,
      storedSessionId: undefined,
      currentIdentity: undefined,
      throwRolloutFields: true
    },
    {
      name: "non-strict session mismatch",
      strict: false,
      storedSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102",
      currentIdentity: { sessionId: THREAD_A, evidence: "fixture" },
      throwRolloutFields: true
    },
    {
      name: "strict exact identity",
      strict: true,
      storedSessionId: THREAD_A,
      currentIdentity: {
        sessionId: THREAD_A,
        processUuid: "codex-pid:4100:birth:12345",
        processBirth: "12345",
        rollout,
        evidence: "fixture"
      },
      throwRolloutFields: false
    }
  ];
  for (const fixture of cases) {
    const legacy = tracedNativeTurnFixture(fixture);
    const legacyResult = legacyNativeAgentIdentityMatchesTurn(
      legacy.conversation,
      fixture.currentIdentity
    );
    const canonical = tracedNativeTurnFixture(fixture);
    const canonicalResult = nativeAgentIdentityMatchesTurn(
      canonical.conversation,
      fixture.currentIdentity
    );
    assert.deepEqual({
      result: canonicalResult,
      trace: canonical.trace
    }, {
      result: legacyResult,
      trace: legacy.trace
    }, fixture.name);
  }
  const nonStrict = tracedNativeTurnFixture({
    strict: false,
    storedSessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbb0102",
    throwRolloutFields: true
  });
  assert.equal(nativeAgentIdentityMatchesTurn(nonStrict.conversation, {
    sessionId: THREAD_A,
    evidence: "fixture"
  }), false);
  assert.deepEqual(nonStrict.trace, [
    "session",
    "process_uuid",
    "process_birth",
    "rollout",
    "protocol",
    "executor",
    "executor"
  ]);
});

test("selector alias normalization preserves legacy invalid-value equality", () => {
  assert.equal(terminalControlAliasMatches(undefined, control, null, control), true);
  assert.equal(terminalControlAliasMatches(0, control, false, control), true);
  assert.equal(terminalControlAliasMatches("old", control, "new", control), false,
    "noncanonical controls still require the historical alias");
  const arrayControl = Object.assign([], control);
  assert.equal(terminalControlSelectorKey(arrayControl), undefined);
  assert.equal(terminalControlsShareIncarnation(arrayControl, control), false);
  assert.equal(
    terminalControlAliasMatches("same", arrayControl, "same", control),
    false
  );
});

test("authority token hashes preserve exact legacy JSON field order", () => {
  const source = session();
  const terminalToken = unmanagedTerminalBindingToken({
    terminalId: "terminal:v2:tmux:codex:work:0.0:4100",
    terminalControl: control,
    agent: "codex",
    pid: 4_100,
    workspace: "/repo",
    processUuid: "codex-pid:4100:birth:12345",
    processBirth: "12345"
  });
  const common = {
    terminalId: "terminal:v2:tmux:codex:work:0.0:4100",
    terminalControl: control,
    pid: 4_100,
    workspace: "/repo",
    processUuid: "codex-pid:4100:birth:12345",
    processBirth: "12345",
    sourceSession: source
  };
  assert.equal(verifiedEmptyCodexHandoffToken(common), hash({
    version: 1,
    kind: "verified_empty_codex_handoff",
    terminal_token: terminalToken,
    source_session_id: source.session_id,
    source_revision: 3,
    source_binding_token: managedSessionBindingToken(source),
    observation: "verified_absent"
  }));
  const dispatchSnapshot = { status: "none" as const, fingerprint: "none" };
  assert.equal(deferredCodexForegroundBindingToken({
    ...common,
    dispatchSnapshot
  }), hash({
    version: 2,
    kind: "deferred_codex_foreground_binding",
    terminal_token: terminalToken,
    composer_state: "styled_empty",
    source_session_id: source.session_id,
    source_revision: 3,
    source_binding_token: managedSessionBindingToken(source),
    terminal_dispatch_snapshot: dispatchSnapshot,
    observation: "verified_absent"
  }));
  const candidateInventory: CodexOpenRootRolloutInventory = {
    schema: "agent-knock-knock/codex-open-root-rollout-inventory",
    version: 1,
    status: "resolved",
    pid: 4_100,
    cwd: "/repo",
    processUuid: "codex-pid:4100:birth:12345",
    processBirth: "12345",
    inventoryFingerprint: "a".repeat(64),
    roots: [{
      sessionId: THREAD_A,
      processUuid: "codex-pid:4100:birth:12345",
      processBirth: "12345",
      rollout,
      evidence: "codex_open_root_rollout"
    }]
  };
  assert.equal(deferredCodexForegroundBindingToken({
    ...common,
    dispatchSnapshot,
    candidateInventory
  }), hash({
    version: 5,
    kind: "deferred_codex_foreground_binding",
    terminal_token: terminalToken,
    composer_state: "styled_empty",
    source_session_id: source.session_id,
    source_revision: 3,
    source_binding_token: managedSessionBindingToken(source),
    terminal_dispatch_snapshot: dispatchSnapshot,
    observation: "exact_open_root_inventory",
    source_rollout_authority: "present",
    inventory_pid: 4_100,
    inventory_cwd: "/repo",
    inventory_fingerprint: "a".repeat(64),
    candidate_native_thread_ids: [THREAD_A]
  }));
  const handoffFacts = {
    handoffToken: "handoff-token",
    sessionId: source.session_id,
    turnId: "turn-1",
    turnStatus: "waiting_for_agent",
    turnUpdatedAt: "2026-08-14T00:00:01.000Z",
    currentMessageId: "message-1",
    ledgerGenerationId: "generation-1",
    ledgerMessageId: "message-1",
    ledgerStatus: "agent_accepted"
  };
  assert.equal(activeTurnHandoffDecisionToken(handoffFacts), hash({
    version: 1,
    kind: "active_turn_human_handoff",
    handoff_token: handoffFacts.handoffToken,
    session_id: handoffFacts.sessionId,
    turn_id: handoffFacts.turnId,
    turn_status: handoffFacts.turnStatus,
    turn_updated_at: handoffFacts.turnUpdatedAt,
    current_message_id: handoffFacts.currentMessageId,
    ledger_generation_id: handoffFacts.ledgerGenerationId,
    ledger_message_id: handoffFacts.ledgerMessageId,
    ledger_status: handoffFacts.ledgerStatus
  }));
});

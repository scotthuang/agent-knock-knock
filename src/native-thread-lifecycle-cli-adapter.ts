import fs from "node:fs";
import path from "node:path";

import { createClaudeThreadLifecycleCandidateProvider } from
  "./claude-local-transcript-provider.js";
import { codexLifecycleBehaviorProfile } from
  "./codex-lifecycle-compatibility.js";
import { expandHome } from "./cli-command-runtime.js";
import type { ExecutorKind } from "./executors.js";
import type { FileLockAcquisitionOptions } from "./file-lock-cli-adapter.js";
import {
  isExactNativeThreadId,
  legacyManagedSessionBindingToken,
  legacyUnmanagedTerminalBindingToken,
  managedSessionBindingToken,
  unmanagedTerminalBindingToken,
  type ManagedSessionState,
  type NativeThreadCandidate
} from "./managed-session.js";
import {
  assertNativeThreadHasExclusiveOwnership as assertExclusiveFromQuery,
  previousCommittedResumeCandidate,
  resumableNativeThreadCandidates,
  type LifecycleTerminalObservation,
  type NativeThreadLifecycleQueryPorts
} from "./native-thread-lifecycle-query-service.js";
import { codexComposerEmpty } from
  "./native-thread-lifecycle-recovery-adapter.js";
import {
  createNativeThreadResumeSnapshot,
  saveNativeThreadResumeSnapshot
} from "./native-thread-resume-snapshot.js";
import { terminalActionFingerprint } from
  "./native-thread-resume-snapshot-policy.js";
import { turnIdForConversation, type Conversation } from "./protocol.js";
import {
  listManagedSessions,
  loadNativeThreadTransition
} from "./session-store.js";
import type {
  ActiveTerminalProcess,
  TerminalAgentAdapter,
  TerminalControlRef,
  TerminalNativeInspectionObservation,
  TerminalNativeInspectionObservationRequest,
  TerminalNativeInspectionPlan,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleCapabilities
} from "./terminal-agent-adapter.js";
import {
  isExactClaudeNativeInspectionIdleComposer,
  NativeInspectionSubmissionError,
  type ResolvedTerminalConversation,
  type TerminalAgentBridge,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import {
  terminalControlAliasMatches,
  selectRootTerminalProcesses,
  withCodexCompanionFences,
  type CodexAllowedCompanionSet
} from "./terminal-authority-policy.js";
import type { TerminalNativeIdentity } from
  "./terminal-binding-authority.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import type { TerminalRuntimeCliAdapter } from
  "./terminal-runtime-cli-adapter.js";
import { nonBlankString } from "./value-guards.js";

export type NativeLifecycleCliOptions = Readonly<Record<string, unknown>>;

export interface NativeLifecycleSnapshot {
  readonly identity?: TerminalNativeIdentity;
  readonly runtimeIdentity?: TerminalNativeIdentity;
  readonly codexCompanions: CodexAllowedCompanionSet;
  readonly session?: ManagedSessionState;
  readonly version?: string;
  readonly capabilities: TerminalThreadLifecycleCapabilities;
  readonly bindingToken: string;
  readonly bindingTokens: readonly string[];
}

interface NativeLifecycleIdentityPorts {
  resolveCurrent(input: {
    options: NativeLifecycleCliOptions;
    agent: ExecutorKind;
    pid: number;
    cwd?: string;
    preferredSessionId?: string;
    allowedCompanionIdentity?: CodexAllowedCompanionSet["primary"];
    allowedAdditionalIdentities?: readonly NonNullable<
      CodexAllowedCompanionSet["primary"]
    >[];
  }): Promise<TerminalNativeIdentity | undefined>;
  managedContext(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
  }): {
    preferredSessionId?: string;
    companions: CodexAllowedCompanionSet;
  };
  boundSession(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState | undefined;
  materializeSession(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState | undefined;
  refineSession(input: {
    storeDir: string;
    session: ManagedSessionState;
    terminalControl: TerminalControlRef;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState;
  logicalIdentity(input: {
    storeDir: string;
    session: ManagedSessionState;
    observedIdentity?: TerminalNativeIdentity;
  }): TerminalNativeIdentity | undefined;
  companionSet(input: {
    storeDir: string;
    session: ManagedSessionState;
  }): CodexAllowedCompanionSet;
  processIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
  runtimeForLiveIdentity(input: {
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  ownerIsInactive(input: {
    session: ManagedSessionState;
    terminal: LifecycleTerminalObservation;
    identity?: TerminalNativeIdentity;
  }): boolean;
  assertCodexComposerReady(input: {
    options: NativeLifecycleCliOptions;
    terminalControl: TerminalControlRef;
  }): Promise<void>;
}

interface NativeLifecycleStatePorts {
  storeDir(options: NativeLifecycleCliOptions): string;
  inspectStore(storeDir: string): { writable: boolean };
  runtimeDir(): string;
  acquireTerminal(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  loadLedger(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  managedTurns(storeDir: string, sessionId: string): readonly Conversation[];
  terminalBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): readonly Conversation[];
  hasUnresolvedTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  dispatchOwnership(terminalControl: TerminalControlRef): { state: string };
  assertNativeThreadStoreAuthority(input: {
    terminalControl: TerminalControlRef;
    nativeThreadId: string;
    storeDir: string;
  }): void;
  orphanedForRecovery(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
}

export interface CreateNativeThreadLifecycleCliAdapterInput {
  runtime: {
    forOptions(options: NativeLifecycleCliOptions): TerminalRuntimeCliAdapter;
    sleep(milliseconds: number): Promise<void>;
  };
  identity: NativeLifecycleIdentityPorts;
  state: NativeLifecycleStatePorts;
  terminalList: {
    isBlockingStatus(status: Conversation["status"]): boolean;
  };
  output: {
    cwd(): string;
    print(value: unknown): void;
  };
}

export interface NativeThreadOwnershipRequest {
  options: NativeLifecycleCliOptions;
  agent: ExecutorKind;
  currentPid: number;
  nativeThreadId: string;
  storeDir: string;
  terminalControl: TerminalControlRef;
  excludedManagedSessionId?: string;
  allowedManagedSessionIds?: string[];
}

export interface NativeThreadLifecycleCliFacade {
  resolveLifecycleTerminal(options: NativeLifecycleCliOptions):
    Promise<ResolvedTerminalConversation>;
  queryPorts(options: NativeLifecycleCliOptions): NativeThreadLifecycleQueryPorts;
  assertExclusive(input: NativeThreadOwnershipRequest): Promise<void>;
  currentSnapshot(
    options: NativeLifecycleCliOptions,
    terminal: ResolvedTerminalConversation,
    settings?: { materialize?: boolean }
  ): Promise<NativeLifecycleSnapshot>;
  lifecycleBindingTokens(input: {
    session?: ManagedSessionState;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): readonly string[];
  agentAdapter(
    options: NativeLifecycleCliOptions,
    agent: ExecutorKind
  ): TerminalAgentAdapter;
  runList(options: NativeLifecycleCliOptions): Promise<void>;
  runInspect(options: NativeLifecycleCliOptions): Promise<void>;
  assertSameInspectionTerminal(
    expected: ResolvedTerminalConversation,
    actual: ResolvedTerminalConversation,
    stage: string
  ): void;
  codexLatentClearResumeObservation(input: {
    screen?: string;
    agentVersion?: string;
  }): { sourceNativeThreadId: string; fingerprint: string } | undefined;
  nativeInspectionComposerEmpty(agent: ExecutorKind, screen?: string): boolean;
}

export function createNativeThreadLifecycleCliAdapter(
  ports: CreateNativeThreadLifecycleCliAdapterInput
): NativeThreadLifecycleCliFacade {
  const app = new NativeThreadLifecycleCliApplication(ports);
  return Object.freeze({
    resolveLifecycleTerminal: (options) => app.resolveLifecycleTerminal(options),
    queryPorts: (options) => app.queryPorts(options),
    assertExclusive: (input) => app.assertExclusive(input),
    currentSnapshot: (options, terminal, settings) =>
      app.currentSnapshot(options, terminal, settings),
    lifecycleBindingTokens: (input) => app.lifecycleBindingTokens(input),
    agentAdapter: (options, agent) => app.agentAdapter(options, agent),
    runList: (options) => app.runList(options),
    runInspect: (options) => app.runInspect(options),
    assertSameInspectionTerminal: (expected, actual, stage) =>
      app.assertSameInspectionTerminal(expected, actual, stage),
    codexLatentClearResumeObservation,
    nativeInspectionComposerEmpty
  });
}

class NativeThreadLifecycleCliApplication {
  constructor(readonly ports: CreateNativeThreadLifecycleCliAdapterInput) {}

  agentAdapter(
    options: NativeLifecycleCliOptions,
    agent: ExecutorKind
  ): TerminalAgentAdapter {
    return this.ports.runtime.forOptions(options).createAgentRegistry().require(agent);
  }

  async resolveLifecycleTerminal(
    options: NativeLifecycleCliOptions
  ): Promise<ResolvedTerminalConversation> {
    const terminalId = required(
      nonBlankString(options.terminal ?? options.conversation ?? options.conversationId),
      "--terminal is required"
    );
    const terminal = await this.ports.runtime.forOptions(options)
      .createBridge().resolveConversationId(terminalId);
    if (!terminal || terminal.conversationId !== terminalId) {
      throw new Error(
        "native thread lifecycle requires the exact terminal_id returned by AKK list"
      );
    }
    return terminal;
  }

  lifecycleBindingTokens(input: {
    session?: ManagedSessionState;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): readonly string[] {
    const { session, terminal, identity } = input;
    const current = this.lifecycleBindingToken(input);
    const incarnation = terminal.agent === "codex" && !identity
      ? this.ports.identity.processIncarnation(terminal.pid)
      : undefined;
    const tokenInput = {
      terminalId: terminal.conversationId,
      terminalControl: terminal.terminalControl,
      agent: terminal.agent,
      pid: terminal.pid,
      workspace: terminal.terminalControl.currentPath ?? this.ports.output.cwd(),
      nativeThreadId: identity?.sessionId,
      processUuid: identity?.processUuid ?? incarnation?.processUuid,
      processBirth: identity?.processBirth ?? incarnation?.processBirth,
      rollout: identity?.rollout
    };
    const legacy = session
      ? legacyManagedSessionBindingToken(session)
      : legacyUnmanagedTerminalBindingToken(tokenInput);
    return [...new Set([current, legacy])];
  }

  lifecycleBindingToken(input: {
    session?: ManagedSessionState;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): string {
    if (input.session) return managedSessionBindingToken(input.session);
    const incarnation = input.terminal.agent === "codex" && !input.identity
      ? this.ports.identity.processIncarnation(input.terminal.pid)
      : undefined;
    return unmanagedTerminalBindingToken({
      terminalId: input.terminal.conversationId,
      terminalControl: input.terminal.terminalControl,
      agent: input.terminal.agent,
      pid: input.terminal.pid,
      workspace: input.terminal.terminalControl.currentPath ??
        this.ports.output.cwd(),
      nativeThreadId: input.identity?.sessionId,
      processUuid: input.identity?.processUuid ?? incarnation?.processUuid,
      processBirth: input.identity?.processBirth ?? incarnation?.processBirth,
      rollout: input.identity?.rollout
    });
  }

  queryPorts(options: NativeLifecycleCliOptions): NativeThreadLifecycleQueryPorts {
    let resolvedStoreDir: string | undefined;
    const storeDir = () => resolvedStoreDir ??=
      this.ports.state.storeDir(options);
    return Object.freeze({
      cwd: this.ports.output.cwd,
      listManagedSessions: () => listManagedSessions(storeDir()),
      loadNativeThreadTransition: (id) => loadNativeThreadTransition(storeDir(), id),
      blockingTurns: (sessionId) => this.ports.state
        .managedTurns(storeDir(), sessionId)
        .filter((turn) => this.ports.terminalList.isBlockingStatus(turn.status))
        .map((turn) => ({ turnId: turnIdForConversation(turn), status: turn.status })),
      assertStoreAuthority: (terminalControl, nativeThreadId) =>
        this.ports.state.assertNativeThreadStoreAuthority({
          terminalControl, nativeThreadId, storeDir: storeDir()
        }),
      runningVersion: (terminal) => this.ports.runtime.forOptions(options)
        .agentVersionForRunningProcess(terminal.agent, terminal.pid),
      candidateProvider: (agent) => agent === "codex"
        ? this.ports.runtime.forOptions(options)
            .createThreadLifecycleCandidateProvider(agent)
        : createClaudeThreadLifecycleCandidateProvider({
            claudeHome: expandHome(nonBlankString(options.claudeHome))
          }),
      sessionOwnerIsConclusivelyInactive: (session, terminal, identity) =>
        this.ports.identity.ownerIsInactive({ session, terminal, identity }),
      rootActiveProcesses: (agent) => this.rootActiveProcesses(options, agent),
      resolveProcessIdentity: (agent, pid, cwd) =>
        this.ports.identity.resolveCurrent({ options, agent, pid, cwd }),
      loadClaudeAgentRows: () => this.ports.runtime.forOptions(options)
        .loadClaudeAgentRows({ required: true }),
      workspaceRelationship: verifiedWorkspaceRelationship
    });
  }

  async rootActiveProcesses(
    options: NativeLifecycleCliOptions,
    agent: ExecutorKind
  ): Promise<readonly ActiveTerminalProcess[]> {
    const runtime = this.ports.runtime.forOptions(options);
    const adapter = runtime.createAgentRegistry().require(agent);
    const snapshots = await runtime.createProcessSource().listProcessSnapshots(
      (snapshot) => adapter.classifyProcess(snapshot) !== undefined,
      { includeCwd: true, includeAncestors: true }
    );
    const processes = snapshots.flatMap((snapshot): ActiveTerminalProcess[] => {
      const classified = adapter.classifyProcess(snapshot);
      return classified ? [{ ...classified, agent }] : [];
    });
    return selectRootTerminalProcesses(processes);
  }

  async assertExclusive(input: NativeThreadOwnershipRequest): Promise<void> {
    await assertExclusiveFromQuery({
      terminalControl: input.terminalControl,
      agent: input.agent,
      currentPid: input.currentPid,
      nativeThreadId: input.nativeThreadId,
      excludedManagedSessionId: input.excludedManagedSessionId,
      allowedManagedSessionIds: input.allowedManagedSessionIds
    }, this.queryPorts({ ...input.options, storeDir: input.storeDir }));
  }

  async currentSnapshot(
    options: NativeLifecycleCliOptions,
    terminal: ResolvedTerminalConversation,
    { materialize = false }: { materialize?: boolean } = {}
  ): Promise<NativeLifecycleSnapshot> {
    const storeDir = this.ports.state.storeDir(options);
    const context = terminal.agent === "codex"
      ? this.ports.identity.managedContext({ storeDir, terminal })
      : undefined;
    const claimedCompanions = context?.companions ?? { additional: [] };
    const observedIdentity = await this.ports.identity.resolveCurrent({
      options, agent: terminal.agent, pid: terminal.pid,
      cwd: terminal.terminalControl.currentPath,
      preferredSessionId: context?.preferredSessionId,
      allowedCompanionIdentity: claimedCompanions.primary,
      allowedAdditionalIdentities: claimedCompanions.additional
    });
    const initialSession = materialize
      ? this.ports.identity.materializeSession({ options, terminal,
          identity: observedIdentity })
      : this.ports.identity.boundSession({ storeDir, terminal,
          identity: observedIdentity });
    const resolved = this.resolveSnapshotIdentity({
      storeDir, terminal, observedIdentity, session: initialSession, materialize
    });
    const codexCompanions = terminal.agent === "codex" && resolved.session
      ? this.ports.identity.companionSet({
          storeDir, session: resolved.session
        })
      : claimedCompanions;
    if (materialize && resolved.identity?.sessionId) {
      await this.assertExclusive({
        options, agent: terminal.agent, currentPid: terminal.pid,
        nativeThreadId: resolved.identity.sessionId, storeDir,
        terminalControl: terminal.terminalControl,
        excludedManagedSessionId: resolved.session?.session_id
      });
    }
    return this.snapshotFacts({
      options, terminal, observedIdentity, session: resolved.session,
      identity: resolved.identity, codexCompanions
    });
  }

  resolveSnapshotIdentity(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
    observedIdentity?: TerminalNativeIdentity;
    session?: ManagedSessionState;
    materialize: boolean;
  }): { session?: ManagedSessionState; identity?: TerminalNativeIdentity } {
    let session = input.session;
    let identity = session ? this.ports.identity.logicalIdentity({
      storeDir: input.storeDir, session, observedIdentity: input.observedIdentity
    }) : input.observedIdentity;
    if (input.materialize && session) {
      session = this.ports.identity.refineSession({
        storeDir: input.storeDir, session,
        terminalControl: input.terminal.terminalControl, identity
      });
      identity = this.ports.identity.logicalIdentity({
        storeDir: input.storeDir, session, observedIdentity: input.observedIdentity
      });
    }
    return { session, identity };
  }

  snapshotFacts(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    observedIdentity?: TerminalNativeIdentity;
    session?: ManagedSessionState;
    identity?: TerminalNativeIdentity;
    codexCompanions: CodexAllowedCompanionSet;
  }): NativeLifecycleSnapshot {
    const version = this.ports.runtime.forOptions(input.options)
      .agentVersionForRunningProcess(input.terminal.agent, input.terminal.pid);
    const adapter = this.agentAdapter(input.options, input.terminal.agent);
    const capabilities = adapter.probeThreadLifecycle?.(version) ?? {
      status: "unsupported", agentVersion: version, newThread: false,
      resumeExact: false,
      reason: `${adapter.displayName} has no native-thread lifecycle adapter`
    } as const;
    const bindingTokens = this.lifecycleBindingTokens({
      session: input.session, terminal: input.terminal, identity: input.identity
    });
    return Object.freeze({
      identity: input.identity, runtimeIdentity: input.observedIdentity,
      codexCompanions: input.codexCompanions,
      session: input.session, version, capabilities,
      bindingToken: bindingTokens[0], bindingTokens
    });
  }

  async runList(options: NativeLifecycleCliOptions): Promise<void> {
    const terminal = await this.resolveLifecycleTerminal(options);
    const snapshot = await this.currentSnapshot(options, terminal);
    if (snapshot.capabilities.status !== "supported" ||
        snapshot.capabilities.resumeExact !== true) {
      throw new Error(snapshot.capabilities.reason);
    }
    const queryPorts = this.queryPorts(options);
    const candidates = await resumableNativeThreadCandidates({
      terminal, currentIdentity: snapshot.identity
    }, queryPorts);
    const storeDir = this.ports.state.storeDir(options);
    const workspace = path.resolve(
      terminal.terminalControl.currentPath ?? this.ports.output.cwd()
    );
    const resumeSnapshot = createNativeThreadResumeSnapshot({
      storeDir,
      selectionScope: nonBlankString(options.selectionScope) ?? "cli:unscoped",
      terminalId: terminal.conversationId,
      agent: terminal.agent,
      workspace,
      terminalControl: terminal.terminalControl,
      currentSessionId: snapshot.session?.session_id,
      currentNativeThreadId: snapshot.identity?.sessionId ??
        snapshot.session?.binding?.native_thread_id,
      expectedBindingToken: snapshot.bindingToken,
      terminalActionFingerprint: terminalActionFingerprint(
        this.ports.state.loadLedger(terminal.terminalControl)
      ),
      candidates
    });
    saveNativeThreadResumeSnapshot(
      this.ports.state.runtimeDir(), storeDir, resumeSnapshot
    );
    const previous = previousCommittedResumeCandidate({
      terminal, currentSession: snapshot.session, candidates
    }, this.queryPorts({ ...options, storeDir }));
    this.ports.output.print(this.listResult({
      terminal, snapshot, candidates, resumeSnapshot, previous, workspace
    }));
  }

  listResult(input: {
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
    candidates: NativeThreadCandidate[];
    resumeSnapshot: ReturnType<typeof createNativeThreadResumeSnapshot>;
    previous?: NativeThreadCandidate;
    workspace: string;
  }): unknown {
    const rows = new Map(input.resumeSnapshot.rows.map(
      (row) => [row.native_thread_id, row]
    ));
    const action = (candidate: NativeThreadCandidate) => ({
      tool: "agent_knock_knock_resume_thread",
      arguments: {
        terminal_id: input.terminal.conversationId,
        native_thread_id: candidate.native_thread_id,
        expected_binding_token: input.snapshot.bindingToken,
        ...(candidate.candidate_token
          ? { candidate_token: candidate.candidate_token }
          : {})
      },
      requires_user_intent: true
    });
    const previousRow = input.previous
      ? rows.get(input.previous.native_thread_id)
      : undefined;
    return {
      terminal_id: input.terminal.conversationId,
      agent: input.terminal.agent,
      workspace: input.workspace,
      current_session_id: input.snapshot.session?.session_id ?? null,
      current_native_thread_id: input.snapshot.identity?.sessionId ??
        input.snapshot.session?.binding?.native_thread_id ?? null,
      expected_binding_token: input.snapshot.bindingToken,
      capability: input.snapshot.capabilities,
      selection_snapshot: {
        schema: input.resumeSnapshot.schema,
        version: input.resumeSnapshot.version,
        snapshot_id: input.resumeSnapshot.snapshot_id,
        created_at: input.resumeSnapshot.created_at,
        expires_at: input.resumeSnapshot.expires_at,
        scope: "exact selection snapshot, scope, and terminal",
        display_only: true
      },
      ...(input.previous && previousRow ? { previous: {
        keyword: "previous",
        native_thread_id: input.previous.native_thread_id,
        selection_number: previousRow.selection_number,
        short_id: previousRow.short_id,
        selection_handle: previousRow.selection_handle,
        available_actions: { resume_thread: action(input.previous) }
      } } : {}),
      threads: input.candidates.map((candidate) => ({
        ...candidate,
        selection_number: rows.get(candidate.native_thread_id)?.selection_number,
        short_id: rows.get(candidate.native_thread_id)?.short_id,
        selection_handle: rows.get(candidate.native_thread_id)?.selection_handle,
        selection_scope: "current_snapshot",
        available_actions: candidate.resumable
          ? { resume_thread: action(candidate) }
          : {}
      }))
    };
  }

  assertSameInspectionTerminal(
    expected: ResolvedTerminalConversation,
    actual: ResolvedTerminalConversation,
    stage: string
  ): void {
    const expectedPath = expected.terminalControl.currentPath;
    const actualPath = actual.terminalControl.currentPath;
    if (
      actual.agent !== expected.agent || actual.pid !== expected.pid ||
      !terminalControlAliasMatches(
        expected.conversationId, expected.terminalControl,
        actual.conversationId, actual.terminalControl
      ) || !expectedPath || !actualPath ||
      path.resolve(actualPath) !== path.resolve(expectedPath)
    ) {
      throw new Error(
        `terminal identity, pane, or cwd changed ${stage}; refresh AKK list`
      );
    }
  }

  assertInspectionReady(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    terminalStatus?: TerminalBridgeStatus;
    session?: ManagedSessionState;
  }): void {
    const { options, terminal, terminalStatus, session } = input;
    if (terminalStatus && (
      terminalStatus.reachable !== true ||
      terminalStatus.activity_state !== "idle" ||
      terminalStatus.approval_state.blocked === true
    )) {
      throw new Error(
        `terminal ${terminal.terminalControl.target} is not at a verified idle prompt ` +
        `(${terminalStatus.activity_state}: ${terminalStatus.activity_reason})`
      );
    }
    const storeDir = this.ports.state.storeDir(options);
    const blocker = this.ports.state.terminalBlockingTurns(
      storeDir, terminal.terminalControl
    )[0];
    if (blocker) {
      throw new Error(
        `terminal ${terminal.terminalControl.target} still has unresolved Turn ` +
        `${turnIdForConversation(blocker)} (${blocker.status})`
      );
    }
    if (session && this.ports.state.hasUnresolvedTransition(storeDir, session)) {
      throw new Error(
        `managed Session ${session.session_id} has an unresolved native-thread transition`
      );
    }
    if (this.ports.state.dispatchOwnership(terminal.terminalControl).state !== "none") {
      throw new Error(
        `terminal ${terminal.terminalControl.target} has unresolved dispatch ` +
        "ownership; resolve it before native inspection"
      );
    }
    const orphaned = this.ports.state.orphanedForRecovery(terminal.terminalControl);
    if (orphaned) {
      throw new Error(
        `terminal ${terminal.terminalControl.target} has unresolved ` +
        `${String(orphaned.kind ?? "terminal")} input ` +
        `(${String(orphaned.status ?? "unknown")})`
      );
    }
  }

  inspectionRuntime(
    terminal: ResolvedTerminalConversation,
    snapshot: NativeLifecycleSnapshot
  ): TerminalRuntimeIdentity {
    if (terminal.agent === "claude") {
      const identity = snapshot.runtimeIdentity;
      if (!identity?.sessionId || !identity.processUuid ||
          identity.sessionId !== snapshot.identity?.sessionId) {
        throw new Error(
          "Claude native status inspection requires one exact claude agents Session and process incarnation"
        );
      }
      return {
        ...this.ports.identity.runtimeForLiveIdentity({ terminal, identity }),
        requireExactClaudeAgentRow: true,
        nativeProcessStartedAt: identity.processStartedAt,
        exactClaudeAgentState: "idle"
      };
    }
    const exactIdentity = snapshot.runtimeIdentity?.sessionId ===
      snapshot.identity?.sessionId ? snapshot.runtimeIdentity : undefined;
    const runtime = exactIdentity
      ? this.ports.identity.runtimeForLiveIdentity({ terminal,
          identity: exactIdentity })
      : {
          ...this.ports.identity.runtimeForLiveIdentity({
            terminal, expectedEmptyNativeSession: true
          }),
          ...(snapshot.identity?.processUuid
            ? { nativeProcessUuid: snapshot.identity.processUuid } : {}),
          ...(snapshot.identity?.processBirth
            ? { nativeProcessBirth: snapshot.identity.processBirth } : {}),
          ...(snapshot.identity?.sessionId
            ? { expectedNativeSessionId: snapshot.identity.sessionId } : {})
        };
    return withCodexCompanionFences(runtime, snapshot.codexCompanions);
  }

  assertInspectionAgentIdentity(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
    stage: string;
    expectedClaudeState?: "idle" | "status_dialog";
  }): void {
    const { options, terminal, snapshot, stage } = input;
    if (terminal.agent !== "claude") return;
    const identity = snapshot.runtimeIdentity;
    if (!identity?.sessionId || !identity.processUuid ||
        !Number.isSafeInteger(identity.processStartedAt) ||
        Number(identity.processStartedAt) <= 0) {
      throw new Error(
        `Claude process identity is incomplete ${stage}; refresh AKK list`
      );
    }
    const runtime = this.ports.runtime.forOptions(options);
    const agentRows = runtime.loadClaudeAgentRows({ required: true });
    const observation = runtime.createAgentRegistry().require("claude")
      .observeThreadLifecycle?.({
        operation: { kind: "new_thread" }, phase: "before", pid: terminal.pid,
        processStartedAt: identity.processStartedAt,
        cwd: terminal.terminalControl.currentPath, agentRows
      });
    const exactRows = agentRows.filter((row) => row.pid === terminal.pid);
    const stateMatches = (input.expectedClaudeState ?? "idle") === "idle"
      ? observation?.idle === true
      : observation?.idle === false && exactRows.length === 1 &&
        exactRows[0].status === "waiting" &&
        exactRows[0].waitingFor === "dialog open";
    if (observation?.status !== "observed" || !stateMatches ||
        observation.nativeThreadId !== identity.sessionId) {
      throw new Error(
        `Claude agents identity, cwd, or idle state changed ${stage}; refresh AKK list`
      );
    }
  }

  assertInspectionSnapshotUnchanged(input: {
    options: NativeLifecycleCliOptions;
    expectedTerminal: ResolvedTerminalConversation;
    actualTerminal: ResolvedTerminalConversation;
    expectedBindingToken: string;
    expectedVersion?: string;
    actualSnapshot: NativeLifecycleSnapshot;
    stage: string;
    expectedClaudeState?: "idle" | "status_dialog";
  }): void {
    this.assertSameInspectionTerminal(
      input.expectedTerminal, input.actualTerminal, input.stage
    );
    if (!input.actualSnapshot.bindingTokens.includes(input.expectedBindingToken)) {
      throw new Error(
        `terminal binding changed ${input.stage}; refresh AKK list`
      );
    }
    if (input.actualSnapshot.version !== input.expectedVersion) {
      throw new Error(
        `coding-agent version changed ${input.stage}; refresh AKK list`
      );
    }
    const capability = this.agentAdapter(
      input.options, input.actualTerminal.agent
    ).probeNativeInspection?.(input.actualSnapshot.version);
    if (capability?.status !== "supported" ||
        capability.statusInspection !== true) {
      throw new Error(capability?.reason ??
        "native status inspection became unsupported; refresh AKK list");
    }
    this.assertInspectionAgentIdentity({
      options: input.options, terminal: input.actualTerminal,
      snapshot: input.actualSnapshot, stage: input.stage,
      expectedClaudeState: input.expectedClaudeState
    });
  }

  async assertInspectionExclusive(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    snapshot: NativeLifecycleSnapshot;
  }): Promise<void> {
    if (input.terminal.agent !== "claude") return;
    const nativeThreadId = input.snapshot.identity?.sessionId ??
      input.snapshot.session?.binding?.native_thread_id;
    if (!isExactNativeThreadId(nativeThreadId)) {
      throw new Error(
        "native status inspection requires one exact current native Session identity"
      );
    }
    await this.assertExclusive({
      options: input.options, agent: input.terminal.agent,
      currentPid: input.terminal.pid, nativeThreadId,
      storeDir: this.ports.state.storeDir(input.options),
      terminalControl: input.terminal.terminalControl,
      excludedManagedSessionId: input.snapshot.session?.session_id
    });
  }

  async assertInspectionComposerReady(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
  }): Promise<void> {
    if (input.terminal.agent === "codex") {
      await this.ports.identity.assertCodexComposerReady({
        options: input.options,
        terminalControl: input.terminal.terminalControl
      });
      return;
    }
    const provider = this.ports.runtime.forOptions(input.options)
      .createControlProvider();
    const resolved = await provider.resolve(
      provider.endpoint(input.terminal.terminalControl)
    );
    const screen = await provider.capture(resolved, { scrollbackLines: 40 });
    if (!isExactClaudeNativeInspectionIdleComposer(screen)) {
      throw new Error(
        "Claude composer contains input or is not at the exact idle frame; refusing automated terminal input"
      );
    }
  }

  validateInspectionOptions(options: NativeLifecycleCliOptions): string {
    const inspection = required(
      nonBlankString(options.inspection), "--inspection is required"
    );
    if (inspection !== "status") {
      throw new Error(
        "--inspection must be the closed value status; arbitrary native slash commands are not accepted"
      );
    }
    if (options.command !== undefined || options.message !== undefined) {
      throw new Error(
        "native inspection does not accept a command or message payload"
      );
    }
    return required(
      nonBlankString(options.expectedBindingToken),
      "--expected-binding-token is required"
    );
  }

  async runInspect(options: NativeLifecycleCliOptions): Promise<void> {
    const expectedBindingToken = this.validateInspectionOptions(options);
    const storeDir = this.ports.state.storeDir(options);
    if (this.ports.state.inspectStore(storeDir).writable !== true) {
      throw new Error(
        "native inspection requires a compatible AKK Store so binding authority can be verified"
      );
    }
    const initiallyResolved = await this.resolveLifecycleTerminal(options);
    const bridge = this.ports.runtime.forOptions(options).createBridge();
    const release = this.ports.state.acquireTerminal(
      storeDir, initiallyResolved.terminalControl, { timeoutMs: 30000 }
    );
    try {
      const context = await this.prepareInspection({
        options, initiallyResolved, expectedBindingToken, bridge
      });
      const submission = await this.submitInspection(context);
      try {
        const observed = await this.observeStableInspection(context, submission);
        const dismissal = await this.dismissInspection(context, observed);
        await this.finalizeInspection(context, observed, submission, dismissal);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (/do not retry automatically/iu.test(detail)) throw error;
        throw new Error(
          "native status inspection Enter was dispatched exactly once, but its " +
          `postcondition became uncertain; do not retry automatically: ${detail}`
        );
      }
    } finally {
      release();
    }
  }

  async prepareInspection(input: {
    options: NativeLifecycleCliOptions;
    initiallyResolved: ResolvedTerminalConversation;
    expectedBindingToken: string;
    bridge: TerminalAgentBridge;
  }): Promise<NativeInspectionContext> {
    const runtimeFacade = this.ports.runtime.forOptions(input.options);
    const bridge = input.bridge;
    const initial = input.initiallyResolved;
    const terminal = await bridge.resolveStoredTerminal(
      initial.agent, initial.pid, initial.terminalControl, { pid: initial.pid }
    );
    this.assertSameInspectionTerminal(
      initial, terminal, "while waiting for native-inspection control"
    );
    const snapshot = await this.currentSnapshot(input.options, terminal);
    if (!snapshot.bindingTokens.includes(input.expectedBindingToken)) {
      throw new Error(
        "terminal binding changed after it was listed; refresh AKK list and retry"
      );
    }
    const adapter = runtimeFacade.createAgentRegistry().require(terminal.agent);
    const capability = adapter.probeNativeInspection?.(snapshot.version);
    if (capability?.status !== "supported" ||
        capability.statusInspection !== true) {
      throw new Error(capability?.reason ??
        "native status inspection is unavailable for this agent version");
    }
    const plan = adapter.planNativeInspection?.({ kind: "status" }, capability);
    if (!plan || plan.operation.kind !== "status" || plan.command !== "/status" ||
        plan.effect !== "read_only") {
      throw new Error(
        "the agent adapter did not produce the closed native status inspection plan"
      );
    }
    const inspectionRuntime = await this.assertInitialInspectionReady(
      input.options, terminal, snapshot, bridge
    );
    return {
      options: input.options, terminal, snapshot, bridge, plan,
      runtime: inspectionRuntime,
      expectedBindingToken: input.expectedBindingToken
    };
  }

  async assertInitialInspectionReady(
    options: NativeLifecycleCliOptions,
    terminal: ResolvedTerminalConversation,
    snapshot: NativeLifecycleSnapshot,
    bridge: TerminalAgentBridge
  ): Promise<TerminalRuntimeIdentity> {
    this.assertInspectionAgentIdentity({
      options, terminal, snapshot, stage: "before native status inspection"
    });
    await this.assertInspectionExclusive({ options, terminal, snapshot });
    const runtime = this.inspectionRuntime(terminal, snapshot);
    const status = await bridge.status(
      terminal.agent, terminal.terminalControl, { runtime }
    );
    this.assertInspectionReady({
      options, terminal, terminalStatus: status, session: snapshot.session
    });
    await this.assertInspectionComposerReady({ options, terminal });
    return runtime;
  }

  async submitInspection(
    context: NativeInspectionContext
  ): Promise<NativeInspectionSubmission> {
    try {
      return await context.bridge.submitNativeInspection(
        context.terminal.agent,
        context.terminal.terminalControl,
        context.plan,
        {
          runtime: context.runtime,
          beforeEnter: async () => {
            const terminal = await context.bridge.resolveStoredTerminal(
              context.terminal.agent,
              context.terminal.pid,
              context.terminal.terminalControl,
              context.runtime
            );
            await this.assertFreshInspectionBoundary({
              context, terminal,
              stage: "immediately before native status submission"
            });
          }
        }
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (error instanceof NativeInspectionSubmissionError &&
          error.doNotRetry !== true) {
        throw new Error(
          `native status inspection did not start; refresh AKK list and retry if still desired: ${detail}`
        );
      }
      throw new Error(
        "native status inspection did not cross a proven completion boundary; " +
        `do not retry automatically: ${detail}`
      );
    }
  }

  async assertFreshInspectionBoundary(input: {
    context: NativeInspectionContext;
    terminal: ResolvedTerminalConversation;
    stage: string;
    expectedClaudeState?: "idle" | "status_dialog";
    assertReady?: boolean;
  }): Promise<NativeLifecycleSnapshot> {
    const snapshot = await this.currentSnapshot(
      input.context.options, input.terminal
    );
    this.assertInspectionSnapshotUnchanged({
      options: input.context.options,
      expectedTerminal: input.context.terminal,
      actualTerminal: input.terminal,
      expectedBindingToken: input.context.expectedBindingToken,
      expectedVersion: input.context.snapshot.version,
      actualSnapshot: snapshot,
      stage: input.stage,
      expectedClaudeState: input.expectedClaudeState
    });
    await this.assertInspectionExclusive({
      options: input.context.options,
      terminal: input.terminal,
      snapshot
    });
    if (input.assertReady !== false) {
      this.assertInspectionReady({
        options: input.context.options,
        terminal: input.terminal,
        session: snapshot.session
      });
    }
    return snapshot;
  }

  async observeStableInspection(
    context: NativeInspectionContext,
    submission: NativeInspectionSubmission
  ): Promise<NativeInspectionObservationResult> {
    const expectedNativeThreadId =
      context.snapshot.session?.binding?.native_thread_id ??
      context.snapshot.identity?.sessionId;
    const request: TerminalNativeInspectionObservationRequest = {
      operation: context.plan.operation,
      previousScreenFingerprint: submission.preEnterScreenDigest,
      preEnterEvidenceInventory: submission.preEnterEvidenceInventory,
      expectedNativeThreadId,
      expectedAgentVersion: context.snapshot.version,
      expectedCwd: context.terminal.terminalControl.currentPath
    };
    const postEnterRuntime: TerminalRuntimeIdentity =
      context.plan.expectedResult.presentation === "modal"
        ? { ...context.runtime, exactClaudeAgentState: "status_dialog" }
        : context.runtime;
    let fingerprint: string | undefined;
    let stable: TerminalNativeInspectionObservation | undefined;
    let count = 0;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const observed = await context.bridge.observeNativeInspection(
        context.terminal.agent, context.terminal.terminalControl, request,
        { runtime: postEnterRuntime, scrollbackLines: 240 }
      );
      if (freshInspectionObservation(
        context.plan, submission.preEnterScreenDigest, observed
      )) {
        if (fingerprint === observed.observation.evidenceFingerprint) count += 1;
        else {
          fingerprint = observed.observation.evidenceFingerprint;
          count = 1;
        }
        stable = observed.observation;
        if (count >= 2) break;
      } else {
        fingerprint = undefined;
        stable = undefined;
        count = 0;
      }
      await this.ports.runtime.sleep(100);
    }
    if (!stable || count < 2) {
      throw new Error(
        "native status inspection Enter was dispatched exactly once, but a fresh exact status result was not proven; do not retry automatically"
      );
    }
    return { observation: stable, request, postEnterRuntime };
  }

  async dismissInspection(
    context: NativeInspectionContext,
    observed: NativeInspectionObservationResult
  ): Promise<NativeInspectionDismissal | undefined> {
    if (context.plan.expectedResult.presentation !== "modal") return undefined;
    const fingerprint = observed.observation.evidenceFingerprint;
    if (!fingerprint) {
      throw new Error(
        "native status modal lacks exact dismissal evidence; do not retry automatically"
      );
    }
    let dismissal: NativeInspectionDismissal;
    try {
      dismissal = await context.bridge.dismissNativeInspection(
        context.terminal.agent, context.terminal.terminalControl,
        context.plan, observed.request, fingerprint,
        {
          runtime: observed.postEnterRuntime,
          scrollbackLines: 240,
          beforeDismiss: async () => {
            const terminal = await context.bridge.resolveStoredTerminal(
              context.terminal.agent, context.terminal.pid,
              context.terminal.terminalControl, observed.postEnterRuntime
            );
            await this.assertFreshInspectionBoundary({
              context, terminal,
              stage: "immediately before native status dismissal",
              expectedClaudeState: "status_dialog"
            });
          }
        }
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        "native status panel was proven but safe dismissal failed; " +
        `do not retry automatically and dismiss it manually if still visible: ${detail}`
      );
    }
    await this.assertInspectionRestoredIdle(context);
    return dismissal;
  }

  async assertInspectionRestoredIdle(
    context: NativeInspectionContext
  ): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const status = await context.bridge.status(
        context.terminal.agent, context.terminal.terminalControl,
        { runtime: context.runtime }
      );
      if (status.reachable === true && status.activity_state === "idle" &&
          status.approval_state.blocked !== true &&
          nativeInspectionComposerEmpty(
            context.terminal.agent, status.screen.excerpt
          )) return;
      await this.ports.runtime.sleep(100);
    }
    throw new Error(
      "Claude Status panel dismissal was dispatched exactly once, but the original idle composer was not restored; do not retry automatically"
    );
  }

  async finalizeInspection(
    context: NativeInspectionContext,
    observed: NativeInspectionObservationResult,
    submission: NativeInspectionSubmission,
    dismissal?: NativeInspectionDismissal
  ): Promise<void> {
    const terminal = await context.bridge.resolveStoredTerminal(
      context.terminal.agent, context.terminal.pid,
      context.terminal.terminalControl, context.runtime
    );
    const snapshot = await this.assertFreshInspectionBoundary({
      context, terminal, stage: "after native status inspection",
      assertReady: false
    });
    const status = await context.bridge.status(
      terminal.agent, terminal.terminalControl, { runtime: context.runtime }
    );
    this.assertInspectionReady({
      options: context.options, terminal, terminalStatus: status,
      session: snapshot.session
    });
    await this.assertInspectionComposerReady({
      options: context.options, terminal
    });
    this.ports.output.print({
      status: "observed",
      inspection: "status",
      terminal_id: context.terminal.conversationId,
      agent: context.terminal.agent,
      agent_version: context.snapshot.version,
      behavior_profile: context.plan.behaviorProfile,
      native_thread_id: observed.observation.nativeThreadId,
      native_status: observed.observation.result,
      terminal_submission: {
        command: context.plan.command,
        enter_count: submission.enterCount,
        materialization: submission.materialization
      },
      ...(dismissal ? { terminal_dismissal: {
        keys: dismissal.keys,
        dismiss_count: dismissal.dismissCount,
        restored_idle: true
      } } : {}),
      store_mutation: false,
      session_created: false,
      turn_created: false,
      receipt_created: false,
      monitor_created: false,
      callback_created: false
    });
  }
}

type NativeInspectionSubmission = Awaited<ReturnType<
  TerminalAgentBridge["submitNativeInspection"]
>>;
type NativeInspectionDismissal = Awaited<ReturnType<
  TerminalAgentBridge["dismissNativeInspection"]
>>;

interface NativeInspectionContext {
  options: NativeLifecycleCliOptions;
  terminal: ResolvedTerminalConversation;
  snapshot: NativeLifecycleSnapshot;
  bridge: TerminalAgentBridge;
  plan: TerminalNativeInspectionPlan;
  runtime: TerminalRuntimeIdentity;
  expectedBindingToken: string;
}

interface NativeInspectionObservationResult {
  observation: TerminalNativeInspectionObservation;
  request: TerminalNativeInspectionObservationRequest;
  postEnterRuntime: TerminalRuntimeIdentity;
}

function freshInspectionObservation(
  plan: TerminalNativeInspectionPlan,
  preEnterScreenDigest: string,
  observed: Awaited<ReturnType<TerminalAgentBridge["observeNativeInspection"]>>
): boolean {
  return observed.status.reachable === true &&
    (plan.expectedResult.presentation === "inline"
      ? observed.status.activity_state === "idle"
      : !["working", "awaiting_approval"].includes(
          observed.status.activity_state
        )) &&
    observed.status.approval_state.blocked !== true &&
    observed.screenDigest !== preEnterScreenDigest &&
    observed.observation.status === "observed" &&
    observed.observation.result?.kind === "native_status" &&
    isExactNativeThreadId(observed.observation.nativeThreadId) &&
    Boolean(observed.observation.evidenceFingerprint);
}

function verifiedWorkspaceRelationship(
  targetWorkspace: unknown,
  candidateWorkspace: unknown
): "same" | "different" | "unknown" {
  const target = nonBlankString(targetWorkspace);
  const candidate = nonBlankString(candidateWorkspace);
  if (!target || !candidate || !path.isAbsolute(target) ||
      !path.isAbsolute(candidate)) return "unknown";
  try {
    const targetReal = fs.realpathSync(target);
    const candidateReal = fs.realpathSync(candidate);
    if (!fs.statSync(targetReal).isDirectory() ||
        !fs.statSync(candidateReal).isDirectory()) return "unknown";
    return targetReal === candidateReal ? "same" : "different";
  } catch {
    return "unknown";
  }
}

function codexLatentClearResumeObservation(input: {
  screen?: string;
  agentVersion?: string;
}): { sourceNativeThreadId: string; fingerprint: string } | undefined {
  const behaviorProfile = codexLifecycleBehaviorProfile(input.agentVersion);
  if (!behaviorProfile) return undefined;
  const clean = (line: string): string => line.replace(
    /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/gu, ""
  );
  const prefix = /^\s*To continue this session, run codex resume\s+(.+?)\s*$/iu;
  const uuid = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;
  const lines = String(input.screen ?? "").split(/\r?\n/u).slice(-24).map(clean);
  const ids: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = prefix.exec(lines[index]);
    if (!match) continue;
    const first = match[1].replace(/\s+/gu, "");
    const fragments = [first, ...(first.endsWith("-")
      ? [`${match[1]}${lines[index + 1] ?? ""}`.replace(/\s+/gu, "")]
      : [])];
    const id = fragments.flatMap((candidate) => {
      const exact = uuid.exec(candidate);
      return exact ? [exact[1].toLowerCase()] : [];
    })[0];
    if (id) ids.push(id);
  }
  const sourceNativeThreadId = ids.at(-1);
  return sourceNativeThreadId ? {
    sourceNativeThreadId,
    fingerprint: terminalActionFingerprint({
      kind: "codex_latent_clear_resume_hint",
      behavior_profile: behaviorProfile,
      source_native_thread_id: sourceNativeThreadId
    })
  } : undefined;
}

function nativeInspectionComposerEmpty(
  agent: ExecutorKind,
  screen?: string
): boolean {
  return agent === "codex"
    ? codexComposerEmpty(screen)
    : isExactClaudeNativeInspectionIdleComposer(String(screen ?? ""));
}

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined || value === "") throw new Error(message);
  return value;
}

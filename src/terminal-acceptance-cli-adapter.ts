// CLI infrastructure for native acceptance and managed Turn persistence.
import path from "node:path";

import type {
  ActiveAgentSessionIdentity,
  CodexOpenRootRolloutInventory,
  CodingAgentSessionProvider
} from "./agent-session-provider.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  detectClaudeTranscriptAcceptance
} from "./claude-local-transcript-provider.js";
import {
  applyMessageToConversation,
  createConversation,
  createMessage,
  executorForConversation,
  resolveExecutor,
  sessionIdForConversation,
  type AgentMessage,
  type Conversation,
  type Executor,
  type MessageType
} from "./protocol.js";
import type { ExecutorKind } from "./executors.js";
import {
  isExactNativeThreadId,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import {
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import {
  appendEvent,
  defaultStoreDir,
  listConversations,
  loadState,
  pathsForConversation,
  pathsForConversationDir,
  saveState,
  withStoreWriterLease,
  withStoreWriterLeaseAsync
} from "./store.js";
import type {
  TerminalControlRef,
  TerminalDurableCompletionRequest,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence
} from "./terminal-control-ref.js";
import {
  exactRolloutMatches,
  isCompleteNativeRollout,
  type TerminalNativeIdentityFence,
  type TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import {
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";
import {
  validTerminalMonitorTimestampMs
} from "./terminal-monitor-decision-policy.js";
import type { TerminalDispatchTerminal } from
  "./terminal-dispatch-composition.js";
import {
  TerminalDispatchExecutionService,
  assertManagedSessionCanStartTurnPolicy,
  managedTurnMatchesTerminal,
  type NativeAgentSessionIdentityObservation,
  type NativeIdentityResolutionRequest
} from "./terminal-dispatch-execution.js";
import {
  applyTerminalBridgeSubmission,
  terminalBridgeRequestFingerprint,
  terminalBridgeSubmission
} from "./terminal-dispatch-receipt.js";
import {
  captureCodexRolloutAcceptanceAnchor,
  detectCodexCandidateSetRolloutAcceptance,
  detectCodexRolloutAcceptance,
  type CodexRolloutAcceptanceAnchor,
  type TerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-acceptance.js";
import {
  TerminalAcceptanceApplicationService,
  type TerminalAcceptanceResolution,
  type TerminalAcceptanceTurnFacts,
  type VirginBindingRecoveryState
} from "./terminal-acceptance-application-service.js";
import {
  ManagedTurnRecoveryService,
  isCurrentVirginCodexRecoveryBoundary,
  isVirginCodexRecoveryCandidate,
  type VirginCodexRecoveryFacts
} from "./managed-turn-recovery-service.js";
import type {
  DeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import {
  cliCwd,
  cliEnv,
  cliNow,
  cliNowMs,
  cliPid,
  cliRuntimeLog,
  cliSleep
} from "./cli-runtime-context.js";
import {
  expandHome,
  resolveOptionalExecutable
} from "./cli-command-runtime.js";
import {
  isRecord,
  nonBlankString
} from "./value-guards.js";
import {
  compareManagedConversationRecency
} from "./terminal-action-projection.js";
import type { FileLockAcquisitionOptions } from
  "./file-lock-cli-adapter.js";

export interface TerminalAcceptanceCliOptions {
  claudeHome?: string;
  gatewayMethod?: string;
  gatewaySession?: string;
  gatewayUrl?: string;
  hardLimit?: number | string;
  logDir?: string;
  messageId?: string;
  openclawBin?: string;
  openclawSession?: string;
  scrollbackLines?: number | string;
  softLimit?: number | string;
  storeDir?: string;
  type?: string;
  [option: string]: unknown;
}

export interface TerminalAcceptanceBridge {
  proveExactDraftStillPresent(
    executor: ExecutorKind,
    terminalControl: TerminalControlRef,
    requestText: string,
    options: {
      scrollbackLines: number;
      runtime: TerminalRuntimeIdentity;
    }
  ): Promise<boolean>;
  resolveStoredTerminal(
    agent: "codex",
    pid: number,
    terminalControl: TerminalControlRef,
    expected: { pid: number }
  ): Promise<TerminalDispatchTerminal>;
}

interface ManagedTerminalTurn {
  conversation: Conversation;
  nextConversation: Conversation;
  statePath: string;
  logPath: string;
  executor: Executor;
  message: AgentMessage;
}

interface DeferredTurnAuthority {
  conversation: Conversation;
  statePath: string;
  submission: { message_body_hash?: unknown };
}

interface TerminalAcceptanceRepositoryPorts {
  acquireStateLock(
    lockPath: string,
    options?: FileLockAcquisitionOptions
  ): () => void;
  acquireTerminalLock(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  loadLedger(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  saveLedger(
    terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument
  ): void;
  reconcileLedger(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined;
  bindingFields(conversation: Conversation): Partial<TerminalDispatchLedgerDocument>;
}

export interface TerminalAcceptanceCliDependencies {
  native: {
    codexProvider(options: TerminalAcceptanceCliOptions): CodingAgentSessionProvider;
    codexProcessIncarnation(pid: number): {
      processUuid: string;
      processBirth: string;
    };
    assertExclusive(input: {
      options: TerminalAcceptanceCliOptions;
      agent: "codex";
      currentPid: number;
      nativeThreadId: string;
      storeDir: string;
      terminalControl: TerminalControlRef;
      excludedManagedSessionId: string;
    }): Promise<void>;
  };
  terminal: {
    runtime(options: TerminalAcceptanceCliOptions): {
      loadClaudeAgentRows(
        observation?: { required?: boolean }
      ): readonly ClaudeAgentRow[];
      createBridge(): TerminalAcceptanceBridge;
    };
    durableRequest(
      conversation: Conversation,
      terminalControl: TerminalControlRef
    ): TerminalDurableCompletionRequest;
    runtimeIdentity(
      conversation: Conversation,
      terminalControl: TerminalControlRef
    ): TerminalRuntimeIdentity;
  };
  authority: {
    assertTurnCurrent(conversation: Conversation, operation: string): void;
    terminalControl(value: unknown): TerminalControlRef | undefined;
    isDiscoverableTurn(conversation: Conversation): boolean;
    workspaceMatches(configured: unknown, observed: unknown): boolean;
    isSessionBlockingStatus(status: Conversation["status"]): boolean;
  };
  repository: TerminalAcceptanceRepositoryPorts;
  deferred: {
    isFinal(status: string): boolean;
    recover(input: {
      options: TerminalAcceptanceCliOptions;
      terminal: TerminalDispatchTerminal;
    }): Promise<void>;
    loadAuthority(input: {
      storeDir: string;
      terminal: TerminalDispatchTerminal;
      transfer: DeferredForegroundTransfer;
    }): DeferredTurnAuthority;
    assertLedgerAuthority(input: {
      storeDir: string;
      terminal: Pick<TerminalDispatchTerminal, "terminalControl">;
      transfer: DeferredForegroundTransfer;
      ledger: TerminalDispatchLedgerDocument;
      statePath: string;
      expectedMessageBodyHash?: string;
    }): void;
    loadTransfer(storeDir: string, transferId: string): DeferredForegroundTransfer;
  };
}

export interface TerminalAcceptanceCliFacade {
  execution(
    options: TerminalAcceptanceCliOptions,
    bridge?: TerminalAcceptanceBridge
  ): TerminalDispatchExecutionService;
  recoverVirgin(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalLockHeld?: boolean;
  }): Promise<{ conversation: Conversation; state: VirginBindingRecoveryState }>;
  reconcileMonitor(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalControl: TerminalControlRef;
    executor: Executor;
    terminalBridge: TerminalAcceptanceBridge;
  }): Promise<
    | { outcome: "accepted"; conversation: Conversation }
    | { outcome: "pending" }
    | { outcome: "not_accepted"; conversation: Conversation }
  >;
  markUncertain(input: {
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalControl: TerminalControlRef;
    reason: string;
  }): Conversation;
  inspectCodexOpenRoots(input: {
    options: TerminalAcceptanceCliOptions;
    pid: number;
    cwd?: string;
  }): Promise<CodexOpenRootRolloutInventory>;
  resolveNativeIdentity(
    request: NativeIdentityResolutionRequest & {
      options: TerminalAcceptanceCliOptions;
    }
  ): Promise<TerminalNativeIdentity | undefined>;
  observeNativeIdentity(
    request: NativeIdentityResolutionRequest & {
      options: TerminalAcceptanceCliOptions;
    }
  ): Promise<NativeAgentSessionIdentityObservation>;
  assertTurnIdentity(input: {
    conversation: Conversation;
    currentIdentity: TerminalNativeIdentity | undefined;
    operation: string;
  }): void;
  withNativeIdentity(
    conversation: Conversation,
    identity: TerminalNativeIdentity
  ): Conversation;
  storeDirForConversation(conversation: Conversation): string | undefined;
  refineSessionIdentity(input: {
    storeDir: string;
    session: ManagedSessionState;
    terminalControl: TerminalControlRef;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState;
  persistSessionIdentity(input: {
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    identity: TerminalNativeIdentity;
    storeDir: string;
  }): ManagedSessionState | undefined;
  quarantineSession(input: {
    conversation: Conversation;
    reason: string;
    storeDir: string;
  }): void;
  turnsForSession(storeDir: string, sessionId: string): Conversation[];
  assertSessionCanStartTurn(turns: Conversation[]): void;
  turnMatchesTerminal(input: {
    conversation: Conversation;
    terminal: TerminalDispatchTerminal;
    currentIdentity?: TerminalNativeIdentity;
  }): boolean;
  createManagedTurn(input: {
    options: TerminalAcceptanceCliOptions;
    conversationId: string;
    agent: ExecutorKind;
    pid: number;
    messageBody: string;
    terminalControl: TerminalControlRef;
    previousTurn?: Conversation;
    managedSession?: ManagedSessionState;
    nativeAgentIdentity?: TerminalNativeIdentity;
    deferredForegroundTransferId?: string;
  }): ManagedTerminalTurn;
}

/** Factory-scoped CLI composition; it retains no mutable module runtime. */
export function createTerminalAcceptanceCliFacade(
  dependencies: TerminalAcceptanceCliDependencies
): TerminalAcceptanceCliFacade {
  const application = new TerminalAcceptanceCliApplication(dependencies);
  return Object.freeze({
    execution: (options, bridge) => application.execution(options, bridge),
    recoverVirgin: (input) => application.recoverVirgin(input),
    reconcileMonitor: (input) => application.reconcileMonitor(input),
    markUncertain: (input) => application.markUncertain(input),
    inspectCodexOpenRoots: (input) => application.inspectCodexOpenRoots(input),
    resolveNativeIdentity: (input) => application.resolveNativeIdentity(input),
    observeNativeIdentity: (input) => application.observeNativeIdentity(input),
    assertTurnIdentity: (input) => application.assertTurnIdentity(input),
    withNativeIdentity: (conversation, identity) =>
      application.withNativeIdentity(conversation, identity),
    storeDirForConversation: (conversation) =>
      application.storeDirForConversation(conversation),
    refineSessionIdentity: (input) => application.refineSessionIdentity(input),
    persistSessionIdentity: (input) => application.persistSessionIdentity(input),
    quarantineSession: (input) => application.quarantineSession(input),
    turnsForSession: (storeDir, sessionId) =>
      application.turnsForSession(storeDir, sessionId),
    assertSessionCanStartTurn: (turns) =>
      application.assertSessionCanStartTurn(turns),
    turnMatchesTerminal: (input) => application.turnMatchesTerminal(input),
    createManagedTurn: (input) => application.createManagedTurn(input)
  });
}

class TerminalAcceptanceCliApplication {
  readonly #dependencies: TerminalAcceptanceCliDependencies;

  constructor(dependencies: TerminalAcceptanceCliDependencies) {
    this.#dependencies = dependencies;
  }

  execution(
    options: TerminalAcceptanceCliOptions,
    bridge?: TerminalAcceptanceBridge
  ): TerminalDispatchExecutionService {
    const provider = (): CodingAgentSessionProvider =>
      this.#dependencies.native.codexProvider(options);
    let currentRuntime: ReturnType<
      TerminalAcceptanceCliDependencies["terminal"]["runtime"]
    > | undefined;
    const runtime = () => currentRuntime ??=
      this.#dependencies.terminal.runtime(options);
    return new TerminalDispatchExecutionService(
      cliEnv().AKK_TEST_ALLOW_SYNTHETIC_TERMINAL_ACCEPTANCE === "1"
        ? cliEnv().AKK_TEST_TERMINAL_ACCEPTANCE_OUTCOME ?? "accepted"
        : undefined,
      {
        clock: { now: cliNow, nowMs: cliNowMs, sleep: cliSleep },
        native: {
          resolveCodex: (request) => provider().resolveActiveSessionIdentityForPid(
            request.pid,
            request.cwd,
            request.preferredSessionId,
            request.allowedCompanionIdentity
              ? companionIdentity(
                  request.allowedCompanionIdentity,
                  "managed_transition_before_identity"
                )
              : undefined,
            request.allowedAdditionalIdentities?.map((identity) =>
              companionIdentity(
                identity,
                "managed_transition_ancestor_identity"
              )
            )
          ),
          inspectCodexOpenRoots: async (pid, cwd) => {
            const currentProvider = provider();
            const inspect = currentProvider.inspectOpenRootRolloutInventoryForPid;
            if (!inspect) {
              throw new Error(
                "Codex open-root rollout inventory inspection is unavailable"
              );
            }
            return inspect.call(currentProvider, pid, cwd);
          },
          claudeRows: () => runtime().loadClaudeAgentRows({ required: true }),
          codexProcessIncarnation:
            this.#dependencies.native.codexProcessIncarnation
        },
        acceptance: {
          captureCodex: captureCodexRolloutAcceptanceAnchor,
          detectCodexCandidates: detectCodexCandidateSetRolloutAcceptance,
          detectBoundCodex: detectCodexRolloutAcceptance,
          detectClaude: (conversation, control) =>
            detectClaudeTranscriptAcceptance(
              this.#dependencies.terminal.durableRequest(conversation, control),
              {
                claudeHome: expandHome(options.claudeHome),
                agentRows: runtime().loadClaudeAgentRows()
              }
            )
        },
        terminal: {
          proveExactDraftStillPresent: (input) =>
            (bridge ?? runtime().createBridge())
              .proveExactDraftStillPresent(
                input.executor,
                input.terminalControl,
                input.requestText,
                {
                  scrollbackLines: input.scrollbackLines,
                  runtime: this.#dependencies.terminal.runtimeIdentity(
                    input.conversation,
                    input.terminalControl
                  )
                }
              )
        },
        authority: {
          assertTurnCurrent: this.#dependencies.authority.assertTurnCurrent
        }
      }
    );
  }

  async inspectCodexOpenRoots(input: {
    options: TerminalAcceptanceCliOptions;
    pid: number;
    cwd?: string;
  }): Promise<CodexOpenRootRolloutInventory> {
    return this.execution(input.options)
      .inspectCodexOpenRootInventory(input.pid, input.cwd);
  }

  async resolveNativeIdentity(
    input: NativeIdentityResolutionRequest & {
      options: TerminalAcceptanceCliOptions;
    }
  ): Promise<TerminalNativeIdentity | undefined> {
    const { options, ...request } = input;
    return this.execution(options).resolveCurrentNativeIdentity(request);
  }

  async observeNativeIdentity(
    input: NativeIdentityResolutionRequest & {
      options: TerminalAcceptanceCliOptions;
    }
  ): Promise<NativeAgentSessionIdentityObservation> {
    const { options, ...request } = input;
    return this.execution(options).observeCurrentNativeIdentity(request);
  }

  assertTurnIdentity(input: {
    conversation: Conversation;
    currentIdentity: TerminalNativeIdentity | undefined;
    operation: string;
  }): void {
    this.execution({}).assertTurnIdentity(input);
  }

  withNativeIdentity(
    conversation: Conversation,
    identity: TerminalNativeIdentity
  ): Conversation {
    return this.execution({}).withNativeIdentity(conversation, identity);
  }

  async recoverVirgin(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalLockHeld?: boolean;
  }): Promise<{ conversation: Conversation; state: VirginBindingRecoveryState }> {
    const initialControl = this.#dependencies.authority.terminalControl(
      takeoverFor(input.conversation)
    );
    const initialFacts = this.#virginFacts(
      input.conversation,
      initialControl,
      undefined
    );
    if (!isVirginCodexRecoveryCandidate(initialFacts)) {
      return { conversation: input.conversation, state: "not_applicable" };
    }
    const storeDir = pathsForConversationDir(
      path.dirname(input.statePath)
    ).storeDir;
    const releaseTerminal = input.terminalLockHeld
      ? () => {}
      : this.#dependencies.repository.acquireTerminalLock(
          storeDir,
          initialControl as TerminalControlRef,
          { timeoutMs: 30000 }
        );
    try {
      return await this.#recoverVirginWithWriter({
        ...input,
        initialControl: initialControl as TerminalControlRef,
        storeDir
      });
    } finally {
      releaseTerminal();
    }
  }

  async #recoverVirginWithWriter(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    logPath: string;
    initialControl: TerminalControlRef;
    storeDir: string;
  }): Promise<{ conversation: Conversation; state: VirginBindingRecoveryState }> {
    return withStoreWriterLeaseAsync(input.storeDir, async () => {
      const releaseState = this.#dependencies.repository.acquireStateLock(
        `${input.statePath}.lock`
      );
      try {
        return await this.#recoverVirginLocked(input);
      } finally {
        releaseState();
      }
    });
  }

  async #recoverVirginLocked(input: {
    options: TerminalAcceptanceCliOptions;
    statePath: string;
    logPath: string;
    initialControl: TerminalControlRef;
    storeDir: string;
  }): Promise<{ conversation: Conversation; state: VirginBindingRecoveryState }> {
    let current = loadState(input.statePath);
    const currentCandidate = this.#virginFacts(
      current,
      input.initialControl,
      undefined
    );
    if (!isCurrentVirginCodexRecoveryBoundary(currentCandidate)) {
      return { conversation: current, state: "not_applicable" };
    }
    const session = loadManagedSession(
      input.storeDir,
      sessionIdForConversation(current)
    );
    const facts = this.#virginFacts(current, input.initialControl, session);
    const rawAnchor = takeoverFor(current)?.codex_rollout_acceptance_anchor;
    let recoveredAt: string | undefined;
    const service = new ManagedTurnRecoveryService({
      identity: {
        resolve: (request) => this.resolveNativeIdentity({
          options: input.options,
          agent: "codex",
          ...request
        })
      },
      acceptance: {
        detect: (identity, requestHash) => Boolean(detectCodexRolloutAcceptance({
          anchor: rawAnchor as CodexRolloutAcceptanceAnchor,
          currentIdentity: identity,
          requestHash
        }))
      },
      authority: {
        assertExclusive: (request) =>
          this.#dependencies.native.assertExclusive({
            options: input.options,
            agent: "codex",
            currentPid: request.pid,
            nativeThreadId: request.nativeThreadId,
            storeDir: input.storeDir,
            terminalControl: request.terminalControl,
            excludedManagedSessionId: request.sessionId
          }),
        assertTurn: (identity) => {
          if (!identity) {
            this.#dependencies.authority.assertTurnCurrent(
              current,
              "recover virgin Codex binding for"
            );
            return;
          }
          recoveredAt ??= cliNow().toISOString();
          this.assertTurnIdentity({
            conversation: current,
            currentIdentity: identity,
            operation: "recover virgin Codex binding for"
          });
        }
      },
      persistence: {
        persistSessionIdentity: (identity) => {
          const persisted = this.persistSessionIdentity({
            conversation: current,
            terminalControl: facts.terminalControl as TerminalControlRef,
            identity,
            storeDir: input.storeDir
          });
          return persisted?.binding
            ? {
                nativeThreadId: persisted.binding.native_thread_id,
                processUuid: persisted.binding.native_process.process_uuid,
                processBirth: persisted.binding.native_process.process_birth,
                rollout: persisted.binding.native_process.rollout
              }
            : undefined;
        },
        persistTurnIdentity: (identity) => {
          recoveredAt = cliNow().toISOString();
          current = {
            ...this.withNativeIdentity(current, identity),
            updated_at: recoveredAt
          };
          saveState(input.statePath, current);
        }
      }
    });
    const result = await service.recover(facts);
    if (result.state !== "recovered") {
      return { conversation: current, state: result.state };
    }
    this.#appendVirginRecoveryEvent({
      ...input,
      conversation: current,
      facts,
      identity: result.identity as TerminalNativeIdentity,
      recoveredAt: recoveredAt ?? cliNow().toISOString()
    });
    return { conversation: current, state: "recovered" };
  }

  #virginFacts(
    conversation: Conversation,
    initialControl: TerminalControlRef | undefined,
    session: ManagedSessionState | undefined
  ): VirginCodexRecoveryFacts {
    const takeover = takeoverFor(conversation);
    const rawAnchor = isRecord(takeover?.codex_rollout_acceptance_anchor)
      ? takeover.codex_rollout_acceptance_anchor
      : undefined;
    const submission = terminalBridgeSubmission(conversation);
    const terminalControl = this.#dependencies.authority.terminalControl(takeover);
    const binding = session?.binding;
    const requestText = String(
      takeover?.terminal_bridge_request_text ?? conversation.user_request ?? ""
    );
    return {
      agent: executorForConversation(conversation).kind,
      anchorVersion: numericValue(rawAnchor?.version),
      anchorNativeThreadBinding: nonBlankString(rawAnchor?.native_thread_binding),
      anchorProcessUuid: nonBlankString(rawAnchor?.process_uuid),
      anchorProcessBirth: nonBlankString(rawAnchor?.process_birth),
      terminalControl,
      initialTerminalIncarnationMatches: Boolean(
        terminalControl && initialControl &&
        terminalControlsShareIncarnation(terminalControl, initialControl)
      ),
      submissionStatus: nonBlankString(submission?.status),
      messageId: nonBlankString(submission?.message_id),
      takeoverMessageId: nonBlankString(takeover?.terminal_bridge_message_id),
      requestHash: nonBlankString(takeover?.terminal_bridge_request_hash),
      computedRequestHash: terminalBridgeRequestFingerprint(requestText),
      bindingId: nonBlankString(conversation.terminal_binding_id),
      bindingGeneration: safeInteger(conversation.terminal_binding_generation),
      pid: safeInteger(takeover?.terminal_agent_pid),
      sessionId: session?.session_id,
      sessionAgent: session?.agent,
      sessionStatus: session?.status,
      sessionBinding: binding
        ? {
            bindingId: binding.binding_id,
            generation: binding.generation,
            pid: binding.native_process.pid,
            terminalIncarnationMatches: Boolean(terminalControl &&
              terminalControlsShareIncarnation(
                binding.terminal_control,
                terminalControl
              )),
            nativeThreadId: binding.native_thread_id,
            processUuid: binding.native_process.process_uuid,
            processBirth: binding.native_process.process_birth,
            rollout: binding.native_process.rollout
          }
        : undefined,
      turnNativeThreadId:
        nonBlankString(conversation.native_thread_id) ??
        nonBlankString(takeover?.terminal_agent_session_id),
      turnProcessUuid: nonBlankString(takeover?.terminal_agent_process_uuid),
      turnProcessBirth: nonBlankString(takeover?.terminal_agent_process_birth),
      turnRollout: isCompleteNativeRollout(takeover?.terminal_agent_rollout)
        ? takeover.terminal_agent_rollout
        : undefined
    };
  }

  #appendVirginRecoveryEvent(input: {
    logPath: string;
    conversation: Conversation;
    facts: VirginCodexRecoveryFacts;
    identity: TerminalNativeIdentity;
    recoveredAt: string;
  }): void {
    try {
      appendEvent(input.logPath, {
        ts: input.recoveredAt,
        conversation_id: input.conversation.conversation_id,
        event: "virgin_codex_post_submission_binding_recovered",
        message_id: input.facts.messageId,
        native_thread_id: input.identity.sessionId,
        terminal_control: input.facts.terminalControl
      });
    } catch (error) {
      cliRuntimeLog("warn", "virgin_codex_binding_recovery_event_failed", {
        conversation_id: input.conversation.conversation_id,
        terminal_target: input.facts.terminalControl?.target,
        error: errorText(error)
      });
    }
  }

  async reconcileMonitor(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalControl: TerminalControlRef;
    executor: Executor;
    terminalBridge: TerminalAcceptanceBridge;
  }): Promise<
    | { outcome: "accepted"; conversation: Conversation }
    | { outcome: "pending" }
    | { outcome: "not_accepted"; conversation: Conversation }
  > {
    const deferred = await this.#reconcileDeferredAcceptance(input);
    if (deferred) return deferred;
    const service = new TerminalAcceptanceApplicationService<Conversation>({
      clock: { nowMs: cliNowMs },
      binding: {
        recover: async (conversation) => {
          const recovered = await this.recoverVirgin({
            ...input,
            conversation,
            terminalLockHeld: true
          });
          return { turn: recovered.conversation, state: recovered.state };
        }
      },
      acceptance: {
        detect: (executor, conversation) =>
          this.execution(input.options).detectAcceptance({
            executor,
            conversation,
            terminalControl: input.terminalControl
          })
      },
      terminal: {
        proveExactDraftStillPresent: (conversation, requestText) =>
          input.terminalBridge.proveExactDraftStillPresent(
            input.executor.kind,
            input.terminalControl,
            requestText,
            {
              scrollbackLines: Number(input.options.scrollbackLines ?? 240),
              runtime: this.#dependencies.terminal.runtimeIdentity(
                conversation,
                input.terminalControl
              )
            }
          )
      },
      repository: {
        commit: (request) => this.#commitAcceptance(input, request)
      }
    });
    const result = await service.reconcile({
      executor: input.executor.kind,
      turn: input.conversation,
      project: acceptanceFacts
    });
    return result.outcome === "pending"
      ? result
      : { outcome: result.outcome, conversation: result.turn };
  }

  async #reconcileDeferredAcceptance(input: {
    options: TerminalAcceptanceCliOptions;
    conversation: Conversation;
    statePath: string;
    terminalControl: TerminalControlRef;
    terminalBridge: TerminalAcceptanceBridge;
  }): Promise<
    | { outcome: "accepted"; conversation: Conversation }
    | { outcome: "pending" }
    | { outcome: "not_accepted"; conversation: Conversation }
    | undefined
  > {
    const transferId = nonBlankString(
      takeoverFor(input.conversation)?.deferred_foreground_transfer_id
    );
    if (!transferId) return undefined;
    const storeDir = pathsForConversationDir(path.dirname(input.statePath)).storeDir;
    let transfer = this.#dependencies.deferred.loadTransfer(storeDir, transferId);
    const pid = safeInteger(
      takeoverFor(input.conversation)?.terminal_agent_pid
    );
    if (!pid || pid <= 1) {
      throw new Error(
        "deferred Codex acceptance monitor lost its exact process identity"
      );
    }
    const terminal = await input.terminalBridge.resolveStoredTerminal(
      "codex",
      pid,
      input.terminalControl,
      { pid }
    );
    let conversation = input.conversation;
    if (!this.#dependencies.deferred.isFinal(transfer.status)) {
      await this.#dependencies.deferred.recover({
        options: { ...input.options, storeDir },
        terminal
      });
      transfer = this.#dependencies.deferred.loadTransfer(storeDir, transferId);
      conversation = loadState(input.statePath);
      if (!this.#dependencies.deferred.isFinal(transfer.status)) {
        return { outcome: "pending" };
      }
    }
    if (transfer.status === "abort_resolved") {
      assertDeferredAbortReceipt(conversation, transfer);
      return { outcome: "not_accepted", conversation };
    }
    return this.#acceptedDeferredAuthority(storeDir, terminal, transfer);
  }

  #acceptedDeferredAuthority(
    storeDir: string,
    terminal: TerminalDispatchTerminal,
    transfer: DeferredForegroundTransfer
  ): { outcome: "accepted"; conversation: Conversation } {
    const authority = this.#dependencies.deferred.loadAuthority({
      storeDir,
      terminal,
      transfer
    });
    const ledger = this.#dependencies.repository.loadLedger(
      terminal.terminalControl
    );
    if (!ledger) {
      throw new Error(
        `deferred foreground transfer ${transfer.transfer_id} resolved ` +
        "without an exact terminal dispatch ledger"
      );
    }
    this.#dependencies.deferred.assertLedgerAuthority({
      storeDir,
      terminal,
      transfer,
      ledger,
      statePath: authority.statePath,
      expectedMessageBodyHash: nonBlankString(
        authority.submission.message_body_hash
      )
    });
    const acceptedIdentity = deferredAcceptedIdentity(transfer);
    this.assertTurnIdentity({
      conversation: authority.conversation,
      currentIdentity: acceptedIdentity,
      operation: "continue deferred foreground monitor for"
    });
    return { outcome: "accepted", conversation: authority.conversation };
  }

  async #commitAcceptance(
    input: {
      statePath: string;
      logPath: string;
      terminalControl: TerminalControlRef;
    },
    request: {
      turn: Conversation;
      expected: TerminalAcceptanceTurnFacts;
      resolution: TerminalAcceptanceResolution;
    }
  ): Promise<Conversation> {
    const resolvedAt = cliNow().toISOString();
    const storeDir = pathsForConversationDir(path.dirname(input.statePath)).storeDir;
    return withStoreWriterLeaseAsync(storeDir, async () => {
      const releaseState = this.#dependencies.repository.acquireStateLock(
        `${input.statePath}.lock`
      );
      try {
        return this.#commitAcceptanceLocked(input, request, resolvedAt);
      } finally {
        releaseState();
      }
    });
  }

  #commitAcceptanceLocked(
    input: {
      statePath: string;
      logPath: string;
      terminalControl: TerminalControlRef;
    },
    request: {
      turn: Conversation;
      expected: TerminalAcceptanceTurnFacts;
      resolution: TerminalAcceptanceResolution;
    },
    resolvedAt: string
  ): Conversation {
    const current = loadState(input.statePath);
    assertAcceptanceGeneration(current, request.turn, request.expected);
    const accepted = resolvedAcceptanceConversation(
      current,
      request.expected,
      request.resolution,
      resolvedAt,
      this.storeDirForConversation(current),
      this.#dependencies.authority.terminalControl(takeoverFor(current))
    );
    const ledger = this.#dependencies.repository.reconcileLedger(
      input.terminalControl,
      this.#dependencies.repository.loadLedger(input.terminalControl)
    );
    if (
      nonBlankString(ledger?.message_id) !== request.expected.messageId ||
      ledger?.status !== "enter_dispatched"
    ) {
      throw new Error(
        "terminal dispatch ledger changed before acceptance reconciliation"
      );
    }
    saveState(input.statePath, accepted);
    this.#persistResolvedAcceptanceLedger(
      input.terminalControl,
      accepted,
      ledger,
      request.resolution,
      resolvedAt
    );
    this.#appendResolvedAcceptanceEvent(
      input,
      accepted,
      request.resolution,
      resolvedAt
    );
    return accepted;
  }

  #persistResolvedAcceptanceLedger(
    terminalControl: TerminalControlRef,
    conversation: Conversation,
    ledger: TerminalDispatchLedgerDocument,
    resolution: TerminalAcceptanceResolution,
    resolvedAt: string
  ): void {
    try {
      if (cliEnv().AKK_TEST_MONITOR_FINAL_TERMINAL_LEDGER_FAILURE === "1") {
        throw new Error(
          "injected monitor final terminal ledger persistence failure"
        );
      }
      this.#dependencies.repository.saveLedger(terminalControl, {
        ...ledger,
        ...this.#dependencies.repository.bindingFields(conversation),
        status: resolution.outcome,
        ...(resolution.outcome === "not_accepted"
          ? { not_accepted_at: resolvedAt }
          : {
              agent_accepted_at: resolvedAt,
              acceptance_evidence: resolution.evidence
            }),
        dispatcher_pid: null
      } as TerminalDispatchLedgerDocument);
    } catch (error) {
      this.#warnAcceptanceLag(
        "terminal_acceptance_monitor_ledger_lagging",
        conversation,
        terminalControl,
        resolution,
        error
      );
    }
  }

  #appendResolvedAcceptanceEvent(
    input: { logPath: string; terminalControl: TerminalControlRef },
    conversation: Conversation,
    resolution: TerminalAcceptanceResolution,
    resolvedAt: string
  ): void {
    try {
      if (cliEnv().AKK_TEST_MONITOR_FINAL_EVENT_FAILURE === "1") {
        throw new Error(
          "injected monitor final acceptance event persistence failure"
        );
      }
      appendEvent(input.logPath, {
        ts: resolvedAt,
        conversation_id: conversation.conversation_id,
        event: resolution.outcome === "not_accepted"
          ? "terminal_message_not_accepted"
          : "terminal_message_agent_accepted",
        message_id: nonBlankString(
          terminalBridgeSubmission(conversation)?.message_id
        ),
        terminal_control: input.terminalControl,
        do_not_retry: resolution.outcome === "not_accepted"
      });
    } catch (error) {
      this.#warnAcceptanceLag(
        "terminal_acceptance_monitor_event_lagging",
        conversation,
        input.terminalControl,
        resolution,
        error
      );
    }
  }

  #warnAcceptanceLag(
    event: string,
    conversation: Conversation,
    terminalControl: TerminalControlRef,
    resolution: TerminalAcceptanceResolution,
    error: unknown
  ): void {
    cliRuntimeLog("warn", event, {
      conversation_id: conversation.conversation_id,
      message_id: nonBlankString(terminalBridgeSubmission(conversation)?.message_id),
      terminal_target: terminalControl.target,
      durable_submission_status: resolution.outcome,
      error: errorText(error)
    });
  }

  markUncertain(input: {
    conversation: Conversation;
    statePath: string;
    logPath: string;
    terminalControl: TerminalControlRef;
    reason: string;
  }): Conversation {
    const messageId = nonBlankString(
      terminalBridgeSubmission(input.conversation)?.message_id
    );
    const uncertainAt = cliNow().toISOString();
    const storeDir = pathsForConversationDir(path.dirname(input.statePath)).storeDir;
    return withStoreWriterLease(storeDir, () => {
      const releaseState = this.#dependencies.repository.acquireStateLock(
        `${input.statePath}.lock`
      );
      try {
        return this.#markUncertainLocked(input, messageId, uncertainAt);
      } finally {
        releaseState();
      }
    });
  }

  #markUncertainLocked(
    input: {
      statePath: string;
      logPath: string;
      terminalControl: TerminalControlRef;
      reason: string;
    },
    messageId: string | undefined,
    uncertainAt: string
  ): Conversation {
    const current = loadState(input.statePath);
    const submission = terminalBridgeSubmission(current);
    if (
      !messageId ||
      nonBlankString(submission?.message_id) !== messageId ||
      !["text_injected", "enter_dispatched"].includes(String(submission?.status))
    ) {
      return current;
    }
    const requestText = String(
      takeoverFor(current)?.terminal_bridge_request_text ??
      current.user_request ?? ""
    );
    const uncertain = applyTerminalBridgeSubmission({
      conversation: {
        ...current,
        status: "stalled",
        stalled_at: uncertainAt,
        stalled_reason: input.reason,
        updated_at: uncertainAt
      },
      messageId,
      requestText,
      status: "uncertain",
      preparedAt: nonBlankString(submission?.prepared_at) ?? uncertainAt,
      textInjectedAt: nonBlankString(submission?.text_injected_at),
      enterDispatchedAt: nonBlankString(submission?.enter_dispatched_at),
      uncertainAt,
      error: input.reason,
      lastProvenStage: submission?.status === "enter_dispatched"
        ? "enter_dispatched"
        : "text_injected"
    }, receiptContext(
      current,
      this.#dependencies.authority.terminalControl(takeoverFor(current))
    ));
    this.#persistUncertainLedger(input, messageId, uncertainAt);
    saveState(input.statePath, uncertain);
    appendEvent(input.logPath, {
      ts: uncertainAt,
      conversation_id: uncertain.conversation_id,
      event: "terminal_message_acceptance_uncertain",
      message_id: messageId,
      terminal_control: input.terminalControl,
      error: textSummary(input.reason),
      do_not_retry: true
    });
    return uncertain;
  }

  #persistUncertainLedger(
    input: { terminalControl: TerminalControlRef; reason: string },
    messageId: string,
    uncertainAt: string
  ): void {
    const ledger = this.#dependencies.repository.loadLedger(input.terminalControl);
    if (
      nonBlankString(ledger?.message_id) === messageId &&
      ["text_injected", "enter_dispatched"].includes(String(ledger?.status))
    ) {
      this.#dependencies.repository.saveLedger(input.terminalControl, {
        ...ledger,
        status: "uncertain",
        uncertain_at: uncertainAt,
        error: textSummary(input.reason),
        dispatcher_pid: null
      } as TerminalDispatchLedgerDocument);
    }
  }

  storeDirForConversation(conversation: Conversation): string | undefined {
    const explicit = nonBlankString(conversation.store_dir);
    if (explicit) return explicit;
    const statePath = nonBlankString(conversation.state_path);
    return statePath
      ? pathsForConversationDir(path.dirname(statePath)).storeDir
      : undefined;
  }

  refineSessionIdentity(input: {
    storeDir: string;
    session: ManagedSessionState;
    terminalControl: TerminalControlRef;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState {
    const binding = input.session.binding;
    if (input.session.status !== "bound" || !binding) return input.session;
    if (
      !terminalControlsShareIncarnation(
        binding.terminal_control,
        input.terminalControl
      ) ||
      (input.identity && binding.native_thread_id &&
        binding.native_thread_id !== input.identity.sessionId)
    ) {
      throw new Error(
        `managed Session ${input.session.session_id} changed native identity before send`
      );
    }
    const refined = refinedSessionBinding(input);
    if (!refined.changed) return input.session;
    const now = cliNow().toISOString();
    return saveManagedSession(input.storeDir, {
      ...input.session,
      binding: {
        ...binding,
        ...(refined.endpoint ? { terminal_endpoint: refined.endpoint } : {}),
        native_thread_id: refined.nativeThreadId,
        native_process: {
          ...binding.native_process,
          process_uuid: refined.processUuid,
          process_birth: refined.processBirth,
          rollout: refined.rollout,
          evidence: input.identity?.evidence ?? binding.native_process.evidence
        },
        last_verified_at: now
      },
      updated_at: now
    }, { expectedRevision: managedSessionRevision(input.session) });
  }

  persistSessionIdentity(input: {
    conversation: Conversation;
    terminalControl: TerminalControlRef;
    identity: TerminalNativeIdentity;
    storeDir: string;
  }): ManagedSessionState | undefined {
    const boundary = this.#managedSessionIdentityBoundary(
      input.conversation,
      input.storeDir,
      "managed Session native identity escaped its exact Store writer"
    );
    if (!boundary) return undefined;
    const canonicalStoreDir = path.resolve(input.storeDir);
    const current = tryLoadManagedSession(canonicalStoreDir, boundary.sessionId);
    assertSessionIdentityCommitAuthority(current, boundary, input);
    const binding = (current as ManagedSessionState).binding as
      NonNullable<ManagedSessionState["binding"]>;
    if (
      binding.native_thread_id &&
      binding.native_thread_id !== input.identity.sessionId
    ) {
      throw new Error(
        `managed Session ${boundary.sessionId} expected native thread ` +
        `${binding.native_thread_id}, observed ${input.identity.sessionId}`
      );
    }
    const now = cliNow().toISOString();
    const next = {
      ...(current as ManagedSessionState),
      binding: {
        ...binding,
        native_thread_id: input.identity.sessionId,
        native_process: {
          ...binding.native_process,
          process_uuid: input.identity.processUuid,
          process_birth: input.identity.processBirth,
          rollout: input.identity.rollout,
          evidence: input.identity.evidence
        },
        last_verified_at: now
      },
      updated_at: now
    };
    return saveManagedSession(canonicalStoreDir, next, {
      expectedRevision: managedSessionRevision(current as ManagedSessionState)
    });
  }

  #managedSessionIdentityBoundary(
    conversation: Conversation,
    storeDir: string,
    escapedStoreMessage: string
  ): {
    sessionId: string;
    bindingId: string;
    bindingGeneration: number;
  } | undefined {
    const bindingId = nonBlankString(conversation.terminal_binding_id);
    const bindingGeneration = safeInteger(
      conversation.terminal_binding_generation
    );
    const conversationStoreDir = this.storeDirForConversation(conversation);
    if (!bindingId || bindingGeneration === undefined || !conversationStoreDir) {
      return undefined;
    }
    if (path.resolve(conversationStoreDir) !== path.resolve(storeDir)) {
      throw new Error(escapedStoreMessage);
    }
    return {
      sessionId: sessionIdForConversation(conversation),
      bindingId,
      bindingGeneration
    };
  }

  quarantineSession(input: {
    conversation: Conversation;
    reason: string;
    storeDir: string;
  }): void {
    const boundary = this.#managedSessionIdentityBoundary(
      input.conversation,
      input.storeDir,
      "managed Session quarantine escaped its exact Store writer"
    );
    if (!boundary) return;
    const canonicalStoreDir = path.resolve(input.storeDir);
    const current = tryLoadManagedSession(canonicalStoreDir, boundary.sessionId);
    if (
      !current?.binding ||
      current.binding.binding_id !== boundary.bindingId ||
      current.binding.generation !== boundary.bindingGeneration
    ) {
      return;
    }
    const now = cliNow().toISOString();
    saveManagedSession(canonicalStoreDir, {
      ...current,
      status: "quarantined",
      quarantine_reason: input.reason.slice(0, 2000),
      updated_at: now
    }, { expectedRevision: managedSessionRevision(current) });
  }

  turnsForSession(storeDir: string, sessionId: string): Conversation[] {
    return listConversations(storeDir)
      .filter(this.#dependencies.authority.isDiscoverableTurn)
      .filter((conversation) =>
        sessionIdForConversation(conversation) === sessionId
      )
      .sort(compareManagedConversationRecency);
  }

  assertSessionCanStartTurn(turns: Conversation[]): void {
    assertManagedSessionCanStartTurnPolicy(
      turns,
      (conversation) =>
        this.#dependencies.authority.isSessionBlockingStatus(conversation.status)
    );
  }

  turnMatchesTerminal(input: {
    conversation: Conversation;
    terminal: TerminalDispatchTerminal;
    currentIdentity?: TerminalNativeIdentity;
  }): boolean {
    const storedControl = this.#dependencies.authority.terminalControl(
      takeoverFor(input.conversation)
    );
    return managedTurnMatchesTerminal({
      ...input,
      storedControlExists: storedControl !== undefined,
      terminalIncarnationMatches: Boolean(storedControl &&
        terminalControlsShareIncarnation(
          storedControl,
          input.terminal.terminalControl
        )),
      workspaceMatches: this.#dependencies.authority.workspaceMatches(
        input.conversation.workspace,
        input.terminal.terminalControl.currentPath
      )
    });
  }

  createManagedTurn(input: {
    options: TerminalAcceptanceCliOptions;
    conversationId: string;
    agent: ExecutorKind;
    pid: number;
    messageBody: string;
    terminalControl: TerminalControlRef;
    previousTurn?: Conversation;
    managedSession?: ManagedSessionState;
    nativeAgentIdentity?: TerminalNativeIdentity;
    deferredForegroundTransferId?: string;
  }): ManagedTerminalTurn {
    const workspace = input.terminalControl.currentPath ?? cliCwd();
    const storeDir = expandHome(
      input.options.storeDir ?? input.options.logDir ?? defaultStoreDir(workspace)
    );
    const executor = input.previousTurn
      ? executorForConversation(input.previousTurn)
      : resolveExecutor({ kind: input.agent, session: input.conversationId });
    const now = cliNow();
    const base = createConversation({
      userRequest: input.messageBody,
      sessionId: input.managedSession?.session_id ??
        (input.previousTurn
          ? sessionIdForConversation(input.previousTurn)
          : undefined),
      workspace,
      openclawSession: input.options.openclawSession ??
        input.previousTurn?.openclaw_session ?? "agent:main:main",
      executorKind: executor.kind,
      executorSession: executor.session,
      softLimit: Number(input.options.softLimit ?? 50),
      hardLimit: Number(input.options.hardLimit ?? 100),
      now
    });
    const paths = pathsForConversation(base.conversation_id, storeDir);
    const attached = attachManagedTurn(base, input, executor, now, paths);
    const message = createMessage({
      conversation: attached,
      id: nonBlankString(input.options.messageId),
      from: "openclaw",
      to: executor.actor,
      type: (input.options.type ?? "task") as MessageType,
      body: input.messageBody,
      metadata: {
        executor_kind: executor.kind,
        executor_session: executor.session,
        source_conversation_id: input.conversationId
      }
    });
    return {
      conversation: attached,
      nextConversation: applyMessageToConversation(attached, message),
      statePath: paths.statePath,
      logPath: paths.logPath,
      executor,
      message
    };
  }
}

function companionIdentity(
  identity: TerminalNativeIdentityFence,
  evidence: string
): ActiveAgentSessionIdentity {
  return { ...identity, evidence };
}

function takeoverFor(conversation: Conversation) {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

function safeInteger(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function numericValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function acceptanceFacts(conversation: Conversation): TerminalAcceptanceTurnFacts {
  const takeover = takeoverFor(conversation);
  const submission = terminalBridgeSubmission(conversation);
  const anchor = isRecord(takeover?.codex_rollout_acceptance_anchor)
    ? takeover.codex_rollout_acceptance_anchor
    : undefined;
  return {
    turnStatus: conversation.status,
    messageId: nonBlankString(submission?.message_id),
    submissionStatus: nonBlankString(submission?.status),
    requestText: String(takeover?.terminal_bridge_request_text ?? ""),
    enterDispatchedAtMs: validTerminalMonitorTimestampMs(
      submission?.enter_dispatched_at
    ),
    codexAnchorVersion: numericValue(anchor?.version)
  };
}

function assertDeferredAbortReceipt(
  conversation: Conversation,
  transfer: DeferredForegroundTransfer
): void {
  const submission = terminalBridgeSubmission(conversation);
  if (
    conversation.conversation_id !== transfer.turn_id ||
    nonBlankString(submission?.message_id) !== transfer.message_id ||
    submission?.status !== "aborted" ||
    submission.safe_to_retry !== true
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} resolved its ` +
      "abort without an exact zero-input Turn receipt"
    );
  }
}

function deferredAcceptedIdentity(
  transfer: DeferredForegroundTransfer
): TerminalNativeIdentity {
  const binding = transfer.target_accepted_binding;
  const rollout = binding?.native_process.rollout;
  if (
    !binding ||
    !transfer.target_native_thread_id ||
    binding.native_thread_id !== transfer.target_native_thread_id ||
    !isCompleteNativeRollout(rollout)
  ) {
    throw new Error(
      `deferred foreground transfer ${transfer.transfer_id} resolved ` +
      "without an exact accepted native binding"
    );
  }
  return {
    sessionId: transfer.target_native_thread_id,
    processUuid: binding.native_process.process_uuid,
    processBirth: binding.native_process.process_birth,
    rollout,
    evidence: binding.native_process.evidence
  };
}

function assertAcceptanceGeneration(
  current: Conversation,
  expectedTurn: Conversation,
  facts: TerminalAcceptanceTurnFacts
): void {
  const submission = terminalBridgeSubmission(current);
  if (
    current.status !== expectedTurn.status ||
    nonBlankString(takeoverFor(current)?.terminal_bridge_message_id) !==
      facts.messageId ||
    nonBlankString(submission?.message_id) !== facts.messageId ||
    submission?.status !== "enter_dispatched"
  ) {
    throw new Error(
      "terminal acceptance generation changed before monitor reconciliation"
    );
  }
}

function resolvedAcceptanceConversation(
  current: Conversation,
  expected: TerminalAcceptanceTurnFacts,
  resolution: TerminalAcceptanceResolution,
  resolvedAt: string,
  storeDir: string | undefined,
  terminalControl: TerminalControlRef | undefined
): Conversation {
  const submission = terminalBridgeSubmission(current);
  const base = resolution.outcome === "not_accepted"
    ? {
        ...current,
        status: "stalled" as const,
        stalled_at: resolvedAt,
        stalled_reason: resolution.reason,
        updated_at: resolvedAt
      }
    : current;
  return applyTerminalBridgeSubmission({
    conversation: base,
    messageId: expected.messageId as string,
    requestText: String(
      takeoverFor(current)?.terminal_bridge_request_text ??
      current.user_request ?? ""
    ),
    status: resolution.outcome,
    preparedAt: nonBlankString(submission?.prepared_at) ?? resolvedAt,
    textInjectedAt: nonBlankString(submission?.text_injected_at),
    enterDispatchedAt: nonBlankString(submission?.enter_dispatched_at),
    ...(resolution.outcome === "not_accepted"
      ? { notAcceptedAt: resolvedAt }
      : {
          agentAcceptedAt: resolvedAt,
          acceptanceEvidence: resolution.evidence
        })
  }, {
    dispatcherPid: cliPid(),
    storeDir,
    terminalControl
  });
}

function receiptContext(
  conversation: Conversation,
  terminalControl: TerminalControlRef | undefined
) {
  const explicit = nonBlankString(conversation.store_dir);
  const statePath = nonBlankString(conversation.state_path);
  return {
    dispatcherPid: cliPid(),
    storeDir: explicit ?? (statePath
      ? pathsForConversationDir(path.dirname(statePath)).storeDir
      : undefined),
    terminalControl
  };
}

function refinedSessionBinding(input: {
  session: ManagedSessionState;
  terminalControl: TerminalControlRef;
  identity?: TerminalNativeIdentity;
}) {
  const binding = input.session.binding as NonNullable<ManagedSessionState["binding"]>;
  const nativeThreadId = binding.native_thread_id ?? input.identity?.sessionId;
  const processUuid = binding.native_process.process_uuid ??
    input.identity?.processUuid;
  const processBirth = binding.native_process.process_birth ??
    input.identity?.processBirth;
  const rollout = binding.native_process.rollout ?? input.identity?.rollout;
  const endpoint = binding.terminal_endpoint ??
    (hasCanonicalTerminalEndpoint(input.terminalControl)
      ? terminalControlEvidence(input.terminalControl)
      : undefined);
  return {
    nativeThreadId,
    processUuid,
    processBirth,
    rollout,
    endpoint,
    changed: nativeThreadId !== binding.native_thread_id ||
      processUuid !== binding.native_process.process_uuid ||
      processBirth !== binding.native_process.process_birth ||
      JSON.stringify(rollout) !== JSON.stringify(binding.native_process.rollout) ||
      endpoint !== binding.terminal_endpoint
  };
}

function assertSessionIdentityCommitAuthority(
  current: ManagedSessionState | undefined,
  boundary: {
    sessionId: string;
    bindingId: string;
    bindingGeneration: number;
  },
  input: {
    terminalControl: TerminalControlRef;
  }
): void {
  if (
    !current ||
    current.status !== "bound" ||
    !current.binding ||
    current.binding.binding_id !== boundary.bindingId ||
    current.binding.generation !== boundary.bindingGeneration ||
    !terminalControlsShareIncarnation(
      current.binding.terminal_control,
      input.terminalControl
    )
  ) {
    throw new Error(
      `managed Session ${boundary.sessionId} binding changed before native identity commit`
    );
  }
}

function attachManagedTurn(
  base: Conversation,
  input: {
    options: TerminalAcceptanceCliOptions;
    conversationId: string;
    agent: ExecutorKind;
    pid: number;
    terminalControl: TerminalControlRef;
    previousTurn?: Conversation;
    managedSession?: ManagedSessionState;
    nativeAgentIdentity?: TerminalNativeIdentity;
    deferredForegroundTransferId?: string;
  },
  executor: Executor,
  now: Date,
  paths: ReturnType<typeof pathsForConversation>
): Conversation {
  const previousTakeover = input.previousTurn
    ? takeoverFor(input.previousTurn)
    : undefined;
  const nativeProcess = input.managedSession?.binding?.native_process;
  return withStoragePaths({
    ...base,
    terminal_binding_id: input.managedSession?.binding?.binding_id,
    terminal_binding_generation: input.managedSession?.binding?.generation,
    native_thread_id: input.managedSession?.binding?.native_thread_id ??
      input.nativeAgentIdentity?.sessionId,
    executor,
    status: "idle",
    idle_since: now.toISOString(),
    updated_at: now.toISOString(),
    gateway_url: input.options.gatewayUrl ?? input.previousTurn?.gateway_url ??
      "ws://127.0.0.1:18789",
    gateway_method: input.options.gatewayMethod ??
      input.previousTurn?.gateway_method,
    gateway_session: input.options.gatewaySession ??
      input.options.openclawSession ?? input.previousTurn?.gateway_session ??
      input.previousTurn?.openclaw_session ?? "agent:main:main",
    openclaw_bin: input.options.openclawBin ??
      input.previousTurn?.openclaw_bin ?? resolveOptionalExecutable("openclaw"),
    native_session_takeover: {
      agent: input.agent,
      terminal_agent_identity_protocol: 1,
      native_session_id: input.conversationId,
      terminal_agent_pid: input.pid,
      terminal_agent_session_id: input.nativeAgentIdentity?.sessionId,
      terminal_agent_expected_session_id:
        input.managedSession?.binding?.native_thread_id,
      terminal_binding_id: input.managedSession?.binding?.binding_id,
      terminal_binding_generation: input.managedSession?.binding?.generation,
      terminal_agent_process_uuid: input.nativeAgentIdentity?.processUuid ??
        nativeProcess?.process_uuid,
      terminal_agent_process_birth: input.nativeAgentIdentity?.processBirth ??
        nativeProcess?.process_birth,
      terminal_agent_rollout: input.nativeAgentIdentity?.rollout ??
        nativeProcess?.rollout,
      terminal_agent_identity_evidence: input.nativeAgentIdentity?.evidence ??
        nativeProcess?.evidence,
      source_cwd: base.workspace,
      source_title: `Terminal-controlled ${executor.display_name} ${input.terminalControl.target}`,
      strategy: "terminal_control",
      attached_at: nonBlankString(previousTakeover?.attached_at) ??
        now.toISOString(),
      takeover_match_kind: input.previousTurn
        ? "managed_session_send"
        : "raw_terminal_send",
      ...terminalEndpointTakeoverFields(input.terminalControl),
      needs_bootstrap: false,
      terminal_bridge: true,
      ...(input.deferredForegroundTransferId
        ? { deferred_foreground_transfer_id: input.deferredForegroundTransferId }
        : {})
    }
  }, paths);
}

function terminalEndpointTakeoverFields(terminalControl: TerminalControlRef) {
  return {
    terminal_control: terminalControl,
    ...(hasCanonicalTerminalEndpoint(terminalControl)
      ? { terminal_endpoint: terminalControlEvidence(terminalControl) }
      : {})
  };
}

function withStoragePaths(
  conversation: Conversation,
  paths: ReturnType<typeof pathsForConversation>
): Conversation {
  return {
    ...conversation,
    store_dir: paths.storeDir,
    conversation_dir: paths.conversationDir,
    event_log_path: paths.logPath,
    state_path: paths.statePath
  };
}

function textSummary(text: unknown, maxLength = 240) {
  const value = String(text ?? "");
  return {
    length: value.length,
    preview: value ? value.slice(0, maxLength) : undefined
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

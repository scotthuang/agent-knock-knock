import path from "node:path";

import {
  captureClaudeTranscriptAnchor,
  defaultClaudeHome,
  type ClaudeTranscriptAnchor
} from "./claude-local-transcript-provider.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import {
  type Conversation
} from "./protocol.js";
import type {
  TerminalAgentAdapterRegistry,
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  isExactClaudeNativeInspectionIdleComposer,
  type TerminalAgentBridge,
  type TerminalBridgeStatus
} from "./terminal-agent-bridge.js";
import type { TerminalNativeIdentity as NativeAgentSessionIdentity } from
  "./terminal-binding-authority.js";
import type { CodexForegroundProofAuthority } from
  "./terminal-command-foreground-proof.js";
import {
  assertTerminalNativeBindingBeforeSend,
  assertTerminalPreSendStatus,
  terminalPreSendRuntime,
  terminalSendCandidateAcceptanceAnchor
} from "./terminal-command-send-preflight.js";
import {
  bindTerminalDispatchRoute,
  type BoundTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import type {
  TerminalControlSendRequest,
  TerminalDispatchTerminal
} from
  "./terminal-dispatch-composition.js";
import {
  terminalSubmissionPayload,
  type TerminalDispatchExecutionService
} from "./terminal-dispatch-execution.js";
import {
  sameCanonicalStatePath,
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import {
  presentTerminalDispatchReplay,
  type TerminalDispatchPresentationContext,
  type TerminalDispatchPresentationPorts
} from "./terminal-dispatch-presenter.js";
import { terminalMonitorScreenFingerprint } from
  "./terminal-monitor-decision-policy.js";
import type { CodexRolloutAcceptanceAnchor } from
  "./terminal-submission-acceptance.js";
import { expandHome } from "./cli-command-runtime.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface TerminalDispatchPreparationDefaults {
  agentTimeoutMinutes: number;
  agentHardTimeoutMinutes: number;
  ordinaryScrollbackLines: number;
  foregroundScrollbackLines: number;
}

export interface TerminalDispatchPreparationPorts {
  assertCodexComposerReadyForAutomatedInput(request: {
    options: TerminalControlSendRequest["options"];
    terminalControl: TerminalControlRef;
    runtime?: TerminalRuntimeIdentity;
  }): Promise<void>;
  assertNoUnresolvedTerminalBridgeSubmission(
    storeDir: string,
    terminalControl: TerminalControlRef,
    currentConversationId: string,
    requestText: string
  ): void;
  assertSafeTerminalSend(
    agent: TerminalControlSendRequest["executor"]["kind"],
    status: TerminalBridgeStatus
  ): void;
  createRegistry(options: TerminalControlSendRequest["options"]):
    TerminalAgentAdapterRegistry;
  createTerminalBridge(options: TerminalControlSendRequest["options"]):
    TerminalAgentBridge;
  execution(
    options: TerminalControlSendRequest["options"],
    bridge: TerminalAgentBridge
  ): TerminalDispatchExecutionService;
  foregroundProofs: CodexForegroundProofAuthority;
  loadClaudeAgentRows(options: TerminalControlSendRequest["options"]):
    ClaudeAgentRow[];
  loadDispatchLedger(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  loadDispatchOwner(
    ledger: Record<string, unknown>
  ): Conversation | undefined;
  now(): Date;
  positiveMinutes(value: unknown, optionName: string): number;
  reconcilePreparedLedger(
    terminalControl: TerminalControlRef,
    ledger?: Record<string, unknown>
  ): TerminalDispatchLedgerDocument | undefined;
  requestFingerprint(text: string): string | undefined;
  required<Value>(
    value: Value | null | undefined,
    message: string
  ): Value;
  resolveLedgerPaneIncarnation(
    terminalControl: TerminalControlRef,
    ledger?: Record<string, unknown>
  ): TerminalDispatchLedgerDocument | undefined;
  terminalBridgeEnabled(conversation: Conversation): boolean;
  terminalRuntimeForLiveIdentity(request: {
    terminal: TerminalDispatchTerminal;
    identity?: NativeAgentSessionIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  terminalRuntimeIdentityForConversation(
    conversation: Conversation,
    terminalControl: TerminalControlRef
  ): TerminalRuntimeIdentity;
  presentation: TerminalDispatchPresentationPorts;
}

export interface PreparedTerminalControlSend {
  route: BoundTerminalDispatchRoute;
  bridge: boolean;
  terminalControl: TerminalControlRef;
  lockedStoreDir: string;
  statePath: string;
  logPath: string;
  terminalBridge: TerminalAgentBridge;
  execution: TerminalDispatchExecutionService;
  bridgeStartedAt: string;
  submissionPreparedAt: string;
  agentTimeoutMinutes: number;
  agentHardTimeoutMinutes: number;
  terminalPayload: string;
  terminalRequestHash: string;
  presentationContext: TerminalDispatchPresentationContext;
  presentationPorts: TerminalDispatchPresentationPorts;
  previousDispatchLedger?: TerminalDispatchLedgerDocument;
  sendTakeover?: Record<string, unknown>;
  terminalAgentPid: number;
  needsPostSendNativeBinding: boolean;
  preSendRuntime: TerminalRuntimeIdentity;
  preSendScreenFingerprint?: string;
  codexRolloutAcceptanceAnchor?: CodexRolloutAcceptanceAnchor;
  claudeTranscriptAnchor?: ClaudeTranscriptAnchor;
  claudeHome?: string;
}

/**
 * Prepare one ordinary dispatch from a single locked route and live terminal
 * observation. This phase never performs task text or Enter input.
 */
export async function prepareTerminalControlSend(
  request: TerminalControlSendRequest,
  ports: TerminalDispatchPreparationPorts,
  defaults: TerminalDispatchPreparationDefaults
): Promise<PreparedTerminalControlSend | undefined> {
  const {
    transaction, options, conversation, executor, message,
    recordRawAttachmentAfterSend = false,
    allowedPreMaterializationIdentity,
    allowedAdditionalIdentities = [],
    deferredCodexForegroundBinding,
    continuingTurnResponse = false
  } = request;
  const bridge = ports.terminalBridgeEnabled(conversation);
  const route = bindTerminalDispatchRoute(
    transaction.scopes,
    transaction.resources
  );
  const {
    terminalControl,
    storeDir: lockedStoreDir,
    statePath,
    logPath
  } = route;
  const terminalBridge = ports.createTerminalBridge(options);
  const execution = ports.execution(options, terminalBridge);
  const bridgeStartedAt = ports.now().toISOString();
  const submissionPreparedAt = deferredCodexForegroundBinding?.preparedAt ??
    bridgeStartedAt;
  const agentTimeoutMinutes = Number(
    options.agentTimeoutMinutes ?? defaults.agentTimeoutMinutes
  );
  const agentHardTimeoutMinutes = ports.positiveMinutes(
    options.agentHardTimeoutMinutes ?? defaults.agentHardTimeoutMinutes,
    "--agent-hard-timeout-minutes"
  );
  const terminalPayload = terminalSubmissionPayload(String(message.body ?? ""));
  const terminalRequestHash = ports.required(
    ports.requestFingerprint(terminalPayload),
    "terminal request hash is unavailable"
  );
  const presentationContext = { message, executor, terminalControl };
  const presentationPorts = ports.presentation;
  let previousDispatchLedger = ports.resolveLedgerPaneIncarnation(
    terminalControl,
    ports.loadDispatchLedger(terminalControl)
  );
  previousDispatchLedger = ports.reconcilePreparedLedger(
    terminalControl,
    previousDispatchLedger
  );
  const previousDispatchLifecycle =
    terminalDispatchLedgerLooksLifecycle(previousDispatchLedger);
  const previousDispatchOwner = execution.preflightRequiresOwner(
    previousDispatchLedger,
    previousDispatchLifecycle
  )
    ? ports.loadDispatchOwner(previousDispatchLedger!)
    : undefined;
  const dispatchPreflight = execution.evaluatePreflight({
    ledger: previousDispatchLedger,
    owner: previousDispatchOwner,
    conversation,
    requestHash: terminalRequestHash,
    requestText: terminalPayload,
    messageId: message.id,
    terminalTarget: terminalControl.target,
    ledgerLifecycle: previousDispatchLifecycle,
    statePathMatches: Boolean(previousDispatchOwner &&
      sameCanonicalStatePath(previousDispatchLedger!.state_path, statePath)),
    continuingTurnResponse
  });
  if (dispatchPreflight.action === "replay") {
    presentTerminalDispatchReplay(
      dispatchPreflight,
      presentationContext,
      presentationPorts
    );
    return undefined;
  }
  if (bridge) {
    ports.assertNoUnresolvedTerminalBridgeSubmission(
      lockedStoreDir,
      terminalControl,
      conversation.conversation_id,
      terminalPayload
    );
  }
  const sendTakeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  const terminalAgentPid = Number(sendTakeover?.terminal_agent_pid);
  const expectedManagedNativeThreadId = nonBlankString(
    sendTakeover?.terminal_agent_expected_session_id
  ) ?? nonBlankString(sendTakeover?.terminal_agent_session_id);
  const candidateSetAnchor = terminalSendCandidateAcceptanceAnchor(request);
  const currentNativeIdentity = candidateSetAnchor
    ? undefined
    : await execution.resolveCurrentNativeIdentity({
        agent: executor.kind,
        pid: terminalAgentPid,
        cwd: terminalControl.currentPath,
        preferredSessionId: allowedPreMaterializationIdentity
          ? expectedManagedNativeThreadId
          : undefined,
        allowedCompanionIdentity: allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
  const virginRawAttach = Boolean(
    recordRawAttachmentAfterSend &&
    !nonBlankString(sendTakeover?.terminal_agent_session_id)
  );
  const pendingManagedNativeBinding = Boolean(
    !nonBlankString(sendTakeover?.terminal_agent_session_id) &&
    nonBlankString(sendTakeover?.terminal_agent_expected_session_id)
  );
  const needsPostSendNativeBinding =
    virginRawAttach || pendingManagedNativeBinding;
  assertTerminalNativeBindingBeforeSend({
    execution,
    conversation,
    currentNativeIdentity,
    needsPostSendNativeBinding,
    allowedPreMaterializationIdentity
  });
  const preSendRuntime = terminalPreSendRuntime({
    request,
    terminalControl,
    terminalAgentPid
  }, {
    terminalRuntimeForLiveIdentity: ports.terminalRuntimeForLiveIdentity,
    terminalRuntimeIdentityForConversation:
      ports.terminalRuntimeIdentityForConversation
  });
  let preSendScreenFingerprint: string | undefined;
  let codexRolloutAcceptanceAnchor: CodexRolloutAcceptanceAnchor | undefined;
  let claudeTranscriptAnchor: ClaudeTranscriptAnchor | undefined;
  const claudeHome = executor.kind === "claude"
    ? path.resolve(expandHome(options.claudeHome) ?? defaultClaudeHome())
    : undefined;
  try {
    const status = await terminalBridge.status(executor.kind, terminalControl, {
      scrollbackLines: options.identifyForeground === true
        ? ports.foregroundProofs.current(options)
            ?.observationScrollbackLines ?? defaults.foregroundScrollbackLines
        : Number(options.scrollbackLines ?? defaults.ordinaryScrollbackLines),
      runtime: preSendRuntime
    });
    ports.foregroundProofs.assertCurrent({
      options,
      executor,
      terminalControl,
      terminalAgentPid,
      status
    });
    assertTerminalPreSendStatus({ request, status }, {
      assertSafeTerminalSend: ports.assertSafeTerminalSend
    });
    const userExplicitManagedAttempt = Boolean(
      nonBlankString(options.expectedUserExplicitTerminalToken)
    );
    if (
      executor.kind === "claude" &&
      userExplicitManagedAttempt &&
      !isExactClaudeNativeInspectionIdleComposer(
        status.screen.excerpt ?? ""
      )
    ) {
      throw new Error(
        "Claude composer is not exactly empty for managed user Send"
      );
    }
    if (
      executor.kind === "codex" &&
      (needsPostSendNativeBinding || userExplicitManagedAttempt)
    ) {
      if (
        needsPostSendNativeBinding &&
        (pendingManagedNativeBinding || allowedPreMaterializationIdentity)
      ) {
        const expectedForegroundId = nonBlankString(
          sendTakeover?.terminal_agent_expected_session_id
        );
        const foreground = ports.createRegistry(options)
          .require("codex")
          .observeThreadLifecycle?.({
            operation: { kind: "new_thread" },
            phase: "before",
            screen: status.screen.excerpt ?? ""
          });
        if (
          !expectedForegroundId ||
          foreground?.status !== "observed" ||
          foreground.nativeThreadId !== expectedForegroundId
        ) {
          throw new Error(
            "Codex foreground thread changed after the managed /status proof; " +
            "refresh list before sending"
          );
        }
      }
      await ports.assertCodexComposerReadyForAutomatedInput({
        options,
        terminalControl,
        runtime: preSendRuntime
      });
    }
    if (bridge) {
      preSendScreenFingerprint = nonBlankString(status.screen.digest) ??
        terminalMonitorScreenFingerprint(status.screen.excerpt);
      if (executor.kind === "codex") {
        codexRolloutAcceptanceAnchor = execution.captureCodexAcceptanceAnchor({
          currentIdentity: currentNativeIdentity,
          expectedNativeThreadId: expectedManagedNativeThreadId,
          boundProcessUuid: nonBlankString(
            sendTakeover?.terminal_agent_process_uuid
          ),
          boundProcessBirth: nonBlankString(
            sendTakeover?.terminal_agent_process_birth
          ),
          allowedPreMaterializationIdentity,
          needsPostSendNativeBinding,
          candidateSetAnchor
        });
      } else {
        claudeTranscriptAnchor = captureClaudeTranscriptAnchor({
          sessionId: preSendRuntime.sessionId,
          cwd: preSendRuntime.cwd,
          pid: preSendRuntime.pid,
          claudeHome,
          agentRows: ports.loadClaudeAgentRows(options)
        });
        if (!claudeTranscriptAnchor) {
          throw new Error(
            "the completion monitor could not bind an owner-private Claude transcript boundary"
          );
        }
      }
    }
  } catch (error) {
    throw new Error(
      `refusing to send to ${executor.display_name} without a verified idle terminal: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  return {
    route,
    bridge,
    terminalControl,
    lockedStoreDir,
    statePath,
    logPath,
    terminalBridge,
    execution,
    bridgeStartedAt,
    submissionPreparedAt,
    agentTimeoutMinutes,
    agentHardTimeoutMinutes,
    terminalPayload,
    terminalRequestHash,
    presentationContext,
    presentationPorts,
    previousDispatchLedger,
    sendTakeover,
    terminalAgentPid,
    needsPostSendNativeBinding,
    preSendRuntime,
    preSendScreenFingerprint,
    codexRolloutAcceptanceAnchor,
    claudeTranscriptAnchor,
    claudeHome
  };
}

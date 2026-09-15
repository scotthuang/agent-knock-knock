import { createHash, randomUUID } from "node:crypto";
import { executorDefinitionForKind } from "./executors.js";
import {
  isTerminalApprovalDecision,
  type TerminalApprovalDecision
} from "./terminal-agent-adapter.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  compactAkkListModelProjection,
  formatAkkListCommandResult,
  formatAkkModelOptionsCommandResult,
  formatAkkRepairModelControlCommandResult,
  formatAkkRespondCommandResult,
  formatAkkSetModelCommandResult,
  formatAkkTerminalWatchHint,
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  formatAkkUnwatchCommandResult,
  formatAkkWatchCommandResult,
  formatAkkWatchStatusCommandResult,
  isAkkModelFacingDiagnosticField,
  isAkkModelFacingPrivateAuthorityField,
  isAkkNativeSubmissionAccepted,
  isAkkRepairModelControlSuccess,
  isAkkSetModelSuccess,
  isAkkThreadTransitionSuccess,
  normalizeAkkModelFacingFieldName,
  parseAkkCommand,
  resolvePluginStoreDir,
  sanitizeAkkModelFacingDiagnosticText,
  sanitizeAkkModelFacingLegacyAuthorityInstructionText
} from "./openclaw-plugin-helpers.js";
import {
  approveParameters,
  cancelParameters,
  closeParameters,
  identifyAndSendParameters,
  identifyForegroundParameters,
  listParameters,
  listResumableThreadsParameters,
  modelOptionsParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  repairModelControlParameters,
  renewParameters,
  respondInteractionParameters,
  respondParameters,
  resumeThreadParameters,
  retryCallbackParameters,
  sendParameters,
  setModelParameters,
  statusParameters,
  unwatchParameters,
  watchParameters
} from "./openclaw-plugin-schemas.js";
import {
  consumeOpenClawPrivateAuthorityOffer,
  invalidateOpenClawInteractionAuthorityOffersForSubject,
  openClawApprovalAuthorityOfferKey,
  openClawInteractionAuthorityOfferKey,
  rememberOpenClawPrivateAuthorityOffer,
  type OpenClawInteractionAuthoritySubjectKind,
  type OpenClawPrivateAuthorityOfferKey,
  type OpenClawPrivateAuthorityOfferPayload,
  type OpenClawPrivateAuthorityTarget
} from "./openclaw-private-authority-offers.js";
import {
  beginSemanticToolCatalog,
  defineSemanticCatalogTool,
  finishSemanticToolCatalog,
  semanticToolLabel,
  type SemanticToolCatalog
} from "./semantic-tool-catalog.js";
import {
  TERMINAL_INTERACTION_LIMITS,
  TERMINAL_INTERACTION_SUBJECT_VERSION,
  terminalInteractionSubjectId,
  validateAnyTerminalInteractionProjection,
  validateAnyTerminalInteractionResponse,
  type TerminalInteractionAnyProjection
} from "./terminal-interaction-protocol.js";
import {
  normalizedTerminalSendResultContract,
  terminalSendEnterDispatched
} from "./terminal-dispatch-presenter.js";
import {
  bindSemanticToolAsyncRelay,
  bindSemanticToolRelayEnvironment,
  bindSemanticToolRelayPath,
  defaultSemanticToolRelayPath,
  runCli,
  runCliAsync,
  runHostAwareCli,
  withHostBridgeInvocationSignal
} from "./semantic-tool-relay.js";

export {
  bindSemanticToolAsyncRelay,
  bindSemanticToolRelayEnvironment,
  bindSemanticToolRelayPath,
  defaultSemanticToolRelayPath,
  runCli,
  runCliAsync,
  withHostBridgeInvocationSignal
} from "./semantic-tool-relay.js";

const MAX_DISPLAYED_RESUME_SNAPSHOTS = 512;
const HANDOFF_AUTHORITY_KIND = "handoff";
const RECONCILE_BINDING_AUTHORITY_KIND = "reconcile_binding";
const MODEL_OPTIONS_AUTHORITY_KIND = "model_options";
// Model discovery intentionally revalidates every native menu transition.
// Claude's live effort-ring walk can exceed the generic 90-second relay
// budget, while set-model performs discovery both before and after its one
// commit. Keep these operations bounded without killing the child midway
// through a verified native picker. The Host abort signal still cancels them.
const MODEL_OPTIONS_CLI_TIMEOUT_MS = 15 * 60_000;
const REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS = 2 * 60_000;
const SET_MODEL_CLI_TIMEOUT_MS = 30 * 60_000;
const CALLBACK_METHOD = AKK_CALLBACK_METHOD;

interface DisplayedModelOptionsOfferPayload
  extends OpenClawPrivateAuthorityOfferPayload {
  readonly scope?: unknown;
  readonly models?: unknown;
}
export type DisplayedResumeSnapshotMap = Map<
  string,
  { snapshotId: string; expiresAtMs: number }
>;
const hostBridgePresentationApis = new WeakSet<object>();

/** Keep one shared tool implementation while selecting Host-neutral output. */
export function bindHostBridgeToolPresentation(api: object): void {
  hostBridgePresentationApis.add(api);
}

/** Build the one host-neutral AKK command/tool catalog for a runtime owner. */
export function createAkkSemanticToolCatalog(
  api: object & Record<string, any>,
  displayedResumeSnapshots: DisplayedResumeSnapshotMap
): SemanticToolCatalog {
  beginSemanticToolCatalog(api);
  const command = {
    name: "akk",
    description: "Send coding work through existing Codex or Claude Code shared terminals, inspect managed Turns, observe a user-selected terminal with durable read-only Terminal Watch, manage native threads, and safely inspect or change an idle pane's native model selection.",
    acceptsArgs: true,
    requiresAuthentication: true,
    progressMessage: "AKK is handling the request...",
    promptGuidance: [
      "Use /akk <task> when exactly one send-ready coding-agent terminal pane should receive new work. Send-ready means an exact live process and terminal plus a scanned, non-blocked approval state. Parsed working activity and ordinary Codex main-Composer visibility, stability, or exactness do not veto this user-priority path. A proven input-owning native approval, questionnaire/editor, or read-only viewer remains a zero-input boundary; Codex 0.154's exact collapsed async-question summary remains sendable, while its expanded, clipped, or ambiguous editor does not. Codex terminal_user_explicit physical fallback sends C-u once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once; after text injection, no Composer observation may veto Enter. Claude Code user-explicit Send remains exact-empty-only. Managed Send may still require exact empty before input, while native inspection and native lifecycle input remain exact-empty-only. Broken or stale AKK management activity records do not veto the user's physical Send. Structured tools use only semantic identifiers returned by AKK: session_id for an exact managed context, terminal_id for the currently verified pane, turn_id for one managed Turn, watch_id for one Terminal Watch, and native_thread_id for one resumable native thread. Draft text, composer digests, and opaque freshness authority stay private; AKK revalidates them under its locks. Once the Codex mutation sequence begins, an uncertain result must not be automatically retried. /akk watch is read-only and follows user intent: it prefers an exact task anchor, but version, artifact, managed ownership, and action-advertisement uncertainty degrade to a warning-bearing terminal-activity Watch instead of vetoing the request. New/clear/resume, approval, reconciliation, handoff, and recovery still require the documented user intent or explicit confirmation. AKK never starts a coding-agent process.",
      "Use /akk models on one exact currently advertised physical pane before /akk set-model. Codex 0.154 may use either one exact current native Session or a verified-zero-rollout pane; identify_foreground is diagnostic and is never a prerequisite for that zero-rollout path. Claude Code still requires one exact current native Session. Both steps require no active Turn and no approval, questionnaire/editor, or read-only viewer. model_options normally requires an empty Composer; when List binds it to one exact stable Codex /model residual, it may continue only that residual into read-only catalog discovery. repair_model_control remains the separate clear-only alternative and never presses Enter or selects anything. Only ids and reasoning efforts from that current native catalog are valid. Codex changes the current session and persists the selected model for future sessions; ordinary efforts, including max, are also persisted, while ultra remains current-session-only and Codex chooses a non-ultra future fallback. Claude Code changes only the current session. Read effective and new_session_defaults separately. Model control never accepts slash text, raw keys, menu indexes, display labels, scope overrides, or private authority; an uncertain outcome must not be retried automatically."
    ],
    execute: async (ctx) => handleAkkCommand(api, ctx, displayedResumeSnapshots)
  };

  registerOpenClawListTool(api);

  registerCliTool(api, {
    name: "agent_knock_knock_watch",
    description:
      "Start one durable read-only Terminal Watch for the user's exact selected Codex or Claude Code terminal. AKK prefers an exact durable task anchor; if version, artifact, task, managed-ownership, or action-advertisement evidence is unavailable, it remains callable and returns warnings while using best-effort terminal activity. That fallback reports stable-idle activity, not proof of exact task completion. Watch creates no AKK Session or Turn, sends no terminal input, and never adopts or blocks the terminal task.",
    parameters: watchParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params, toolContext) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const openclawSession =
        stringValue(toolContext?.sessionKey) ??
        "agent:main:main";
      const args = [
        "watch-terminal",
        "--terminal",
        requiredString(params.terminal_id, "terminal_id")
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(
        args,
        "--hard-timeout-minutes",
        numberString(params.hardTimeoutMinutes) ??
          numberString(config.agentHardTimeoutMinutes)
      );
      pushOptional(args, "--openclaw-session", openclawSession);
      pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_unwatch",
    description:
      "Stop one exact durable Terminal Watch by its authoritative watch_id. This cancels observation only; it sends no terminal input and does not interrupt, adopt, or otherwise mutate the human's coding-agent task.",
    parameters: unwatchParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = [
        "unwatch-terminal",
        "--watch",
        requiredString(params.watch_id, "watch_id")
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_list_resumable_threads",
    description:
      "List structurally verified native Codex or Claude Code threads for one exact terminal. A valid unverified agent version remains callable with a compatibility warning. Resume only a row with resumable=true by passing this terminal_id and that row's complete native_thread_id. AKK retains candidate and binding freshness evidence privately. Number and short-id fields are slash-command display aids, never tool arguments. This is read-only for Session/Turn state and creates no AKK Turn.",
    parameters: listResumableThreadsParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = [
        "list-resumable-threads",
        "--terminal",
        requiredString(params.terminal_id, "terminal_id")
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_native_inspect",
    description:
      "Execute one closed native status inspection in an exact Codex or Claude Code terminal. Verified versions use their regression-tested profile; unverified complete x.y.z versions remain callable through the generic runtime protocol and return a compatibility warning. Pass only terminal_id and inspection=status; AKK refreshes binding authority privately. Arbitrary slash commands remain unavailable. This creates no AKK Session, Turn, receipt, monitor, or callback.",
    parameters: nativeInspectParameters,
    normalizeTurnIdentity: false,
    buildArgs: async (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const inspection = requiredString(params.inspection, "inspection");
      if (inspection !== "status") {
        throw new Error("inspection must be status");
      }
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_native_inspect"
      );
      const args = [
        "native-inspect",
        "--terminal",
        terminalId,
        "--inspection",
        inspection,
        "--expected-binding-token",
        requiredString(
          action.expected_binding_token,
          "current internal native-inspect binding authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerModelControlTools(api);

  registerForegroundIdentificationTools(api);

  registerCliTool(api, {
    name: "agent_knock_knock_new_thread",
    description:
      "Start and verify a clean native coding-agent thread in the exact terminal_id after explicit user intent. A valid unverified agent version remains callable with a compatibility warning. AKK refreshes lifecycle authority privately. Never send /clear as ordinary task text. This creates a new AKK Session but no Turn.",
    parameters: newThreadParameters,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
    buildArgs: async (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_new_thread"
      );
      const args = [
        "new-thread",
        "--terminal",
        terminalId,
        "--expected-binding-token",
        requiredString(
          action.expected_binding_token,
          "current internal new-thread binding authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_reconcile_binding",
    description:
      "Detach one exact conflicting managed Session binding without adopting the live replacement thread. Pass only the advertised terminal_id and conflicting_session_id after explicit user confirmation; AKK refreshes all revision and binding authority privately. This sends no coding-agent input and creates no Turn.",
    parameters: reconcileBindingParameters,
    normalizeTurnIdentity: false,
    buildArgs: async (params, toolContext) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const conflictingSessionId = requiredString(
        params.conflicting_session_id,
        "conflicting_session_id"
      );
      const action = await consumeDisplayedPrivateAction(api, {
        sessionKey: requiredOpenClawSessionKey(toolContext?.sessionKey),
        sessionId: requiredOpenClawSessionId(toolContext?.sessionId),
        kind: RECONCILE_BINDING_AUTHORITY_KIND,
        target: { type: "terminal_id", id: terminalId },
        tool: "agent_knock_knock_reconcile_binding",
        terminalId,
        matches: (argumentsValue) =>
          stringValue(argumentsValue.terminal_id) === terminalId &&
          stringValue(argumentsValue.conflicting_session_id) ===
            conflictingSessionId
      });
      const revision = Number(action.expected_session_revision);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new Error(
          "expected_session_revision must be a positive safe integer"
        );
      }
      const args = [
        "reconcile-binding",
        "--terminal",
        terminalId,
        "--conflicting-session",
        requiredString(
          conflictingSessionId,
          "conflicting_session_id"
        ),
        "--expected-session-revision",
        String(revision),
        "--expected-binding-token",
        requiredString(
          action.expected_binding_token,
          "current internal conflicting binding authority"
        ),
        "--expected-terminal-token",
        requiredString(
          action.expected_terminal_token,
          "current internal terminal authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_resume_thread",
    description:
      "Resume one exact structurally verified historical native thread after explicit user intent. A valid unverified agent version remains callable with a compatibility warning. Pass only terminal_id and one complete native_thread_id from a resumable=true row; AKK refreshes binding and candidate evidence privately. This creates or reactivates an AKK Session but no Turn.",
    parameters: resumeThreadParameters,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
    buildArgs: async (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const nativeThreadId = requiredString(
        params.native_thread_id,
        "native_thread_id"
      );
      const discovery = await privateThreadDiscovery(api, terminalId);
      const candidate = Array.isArray(discovery.threads)
        ? discovery.threads.find((thread) =>
            isRecord(thread) &&
            thread.resumable === true &&
            stringValue(thread.native_thread_id) === nativeThreadId
          )
        : undefined;
      if (!isRecord(candidate)) {
        throw new Error(
          `native thread ${nativeThreadId} is not resumable in the current lifecycle snapshot`
        );
      }
      const args = [
        "resume-thread",
        "--terminal",
        terminalId,
        "--native-thread",
        nativeThreadId,
        "--expected-binding-token",
        requiredString(
          discovery.expected_binding_token,
          "current internal lifecycle binding authority"
        ),
        "--candidate-token",
        requiredString(
          candidate.candidate_token,
          "current internal resume candidate authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  defineSemanticCatalogTool(api, {
    label: "AKK Status",
    name: "agent_knock_knock_status",
    description:
      "Inspect one exact AKK-managed Turn by its authoritative turn_id, one durable Terminal Watch by its authoritative watch_id, or use only a raw terminal row's own prefilled compatibility selector. These targets are mutually exclusive. The deprecated conversation_id remains a legacy Turn alias and the list-prefilled raw-terminal input; never construct it. User-selected Watch status reports whether it uses an exact task anchor or best-effort terminal activity without implying Watch sent or adopted the task; that task may independently be managed. Automatic terminal_user_explicit fallback Watch status describes the exact request AKK physically sent without claiming a managed Turn. AKK never starts a coding agent.",
    inputSchema: statusParameters,
    async execute(toolContext, _toolCallId, params, signal) {
      return withHostBridgeInvocationSignal(signal, async () => {
        try {
          const result = await runStatusRequest(api, params, toolContext);
          const rendered = toolResult(result);
          rememberDisplayedApprovalOffer(
            api,
            toolContext?.sessionKey,
            toolContext?.sessionId,
            result
          );
          rememberDisplayedInteractionOffer(
            api,
            toolContext?.sessionKey,
            toolContext?.sessionId,
            result
          );
          return rendered;
        } catch (error) {
          throw modelFacingToolError(error);
        }
      });
    }
  });

  defineSemanticCatalogTool(api, {
    label: "AKK Send",
    name: "agent_knock_knock_send",
    description:
      "Start a new AKK Turn, use one advertised terminal_user_explicit user-priority send, or explicitly recover one current uncertain submission only through its advertised retry_submission action. Ordinary send requires request and may use session_id or terminal_id exactly as advertised. terminal_user_explicit requires one exact live physical terminal/process, a scanned non-blocked approval state, and no input-owning native questionnaire/editor or read-only viewer; parsed working activity, Codex rollout ambiguity, AKK management state, and ordinary Codex main-Composer visibility, stability, or exactness do not veto physical delivery. Codex 0.154's exact collapsed async-question summary remains sendable, while its expanded, clipped, or ambiguous editor receives zero input. Codex physical fallback sends C-u once to replace the current Composer, injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto; Claude Code remains exact-empty-only. A source-less Codex terminal freezes all current rollout roots before input, then promotes a provisional Session/Turn only when exactly one anchored or newly opened rollout durably accepts the exact request hash; zero matches remain pending and ambiguity becomes uncertain without replay. If managed preparation fails before input, AKK still delivers once as unmanaged work, then best-effort attaches an exact Terminal Watch callback. After exact request acceptance and terminal attribution, a supported questionnaire on that Watch may expose owner-bound response authority through Status and its watch_id; terminal-activity observations and manual_required interactions remain notification-only. Read terminal_input_dispatched, agent_acceptance, management_mode, observation_mode, and capabilities independently. Watch attachment failure never changes a successful Send. Once the mutation sequence begins, an uncertain result must not be automatically retried. Retry submission is the mutually exclusive exact {turn_id} form and cannot change request text or routing. Draft text, composer digests, and opaque freshness authority stay private. A Turn id is never an ordinary-send destination. Managed acceptance is asynchronous: yield and wait for its callback or an explicit status request.",
    inputSchema: sendParameters,
    async execute(toolContext, toolCallId, params, signal) {
      return withHostBridgeInvocationSignal(signal, async () => {
        try {
          const result = await runSendRequest(
            api,
            isRecord(params) ? params : {},
            toolContext,
            terminalMessageIdForToolCall({
              toolCallId,
              sessionKey: toolContext?.sessionKey,
              sessionId: toolContext?.sessionId,
              toolName: "agent_knock_knock_send"
            })
          );
          return toolResult(result, { submissionErrors: true });
        } catch (error) {
          throw modelFacingToolError(error);
        }
      });
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_respond",
    description:
      "Respond to a question or blocked callback in one exact in-flight AKK turn. This continues that turn and does not create a new turn; for later ordinary work refresh agent_knock_knock_list and use that terminal row's currently advertised send action.",
    parameters: respondParameters,
    buildArgs: (params, toolContext, toolCallId) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const openclawSession =
        stringValue(toolContext?.sessionKey) ?? "agent:main:main";
      const args = [
        "respond",
        "--turn",
        authoritativeManagedId(params.turn_id, "turn_id"),
        "--message",
        requiredString(params.request, "request")
      ];
      pushOptional(
        args,
        "--message-id",
        terminalMessageIdForToolCall({
          toolCallId,
          sessionKey: openclawSession,
          sessionId: toolContext?.sessionId,
          toolName: "agent_knock_knock_respond"
        })
      );
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--openclaw-session", openclawSession);
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_respond_interaction",
    description:
      "Answer exactly one current native questionnaire step shown by agent_knock_knock_status in this controller conversation. Supply exactly one authoritative subject target: turn_id for a managed Turn or watch_id for an interactive Terminal Watch, plus interaction_id and one typed semantic answer. single_select uses selected_option_ids with one advertised option_id; free_text uses text; confirm uses confirm. AKK consumes only that subject's displayed private offer and revalidates the exact discriminator-specific shape, prompt, owner, task attribution, and terminal authority before any input. A displayed expiry is a freshness boundary: after it passes, AKK must prove the same exact live questionnaire again instead of rejecting an otherwise live prompt. Raw keys, menu indexes, rendered labels, fingerprints, versions, and terminal commands are never accepted. An uncertain response must never be retried blindly.",
    parameters: respondInteractionParameters,
    buildArgs: (params, toolContext) => buildPrivateInteractionResponseArgs(
      api,
      params,
      {
        sessionKey: requiredOpenClawSessionKey(toolContext?.sessionKey),
        sessionId: requiredOpenClawSessionId(toolContext?.sessionId)
      }
    )
  });

  registerCliTool(api, {
    name: "agent_knock_knock_approve",
    description:
      "Dispatch one closed semantic decision for the current exact permission request only after the user reviews and explicitly chooses it. decision defaults to approve_once for compatibility; reject is available only on a managed Turn when the adapter proves a safe native reject choice. Use turn_id for a managed Turn or terminal_id for a separately advertised approve_once-only terminal action. AKK privately refreshes the prompt and authority, then recaptures it under lock. Raw keys, indexes, and labels are not accepted. Never retry an interrupted decision blindly.",
    parameters: approveParameters,
    buildArgs: (params, toolContext) => buildPrivateApprovalArgs(api, params, {
      sessionKey: requiredOpenClawSessionKey(toolContext?.sessionKey),
      sessionId: requiredOpenClawSessionId(toolContext?.sessionId)
    })
  });

  registerCliTool(api, {
    name: "agent_knock_knock_renew",
    description: "Renew monitoring for one exact stalled turn_id without sending text or keys to the coding agent. Use this when the user wants a still-live long-running terminal task to keep monitoring after an inactivity stall.",
    parameters: renewParameters,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["renew"];
      pushTurnTarget(args, params);
      pushOptional(args, "--minutes", numberString(params.minutes) ?? numberString(config.agentTimeoutMinutes));
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_retry_callback",
    description: "Retry a persisted AKK callback for an exact turn that failed before reaching the controller Host. The original callback message id and turn identity are reused for idempotent delivery.",
    parameters: retryCallbackParameters,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["retry-callback"];
      pushTurnTarget(args, params);
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_cancel",
    description: "Interrupt one exact AKK turn_id, or use only an unmanaged raw terminal row's own prefilled cancel action. Claude sends Escape; Codex uses its declared interrupt key. The shared terminal pane remains open for human takeover.",
    parameters: cancelParameters,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["cancel"];
      pushTurnTarget(args, params);
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_close",
    description:
      "Honor an explicit user request to close one managed turn_id and release AKK management. Raw orphan recovery may instead use conversation_id with expected_message_id or expected_transition_id. Close never sends terminal input, stops the coding agent, or closes the shared pane. Deferred transfer, Session, ledger, and callback cleanup is best-effort and cannot veto closing the Turn; warnings identify metadata AKK preserved. Refresh list afterward and use Watch if the coding agent is still working.",
    parameters: closeParameters,
    isErrorResult: isBlockedTerminalDispatchResult,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["close"];
      assertExclusiveRecoveryFence(params);
      pushTurnTarget(args, params);
      pushOptional(args, "--reason", stringValue(params.reason));
      pushOptional(
        args,
        "--expected-message-id",
        stringValue(params.expected_message_id)
      );
      pushOptional(
        args,
        "--expected-transition-id",
        stringValue(params.expected_transition_id)
      );
      pushOptional(
        args,
        "--store-dir",
        resolvePluginStoreDir(config)
      );
      return args;
    }
  });
  return finishSemanticToolCatalog(api, command, 22);
}

function registerOpenClawListTool(api): void {
  registerCliTool(api, {
    name: "agent_knock_knock_list",
    description:
      "List live AKK terminal resources and Terminal Watches. The model-facing result is a compact projection: available_actions contains current semantic action names and action_inputs contains only their dynamic semantic inputs. Follow the installed agent-knock-knock skill for action meaning, target rules, safety boundaries, and recovery behavior; AKK privately revalidates every mutation.",
    parameters: listParameters,
    modelProjection: compactAkkListModelProjection,
    compactText: true,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["list", "--reconcile"];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(
        args,
        "--idle-timeout-minutes",
        numberString(params.idleTimeoutMinutes) ??
          numberString(api.pluginConfig?.idleTimeoutMinutes)
      );
      pushOptional(args, "--agent", stringValue(params.agent));
      pushOptional(args, "--status", stringValue(params.status));
      if (params.all === true) args.push("--all");
      if (params.noApprovalScan === true) args.push("--no-approval-scan");
      if (params.terminalDebug === true) args.push("--terminal-debug");
      return args;
    }
  });
}

function registerModelControlTools(api): void {
  registerCliTool(api, {
    name: "agent_knock_knock_model_options",
    description:
      "Inspect the exact current native model catalog for one explicitly selected physical Codex or Claude Code pane. This is the required read-only first step before set_model. Codex 0.154 accepts one exact current native Session or a verified-zero-rollout pane without identify_foreground; Claude Code still requires one exact current native Session. AKK requires an exact live pane/process, no active Turn, and no approval, questionnaire/editor, or read-only viewer. The Composer must be empty unless current List privately binds this action to one exact stable Codex 0.154 /model residual, which AKK may continue into the native picker without retyping it. That residual-bound authority is consumed by discovery; after restoring an exact empty Composer, AKK retains only fresh ordinary terminal/catalog authority for one set_model attempt in this exact controller conversation. It obtains model ids and reasoning-effort values from the native UI/runtime and exposes only semantic choices. Codex advertises scope=current_and_new_sessions; Claude Code advertises scope=current_session. Arbitrary commands, keys, menu indexes, labels, and hidden authority are never accepted.",
    parameters: modelOptionsParameters,
    timeoutMs: MODEL_OPTIONS_CLI_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    buildArgs: async (params) => {
      assertOnlyModelControlParameters(
        params,
        ["terminal_id"],
        "model_options"
      );
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_model_options"
      );
      const args = [
        "model-options",
        "--terminal",
        terminalId,
        "--expected-binding-token",
        requiredString(
          action.expected_binding_token,
          "current internal model-options binding authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    },
    rememberResult: (result, params, toolContext) =>
      rememberDisplayedModelOptionsOffer(
        api,
        toolContext?.sessionKey,
        toolContext?.sessionId,
        params.terminal_id,
        result
      )
  });

  registerCliTool(api, {
    name: "agent_knock_knock_repair_model_control",
    description:
      "Clear one exact stale Codex 0.154 /model completion surface, exact bare /model Composer, or exact open native model picker left by a failed native model-control attempt. This explicit one-shot repair is available only when the current AKK list proves the same exact pane/process, the closed profiled model-control residue, no active Turn, and no approval, questionnaire/editor, or read-only viewer. Pass only terminal_id; AKK privately derives and revalidates every physical, screen, and Composer fence before each reversible cleanup input. It never submits a task, selects a model, approves a prompt, accepts raw commands or keys, or automatically continues into model_options/set_model. An open picker receives dismissal authority only, never Enter authority. outcome=uncertain must never be retried automatically.",
    parameters: repairModelControlParameters,
    timeoutMs: REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkRepairModelControlSuccess(result),
    buildArgs: async (params) => {
      assertOnlyModelControlParameters(
        params,
        ["terminal_id"],
        "repair_model_control"
      );
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_repair_model_control"
      );
      const args = [
        "repair-model-control",
        "--terminal",
        terminalId,
        "--expected-binding-token",
        requiredString(
          action.expected_binding_token,
          "current internal model-control repair authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_set_model",
    description:
      "Change exactly one already-open physical coding-agent pane to one semantic model and reasoning-effort tuple from the immediately preceding model_options result in this same controller conversation. AKK consumes the private current-snapshot offer, revalidates the exact pane/process plus idle and empty native UI under lock, rejects active Turns and every input-owning prompt/viewer, and verifies the effective postcondition. Codex 0.154 accepts one exact current native Session or a verified-zero-rollout pane without identify_foreground; Claude Code still requires one exact current native Session. Codex scope is current_and_new_sessions: the model and ordinary efforts (including max) are persisted, but ultra remains current-session-only; the future model is reported while the native TUI's unobservable fallback effort is omitted. Claude Code scope is current_session and leaves future defaults unchanged. Parameters never accept scope, raw commands, slash text, keys, menu indexes, display labels, fingerprints, or tokens. outcome=uncertain must never be retried automatically.",
    parameters: setModelParameters,
    timeoutMs: SET_MODEL_CLI_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkSetModelSuccess(result),
    buildArgs: (params, toolContext) => buildPrivateSetModelArgs(
      api,
      params,
      {
        sessionKey: requiredOpenClawSessionKey(toolContext?.sessionKey),
        sessionId: requiredOpenClawSessionId(toolContext?.sessionId)
      }
    )
  });
}

function registerForegroundIdentificationTools(api): void {
  registerCliTool(api, {
    name: "agent_knock_knock_identify_foreground",
    description:
      "Explicitly identify the foreground Codex native thread in one exact idle terminal by issuing the closed /status probe once. The result is a short-lived diagnostic bound to the current pane, process, cwd, and screen generation; it creates no Session or Turn and grants no later response, approval, lifecycle, or send authority. Ordinary list/status never runs this probe.",
    parameters: identifyForegroundParameters,
    normalizeTurnIdentity: false,
    buildArgs: async (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_identify_foreground",
        { reconcile: false }
      );
      const args = [
        "identify-foreground",
        "--terminal",
        terminalId,
        "--expected-terminal-token",
        requiredString(
          action.expected_terminal_token,
          "current internal foreground-identification terminal authority"
        )
      ];
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_identify_and_send",
    description:
      "Explicitly identify the foreground Codex native thread with one closed /status probe, then dispatch one task while retaining the same terminal lock. This is an optional managed-attachment enhancement, not a prerequisite for ordinary human Send. The short-lived status observation never becomes durable identity: only the rollout that uniquely accepts the exact task may own the resulting Session/Turn. If the probe or boundary becomes uncertain, AKK does not send or retry the task.",
    parameters: identifyAndSendParameters,
    isErrorResult: isSubmissionError,
    buildArgs: async (params, toolContext, toolCallId) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = await privateTerminalActionArguments(
        api,
        terminalId,
        "agent_knock_knock_identify_and_send",
        { reconcile: false }
      );
      const openclawSession =
        stringValue(toolContext?.sessionKey) ?? "agent:main:main";
      const args = [
        "send",
        "--conversation",
        terminalId,
        "--expected-terminal-token",
        requiredString(
          action.expected_terminal_token,
          "current internal identify-and-send terminal authority"
        ),
        "--identify-foreground",
        "--message",
        requiredString(params.request, "request"),
        "--background"
      ];
      pushOptional(
        args,
        "--message-id",
        terminalMessageIdForToolCall({
          toolCallId,
          sessionKey: openclawSession,
          sessionId: toolContext?.sessionId,
          toolName: "agent_knock_knock_identify_and_send"
        })
      );
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      pushOptional(
        args,
        "--idle-timeout-minutes",
        numberString(params.idleTimeoutMinutes) ??
          numberString(config.idleTimeoutMinutes)
      );
      pushOptional(
        args,
        "--agent-timeout-minutes",
        numberString(params.agentTimeoutMinutes) ??
          numberString(config.agentTimeoutMinutes)
      );
      pushOptional(
        args,
        "--agent-hard-timeout-minutes",
        numberString(params.agentHardTimeoutMinutes) ??
          numberString(config.agentHardTimeoutMinutes)
      );
      pushOptional(args, "--openclaw-session", openclawSession);
      pushOptional(args, "--gateway-method", CALLBACK_METHOD);
      pushOptional(args, "--gateway-session", openclawSession);
      pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
      return args;
    }
  });
}

function resumeSelectionScope(
  sessionKey: unknown,
  sessionId: unknown
): string {
  const key = requiredString(
    sessionKey,
    "Controller session identity is required for snapshot-bound Resume"
  );
  const incarnation = stringValue(sessionId) ?? null;
  return `openclaw:${createHash("sha256")
    .update(JSON.stringify([key, incarnation]))
    .digest("hex")}`;
}

function resumeSnapshotCacheKey(
  sessionKey: unknown,
  sessionId: unknown,
  terminalId: string
): string {
  const key = requiredString(
    sessionKey,
    "Controller session identity is required for snapshot-bound Resume"
  );
  return JSON.stringify([key, stringValue(sessionId) ?? null, terminalId]);
}

function rememberDisplayedResumeSnapshot(
  snapshots: Map<string, { snapshotId: string; expiresAtMs: number }>,
  key: string,
  snapshotId: string,
  expiresAtMs: number
): void {
  const now = Date.now();
  for (const [candidateKey, value] of snapshots) {
    if (value.expiresAtMs <= now) {
      snapshots.delete(candidateKey);
    }
  }
  snapshots.delete(key);
  while (snapshots.size >= MAX_DISPLAYED_RESUME_SNAPSHOTS) {
    const oldestKey = snapshots.keys().next().value;
    if (typeof oldestKey !== "string") {
      break;
    }
    snapshots.delete(oldestKey);
  }
  snapshots.set(key, { snapshotId, expiresAtMs });
}

function currentDisplayedResumeSnapshotId(
  snapshots: Map<string, { snapshotId: string; expiresAtMs: number }>,
  key: string
): string | undefined {
  const value = snapshots.get(key);
  if (!value) {
    return undefined;
  }
  if (value.expiresAtMs <= Date.now()) {
    snapshots.delete(key);
    return undefined;
  }
  return value.snapshotId;
}

async function handleAkkCommand(
  api,
  ctx,
  displayedResumeSnapshots: Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >
) {
  try {
    const parsed = parseAkkCommand(ctx.args);
    if (parsed.action === "help") {
      return { text: akkUsageText() };
    }
    if (parsed.action === "delegate") {
      const result = await runDelegate(api, {
        request: parsed.request,
        messageId: `openclaw-command-${randomUUID()}`
      }, {
        sessionKey: ctx.sessionKey
      });
      return {
        text: result.scope === "terminal_user_explicit"
          ? formatSendCommandResult(result)
          : formatDelegateCommandResult(result),
        isError: sendCommandResultIsError(result)
      };
    }
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    if (
      parsed.action === "model-options" ||
      parsed.action === "repair-model-control" ||
      parsed.action === "set-model"
    ) {
      return await handleAkkModelCommand(api, ctx, parsed, config);
    }
    if (
      parsed.action === "list-resumable-threads" ||
      parsed.action === "new-thread" ||
      parsed.action === "resume-thread"
    ) {
      return await handleAkkLifecycleCommand(
        api,
        ctx,
        parsed,
        config,
        displayedResumeSnapshots
      );
    }
    const args = parsed.action === "approve"
      ? await buildPrivateApprovalArgs(api, {
          turn_id: parsed.turnId,
          decision: parsed.decision
        }, {
          sessionKey: requiredOpenClawSessionKey(ctx.sessionKey),
          sessionId: requiredOpenClawSessionId(ctx.sessionId)
        })
      : buildAkkCommandCliArgs(parsed, config, {
          sessionKey: ctx.sessionKey,
          messageId: parsed.action === "send"
            ? `openclaw-command-${randomUUID()}`
            : undefined
        });
    if (!args) {
      return { text: akkUsageText(), isError: true };
    }
    // Doctor calls back into the running Gateway for its independent health
    // check. Keep the Gateway event loop free while that child CLI runs.
    const result = parsed.action === "doctor"
      ? await runCliAsync(api, args, { allowNonzeroJson: true })
      : await runHostAwareCli(api, args);
    switch (parsed.action) {
      case "doctor":
        return {
          text: formatDoctorCommandResult(result),
          isError: result.ok !== true
        };
      case "list":
        return { text: formatAkkListCommandResult(result) };
      case "watch":
        return { text: formatAkkWatchCommandResult(result) };
      case "unwatch":
        return { text: formatAkkUnwatchCommandResult(result) };
      case "status":
        return { text: formatStatusCommandResult(result) };
      case "send":
        return {
          text: formatSendCommandResult(result),
          isError: sendCommandResultIsError(result)
        };
      case "respond":
        return formatAkkRespondCommandResult(result);
      case "approve":
        return { text: formatApproveCommandResult(result) };
      case "renew":
        return { text: formatRenewCommandResult(result) };
      case "retry-callback":
        return { text: formatRetryCallbackCommandResult(result) };
      case "cancel":
        return { text: formatCancelCommandResult(result) };
      case "close":
        return {
          text: formatCloseCommandResult(result),
          isError: isBlockedTerminalDispatchResult(result)
        };
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }
    const message = modelFacingErrorMessage(error);
    return {
      text: `AKK command failed: ${message}`,
      isError: true
    };
  }
}

async function handleAkkModelCommand(
  api,
  ctx,
  parsed: Extract<
    ReturnType<typeof parseAkkCommand>,
    { action: "model-options" | "repair-model-control" | "set-model" }
  >,
  config: Record<string, unknown>
) {
  const sessionKey = requiredOpenClawSessionKey(ctx.sessionKey);
  const sessionId = requiredOpenClawSessionId(ctx.sessionId);
  if (parsed.action === "model-options") {
    const action = await privateTerminalActionArguments(
      api,
      parsed.terminalId,
      "agent_knock_knock_model_options"
    );
    const args = buildAkkCommandCliArgs(parsed, config, {
      expectedBindingToken: action.expected_binding_token
    });
    if (!args) throw new Error("could not build model-options command");
    const result = await runHostAwareCli(api, args, {
      timeoutMs: MODEL_OPTIONS_CLI_TIMEOUT_MS
    });
    rememberDisplayedModelOptionsOffer(
      api,
      sessionKey,
      sessionId,
      parsed.terminalId,
      result
    );
    return { text: formatAkkModelOptionsCommandResult(result) };
  }
  if (parsed.action === "repair-model-control") {
    const action = await privateTerminalActionArguments(
      api,
      parsed.terminalId,
      "agent_knock_knock_repair_model_control"
    );
    const args = buildAkkCommandCliArgs(parsed, config, {
      expectedBindingToken: action.expected_binding_token
    });
    if (!args) throw new Error("could not build repair-model-control command");
    const result = await runHostAwareCli(api, args, {
      timeoutMs: REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS
    });
    return {
      text: formatAkkRepairModelControlCommandResult(result),
      isError: !isAkkRepairModelControlSuccess(result)
    };
  }
  const args = buildPrivateSetModelArgs(
    api,
    {
      terminal_id: parsed.terminalId,
      model: parsed.model,
      reasoning_effort: parsed.reasoningEffort
    },
    { sessionKey, sessionId }
  );
  const result = await runHostAwareCli(api, args, {
    timeoutMs: SET_MODEL_CLI_TIMEOUT_MS
  });
  return {
    text: formatAkkSetModelCommandResult(result),
    isError: !isAkkSetModelSuccess(result)
  };
}

function sendCommandResultIsError(result) {
  return isSuccessfulTerminalDispatch(result)
    ? false
    : terminalSubmissionReported(result)
      ? !isAkkNativeSubmissionAccepted(result)
      : result.status === "delivered_unfenced";
}

function isSuccessfulTerminalDispatch(
  result: unknown
): boolean {
  return isRecord(result) && terminalSendEnterDispatched(result);
}

async function handleAkkLifecycleCommand(
  api,
  ctx,
  parsed,
  config,
  displayedResumeSnapshots: Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >
) {
  const selectionScope = resumeSelectionScope(
    ctx.sessionKey,
    ctx.sessionId
  );
  const snapshotCacheKey = resumeSnapshotCacheKey(
    ctx.sessionKey,
    ctx.sessionId,
    parsed.terminalId
  );
  if (
    parsed.action === "resume-thread" &&
    parsed.selection &&
    ["number", "short-id"].includes(
      parsed.selection.kind
    )
  ) {
    requiredString(
      ctx.sessionId,
      "Controller conversation incarnation is required for number or short-id Resume; run /akk threads again in the current conversation or use the complete UUID"
    );
    const mutationArgs = buildAkkCommandCliArgs(parsed, config, {
      sessionKey: ctx.sessionKey,
      selectionScope,
      selectionSnapshotId: currentDisplayedResumeSnapshotId(
        displayedResumeSnapshots,
        snapshotCacheKey
      )
    });
    if (!mutationArgs) {
      throw new Error("could not build snapshot-bound resume command");
    }
    const transitionResult = await runHostAwareCli(api, mutationArgs);
    if (isAkkThreadTransitionSuccess(transitionResult)) {
      displayedResumeSnapshots.delete(snapshotCacheKey);
    }
    return {
      text: formatAkkThreadTransitionCommandResult(transitionResult),
      isError: !isAkkThreadTransitionSuccess(transitionResult)
    };
  }
  const discoveryArgs = buildAkkCommandCliArgs(
    {
      action: "list-resumable-threads",
      terminalId: parsed.terminalId
    },
    config,
    { selectionScope }
  );
  if (!discoveryArgs) {
    throw new Error("could not build native-thread discovery command");
  }
  const discovery = await runHostAwareCli(api, discoveryArgs);
  if (
    parsed.action === "list-resumable-threads" ||
    (
      parsed.action === "resume-thread" &&
      !parsed.selection
    )
  ) {
    const snapshotId = isRecord(discovery.selection_snapshot)
      ? stringValue(discovery.selection_snapshot.snapshot_id)
      : undefined;
    const expiresAt = isRecord(discovery.selection_snapshot)
      ? Date.parse(String(discovery.selection_snapshot.expires_at ?? ""))
      : Number.NaN;
    if (snapshotId && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
      rememberDisplayedResumeSnapshot(
        displayedResumeSnapshots,
        snapshotCacheKey,
        snapshotId,
        expiresAt
      );
    } else {
      displayedResumeSnapshots.delete(snapshotCacheKey);
    }
    return { text: formatAkkThreadsCommandResult(discovery) };
  }
  let expectedBindingToken = requiredString(
    discovery.expected_binding_token,
    "expected_binding_token from lifecycle discovery"
  );
  let candidateToken: string | undefined;
  let mutationCommand = parsed;
  if (parsed.action === "resume-thread") {
    let nativeThreadId: string;
    if (parsed.selection?.kind === "previous") {
      const previous = isRecord(discovery.previous)
        ? discovery.previous
        : undefined;
      const action = isRecord(previous?.available_actions) &&
          isRecord(previous.available_actions.resume_thread)
        ? previous.available_actions.resume_thread
        : undefined;
      const actionArguments = isRecord(action?.arguments)
        ? action.arguments
        : undefined;
      nativeThreadId = requiredString(
        actionArguments?.native_thread_id,
        "no verified previous native thread is available; run /akk threads"
      );
      if (stringValue(actionArguments?.terminal_id) !== parsed.terminalId) {
        throw new Error("previous resume action belongs to another terminal");
      }
      expectedBindingToken = requiredString(
        actionArguments?.expected_binding_token,
        "expected_binding_token from the previous resume action"
      );
      candidateToken = requiredString(
        actionArguments?.candidate_token,
        "candidate_token from the previous resume action"
      );
    } else {
      if (parsed.selection?.kind !== "exact") {
        throw new Error("resume selection could not be resolved");
      }
      nativeThreadId = parsed.selection.nativeThreadId;
      const candidate = Array.isArray(discovery.threads)
        ? discovery.threads.find((thread) =>
            isRecord(thread) &&
            stringValue(thread.native_thread_id) === nativeThreadId
          )
        : undefined;
      if (!isRecord(candidate) || candidate.resumable !== true) {
        throw new Error(
          `native thread ${nativeThreadId} is not resumable in the current lifecycle snapshot`
        );
      }
      candidateToken = requiredString(
        candidate.candidate_token,
        "candidate_token from the selected resumable thread"
      );
    }
    mutationCommand = {
      action: "resume-thread",
      terminalId: parsed.terminalId,
      selection: { kind: "exact", nativeThreadId }
    };
  }
  const mutationArgs = buildAkkCommandCliArgs(mutationCommand, config, {
    sessionKey: ctx.sessionKey,
    expectedBindingToken,
    candidateToken,
    selectionScope
  });
  if (!mutationArgs) {
    throw new Error("could not build native-thread lifecycle command");
  }
  const transitionResult = await runHostAwareCli(api, mutationArgs);
  if (isAkkThreadTransitionSuccess(transitionResult)) {
    displayedResumeSnapshots.delete(snapshotCacheKey);
  }
  return {
    text: formatAkkThreadTransitionCommandResult(transitionResult),
    isError: !isAkkThreadTransitionSuccess(transitionResult)
  };
}

function formatDelegateCommandResult(result) {
  const agent = executorDisplayName(result.agent);
  const { sessionId, turnId } = publicTurnIdentity(result);
  if (result.status === "submission_unfenced") {
    return [
      `AKK sent the terminal input to ${agent}, but could not bind later side effects to an exact native session.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry or continue automatically; inspect the named pane and close this Turn before sending more work."
    ].join("\n");
  }
  if (result.status === "submission_uncertain") {
    return [
      `AKK could not prove whether ${agent} received the terminal task.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry automatically; inspect AKK status and the named terminal pane."
    ].join("\n");
  }
  if (result.status === "submission_aborted") {
    const safeToRetry =
      result.safe_to_retry === true && result.do_not_retry !== true;
    return [
      `AKK stopped before sending the terminal task to ${agent}.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      safeToRetry
        ? "next: no terminal input was sent and the aborted receipt is durable, so this request may be retried."
        : "next: do not retry automatically; AKK could not prove a durable safe abort, so inspect this Turn and its terminal dispatch ledger."
    ].join("\n");
  }
  if (result.status === "submission_pending_acceptance") {
    return [
      `AKK dispatched terminal input to ${agent}, but native acceptance is still pending.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry or report success; wait for acceptance or inspect the shared terminal pane."
    ].join("\n");
  }
  if (result.status === "submission_not_accepted") {
    return [
      `AKK proved that ${agent} did not accept the terminal draft.`,
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      "next: do not retry automatically; inspect the exact draft in the shared terminal pane."
    ].join("\n");
  }
  return [
    `AKK sent the task to ${agent} in the shared terminal.`,
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${result.conversation_status ?? result.status ?? "unknown"}`,
    "The result will return to this controller session through the callback."
  ].join("\n");
}

function executorDisplayName(kind) {
  try {
    return executorDefinitionForKind(String(kind ?? "codex")).displayName;
  } catch {
    return String(kind ?? "agent");
  }
}

function formatStatusCommandResult(result) {
  if (
    stringValue(result.watch_id) ||
    (isRecord(result.watch) && stringValue(result.watch.watch_id)) ||
    (
      isRecord(result.terminal_watch) &&
      stringValue(result.terminal_watch.watch_id)
    )
  ) {
    return formatAkkWatchStatusCommandResult(result);
  }
  const summary = result.summary ?? result.conversation ?? result ?? {};
  const terminalStatus = isRecord(result.terminal_status) ? result.terminal_status : {};
  const rawCallbackDelivery = isRecord(result.conversation?.callback_delivery)
    ? result.conversation.callback_delivery
    : undefined;
  const summarizedCallbackDelivery = isRecord(summary.callback_delivery)
    ? summary.callback_delivery
    : undefined;
  const callbackDelivery = rawCallbackDelivery || summarizedCallbackDelivery
    ? {
        ...(rawCallbackDelivery ?? {}),
        ...(summarizedCallbackDelivery ?? {})
      }
    : undefined;
  const { sessionId, turnId } = publicTurnIdentity(result);
  const lines = [
    "AKK status:",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `agent: ${summary.agent ?? summary.executor?.kind ?? terminalStatus.agent ?? "unknown"}`,
    `turn status: ${summary.status ?? result.conversation_status ?? result.status ?? "not managed"}`,
    `terminal activity: ${terminalStatus.activity_state ?? "unavailable"}`,
    ...formatAkkTerminalWatchHint(result)
  ];
  if (callbackDelivery) {
    const callbackParts = [
      String(callbackDelivery.status ?? "unknown"),
      Number.isSafeInteger(Number(callbackDelivery.attempts))
        ? `attempt ${Number(callbackDelivery.attempts)}`
        : undefined,
      callbackDelivery.attempt_state === "in_flight"
        ? "in flight"
        : undefined,
      stringValue(callbackDelivery.next_attempt_at)
        ? `next retry ${stringValue(callbackDelivery.next_attempt_at)}`
        : undefined
    ].filter(Boolean);
    lines.push(`callback: ${callbackParts.join(", ")}`);
  }
  if (summary.request) {
    lines.push(`request: ${truncateText(summary.request, 180)}`);
  }
  if (result.about) {
    lines.push(`about: ${truncateText(result.about, 500)}`);
  }
  if (result.confidence) {
    lines.push(`confidence: ${result.confidence}`);
  }
  const limitations = Array.isArray(result.limitations)
    ? result.limitations.filter(Boolean)
    : [];
  if (limitations.length > 0) {
    lines.push(`limitations: ${limitations.slice(0, 3).join("; ")}`);
  }
  const screen = terminalScreenExcerpt(result);
  if (screen) {
    lines.push(`terminal screen:\n${screen}`);
  }
  return lines.join("\n");
}

function formatDoctorCommandResult(result) {
  const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
  const tmux = isRecord(capabilities.tmux) ? capabilities.tmux : {};
  const herdr = isRecord(capabilities.herdr) ? capabilities.herdr : {};
  const dependencyChecks = Array.isArray(result.checks)
    ? result.checks.filter(isRecord)
    : [];
  const codingAgentLines = ([
    ["Codex", "codex"],
    ["Claude Code", "claude"]
  ] as const).map(([label, command]) => {
    const check = dependencyChecks.find((entry) => entry.command === command);
    const version = typeof check?.version === "string"
      ? check.version
      : "unavailable";
    const nativeProfile = check?.native_profile_supported === true &&
      typeof check.native_profile === "string"
      ? `native profile ${check.native_profile}`
      : check?.native_actions_available === true
        ? "native lifecycle/status available with compatibility warning"
        : check?.available === true
          ? "native lifecycle/status unavailable: unrecognized version format"
        : "unavailable";
    return `${label}: ${version} (${nativeProfile})`;
  });
  const openclaw = isRecord(result.openclaw) ? result.openclaw : {};
  const checks = Array.isArray(openclaw.checks) ? openclaw.checks : [];
  const failures = checks
    .filter((check) => isRecord(check) && check.ok !== true)
    .map((check) => String(check.name ?? "unknown"));
  const remediation = [...new Set(
    checks.flatMap((check) =>
      isRecord(check) && Array.isArray(check.remediation)
        ? check.remediation.filter(
            (command): command is string =>
              typeof command === "string" && command.trim().length > 0
          )
        : []
    )
  )].slice(0, 3);
  return [
    `AKK doctor: ${result.ok === true ? "ready" : "needs attention"}`,
    `tmux: ${tmux.status ?? "unknown"}`,
    `Herdr: ${herdr.status ?? "unknown"}`,
    ...codingAgentLines,
    `OpenClaw package: ${openclaw.package_ready === true ? "ready" : "not ready"}`,
    `Gateway: ${openclaw.gateway_ready === true ? "healthy" : "unavailable"}`,
    ...(failures.length > 0 ? [`check: ${failures.join(", ")}`] : []),
    ...remediation.map((command) => `next: ${command}`)
  ].join("\n");
}

function formatRenewCommandResult(result) {
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK monitoring renewed.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `inactivity timeout: ${result.agent_timeout_minutes ?? "unknown"} minutes`,
    `hard lifetime: ${result.agent_hard_timeout_minutes ?? "unknown"} minutes`,
    "No message or key was sent to the coding agent."
  ].join("\n");
}

function formatRetryCallbackCommandResult(result) {
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK callback delivered.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${result.conversation?.status ?? "unknown"}`,
    `attempts: ${result.conversation?.callback_delivery?.attempts ?? "unknown"}`
  ].join("\n");
}

function formatUnconfirmedTerminalUserExplicitSendResult(result) {
  const terminalInputDispatched = result.terminal_input_dispatched === true;
  const enterDispatched = terminalSendEnterDispatched(result);
  if (!enterDispatched) {
    return [
      terminalInputDispatched
        ? "AKK started this terminal Send, but could not prove that Enter was dispatched."
        : "AKK stopped this terminal Send before any terminal input was proven.",
      `terminal: ${result.terminal_id ?? "unknown"}`,
      `message: ${result.message_id ?? "unknown"}`,
      terminalInputDispatched
        ? "delivery: text input may be present; do not resend this message id."
        : "delivery: no terminal input proven.",
      "next: inspect AKK status and the terminal before deciding whether to continue."
    ].join("\n");
  }
  return [
    "AKK already dispatched this managed terminal Send; native acceptance is still pending.",
    `terminal: ${result.terminal_id ?? "unknown"}`,
    `message: ${result.message_id ?? "unknown"}`,
    "delivery: Enter dispatched; do not resend this message id.",
    "next: inspect AKK status or the terminal; wait for the existing managed Turn."
  ].join("\n");
}

function formatTerminalUserExplicitSendResult(result) {
  if (!terminalSendEnterDispatched(result)) {
    return formatUnconfirmedTerminalUserExplicitSendResult(result);
  }
  const unmanaged = result.delivered_unmanaged === true;
  const replayed = result.replayed === true;
  const watchCallback = unmanaged &&
    result.callback_expected === true &&
    result.callback_mode === "terminal_watch" &&
    typeof result.watch_id === "string"
      ? result.watch_id
      : undefined;
  return [
    unmanaged
      ? replayed
        ? "AKK confirmed this direct terminal Send was already delivered."
        : "AKK delivered the user's request directly to the coding agent."
      : replayed
        ? "AKK confirmed this managed terminal Send was already delivered."
        : "AKK delivered the user's terminal Send through managed routing.",
    `terminal: ${result.terminal_id ?? "unknown"}`,
    `message: ${result.message_id ?? "unknown"}`,
    `delivery: ${unmanaged ? "unmanaged fallback" : "managed"}`,
    ...(unmanaged
      ? [watchCallback
          ? `callback: Terminal Watch ${watchCallback}; no managed AKK Turn was created.`
          : "callback: unavailable; no managed AKK Turn was created."]
      : []),
    unmanaged
      ? watchCallback
        ? "next: wait for the Terminal Watch callback; watch-status is the recovery path."
        : "next: refresh AKK list and use Watch to observe the still-running coding-agent task."
      : "next: refresh AKK list; do not resend this message id."
  ].join("\n");
}

function formatManagedSendCommandResult(result) {
  const conversation = result.conversation ?? {};
  const conversationId = conversation.conversation_id ?? result.conversation_id ?? "unknown";
  const sessionId = conversation.session_id ?? result.session_id ?? conversationId;
  const turnId = conversation.turn_id ?? result.turn_id ?? conversationId;
  const status = conversation.status ?? result.status ?? "unknown";
  const nextAction = isRecord(result.openclaw_next_action) ? result.openclaw_next_action : undefined;
  if (result.status === "delivered_unfenced") {
    return [
      "AKK sent the terminal input but could not bind an exact native session.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${status}`,
      "next: do not retry or continue automatically; inspect the shared terminal pane and close this Turn before sending more work."
    ].join("\n");
  }
  if (result.submission_outcome === "uncertain") {
    return [
      "AKK terminal submission outcome is uncertain.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry automatically; inspect AKK status and the named terminal pane."
    ].join("\n");
  }
  if (result.submission_outcome === "aborted") {
    const safeToRetry =
      result.safe_to_retry === true && result.do_not_retry !== true;
    return [
      "AKK terminal submission was aborted before terminal input.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      safeToRetry
        ? "next: this request was not sent, the aborted receipt is durable, and it may be retried."
        : "next: do not retry automatically; inspect the Turn because a durable safe abort was not proven."
    ].join("\n");
  }
  if (result.submission_outcome === "pending_acceptance") {
    return [
      "AKK dispatched the terminal input but native acceptance is still pending.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry or report success; wait for acceptance or inspect the shared terminal pane."
    ].join("\n");
  }
  if (result.submission_outcome === "not_accepted") {
    return [
      "AKK proved that the agent did not accept the terminal draft.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry automatically; inspect the exact draft in the shared terminal pane."
    ].join("\n");
  }
  if (
    terminalSubmissionReported(result) &&
    !isAkkNativeSubmissionAccepted(result)
  ) {
    return [
      "AKK could not verify native agent acceptance for this terminal input.",
      `session: ${sessionId}`,
      `turn: ${turnId}`,
      `status: ${result.status ?? status}`,
      "next: do not retry or report success; inspect the exact Turn receipt and shared terminal pane."
    ].join("\n");
  }
  const lines = [
    "AKK turn sent.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${status}`
  ];
  if (result.source) {
    lines.push(`source: ${result.source}`);
  }
  return [
    ...lines,
    nextAction?.action === "yield"
      ? "next: yield now and wait for the AKK callback or an explicit status request."
      : `launched: ${result.launched === true ? "yes" : "no"}`
  ].join("\n");
}

function formatSendCommandResult(result) {
  return result.scope === "terminal_user_explicit"
    ? formatTerminalUserExplicitSendResult(result)
    : formatManagedSendCommandResult(result);
}

function formatCancelCommandResult(result) {
  const conversation = result.conversation ?? {};
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK cancel requested.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `agent: ${result.executor?.kind ?? conversation.executor?.kind ?? "unknown"}`,
    `status: ${conversation.status ?? (result.cancel_requested === true ? "cancel requested" : "not cancelled")}`
  ].join("\n");
}

function formatApproveCommandResult(result) {
  const conversation = result.conversation ?? {};
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    result.approved === true
      ? "AKK approved the current terminal request."
      : "AKK did not approve the terminal request.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${conversation.status ?? "unknown"}`,
    ...(result.reason
      ? [`reason: ${sanitizeAkkModelFacingDiagnosticText(String(result.reason))}`]
      : [])
  ].join("\n");
}

function formatCloseCommandResult(result) {
  if (result.source === "terminal_control") {
    const terminalControl = isRecord(result.terminal_control)
      ? result.terminal_control
      : {};
    if (result.terminal_dispatch_resolved !== true) {
      return [
        "AKK did not clear the unresolved terminal dispatch fence.",
        `terminal: ${terminalControl.target ?? "unknown"}`,
        ...(stringValue(result.transition_id)
          ? [`transition: ${stringValue(result.transition_id)}`]
          : []),
        `reason: ${sanitizeAkkModelFacingDiagnosticText(
          stringValue(result.reason) ??
            "the recorded lifecycle outcome could not be verified"
        )}`,
        "This terminal remains blocked. Do not retry or continue automatically; inspect the pane and use the fresh recovery action from /akk list."
      ].join("\n");
    }
    return [
      "AKK cleared the unresolved terminal dispatch fence.",
      `terminal: ${terminalControl.target ?? "unknown"}`,
      ...(stringValue(result.transition_id)
        ? [`transition: ${stringValue(result.transition_id)}`]
        : [
            `previous turn: ${result.owner_turn_id ?? result.owner_conversation_id ?? "unknown"}`
          ]),
      "The coding agent and terminal pane remain open."
    ].join("\n");
  }
  const conversation = result.conversation ?? {};
  const { sessionId, turnId } = publicTurnIdentity(result);
  return [
    "AKK Turn record closed.",
    `session: ${sessionId}`,
    `turn: ${turnId}`,
    `status: ${conversation.status ?? "unknown"}`,
    "AKK management was released; the coding agent and terminal pane were not stopped.",
    ...(Array.isArray(result.warnings) && result.warnings.length > 0
      ? [`cleanup warnings: ${result.warnings.map((warning) =>
          sanitizeAkkModelFacingDiagnosticText(String(warning))).join("; ")}`]
      : []),
    "Refresh the AKK list; if the coding agent is still working, Watch can attach to it again."
  ].join("\n");
}

function publicTurnIdentity(result) {
  const conversation = isRecord(result.conversation) ? result.conversation : {};
  const summary = isRecord(result.summary) ? result.summary : {};
  const compatibilityId =
    stringValue(conversation.conversation_id) ??
    stringValue(summary.conversation_id) ??
    stringValue(result.conversation_id);
  return {
    sessionId:
      stringValue(conversation.session_id) ??
      stringValue(summary.session_id) ??
      stringValue(result.session_id) ??
      compatibilityId ??
      "unknown",
    turnId:
      stringValue(conversation.turn_id) ??
      stringValue(summary.turn_id) ??
      stringValue(result.turn_id) ??
      compatibilityId ??
      "unknown"
  };
}

function buildStatusCliArgs(api, params, toolContext) {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  if (Object.hasOwn(params, "watch_id")) {
    if (
      Object.hasOwn(params, "turn_id") ||
      Object.hasOwn(params, "conversation_id")
    ) {
      throw new Error(
        "status accepts exactly one of turn_id, conversation_id, or watch_id"
      );
    }
    const watchId = requiredString(params.watch_id, "watch_id");
    const watchArgs = [
      "watch-status",
      "--watch",
      watchId,
      "--openclaw-session",
      requiredOpenClawSessionKey(toolContext?.sessionKey)
    ];
    pushOptional(
      watchArgs,
      "--store-dir",
      resolvePluginStoreDir(config)
    );
    return watchArgs;
  }
  const args = [
    "status",
    "--reconcile"
  ];
  pushTurnTarget(args, params);
  pushOptional(
    args,
    "--store-dir",
    resolvePluginStoreDir(config)
  );
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(params.idleTimeoutMinutes) ??
      numberString(api.pluginConfig?.idleTimeoutMinutes)
  );
  if (params.trace === true) {
    args.push("--trace");
  }
  return args;
}

async function runStatusRequest(
  api,
  params: unknown,
  toolContext: { sessionKey?: unknown; sessionId?: unknown } | undefined
): Promise<Record<string, any>> {
  const statusParams = isRecord(params) ? params : {};
  const statusArgs = buildStatusCliArgs(api, statusParams, toolContext);
  invalidateRequestedInteractionOffers(
    api,
    toolContext?.sessionKey,
    toolContext?.sessionId,
    statusParams
  );
  return runHostAwareCli(api, statusArgs);
}

function terminalScreenExcerpt(result): string | undefined {
  const screen = result.terminal_screen;
  const text = typeof screen === "string"
    ? screen
    : isRecord(screen)
      ? stringValue(screen.excerpt) ??
        stringValue(screen.text) ??
        stringValue(screen.content)
      : undefined;
  if (!text) {
    return undefined;
  }
  return text.length <= 1600
    ? text
    : `…${text.slice(-1599)}`;
}

async function runSendRequest(
  api,
  params,
  toolContext,
  messageId?: string
): Promise<Record<string, any>> {
  if (Object.hasOwn(params, "turn_id")) {
    const unexpected = Object.keys(params).filter((key) => key !== "turn_id");
    if (unexpected.length > 0) {
      throw new Error(
        "send retry_submission accepts exactly turn_id; do not pass request, terminal_id, session_id, timeout overrides, or callback route data"
      );
    }
    const turnId = authoritativeManagedId(params.turn_id, "turn_id");
    await privateActionArguments(api, {
      tool: "agent_knock_knock_send",
      matches: (argumentsValue) =>
        Object.keys(argumentsValue).length === 1 &&
        stringValue(argumentsValue.turn_id) === turnId
    });
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["send", "--turn", turnId];
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    const result = await runHostAwareCli(api, args);
    return {
      ...result,
      ...normalizedTerminalSendResultContract(result)
    };
  }
  const requestedType = Object.hasOwn(params, "type")
    ? stringValue(params.type)
    : "task";
  if (requestedType !== "task") {
    throw new Error(
      "ordinary send type must be task; use agent_knock_knock_respond for an in-flight response"
    );
  }
  if (Object.hasOwn(params, "session_id") && Object.hasOwn(params, "terminal_id")) {
    throw new Error("ordinary send accepts only one of session_id or terminal_id");
  }
  const sessionId = Object.hasOwn(params, "session_id")
    ? authoritativeManagedId(params.session_id, "session_id")
    : undefined;
  const terminalId = Object.hasOwn(params, "terminal_id")
    ? requiredString(params.terminal_id, "terminal_id")
    : undefined;
  if (terminalId && !/^terminal:v[0-9]+:\S+$/u.test(terminalId)) {
    throw new Error(
      "terminal_id must be the exact full terminal identifier returned by AKK list"
    );
  }
  if (!sessionId && !terminalId) {
    return runDelegate(api, { ...params, messageId }, toolContext);
  }

  const terminalAction = terminalId
    ? await privateActionArguments(api, {
        tool: "agent_knock_knock_send",
        terminalId,
        matches: (argumentsValue) =>
          stringValue(argumentsValue.selector) === terminalId ||
          stringValue(argumentsValue.terminal_id) === terminalId
      })
    : undefined;
  const expectedTerminalToken = terminalAction
    ? requiredString(
        terminalAction.expected_terminal_token,
        "current internal terminal send authority"
      )
    : undefined;
  const expectedManagedTerminalToken = terminalAction
    ? stringValue(terminalAction.expected_managed_terminal_token)
    : undefined;
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
    "agent:main:main";
  const args = [
    "send"
  ];
  if (sessionId) {
    args.push("--session", sessionId);
  } else {
    args.push("--conversation", requiredString(terminalId, "terminal_id"));
  }
  pushOptional(
    args,
    "--expected-terminal-token",
    expectedTerminalToken
  );
  pushOptional(
    args,
    "--expected-managed-terminal-token",
    expectedManagedTerminalToken
  );
  args.push(
    "--message",
    requiredString(params.request, "request"),
    "--background"
  );
  pushOptional(args, "--type", stringValue(params.type));
  pushOptional(args, "--message-id", messageId);
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(params.idleTimeoutMinutes) ??
      numberString(config.idleTimeoutMinutes)
  );
  pushOptional(
    args,
    "--agent-timeout-minutes",
    numberString(params.agentTimeoutMinutes) ??
      numberString(config.agentTimeoutMinutes)
  );
  pushOptional(
    args,
    "--agent-hard-timeout-minutes",
    numberString(params.agentHardTimeoutMinutes) ??
      numberString(config.agentHardTimeoutMinutes)
  );
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  const result = await runHostAwareCli(api, args);
  return {
    ...result,
    ...normalizedTerminalSendResultContract(result)
  };
}

function toolResult(
  result,
  {
    submissionErrors = false,
    normalizeTurnIdentity = true,
    forceError = false,
    modelProjection = undefined,
    compactText = false
  }: {
    submissionErrors?: boolean;
    normalizeTurnIdentity?: boolean;
    forceError?: boolean;
    modelProjection?: (value: unknown) => unknown;
    compactText?: boolean;
  } = {}
) {
  const normalized = normalizeTurnIdentity ? withTurnIdentity(result) : result;
  const sanitized = sanitizeModelFacingValue(normalized);
  const modelFacing = modelProjection
    ? modelProjection(sanitized)
    : sanitized;
  const submissionError = submissionErrors && isSubmissionError(normalized);
  return {
    content: [
      {
        type: "text" as const,
        text: compactText
          ? JSON.stringify(modelFacing)
          : JSON.stringify(modelFacing, null, 2)
      }
    ],
    details: modelFacing,
    ...(submissionError || forceError ? { isError: true } : {})
  };
}

async function privateList(
  api,
  options: { reconcile?: boolean } = {}
): Promise<Record<string, unknown>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = ["list"];
  if (options.reconcile !== false) args.push("--reconcile");
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(config.idleTimeoutMinutes)
  );
  return runHostAwareCli(api, args);
}

async function privateThreadDiscovery(
  api,
  terminalId: string
): Promise<Record<string, unknown>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = [
    "list-resumable-threads",
    "--terminal",
    terminalId
  ];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", stringValue(config.codexHome));
  return runHostAwareCli(api, args);
}

function rememberDisplayedModelOptionsOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  requestedTerminalIdValue: unknown,
  result: unknown
): void {
  const sessionKey = requiredOpenClawSessionKey(sessionKeyValue);
  const sessionId = requiredOpenClawSessionId(sessionIdValue);
  const requestedTerminalId = requiredString(
    requestedTerminalIdValue,
    "terminal_id"
  );
  if (!isRecord(result)) {
    throw new Error("model-options returned an invalid result");
  }
  const terminalId = requiredString(result.terminal_id, "model-options terminal_id");
  if (terminalId !== requestedTerminalId) {
    throw new Error("model-options returned a different terminal");
  }
  const scope = requiredModelSwitchScope(result.agent, result.scope);
  const models = modelOptionsCatalog(result.models);
  const args = setModelActionArguments(result);
  if (stringValue(args.terminal ?? args.terminal_id) !== terminalId) {
    throw new Error("set-model action belongs to a different terminal");
  }
  const catalogFingerprint = requiredString(
    args.expected_catalog_fingerprint,
    "current internal model catalog authority"
  );
  if (catalogFingerprint !== stringValue(result.catalog_fingerprint)) {
    throw new Error("set-model action does not match the displayed catalog");
  }
  const key = modelOptionsOfferKey(sessionKey, sessionId, terminalId);
  consumeOpenClawPrivateAuthorityOffer(api, key);
  rememberOpenClawPrivateAuthorityOffer(api, key, {
    fingerprint: catalogFingerprint,
    args,
    scope,
    models
  });
}

function modelOptionsCatalog(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("model-options returned no semantic model choices");
  }
  const models = value.map((entry) => {
    if (!isRecord(entry)) throw new Error("model-options returned an invalid model");
    const id = requiredModelSemanticValue(entry.id, "model id", 160);
    if (!Array.isArray(entry.reasoning_efforts)) {
      throw new Error(`model ${id} has no reasoning-effort catalog`);
    }
    const reasoningEfforts = entry.reasoning_efforts.map((effort) =>
      requiredReasoningEffort(effort, `reasoning effort for ${id}`)
    );
    if (new Set(reasoningEfforts).size !== reasoningEfforts.length) {
      throw new Error(`model ${id} has duplicate reasoning efforts`);
    }
    return { id, reasoning_efforts: reasoningEfforts };
  });
  const ids = models.map((model) => String(model.id));
  if (new Set(ids).size !== ids.length) {
    throw new Error("model-options returned duplicate model ids");
  }
  return models;
}

function setModelActionArguments(
  result: Record<string, unknown>
): Record<string, unknown> {
  const availableActions = isRecord(result.available_actions)
    ? result.available_actions
    : undefined;
  const action = isRecord(availableActions?.set_model)
    ? availableActions.set_model
    : undefined;
  if (
    action?.tool !== "agent_knock_knock_set_model" ||
    !isRecord(action.arguments)
  ) {
    throw new Error("model-options did not advertise a typed set-model action");
  }
  requiredString(
    action.arguments.expected_binding_token,
    "current internal set-model binding authority"
  );
  return action.arguments;
}

function requiredModelSwitchScope(agentValue: unknown, scopeValue: unknown): string {
  const agent = requiredString(agentValue, "model-options agent");
  const scope = requiredString(scopeValue, "model-options scope");
  const expected = agent === "codex"
    ? "current_and_new_sessions"
    : agent === "claude"
      ? "current_session"
      : undefined;
  if (!expected || scope !== expected) {
    throw new Error("model-options returned an unsupported agent or mutation scope");
  }
  return scope;
}

function modelOptionsOfferKey(
  sessionKey: string,
  sessionId: string,
  terminalId: string
): OpenClawPrivateAuthorityOfferKey {
  return privateAuthorityOfferKey(
    sessionKey,
    sessionId,
    MODEL_OPTIONS_AUTHORITY_KIND,
    { type: "terminal_id", id: terminalId }
  );
}

function buildPrivateSetModelArgs(
  api,
  params: Record<string, unknown>,
  context: { sessionKey: string; sessionId: string }
): string[] {
  assertOnlyModelControlParameters(
    params,
    ["terminal_id", "model", "reasoning_effort"],
    "set_model"
  );
  const terminalId = requiredString(params.terminal_id, "terminal_id");
  const model = requiredModelSemanticValue(params.model, "model", 160);
  const reasoningEffort = requiredReasoningEffort(
    params.reasoning_effort,
    "reasoning_effort"
  );
  const offered = consumeOpenClawPrivateAuthorityOffer<
    DisplayedModelOptionsOfferPayload
  >(api, modelOptionsOfferKey(context.sessionKey, context.sessionId, terminalId));
  if (!offered || !isRecord(offered.args) || !Array.isArray(offered.models)) {
    throw new Error(
      "set_model requires current choices shown by agent_knock_knock_model_options in this controller conversation; refresh model options and choose one exact semantic tuple"
    );
  }
  assertOfferedModelTuple(offered.models, model, reasoningEffort);
  const offeredTerminalId = stringValue(
    offered.args.terminal ?? offered.args.terminal_id
  );
  if (offeredTerminalId !== terminalId) {
    throw new Error("the displayed set-model action belongs to another terminal");
  }
  const fingerprint = requiredString(
    offered.args.expected_catalog_fingerprint,
    "current internal model catalog authority"
  );
  if (fingerprint !== offered.fingerprint) {
    throw new Error("the displayed model catalog authority changed");
  }
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = buildAkkCommandCliArgs(
    {
      action: "set-model",
      terminalId,
      model,
      reasoningEffort
    },
    config,
    {
      expectedBindingToken: offered.args.expected_binding_token,
      expectedCatalogFingerprint: fingerprint
    }
  );
  if (!args) throw new Error("could not build set-model command");
  return args;
}

function assertOnlyModelControlParameters(
  params: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const unexpected = Object.keys(params).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new Error(
      `${label} accepts only typed semantic fields; raw commands, keys, menu indexes, scope, labels, tokens, and fingerprints are forbidden`
    );
  }
}

function assertOfferedModelTuple(
  modelEntries: readonly unknown[],
  model: string,
  reasoningEffort: string
): void {
  const entry = modelEntries.find((candidate) =>
    isRecord(candidate) && candidate.id === model
  );
  if (!isRecord(entry) || !Array.isArray(entry.reasoning_efforts)) {
    throw new Error("model was not advertised by the current native catalog");
  }
  if (
    !entry.reasoning_efforts.includes(reasoningEffort)
  ) {
    throw new Error(
      "reasoning_effort was not advertised for this model by the current native catalog"
    );
  }
}

function requiredModelSemanticValue(
  value: unknown,
  label: string,
  maxLength: number
): string {
  const text = requiredString(value, label);
  if (
    text.length > maxLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/+\-]*$/u.test(text)
  ) {
    throw new Error(`${label} must be one exact advertised semantic id`);
  }
  return text;
}

function requiredReasoningEffort(value: unknown, label: string): string {
  const text = requiredString(value, label);
  if (text.length > 64 || !/^[a-z][a-z0-9_-]*$/u.test(text)) {
    throw new Error(`${label} must be one exact advertised semantic value`);
  }
  return text;
}

async function privateTerminalActionArguments(
  api,
  terminalId: string,
  tool: string,
  options: { reconcile?: boolean } = {}
): Promise<Record<string, unknown>> {
  return privateActionArguments(api, {
    tool,
    terminalId,
    reconcile: options.reconcile,
    matches: (argumentsValue) =>
      stringValue(argumentsValue.terminal_id) === terminalId
  });
}

async function privateActionArguments(
  api,
  input: {
    tool: string;
    terminalId?: string;
    reconcile?: boolean;
    matches: (argumentsValue: Record<string, unknown>) => boolean;
  }
): Promise<Record<string, unknown>> {
  const result = await privateList(api, { reconcile: input.reconcile });
  const terminals = input.terminalId
    ? terminalRows(result).filter((terminal) =>
        stringValue(terminal.id) === input.terminalId
      )
    : terminalRows(result);
  if (input.terminalId && terminals.length !== 1) {
    throw new Error(
      `terminal ${input.terminalId} is not uniquely present in the current AKK list`
    );
  }
  const candidates = (
    input.tool === "agent_knock_knock_close"
      ? authoritativeHandoffActionArguments(terminals)
      : terminals.flatMap((terminal) =>
          authoritativeTerminalActionArguments(terminal, input.tool)
        )
  ).filter(input.matches);
  const uniqueCandidates = [...new Map(candidates.map((candidate) => [
    JSON.stringify(candidate),
    candidate
  ])).values()];
  if (uniqueCandidates.length !== 1) {
    throw new Error(
      `the current AKK list does not advertise one exact ${input.tool} action for the requested semantic target`
    );
  }
  return uniqueCandidates[0]!;
}

function rememberDisplayedPrivateAuthorityOffers(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  rememberDisplayedHandoffActions(api, sessionKey, sessionId, result);
  rememberDisplayedReconcileActions(api, sessionKey, sessionId, result);
}

function rememberDisplayedHandoffActions(
  api: object,
  sessionKey: string,
  sessionId: string,
  result: Record<string, unknown>
): void {
  for (const args of uniqueArgumentObjects(
    authoritativeHandoffActionArguments(terminalRows(result))
  )) {
    const turnId = stringValue(args.turn_id ?? args.conversation_id);
    if (
      !turnId ||
      stringValue(args.reason) !== "superseded_by_human_context_switch" ||
      !stringValue(args.expected_handoff_token)
    ) {
      continue;
    }
    rememberOpenClawPrivateAuthorityOffer(
      api,
      privateAuthorityOfferKey(
        sessionKey,
        sessionId,
        HANDOFF_AUTHORITY_KIND,
        { type: "turn_id", id: turnId }
      ),
      { args }
    );
  }
}

function rememberDisplayedReconcileActions(
  api: object,
  sessionKey: string,
  sessionId: string,
  result: Record<string, unknown>
): void {
  for (const args of uniqueArgumentObjects(
    terminalRows(result).flatMap((terminal) =>
      authoritativeTerminalActionArguments(
        terminal,
        "agent_knock_knock_reconcile_binding"
      )
    )
  )) {
    const terminalId = stringValue(args.terminal_id);
    const conflictingSessionId = stringValue(args.conflicting_session_id);
    if (!terminalId || !conflictingSessionId) continue;
    rememberOpenClawPrivateAuthorityOffer(
      api,
      privateAuthorityOfferKey(
        sessionKey,
        sessionId,
        RECONCILE_BINDING_AUTHORITY_KIND,
        { type: "terminal_id", id: terminalId }
      ),
      { args }
    );
  }
}

function rememberDisplayedApprovalOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  const decisionFingerprints = currentApprovalDecisionFingerprints(result);
  const fingerprint = decisionFingerprints.approve_once;
  if (!fingerprint) return;
  const target = approvalTargetFromStatus(result);
  if (!target) return;
  rememberOpenClawPrivateAuthorityOffer(
    api,
    openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target),
    {
      fingerprint,
      decision_fingerprints: decisionFingerprints
    }
  );
}

interface DisplayedInteractionOfferPayload
  extends OpenClawPrivateAuthorityOfferPayload {
  readonly interaction_state?: unknown;
}

interface DisplayedInteractionStatus {
  readonly fields: Record<string, unknown>;
  readonly expectedSubjectKind: OpenClawInteractionAuthoritySubjectKind;
  readonly expectedSubjectId?: string;
}

interface OpenClawInteractionSubjectTarget {
  readonly kind: OpenClawInteractionAuthoritySubjectKind;
  readonly id: string;
  readonly cliOption: "--turn" | "--watch";
}

function rememberDisplayedInteractionOffer(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  result: unknown
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId || !isRecord(result)) return;
  const displayed = displayedInteractionStatus(result);
  if (!displayed) return;
  const expectedSubjectId = stringValue(displayed.expectedSubjectId);
  if (!expectedSubjectId || expectedSubjectId === "unknown") return;
  invalidateOpenClawInteractionAuthorityOffersForSubject(
    api,
    sessionKey,
    sessionId,
    displayed.expectedSubjectKind,
    expectedSubjectId
  );
  const fingerprint = stringValue(
    displayed.fields.interaction_prompt_fingerprint
  );
  if (!isExactInteractionFingerprint(fingerprint)) return;
  let interactionState: TerminalInteractionAnyProjection;
  try {
    interactionState = validateAnyTerminalInteractionProjection(
      displayed.fields.interaction_state
    );
  } catch {
    return;
  }
  const subject = interactionProjectionSubject(interactionState);
  if (
    interactionState.state !== "pending" ||
    interactionState.capabilities.respond !== true ||
    subject.kind !== displayed.expectedSubjectKind ||
    subject.id !== expectedSubjectId ||
    (
      interactionState.version === TERMINAL_INTERACTION_SUBJECT_VERSION &&
      (
        interactionState.response_authority !== "executable" ||
        interactionState.prompt_fingerprint !== fingerprint
      )
    )
  ) {
    return;
  }
  rememberOpenClawPrivateAuthorityOffer(
    api,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      subject.kind,
      subject.id,
      interactionState.interaction_id
    ),
    {
      fingerprint,
      interaction_state: interactionState
    }
  );
}

function invalidateRequestedInteractionOffers(
  api: object,
  sessionKeyValue: unknown,
  sessionIdValue: unknown,
  params: Record<string, unknown>
): void {
  const sessionKey = stringValue(sessionKeyValue);
  const sessionId = stringValue(sessionIdValue);
  if (!sessionKey || !sessionId) return;
  const watchId = stringValue(params.watch_id);
  if (watchId) {
    invalidateOpenClawInteractionAuthorityOffersForSubject(
      api,
      sessionKey,
      sessionId,
      "terminal_watch",
      watchId
    );
    return;
  }
  const turnId = stringValue(params.turn_id);
  if (!turnId) return;
  invalidateOpenClawInteractionAuthorityOffersForSubject(
    api,
    sessionKey,
    sessionId,
    "managed_turn",
    turnId
  );
}

function displayedInteractionStatus(
  result: Record<string, unknown>
): DisplayedInteractionStatus | undefined {
  const watch = isRecord(result.watch) ? result.watch : undefined;
  if (watch) {
    return {
      fields: watch,
      expectedSubjectKind: "terminal_watch",
      expectedSubjectId: stringValue(watch.watch_id)
    };
  }
  const terminalStatus = isRecord(result.terminal_status)
    ? result.terminal_status
    : undefined;
  if (terminalStatus) {
    return {
      fields: terminalStatus,
      expectedSubjectKind: "managed_turn",
      expectedSubjectId: publicTurnIdentity(result).turnId
    };
  }
  if (result.interaction_state === undefined) return undefined;
  const watchId = stringValue(result.watch_id);
  return {
    fields: result,
    expectedSubjectKind: watchId ? "terminal_watch" : "managed_turn",
    expectedSubjectId: watchId ?? publicTurnIdentity(result).turnId
  };
}

function interactionProjectionSubject(
  projection: TerminalInteractionAnyProjection
): Pick<OpenClawInteractionSubjectTarget, "kind" | "id"> {
  if (projection.version === TERMINAL_INTERACTION_SUBJECT_VERSION) {
    return {
      kind: projection.subject.kind,
      id: terminalInteractionSubjectId(projection.subject)
    };
  }
  return { kind: "managed_turn", id: projection.turn_id };
}

function approvalTargetFromStatus(
  result: Record<string, unknown>
): OpenClawPrivateAuthorityTarget | undefined {
  const conversationId = stringValue(result.conversation_id);
  if (
    stringValue(result.source) === "terminal_control" ||
    conversationId?.startsWith("terminal:")
  ) {
    return conversationId
      ? { type: "terminal_id", id: conversationId }
      : undefined;
  }
  const { turnId } = publicTurnIdentity(result);
  return turnId && turnId !== "unknown"
    ? { type: "turn_id", id: turnId }
    : undefined;
}

function uniqueArgumentObjects(
  candidates: Record<string, unknown>[]
): Record<string, unknown>[] {
  return [...new Map(
    candidates.map((args) => [
      JSON.stringify(args),
      args
    ])
  ).values()];
}

function privateAuthorityOfferKey(
  sessionKey: string,
  sessionId: string,
  kind: string,
  target: OpenClawPrivateAuthorityTarget
): OpenClawPrivateAuthorityOfferKey {
  return { sessionKey, sessionId, kind, target };
}

async function consumeDisplayedPrivateAction(
  api: object,
  input: {
    sessionKey: string;
    sessionId: string;
    kind: string;
    target: OpenClawPrivateAuthorityTarget;
    tool: string;
    terminalId?: string;
    matches: (argumentsValue: Record<string, unknown>) => boolean;
  }
): Promise<Record<string, unknown>> {
  const offered = consumeOpenClawPrivateAuthorityOffer(api, {
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    kind: input.kind,
    target: input.target
  });
  if (!offered || !isRecord(offered.args)) {
    throw new Error(
      `${input.tool} requires a current action shown by AKK list in this controller session; refresh list, review it, and explicitly confirm again`
    );
  }
  const current = await privateActionArguments(api, input);
  if (JSON.stringify(current) !== JSON.stringify(offered.args)) {
    throw new Error(
      `${input.tool} authority changed after it was shown; refresh AKK list, review the current action, and explicitly confirm again`
    );
  }
  return current;
}

function terminalRows(result: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(result.terminals)
    ? result.terminals.filter(isRecord)
    : [];
}

function authoritativeTerminalActionArguments(
  terminal: Record<string, unknown>,
  tool: string
): Record<string, unknown>[] {
  const availableActions = isRecord(terminal.available_actions)
    ? terminal.available_actions
    : undefined;
  if (!availableActions) return [];
  return Object.values(availableActions).flatMap((action) =>
    isRecord(action) && action.tool === tool && isRecord(action.arguments)
      ? [action.arguments]
      : []
  );
}

function authoritativeHandoffActionArguments(
  terminals: Record<string, unknown>[]
): Record<string, unknown>[] {
  return terminals.flatMap((terminal) => {
    const decision = isRecord(terminal.handoff_decision)
      ? terminal.handoff_decision
      : undefined;
    const choices = isRecord(decision?.choices) ? decision.choices : undefined;
    const takeOver = isRecord(choices?.take_over_current)
      ? choices.take_over_current
      : undefined;
    const action = isRecord(takeOver?.action) ? takeOver.action : undefined;
    return decision?.kind === "active_turn_requires_decision" &&
        action?.tool === "agent_knock_knock_close" &&
        action.requires_explicit_user_confirmation === true &&
        isRecord(action.arguments)
      ? [action.arguments]
      : [];
  });
}

function currentApprovalFingerprint(
  result: unknown,
  decision: TerminalApprovalDecision
): string {
  const fingerprint = isRecord(result)
    ? currentApprovalDecisionFingerprints(result)[decision]
    : undefined;
  if (!fingerprint) {
    throw new Error(
      `the current status does not contain one exact ${decision} choice; refresh status and ask the user to review it again`
    );
  }
  return fingerprint;
}

async function buildPrivateApprovalArgs(
  api,
  params: Record<string, unknown>,
  { sessionKey, sessionId }: { sessionKey: string; sessionId: string }
): Promise<string[]> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const turnId = stringValue(params.turn_id);
  const terminalId = stringValue(params.terminal_id);
  const decisionValue = params.decision ?? "approve_once";
  if (!isTerminalApprovalDecision(decisionValue)) {
    throw new Error("decision must be one of: approve_once, reject");
  }
  const decision = decisionValue;
  if (Boolean(turnId) === Boolean(terminalId)) {
    throw new Error("approve requires exactly one of turn_id or terminal_id");
  }
  if (terminalId && decision !== "approve_once") {
    throw new Error(
      "terminal-scoped approval supports approve_once only; reject requires an exact managed Turn"
    );
  }
  const target: OpenClawPrivateAuthorityTarget = terminalId
    ? { type: "terminal_id", id: terminalId }
    : { type: "turn_id", id: requiredString(turnId, "turn_id") };
  const offered = consumeOpenClawPrivateAuthorityOffer<
    OpenClawPrivateAuthorityOfferPayload
  >(api, openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target));
  const offeredDecisions = isRecord(offered?.decision_fingerprints)
    ? offered.decision_fingerprints
    : undefined;
  const offeredFingerprint = stringValue(offeredDecisions?.[decision]) ??
    (decision === "approve_once" ? stringValue(offered?.fingerprint) : undefined) ??
    (isRecord(offered?.args)
      ? decision === "approve_once"
        ? stringValue(offered.args.expected_approval_fingerprint)
        : undefined
      : undefined);
  if (!isExactApprovalFingerprint(offeredFingerprint)) {
    throw new Error(
      "approve requires a current approval request shown by agent_knock_knock_status in this controller conversation; refresh status, ask the user to review it, and explicitly confirm again"
    );
  }
  const action = terminalId
    ? await privateActionArguments(api, {
        tool: "agent_knock_knock_approve",
        terminalId,
        matches: (argumentsValue) => stringValue(
          argumentsValue.terminal_id ?? argumentsValue.conversation_id
        ) === terminalId
      })
    : undefined;
  const statusArgs = ["status", "--reconcile"];
  if (terminalId) {
    statusArgs.push("--conversation", terminalId);
  } else {
    statusArgs.push("--turn", requiredString(turnId, "turn_id"));
  }
  pushOptional(statusArgs, "--store-dir", resolvePluginStoreDir(config));
  const args = ["approve"];
  if (terminalId) {
    args.push("--conversation", terminalId);
  } else {
    args.push("--turn", requiredString(turnId, "turn_id"));
  }
  const currentFingerprint = currentApprovalFingerprint(
    await runHostAwareCli(api, statusArgs),
    decision
  );
  if (currentFingerprint !== offeredFingerprint) {
    throw new Error(
      "the approval request changed after it was shown; refresh AKK status, ask the user to review the current request, and explicitly confirm again"
    );
  }
  args.push("--decision", decision);
  args.push("--expected-approval-fingerprint", currentFingerprint);
  if (terminalId) {
    args.push(
      "--expected-terminal-token",
      requiredString(
        action?.expected_terminal_token,
        "current internal terminal approval authority"
      )
    );
  }
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  return args;
}

function buildPrivateInteractionResponseArgs(
  api,
  params: Record<string, unknown>,
  { sessionKey, sessionId }: { sessionKey: string; sessionId: string }
): string[] {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const requestedSubject = requestedInteractionSubject(params);
  const interactionId = requiredTerminalInteractionIdentifier(
    params.interaction_id,
    "interaction_id"
  );
  const offered = consumeOpenClawPrivateAuthorityOffer<
    DisplayedInteractionOfferPayload
  >(
    api,
    openClawInteractionAuthorityOfferKey(
      sessionKey,
      sessionId,
      requestedSubject.kind,
      requestedSubject.id,
      interactionId
    )
  );
  const fingerprint = stringValue(offered?.fingerprint);
  if (
    !isExactInteractionFingerprint(fingerprint) ||
    offered?.interaction_state === undefined
  ) {
    throw new Error(
      "respond_interaction requires a current pending interaction shown by agent_knock_knock_status in this controller conversation; refresh status, review the current questions, and respond again"
    );
  }
  const projection = validateAnyTerminalInteractionProjection(
    offered.interaction_state
  );
  assertInteractionSubjectMatchesProjection(requestedSubject, projection);
  const responseInput = interactionResponseForProjection(params, projection);
  const response = validateAnyTerminalInteractionResponse(
    responseInput,
    projection,
    {
      // This consumes a still-live, session/incarnation-bound private offer.
      // The CLI/bridge path always performs exact live terminal recaptures
      // before it can reserve or dispatch input, so projection expiry is a
      // recheck trigger rather than proof that the questionnaire disappeared.
      allowExpiredForLiveRecapture: true
    }
  );
  const args = [
    "respond-interaction",
    requestedSubject.cliOption,
    requestedSubject.id,
    "--interaction",
    response.interaction_id,
    "--response-json",
    JSON.stringify(response),
    "--expected-interaction-fingerprint",
    fingerprint,
    "--expected-interaction-expires-at",
    projection.expires_at,
    "--openclaw-session",
    sessionKey
  ];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  return args;
}

function requestedInteractionSubject(
  params: Record<string, unknown>
): OpenClawInteractionSubjectTarget {
  const hasTurn = Object.hasOwn(params, "turn_id");
  const hasWatch = Object.hasOwn(params, "watch_id");
  if (hasTurn === hasWatch) {
    throw new Error(
      "respond_interaction requires exactly one of turn_id or watch_id"
    );
  }
  return hasTurn
    ? {
        kind: "managed_turn",
        id: requiredTerminalInteractionIdentifier(params.turn_id, "turn_id"),
        cliOption: "--turn"
      }
    : {
        kind: "terminal_watch",
        id: requiredTerminalInteractionIdentifier(params.watch_id, "watch_id"),
        cliOption: "--watch"
      };
}

function assertInteractionSubjectMatchesProjection(
  requested: OpenClawInteractionSubjectTarget,
  projection: TerminalInteractionAnyProjection
): void {
  const projected = interactionProjectionSubject(projection);
  if (requested.kind !== projected.kind || requested.id !== projected.id) {
    throw new Error(
      "respond_interaction target does not match the displayed interaction subject; refresh status and respond to its exact turn_id or watch_id"
    );
  }
}

function interactionResponseForProjection(
  params: Record<string, unknown>,
  projection: TerminalInteractionAnyProjection
): Record<string, unknown> {
  if (projection.version !== TERMINAL_INTERACTION_SUBJECT_VERSION) {
    return params;
  }
  return {
    interaction_id: params.interaction_id,
    subject: projection.subject,
    ...(projection.subject.kind === "managed_turn"
      ? { turn_id: params.turn_id }
      : {}),
    answers: params.answers
  };
}

function isExactApprovalFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isExactInteractionFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function currentApprovalDecisionFingerprints(
  result: Record<string, unknown>
): Partial<Record<TerminalApprovalDecision, string>> {
  const terminalStatus = isRecord(result.terminal_status)
    ? result.terminal_status
    : undefined;
  const states = [
    isRecord(result.approval_state) ? result.approval_state : undefined,
    isRecord(terminalStatus?.approval_state)
      ? terminalStatus.approval_state
      : undefined
  ];
  const found = new Map<TerminalApprovalDecision, Set<string>>();
  const remember = (decision: TerminalApprovalDecision, value: unknown) => {
    if (!isExactApprovalFingerprint(value)) return;
    const fingerprints = found.get(decision) ?? new Set<string>();
    fingerprints.add(value);
    found.set(decision, fingerprints);
  };
  for (const state of states) {
    const fingerprint = state?.approvable === true
      ? stringValue(state.fingerprint)
      : undefined;
    remember("approve_once", fingerprint);
    if (state?.approvable !== true || !Array.isArray(state.choices)) continue;
    for (const choice of state.choices) {
      if (
        isRecord(choice) &&
        isTerminalApprovalDecision(choice.decision)
      ) {
        remember(choice.decision, choice.fingerprint);
      }
    }
  }
  return Object.fromEntries(
    [...found.entries()].flatMap(([decision, fingerprints]) =>
      fingerprints.size === 1
        ? [[decision, [...fingerprints][0]!]]
        : []
    )
  );
}

function sanitizeModelFacingValue(
  value: unknown,
  parentKey?: string,
  path: readonly string[] = []
): unknown {
  if (Array.isArray(value)) {
    if (parentKey === "missing_required") {
      return value.filter((item) =>
        typeof item !== "string" ||
          !isAkkModelFacingPrivateAuthorityField(item)
      );
    }
    return value.map((item, index) =>
      sanitizeModelFacingValue(item, parentKey, [...path, String(index)])
    );
  }
  if (!isRecord(value)) {
    if (typeof value !== "string") {
      return value;
    }
    if (isAkkModelFacingDiagnosticField(parentKey)) {
      return sanitizeAkkModelFacingDiagnosticText(value);
    }
    return isLegacyAuthorityInstructionPath(path)
      ? sanitizeAkkModelFacingLegacyAuthorityInstructionText(value)
      : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      isAkkModelFacingPrivateAuthorityField(key) ||
      key === "_user_explicit_composer_ready" ||
      key === "composer_draft" ||
      key === "selection_snapshot" ||
      key === "live_native_thread_id" ||
      (key === "fingerprint" && parentKey === "approval_state")
    ) {
      continue;
    }
    if (key === "interaction_state") {
      try {
        output[key] = sanitizeModelFacingValue(
          validateAnyTerminalInteractionProjection(item),
          undefined,
          [...path, key]
        );
      } catch {
        continue;
      }
      continue;
    }
    output[key] = sanitizeModelFacingValue(item, key, [...path, key]);
  }
  if (output.tool === "agent_knock_knock_send" && isRecord(output.arguments)) {
    const selector = stringValue(output.arguments.selector);
    if (selector && /^terminal:v[0-9]+:\S+$/u.test(selector)) {
      const { selector: _selector, ...argumentsValue } = output.arguments;
      output.arguments = { ...argumentsValue, terminal_id: selector };
    }
  }
  if (output.tool === "agent_knock_knock_approve" && isRecord(output.arguments)) {
    const conversationId = stringValue(output.arguments.conversation_id);
    if (conversationId && /^terminal:v[0-9]+:\S+$/u.test(conversationId)) {
      const { conversation_id: _conversationId, ...argumentsValue } =
        output.arguments;
      output.arguments = { ...argumentsValue, terminal_id: conversationId };
    }
    const approvalArguments = isRecord(output.arguments)
      ? output.arguments
      : {};
    const terminalId = stringValue(approvalArguments.terminal_id);
    output.before_call = {
      tool: "agent_knock_knock_status",
      arguments: terminalId
        ? { conversation_id: terminalId }
        : { ...approvalArguments },
      use:
        "Show the current approval request to the user. After explicit confirmation, call approve with only this semantic target; AKK revalidates the prompt privately."
    };
    delete output.missing_required;
  }
  if (
    output.tool === "agent_knock_knock_set_model" &&
    isRecord(output.arguments)
  ) {
    const terminalId = stringValue(
      output.arguments.terminal_id ?? output.arguments.terminal
    );
    output.arguments = terminalId && /^terminal:v[0-9]+:\S+$/u.test(terminalId)
      ? { terminal_id: terminalId }
      : {};
    if (Array.isArray(output.missing_required)) {
      output.missing_required = output.missing_required.filter((field) =>
        field === "model" || field === "reasoning_effort"
      );
    }
  }
  return output;
}

function isLegacyAuthorityInstructionPath(path: readonly string[]): boolean {
  const normalized = path.map(normalizeAkkModelFacingFieldName);
  if (normalized.at(-1) !== "body") return false;
  const callbackMessageBody = normalized.slice(-3).join(".") ===
    "callbackdelivery.message.body";
  return callbackMessageBody || normalized.includes("recentevents");
}

function modelFacingToolError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return error;
  }
  return new Error(modelFacingErrorMessage(error));
}

function modelFacingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeAkkModelFacingDiagnosticText(message);
}

function isBlockedTerminalDispatchResult(result: unknown): boolean {
  return Boolean(
    isRecord(result) &&
    result.source === "terminal_control" &&
    result.terminal_dispatch_resolved !== true
  );
}

function isSubmissionError(result: unknown): boolean {
  if (!isRecord(result)) {
    return false;
  }
  if (isSuccessfulTerminalDispatch(result)) {
    return false;
  }
  if (terminalSubmissionReported(result)) {
    return !isAkkNativeSubmissionAccepted(result);
  }
  return [
    "submission_unfenced",
    "submission_uncertain",
    "submission_aborted",
    "submission_pending_acceptance",
    "submission_not_accepted"
  ].includes(String(result.status ?? "")) ||
    ["uncertain", "aborted", "pending_acceptance", "not_accepted"].includes(
      String(result.submission_outcome ?? "")
    ) ||
    result.status === "delivered_unfenced";
}

function terminalSubmissionReported(result: Record<string, unknown>): boolean {
  return result.submission_outcome !== undefined ||
    result.delivery_receipt !== undefined ||
    result.delivered !== undefined;
}

function withTurnIdentity(result) {
  if (!isRecord(result)) {
    return result;
  }
  const sources = [
    { label: "result", value: result },
    { label: "result.conversation", value: result.conversation },
    { label: "result.summary", value: result.summary },
    { label: "result.message", value: result.message }
  ];
  const compatibilityId = consistentResultIdentity(
    "conversation_id",
    sources
  );
  const explicitSessionId = consistentResultIdentity("session_id", sources);
  const explicitTurnId = consistentResultIdentity("turn_id", sources);
  const hasModernIdentity = Boolean(explicitSessionId || explicitTurnId);
  if (hasModernIdentity && (!explicitSessionId || !explicitTurnId)) {
    throw new Error(
      "agent-knock-knock CLI returned a partial session_id/turn_id identity"
    );
  }
  if (hasModernIdentity && !compatibilityId) {
    throw new Error(
      "agent-knock-knock CLI returned modern identity without conversation_id"
    );
  }
  if (hasModernIdentity && compatibilityId !== explicitTurnId) {
    throw new Error(
      "agent-knock-knock CLI returned conversation_id that differs from turn_id"
    );
  }
  if (!hasModernIdentity && !compatibilityId) {
    return result;
  }
  if (
    !hasModernIdentity &&
    (
      compatibilityId?.startsWith("terminal:") ||
      stringValue(result.source) === "terminal" ||
      (
        isRecord(result.summary) &&
        stringValue(result.summary.source) === "terminal"
      )
    )
  ) {
    return result;
  }
  const sessionId = explicitSessionId ?? compatibilityId;
  const turnId = explicitTurnId ?? compatibilityId;
  return {
    ...result,
    session_id: sessionId,
    turn_id: turnId
  };
}

function consistentResultIdentity(field, sources) {
  const values = sources.flatMap(({ label, value }) => {
    if (!isRecord(value) || !Object.hasOwn(value, field)) {
      return [];
    }
    const identity = stringValue(value[field]);
    if (!identity) {
      throw new Error(
        `agent-knock-knock CLI returned invalid ${label}.${field}`
      );
    }
    return [{ label, identity }];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.identity !== expected.identity) {
      throw new Error(
        `agent-knock-knock CLI returned conflicting ${field} between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.identity;
}

async function runDelegate(
  api,
  params,
  toolContext
): Promise<Record<string, any>> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const request = requiredString(params.request, "request");
  const openclawSession =
    stringValue(toolContext?.sessionKey) ??
    "agent:main:main";
  const args = [
    "delegate",
    "--request",
    request,
    "--background"
  ];

  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--message-id", stringValue(params.messageId));
  pushOptional(args, "--openclaw-session", openclawSession);
  pushOptional(args, "--gateway-method", CALLBACK_METHOD);
  pushOptional(args, "--gateway-session", openclawSession);
  pushOptional(args, "--openclaw-bin", stringValue(config.openclawBin));
  pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(config.idleTimeoutMinutes));
  pushOptional(args, "--agent-timeout-minutes", numberString(params.agentTimeoutMinutes) ?? numberString(config.agentTimeoutMinutes));
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));

  const parsed = withTurnIdentity(await runCliAsync(api, args));
  if (!isRecord(parsed)) {
    throw new Error("agent-knock-knock delegate returned a non-object result");
  }
  if (parsed.scope === "terminal_user_explicit") {
    // A uniquely delegated user-priority Send may deliberately complete
    // without creating a managed Turn. Preserve that terminal receipt for the
    // shared Send formatter instead of inventing Session/Turn identity.
    return {
      ...parsed,
      ...normalizedTerminalSendResultContract(parsed)
    };
  }
  const conversationId = stringValue(parsed.conversation_id) ??
    (isRecord(parsed.conversation)
      ? stringValue(parsed.conversation.conversation_id)
      : undefined);
  const sessionId = stringValue(parsed.session_id);
  const turnId = stringValue(parsed.turn_id);
  if (!conversationId || !sessionId || !turnId) {
    throw new Error("agent-knock-knock delegate returned incomplete Turn identity");
  }
  const parsedConversation = isRecord(parsed.conversation)
    ? parsed.conversation
    : undefined;
  const parsedPaths = isRecord(parsed.paths) ? parsed.paths : undefined;
  const parsedTerminalControl = isRecord(parsed.terminal_control)
    ? parsed.terminal_control
    : undefined;
  const statePath =
    parsedConversation?.state_path ??
    parsedPaths?.statePath;
  const logPath =
    parsedConversation?.event_log_path ??
    parsedPaths?.logPath;
  const submissionUncertain = parsed.submission_outcome === "uncertain";
  const submissionAborted = parsed.submission_outcome === "aborted";
  const submissionAccepted = parsed.submission_outcome === "agent_accepted" &&
    parsed.delivery_receipt === "agent_accepted" &&
    parsed.delivered === true;
  const submissionNotAccepted = parsed.submission_outcome === "not_accepted";
  const submissionPending = !submissionAccepted &&
    !submissionUncertain &&
    !submissionAborted &&
    !submissionNotAccepted;
  const submissionUnfenced = parsed.status === "delivered_unfenced";
  const agent =
    (isRecord(parsedConversation?.executor)
      ? stringValue(parsedConversation.executor.kind)
      : undefined) ??
    stringValue(parsed.agent);
  return {
    status: submissionUnfenced
      ? "submission_unfenced"
      : submissionUncertain
      ? "submission_uncertain"
      : submissionAborted
        ? "submission_aborted"
        : submissionNotAccepted
          ? "submission_not_accepted"
          : submissionPending
            ? "submission_pending_acceptance"
            : "async_pending",
    submission_status: submissionUnfenced
      ? "submitted_unfenced"
      : submissionUncertain
      ? "uncertain"
      : submissionAborted
        ? "aborted"
        : submissionNotAccepted
          ? "not_accepted"
          : submissionPending
            ? "pending_acceptance"
            : "accepted",
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: turnId,
    conversation_status: parsedConversation?.status,
    state_path: statePath,
    event_log_path: logPath,
    agent,
    executor: parsedConversation?.executor,
    session:
      (isRecord(parsedConversation?.executor)
        ? parsedConversation.executor.session
        : undefined) ??
      parsedTerminalControl?.target,
    openclaw_session: openclawSession,
    launched: parsed.launched === true,
    replayed: parsed.replayed === true,
    background: parsed.background === true,
    pid: parsed.pid ?? parsedTerminalControl?.panePid ?? null,
    callback_method: hostBridgePresentationApis.has(api)
      ? "command_json_v1"
      : CALLBACK_METHOD,
    ...normalizedTerminalSendResultContract(parsed),
    ...(submissionUnfenced
      ? {
          submission_outcome: "submitted",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK sent the terminal input but could not fence later side effects to an exact native session. Do not retry or continue automatically; inspect the pane and close this Turn."
        }
      : submissionUncertain
      ? {
          submission_outcome: "uncertain",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK could not prove whether the terminal accepted Enter. Do not retry automatically; inspect the exact AKK Turn record and shared terminal."
        }
      : submissionAborted
        ? parsed.safe_to_retry === true && parsed.do_not_retry !== true
          ? {
              submission_outcome: "aborted",
              safe_to_retry: true,
              do_not_retry: false,
              reason: parsed.reason,
              openclaw_next_action: parsed.openclaw_next_action,
              note:
                "AKK stopped before sending terminal input and durably proved a safe abort. The request may be retried."
            }
          : {
              submission_outcome: "aborted",
              safe_to_retry: false,
              do_not_retry: true,
              reason: parsed.reason,
              openclaw_next_action: parsed.openclaw_next_action,
              note:
                "AKK could not prove a durable safe abort. Do not retry automatically; inspect the exact Turn and terminal dispatch ledger."
            }
      : submissionNotAccepted
        ? {
            submission_outcome: "not_accepted",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved terminal transport but the exact draft is still present in the agent composer. Do not retry automatically; inspect the shared pane."
          }
      : submissionPending
        ? {
            submission_outcome: "pending_acceptance",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved only terminal transport and is still waiting for native agent acceptance. Do not retry or report the task as accepted."
          }
      : {
          openclaw_next_action: {
            action: "yield",
            reason:
              "The coding agent is working in the shared terminal. End this controller turn now and wait for an Agent Knock Knock callback.",
            do_not:
              "Do not poll terminal internals while waiting. Further communication must use Agent Knock Knock tools so the same shared terminal remains authoritative.",
            expected_callback:
              "The callback will be injected into this controller session by its configured callback transport."
          },
          note:
            "The task was sent to the shared terminal. The controller Host should yield now and wait for the callback turn."
        })
  };
}

function terminalMessageIdForToolCall({
  toolCallId: toolCallIdValue,
  sessionKey: sessionKeyValue,
  sessionId: sessionIdValue,
  toolName
}: {
  toolCallId: unknown;
  sessionKey: unknown;
  sessionId: unknown;
  toolName:
    | "agent_knock_knock_send"
    | "agent_knock_knock_identify_and_send"
    | "agent_knock_knock_respond";
}): string | undefined {
  const toolCallId = stringValue(toolCallIdValue);
  if (!toolCallId) {
    return undefined;
  }
  const sessionKey = stringValue(sessionKeyValue) ?? "agent:main:main";
  // sessionId is the OpenClaw conversation incarnation. It changes across
  // /new and /reset even when sessionKey remains stable. Keep a literal null
  // fallback so retries with the same legacy context remain deterministic.
  const sessionId = stringValue(sessionIdValue) ?? null;
  const digest = createHash("sha256")
    .update(JSON.stringify([sessionKey, sessionId, toolName, toolCallId]))
    .digest("hex");
  return `msg-openclaw-${digest}`;
}

function registerCliTool(
  api,
  {
    name,
    description,
    parameters,
    buildArgs,
    rememberResult = undefined,
    timeoutMs = undefined,
    normalizeTurnIdentity = true,
    modelProjection = undefined,
    compactText = false,
    isErrorResult = (_result: unknown) => false
  }: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    buildArgs: (
      params: Record<string, unknown>,
      toolContext?: { sessionKey?: unknown; sessionId?: unknown },
      toolCallId?: unknown
    ) => string[] | Promise<string[]>;
    rememberResult?: (
      result: unknown,
      params: Record<string, unknown>,
      toolContext?: { sessionKey?: unknown; sessionId?: unknown }
    ) => void;
    timeoutMs?: number;
    normalizeTurnIdentity?: boolean;
    modelProjection?: (value: unknown) => unknown;
    compactText?: boolean;
    isErrorResult?: (result: unknown) => boolean;
  }
) {
  defineSemanticCatalogTool(api, {
    label: semanticToolLabel(name),
    name,
    description,
    inputSchema: parameters,
    async execute(toolContext, toolCallId, params, signal) {
      return withHostBridgeInvocationSignal(signal, async () => {
        try {
          const result = await runHostAwareCli(
            api,
            await buildArgs(
              isRecord(params) ? params : {},
              toolContext,
              toolCallId
            ),
            timeoutMs === undefined ? {} : { timeoutMs }
          );
          if (typeof rememberResult === "function") {
            rememberResult(
              result,
              isRecord(params) ? params : {},
              toolContext
            );
          }
          if (name === "agent_knock_knock_list") {
            rememberDisplayedPrivateAuthorityOffers(
              api,
              toolContext?.sessionKey,
              toolContext?.sessionId,
              result
            );
          }
          const rendered = toolResult(result, {
            submissionErrors:
              name === "agent_knock_knock_respond" ||
              name === "agent_knock_knock_identify_and_send",
            normalizeTurnIdentity,
            modelProjection,
            compactText,
            forceError:
              typeof isErrorResult === "function" && isErrorResult(result) === true
          });
          return rendered;
        } catch (error) {
          throw modelFacingToolError(error);
        }
      });
    }
  });
}

function pushTurnTarget(args, params) {
  if (Object.hasOwn(params, "turn_id") && Object.hasOwn(params, "conversation_id")) {
    throw new Error("turn-target tools accept only one of turn_id or conversation_id");
  }
  const turnId = stringValue(params.turn_id);
  if (turnId) {
    args.push("--turn", authoritativeManagedId(turnId, "turn_id"));
    return;
  }
  args.push(
    "--conversation",
    requiredString(params.conversation_id, "turn_id")
  );
}

function authoritativeManagedId(value, name) {
  const id = requiredString(value, name).trim();
  if (
    /^(?:only|latest|codex|claude|(?:codex|claude):latest)$/iu.test(id) ||
    /^@[0-9a-f]+$/iu.test(id) ||
    /^terminal:/iu.test(id)
  ) {
    throw new Error(
      `${name} must be an authoritative managed id, not a discovery selector or terminal id`
    );
  }
  return id;
}

function assertExclusiveRecoveryFence(params) {
  const expectedMessageId = stringValue(params.expected_message_id);
  const expectedTransitionId = stringValue(params.expected_transition_id);
  const closeFenceCount = [expectedMessageId, expectedTransitionId]
    .filter(Boolean).length;
  if (closeFenceCount > 1) {
    throw new Error(
      "close accepts only one of expected_message_id or expected_transition_id"
    );
  }
  if (
    stringValue(params.reason) === "superseded_by_human_context_switch" &&
    (!stringValue(params.turn_id) || stringValue(params.conversation_id))
  ) {
    throw new Error(
      "human-context handoff Close requires the exact managed turn_id"
    );
  }
}

export function pushOptional(args, flag, value) {
  if (value !== undefined && value !== "") {
    args.push(flag, value);
  }
}

function numberString(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

function requiredString(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requiredOpenClawSessionKey(value: unknown): string {
  return requiredString(
    value,
    "Controller session identity for this confirmed action"
  );
}

function requiredOpenClawSessionId(value: unknown): string {
  return requiredString(
    value,
    "Controller conversation incarnation for this confirmed action"
  );
}

function requiredTerminalInteractionIdentifier(
  value: unknown,
  name: string
): string {
  const identifier = requiredString(value, name);
  if (
    identifier.length > TERMINAL_INTERACTION_LIMITS.maxIdentifierLength ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(identifier)
  ) {
    throw new Error(`${name} must be an exact safe interaction identifier`);
  }
  return identifier;
}

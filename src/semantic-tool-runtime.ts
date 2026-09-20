import { createHash, randomUUID } from "node:crypto";
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
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  formatAkkUnwatchCommandResult,
  formatAkkWatchCommandResult,
  isAkkRepairModelControlSuccess,
  isAkkSetModelSuccess,
  isAkkThreadTransitionSuccess,
  parseAkkCommand,
  resolvePluginStoreDir
} from "./semantic-tool-command-helpers.js";
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
} from "./semantic-tool-schemas.js";
import {
  beginSemanticToolCatalog,
  defineSemanticCatalogTool,
  finishSemanticToolCatalog,
  semanticToolLabel,
  type SemanticToolCatalog
} from "./semantic-tool-catalog.js";
import {
  normalizedTerminalSendResultContract
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
import {
  bindHostBridgeToolPresentation,
  formatApproveCommandResult,
  formatCancelCommandResult,
  formatCloseCommandResult,
  formatDelegateCommandResult,
  formatDoctorCommandResult,
  formatRenewCommandResult,
  formatRetryCallbackCommandResult,
  formatSendCommandResult,
  formatStatusCommandResult,
  isBlockedTerminalDispatchResult,
  isSubmissionError,
  modelFacingErrorMessage,
  modelFacingToolError,
  publicTurnIdentity,
  sendCommandResultIsError,
  toolResult,
  usesHostBridgeToolPresentation,
  withTurnIdentity
} from "./semantic-tool-presentation.js";
import {
  assertExclusiveRecoveryFence,
  authoritativeManagedId,
  numberString,
  pushOptional,
  pushTurnTarget,
  requiredControllerSessionId,
  requiredControllerSessionKey,
  requiredString,
  requiredTerminalInteractionIdentifier
} from "./semantic-tool-arguments.js";
import {
  buildPrivateApprovalArgs,
  buildPrivateInteractionResponseArgs,
  buildPrivateSetModelArgs,
  assertOnlyModelControlParameters,
  consumeDisplayedPrivateAction,
  invalidateRequestedInteractionOffers,
  privateActionArguments,
  privateTerminalActionArguments,
  privateThreadDiscovery,
  rememberDisplayedApprovalOffer,
  rememberDisplayedInteractionOffer,
  rememberDisplayedModelOptionsOffer,
  rememberDisplayedPrivateAuthorityOffers,
  RECONCILE_BINDING_AUTHORITY_KIND
} from "./semantic-tool-private-authority.js";

export {
  bindSemanticToolAsyncRelay,
  bindSemanticToolRelayEnvironment,
  bindSemanticToolRelayPath,
  defaultSemanticToolRelayPath,
  runCli,
  runCliAsync,
  withHostBridgeInvocationSignal
} from "./semantic-tool-relay.js";

export { bindHostBridgeToolPresentation } from "./semantic-tool-presentation.js";
export { pushOptional } from "./semantic-tool-arguments.js";

const MAX_DISPLAYED_RESUME_SNAPSHOTS = 512;
// Model discovery intentionally revalidates every native menu transition.
// Claude's live effort-ring walk can exceed the generic 90-second relay
// budget, while set-model performs discovery both before and after its one
// commit. Keep these operations bounded without killing the child midway
// through a verified native picker. The Host abort signal still cancels them.
const MODEL_OPTIONS_CLI_TIMEOUT_MS = 15 * 60_000;
const REPAIR_MODEL_CONTROL_CLI_TIMEOUT_MS = 2 * 60_000;
const SET_MODEL_CLI_TIMEOUT_MS = 30 * 60_000;
const CALLBACK_METHOD = AKK_CALLBACK_METHOD;

export type DisplayedResumeSnapshotMap = Map<
  string,
  { snapshotId: string; expiresAtMs: number }
>;

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
      "Use /akk <task> when exactly one send-ready coding-agent terminal pane should receive new work. Send-ready means an exact live process and terminal plus a scanned, non-blocked approval state. Parsed working activity and ordinary main-Composer visibility, stability, exactness, or existing draft contents do not veto this user-priority path. A proven input-owning native approval, questionnaire/editor, menu, or read-only viewer remains a zero-input boundary; profiled Codex 0.154.0/0.155.1 exact collapsed async-question summaries remain sendable, while expanded, clipped, or ambiguous editors do not. Codex sends C-u once to replace the current Composer; Claude Code uses a sentinel-backed native C-s stash-clear transaction that is independent of the cursor position and does not interrupt an active turn, then proves the main Composer empty. Each injects the request, waits through the paste window, and dispatches Enter exactly once; after text injection, no Composer observation may veto Enter. Managed Send may still require exact empty before input, while native inspection and native lifecycle input remain exact-empty-only. Broken or stale AKK management activity records do not veto the user's physical Send. Structured tools use only semantic identifiers returned by AKK: session_id for an exact managed context, terminal_id for the currently verified pane, turn_id for one managed Turn, watch_id for one Terminal Watch, and native_thread_id for one resumable native thread. Draft text, composer digests, and opaque freshness authority stay private; AKK revalidates them under its locks. Once the mutation sequence begins, an uncertain result must not be automatically retried. /akk watch is read-only and follows user intent: it prefers an exact task anchor, but version, artifact, managed ownership, and action-advertisement uncertainty degrade to a warning-bearing terminal-activity Watch instead of vetoing the request. New/clear/resume, approval, reconciliation, handoff, and recovery still require the documented user intent or explicit confirmation. AKK never starts a coding-agent process.",
      "Use /akk models on one exact currently advertised physical pane before /akk set-model. Profiled Codex 0.154.0/0.155.1 may use either one exact current native Session or a verified-zero-rollout pane; identify_foreground is diagnostic and is never a prerequisite for that zero-rollout path. Claude Code still requires one exact current native Session. Both steps require no active Turn and no approval, questionnaire/editor, or read-only viewer. model_options normally requires an empty Composer; when List binds it to one exact stable Codex /model residual, it may continue only that residual into read-only catalog discovery. repair_model_control remains the separate clear-only alternative and never presses Enter or selects anything. Only ids and reasoning efforts from that current native catalog are valid. Codex changes the current session and persists the selected model for future sessions; ordinary efforts, including max, are also persisted, while ultra remains current-session-only and Codex chooses a non-ultra future fallback. Claude Code changes only the current session. Read effective and new_session_defaults separately. Model control never accepts slash text, raw keys, menu indexes, display labels, scope overrides, or private authority; an uncertain outcome must not be retried automatically."
    ],
    execute: async (ctx) => handleAkkCommand(api, ctx, displayedResumeSnapshots)
  };

  registerSemanticListTool(api);

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
        sessionKey: requiredControllerSessionKey(toolContext?.sessionKey),
        sessionId: requiredControllerSessionId(toolContext?.sessionId),
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
      "Start a new AKK Turn, use one advertised terminal_user_explicit user-priority send, or explicitly recover one current uncertain submission only through its advertised retry_submission action. Ordinary send requires request and may use session_id or terminal_id exactly as advertised. terminal_user_explicit requires one exact live physical terminal/process, a scanned non-blocked approval state, and no input-owning native questionnaire/editor, menu, or read-only viewer; parsed working activity, Codex rollout ambiguity, AKK management state, ordinary main-Composer visibility, stability, exactness, and existing draft contents do not veto physical delivery. Profiled Codex 0.154.0/0.155.1 exact collapsed async-question summaries remain sendable, while expanded, clipped, or ambiguous editors receive zero input. Codex sends C-u once to replace the current Composer; Claude Code uses a sentinel-backed native C-s stash-clear transaction that is independent of the cursor position and does not interrupt an active turn, then proves the main Composer empty. Each injects the request, waits through the paste window, and dispatches Enter exactly once without a post-text Composer veto. A source-less Codex terminal freezes all current rollout roots before input, then promotes a provisional Session/Turn only when exactly one anchored or newly opened rollout durably accepts the exact request hash; zero matches remain pending and ambiguity becomes uncertain without replay. If managed preparation fails before input, AKK still delivers once as unmanaged work, then best-effort attaches an exact Terminal Watch callback. After exact request acceptance and terminal attribution, a supported questionnaire on that Watch may expose owner-bound response authority through Status and its watch_id; terminal-activity observations and manual_required interactions remain notification-only. Read terminal_input_dispatched, agent_acceptance, management_mode, observation_mode, and capabilities independently. Watch attachment failure never changes a successful Send. Once the mutation sequence begins, an uncertain result must not be automatically retried. Retry submission is the mutually exclusive exact {turn_id} form and cannot change request text or routing. Draft text, composer digests, and opaque freshness authority stay private. A Turn id is never an ordinary-send destination. Managed acceptance is asynchronous: yield and wait for its callback or an explicit status request.",
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
        sessionKey: requiredControllerSessionKey(toolContext?.sessionKey),
        sessionId: requiredControllerSessionId(toolContext?.sessionId)
      }
    )
  });

  registerCliTool(api, {
    name: "agent_knock_knock_approve",
    description:
      "Dispatch one closed semantic decision for the current exact permission request only after the user reviews and explicitly chooses it. decision defaults to approve_once for compatibility; reject is available only on a managed Turn when the adapter proves a safe native reject choice. Use turn_id for a managed Turn or terminal_id for a separately advertised approve_once-only terminal action. AKK privately refreshes the prompt and authority, then recaptures it under lock. Raw keys, indexes, and labels are not accepted. Never retry an interrupted decision blindly.",
    parameters: approveParameters,
    buildArgs: (params, toolContext) => buildPrivateApprovalArgs(api, params, {
      sessionKey: requiredControllerSessionKey(toolContext?.sessionKey),
      sessionId: requiredControllerSessionId(toolContext?.sessionId)
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
  return finishSemanticToolCatalog(api, command);
}

function registerSemanticListTool(api): void {
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
      "Inspect the exact current native model catalog for one explicitly selected physical Codex or Claude Code pane. This is the required read-only first step before set_model. Profiled Codex 0.154.0/0.155.1 accepts one exact current native Session or a verified-zero-rollout pane without identify_foreground; Claude Code still requires one exact current native Session. AKK requires an exact live pane/process, no active Turn, and no approval, questionnaire/editor, or read-only viewer. The Composer must be empty unless current List privately binds this action to one exact stable profiled Codex 0.154.0/0.155.1 /model residual, which AKK may continue into the native picker without retyping it. That residual-bound authority is consumed by discovery; after restoring an exact empty Composer, AKK retains only fresh ordinary terminal/catalog authority for one set_model attempt in this exact controller conversation. It obtains model ids and reasoning-effort values from the native UI/runtime and exposes only semantic choices. Codex advertises scope=current_and_new_sessions; Claude Code advertises scope=current_session. Arbitrary commands, keys, menu indexes, labels, and hidden authority are never accepted.",
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
      "Clear one exact stale profiled Codex 0.154.0/0.155.1 /model completion surface, exact bare /model Composer, or exact open native model picker left by a failed native model-control attempt. This explicit one-shot repair is available only when the current AKK list proves the same exact pane/process, the closed profiled model-control residue, no active Turn, and no approval, questionnaire/editor, or read-only viewer. Pass only terminal_id; AKK privately derives and revalidates every physical, screen, and Composer fence before each reversible cleanup input. It never submits a task, selects a model, approves a prompt, accepts raw commands or keys, or automatically continues into model_options/set_model. An open picker receives dismissal authority only, never Enter authority. outcome=uncertain must never be retried automatically.",
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
      "Change exactly one already-open physical coding-agent pane to one semantic model and reasoning-effort tuple from the immediately preceding model_options result in this same controller conversation. AKK consumes the private current-snapshot offer, revalidates the exact pane/process plus idle and empty native UI under lock, rejects active Turns and every input-owning prompt/viewer, and verifies the effective postcondition. Profiled Codex 0.154.0/0.155.1 accepts one exact current native Session or a verified-zero-rollout pane without identify_foreground; Claude Code still requires one exact current native Session. Codex scope is current_and_new_sessions: the model and ordinary efforts (including max) are persisted, but ultra remains current-session-only; the future model is reported while the native TUI's unobservable fallback effort is omitted. Claude Code scope is current_session and leaves future defaults unchanged. Parameters never accept scope, raw commands, slash text, keys, menu indexes, display labels, fingerprints, or tokens. outcome=uncertain must never be retried automatically.",
    parameters: setModelParameters,
    timeoutMs: SET_MODEL_CLI_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkSetModelSuccess(result),
    buildArgs: (params, toolContext) => buildPrivateSetModelArgs(
      api,
      params,
      {
        sessionKey: requiredControllerSessionKey(toolContext?.sessionKey),
        sessionId: requiredControllerSessionId(toolContext?.sessionId)
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
          sessionKey: requiredControllerSessionKey(ctx.sessionKey),
          sessionId: requiredControllerSessionId(ctx.sessionId)
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
  const sessionKey = requiredControllerSessionKey(ctx.sessionKey);
  const sessionId = requiredControllerSessionId(ctx.sessionId);
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
      requiredControllerSessionKey(toolContext?.sessionKey)
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
    callback_method: usesHostBridgeToolPresentation(api)
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
  // sessionId is the controller conversation incarnation. It changes across
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

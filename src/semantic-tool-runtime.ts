import { semanticCommandGuidance, semanticToolDescriptions } from
  "./semantic-tool-descriptions.js";
import { createHash, randomUUID } from "node:crypto";
import { desktopSendToolArgs, desktopWatchTarget, validatedDesktopWatchId } from "./desktop-semantic.js";
import { isNativeInteractionResponseError, nativeApprovalToolArgs, nativeConversationTarget, nativeInteractionToolArgs,
  nativePermissionToolArgs, nativeSendToolArgs, validatedNativeWatchId } from "./codex-native-semantic.js";
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

import { registerPermissionControlTools, handleAkkPermissionCommand } from
  "./semantic-permission-control.js";

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
    description: semanticToolDescriptions.akk,
    acceptsArgs: true,
    requiresAuthentication: true,
    progressMessage: "AKK is handling the request...",
    promptGuidance: [...semanticCommandGuidance],
    execute: async (ctx) => handleAkkCommand(api, ctx, displayedResumeSnapshots)
  };

  registerSemanticListTool(api);

  registerCliTool(api, {
    name: "agent_knock_knock_watch",
    description:
      semanticToolDescriptions.watch,
    parameters: watchParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params, toolContext) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const desktopId = nativeConversationTarget(params) ?? desktopWatchTarget(params);
      const openclawSession =
        desktopId ? requiredControllerSessionKey(toolContext?.sessionKey)
          : stringValue(toolContext?.sessionKey) ?? "agent:main:main";
      const args = [
        "watch-terminal",
        desktopId ? "--conversation" : "--terminal",
        desktopId ?? requiredString(params.terminal_id, "terminal_id")
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
      if (nativeConversationTarget(params)) pushOptional(args, "--codex-home", stringValue(config.codexHome));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_unwatch",
    description:
      semanticToolDescriptions.unwatch,
    parameters: unwatchParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params, toolContext) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = [
        "unwatch-terminal",
        "--watch",
        requiredString(params.watch_id, "watch_id")
      ];
      if (validatedNativeWatchId(params.watch_id) ?? validatedDesktopWatchId(params.watch_id)) pushOptional(args, "--openclaw-session", requiredString(toolContext?.sessionKey, "controller session"));
      if (validatedNativeWatchId(params.watch_id)) pushOptional(args, "--codex-home", stringValue(config.codexHome));
      pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_list_resumable_threads",
    description:
      semanticToolDescriptions.list_resumable_threads,
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
      semanticToolDescriptions.native_inspect,
    parameters: nativeInspectParameters,
    normalizeTurnIdentity: false,
    buildArgs: async (params, context) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const inspection = requiredString(params.inspection, "inspection");
      if (inspection !== "status") {
        throw new Error("inspection must be status");
      }
      const nativeArgs = nativePermissionToolArgs(params, config, context ?? {}, "status");
      if (nativeArgs) return nativeArgs;
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
  registerPermissionControlTools(api, registerCliTool);

  registerForegroundIdentificationTools(api);

  registerCliTool(api, {
    name: "agent_knock_knock_new_thread",
    description:
      semanticToolDescriptions.new_thread,
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
      semanticToolDescriptions.reconcile_binding,
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
      semanticToolDescriptions.resume_thread,
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
      semanticToolDescriptions.status,
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
      semanticToolDescriptions.send,
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
      semanticToolDescriptions.respond,
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
      semanticToolDescriptions.respond_interaction,
    parameters: respondInteractionParameters,
    isErrorResult: isNativeInteractionResponseError,
    buildArgs: (params, toolContext) => nativeInteractionToolArgs(params,
      isRecord(api.pluginConfig) ? api.pluginConfig : {}, toolContext ?? {}) ?? buildPrivateInteractionResponseArgs(
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
      semanticToolDescriptions.approve,
    parameters: approveParameters,
    isErrorResult: isNativeInteractionResponseError,
    buildArgs: (params, toolContext) => nativeApprovalToolArgs(params,
      isRecord(api.pluginConfig) ? api.pluginConfig : {}, toolContext ?? {}) ?? buildPrivateApprovalArgs(api, params, {
      sessionKey: requiredControllerSessionKey(toolContext?.sessionKey),
      sessionId: requiredControllerSessionId(toolContext?.sessionId)
    })
  });

  registerCliTool(api, {
    name: "agent_knock_knock_renew",
    description: semanticToolDescriptions.renew,
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
    description: semanticToolDescriptions.retry_callback,
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
    description: semanticToolDescriptions.cancel,
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
      semanticToolDescriptions.close,
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
      semanticToolDescriptions.list,
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
      pushOptional(args, "--desktop-search", stringValue(params.desktopSearch));
      pushOptional(args, "--desktop-project", stringValue(params.desktopProject));
      pushOptional(args, "--desktop-cursor", stringValue(params.desktopCursor));
      pushOptional(args, "--desktop-limit", numberString(params.desktopLimit));
      pushOptional(args, "--codex-home", stringValue(config.codexHome));
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
      semanticToolDescriptions.model_options,
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
      semanticToolDescriptions.repair_model_control,
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
      semanticToolDescriptions.set_model,
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
      semanticToolDescriptions.identify_foreground,
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
      semanticToolDescriptions.identify_and_send,
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
    if (parsed.action === "permission-options" || parsed.action === "set-permissions") {
      return await handleAkkPermissionCommand(api, ctx, parsed);
    }
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
      "Controller conversation incarnation is required for number or short-id " +
        "Resume; run /akk threads again in the current conversation or use the " +
        "complete UUID"
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
    validatedNativeWatchId(watchId) ?? validatedDesktopWatchId(watchId);
    const watchArgs = [
      "watch-status",
      "--watch",
      watchId,
      "--openclaw-session",
      requiredControllerSessionKey(toolContext?.sessionKey)
    ];
    if (validatedNativeWatchId(watchId)) pushOptional(watchArgs, "--codex-home", stringValue(config.codexHome));
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
  if (nativeConversationTarget(params)) {
    pushOptional(args, "--openclaw-session", requiredString(toolContext?.sessionKey, "controller session"));
    pushOptional(args, "--codex-home", stringValue(config.codexHome));
  }
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
  const nativeArgs = nativeSendToolArgs(params, isRecord(api.pluginConfig) ? api.pluginConfig : {}, toolContext ?? {}, messageId);
  if (nativeArgs) return runHostAwareCli(api, nativeArgs);
  const desktopArgs = desktopSendToolArgs(params, isRecord(api.pluginConfig) ? api.pluginConfig : {}, toolContext ?? {}, messageId);
  if (desktopArgs) return runHostAwareCli(api, desktopArgs);
  if (Object.hasOwn(params, "turn_id")) {
    const unexpected = Object.keys(params).filter((key) => key !== "turn_id");
    if (unexpected.length > 0) {
      throw new Error(
        "send retry_submission accepts exactly turn_id; do not pass request, " +
          "terminal_id, session_id, timeout overrides, or callback route data"
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
            "AKK sent the terminal input but could not fence later side effects to an " +
              "exact native session. Do not retry or continue automatically; inspect the " +
              "pane and close this Turn."
        }
      : submissionUncertain
      ? {
          submission_outcome: "uncertain",
          do_not_retry: true,
          reason: parsed.reason,
          openclaw_next_action: parsed.openclaw_next_action,
          note:
            "AKK could not prove whether the terminal accepted Enter. Do not retry " +
              "automatically; inspect the exact AKK Turn record and shared terminal."
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
                "AKK could not prove a durable safe abort. Do not retry automatically; " +
                  "inspect the exact Turn and terminal dispatch ledger."
            }
      : submissionNotAccepted
        ? {
            submission_outcome: "not_accepted",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved terminal transport but the exact draft is still present in the " +
                "agent composer. Do not retry automatically; inspect the shared pane."
          }
      : submissionPending
        ? {
            submission_outcome: "pending_acceptance",
            do_not_retry: true,
            reason: parsed.reason,
            openclaw_next_action: parsed.openclaw_next_action,
            note:
              "AKK proved only terminal transport and is still waiting for native agent " +
                "acceptance. Do not retry or report the task as accepted."
          }
      : {
          openclaw_next_action: {
            action: "yield",
            reason:
              "The coding agent is working in the shared terminal. End this controller turn " +
                "now and wait for an Agent Knock Knock callback.",
            do_not:
              "Do not poll terminal internals while waiting. Further communication must use " +
                "Agent Knock Knock tools so the same shared terminal remains authoritative.",
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

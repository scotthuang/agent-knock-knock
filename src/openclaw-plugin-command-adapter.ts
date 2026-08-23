import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { executorDefinitionForKind } from "./executors.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  AKK_CALLBACK_METHOD,
  akkUsageText,
  buildAkkCommandCliArgs,
  formatAkkListCommandResult,
  formatAkkRespondCommandResult,
  formatAkkTerminalWatchHint,
  formatAkkThreadsCommandResult,
  formatAkkThreadTransitionCommandResult,
  formatAkkUnwatchCommandResult,
  formatAkkWatchCommandResult,
  formatAkkWatchStatusCommandResult,
  isAkkModelFacingDiagnosticField,
  isAkkModelFacingPrivateAuthorityField,
  isAkkNativeSubmissionAccepted,
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
  listParameters,
  listResumableThreadsParameters,
  nativeInspectParameters,
  newThreadParameters,
  reconcileBindingParameters,
  renewParameters,
  respondParameters,
  resumeThreadParameters,
  retryCallbackParameters,
  sendParameters,
  statusParameters,
  unwatchParameters,
  watchParameters
} from "./openclaw-plugin-schemas.js";
import {
  consumeOpenClawPrivateAuthorityOffer,
  openClawApprovalAuthorityOfferKey,
  rememberOpenClawPrivateAuthorityOffer,
  type OpenClawPrivateAuthorityOfferKey,
  type OpenClawPrivateAuthorityOfferPayload,
  type OpenClawPrivateAuthorityTarget
} from "./openclaw-private-authority-offers.js";

const MAX_DISPLAYED_RESUME_SNAPSHOTS = 512;
const OPENCLAW_HANDOFF_AUTHORITY_KIND = "handoff";
const OPENCLAW_RECONCILE_BINDING_AUTHORITY_KIND = "reconcile_binding";
const CALLBACK_METHOD = AKK_CALLBACK_METHOD;
export const defaultOpenClawRelayPath = fileURLToPath(
  new URL("./cli.js", import.meta.url)
);
const relayPathByApi = new WeakMap<object, string>();

export function bindOpenClawRelayPath(api: object, relayPath: string): void {
  relayPathByApi.set(api, relayPath);
}

export function registerOpenClawCommands(
  api,
  displayedResumeSnapshots: Map<
    string,
    { snapshotId: string; expiresAtMs: number }
  >
): void {
  api.registerCommand?.({
    name: "akk",
    description: "Send coding work through existing Codex or Claude Code shared terminals, inspect managed Turns, observe human-started work with durable Terminal Watch, and explicitly start, clear, list, or resume native threads.",
    acceptsArgs: true,
    requireAuth: true,
    nativeProgressMessages: {
      default: "AKK is handling the request..."
    },
    agentPromptGuidance: [
      "Use /akk <task> when exactly one eligible idle coding-agent terminal pane should receive new work. Structured tools use only semantic identifiers returned by AKK: session_id for an exact managed context, terminal_id for the currently verified pane, turn_id for one managed Turn, watch_id for one Terminal Watch, and native_thread_id for one resumable native thread. AKK keeps all opaque freshness authority private and revalidates it under its locks. Use /akk watch only from a currently advertised watch action to observe one human-started active task; it sends no input and creates no Session or Turn. New/clear/resume, approval, reconciliation, handoff, and recovery still require the documented user intent or explicit confirmation. AKK never starts a coding-agent process."
    ],
    handler: async (ctx) => handleAkkCommand(
      api,
      ctx,
      displayedResumeSnapshots
    )
  });

  registerCliTool(api, {
    name: "agent_knock_knock_list",
    description: "List existing Codex and Claude Code tmux or Herdr panes as the primary terminals[] resources, plus durable terminal_watches[] records. Use only advertised actions and their semantic IDs. AKK keeps opaque freshness authority private and revalidates terminal, binding, candidate, approval, and handoff state before every side effect. A session_exact send uses session_id; terminal_follow_current and Watch use terminal_id; managed controls use turn_id; lifecycle resume additionally uses the complete native_thread_id. Recovery actions remain explicit-confirmation operations. AKK never starts a coding-agent process.",
    parameters: listParameters,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const args = ["list", "--reconcile"];
      pushOptional(
        args,
        "--store-dir",
        resolvePluginStoreDir(config)
      );
      pushOptional(args, "--idle-timeout-minutes", numberString(params.idleTimeoutMinutes) ?? numberString(api.pluginConfig?.idleTimeoutMinutes));
      pushOptional(args, "--agent", stringValue(params.agent));
      pushOptional(args, "--status", stringValue(params.status));
      if (params.all === true) {
        args.push("--all");
      }
      if (params.noApprovalScan === true) {
        args.push("--no-approval-scan");
      }
      if (params.terminalDebug === true) {
        args.push("--terminal-debug");
      }
      return args;
    }
  });

  registerCliTool(api, {
    name: "agent_knock_knock_watch",
    description:
      "Start one durable Terminal Watch for the exact supported human-started task already active in a listed Codex or Claude Code terminal. Call only from that terminal row's current watch action and pass its exact terminal_id. AKK refreshes and revalidates current observation authority internally. This observes external work, creates no AKK Session or Turn, sends no terminal input, and never adopts or blocks the human's terminal task.",
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
      "List verified native Codex or Claude Code threads for one exact terminal. Resume only a row with resumable=true by passing this terminal_id and that row's complete native_thread_id. AKK retains candidate and binding freshness evidence privately. Number and short-id fields are slash-command display aids, never tool arguments. This is read-only for Session/Turn state and creates no AKK Turn.",
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
      "Execute one closed, exact-version native status inspection in an exact Codex or Claude Code terminal. Pass only terminal_id and inspection=status; AKK refreshes binding authority privately. Arbitrary slash commands remain unavailable. This creates no AKK Session, Turn, receipt, monitor, or callback.",
    parameters: nativeInspectParameters,
    normalizeTurnIdentity: false,
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const inspection = requiredString(params.inspection, "inspection");
      if (inspection !== "status") {
        throw new Error("inspection must be status");
      }
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = privateTerminalActionArguments(
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

  registerCliTool(api, {
    name: "agent_knock_knock_new_thread",
    description:
      "Start and verify a clean native coding-agent thread in the exact terminal_id after explicit user intent. AKK refreshes lifecycle authority privately. Never send /clear as ordinary task text. This creates a new AKK Session but no Turn.",
    parameters: newThreadParameters,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const action = privateTerminalActionArguments(
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
    buildArgs: (params, toolContext) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const conflictingSessionId = requiredString(
        params.conflicting_session_id,
        "conflicting_session_id"
      );
      const action = consumeDisplayedPrivateAction(api, {
        sessionKey: requiredOpenClawSessionKey(toolContext?.sessionKey),
        sessionId: requiredOpenClawSessionId(toolContext?.sessionId),
        kind: OPENCLAW_RECONCILE_BINDING_AUTHORITY_KIND,
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
      "Resume one exact verified historical native thread after explicit user intent. Pass only terminal_id and one complete native_thread_id from a resumable=true row; AKK refreshes binding and candidate evidence privately. This creates or reactivates an AKK Session but no Turn.",
    parameters: resumeThreadParameters,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkThreadTransitionSuccess(result),
    buildArgs: (params) => {
      const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
      const terminalId = requiredString(params.terminal_id, "terminal_id");
      const nativeThreadId = requiredString(
        params.native_thread_id,
        "native_thread_id"
      );
      const discovery = privateThreadDiscovery(api, terminalId);
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

  api.registerTool(
    (toolContext) => ({
      label: "AKK Status",
      name: "agent_knock_knock_status",
      description:
        "Inspect one exact AKK-managed Turn by its authoritative turn_id, one durable Terminal Watch by its authoritative watch_id, or use only a raw terminal row's own prefilled compatibility selector. These targets are mutually exclusive. The deprecated conversation_id remains a legacy Turn alias and the list-prefilled raw-terminal input; never construct it. Watch status describes observed external work and never claims AKK sent or adopted the task. AKK never starts a coding agent.",
      parameters: statusParameters,
      async execute(_toolCallId, params) {
        try {
          const result = runCli(
            api,
            buildStatusCliArgs(api, isRecord(params) ? params : {})
          );
          const rendered = toolResult(result);
          rememberDisplayedApprovalOffer(
            api,
            toolContext?.sessionKey,
            toolContext?.sessionId,
            result
          );
          return rendered;
        } catch (error) {
          throw modelFacingToolError(error);
        }
      }
    }),
    { name: "agent_knock_knock_status", optional: true }
  );

  api.registerTool(
    (toolContext) => ({
      label: "AKK Send",
      name: "agent_knock_knock_send",
      description:
        "Start a new AKK Turn, or explicitly recover one current uncertain submission only through its advertised retry_submission action. Ordinary send requires request and may use session_id or terminal_id exactly as advertised. Retry submission is the mutually exclusive exact {turn_id} form: the caller cannot supply or change request text, terminal, Session, timeout, or callback route data. AKK may press Enter once for the proven exact original draft, or retransmit the immutable original request once only when durable evidence proves Enter was never attempted and the live composer is positively empty. AKK derives all freshness authority privately, revalidates the exact durable Turn/pane/process/context under lock, and otherwise fails closed. A Turn id is never an ordinary-send destination. This is asynchronous: after acceptance, yield and wait for the callback or an explicit status request.",
      parameters: sendParameters,
      async execute(toolCallId, params) {
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
      }
    }),
    { name: "agent_knock_knock_send", optional: true }
  );

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
    name: "agent_knock_knock_approve",
    description:
      "Manually approve the current exact permission request only after the user reviews and explicitly confirms it. Use turn_id for a managed Turn or terminal_id for a separately advertised terminal-scoped approval. AKK privately refreshes the approval prompt and terminal authority, then the CLI recaptures the same prompt under lock before sending keys. Never retry an interrupted approval blindly. This tool cannot enable automatic approval.",
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
    description: "Retry a persisted AKK callback for an exact turn that failed before reaching OpenClaw. The original callback message id and turn identity are reused for idempotent delivery.",
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
}

function resumeSelectionScope(
  sessionKey: unknown,
  sessionId: unknown
): string {
  const key = requiredString(
    sessionKey,
    "OpenClaw session identity is required for snapshot-bound Resume"
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
    "OpenClaw session identity is required for snapshot-bound Resume"
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
        request: parsed.request
      }, {
        sessionKey: ctx.sessionKey
      });
      return {
        text: formatDelegateCommandResult(result),
        isError: result.status !== "async_pending"
      };
    }
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
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
      ? buildPrivateApprovalArgs(api, { turn_id: parsed.turnId }, {
          sessionKey: requiredOpenClawSessionKey(ctx.sessionKey),
          sessionId: requiredOpenClawSessionId(ctx.sessionId)
        })
      : buildAkkCommandCliArgs(parsed, config, {
          sessionKey: ctx.sessionKey
        });
    if (!args) {
      return { text: akkUsageText(), isError: true };
    }
    // Doctor calls back into the running Gateway for its independent health
    // check. Keep the Gateway event loop free while that child CLI runs.
    const result = parsed.action === "doctor"
      ? await runCliAsync(api, args, { allowNonzeroJson: true })
      : runCli(api, args);
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
          isError: terminalSubmissionReported(result)
            ? !isAkkNativeSubmissionAccepted(result)
            : result.status === "delivered_unfenced"
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
    const message = modelFacingErrorMessage(error);
    return {
      text: `AKK command failed: ${message}`,
      isError: true
    };
  }
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
      "OpenClaw conversation incarnation is required for number or short-id Resume; run /akk threads again in the current conversation or use the complete UUID"
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
    const transitionResult = runCli(api, mutationArgs);
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
  const discovery = runCli(api, discoveryArgs);
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
  const transitionResult = runCli(api, mutationArgs);
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
    "The result will return to this OpenClaw session through the callback."
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
      : check?.available === true
        ? "native lifecycle/status unverified"
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

function formatSendCommandResult(result) {
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

function buildStatusCliArgs(api, params) {
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
      watchId
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

async function runSendRequest(api, params, toolContext, messageId?: string) {
  if (Object.hasOwn(params, "turn_id")) {
    const unexpected = Object.keys(params).filter((key) => key !== "turn_id");
    if (unexpected.length > 0) {
      throw new Error(
        "send retry_submission accepts exactly turn_id; do not pass request, terminal_id, session_id, timeout overrides, or callback route data"
      );
    }
    const turnId = authoritativeManagedId(params.turn_id, "turn_id");
    privateActionArguments(api, {
      tool: "agent_knock_knock_send",
      matches: (argumentsValue) =>
        Object.keys(argumentsValue).length === 1 &&
        stringValue(argumentsValue.turn_id) === turnId
    });
    const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
    const args = ["send", "--turn", turnId];
    pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
    return runCli(api, args);
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
    ? privateActionArguments(api, {
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
  return runCli(api, args);
}

function toolResult(
  result,
  {
    submissionErrors = false,
    normalizeTurnIdentity = true,
    forceError = false
  }: {
    submissionErrors?: boolean;
    normalizeTurnIdentity?: boolean;
    forceError?: boolean;
  } = {}
) {
  const normalized = normalizeTurnIdentity ? withTurnIdentity(result) : result;
  const modelFacing = sanitizeModelFacingValue(normalized);
  const submissionError = submissionErrors && isSubmissionError(normalized);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(modelFacing, null, 2)
      }
    ],
    details: modelFacing,
    ...(submissionError || forceError ? { isError: true } : {})
  };
}

function privateList(api): Record<string, unknown> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = ["list", "--reconcile"];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(
    args,
    "--idle-timeout-minutes",
    numberString(config.idleTimeoutMinutes)
  );
  return runCli(api, args);
}

function privateThreadDiscovery(
  api,
  terminalId: string
): Record<string, unknown> {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = [
    "list-resumable-threads",
    "--terminal",
    terminalId
  ];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", stringValue(config.codexHome));
  return runCli(api, args);
}

function privateTerminalActionArguments(
  api,
  terminalId: string,
  tool: string
): Record<string, unknown> {
  return privateActionArguments(api, {
    tool,
    terminalId,
    matches: (argumentsValue) =>
      stringValue(argumentsValue.terminal_id) === terminalId
  });
}

function privateActionArguments(
  api,
  input: {
    tool: string;
    terminalId?: string;
    matches: (argumentsValue: Record<string, unknown>) => boolean;
  }
): Record<string, unknown> {
  const result = privateList(api);
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
        OPENCLAW_HANDOFF_AUTHORITY_KIND,
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
        OPENCLAW_RECONCILE_BINDING_AUTHORITY_KIND,
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
  const fingerprints = currentApprovalFingerprints(result);
  if (fingerprints.length !== 1) return;
  const target = approvalTargetFromStatus(result);
  if (!target) return;
  rememberOpenClawPrivateAuthorityOffer(
    api,
    openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target),
    { fingerprint: fingerprints[0]! }
  );
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

function consumeDisplayedPrivateAction(
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
): Record<string, unknown> {
  const offered = consumeOpenClawPrivateAuthorityOffer(api, {
    sessionKey: input.sessionKey,
    sessionId: input.sessionId,
    kind: input.kind,
    target: input.target
  });
  if (!offered || !isRecord(offered.args)) {
    throw new Error(
      `${input.tool} requires a current action shown by AKK list in this OpenClaw session; refresh list, review it, and explicitly confirm again`
    );
  }
  const current = privateActionArguments(api, input);
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

function currentApprovalFingerprint(result: unknown): string {
  const unique = isRecord(result) ? currentApprovalFingerprints(result) : [];
  if (unique.length !== 1) {
    throw new Error(
      "the current status does not contain one exact approvable prompt; refresh status and ask the user to review it again"
    );
  }
  return unique[0]!;
}

function buildPrivateApprovalArgs(
  api,
  params: Record<string, unknown>,
  { sessionKey, sessionId }: { sessionKey: string; sessionId: string }
): string[] {
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const turnId = stringValue(params.turn_id);
  const terminalId = stringValue(params.terminal_id);
  if (Boolean(turnId) === Boolean(terminalId)) {
    throw new Error("approve requires exactly one of turn_id or terminal_id");
  }
  const target: OpenClawPrivateAuthorityTarget = terminalId
    ? { type: "terminal_id", id: terminalId }
    : { type: "turn_id", id: requiredString(turnId, "turn_id") };
  const offered = consumeOpenClawPrivateAuthorityOffer<
    OpenClawPrivateAuthorityOfferPayload
  >(api, openClawApprovalAuthorityOfferKey(sessionKey, sessionId, target));
  const offeredFingerprint = stringValue(offered?.fingerprint) ??
    (isRecord(offered?.args)
      ? stringValue(offered.args.expected_approval_fingerprint)
      : undefined);
  if (!isExactApprovalFingerprint(offeredFingerprint)) {
    throw new Error(
      "approve requires a current approval request shown by agent_knock_knock_status in this OpenClaw conversation; refresh status, ask the user to review it, and explicitly confirm again"
    );
  }
  const action = terminalId
    ? privateActionArguments(api, {
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
  const currentFingerprint = currentApprovalFingerprint(runCli(api, statusArgs));
  if (currentFingerprint !== offeredFingerprint) {
    throw new Error(
      "the approval request changed after it was shown; refresh AKK status, ask the user to review the current request, and explicitly confirm again"
    );
  }
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

function isExactApprovalFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function currentApprovalFingerprints(
  result: Record<string, unknown>
): string[] {
  const terminalStatus = isRecord(result.terminal_status)
    ? result.terminal_status
    : undefined;
  const states = [
    isRecord(result.approval_state) ? result.approval_state : undefined,
    isRecord(terminalStatus?.approval_state)
      ? terminalStatus.approval_state
      : undefined
  ];
  return [...new Set(states.flatMap((state) => {
    const fingerprint = state?.approvable === true
      ? stringValue(state.fingerprint)
      : undefined;
    return fingerprint && /^[a-f0-9]{64}$/u.test(fingerprint)
      ? [fingerprint]
      : [];
  }))];
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
      key === "selection_snapshot" ||
      key === "live_native_thread_id" ||
      (key === "fingerprint" && parentKey === "approval_state")
    ) {
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

async function runDelegate(api, params, toolContext) {
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
    callback_method: CALLBACK_METHOD,
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
              "The coding agent is working in the shared terminal. End this OpenClaw turn now and wait for an Agent Knock Knock callback.",
            do_not:
              "Do not poll terminal internals while waiting. Further communication must use Agent Knock Knock tools so the same shared terminal remains authoritative.",
            expected_callback:
              "The callback will be injected and scheduled into this OpenClaw session by the agent-knock-knock.callback Gateway method."
          },
          note:
            "The task was sent to the shared terminal. OpenClaw should yield now and wait for the scheduled callback turn."
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
  toolName: "agent_knock_knock_send" | "agent_knock_knock_respond";
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
    normalizeTurnIdentity = true,
    isErrorResult = (_result: unknown) => false
  }
) {
  api.registerTool(
    (toolContext) => ({
      label: toolLabel(name),
      name,
      description,
      parameters,
      async execute(toolCallId, params) {
        try {
          const result = runCli(
            api,
            buildArgs(
              isRecord(params) ? params : {},
              toolContext,
              toolCallId
            )
          );
          const rendered = toolResult(result, {
            submissionErrors: name === "agent_knock_knock_respond",
            normalizeTurnIdentity,
            forceError:
              typeof isErrorResult === "function" && isErrorResult(result) === true
          });
          if (name === "agent_knock_knock_list") {
            rememberDisplayedPrivateAuthorityOffers(
              api,
              toolContext?.sessionKey,
              toolContext?.sessionId,
              result
            );
          }
          return rendered;
        } catch (error) {
          throw modelFacingToolError(error);
        }
      }
    }),
    { name, optional: true }
  );
}

function toolLabel(name) {
  const action = String(name)
    .replace(/^agent_knock_knock_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return `AKK ${action || "Tool"}`;
}

export function runCli(
  api,
  cliArgs,
  {
    cwd = process.cwd(),
    allowNonzeroJson = false
  }: {
    cwd?: string;
    allowNonzeroJson?: boolean;
  } = {}
) {
  const binPath = relayPathForApi(api);
  const spawned = spawnSync(process.execPath, [binPath, ...cliArgs], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 10,
    cwd
  });

  if (spawned.error) {
    throw new Error(`agent-knock-knock ${cliArgs[0]} failed to start: ${spawned.error.message}`);
  }
  if (spawned.status !== 0) {
    if (allowNonzeroJson && spawned.stdout.trim()) {
      return parseJson(spawned.stdout);
    }
    throw new Error(cleanError(spawned.stderr || spawned.stdout || `agent-knock-knock ${cliArgs[0]} exited with status ${spawned.status}`));
  }

  return parseJson(spawned.stdout);
}

export function runCliAsync(
  api,
  cliArgs,
  {
    cwd = process.cwd(),
    allowNonzeroJson = false,
    timeoutMs = 90_000
  }: {
    cwd?: string;
    allowNonzeroJson?: boolean;
    timeoutMs?: number;
  } = {}
): Promise<Record<string, unknown>> {
  const binPath = relayPathForApi(api);
  const maxBuffer = 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath, ...cliArgs], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const append = (current: string, chunk: string): string => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > maxBuffer) {
        overflow = true;
        child.kill("SIGKILL");
      }
      return next;
    };
    child.stdout.on("data", (chunk: string) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = append(stderr, chunk);
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `agent-knock-knock ${cliArgs[0]} failed to start: ${error.message}`
        )
      );
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(
          new Error(`agent-knock-knock ${cliArgs[0]} timed out`)
        );
        return;
      }
      if (overflow) {
        reject(
          new Error(`agent-knock-knock ${cliArgs[0]} output exceeded 10 MiB`)
        );
        return;
      }
      if (status !== 0) {
        if (allowNonzeroJson && stdout.trim()) {
          try {
            resolve(parseJson(stdout));
          } catch (error) {
            reject(error);
          }
          return;
        }
        reject(
          new Error(
            cleanError(
              stderr ||
                stdout ||
                `agent-knock-knock ${cliArgs[0]} exited with status ${status}`
            )
          )
        );
        return;
      }
      try {
        resolve(parseJson(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function relayPathForApi(api): string {
  return relayPathByApi.get(api) ?? defaultOpenClawRelayPath;
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
    "OpenClaw session identity for this confirmed action"
  );
}

function requiredOpenClawSessionId(value: unknown): string {
  return requiredString(
    value,
    "OpenClaw conversation incarnation for this confirmed action"
  );
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`agent-knock-knock CLI returned invalid JSON: ${error.message}`);
  }
}

function cleanError(text) {
  return String(text).trim().slice(0, 2000);
}

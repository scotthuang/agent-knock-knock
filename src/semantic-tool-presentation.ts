import { executorDefinitionForKind } from "./executors.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";
import {
  formatAkkTerminalWatchHint,
  formatAkkWatchStatusCommandResult,
  isAkkModelFacingDiagnosticField,
  isAkkModelFacingPrivateAuthorityField,
  isAkkNativeSubmissionAccepted,
  normalizeAkkModelFacingFieldName,
  sanitizeAkkModelFacingDiagnosticText,
  sanitizeAkkModelFacingLegacyAuthorityInstructionText
} from "./openclaw-plugin-helpers.js";
import {
  validateAnyTerminalInteractionProjection
} from "./terminal-interaction-protocol.js";
import {
  terminalSendEnterDispatched
} from "./terminal-dispatch-presenter.js";

const hostBridgePresentationApis = new WeakSet<object>();

/** Select compact Host-neutral callback presentation for one runtime owner. */
export function bindHostBridgeToolPresentation(api: object): void {
  hostBridgePresentationApis.add(api);
}

/** Read presentation mode without exposing the owner-local binding set. */
export function usesHostBridgeToolPresentation(api: object): boolean {
  return hostBridgePresentationApis.has(api);
}

export function sendCommandResultIsError(result) {
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

export function formatDelegateCommandResult(result) {
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

export function formatStatusCommandResult(result) {
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

export function formatDoctorCommandResult(result) {
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

export function formatRenewCommandResult(result) {
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

export function formatRetryCallbackCommandResult(result) {
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

export function formatSendCommandResult(result) {
  return result.scope === "terminal_user_explicit"
    ? formatTerminalUserExplicitSendResult(result)
    : formatManagedSendCommandResult(result);
}

export function formatCancelCommandResult(result) {
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

export function formatApproveCommandResult(result) {
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

export function formatCloseCommandResult(result) {
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

export function publicTurnIdentity(result) {
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

export function toolResult(
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

export function modelFacingToolError(error: unknown): Error {
  if (error instanceof Error && error.name === "AbortError") {
    return error;
  }
  return new Error(modelFacingErrorMessage(error));
}

export function modelFacingErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return sanitizeAkkModelFacingDiagnosticText(message);
}

export function isBlockedTerminalDispatchResult(result: unknown): boolean {
  return Boolean(
    isRecord(result) &&
    result.source === "terminal_control" &&
    result.terminal_dispatch_resolved !== true
  );
}

export function isSubmissionError(result: unknown): boolean {
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

export function withTurnIdentity(result) {
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

function truncateText(value, maxLength) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}...`;
}

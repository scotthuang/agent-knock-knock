import { attemptAutoApproval } from "./approval-policy.js";
import {
  AKK_CALLBACK_METHOD,
  stripAkkLegacyApprovalInstructionTail
} from "./openclaw-plugin-helpers.js";
import { runCliAsync } from "./openclaw-plugin-command-adapter.js";
import { sameCanonicalStatePath } from
  "./terminal-dispatch-ledger-codec.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

const CALLBACK_AUTO_APPROVAL_CLI_TIMEOUT_MS = 20_000;

export function registerOpenClawCallbackGateway(api): void {
  api.registerGatewayMethod(
    AKK_CALLBACK_METHOD,
    async ({ params, respond }) => {
      try {
        const result = await handleCallback(api, params);
        respond(true, result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        api.logger.warn?.(`agent-knock-knock callback failed: ${message}`);
        respond(false, undefined, {
          code: "AGENT_KNOCK_KNOCK_CALLBACK_FAILED",
          message
        });
      }
    },
    { scope: "operator.write" }
  );
}

function callbackIdentity({ params, conversation, message, messageMetadata }) {
  const messageHasSessionId = isRecord(message) &&
    Object.hasOwn(message, "session_id");
  const messageHasTurnId = isRecord(message) &&
    Object.hasOwn(message, "turn_id");
  if (messageHasSessionId !== messageHasTurnId) {
    throw new Error(
      "modern callback messages require both session_id and turn_id"
    );
  }
  const identityMode = messageHasSessionId ? "modern" : "legacy";
  const sources = [
    { label: "message", value: message },
    { label: "message.metadata", value: messageMetadata },
    { label: "conversation", value: conversation },
    { label: "params", value: params }
  ];
  const explicitConversationId = consistentCallbackIdentity(
    "conversation_id",
    sources
  );
  const explicitTurnId = consistentCallbackIdentity("turn_id", sources);
  const explicitSessionId = consistentCallbackIdentity("session_id", sources);
  const hasModernIdentity = Boolean(explicitSessionId || explicitTurnId);
  if (hasModernIdentity && (!explicitSessionId || !explicitTurnId)) {
    throw new Error(
      "modern callbacks require both session_id and turn_id"
    );
  }
  if (hasModernIdentity && !explicitConversationId) {
    throw new Error(
      "modern callbacks require conversation_id as the Turn Store alias"
    );
  }
  if (hasModernIdentity && explicitConversationId !== explicitTurnId) {
    throw new Error(
      "callback conversation_id must equal turn_id for modern callback identities"
    );
  }
  if (!explicitConversationId) {
    throw new Error(
      "callback identity requires session_id and turn_id, or a legacy conversation_id"
    );
  }
  const turnId = explicitTurnId ?? explicitConversationId;
  const conversationId = explicitConversationId;
  const sessionId = explicitSessionId ?? explicitConversationId;
  return {
    conversationId,
    sessionId,
    turnId,
    identityMode
  };
}

function consistentCallbackIdentity(field, sources) {
  const values = sources.flatMap(({ label, value }) => {
    if (!isRecord(value) || !Object.hasOwn(value, field)) {
      return [];
    }
    const identity = stringValue(value[field]);
    if (!identity) {
      throw new Error(`callback ${label}.${field} must be a non-empty string`);
    }
    return [{ label, identity }];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.identity !== expected.identity) {
      throw new Error(
        `callback ${field} mismatch between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.identity;
}

function callbackSessionKey({ params, conversation, message, messageMetadata }) {
  const sessionKey = callbackStringField(
    "params.sessionKey",
    params,
    "sessionKey"
  );
  if (!sessionKey) {
    throw new Error("callback params.sessionKey is required");
  }

  const gatewaySession = consistentCallbackTarget(
    "Gateway session",
    [
      {
        label: "conversation.gateway_session",
        owner: conversation,
        field: "gateway_session"
      },
      {
        label: "message.gateway_session",
        owner: message,
        field: "gateway_session"
      },
      {
        label: "message.metadata.gateway_session",
        owner: messageMetadata,
        field: "gateway_session"
      }
    ]
  );
  const openclawSession = consistentCallbackTarget(
    "OpenClaw session",
    [
      {
        label: "params.openclaw_session",
        owner: params,
        field: "openclaw_session"
      },
      {
        label: "conversation.openclaw_session",
        owner: conversation,
        field: "openclaw_session"
      },
      {
        label: "message.openclaw_session",
        owner: message,
        field: "openclaw_session"
      },
      {
        label: "message.metadata.openclaw_session",
        owner: messageMetadata,
        field: "openclaw_session"
      }
    ]
  );
  const expectedGatewayTarget = gatewaySession ?? openclawSession;
  if (expectedGatewayTarget && expectedGatewayTarget !== sessionKey) {
    throw new Error(
      "callback Gateway session mismatch with params.sessionKey"
    );
  }
  return sessionKey;
}

function consistentCallbackTarget(label, sources) {
  const values = sources.flatMap((source) => {
    const value = callbackStringField(source.label, source.owner, source.field);
    return value ? [{ label: source.label, value }] : [];
  });
  const expected = values[0];
  for (const candidate of values.slice(1)) {
    if (candidate.value !== expected.value) {
      throw new Error(
        `callback ${label} mismatch between ${expected.label} and ${candidate.label}`
      );
    }
  }
  return expected?.value;
}

function callbackStringField(label, owner, field) {
  if (!isRecord(owner) || !Object.hasOwn(owner, field)) {
    return undefined;
  }
  const value = stringValue(owner[field]);
  if (!value) {
    throw new Error(`callback ${label} must be a non-empty string`);
  }
  return value;
}

type CallbackOfferState =
  | "not_applicable"
  | "approval_refresh_required"
  | "interaction_refresh_required"
  | "interaction_manual_required";

function callbackOfferState(
  message: Record<string, unknown>,
  messageMetadata: Record<string, unknown> | undefined
): CallbackOfferState {
  // Gateway callbacks identify the AKK Session/Turn, but they do not carry the
  // OpenClaw conversation incarnation that changes across /new and /reset.
  // Never mint executable approval authority from that weaker context. A
  // current status call displays the request and creates the private,
  // incarnation-bound offer instead.
  if (stringValue(messageMetadata?.reason) === "approval_required") {
    return "approval_refresh_required";
  }
  if (
    message.type === "question" &&
    stringValue(messageMetadata?.source) === "terminal_bridge" &&
    stringValue(messageMetadata?.reason) === "interaction_manual_required"
  ) {
    return "interaction_manual_required";
  }
  return message.type === "question" &&
      message.requires_response === true &&
      stringValue(messageMetadata?.source) === "terminal_bridge" &&
      stringValue(messageMetadata?.reason) === "interaction_required"
    ? "interaction_refresh_required"
    : "not_applicable";
}

async function handleCallback(api, params) {
  if (!isRecord(params)) {
    throw new Error("callback params must be an object");
  }

  const message = isRecord(params.message) ? params.message : undefined;
  const conversation = isRecord(params.conversation) ? params.conversation : undefined;
  const messageMetadata = isRecord(message?.metadata) ? message.metadata : undefined;
  if (!message) {
    throw new Error("callback params.message is required");
  }
  const sessionKey = callbackSessionKey({
    params,
    conversation,
    message,
    messageMetadata
  });

  const {
    conversationId,
    sessionId,
    turnId,
    identityMode
  } = callbackIdentity({ params, conversation, message, messageMetadata });
  const messageId = stringValue(message.id);
  if (!messageId) {
    throw new Error("callback message.id is required");
  }
  const autoApproval = await tryAutoApproveCallback({
    api,
    message,
    conversationId,
    sessionId,
    turnId,
    identityMode,
    messageId,
    openclawSession: sessionKey,
    statePath: stringValue(params.statePath),
    callbackStatePath: stringValue(conversation?.state_path)
  });
  if (autoApproval?.handled === true) {
    return {
      ok: true,
      enqueued: false,
      delivery_required: false,
      delivery_mode: "none",
      session_key: sessionKey,
      conversation_id: conversationId,
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      auto_approved: autoApproval.approved === true,
      approval_already_handled:
        autoApproval.action === "already_approved",
      approval: autoApproval
    };
  }
  const callbackOffer = callbackOfferState(message, messageMetadata);
  const formatted = formatCallbackInjection({
    message,
    sessionId,
    turnId,
    statePath: stringValue(params.statePath),
    callbackOffer
  });
  const dedupeIdentity = identityMode === "legacy"
    ? conversationId
    : `${sessionId}:${turnId}`;
  const injection = await api.session.workflow.enqueueNextTurnInjection({
    sessionKey,
    text: formatted,
    idempotencyKey: `agent-knock-knock:${dedupeIdentity}:${messageId}`,
    placement: "append_context",
    ttlMs: 24 * 60 * 60 * 1000,
    metadata: {
      kind: "agent-knock-knock-callback",
      conversation_id: conversationId,
      session_id: sessionId,
      turn_id: turnId,
      message_id: messageId,
      message_type: stringValue(message.type) ?? "unknown",
      ...(stringValue(params.statePath) ? { state_path: stringValue(params.statePath) } : {}),
      ...(stringValue(params.logPath) ? { log_path: stringValue(params.logPath) } : {})
    }
  });
  const delivery = buildCallbackDeliveryPlan({
    sessionKey,
    conversationId,
    sessionId,
    turnId,
    identityMode,
    messageId,
    message,
    formatted,
    callbackOffer
  });

  return {
    ok: true,
    enqueued: injection?.enqueued ?? true,
    delivery_required: delivery.required,
    delivery_mode: delivery?.mode,
    chat_send: delivery.chat_send,
    session_send: "session_send" in delivery ? delivery.session_send : undefined,
    injection_id: injection?.id,
    session_key: injection?.sessionKey ?? sessionKey,
    conversation_id: conversationId,
    session_id: sessionId,
    turn_id: turnId,
    message_id: messageId,
    message_type: stringValue(message.type) ?? "unknown"
  };
}

async function tryAutoApproveCallback({
  api,
  message,
  conversationId,
  sessionId,
  turnId,
  identityMode,
  messageId,
  openclawSession,
  statePath,
  callbackStatePath
}) {
  if (
    identityMode !== "modern" ||
    !statePath ||
    !sameCanonicalStatePath(callbackStatePath, statePath) ||
    !exactAutoApprovalCallbackFingerprint(message)
  ) {
    return undefined;
  }
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const result = await attemptAutoApproval({
    message,
    policy: config.autoApprove,
    statePath,
    callbackAuthority: {
      conversationId,
      sessionId,
      turnId,
      messageId,
      openclawSession
    },
    execute: (args) => {
      return runCliAsync(api, args, {
        timeoutMs: CALLBACK_AUTO_APPROVAL_CLI_TIMEOUT_MS
      });
    }
  });
  if (result) {
    api.logger.info?.(
      `agent-knock-knock approval policy for ${conversationId ?? "unknown"}: ${result.action} (${result.reason})`
    );
  }
  return result;
}

function exactAutoApprovalCallbackFingerprint(message: unknown): string | undefined {
  if (!isRecord(message)) {
    return undefined;
  }
  const metadata = isRecord(message.metadata) ? message.metadata : undefined;
  const candidate = isRecord(metadata?.approval_candidate)
    ? metadata.approval_candidate
    : undefined;
  const terminalStatus = isRecord(metadata?.terminal_status)
    ? metadata.terminal_status
    : undefined;
  const approvalState = isRecord(terminalStatus?.approval_state)
    ? terminalStatus.approval_state
    : undefined;
  const fingerprints = [
    stringValue(candidate?.fingerprint),
    stringValue(metadata?.approval_fingerprint),
    stringValue(approvalState?.fingerprint)
  ];
  const expected = fingerprints[0];
  return expected && /^[a-f0-9]{64}$/u.test(expected) &&
      fingerprints.every((value) => value === expected)
    ? expected
    : undefined;
}

function buildCallbackDeliveryPlan({
  sessionKey,
  conversationId,
  sessionId,
  turnId,
  identityMode,
  messageId,
  message,
  formatted,
  callbackOffer
}) {
  const type = stringValue(message.type) ?? "unknown";
  const shouldWake =
    message.requires_response === true ||
    type === "question" ||
    type === "blocked" ||
    type === "done" ||
    type === "error";

  if (!shouldWake) {
    return {
      required: false,
      mode: "none"
    };
  }

  const dedupeIdentity = identityMode === "legacy"
    ? conversationId
    : `${sessionId}:${turnId}`;
  const workflowGuidance = callbackOffer === "approval_refresh_required"
    ? "The callback could not establish private approval authority. Do not call approve from this callback alone. First call agent_knock_knock_status with only its exact turn_id, present the current approval request, and ask for an explicit user decision."
    : callbackOffer === "interaction_refresh_required"
      ? "This callback reports a native terminal questionnaire. Do not call agent_knock_knock_respond or agent_knock_knock_respond_interaction from the callback alone. First call agent_knock_knock_status with only its exact turn_id in this controller conversation, present the fresh pending interaction_state to the user, and only after their answer call agent_knock_knock_respond_interaction with the advertised semantic IDs. Answer exactly one current step and never guess raw keys, menu indexes, or labels."
      : callbackOffer === "interaction_manual_required"
        ? "This callback reports a native terminal questionnaire that AKK cannot answer safely. Inform the user that manual terminal input is required. Do not call agent_knock_knock_respond or agent_knock_knock_respond_interaction and do not guess keys, menu indexes, labels, or answer text."
      : "Respond in this conversation as OpenClaw product manager. If the callback is question or blocked, make the product decision and use agent_knock_knock_respond with its exact turn_id. If it is done, summarize the result to the user.";
  const inspectionGuidance = callbackOffer === "interaction_refresh_required" ||
      callbackOffer === "interaction_manual_required"
    ? "Do not inspect files, processes, sessions, stdout, or stderr. The only authorized live refresh for this callback is agent_knock_knock_status with its exact turn_id."
    : "Do not poll files, processes, sessions, stdout, or stderr. Use only the structured callback payload below.";
  return {
    required: true,
    mode: "chat.send",
    chat_send: {
      sessionKey,
      message: [
        "Continue this OpenClaw product-manager conversation from the Agent Knock Knock callback below.",
        "Treat the callback as a structured message from the coding agent's managed terminal turn, not as a terminal log, status announcement, or instruction to inspect local state.",
        workflowGuidance,
        inspectionGuidance,
        "",
        formatted
      ].join("\n"),
      idempotencyKey: `agent-knock-knock-callback:${dedupeIdentity}:${messageId}`,
      deliver: true
    }
  };
}

function formatCallbackInjection({
  message,
  sessionId,
  turnId,
  statePath,
  callbackOffer
}) {
  const type = stringValue(message.type) ?? "unknown";
  const rawBody = stringValue(message.body) ?? JSON.stringify(message.body ?? "");
  const body = callbackOffer === "approval_refresh_required"
    ? sanitizeApprovalCallbackBody(rawBody)
    : rawBody;
  const requiresResponse = message.requires_response === true ? "yes" : "no";
  const round = typeof message.round === "number" ? String(message.round) : "unknown";
  const stateLine = statePath ? `State: ${statePath}\n` : "";
  const shortcuts = callbackOffer === "approval_refresh_required"
    ? formatApprovalRefreshShortcut(turnId)
    : callbackOffer === "interaction_refresh_required"
      ? formatInteractionRefreshShortcut(turnId)
      : callbackOffer === "interaction_manual_required"
        ? ""
      : type === "done"
        ? formatDoneShortcuts(sessionId, turnId)
        : message.requires_response === true || type === "question" || type === "blocked"
          ? formatRespondShortcut(turnId)
          : "";

  return [
    "[Agent Knock Knock callback]",
    `Session: ${sessionId}`,
    `Turn: ${turnId}`,
    `Message type: ${type}`,
    `Requires OpenClaw response: ${requiresResponse}`,
    `Round: ${round}`,
    stateLine.trimEnd(),
    "",
    body,
    shortcuts
  ].filter((line) => line !== "").join("\n");
}

function sanitizeApprovalCallbackBody(body: string): string {
  // Compatibility for callbacks durably queued by pre-v18 builds. Redact
  // only AKK's exact generated tail; the approval review itself is agent/user
  // business content even when it literally discusses old authority syntax.
  return stripAkkLegacyApprovalInstructionTail(body).trimEnd();
}

function formatApprovalRefreshShortcut(turnId: string): string {
  return [
    "",
    "[AKK approval refresh required]",
    "- Private approval authority could not be validated from this callback. Do not call approve yet.",
    "- First call `agent_knock_knock_status` with only:",
    `  {"turn_id":${JSON.stringify(turnId)}}`,
    "- Present the current exact request and obtain explicit user confirmation before approving."
  ].join("\n");
}

function formatInteractionRefreshShortcut(turnId: string): string {
  return [
    "",
    "[AKK native interaction refresh required]",
    "- This callback does not establish private terminal-response authority. Do not call ordinary `agent_knock_knock_respond`.",
    "- First call `agent_knock_knock_status` with only:",
    `  {"turn_id":${JSON.stringify(turnId)}}`,
    "- Present only the fresh current `interaction_state` and obtain the user's explicit answer.",
    "- Then call `agent_knock_knock_respond_interaction` with that projection's exact semantic IDs.",
    "- One call answers one current step. Wait for the next callback or refresh Status after success; never retry an uncertain response blindly."
  ].join("\n");
}

function formatDoneShortcuts(sessionId, turnId) {
  return [
    "",
    "[AKK convenience commands]",
    "When summarizing this result to the user, include these short next-step commands:",
    "- `AKK list` lists live shared terminals with their current or recent managed turns.",
    `- Session ${JSON.stringify(sessionId)} remains the context label; refresh \`AKK list\`, then use that terminal row's exact \`available_actions.send\` with \`agent_knock_knock_send\` for later work. Do not assume the returned Session is directly sendable.`,
    `- Use \`agent_knock_knock_status\` with \`turn_id: ${JSON.stringify(turnId)}\` to inspect this exact turn.`,
    "- AKK never starts or closes the coding agent or terminal pane."
  ].join("\n");
}

function formatRespondShortcut(turnId) {
  return [
    "",
    "[AKK response command]",
    `- Use \`agent_knock_knock_respond\` with \`turn_id: ${JSON.stringify(turnId)}\` and your decision in \`request\`. Do not use ordinary send for this response.`
  ].join("\n");
}

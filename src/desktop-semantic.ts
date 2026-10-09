import { consumeSemanticPrivateAuthorityOffer, rememberSemanticPrivateAuthorityOffer,
  semanticInteractionAuthorityOfferKey, invalidateSemanticInteractionAuthorityOffersForSubject } from "./semantic-private-authority-offers.js";
import { desktopInteractionIsApproval, validateDesktopInteractionProjections, validateDesktopProjectedAnswer } from "./desktop-interaction-projection.js";
import { isRecord } from "./value-guards.js";
import { isDesktopConversationId, parseDesktopConversationId } from "./desktop-identity.js";
import { requiredString, pushOptional, numberString, requiredTerminalInteractionIdentifier } from "./semantic-tool-arguments.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";

/** Separate Desktop addressing from all terminal/managed-turn authority paths. */
export function desktopSendToolArgs(params: Record<string, unknown>, config: Record<string, unknown>,
  context: { sessionKey?: unknown }, messageId?: string): string[] | undefined {
  if (!Object.hasOwn(params, "conversation_id")) return undefined;
  const id = requiredString(params.conversation_id, "conversation_id");
  if (!isDesktopConversationId(id)) throw new Error("Send conversation_id must be an exact Desktop ID from List");
  parseDesktopConversationId(id);
  if (["turn_id", "terminal_id", "session_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("Desktop Send accepts one conversation_id and no other target");
  }
  if (params.type !== undefined && params.type !== "task") throw new Error("Desktop v1 sends tasks only");
  const args = ["send", "--conversation", id, "--message", requiredString(params.request, "request"), "--background",
    "--openclaw-session", requiredString(context.sessionKey, "controller session")];
  args.push("--message-id", requiredString(messageId, "stable Desktop tool call identity"));
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--openclaw-bin", config.openclawBin);
  pushOptional(args, "--codex-home", config.codexHome);
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));
  return args;
}

export function desktopWatchTarget(params: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(params, "conversation_id")) return undefined;
  if (Object.hasOwn(params, "terminal_id")) throw new Error("Watch accepts one terminal_id or Desktop conversation_id");
  const id = requiredString(params.conversation_id, "conversation_id");
  parseDesktopConversationId(id);
  return id;
}

export function isDesktopWatchId(value: unknown): value is string {
  return typeof value === "string" && /^desktop-watch:[A-Za-z0-9_-]{8,128}$/u.test(value);
}

export function validatedDesktopWatchId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("desktop-watch:")) return undefined;
  if (!isDesktopWatchId(value)) throw new Error("Invalid Desktop Watch ID");
  return value;
}


/** Desktop answers retain their own subject and never borrow terminal authority. */
export function desktopInteractionToolArgs(api: object, params: Record<string, unknown>,
  config: Record<string, unknown>, context: { sessionKey?: unknown; sessionId?: unknown }): string[] | undefined {
  const subject = desktopInteractionSubject(params);
  if (!subject) return undefined;
  const sessionKey = requiredString(context.sessionKey, "controller session");
  const sessionId = requiredString(context.sessionId, "controller conversation incarnation");
  const interactionId = requiredTerminalInteractionIdentifier(params.interaction_id, "interaction_id");
  if (Object.keys(params).some(key => !["conversation_id", "watch_id", "interaction_id", "answers", "delivery_mode"].includes(key))) {
    throw new Error("Desktop answers accept only an exact subject and typed answer");
  }
  const { projection, fingerprint } = consumeDesktopOffer(api, subject, sessionKey, sessionId, interactionId);
  const response = { interaction_id: interactionId, answers: params.answers,
    ...(params.delivery_mode === undefined ? {} : { delivery_mode: params.delivery_mode }) };
  validateDesktopProjectedAnswer(projection, response);
  const args = ["respond-interaction", subject.kind === "desktop_watch" ? "--watch" : "--conversation", subject.id,
    "--interaction", interactionId, "--response-json", JSON.stringify(response),
    "--expected-interaction-fingerprint", fingerprint, "--expected-interaction-expires-at", projection.expires_at,
    "--openclaw-session", sessionKey];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", config.codexHome);
  return args;
}

export function desktopApprovalToolArgs(api: object, params: Record<string, unknown>,
  config: Record<string, unknown>, context: { sessionKey?: unknown; sessionId?: unknown }): string[] | undefined {
  const subject = desktopInteractionSubject(params);
  if (!subject) return undefined;
  if (Object.keys(params).some(key => !["conversation_id", "watch_id", "interaction_id", "decision"].includes(key))) throw new Error("Unexpected Desktop approval parameters");
  const decision = params.decision ?? "approve_once";
  if (decision !== "approve_once" && decision !== "reject") throw new Error("decision must be approve_once or reject");
  const sessionKey = requiredString(context.sessionKey, "controller session");
  const interactionId = requiredTerminalInteractionIdentifier(params.interaction_id, "interaction_id");
  const { projection, fingerprint } = consumeDesktopOffer(api, subject, sessionKey,
    requiredString(context.sessionId, "controller conversation incarnation"), interactionId);
  if (!desktopInteractionIsApproval(projection)) throw new Error("Current Desktop interaction is not an approval");
  const args = ["approve", subject.kind === "desktop_watch" ? "--watch" : "--conversation", subject.id,
    "--interaction", interactionId, "--decision", decision, "--expected-interaction-fingerprint", fingerprint,
    "--expected-interaction-expires-at", projection.expires_at, "--openclaw-session", sessionKey];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", config.codexHome);
  return args;
}
function consumeDesktopOffer(api: object, subject: { kind: "desktop_conversation" | "desktop_watch"; id: string },
  sessionKey: string, sessionId: string, interactionId: string) {
  const offer = consumeSemanticPrivateAuthorityOffer(api,
    semanticInteractionAuthorityOfferKey(sessionKey, sessionId, subject.kind, subject.id, interactionId));
  if (!offer || typeof offer.fingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(offer.fingerprint)) {
    throw new Error("Refresh AKK Status for this Desktop conversation or Watch, then answer its current question or approval");
  }
  const projections = validateDesktopInteractionProjections([offer.interaction_state], offer.desktop_id,
    subject.kind === "desktop_watch" ? subject.id : undefined);
  return { projection: projections[0], fingerprint: offer.fingerprint };
}

function desktopInteractionSubject(params: Record<string, unknown>): { kind: "desktop_conversation" | "desktop_watch"; id: string } | undefined {
  const conversation = typeof params.conversation_id === "string" && isDesktopConversationId(params.conversation_id)
    ? params.conversation_id : undefined;
  const watch = validatedDesktopWatchId(params.watch_id);
  if (!conversation && !watch) return undefined;
  if (["terminal_id", "session_id", "turn_id"].some(key => Object.hasOwn(params, key))
    || (conversation && Object.hasOwn(params, "watch_id")) || (watch && Object.hasOwn(params, "conversation_id"))) {
    throw new Error("Desktop interaction accepts exactly one conversation_id or watch_id");
  }
  if (conversation) parseDesktopConversationId(conversation);
  return { kind: watch ? "desktop_watch" : "desktop_conversation", id: watch ?? conversation! };
}

export function rememberDisplayedDesktopInteractionOffers(api: object, context: { sessionKey?: unknown; sessionId?: unknown }, result: unknown): void {
  if (!isRecord(result) || result.source !== "codex_desktop" || !isDesktopConversationId(result.conversation_id)
    || typeof context.sessionKey !== "string" || typeof context.sessionId !== "string") return;
  // Status Watch results include both identities; only its exact Watch is the response subject.
  const watch = validatedDesktopWatchId(result.watch_id);
  const kind = watch ? "desktop_watch" : "desktop_conversation";
  const id = watch ?? String(result.conversation_id);
  invalidateSemanticInteractionAuthorityOffersForSubject(api, context.sessionKey, context.sessionId, kind, id);
  let projections: ReturnType<typeof validateDesktopInteractionProjections>;
  try { projections = validateDesktopInteractionProjections(result.interaction_state ?? [], result.conversation_id, watch, result.native_turn_id); }
  catch { return; }
  for (const projection of projections) {
    const fingerprint = projection.interaction_prompt_fingerprint;
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) continue;
    rememberSemanticPrivateAuthorityOffer(api, semanticInteractionAuthorityOfferKey(context.sessionKey, context.sessionId,
      kind, id, projection.interaction_id), { fingerprint, desktop_id: result.conversation_id, interaction_state: projection });
  }
}

export function isDesktopInteractionResponseError(value: unknown): boolean {
  return isRecord(value) && value.source === "codex_desktop" && ["not_sent", "uncertain", "reserved"].includes(String(value.state));
}

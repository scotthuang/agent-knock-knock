import { isCodexNativeConversationId, isCodexNativeWatchId, parseCodexNativeConversationId } from "./codex-native-identity.js";
import { numberString, pushOptional, requiredString, requiredTerminalInteractionIdentifier } from "./semantic-tool-arguments.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";
import { isRecord } from "./value-guards.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { TERMINAL_INTERACTION_LIMITS } from "./terminal-interaction-protocol.js";

type Params = Record<string, unknown>;
type Context = { sessionKey?: unknown };

/** A dispatched response is distinct from a subsequently verified native effect. */
export function isNativeInteractionResponseError(value: unknown): boolean {
  return isRecord(value) && value.source === "codex_cli" &&
    ["not_sent", "uncertain", "reserved"].includes(String(value.state));
}

/** Native targets carry the backend/thread identity, never terminal UI authority. */
export function nativeConversationTarget(params: Params): string | undefined {
  if (!Object.hasOwn(params, "conversation_id")) return undefined;
  const id = requiredString(params.conversation_id, "conversation_id");
  if (!isCodexNativeConversationId(id)) return undefined;
  parseCodexNativeConversationId(id);
  if (["terminal_id", "session_id", "turn_id", "watch_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("Codex CLI conversation_id cannot be combined with another target");
  }
  return id;
}

/** Terminal aliases stay selectors; the CLI router proves the backend identity before dispatch. */
export function routedCodexTerminalTarget(params: Params): string | undefined {
  const id = params.conversation_id ?? params.terminal_id;
  if (typeof id !== "string" || parseTerminalConversationId(id)?.agent !== "codex") return undefined;
  const keys = ["conversation_id", "terminal_id", "session_id", "turn_id", "watch_id"];
  if (keys.filter(key => Object.hasOwn(params, key)).length !== 1) {
    throw new Error("Codex terminal conversation accepts exactly one target");
  }
  return id;
}

export function routedCodexTerminalControlArgs(params: Params, config: Params, context: Context,
  action: "status" | "permissions" | "set-permissions"): string[] | undefined {
  const id = routedCodexTerminalTarget(params);
  if (!id) return undefined;
  const fields = action === "set-permissions" ? ["mode"] : action === "status" ? ["inspection"] : [];
  onlyParameters(params, ["conversation_id", "terminal_id", ...fields]);
  const args = scopedArgs(action === "status" ? "native-inspect" : action === "permissions" ? "permission-options" : action,
    ["--terminal", id], config, context);
  if (action === "status") args.push("--inspection", "status");
  if (action === "set-permissions") {
    if (!["read-only", "default", "full-access"].includes(String(params.mode))) return undefined;
    args.push("--mode", String(params.mode));
  }
  return args;
}

export function validatedNativeWatchId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("codex-cli-watch:")) return undefined;
  if (!isCodexNativeWatchId(value)) {
    throw new Error("Invalid Codex CLI Watch ID");
  }
  return value;
}

function nativeSubject(params: Params): string[] | undefined {
  const conversationId = nativeConversationTarget(params);
  if (conversationId) return ["--conversation", conversationId];
  const terminalId = routedCodexTerminalTarget(params);
  if (terminalId && Object.hasOwn(params, "interaction_id")) {
    if (!/^codex-native-interaction:[0-9a-f]{64}$/u.test(String(params.interaction_id))) {
      throw new Error("A terminal conversation interaction requires its exact backend interaction_id; use the displayed Turn or Watch for terminal UI responses");
    }
    return ["--conversation", terminalId];
  }
  const watchId = validatedNativeWatchId(params.watch_id);
  if (!watchId) return undefined;
  if (["terminal_id", "session_id", "turn_id", "conversation_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("Codex CLI watch_id cannot be combined with another target");
  }
  return ["--watch", watchId];
}

function scopedArgs(command: string, target: string[], config: Params, context: Context): string[] {
  const args = [command, ...target, "--openclaw-session", requiredString(context.sessionKey, "controller session")];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", config.codexHome);
  return args;
}

function onlyParameters(params: Params, names: string[]): void {
  const extra = Object.keys(params).filter(key => !names.includes(key));
  if (extra.length) throw new Error(`Unexpected Codex CLI parameters: ${extra.join(", ")}`);
}

export function nativeSendToolArgs(params: Params, config: Params, context: Context, messageId?: string): string[] | undefined {
  const id = nativeConversationTarget(params);
  if (!id) return undefined;
  onlyParameters(params, ["conversation_id", "request", "type", "agentHardTimeoutMinutes"]);
  if (params.type !== undefined && params.type !== "task") throw new Error("Codex CLI Send accepts tasks only");
  const args = scopedArgs("send", ["--conversation", id], config, context);
  args.push("--message", requiredString(params.request, "request"), "--background",
    "--message-id", requiredString(messageId, "stable Codex CLI tool call identity"));
  pushOptional(args, "--openclaw-bin", config.openclawBin);
  pushOptional(args, "--agent-hard-timeout-minutes", numberString(params.agentHardTimeoutMinutes) ?? numberString(config.agentHardTimeoutMinutes));
  return args;
}

export function nativePermissionToolArgs(params: Params, config: Params, context: Context, action: "status" | "permissions" | "set-permissions"): string[] | undefined {
  const id = nativeConversationTarget(params);
  if (!id) return undefined;
  onlyParameters(params, action === "set-permissions" ? ["conversation_id", "mode"] : action === "status" ? ["conversation_id", "inspection"] : ["conversation_id"]);
  const args = scopedArgs(action === "set-permissions" ? action : "native-inspect", ["--conversation", id], config, context);
  if (action === "set-permissions") {
    if (!["read-only", "default", "full-access"].includes(String(params.mode))) throw new Error("mode must be read-only, default, or full-access");
    args.push("--mode", String(params.mode));
  } else args.push("--action", action);
  return args;
}

export function nativeApprovalToolArgs(params: Params, config: Params, context: Context): string[] | undefined {
  const target = nativeSubject(params);
  if (!target) return undefined;
  onlyParameters(params, ["conversation_id", "terminal_id", "watch_id", "interaction_id", "decision"]);
  const decision = params.decision ?? "approve_once";
  if (decision !== "approve_once" && decision !== "reject") throw new Error("decision must be approve_once or reject");
  return [...scopedArgs("approve", target, config, context), "--interaction",
    requiredTerminalInteractionIdentifier(params.interaction_id, "interaction_id"), "--decision", decision];
}

export function nativeInteractionToolArgs(params: Params, config: Params, context: Context): string[] | undefined {
  const target = nativeSubject(params);
  if (!target) return undefined;
  onlyParameters(params, ["conversation_id", "terminal_id", "watch_id", "interaction_id", "answers", "delivery_mode"]);
  const interactionId = requiredTerminalInteractionIdentifier(params.interaction_id, "interaction_id");
  if (params.delivery_mode !== undefined && params.delivery_mode !== "steer_current_turn") {
    throw new Error("Codex CLI async answers support steer_current_turn only");
  }
  validateNativeAnswers(params.answers);
  const response = { interaction_id: interactionId, answers: params.answers,
    ...(params.delivery_mode === undefined ? {} : { delivery_mode: params.delivery_mode }) };
  return [...scopedArgs("respond-interaction", target, config, context), "--interaction", interactionId,
    "--response-json", JSON.stringify(response)];
}

function validateNativeAnswers(answers: unknown): void {
  if (!Array.isArray(answers) || !answers.length || answers.length > 16) {
    throw new Error("answers must contain current typed question answers");
  }
  const seen = new Set<string>();
  for (const answer of answers) {
    if (!isRecord(answer)) throw new Error("Invalid typed question answer");
    const questionId = requiredTerminalInteractionIdentifier(answer.question_id, "question_id");
    if (seen.has(questionId)) throw new Error("Duplicate question_id");
    seen.add(questionId);
    const kind = answer.response_kind;
    const field = kind === "single_select" ? "selected_option_ids" : kind === "free_text" ? "text" : kind === "confirm" ? "confirm" : undefined;
    if (!field) throw new Error("Unsupported response_kind");
    onlyParameters(answer, ["question_id", "response_kind", field]);
    if (field === "selected_option_ids") {
      if (!Array.isArray(answer[field]) || answer[field].length !== 1) throw new Error("single_select requires exactly one option_id");
      requiredTerminalInteractionIdentifier(answer[field][0], "option_id");
    } else if (field === "text") {
      const text = requiredString(answer.text, "text");
      if (text.length > TERMINAL_INTERACTION_LIMITS.maxTextAnswerLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) throw new Error("Invalid free_text answer");
    } else if (typeof answer.confirm !== "boolean") throw new Error("confirm requires a boolean");
  }
}

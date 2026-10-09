import { isDesktopConversationId, parseDesktopConversationId } from "./desktop-identity.js";
import { isDesktopWatchId } from "./desktop-semantic.js";
import { pushOptional, requiredString, requiredTerminalInteractionIdentifier } from "./semantic-tool-arguments.js";
import { resolvePluginStoreDir } from "./semantic-tool-command-helpers.js";

type Params = Record<string, unknown>;
type Context = { sessionKey?: unknown };
export function desktopConversationTarget(params: Params): string | undefined {
  if (!isDesktopConversationId(params.conversation_id)) return undefined;
  const id = String(params.conversation_id);
  parseDesktopConversationId(id);
  if (["terminal_id", "session_id", "turn_id", "watch_id"].some(key => Object.hasOwn(params, key))) {
    throw new Error("Desktop conversation_id cannot be combined with another target");
  }
  return id;
}
function scoped(command: string, id: string, config: Params, context: Context, watch = false): string[] {
  const args = [command, watch ? "--watch" : "--conversation", id,
    "--openclaw-session", requiredString(context.sessionKey, "controller session")];
  pushOptional(args, "--store-dir", resolvePluginStoreDir(config));
  pushOptional(args, "--codex-home", config.codexHome);
  return args;
}
function only(params: Params, allowed: string[]): void {
  if (Object.keys(params).some(key => !allowed.includes(key))) throw new Error("Unexpected Desktop control parameters");
}
export function desktopControlToolArgs(params: Params, config: Params, context: Context,
  action: "status" | "permissions" | "set-permissions" | "model-options" | "set-model"): string[] | undefined {
  const id = desktopConversationTarget(params);
  if (!id) return undefined;
  const fields = action === "set-model" ? ["model", "reasoning_effort", "collaboration_mode"]
    : action === "set-permissions" ? ["mode"] : action === "status" ? ["inspection"] : [];
  only(params, ["conversation_id", ...fields]);
  const args = scoped(action === "status" ? "native-inspect" : action === "permissions" ? "permission-options" : action, id, config, context);
  if (action === "status") args.push("--action", "status");
  if (action === "set-permissions") {
    if (!["read-only", "default", "full-access"].includes(String(params.mode))) throw new Error("mode must be read-only, default, or full-access");
    args.push("--mode", String(params.mode));
  }
  if (action === "set-model") appendModel(args, params);
  return args;
}
function appendModel(args: string[], params: Params): void {
  const model = requiredString(params.model, "model"), effort = requiredString(params.reasoning_effort, "reasoning_effort");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/+\-]{0,159}$/u.test(model) || !/^[a-z][a-z0-9_-]{0,63}$/u.test(effort)) throw new Error("Invalid Desktop model/effort tuple");
  args.push("--model", model, "--reasoning-effort", effort);
  if (params.collaboration_mode !== undefined) {
    if (params.collaboration_mode !== "plan" && params.collaboration_mode !== "default") throw new Error("Desktop collaboration_mode must be plan or default");
    args.push("--collaboration-mode", params.collaboration_mode);
  }
}
export function desktopCancelToolArgs(params: Params, config: Params, context: Context): string[] | undefined {
  const id = desktopConversationTarget(params);
  if (id) {
    only(params, ["conversation_id", "expected_native_turn_id"]);
    return [...scoped("cancel", id, config, context), "--expected-native-turn-id",
      requiredTerminalInteractionIdentifier(params.expected_native_turn_id, "expected_native_turn_id")];
  }
  if (!isDesktopWatchId(params.watch_id)) return undefined;
  only(params, ["watch_id"]);
  return scoped("cancel", params.watch_id, config, context, true);
}

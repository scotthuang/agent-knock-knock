import type { DesktopRuntime } from "./desktop-runtime.js";
import type { DesktopThreadIdentity } from "./desktop-types.js";

type Options = Record<string, unknown>;
const required = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Desktop ${label} is required`);
  return value;
};
/** Typed controls operate on the original Desktop owner; they never launch or resume a CLI. */
export async function desktopControlForCli(runtime: DesktopRuntime, command: string, options: Options,
  subject: { id: string; identity: DesktopThreadIdentity }, watchId?: string): Promise<Record<string, unknown> | undefined> {
  let result: Record<string, unknown>;
  if (command === "permission-options" || command === "native-inspect" && options.action === "permissions") {
    result = await runtime.controls.permissionOptions(subject.identity);
  } else if (command === "set-permissions") {
    const mode = required(options.mode, "permission mode");
    if (mode !== "read-only" && mode !== "default" && mode !== "full-access") throw new Error("Invalid Desktop permission mode");
    result = await runtime.controls.setPermissions(subject.identity, mode);
  } else if (command === "model-options") {
    result = await runtime.controls.modelOptions(subject.identity);
  } else if (command === "set-model") {
    result = await runtime.controls.setModel(subject.identity, { model: required(options.model, "model"),
      reasoningEffort: required(options.reasoningEffort, "reasoning effort"),
      ...(options.collaborationMode === undefined ? {} : { collaborationMode: desktopMode(options.collaborationMode) }) });
  } else if (command === "cancel") {
    result = await runtime.controls.interrupt(subject.identity, required(options.expectedNativeTurnId, "expected native turn ID"));
    if (watchId) await runtime.tasks.reconcile(watchId);
  } else return undefined;
  const input = { conversation_id: subject.id };
  const available_actions = command === "permission-options" || command === "native-inspect" && options.action === "permissions"
    ? { set_permissions: { tool: "agent_knock_knock_set_permissions", input } }
    : command === "model-options" ? { set_model: { tool: "agent_knock_knock_set_model", input } } : undefined;
  return { ...result, ...(available_actions ? { available_actions } : {}), source: "codex_desktop", conversation_id: subject.id, native_thread_id: subject.identity.threadId,
    ...(watchId ? { watch_id: watchId } : {}) };
}
function desktopMode(value: unknown): "plan" | "default" {
  if (value !== "plan" && value !== "default") throw new Error("Desktop collaboration_mode must be plan or default");
  return value;
}

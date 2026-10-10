import { nonBlankString, recordValue } from "./value-guards.js";
import { isCodexNativeConversationId } from "./codex-native-identity.js";

type Options = Record<string, unknown>;
const backendCommands = new Set(["send", "status", "watch-terminal", "native-status", "permission-options", "set-permissions"]);
const terminalCommands = new Set(["model-options", "set-model", "cancel", "new-thread", "clear-thread", "resume-thread",
  "list-resumable-threads", "threads", "identify-foreground", "repair-model-control", "reconcile-binding", "close"]);
const interactionCommands = new Set(["approve", "respond-interaction"]);
const nativeInteraction = /^codex-native-interaction:[0-9a-f]{64}$/u;
const nativePermissionModes = { read_only: "read-only", ask_for_approval: "default", full_access: "full-access" };

/** Provider support, not a version allowlist. Bound Turn/Watch operations never change provider. */
export function conversationCommandPolicy(command: string, options: Options) {
  if (options.watch || options.turn || options.respond) return undefined;
  if (interactionCommands.has(command)) {
    const backend = isCodexNativeConversationId(options.conversation ?? options.conversationId ?? options.terminal ?? options.session)
      || nativeInteraction.test(String(options.interaction ?? "")) || String(options.interaction ?? "").startsWith("codex-native-interaction:");
    return { backend, requireBackend: backend };
  }
  if (command === "native-inspect") return {
    backend: ["status", "permissions"].includes(String(options.action ?? options.inspection ?? "status")), requireBackend: false
  };
  if (command === "set-permissions" && options.mode === "approve_for_me") return { backend: false, requireBackend: false };
  if (backendCommands.has(command)) return { backend: true, requireBackend: options.routingRequireNative === true };
  if (terminalCommands.has(command)) return { backend: false, requireBackend: false };
  return undefined;
}

export function routedCommand(command: string, options: Options, route: "native" | "terminal"): string {
  if (command === "native-status") return "native-inspect";
  if (route === "terminal" && command === "native-inspect" && (options.action ?? options.inspection) === "permissions") return "permission-options";
  return command;
}

/** Read/catalog authority may be refreshed. A displayed mutation offer must never be invented. */
export function prepareConversationTerminalOptions(command: string, selected: Options, row: Options): void {
  const actions = recordValue(row.available_actions);
  const action = command === "send" ? "send" : command === "native-inspect" ? "native_inspect" : command.replaceAll("-", "_");
  const args = recordValue(recordValue(actions?.[action])?.arguments);
  if (command === "send") {
    if (!nonBlankString(selected.expectedTerminalToken) && !nonBlankString(args?.expected_terminal_token)) {
      throw new Error("Exact terminal fallback cannot currently accept this task");
    }
    // Existing explicit Send authority is revalidated by the dispatch boundary, even when List
    // cannot advertise a new offer. Never turn this routing preflight into a second UI veto.
    selected.expectedTerminalToken ??= args?.expected_terminal_token;
    selected.expectedManagedTerminalToken ??= args?.expected_managed_terminal_token;
  } else if (["native-inspect", "permission-options", "model-options", "new-thread", "clear-thread", "repair-model-control"].includes(command)) {
    if (!nonBlankString(selected.expectedBindingToken)) {
      const authority = command === "clear-thread" ? recordValue(recordValue(actions?.new_thread)?.arguments) : args;
      if (!nonBlankString(authority?.expected_binding_token)) throw new Error(`Exact terminal fallback cannot currently perform ${command}; refresh AKK List`);
      selected.expectedBindingToken = authority!.expected_binding_token;
    }
  } else if (["set-permissions", "set-model"].includes(command)) {
    if (!nonBlankString(selected.expectedBindingToken) || !nonBlankString(selected.expectedCatalogFingerprint)) {
      throw new Error(`Backend operation is unavailable; refresh ${command === "set-model" ? "model-options" : "permission-options"} before using its terminal fallback`);
    }
  }
  if (command === "native-inspect") selected.inspection ??= "status";
}

export function conversationRoutedOptions(command: string, options: Options, route: "native" | "terminal", targetId: string): Options {
  const result = { ...options };
  for (const key of ["conversation", "conversationId", "terminal", "session", "routingRequireNative"]) delete result[key];
  result.conversation = targetId;
  if (route === "native") {
    for (const key of ["expectedTerminalToken", "expectedManagedTerminalToken", "expectedBindingToken", "expectedCatalogFingerprint"]) delete result[key];
    result.openclawSession ??= "agent:main:main";
    result.action ??= result.inspection;
    if (command === "set-permissions" && Object.hasOwn(nativePermissionModes, String(result.mode))) {
      result.mode = nativePermissionModes[String(result.mode) as keyof typeof nativePermissionModes];
    }
  } else result.inspection ??= result.action;
  return result;
}

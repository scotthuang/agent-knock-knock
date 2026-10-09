import {
  consumeSemanticPrivateAuthorityOffer,
  rememberSemanticPrivateAuthorityOffer,
  type SemanticPrivateAuthorityOfferKey,
  type SemanticPrivateAuthorityOfferPayload
} from "./semantic-private-authority-offers.js";
import {
  buildAkkCommandCliArgs,
  type AkkCommand
} from "./semantic-tool-command-helpers.js";
import {
  requiredControllerSessionId,
  requiredControllerSessionKey,
  requiredString
} from "./semantic-tool-arguments.js";
import {
  assertOnlyModelControlParameters,
  privateTerminalActionArguments
} from "./semantic-tool-private-authority.js";
import { permissionOptionsParameters, setPermissionsParameters } from
  "./semantic-tool-schemas.js";
import { runHostAwareCli } from "./semantic-tool-relay.js";
import { modelFacingErrorMessage } from "./semantic-tool-presentation.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import { nativeConversationTarget, nativePermissionToolArgs } from "./codex-native-semantic.js";
import { isCodexNativeConversationId } from "./codex-native-identity.js";

const PERMISSION_CONTROL_TIMEOUT_MS = 3 * 60_000;
type ControllerContext = { sessionKey?: unknown; sessionId?: unknown };
interface PermissionOffer extends SemanticPrivateAuthorityOfferPayload {
  readonly choices?: unknown;
}

function offerKey(context: ControllerContext, terminalId: string): SemanticPrivateAuthorityOfferKey {
  return {
    sessionKey: requiredControllerSessionKey(context.sessionKey),
    sessionId: requiredControllerSessionId(context.sessionId),
    kind: "permission_options",
    target: { type: "terminal_id", id: terminalId }
  };
}

function exactTerminalId(value: unknown): string {
  const id = requiredString(value, "terminal_id");
  if (!/^terminal:v[0-9]+:\S+$/u.test(id)) {
    throw new Error("terminal_id must be the exact full terminal identifier returned by AKK list");
  }
  return id;
}

function semanticMode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value)) {
    throw new Error("mode must be one exact semantic id from the displayed permission catalog; " +
      "raw commands, keys, labels, and menu indexes are forbidden");
  }
  return value;
}

export async function buildPrivatePermissionOptionsArgs(
  api,
  params: Record<string, unknown>,
  context: ControllerContext
): Promise<string[]> {
  const native = nativePermissionToolArgs(params, isRecord(api.pluginConfig) ? api.pluginConfig : {}, context, "permissions");
  if (native) return native;
  assertOnlyModelControlParameters(params, ["terminal_id"], "permission_options");
  const terminalId = exactTerminalId(params.terminal_id);
  // Refresh revokes the old offer even if discovery subsequently fails. Check
  // the controller incarnation before issuing any native inspection input.
  consumeSemanticPrivateAuthorityOffer(api, offerKey(context, terminalId));
  const action = await privateTerminalActionArguments(
    api, terminalId, "agent_knock_knock_permission_options", { reconcile: false }
  );
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = buildAkkCommandCliArgs(
    { action: "permission-options", terminalId }, config,
    { expectedBindingToken: action.expected_binding_token }
  );
  if (!args) throw new Error("could not build permission-options command");
  return args;
}

export function rememberDisplayedPermissionOptionsOffer(
  api: object,
  context: ControllerContext,
  requestedTerminalId: unknown,
  value: unknown
): void {
  const terminalId = exactTerminalId(requestedTerminalId);
  const key = offerKey(context, terminalId);
  consumeSemanticPrivateAuthorityOffer(api, key);
  if (!isRecord(value) || value.terminal_id !== terminalId ||
      value.agent !== "codex" || value.scope !== "current_session") {
    throw new Error("permission-options returned an invalid terminal, agent, or mutation scope");
  }
  // A current setting need not be selectable: for example, read-only can be
  // reported by /status while the macOS picker omits that built-in preset.
  semanticMode(value.current);
  const choices = permissionChoices(value.choices);
  const available = isRecord(value.available_actions) ? value.available_actions : {};
  const action = isRecord(available.set_permissions) ? available.set_permissions : {};
  if (action.tool !== "agent_knock_knock_set_permissions" || !isRecord(action.arguments)) {
    throw new Error("permission-options did not advertise a typed set-permissions action");
  }
  const args = action.arguments;
  if (args.terminal_id !== terminalId) throw new Error("set-permissions action belongs to another terminal");
  const binding = requiredString(args.expected_binding_token, "current internal permission binding authority");
  const fingerprint = requiredString(args.expected_catalog_fingerprint, "current internal permission catalog authority");
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || fingerprint !== value.catalog_fingerprint) {
    throw new Error("set-permissions action does not match the displayed catalog");
  }
  rememberSemanticPrivateAuthorityOffer(api, key, {
    fingerprint,
    args: { terminal_id: terminalId, expected_binding_token: binding, expected_catalog_fingerprint: fingerprint },
    choices
  });
}

function permissionChoices(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("permission-options returned no selectable modes");
  const ids = value.map((choice) => {
    if (!isRecord(choice) ||
        !stringValue(choice.label) || !stringValue(choice.description)) {
      throw new Error("permission-options returned an invalid semantic choice");
    }
    return semanticMode(choice.id);
  });
  if (new Set(ids).size !== ids.length) throw new Error("permission-options returned duplicate mode ids");
  return ids;
}

export function buildPrivateSetPermissionsArgs(
  api,
  params: Record<string, unknown>,
  context: ControllerContext
): string[] {
  const native = nativePermissionToolArgs(params, isRecord(api.pluginConfig) ? api.pluginConfig : {}, context, "set-permissions");
  if (native) return native;
  assertOnlyModelControlParameters(params, ["terminal_id", "mode"], "set_permissions");
  const terminalId = exactTerminalId(params.terminal_id);
  const mode = semanticMode(params.mode);
  const offered = consumeSemanticPrivateAuthorityOffer<PermissionOffer>(api, offerKey(context, terminalId));
  if (!offered || !isRecord(offered.args) || !Array.isArray(offered.choices)) {
    throw new Error("set_permissions requires current choices shown by " +
      "agent_knock_knock_permission_options in this controller conversation; " +
      "refresh permission options before another attempt");
  }
  if (!offered.choices.includes(mode)) throw new Error("mode was not advertised by the current native permission catalog");
  if (offered.args.terminal_id !== terminalId || offered.args.expected_catalog_fingerprint !== offered.fingerprint) {
    throw new Error("the displayed permission catalog authority changed");
  }
  const config = isRecord(api.pluginConfig) ? api.pluginConfig : {};
  const args = buildAkkCommandCliArgs(
    { action: "set-permissions", terminalId, mode }, config,
    { expectedBindingToken: offered.args.expected_binding_token, expectedCatalogFingerprint: offered.fingerprint }
  );
  if (!args) throw new Error("could not build set-permissions command");
  return args;
}

export function isAkkSetPermissionsSuccess(value: unknown): boolean {
  if (!isRecord(value) || value.scope !== "current_session" ||
      value.defaults_changed !== false || value.do_not_retry !== false ||
      !isRecord(value.requested) || !isRecord(value.effective)) return false;
  return (value.outcome === "changed" || value.outcome === "already_effective") &&
    typeof value.requested.mode === "string" && value.effective.mode === value.requested.mode;
}

export function registerPermissionControlTools(api, registerCliTool): void {
  registerCliTool(api, {
    name: "agent_knock_knock_permission_options",
    description: "For a listed direct Codex CLI conversation_id, read settings and built-in " +
      "choices through its backend without terminal input. For terminal_id, " +
      "inspect the current Codex permission setting and built-in choices for one " +
      "explicitly selected idle physical terminal. This closed /status and " +
      "/permissions inspection sends native UI input but does not change " +
      "permissions. It requires an empty Composer, exact pane/process and native " +
      "thread identity, and no active task or input-owning prompt. Use current, " +
      "scope, and returned choices to select the requested or authorized mode " +
      "before set_permissions. Full Access is an ordinary option and needs no " +
      "additional user confirmation. Only modes actually displayed by this native " +
      "picker may be selected; arbitrary profiles and configuration paths are " +
      "unsupported.",
    parameters: permissionOptionsParameters,
    timeoutMs: PERMISSION_CONTROL_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    buildArgs: (params, context) => buildPrivatePermissionOptionsArgs(api, params, context ?? {}),
    rememberResult: (result, params, context) => {
      if (!nativeConversationTarget(params)) rememberDisplayedPermissionOptionsOffer(api, context ?? {}, params.terminal_id, result);
    }
  });
  registerCliTool(api, {
    name: "agent_knock_knock_set_permissions",
    description: "For a listed direct Codex CLI conversation_id, set read-only, default, or " +
      "full-access through its backend and verify effective settings; no terminal " +
      "UI or extra confirmation is needed. For terminal_id, set one requested or " +
      "authorized Codex permission mode from the immediately " +
      "preceding permission_options result in the same controller conversation. " +
      "Consumes that private catalog once and revalidates the exact physical " +
      "terminal, native thread, empty Composer and idle state. Full Access is an " +
      "ordinary selectable mode with no additional user confirmation. AKK " +
      "automatically handles its exact native confirmation inside this closed " +
      "transaction; never ask the user to confirm it separately or use generic " +
      "approve for it. Scope is the current session/thread and may persist when " +
      "that thread is resumed; global defaults stay unchanged. Ordinary Send does " +
      "not change permissions. No raw commands, keys, menu indexes, labels, " +
      "arbitrary profiles, tokens, or scope overrides are accepted. Proceed with a " +
      "task only after changed/already_effective and effective.mode matches the " +
      "request; uncertain means stop and do not retry automatically.",
    parameters: setPermissionsParameters,
    timeoutMs: PERMISSION_CONTROL_TIMEOUT_MS,
    normalizeTurnIdentity: false,
    isErrorResult: (result) => !isAkkSetPermissionsSuccess(result),
    buildArgs: (params, context) => buildPrivateSetPermissionsArgs(api, params, context ?? {})
  });
}

export async function handleAkkPermissionCommand(
  api,
  context: ControllerContext,
  command: Extract<AkkCommand, { action: "permission-options" | "set-permissions" }>
): Promise<{ text: string; isError?: boolean }> {
  const native = isCodexNativeConversationId(command.terminalId);
  const params = native ? { conversation_id: command.terminalId } : { terminal_id: command.terminalId };
  if (command.action === "permission-options") {
    const args = await buildPrivatePermissionOptionsArgs(api, params, context);
    const result = await runHostAwareCli(api, args, { timeoutMs: PERMISSION_CONTROL_TIMEOUT_MS });
    if (!native) rememberDisplayedPermissionOptionsOffer(api, context, command.terminalId, result);
    return { text: formatAkkPermissionOptionsCommandResult(result) };
  }
  const args = buildPrivateSetPermissionsArgs(api, { ...params, mode: command.mode }, context);
  const result = await runHostAwareCli(api, args, { timeoutMs: PERMISSION_CONTROL_TIMEOUT_MS });
  return { text: formatAkkSetPermissionsCommandResult(result), isError: !isAkkSetPermissionsSuccess(result) };
}

export function formatAkkPermissionOptionsCommandResult(result: Record<string, unknown>): string {
  const terminalId = stringValue(result.conversation_id) ?? stringValue(result.terminal_id) ?? "unknown";
  const native = result.source === "codex_cli";
  const choices = Array.isArray(result.choices) ? result.choices.filter(isRecord) : [];
  return [
    "AKK Codex permission options:",
    `${native ? "conversation" : "terminal"}: ${terminalId}`,
    `current: ${stringValue(result.current) ?? "unknown"}`,
    "scope: current_session (may be retained when this thread is resumed); global defaults are unchanged.",
    ...choices.map((choice) => `- ${choice.id}: ${choice.label} — ${choice.description}`),
    `next: /akk set-permissions ${terminalId} <advertised-mode-id>`,
    "Use a displayed mode for the requested permission change. Full Access needs " +
      "no additional user confirmation; " + (native ? "AKK verifies the effective backend settings." : "AKK handles its native dialog automatically.")
  ].join("\n");
}

export function formatAkkSetPermissionsCommandResult(result: Record<string, unknown>): string {
  const requested = isRecord(result.requested) ? result.requested : {};
  const effective = isRecord(result.effective) ? result.effective : {};
  const success = isAkkSetPermissionsSuccess(result);
  return [
    success ? "AKK verified the requested Codex permissions." : "AKK could not prove the permission-change postcondition.",
    `requested: ${stringValue(requested.mode) ?? "unknown"}`,
    `effective: ${stringValue(effective.mode) ?? "unproven"}`,
    "scope: current_session (may be retained when this thread is resumed); global defaults are unchanged.",
    ...(stringValue(result.reason) ? [`reason: ${modelFacingErrorMessage(new Error(String(result.reason)))}`] : []),
    success ? "You can now send the intended task. No task or AKK Turn was created by this permission change." : "Stop before sending the task. Do not retry automatically; inspect the " +
      "terminal and refresh permission options before a deliberate new attempt."
  ].join("\n");
}

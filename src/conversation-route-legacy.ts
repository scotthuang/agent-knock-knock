import { createHash } from "node:crypto";
import { assertCodexNativeTaskRecord } from "./codex-native-state-store.js";
import { nativeDigest, nativeErrorCode, type CodexNativeTaskService } from "./codex-native-task-service.js";
import { ConversationRouteError, type ConversationRouteInput } from "./conversation-route-store.js";
import type { ConversationRouteSelection } from "./conversation-route-dispatch.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import { createTerminalUserSendIntentRepository } from "./terminal-user-send-intent.js";

export interface LegacyConversationRouteOptions {
  input: ConversationRouteInput;
  nativeTasks: Pick<CodexNativeTaskService, "status">;
  /** The same host runtime directory used by explicit terminal Send. */
  terminalRuntimeDir: string;
  /** Required to keep an old explicit Send in the provider that owns its ledger. */
  expectedTerminalToken?: string;
  managedOnly?: boolean;
}

function conflict(detail: string): never {
  throw new ConversationRouteError("conversation_route_conflict",
    `Message ID is already bound to different immutable request input or a different legacy route: ${detail}`);
}

/** Consult only the two exact old message ledgers, before backend discovery or input.
 * An old reservation remains a route pin even when its outcome is uncertain.
 * Terminal receipts predate public target storage; their provider must still
 * validate runtime key and physical token before replay or any input.
 */
export function selectLegacyConversationRoute(options: LegacyConversationRouteOptions): ConversationRouteSelection | undefined {
  const { input, nativeTasks, terminalRuntimeDir } = options;
  const id = `codex-cli-watch:${nativeDigest([input.controllerSession, input.messageId])}`;
  let native;
  try { native = nativeTasks.status(id); }
  catch (error) { if (nativeErrorCode(error) !== "codex_native_watch_not_found") throw error; }
  if (native) {
    assertCodexNativeTaskRecord(native);
    if (native.id !== id || native.kind !== "send" || native.controller_session !== input.controllerSession ||
      native.send_intent?.message_id !== input.messageId || native.send_intent.text !== input.requestText) {
      conflict("native message identity or request changed");
    }
    if (native.native_id !== input.canonicalTarget) conflict("native conversation changed or terminal alias is unproven");
  }
  const terminal = createTerminalUserSendIntentRepository({ runtimeDir: terminalRuntimeDir }).loadMessage({ messageId: input.messageId });
  if (native && terminal) conflict("both transport ledgers already exist; automatic routing is ambiguous");
  if (native) return { route: "native", targetId: native.native_id, reason: "legacy_native_message" };
  if (!terminal) return undefined;
  const requestHash = createHash("sha256").update(terminalSubmissionPayload(input.requestText)).digest("hex");
  if (terminal.request_hash !== requestHash) conflict("terminal request changed");
  const target = parseTerminalConversationId(input.canonicalTarget);
  if (target?.agent !== "codex") conflict("legacy terminal receipt cannot identify a terminal from a backend alias");
  if (options.managedOnly || options.expectedTerminalToken !== terminal.physical_token) {
    conflict("legacy terminal Send requires its exact explicit terminal authority");
  }
  return { route: "terminal", targetId: input.canonicalTarget, reason: "legacy_terminal_message" };
}

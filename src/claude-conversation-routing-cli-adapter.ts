import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { cliDependencies, cliEnv, cliNow, cliNowMs, cliPid, cliSleepSync, writeCliStdout } from "./cli-runtime-context.js";
import { claudeNativeRuntimeOptions } from "./claude-native-cli-adapter.js";
import { createClaudeNativeRuntime } from "./claude-native-runtime.js";
import { isClaudeNativeConversationId, parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { parseTerminalConversationId } from "./terminal-agent-adapter.js";
import { exactClaudeTerminal } from "./claude-conversation-routing-identity.js";
import { dispatchConversationRoute } from "./conversation-route-dispatch.js";
import { ConversationRouteError, type ConversationRouteChoice, type ConversationRouteInput } from "./conversation-route-store.js";
import { createConversationRuntimeRouteStore } from "./conversation-runtime-route-store.js";
import { createTerminalUserSendIntentRepository } from "./terminal-user-send-intent.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import { defaultStoreDir } from "./store.js";
import { expandHome } from "./cli-command-runtime.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { conversationRoutedOptions, prepareConversationTerminalOptions } from "./conversation-routing-commands.js";
import type { ConversationRoutingCliPorts } from "./conversation-routing-commands.js";

const core = new Set(["send", "status", "watch-terminal", "native-status"]);
const special = new Set(["model-options", "set-model", "permission-options", "set-permissions", "cancel", "new-thread", "clear-thread", "resume-thread", "list-resumable-threads", "threads", "native-inspect", "approve", "respond-interaction", "reconcile-binding"]);
const unavailable = new Set(["identity_unavailable", "discovery_unavailable", "unsupported_platform", "unsupported_contract", "registry_unavailable", "peer_helper_unavailable", "ENOENT", "ECONNREFUSED", "ENOTSOCK"]);
const code = (error: unknown) => error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
const isCore = (command: string, options: Record<string, unknown>) => core.has(command)
  || command === "native-inspect" && [undefined, "status"].includes((options.action ?? options.inspection) as string | undefined);

export async function dispatchClaudeConversationCli(command: string | undefined, original: Record<string, unknown>, ports: ConversationRoutingCliPorts): Promise<boolean> {
  const target = claudeRoutingTarget(command, original);
  if (!target || !command) return false;
  const native = isClaudeNativeConversationId(target);
  const options: Record<string, unknown> = { ...original, ...(command === "send" ? { messageId: original.messageId ?? randomUUID() } : {}) };
  const configuration = claudeNativeRuntimeOptions(options);
  const runtime = (cliDependencies().createClaudeNativeRuntime ?? createClaudeNativeRuntime)(configuration);
  const input = command === "send" ? { controllerSession: String(options.openclawSession ?? "agent:main:main"),
    messageId: String(options.messageId), requestText: String(options.message ?? options.request ?? ""), canonicalTarget: target } : undefined;
  const terminalRuntimeDir = cliEnv().AKK_RUNTIME_DIR ? path.resolve(expandHome(cliEnv().AKK_RUNTIME_DIR)!) : path.join(path.dirname(defaultStoreDir()), "runtime-v2");
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  try {
    const result = await dispatchConversationRoute({ command, input,
      store: input ? createConversationRuntimeRouteStore(configuration.storeDir, terminalRuntimeDir, locks, { now: cliNow }) : undefined,
      select: () => selectClaudeRoute({ command, target, native, options, ports, runtime, input, terminalRuntimeDir }),
      execute: async (choice: ConversationRouteChoice) => {
        const selected = conversationRoutedOptions(command, options, choice.route, choice.targetId);
        const selectedCommand = command === "native-status" ? "native-inspect" : command;
        if (choice.route === "terminal") {
          const rows = await ports.terminals(options, choice.targetId);
          if (rows.length !== 1 || rows[0].id !== choice.targetId || native && !exactClaudeTerminal(target, rows[0])) throw new Error("Claude terminal identity changed; no input was sent");
          prepareConversationTerminalOptions(selectedCommand, selected, rows[0]);
        }
        return ports.execute(selectedCommand, selected);
      }
    });
    const routing = result.routing as Record<string, unknown> | undefined;
    if (routing?.transport === "codex_backend") routing.transport = "claude_native";
    writeCliStdout(JSON.stringify(result, null, 2) + "\n");
    return true;
  } finally { await runtime.close(); }
}

/** An older terminal Send retains its original provider even after direct discovery becomes available. */
function legacyClaudeTerminalRoute(input: ConversationRouteInput, options: Record<string, unknown>, runtimeDir: string): ConversationRouteChoice | undefined {
  const prior = createTerminalUserSendIntentRepository({ runtimeDir }).loadMessage({ messageId: input.messageId });
  if (!prior) return undefined;
  const requestHash = createHash("sha256").update(terminalSubmissionPayload(input.requestText)).digest("hex");
  if (prior.request_hash !== requestHash || parseTerminalConversationId(input.canonicalTarget)?.agent !== "claude"
    || options.expectedTerminalToken !== prior.physical_token) {
    throw new ConversationRouteError("conversation_route_conflict", "Existing terminal message requires its unchanged request and exact original terminal authority");
  }
  return { route: "terminal", targetId: input.canonicalTarget };
}

type ClaudeRouteContext = {
  command: string; target: string; native: boolean; options: Record<string, unknown>;
  ports: ConversationRoutingCliPorts; runtime: ReturnType<typeof createClaudeNativeRuntime>;
  input?: ConversationRouteInput; terminalRuntimeDir: string;
};
async function selectClaudeRoute(context: ClaudeRouteContext): Promise<ConversationRouteChoice & { reason?: string }> {
  const { command, target, native, options, ports, runtime, input, terminalRuntimeDir } = context;
  const legacy = input ? legacyClaudeTerminalRoute(input, options, terminalRuntimeDir) : undefined;
  if (legacy) return legacy;
  if (native && isCore(command, options)) {
    try { await runtime.inspect(parseClaudeNativeConversationId(target)); return { route: "native", targetId: target }; }
    catch (error) { if (!unavailable.has(code(error))) throw error; }
  }
  const terminals = await ports.terminals(options, native ? undefined : target);
  const exact = native ? terminals.filter(row => exactClaudeTerminal(target, row))
    : terminals.filter(row => row.id === target);
  if (exact.length !== 1) {
    if (native) return { route: "native", targetId: target, reason: "manual_required" };
    throw new Error("Exact Claude terminal is unavailable; no input was sent");
  }
  if (!native && isCore(command, options)) {
    const discovery = await runtime.catalog.discover();
    const matches = discovery.sessions.filter(entry => exactClaudeTerminal(entry.nativeId, exact[0]));
    if (matches.length > 1) throw new Error("Claude native identity is ambiguous; no input was sent");
    if (matches.length === 1) {
      // Busy/blocked remains a native result, never an excuse to switch transport.
      await runtime.inspect(matches[0]);
      return { route: "native", targetId: matches[0].nativeId };
    }
    const unsafe = discovery.errors.find(error => !unavailable.has(error.code));
    if (unsafe) throw new Error(`Claude discovery failed verification: ${unsafe.code}; no input was sent`);
  }
  return { route: "terminal", targetId: String(exact[0].id) };

}

function claudeRoutingTarget(command: string | undefined, original: Record<string, unknown>): string | undefined {
  const target = original.conversation ?? original.conversationId ?? original.terminal ?? original.session;
  if (!command || typeof target !== "string" || original.watch || original.turn || original.respond || original.managedOnly === true
    || !isCore(command, original) && !special.has(command)) return undefined;
  const native = isClaudeNativeConversationId(target);
  if (!native && parseTerminalConversationId(target)?.agent !== "claude") return undefined;
  if (["conversation", "conversationId", "terminal", "session"].filter(key => original[key] !== undefined).length !== 1) throw new Error("Claude routing requires exactly one conversation target");
  if (command === "send" && (original.type ?? "task") !== "task") throw new Error("Claude direct send accepts tasks only");
  return target;
}

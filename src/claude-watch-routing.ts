import { exactClaudeTerminal } from "./claude-conversation-routing-identity.js";
import { parseClaudeNativeConversationId } from "./claude-native-identity.js";
import type { createClaudeNativeRuntime } from "./claude-native-runtime.js";
import { claudeWatchRefusal, markClaudeWatchActivity } from "./claude-native-watch-admission.js";
import type { ConversationRouteChoice } from "./conversation-route-store.js";
import type { ConversationRoutingCliPorts } from "./conversation-routing-commands.js";
import { recordValue } from "./value-guards.js";

/** Choose before creating a Watch. Never retry an executed native Watch on another transport. */
export async function selectClaudeWatchRoute(context: {
  target: string; native: boolean; options: Record<string, unknown>;
  ports: ConversationRoutingCliPorts; runtime: ReturnType<typeof createClaudeNativeRuntime>;
}): Promise<ConversationRouteChoice> {
  const { target, native, options, ports, runtime } = context;
  let nativeId = native ? target : undefined;
  let rows: Record<string, unknown>[] | undefined;
  if (!native) {
    rows = (await ports.terminals(options, target)).filter(row => row.id === target);
    if (rows.length !== 1) throw claudeWatchRefusal("terminal_identity_unavailable", rows.length ? "multiple_matches" : "no_match");
    const discovery = await runtime.catalog.discover();
    const matches = discovery.sessions.filter(entry => exactClaudeTerminal(entry.nativeId, rows![0]));
    if (matches.length > 1) throw claudeWatchRefusal("native_identity_ambiguous", "forbidden");
    nativeId = matches[0]?.nativeId;
    if (!nativeId) {
      // The native peer transport is optional for an explicitly selected terminal.
      // Identity failures and unclassified errors still cannot authorize fallback.
      const unsafe = discovery.errors.find(({ code }) => code !== "unsupported_platform" && code !== "peer_helper_unavailable");
      if (unsafe) throw claudeWatchRefusal(`native_discovery_unverified (${unsafe.code})`, "not_checked");
      return { route: "terminal", targetId: target };
    }
  }
  // Process/identity errors propagate: a different process cannot inherit this Watch.
  const admission = await runtime.watchReadiness(parseClaudeNativeConversationId(nativeId!));
  if (admission.ready) return { route: "native", targetId: nativeId! };
  if (!admission.fallbackAllowed) throw claudeWatchRefusal(admission.reason, "forbidden_identity_mismatch");
  rows ??= await ports.terminals(options);
  const exact = rows.filter(row => exactClaudeTerminal(nativeId!, row));
  if (exact.length !== 1) throw claudeWatchRefusal(admission.reason, exact.length ? "multiple_matches" : "no_match");
  const controls = recordValue(exact[0].terminal_control);
  if (!Array.isArray(controls?.capabilities) || !controls.capabilities.includes("screen_status")) {
    throw claudeWatchRefusal(admission.reason, "screen_status_unavailable");
  }
  const choice: ConversationRouteChoice = { route: "terminal", targetId: String(exact[0].id) };
  markClaudeWatchActivity(choice, { nativeId: nativeId!, reason: admission.reason });
  return choice;
}

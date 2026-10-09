import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cliCwd, cliEnv, cliDependencies, writeCliStdout } from "./cli-runtime-context.js";
import { isDesktopConversationId, parseDesktopConversationId } from "./desktop-identity.js";
import { isDesktopWatchId } from "./desktop-semantic.js";
import { createDesktopRuntime, desktopWritesVerified, type DesktopRuntime, type DesktopRuntimeOptions } from "./desktop-runtime.js";
import { createTerminalWatchOpenClawCallbackRoute, parseCallbackRoute } from "./callback-transport.js";
import { desktopSessionProjection, desktopTaskProjection } from "./desktop-public-projection.js";
import { desktopTaskNeedsReconciliation } from "./desktop-task-service.js";
import { listDesktopSessions } from "./desktop-list.js";
import { launchDesktopMonitor, runDesktopMonitor } from "./desktop-monitor.js";
import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import type { DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";

type Options = Record<string, unknown>;
interface DesktopConversation {
  id: string;
  identity: DesktopThreadIdentity;
  entry: DesktopCatalogEntry;
}
const NATIVE_COMMANDS = ["desktop-list", "monitor-desktop", "reconcile-desktop-watches"];
const SUPPORTED_COMMANDS = [...NATIVE_COMMANDS, "send", "status", "watch-terminal", "watch-status", "unwatch-terminal"];
const str = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const required = (value: unknown, label: string): string => {
  const result = str(value); if (!result) throw new Error(`Desktop ${label} is required`); return result;
};
const output = (value: unknown) => writeCliStdout(JSON.stringify(value, null, 2) + "\n");

export function desktopRuntimeOptions(options: Options): DesktopRuntimeOptions {
  const env = cliEnv(); const home = env.HOME ?? os.homedir();
  const resolve = (value: string) => path.resolve(cliCwd(), value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  let homes = [path.join(home, ".codex"), ...(str(options.codexHome) ? [str(options.codexHome)!] : env.CODEX_HOME ? [env.CODEX_HOME] : [])];
  if (env.AKK_DESKTOP_CODEX_HOMES) {
    const saved: unknown = JSON.parse(env.AKK_DESKTOP_CODEX_HOMES);
    if (!Array.isArray(saved) || !saved.length || saved.some(item => typeof item !== "string" || !path.isAbsolute(item))) {
      throw new Error("Invalid configured Desktop homes");
    }
    homes = saved;
  }
  return { storeDir: resolve(str(options.storeDir ?? options.logDir) ?? path.join(home, ".agent-knock-knock", "store")),
    codexHomes: [...new Set(homes.map(resolve))], openclawBin: str(options.openclawBin) };
}

export async function desktopListForCli(options: Options): Promise<Record<string, unknown>> {
  if (options.agent && options.agent !== "codex") return { desktop_sessions: [], desktop_watches: [], desktop_scan: { status: "filtered" } };
  const runtime = (cliDependencies().createDesktopRuntime ?? createDesktopRuntime)(desktopRuntimeOptions(options));
  try { return await listDesktopSessions(runtime, options); } finally { await runtime.close(); }
}

async function reconcileDesktopWatches(runtime: DesktopRuntime): Promise<void> {
  const before = new Map<string, ReturnType<typeof runtime.tasks.status>>();
  try { for (const task of runtime.tasks.list()) before.set(task.id, task); }
  catch { /* reconcileAll isolates damaged records */ }
  const result = await runtime.tasks.reconcileAll();
  const callbacksDelivered = result.tasks.reduce((count, task) => count + task.notifications.filter(note =>
    note.status === "accepted" && !before.get(task.id)?.notifications.some(old =>
      old.id === note.id && old.status === "accepted")).length, 0);
  output({
    checked: result.tasks.length + result.errors.length,
    changed: result.tasks.filter(task => task.status !== before.get(task.id)?.status).length,
    callbacks_delivered: callbacksDelivered,
    errors: result.errors.length,
    diagnostics: result.errors
  });
}

async function inspectOrStopDesktopWatch(runtime: DesktopRuntime, command: string | undefined,
  options: Options, watch: string, target: string | undefined): Promise<void> {
  if (target || options.turn) throw new Error("Desktop Watch accepts exactly one target");
  const task = runtime.tasks.status(watch);
  const controller = str(options.openclawSession);
  if (controller && controller !== task.controller_session) throw new Error("Desktop Watch belongs to a different controller");
  if (command === "unwatch-terminal") {
    output(desktopTaskProjection(runtime.tasks.unwatch(watch,
      { controllerSession: required(controller, "controller session") })));
  } else if (command === "watch-status" || command === "status") {
    output(desktopTaskProjection(options.reconcile === true ? await runtime.tasks.reconcile(watch) : task));
  } else throw new Error("Desktop Watch ID is only valid for status or unwatch");
}

async function getDesktopConversation(runtime: DesktopRuntime, options: Options,
  target: string | undefined): Promise<DesktopConversation> {
  const id = required(target, "conversation ID");
  const identity = parseDesktopConversationId(id);
  if (["conversation", "conversationId", "session", "terminal"].filter(key => options[key] !== undefined).length !== 1 || options.turn) {
    throw new Error("Desktop command accepts exactly one conversation target");
  }
  const entry = await runtime.catalog.get(identity);
  if (!entry) throw new Error("Desktop conversation is absent from the configured local catalog; refresh List");
  return { id, identity, entry };
}

function latestTurnProjection(turn: DesktopTurn | undefined) {
  if (!turn) return null;
  const text = turn.items.filter(item => item.type === "agentMessage" &&
    item.phase !== "analysis" && item.phase !== "commentary").map(item => item.text ?? "").join("\n\n");
  const isFinal = turn.itemsComplete && ["completed", "failed", "interrupted"].includes(turn.status);
  return { id: turn.turnId, status: turn.status, items_complete: turn.itemsComplete,
    ...(isFinal ? { final_text: text } : { response_text: text }) };
}

async function inspectDesktopConversation(runtime: DesktopRuntime, { identity, entry }: DesktopConversation): Promise<void> {
  try {
    const snapshot = await runtime.transport.observe(identity);
    const current = snapshot.turns.find(turn => turn.turnId === snapshot.latestTurnId);
    output({ ...desktopSessionProjection(entry, snapshot, desktopWritesVerified(runtime.compatibility)),
      source: "codex_desktop", latest_turn: latestTurnProjection(current) });
  } catch { output(desktopSessionProjection(entry, undefined, false, "live_owner_not_confirmed")); }
}

async function sendOrWatchDesktopTask(runtime: DesktopRuntime, command: "send" | "watch-terminal",
  options: Options, config: DesktopRuntimeOptions, { id, identity }: DesktopConversation): Promise<void> {
  const controllerSession = required(options.openclawSession, "controller session");
  const route = options.callbackRoute ? parseCallbackRoute(options.callbackRoute)
    : createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controllerSession, openclawBin: config.openclawBin });
  const timeout = Number(options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes ?? 60) * 60_000;
  const input = { target: identity, desktopId: id, controllerSession, timeoutMs: timeout,
    callbackRoute: { ...route, capabilities: { wake: true, respond: false } } };
  const task = command === "send" ? await runtime.tasks.send({ ...input,
    text: required(options.message ?? options.request, "message"), messageId: str(options.messageId) ?? randomUUID() })
    : await runtime.tasks.watch(input);
  const result = desktopTaskProjection(task);
  if (desktopTaskNeedsReconciliation(task)) {
    try { result.monitor_pid = await (cliDependencies().launchDesktopMonitor ?? launchDesktopMonitor)(task.id, config); }
    catch { result.monitor_error = "desktop_monitor_launch_failed"; result.callback_expected = false; }
  }
  output(result);
}

/** Return false only for non-Desktop targets. Unsupported Desktop actions never fall through to terminals. */
export async function dispatchDesktopCli(command: string | undefined, options: Options): Promise<boolean> {
  const target = str(options.conversation ?? options.conversationId ?? options.session ?? options.terminal);
  const watch = str(options.watch);
  if (!isDesktopConversationId(target) && !isDesktopWatchId(watch) && !NATIVE_COMMANDS.includes(command ?? "")) return false;
  if (!SUPPORTED_COMMANDS.includes(command ?? "")) {
    throw new Error("Desktop v1 supports List, Send, Status and Watch only. Answer questions and approvals manually in Desktop.");
  }
  if (command === "desktop-list") { output(await desktopListForCli(options)); return true; }
  const config = desktopRuntimeOptions(options);
  if (command === "monitor-desktop") { await runDesktopMonitor(required(watch, "Watch ID"), config); return true; }
  const runtime = (cliDependencies().createDesktopRuntime ?? createDesktopRuntime)(config);
  try {
    if (command === "reconcile-desktop-watches") {
      await reconcileDesktopWatches(runtime);
      return true;
    }
    if (watch) {
      await inspectOrStopDesktopWatch(runtime, command, options, watch, target);
      return true;
    }
    const conversation = await getDesktopConversation(runtime, options, target);
    if (command === "status") {
      await inspectDesktopConversation(runtime, conversation);
      return true;
    }
    if (command !== "send" && command !== "watch-terminal") throw new Error("Desktop Watch ID is required");
    await sendOrWatchDesktopTask(runtime, command, options, config, conversation);
    return true;
  } finally { await runtime.close(); }
}

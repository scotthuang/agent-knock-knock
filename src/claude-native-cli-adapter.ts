import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cliCwd, cliDependencies, cliEnv, writeCliStdout } from "./cli-runtime-context.js";
import { createTerminalWatchOpenClawCallbackRoute, parseCallbackRoute } from "./callback-transport.js";
import { monitorMinutesToMs, resolveMonitorHardTimeoutMinutes } from "./monitor-deadline-policy.js";
import { assertBackendRecoveryCliTarget } from "./backend-recovery-semantic.js";
import { isClaudeNativeConversationId, isClaudeNativeWatchId, parseClaudeNativeConversationId } from "./claude-native-identity.js";
import { createClaudeNativeRuntime, type ClaudeNativeRuntimeOptions } from "./claude-native-runtime.js";
import { claudeNativeTaskNeedsReconciliation } from "./claude-native-task-service.js";
import { launchClaudeNativeMonitor, runClaudeNativeMonitor } from "./claude-native-monitor.js";
import { claudeNativeSessionProjection, claudeNativeTaskProjection } from "./claude-native-public-projection.js";
import type { ClaudeNativeTaskRecord } from "./claude-native-state-store.js";

type Options = Record<string, unknown>;
type Runtime = ReturnType<typeof createClaudeNativeRuntime>;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value : undefined;
const required = (value: unknown, label: string): string => { const result = text(value); if (!result) throw new Error(`Claude CLI ${label} is required`); return result; };
const output = (value: unknown) => writeCliStdout(JSON.stringify(value, null, 2) + "\n");
const commands = new Set(["claude-cli-list", "monitor-claude-native", "reconcile-claude-native-watches"]);

export function claudeNativeRuntimeOptions(options: Options): ClaudeNativeRuntimeOptions {
  const env = cliEnv(), home = env.HOME ?? os.homedir();
  const resolve = (value: string) => path.resolve(cliCwd(), value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  let dirs = [env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude")];
  if (env.AKK_NATIVE_CLAUDE_CONFIG_DIRS) {
    const configured: unknown = JSON.parse(env.AKK_NATIVE_CLAUDE_CONFIG_DIRS);
    if (!Array.isArray(configured) || !configured.length || configured.some(dir => typeof dir !== "string" || !path.isAbsolute(dir))) throw new Error("Invalid Claude native config directories");
    dirs = configured;
  }
  return { storeDir: resolve(text(options.storeDir ?? options.logDir) ?? path.join(home, ".agent-knock-knock", "store")),
    claudeConfigDirs: [...new Set(dirs.map(resolve))], claudeBin: text(options.claudeBin) ?? text(env.AKK_NATIVE_CLAUDE_BIN),
    pythonBin: text(options.pythonBin) ?? text(env.AKK_NATIVE_CLAUDE_PYTHON), openclawBin: text(options.openclawBin) };
}
const runtimeFor = (options: Options) => (cliDependencies().createClaudeNativeRuntime ?? createClaudeNativeRuntime)(claudeNativeRuntimeOptions(options));

export async function claudeNativeListForCli(options: Options): Promise<Record<string, unknown>> {
  if (options.agent && options.agent !== "claude") return { claude_cli_sessions: [], claude_cli_watches: [], claude_cli_scan: { status: "filtered" } };
  const runtime = runtimeFor(options);
  try {
    const discovery = await runtime.catalog.discover();
    const sessions = discovery.sessions.filter(entry => !options.status || entry.status === options.status).map(entry => claudeNativeSessionProjection(entry));
    let watches: ReturnType<typeof claudeNativeTaskProjection>[] = [], watchError: string | undefined;
    try { watches = runtime.tasks.list().map(task => { const projected = claudeNativeTaskProjection(task); delete projected.progress; return projected; }); } catch { watchError = "claude_native_watch_store_unavailable"; }
    return { claude_cli_sessions: sessions, claude_cli_watches: watches, claude_cli_scan: { status: discovery.errors.length ? "partial" : "ok",
      returned: sessions.length, loaded_count: discovery.sessions.length, complete: !discovery.errors.length, diagnostics: discovery.errors, watch_error: watchError } };
  } finally { await runtime.close(); }
}
function conversation(options: Options) {
  if (["conversation", "conversationId", "terminal", "session", "watch", "turn"].filter(key => options[key] !== undefined).length !== 1) throw new Error("Claude CLI requires one exact conversation or Watch target");
  const id = required(options.conversation ?? options.conversationId, "conversation ID");
  return { id, target: parseClaudeNativeConversationId(id) };
}
async function launch(task: ClaudeNativeTaskRecord, options: Options) {
  const result: Record<string, unknown> = claudeNativeTaskProjection(task);
  if (claudeNativeTaskNeedsReconciliation(task)) {
    try { result.monitor_pid = await (cliDependencies().launchClaudeNativeMonitor ?? launchClaudeNativeMonitor)(task.id, claudeNativeRuntimeOptions(options)); }
    catch { result.monitor_error = "claude_native_monitor_launch_failed"; result.callback_expected = false; }
  }
  return result;
}
async function sendOrWatch(runtime: Runtime, command: string, options: Options) {
  const { id, target } = conversation(options);
  const controllerSession = required(options.openclawSession, "controller session");
  const callbackRoute = options.callbackRoute ? parseCallbackRoute(options.callbackRoute)
    : createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controllerSession, openclawBin: text(options.openclawBin) });
  const input = { target, nativeId: id, controllerSession, callbackRoute,
    timeoutMs: monitorMinutesToMs(resolveMonitorHardTimeoutMinutes(options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes)) };
  const task = command === "send" ? await runtime.tasks.send({ ...input, messageId: text(options.messageId) ?? randomUUID(), text: required(options.message ?? options.request, "message") })
    : await runtime.tasks.watch(input);
  output(await launch(task, options));
}
async function watchCommand(runtime: Runtime, command: string, options: Options) {
  const id = required(options.watch ?? options.turn, "Watch ID");
  if (!isClaudeNativeWatchId(id) || ["conversation", "conversationId", "terminal", "session", "watch", "turn"].filter(key => options[key] !== undefined).length !== 1) throw new Error("Use one exact Claude Watch ID");
  const task = runtime.tasks.status(id);
  if (options.openclawSession && options.openclawSession !== task.controller_session) throw new Error("Claude Watch belongs to a different controller");
  if (command === "status" || command === "watch-status") { output(claudeNativeTaskProjection(await runtime.reconcile(id), true)); return; }
  const controllerSession = required(options.openclawSession, "controller session");
  const result = command === "unwatch-terminal" ? runtime.tasks.unwatch(id, { controllerSession })
    : command === "close" ? runtime.tasks.close(id, { controllerSession, reason: text(options.reason) })
    : command === "renew" ? await runtime.tasks.renew(id, { controllerSession,
      timeoutMs: monitorMinutesToMs(resolveMonitorHardTimeoutMinutes(options.minutes ?? options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes)) })
    : command === "recover" ? await runtime.tasks.recover(id, { controllerSession })
    : command === "retry-callback" ? await runtime.tasks.retryCallback(id, { controllerSession, notificationId: text(options.notificationId) }) : undefined;
  if (!result) { output(manualRequired(task.native_id, command)); return; }
  output(await launch(result, options));
}
export function manualRequired(id: string, command: string) {
  return { source: "claude_cli", conversation_id: id, status: "unavailable", operation: command, applied: false,
    manual_required: true, reason: "native_operation_unavailable", next_action: "return_to_claude_terminal",
    message: "This operation is not supported by the Claude direct connection. Return to the original Claude Code terminal, or use its verified terminal controls when available.", do_not_retry: true };
}
export async function dispatchClaudeNativeCli(command: string | undefined, options: Options): Promise<boolean> {
  const target = options.conversation ?? options.conversationId ?? options.terminal ?? options.session;
  if (!isClaudeNativeConversationId(target) && !String(options.watch ?? options.turn ?? "").startsWith("claude-cli-watch:") && !commands.has(command ?? "")) return false;
  assertBackendRecoveryCliTarget(command, options);
  if (command === "claude-cli-list") { output(await claudeNativeListForCli(options)); return true; }
  if (command === "monitor-claude-native") { await runClaudeNativeMonitor(required(options.watch, "Watch ID"), claudeNativeRuntimeOptions(options)); return true; }
  const runtime = runtimeFor(options);
  try {
    await dispatchClaudeTarget(runtime, command, options);
    return true;
  } finally { await runtime.close(); }
}

async function dispatchClaudeTarget(runtime: Runtime, command: string | undefined, options: Options) {
    if (command === "reconcile-claude-native-watches") {
      const before = new Map(runtime.tasks.list().map(task => [task.id, task]));
      const result = await runtime.tasks.reconcileAll();
      output({ checked: result.tasks.length + result.errors.length, errors: result.errors.length, diagnostics: result.errors,
        changed: result.tasks.filter(task => task.status !== before.get(task.id)?.status).length,
        callbacks_delivered: result.tasks.reduce((sum, task) => sum + task.notifications.filter(note => note.status === "accepted"
          && !before.get(task.id)?.notifications.some(old => old.id === note.id && old.status === "accepted")).length, 0) });
    } else if (options.watch || options.turn) await watchCommand(runtime, command ?? "", options);
    else if (command === "send" || command === "watch-terminal") await sendOrWatch(runtime, command, options);
    else if (command === "status" || command === "native-inspect" && [undefined, "status"].includes((options.action ?? options.inspection) as string | undefined)) {
      const { target } = conversation(options); const entry = await runtime.inspect(target); const snapshot = await runtime.read(target);
      output({ ...claudeNativeSessionProjection(entry, snapshot), progress: snapshot.progress });
    } else { const { id } = conversation(options); output(manualRequired(id, command ?? "unknown")); }
}

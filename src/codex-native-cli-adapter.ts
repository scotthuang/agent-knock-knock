import { monitorMinutesToMs, resolveMonitorHardTimeoutMinutes } from "./monitor-deadline-policy.js";
import { assertBackendRecoveryCliTarget } from "./backend-recovery-semantic.js";
import { backendPublicProgress, backendPublicProgressReadError } from "./backend-public-progress.js";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cliCwd, cliDependencies, cliEnv, cliNow, writeCliStdout } from "./cli-runtime-context.js";
import { createTerminalWatchOpenClawCallbackRoute, parseCallbackRoute } from "./callback-transport.js";
import { isCodexNativeConversationId, parseCodexNativeConversationId } from "./codex-native-identity.js";
import { isCodexNativeWatchId, type PersistedNativeInteraction, type CodexNativeTaskRecord } from "./codex-native-state-store.js";
import { codexNativeTaskNeedsReconciliation, nativeDigest, nativeErrorCode } from "./codex-native-task-service.js";
import { createCodexNativeRuntime, type CodexNativeRuntimeOptions } from "./codex-native-runtime.js";
import { launchCodexNativeMonitor, runCodexNativeMonitor } from "./codex-native-monitor.js";
import { codexNativeSessionProjection, codexNativeTaskProjection, nativeQuestionResponse } from "./codex-native-public-projection.js";
import type { CodexNativeIdentity, CodexNativePermissionPreset, NativeInteractionResponse } from "./codex-native-types.js";

type Options = Record<string, unknown>;
type Runtime = ReturnType<typeof createCodexNativeRuntime>;
const nativeCommands = new Set(["codex-cli-list", "monitor-codex-native", "reconcile-codex-native-watches"]);
const supported = new Set([...nativeCommands, "send", "status", "watch-terminal", "watch-status", "unwatch-terminal",
  "native-inspect", "permission-options", "set-permissions", "approve", "respond-interaction", "close", "renew", "recover", "retry-callback"]);
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const required = (value: unknown, label: string): string => {
  const result = text(value); if (!result) throw new Error(`Codex CLI ${label} is required`); return result;
};
const output = (value: unknown) => writeCliStdout(JSON.stringify(value, null, 2) + "\n");

export function codexNativeRuntimeOptions(options: Options): CodexNativeRuntimeOptions {
  const env = cliEnv(); const home = env.HOME ?? os.homedir();
  const resolve = (value: string) => path.resolve(cliCwd(), value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  let homes = [path.join(home, ".codex"), ...(text(options.codexHome) ? [text(options.codexHome)!] : env.CODEX_HOME ? [env.CODEX_HOME] : [])];
  if (env.AKK_NATIVE_CODEX_HOMES) {
    const saved: unknown = JSON.parse(env.AKK_NATIVE_CODEX_HOMES);
    if (!Array.isArray(saved) || !saved.length || saved.some(item => typeof item !== "string" || !path.isAbsolute(item))) {
      throw new Error("Invalid configured Codex CLI homes");
    }
    homes = saved;
  }
  return { storeDir: resolve(text(options.storeDir ?? options.logDir) ?? path.join(home, ".agent-knock-knock", "store")),
    codexHomes: [...new Set(homes.map(resolve))], openclawBin: text(options.openclawBin) };
}

const runtimeFor = (options: Options) => (cliDependencies().createCodexNativeRuntime ?? createCodexNativeRuntime)(codexNativeRuntimeOptions(options));

export async function codexNativeListForCli(options: Options): Promise<Record<string, unknown>> {
  if (options.agent && options.agent !== "codex") return { codex_cli_sessions: [], codex_cli_watches: [], codex_cli_scan: { status: "filtered" } };
  const runtime = runtimeFor(options);
  try {
    const discovery = await runtime.catalog.discover();
    const rows: ReturnType<typeof codexNativeSessionProjection>[] = [];
    const errors = [...discovery.errors];
    for (const entry of discovery.sessions) {
      try {
        const client = await runtime.clientFor(entry);
        const snapshot = await client.readSnapshot(entry.threadId);
        if (options.status && options.status !== snapshot.thread.status.type &&
          !(options.status === "working" && snapshot.thread.status.type === "active")) continue;
        rows.push(codexNativeSessionProjection(entry, snapshot, entry.backendVersion));
      } catch (error) { errors.push({ codexHome: entry.codexHome, error_code: nativeErrorCode(error) }); }
    }
    let watches: ReturnType<typeof codexNativeTaskProjection>[] = []; let watchError: string | undefined;
    try { watches = runtime.tasks.list().map(codexNativeTaskProjection); }
    catch { watchError = "codex_native_watch_store_unavailable"; }
    return { codex_cli_sessions: rows, codex_cli_watches: watches,
      codex_cli_scan: { status: errors.length ? "partial" : "ok", returned: rows.length,
        loaded_count: discovery.sessions.length, complete: errors.length === 0, diagnostics: errors, watch_error: watchError } };
  } finally { await runtime.close(); }
}

function conversation(options: Options): { id: string; target: CodexNativeIdentity } {
  if (["conversation", "conversationId", "terminal", "session", "watch", "turn"].filter(key => options[key] !== undefined).length !== 1) {
    throw new Error("Codex CLI accepts exactly one native conversation or Watch target");
  }
  const id = required(options.conversation ?? options.conversationId, "conversation ID");
  return { id, target: parseCodexNativeConversationId(id) };
}

async function launchIfNeeded(task: CodexNativeTaskRecord, options: Options) {
  const result: Record<string, unknown> = codexNativeTaskProjection(task);
  if (codexNativeTaskNeedsReconciliation(task)) {
    try { result.monitor_pid = await (cliDependencies().launchCodexNativeMonitor ?? launchCodexNativeMonitor)(task.id, codexNativeRuntimeOptions(options)); }
    catch { result.monitor_error = "codex_native_monitor_launch_failed"; result.callback_expected = false; }
  }
  return result;
}

async function sendOrWatch(runtime: Runtime, command: string, options: Options) {
  const { id, target } = conversation(options);
  const controllerSession = required(options.openclawSession, "controller session");
  const route = options.callbackRoute ? parseCallbackRoute(options.callbackRoute)
    : createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controllerSession, openclawBin: text(options.openclawBin) });
  const input = { target, nativeId: id, controllerSession, callbackRoute: route,
    timeoutMs: monitorMinutesToMs(resolveMonitorHardTimeoutMinutes(options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes)) };
  const task = command === "send" ? await runtime.tasks.send({ ...input,
    messageId: text(options.messageId) ?? randomUUID(), text: required(options.message ?? options.request, "message") })
    : await runtime.tasks.watch(input);
  output(await launchIfNeeded(task, options));
}

async function inspectConversation(runtime: Runtime, options: Options) {
  const { id, target } = conversation(options);
  try {
    const client = await runtime.clientFor(target);
    // Subscription replays current requests on an already loaded thread; it cannot load a historical conversation.
    await client.subscribe(target.threadId);
    const snapshot = await client.readSnapshot(target.threadId);
    if (snapshot.threadId !== target.threadId) throw new Error("Native snapshot identity mismatch");
    output({ ...codexNativeSessionProjection(target, snapshot, client.metadata.serverVersion, true),
      progress: backendPublicProgress({ nativeTurnId: snapshot.latestTurnId,
        turn: snapshot.turns.find(turn => turn.id === snapshot.latestTurnId), readAt: cliNow().toISOString() }) });
  } catch {
    output({ source: "codex_cli", conversation_id: id, native_thread_id: target.threadId, native_turn_id: null,
      connection_state: "unconfirmed", activity_state: "unknown", interaction_requests_scanned: false,
      pending_interaction_count: null, observation_error: "native_status_read_failed",
      progress: backendPublicProgressReadError(null, cliNow().toISOString()) });
  }
}

async function watchProgress(runtime: Runtime, task: CodexNativeTaskRecord) {
  if (!task.native_turn_id) return backendPublicProgressReadError(null, cliNow().toISOString(), "missing_exact_turn");
  try {
    const snapshot = await runtime.read(task.target, task.native_turn_id);
    if (snapshot.threadId !== task.target.threadId) throw new Error("Native snapshot identity mismatch");
    return backendPublicProgress({ nativeTurnId: task.native_turn_id,
      turn: snapshot.turns.find(turn => turn.id === task.native_turn_id), readAt: cliNow().toISOString() });
  } catch { return backendPublicProgressReadError(task.native_turn_id, cliNow().toISOString()); }
}

async function permissionCommand(runtime: Runtime, command: string, options: Options) {
  const { id, target } = conversation(options);
  const client = await runtime.clientFor(target);
  if (command === "set-permissions") {
    if (!["read-only", "default", "full-access"].includes(String(options.mode))) throw new Error("Mode must be read-only, default, or full-access");
    const before = await client.readPermissions(target.threadId);
    const settings = await client.updatePermissions(target.threadId, options.mode as CodexNativePermissionPreset);
    output({ source: "codex_cli", conversation_id: id, native_thread_id: target.threadId, applied: true, settings,
      scope: "current_session", defaults_changed: false, do_not_retry: false,
      outcome: before.preset === settings.preset ? "already_effective" : "changed",
      requested: { mode: options.mode }, effective: { mode: settings.preset } });
  } else {
    const settings = await client.readPermissions(target.threadId);
    const labels = { "read-only": "Read Only", default: "Default", "full-access": "Full Access" };
    output({ source: "codex_cli", conversation_id: id, native_thread_id: target.threadId, settings,
      scope: "current_session", current: settings.preset,
      choices: ["read-only", "default", "full-access"].map(mode => ({ id: mode, mode,
        label: labels[mode], description: mode === "full-access" ? "Unrestricted execution without approval prompts for this thread."
          : mode === "read-only" ? "Read-only sandbox; request approval for additional access." : "Write inside the workspace; request approval for additional access.",
        action: { tool: "agent_knock_knock_set_permissions", input: { conversation_id: id, mode } } })) });
  }
}

function responseValue(command: string, options: Options, interaction: PersistedNativeInteraction): NativeInteractionResponse {
  if (command === "approve") {
    if (!["command_approval", "file_approval"].includes(interaction.kind)) throw new Error("Interaction is not an approval");
    const decision = options.decision ?? "approve_once";
    if (decision !== "approve_once" && decision !== "reject") throw new Error("Decision must be approve_once or reject");
    return { decision: decision === "approve_once" ? "accept"
      : !interaction.availableDecisions || interaction.availableDecisions.includes("decline") ? "decline" : "cancel" };
  } else {
    return nativeQuestionResponse(interaction, JSON.parse(required(options.responseJson, "typed response JSON")));
  }
}

async function respond(runtime: Runtime, command: string, options: Options) {
  const controllerSession = required(options.openclawSession, "controller session");
  const watch = text(options.watch);
  let subject: { id: string; target: CodexNativeIdentity };
  if (watch) {
    if (["conversation", "conversationId", "terminal", "session", "turn"].some(key => options[key] !== undefined)) throw new Error("Use only one response target");
    const task = runtime.tasks.status(watch);
    if (task.controller_session !== controllerSession) throw new Error("Codex CLI Watch belongs to a different controller");
    await runtime.reconcile(watch);
    subject = { id: task.native_id, target: task.target };
  } else subject = conversation(options);
  const interactionId = required(options.interaction, "interaction ID");
  const previous = runtime.responses.list().find(record => record.id === `codex-cli-response:${nativeDigest([subject.target, interactionId])}`);
  if (previous && previous.controller_session !== controllerSession) throw new Error("Codex CLI response belongs to a different controller");
  const snapshot = previous ? undefined : await runtime.transport.observe(subject.target, watch ? runtime.tasks.status(watch).native_turn_id : undefined);
  const interaction = previous?.interaction ?? snapshot?.pendingInteractions.find(item => item.id === interactionId);
  if (!interaction) throw new Error("Codex CLI interaction is no longer pending; refresh Status");
  const response = responseValue(command, options, interaction);
  const input = { controllerSession, interactionId,
    responseId: text(options.responseId) ?? nativeDigest([controllerSession, subject.id, interactionId, response]), response };
  const record = watch ? await runtime.responses.respondWatch(watch, input)
    : await runtime.responses.respond({ ...input, nativeId: subject.id, target: subject.target });
  output({ source: "codex_cli", conversation_id: subject.id, ...(watch ? { watch_id: watch } : {}),
    interaction_id: interactionId, response_id: record.id, state: record.state, evidence: record.evidence,
    attempts: record.attempts ?? 1, not_sent_history: record.not_sent_history, error_code: record.error_code,
    resend_allowed: record.state === "not_sent" });
}

async function watchCommand(runtime: Runtime, command: string, options: Options) {
  const id = required(options.watch ?? options.turn, "Watch ID");
  if (["conversation", "conversationId", "terminal", "session", "watch", "turn"].filter(key => options[key] !== undefined).length !== 1) throw new Error("Use only one exact Watch target");
  const task = runtime.tasks.status(id);
  if (options.openclawSession && options.openclawSession !== task.controller_session) throw new Error("Codex CLI Watch belongs to a different controller");
  if (command === "unwatch-terminal") {
    output(codexNativeTaskProjection(runtime.tasks.unwatch(id, { controllerSession: required(options.openclawSession, "controller session") })));
  } else if (command === "watch-status" || command === "status") {
    const current = await runtime.reconcile(id);
    output({ ...codexNativeTaskProjection(current), progress: await watchProgress(runtime, current) });
  } else if (["close", "renew", "recover", "retry-callback"].includes(command)) {
    const controllerSession = required(options.openclawSession, "controller session");
    const result = command === "close" ? runtime.tasks.close(id, { controllerSession, reason: text(options.reason) })
      : command === "renew" ? await runtime.tasks.renew(id, { controllerSession,
        ...((options.minutes ?? options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes) !== undefined
          ? { timeoutMs: monitorMinutesToMs(Number(options.minutes ?? options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes)) } : {}) })
      : command === "recover" ? await runtime.tasks.recover(id, { controllerSession })
      : await runtime.tasks.retryCallback(id, { controllerSession, notificationId: text(options.notificationId) });
    output(command === "close" ? codexNativeTaskProjection(result) : await launchIfNeeded(result, options));
  } else throw new Error("Codex CLI Watch is only valid for status, response, or task management");
}

async function reconcileWatches(runtime: Runtime) {
      const before = new Map(runtime.tasks.list().map(task => [task.id, task]));
      const result = await runtime.tasks.reconcileAll();
      output({ checked: result.tasks.length + result.errors.length, errors: result.errors.length, diagnostics: result.errors,
        changed: result.tasks.filter(task => task.status !== before.get(task.id)?.status).length,
        callbacks_delivered: result.tasks.reduce((total, task) => total + task.notifications.filter(note => note.status === "accepted" &&
          !before.get(task.id)?.notifications.some(old => old.id === note.id && old.status === "accepted")).length, 0) });
}

async function dispatchTarget(runtime: Runtime, command: string, options: Options) {
  if (command === "approve" || command === "respond-interaction") await respond(runtime, command, options);
    else if (options.watch || options.turn) await watchCommand(runtime, command!, options);
    else if (command === "set-permissions" || command === "permission-options" || command === "native-inspect" && options.action === "permissions") {
      await permissionCommand(runtime, command, options);
    } else if (command === "status" || command === "native-inspect" && (options.action === "status" || options.action === undefined)) await inspectConversation(runtime, options);
    else if (command === "send" || command === "watch-terminal") await sendOrWatch(runtime, command, options);
    else throw new Error("Unsupported Codex CLI native inspection");
}

function isNativeDispatch(command: string | undefined, options: Options): boolean {
  const target = options.conversation ?? options.conversationId ?? options.terminal ?? options.session;
  return isCodexNativeConversationId(target) || String(options.watch ?? options.turn ?? "").startsWith("codex-cli-watch:") || nativeCommands.has(command ?? "");
}

export async function dispatchCodexNativeCli(command: string | undefined, options: Options): Promise<boolean> {
  if (!isNativeDispatch(command, options)) return false;
  assertBackendRecoveryCliTarget(command, options);
  if (!supported.has(command ?? "")) throw new Error("Unsupported Codex CLI native action; target was not sent to a terminal");
  if (options.watch !== undefined && !isCodexNativeWatchId(options.watch) ||
    options.turn !== undefined && !isCodexNativeWatchId(options.turn)) throw new Error("Invalid Codex CLI Watch ID");
  if (["close", "renew", "recover", "retry-callback"].includes(command ?? "") && !options.watch && !options.turn) {
    throw new Error("Codex CLI task management requires an exact Watch ID via --watch or --turn");
  }
  if (command === "codex-cli-list") { output(await codexNativeListForCli(options)); return true; }
  if (command === "monitor-codex-native") { await runCodexNativeMonitor(required(options.watch, "Watch ID"), codexNativeRuntimeOptions(options)); return true; }
  const runtime = runtimeFor(options);
  try {
    if (command === "reconcile-codex-native-watches") {
      await reconcileWatches(runtime);
    } else await dispatchTarget(runtime, command!, options);
    return true;
  } finally { await runtime.close(); }
}

import { desktopControlForCli } from "./desktop-cli-controls.js";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { cliCwd, cliEnv, cliDependencies, writeCliStdout } from "./cli-runtime-context.js";
import { isDesktopConversationId, parseDesktopConversationId } from "./desktop-identity.js";
import { isDesktopWatchId } from "./desktop-semantic.js";
import { createDesktopRuntime, desktopWritesVerified, type DesktopRuntime, type DesktopRuntimeOptions } from "./desktop-runtime.js";
import { createTerminalWatchOpenClawCallbackRoute, parseCallbackRoute } from "./callback-transport.js";
import { desktopResponseId, type DesktopResponseRecord } from "./desktop-response-store.js";
import { desktopInteractionFingerprint, desktopInteractionIsApproval, desktopQuestionAnswer, desktopQuestionResponse } from "./desktop-interaction-projection.js";
import { desktopSessionProjection, desktopTaskProjection } from "./desktop-public-projection.js";
import { desktopTaskNeedsReconciliation } from "./desktop-task-service.js";
import { listDesktopSessions } from "./desktop-list.js";
import { launchDesktopMonitor, runDesktopMonitor } from "./desktop-monitor.js";
import type { DesktopCatalogEntry } from "./desktop-session-catalog.js";
import type { DesktopInteraction, DesktopRequestResponse, DesktopThreadIdentity, DesktopTurn } from "./desktop-types.js";

type Options = Record<string, unknown>;
interface DesktopConversation {
  id: string;
  identity: DesktopThreadIdentity;
  entry: DesktopCatalogEntry;
}
const NATIVE_COMMANDS = ["desktop-list", "monitor-desktop", "reconcile-desktop-watches"];
const SUPPORTED_COMMANDS = [...NATIVE_COMMANDS, "send", "status", "watch-terminal", "watch-status", "unwatch-terminal", "respond-interaction", "approve", "native-inspect", "permission-options", "set-permissions", "model-options", "set-model", "cancel"];
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
  if (command === "cancel") {
    if (!task.native_turn_id) throw new Error("Desktop Watch has no exact native task to interrupt");
    required(controller, "controller session");
    const result = await desktopControlForCli(runtime, command, { ...options, expectedNativeTurnId: task.native_turn_id },
      { id: task.desktop_id, identity: task.target }, watch);
    output(result);
  } else if (command === "unwatch-terminal") {
    output(desktopTaskProjection(runtime.tasks.unwatch(watch,
      { controllerSession: required(controller, "controller session") })));
  } else if (command === "watch-status" || command === "status") {
    const current = await runtime.tasks.reconcile(watch);
    output({ ...desktopTaskProjection(current, desktopWritesVerified(runtime.compatibility)),
      response_state: await desktopResponseStates(runtime, current.desktop_id, current.native_turn_id, controller) });
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
    item.phase !== "analysis" && item.phase !== "commentary" && item.delivery !== "async").map(item => item.text ?? "").join("\n\n");
  const isFinal = turn.itemsComplete && ["completed", "failed", "interrupted"].includes(turn.status);
  return { id: turn.turnId, status: turn.status, items_complete: turn.itemsComplete,
    ...(isFinal ? { final_text: text } : { response_text: text }) };
}

async function inspectDesktopConversation(runtime: DesktopRuntime, { identity, entry }: DesktopConversation, options: Options): Promise<void> {
  try {
    const snapshot = await runtime.transport.observe(identity);
    const current = snapshot.turns.find(turn => turn.turnId === snapshot.latestTurnId);
    output({ ...desktopSessionProjection(entry, snapshot, desktopWritesVerified(runtime.compatibility)),
      source: "codex_desktop", latest_turn: latestTurnProjection(current),
      response_state: await desktopResponseStates(runtime, entry.conversationId, snapshot.latestTurnId ?? undefined, str(options.openclawSession)) });
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
  const result = desktopTaskProjection(task, desktopWritesVerified(runtime.compatibility));
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
    throw new Error("Desktop supports List, Send, Status, Watch, typed interactions, current-thread settings and exact task cancellation; new/resume are unsupported.");
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
    if (command === "respond-interaction" || command === "approve") {
      await respondToDesktopInteraction(runtime, options, target, watch, command);
      return true;
    }
    if (watch) {
      await inspectOrStopDesktopWatch(runtime, command, options, watch, target);
      return true;
    }
    await dispatchDesktopConversation(runtime, command!, options, config,
      await getDesktopConversation(runtime, options, target));
    return true;
  } finally { await runtime.close(); }
}

/** Once the exact conversation is resolved, route its read, setting, or task operation. */
async function dispatchDesktopConversation(runtime: DesktopRuntime, command: string, options: Options,
  config: DesktopRuntimeOptions, conversation: DesktopConversation): Promise<void> {
  if (command === "status" || command === "native-inspect" && (options.action ?? options.inspection) === "status") {
    await inspectDesktopConversation(runtime, conversation, options);
    return;
  }
  const control = await desktopControlForCli(runtime, command, options, conversation);
  if (control) { output(control); return; }
  if (command !== "send" && command !== "watch-terminal") throw new Error("Unsupported Desktop command or inspection");
  await sendOrWatchDesktopTask(runtime, command, options, config, conversation);
}


async function desktopResponseSubject(runtime: DesktopRuntime, options: Options, target: string | undefined,
  watch: string | undefined, controllerSession: string): Promise<{ id: string; identity: DesktopThreadIdentity }> {
  if (!watch) return getDesktopConversation(runtime, options, target);
  if (["conversation", "conversationId", "session", "terminal", "turn"].some(key => options[key] !== undefined)) {
    throw new Error("Desktop response accepts exactly one target");
  }
  const task = runtime.tasks.status(watch);
  if (task.controller_session !== controllerSession) throw new Error("Desktop Watch belongs to a different controller");
  return { id: task.desktop_id, identity: task.target };
}

function desktopResponseFingerprint(interaction: DesktopInteraction, options: Options): void {
  const fingerprint = options.expectedInteractionFingerprint;
  const expiresAt = options.expectedInteractionExpiresAt;
  if (fingerprint === undefined && expiresAt === undefined) return;
  if (typeof fingerprint !== "string" || fingerprint !== desktopInteractionFingerprint(interaction)
    || typeof expiresAt !== "string" || !Number.isFinite(Date.parse(expiresAt))) throw new Error("Desktop question changed; refresh Status before answering");
  // Expiry triggers live revalidation by the response service, not refusal of the same pending question.
}

async function respondToDesktopInteraction(runtime: DesktopRuntime, options: Options,
  target: string | undefined, watch: string | undefined, command: "respond-interaction" | "approve"): Promise<void> {
  const controllerSession = required(options.openclawSession, "controller session");
  const subject = await desktopResponseSubject(runtime, options, target, watch, controllerSession);
  const interactionId = required(options.interaction, "interaction ID");
  const previous = runtime.responses.list().find(record => record.id === desktopResponseId(subject.identity, interactionId));
  if (previous && previous.controller_session !== controllerSession) throw new Error("Desktop response belongs to a different controller");
  const snapshot = previous && previous.state !== "not_sent" ? undefined : await runtime.transport.observe(subject.identity);
  const freshInteraction = (snapshot?.pendingInteractions ?? snapshot?.asyncQuestions)?.find(item => item.id === interactionId);
  const interaction = previous?.state === "not_sent" ? freshInteraction : previous?.interaction ?? freshInteraction;
  if (!interaction) throw new Error("Desktop interaction is no longer pending; refresh Status");
  desktopResponseFingerprint(interaction, options);
  const response = desktopTypedResponse(interaction, command, options);
  const responseId = str(options.responseId) ?? previous?.response_id ?? createHash("sha256").update(JSON.stringify([controllerSession, subject.id, interactionId, response])).digest("hex");
  const input = { controllerSession, interactionId, responseId, ...response };
  const record = watch ? await runtime.responses.respondWatch(watch, input)
    : await runtime.responses.respond({ ...input, desktopId: subject.id, target: subject.identity });
  output({ source: "codex_desktop", conversation_id: subject.id, ...(watch ? { watch_id: watch } : {}),
    native_thread_id: subject.identity.threadId, ...desktopResponseProjection(record) });
}


function desktopTypedResponse(interaction: DesktopInteraction, command: "respond-interaction" | "approve", options: Options):
  { answer: string } | { response: DesktopRequestResponse } {
  if (command === "approve") {
    if (!desktopInteractionIsApproval(interaction)) throw new Error("Desktop interaction is not an approval");
    const decision = options.decision ?? "approve_once";
    if (decision !== "approve_once" && decision !== "reject") throw new Error("decision must be approve_once or reject");
    return { response: { decision: decision === "approve_once" ? "accept" : "decline" } };
  }
  const value: unknown = JSON.parse(required(options.responseJson, "typed response JSON"));
  return interaction.kind === "async_question" ? { answer: desktopQuestionAnswer(interaction, value) }
    : { response: desktopQuestionResponse(interaction, value) };
}

function desktopResponseProjection(record: DesktopResponseRecord) {
  return { interaction_id: record.interaction.id, response_id: record.id, state: record.state, evidence: record.evidence,
    native_turn_id: record.interaction.turnId, attempts: record.attempts,
    not_sent_history: record.not_sent_history, error_code: record.error_code, resend_allowed: record.state === "not_sent" };
}

/** Status recovers response evidence without re-dispatching an answer that may already have arrived. */
async function desktopResponseStates(runtime: DesktopRuntime, desktopId: string, turnId?: string, controller?: string) {
  if (!turnId) return [];
  const records = runtime.responses.list().filter(record => record.desktop_id === desktopId
    && record.interaction.turnId === turnId && (!controller || record.controller_session === controller));
  const projections: ReturnType<typeof desktopResponseProjection>[] = [];
  for (const record of records) {
    const current = ["sent", "uncertain"].includes(record.state) ? await runtime.responses.reconcile(record.id) : record;
    projections.push(desktopResponseProjection(current));
  }
  return projections;
}

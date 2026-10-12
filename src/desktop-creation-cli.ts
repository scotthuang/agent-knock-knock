import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { isDeepStrictEqual, promisify } from "node:util";
import { cliDependencies, cliEnv, cliNow, cliCwd, writeCliStdout } from "./cli-runtime-context.js";
import { desktopRuntimeOptions } from "./desktop-cli-adapter.js";
import { createDesktopRuntime, type DesktopRuntime } from "./desktop-runtime.js";
import { desktopCapabilityProfile } from "./desktop-compatibility.js";
import { createDesktopCreationNative } from "./desktop-creation-native.js";
import { createDesktopCreationService } from "./desktop-creation-service.js";
import { assertDesktopCreationId, createDesktopCreationStore, type DesktopCreationRecord, type DesktopCreationRequest } from "./desktop-creation-store.js";
import { createDesktopConversationId } from "./desktop-identity.js";
import { createTerminalWatchOpenClawCallbackRoute, parseCallbackRoute } from "./callback-transport.js";
import { monitorMinutesToMs, resolveMonitorHardTimeoutMinutes } from "./monitor-deadline-policy.js";
import { desktopTaskProjection } from "./desktop-public-projection.js";
import { desktopTaskNeedsReconciliation } from "./desktop-task-service.js";
import { launchDesktopMonitor } from "./desktop-monitor.js";

type Options = Record<string, unknown>;
const text = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`); return value;
};
function creationNextAction(r: DesktopCreationRecord, requestState: string): string | undefined {
  if (r.status === "failed") return "Inspect error_code; this operation will not be retried.";
  if (r.status === "uncertain") return "Creation or identity is uncertain. Do not create a replacement or resend. Inspect the exact operation before taking further action.";
  if (r.worker) return "This operation is still in progress. Wait, then continue with the same operation_id; do not create another operation.";
  if (r.status !== "ready") return "Continue only with this operation_id. If Desktop has not loaded the known conversation, open its native link and continue.";
  if (r.input.request && requestState !== "accepted") return "Desktop is ready, but task acceptance is not confirmed. Continue only with this operation_id to reconcile the same send; do not resend separately.";
  return undefined;
}
function creationActions(r: DesktopCreationRecord, conversationId?: string): Options {
  const actions: Options = conversationId ? { status: { tool: "agent_knock_knock_status", input: { conversation_id: conversationId } } } : {};
  if (!["failed", "uncertain"].includes(r.status) && !(r.status === "ready" && (!r.input.request || r.watchId))) {
    actions.continue_creation = { tool: "agent_knock_knock_desktop_create", input: { operation_id: r.id } };
  }
  return actions;
}
function creationProjection(r: DesktopCreationRecord): Record<string, unknown> {
  const id = r.threadId ? createDesktopConversationId({ codexHome: r.input.codexHome, hostId: "local", threadId: r.threadId }) : undefined;
  const requestState = r.requestState ?? (r.watchId ? "uncertain" : "not_sent");
  const next = creationNextAction(r, requestState);
  return { source: "codex_desktop", operation_id: r.id, status: r.status, creation_status: r.status,
    created: r.threadId ? true : ["creating", "uncertain"].includes(r.status) ? null : false,
    ...(id ? { conversation_id: id, native_thread_id: r.threadId } : {}),
    cwd: r.cwd ?? null, title: r.nativeTitle ?? null, requested_title: r.input.title,
    title_confirmed: r.nativeTitle === r.input.title, native_project_id: r.projectId ?? null, project_name: r.projectName ?? null,
    desktop_owner_verified: r.status === "ready", operation_in_flight: Boolean(r.worker), callback_expected: false,
    ...(r.errorCode ? { error_code: r.errorCode } : {}),
    ...(r.input.request ? { request_state: requestState } : {}), available_actions: creationActions(r, id),
    ...(next ? { next_action: next, ...(r.threadId ? { desktop_url: `codex://threads/${r.threadId}` } : {}) } : {}) };
}
function validateCreationOptions(options: Options, old: DesktopCreationRecord | undefined, controller: string, resume: boolean): void {
  if (["conversation", "conversationId", "terminal", "session", "turn", "watch"].some(key => options[key] !== undefined)) {
    throw new Error("Desktop creation does not accept an existing conversation or terminal target");
  }
  if (resume && ["project", "cwd", "title", "message", "request", "agentHardTimeoutMinutes", "hardTimeoutMinutes"].some(key => options[key] !== undefined)) {
    throw new Error("Desktop creation recovery cannot change its original payload or deadline");
  }
  if (old && old.controllerSession !== controller || resume && !old) throw new Error("Desktop creation operation not found for this controller");
}
function creationInput(options: Options, codexHome: string, controller: string, home: string, openclawBin?: string): DesktopCreationRequest {
  const request = options.message ?? options.request;
  const title = options.title === undefined ? "AKK 新会话" : text(options.title, "title");
  if ([...title].length > 200) throw new Error("Desktop title exceeds 200 characters");
  if (request !== undefined && Buffer.byteLength(text(request, "request")) > 1024 * 1024) throw new Error("Desktop task exceeds 1 MiB");
  const route = options.callbackRoute ? parseCallbackRoute(options.callbackRoute)
    : createTerminalWatchOpenClawCallbackRoute({ controllerSessionId: controller, openclawBin });
  if (route.controller_session_id !== controller) throw new Error("Desktop creation callback belongs to a different controller");
  return { codexHome, title,
    ...(options.project === undefined ? {} : { project: text(options.project, "project") }),
    ...(options.cwd === undefined ? {} : { cwd: fs.realpathSync(expandDirectory(text(options.cwd, "cwd"), home)) }),
    ...(request === undefined ? {} : { request: text(request, "request"), callbackRoute: { ...route, capabilities: { wake: true, respond: false } } }),
    timeoutMs: monitorMinutesToMs(resolveMonitorHardTimeoutMinutes(options.hardTimeoutMinutes ?? options.agentHardTimeoutMinutes)) };
}
function expandDirectory(value: string, home: string): string {
  return path.resolve(cliCwd(), value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
}
function creationService(store: ReturnType<typeof createDesktopCreationStore>, runtime: DesktopRuntime, home: string) {
  return createDesktopCreationService({ store,
    connect: selectedHome => (cliDependencies().createDesktopCreationNative ?? createDesktopCreationNative)({
      codexHome: selectedHome, compatibility: runtime.compatibility }),
    defaultDirectory: operationId => {
      const directory = path.join(home, ".agent-knock-knock", "workspaces", "desktop", operationId.slice(-16));
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); return fs.realpathSync(directory);
    },
    open: cliDependencies().openDesktopThread ?? (async threadId => {
      if (!/^[0-9a-f-]{36}$/iu.test(threadId)) throw new Error("Invalid Desktop native thread UUID");
      await promisify(execFile)("/usr/bin/open", ["-b", "com.openai.codex", `codex://threads/${threadId}`], { timeout: 10_000 });
    }), observe: target => runtime.transport.observe(target), tasks: runtime.tasks, now: cliNow,
    ownerAttempts: cliDependencies().desktopCreationOwnerAttempts });
}
async function creationTaskProjection(r: DesktopCreationRecord, runtime: DesktopRuntime, config: ReturnType<typeof desktopRuntimeOptions>): Promise<Options> {
  const output = creationProjection(r);
  if (!r.watchId) return output;
  const task = runtime.tasks.status(r.watchId);
  if (task.controller_session !== r.controllerSession || task.target.threadId !== r.threadId
    || path.resolve(task.target.codexHome) !== path.resolve(r.input.codexHome) || task.send_intent?.message_id !== r.id) {
    throw new Error("Desktop creation Watch identity differs from its immutable task");
  }
  const projected = desktopTaskProjection(task, desktopCapabilityProfile(runtime.compatibility));
  const { status, available_actions, ...fields } = projected;
  const result: Options = { ...output, ...fields, task_status: status, creation_status: output.creation_status,
    status: output.creation_status, request_state: task.send_intent?.state === "accepted" ? "accepted"
      : task.send_intent?.state === "not_sent" ? "not_sent" : "uncertain",
    available_actions: { ...(output.available_actions as Options), ...(available_actions as Options) } };
  if (result.request_state === "accepted") delete result.next_action;
  if (desktopTaskNeedsReconciliation(task)) {
    try { result.monitor_pid = await (cliDependencies().launchDesktopMonitor ?? launchDesktopMonitor)(task.id, { ...config, codexHomes: [r.input.codexHome] }); }
    catch { result.monitor_error = "desktop_monitor_launch_failed"; result.callback_expected = false; }
  }
  return result;
}

/** An explicit new Desktop resource operation, separate from replacing a terminal's native thread. */
export async function dispatchDesktopCreationCli(command: string | undefined, options: Options): Promise<boolean> {
  if (command !== "desktop-create") return false;
  const id = text(options.operationId, "--operation-id"); assertDesktopCreationId(id);
  const controller = text(options.openclawSession, "--openclaw-session");
  const config = desktopRuntimeOptions(options), store = createDesktopCreationStore(config.storeDir);
  const resume = options.resumeCreation === true, old = store.load(id);
  validateCreationOptions(options, old, controller, resume);
  const env = cliEnv(), home = env.HOME ?? os.homedir();
  const codexHome = old?.input.codexHome ?? fs.realpathSync(expandDirectory(String(options.codexHome ?? env.CODEX_HOME ?? path.join(home, ".codex")), home));
  const input = resume ? undefined : creationInput(options, codexHome, controller, home, config.openclawBin);
  if (old && input && !isDeepStrictEqual(old.input, input)) throw new Error("Desktop creation operation belongs to different immutable input");
  const runtime = (cliDependencies().createDesktopRuntime ?? createDesktopRuntime)({ ...config, codexHomes: [codexHome] });
  let output: Record<string, unknown>;
  try {
    const r = await creationService(store, runtime, home).run({ operationId: id, controllerSession: controller, resume, input });
    output = await creationTaskProjection(r, runtime, config);
  } catch {
    const record = store.load(id);
    output = record?.controllerSession === controller ? { ...creationProjection(record), error_code: "desktop_creation_incomplete",
      ...(record.input.request && record.watchId ? { request_state: "uncertain", callback_expected: false,
        next_action: "The task receipt could not be read. Inspect this exact Watch; do not resend the task." } : {}) }
      : { source: "codex_desktop", operation_id: id, status: "failed", created: false, error_code: "desktop_creation_failed" };
  } finally { await runtime.close(); }
  writeCliStdout(JSON.stringify(output, null, 2) + "\n"); return true;
}

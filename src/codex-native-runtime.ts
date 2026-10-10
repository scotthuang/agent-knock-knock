import { backendObservationStopped } from "./backend-task-recovery.js";
import path from "node:path";
import { CodexNativeClient } from "./codex-native-client.js";
import { createCodexNativeConversationId } from "./codex-native-identity.js";
import { createCodexNativeStateStore } from "./codex-native-state-store.js";
import { createCodexNativeTaskService, nativeErrorCode, type CodexNativeTransportPort } from "./codex-native-task-service.js";
import { createCodexNativeResponseService, createCodexNativeResponseStore } from "./codex-native-response-service.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { createOpenClawCallbackTransport } from "./openclaw-callback-transport.js";
import { createHostProfileCallbackTransport } from "./host-profile-callback-transport.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import type { CallbackAttemptOutcome, CallbackTransportDeliverInput } from "./callback-transport.js";
import type { CodexNativeClientOptions, CodexNativeIdentity, CodexNativeThread } from "./codex-native-types.js";

export type CodexNativeClientPort = Pick<CodexNativeClient, "metadata" | "discover" | "readSnapshot" | "subscribe" | "start" |
  "respond" | "answerAsync" | "readPermissions" | "updatePermissions" | "close">;
export interface CodexNativeRuntimeOptions {
  storeDir: string;
  codexHomes: string[];
  openclawBin?: string;
  clientFactory?(options: CodexNativeClientOptions): Promise<CodexNativeClientPort>;
  callbackDeliver?(input: CallbackTransportDeliverInput): Promise<CallbackAttemptOutcome> | CallbackAttemptOutcome;
}
export interface CodexNativeCatalogEntry extends CodexNativeIdentity {
  nativeId: string;
  thread: CodexNativeThread;
  backendVersion: string;
}
/** Keep subscriptions alive across polling; reconnects replay pending native requests. */
export function createCodexNativeRuntime(options: CodexNativeRuntimeOptions) {
  const homes = new Set(options.codexHomes.map(home => path.resolve(home)));
  const clients = new Map<string, Promise<CodexNativeClientPort>>();
  async function clientFor(identity: Pick<CodexNativeIdentity, "codexHome">): Promise<CodexNativeClientPort> {
    const home = path.resolve(identity.codexHome);
    if (!path.isAbsolute(identity.codexHome) || !homes.has(home)) throw new Error("Codex native target must belong to a configured local home");
    let pending = clients.get(home);
    if (!pending) {
      pending = (options.clientFactory ?? CodexNativeClient.connect)({ codexHome: home }); clients.set(home, pending);
      pending.catch(() => { if (clients.get(home) === pending) clients.delete(home); });
    }
    return pending;
  }
  async function run<T>(identity: CodexNativeIdentity, operation: (client: CodexNativeClientPort) => Promise<T>): Promise<T> {
    const client = await clientFor(identity);
    try { return await operation(client); }
    catch (error) {
      if (["closed", "timeout", "invalid_response"].includes(nativeErrorCode(error))) {
        client.close(); clients.delete(path.resolve(identity.codexHome));
      }
      throw error;
    }
  }
  const transport: CodexNativeTransportPort = {
    observe: (identity, turnId) => run(identity, async client => {
      const snapshot = await client.readSnapshot(identity.threadId, turnId);
      if (!snapshot.loaded) return snapshot;
      await client.subscribe(identity.threadId);
      return client.readSnapshot(identity.threadId, turnId);
    }),
    start: (identity, input) => run(identity, client => client.start(identity.threadId, input))
  };
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const lockPort = { acquire: (lock: string) => locks.acquire(lock) };
  const repository = createCodexNativeStateStore(options.storeDir, lockPort);
  const responseRepository = createCodexNativeResponseStore(options.storeDir, lockPort);
  const legacy = createOpenClawCallbackTransport({ now: cliNow, environment: cliEnv,
    redactConversation: () => { throw new Error("Codex native callbacks do not use managed conversations"); },
    recordCallbackProcessDelivery: () => { throw new Error("Codex native callbacks use their durable outbox"); } });
  const callbacks = createHostProfileCallbackTransport({ legacyTransport: legacy, environment: cliEnv, cwd: cliCwd(), now: cliNow });
  const tasks = createCodexNativeTaskService({ repository, ...transport, now: cliNow,
    deliver: options.callbackDeliver ?? (input => callbacks.deliver(input)),
    resolveCallbackContext: task => ({ legacyOptions: { gatewayMethod: "chat.send", openclawSession: task.controller_session,
      gatewaySession: task.controller_session, openclawBin: options.openclawBin } }) });
  const responses = createCodexNativeResponseService({ repository: responseRepository, tasks: repository, observe: transport.observe, now: cliNow,
    respond: (identity, interaction, response) => run(identity, client => client.respond(interaction, response)),
    answerAsync: (identity, interaction, input) => run(identity, client => client.answerAsync(interaction, input)) });
  const catalog = {
    async discover(): Promise<{ sessions: CodexNativeCatalogEntry[]; errors: { codexHome: string; error_code: string }[] }> {
      const sessions: CodexNativeCatalogEntry[] = [], errors: { codexHome: string; error_code: string }[] = [];
      for (const codexHome of homes) {
        try {
          const client = await clientFor({ codexHome });
          for (const thread of await client.discover()) {
            const identity = { codexHome, threadId: thread.id };
            sessions.push({ ...identity, nativeId: createCodexNativeConversationId(identity), thread, backendVersion: client.metadata.serverVersion });
          }
        } catch (error) { errors.push({ codexHome, error_code: nativeErrorCode(error) }); }
      }
      return { sessions, errors };
    }
  };
  return { tasks, responses, transport, catalog, clientFor,
    read: (identity: CodexNativeIdentity, exactTurnId?: string) => run(identity, client => client.readSnapshot(identity.threadId, exactTurnId)),
    async reconcile(watchId: string) {
      const task = await tasks.reconcile(watchId);
      if (backendObservationStopped(task)) return task;
      for (const response of responseRepository.scanForReconciliation().tasks) {
        if (["reserved", "sent", "uncertain"].includes(response.state) && response.native_id === task.native_id && response.interaction.turnId === task.native_turn_id) {
          try { await responses.reconcile(response.id); }
          catch { /* Response observation cannot revoke the independently verified task result. */ }
        }
      }
      return task;
    },
    async close() {
      const current = [...clients.values()]; clients.clear();
      for (const pending of current) { try { (await pending).close(); } catch { /* Failed connection owns no subscription. */ } }
    }
  };
}
export type CodexNativeRuntime = ReturnType<typeof createCodexNativeRuntime>;

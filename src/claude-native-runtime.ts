import path from "node:path";
import fs from "node:fs";
import { createClaudeNativeClient, type ClaudeNativeClient } from "./claude-native-client.js";
import { runClaudeNativeCommand } from "./claude-native-discovery.js";
import { ClaudeNativeError, type ClaudeNativeIdentity } from "./claude-native-identity.js";
import { readClaudeNativeSnapshot } from "./claude-native-observation.js";
import { createClaudeNativeStateStore } from "./claude-native-state-store.js";
import { createClaudeNativeTaskService } from "./claude-native-task-service.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { createOpenClawCallbackTransport } from "./openclaw-callback-transport.js";
import { createHostProfileCallbackTransport } from "./host-profile-callback-transport.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import type { CallbackAttemptOutcome, CallbackTransportDeliverInput } from "./callback-transport.js";

export interface ClaudeNativeRuntimeOptions {
  storeDir: string; claudeConfigDirs: string[]; claudeBin?: string; pythonBin?: string; openclawBin?: string;
  client?: Pick<ClaudeNativeClient, "discover" | "inspect" | "send" | "close">;
  callbackDeliver?(input: CallbackTransportDeliverInput): Promise<CallbackAttemptOutcome> | CallbackAttemptOutcome;
  processCheck?(identity: ClaudeNativeIdentity): Promise<void>;
}
/** Exit and PID reuse are separate from an unavailable registry or an unknown protocol. */
export async function assertClaudeOriginalProcess(identity: ClaudeNativeIdentity): Promise<void> {
  let info: string;
  try { info = await runClaudeNativeCommand("/bin/ps", ["-p", String(identity.pid), "-o", "uid=", "-o", "lstart="],
    { ...process.env, LC_ALL: "C", TZ: "UTC" }); }
  catch {
    try { process.kill(identity.pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") throw new ClaudeNativeError("process_exited", "Original Claude process exited");
    }
    throw new ClaudeNativeError("process_check_unavailable", "Could not verify the original Claude process");
  }
  if (info.trim().replace(/\s+/gu, " ") !== `${process.getuid?.()} ${identity.processStart}`) {
    throw new ClaudeNativeError("process_changed", "Original Claude process identity changed");
  }
}
export function createClaudeNativeRuntime(options: ClaudeNativeRuntimeOptions) {
  const canonical = (dir: string) => { try { return fs.realpathSync(dir); } catch { return path.resolve(dir); } };
  const homes = new Set(options.claudeConfigDirs.map(canonical));
  const client = options.client ?? createClaudeNativeClient({ configDirs: [...homes], claudePath: options.claudeBin, pythonPath: options.pythonBin });
  function assertConfigured(identity: ClaudeNativeIdentity) {
    if (!path.isAbsolute(identity.configDir) || !homes.has(canonical(identity.configDir))) throw new ClaudeNativeError("unconfigured_home", "Claude target is outside configured local homes");
  }
  async function inspect(identity: ClaudeNativeIdentity) {
    assertConfigured(identity); await (options.processCheck ?? assertClaudeOriginalProcess)(identity); return client.inspect(identity);
  }
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const repository = createClaudeNativeStateStore(options.storeDir, { acquire: lock => locks.acquire(lock) });
  const legacy = createOpenClawCallbackTransport({ now: cliNow, environment: cliEnv,
    redactConversation: () => { throw new Error("Claude native callbacks use exact task records"); },
    recordCallbackProcessDelivery: () => { throw new Error("Claude native callbacks use their durable outbox"); } });
  const callbacks = createHostProfileCallbackTransport({ legacyTransport: legacy, environment: cliEnv, cwd: cliCwd(), now: cliNow });
  const tasks = createClaudeNativeTaskService({ repository, inspect, now: cliNow,
    send: (identity, input) => { assertConfigured(identity); return client.send(identity, input); },
    observe: async (entry, observation) => {
      const current = await inspect(entry);
      return readClaudeNativeSnapshot(current, { ...observation, processAlive: true });
    },
    deliver: options.callbackDeliver ?? (input => callbacks.deliver(input)),
    resolveCallbackContext: task => ({ legacyOptions: { gatewayMethod: "chat.send", openclawSession: task.controller_session,
      gatewaySession: task.controller_session, openclawBin: options.openclawBin } }) });
  return { catalog: { discover: () => client.discover() }, tasks, inspect,
    async read(identity: ClaudeNativeIdentity, exactInputUuid?: string, messageId?: string) {
      const entry = await inspect(identity); return readClaudeNativeSnapshot(entry, { exactInputUuid, messageId, processAlive: true });
    },
    reconcile: (id: string) => tasks.reconcile(id),
    async close() { client.close(); }
  };
}

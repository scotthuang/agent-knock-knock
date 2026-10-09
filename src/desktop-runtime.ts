import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DesktopIpcClient, VERIFIED_DESKTOP_BUILD } from "./desktop-ipc-client.js";
import { DesktopSessionCatalog } from "./desktop-session-catalog.js";
import { createDesktopStateStore } from "./desktop-state-store.js";
import { createDesktopTaskService } from "./desktop-task-service.js";
import { createFileLockCliAdapter } from "./file-lock-cli-adapter.js";
import { createOpenClawCallbackTransport } from "./openclaw-callback-transport.js";
import { createHostProfileCallbackTransport } from "./host-profile-callback-transport.js";
import { cliCwd, cliEnv, cliNow, cliNowMs, cliPid, cliSleepSync } from "./cli-runtime-context.js";
import type { DesktopCompatibility, DesktopThreadIdentity, DesktopTransportPort } from "./desktop-types.js";

export interface DesktopRuntimeOptions {
  storeDir: string;
  codexHomes: string[];
  openclawBin?: string;
}

/** Read the installed application, never substitute the globally installed CLI version. */
export function installedDesktopCompatibility(): DesktopCompatibility {
  const plist = "/Applications/ChatGPT.app/Contents/Info.plist";
  if (process.platform !== "darwin" || !fs.existsSync(plist)) return { version: "unavailable", build: "unavailable" };
  const read = (key: string) => execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist],
    { encoding: "utf8", timeout: 3000 }).trim();
  if (read("CFBundleIdentifier") !== "com.openai.codex") return { version: "unavailable", build: "unavailable" };
  return { version: read("CFBundleShortVersionString"), build: read("CFBundleVersion") };
}

export function desktopWritesVerified(version: DesktopCompatibility): boolean {
  return version.version === VERIFIED_DESKTOP_BUILD.version && version.build === VERIFIED_DESKTOP_BUILD.build;
}

/** A command owns one connection per thread. No CLI resume or owner acquisition fallback. */
export function createDesktopRuntime(options: DesktopRuntimeOptions) {
  const compatibility = installedDesktopCompatibility();
  const catalog = new DesktopSessionCatalog({ codexHomes: options.codexHomes });
  const clients = new Map<string, Promise<DesktopIpcClient>>();
  const homes = new Set(options.codexHomes.map(home => path.resolve(home)));
  const clientFor = async (identity: DesktopThreadIdentity) => {
    if (identity.hostId !== "local" || !homes.has(path.resolve(identity.codexHome))) {
      throw new Error("Desktop target must belong to a configured local Codex home");
    }
    const key = JSON.stringify(identity);
    let client = clients.get(key);
    if (!client) {
      client = DesktopIpcClient.connect({ socketPath: path.join(identity.codexHome, "ipc", "ipc.sock"), compatibility });
      clients.set(key, client);
    }
    return client;
  };
  const transport: DesktopTransportPort = {
    async observe(identity) {
      const client = await clientFor(identity);
      const owner = await client.discoverOwner(identity.threadId);
      return client.observeThread({ threadId: identity.threadId, ownerClientId: owner.ownerClientId });
    },
    async start(identity, input) {
      return (await clientFor(identity)).sendTurnOnce(input);
    }
  };
  const locks = createFileLockCliAdapter({ now: cliNow, nowMs: cliNowMs, pid: cliPid, sleepSync: cliSleepSync });
  const repository = createDesktopStateStore(options.storeDir, { acquire: lock => locks.acquire(lock) });
  const legacy = createOpenClawCallbackTransport({ now: cliNow, environment: cliEnv,
    redactConversation: () => { throw new Error("Desktop callbacks do not use managed conversations"); },
    recordCallbackProcessDelivery: () => { throw new Error("Desktop callbacks use their durable outbox"); } });
  const callbacks = createHostProfileCallbackTransport({ legacyTransport: legacy, environment: cliEnv, cwd: cliCwd(), now: cliNow });
  const tasks = createDesktopTaskService({ repository, ...transport, now: cliNow,
    deliver: input => callbacks.deliver(input),
    resolveCallbackContext: task => ({ legacyOptions: { gatewayMethod: "chat.send",
      openclawSession: task.controller_session, gatewaySession: task.controller_session, openclawBin: options.openclawBin } }) });
  return { catalog, compatibility, tasks, transport,
    async close() { for (const client of clients.values()) { try { (await client).close(); } catch { /* failed connection */ } } }
  };
}

export type DesktopRuntime = ReturnType<typeof createDesktopRuntime>;

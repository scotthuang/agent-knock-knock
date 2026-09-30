import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { codexProcessIncarnationForPid } from "./codex-process-incarnation.js";
import {
  isAuditedCodexPaginatedServerPair,
  isCodexPaginatedVersion
} from "./codex-lifecycle-compatibility.js";
import { connectCodexAppServerReadClient } from "./codex-app-server-read-client.js";
import { createCodexTerminalAgentAdapter } from "./codex-terminal-agent-adapter.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import { stripTerminalEscapeSequences } from "./terminal-native-inspection-bridge.js";

import type { CodexPaginatedThreadBinding } from "./codex-paginated-thread-facts.js";
export type { CodexPaginatedThreadBinding } from "./codex-paginated-thread-facts.js";

export function codexPaginatedHome(configured?: string): string {
  const value = configured ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

export async function captureCodexPaginatedThreadBinding(input: {
  bridge: Pick<TerminalAgentBridge, "submitCodexStatusProbe" | "captureCodexStatusFrame">;
  terminalControl: TerminalControlRef;
  pid: number;
  agentVersion: string;
  codexHome?: string;
  allowWorking?: boolean;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  incarnation?: typeof codexProcessIncarnationForPid;
  resolveBackendVersion?: (request: {
    codexHome: string;
    agentVersion: string;
  }) => Promise<string>;
}): Promise<CodexPaginatedThreadBinding> {
  if (!isCodexPaginatedVersion(input.agentVersion)) {
    throw new Error("Codex paginated foreground inspection requires version 0.158.0, 0.159.0, or 0.159.2");
  }
  const incarnation = input.incarnation ?? codexProcessIncarnationForPid;
  const before = incarnation(input.pid);
  const runtime = { pid: input.pid, agentVersion: input.agentVersion };
  const submission = await input.bridge.submitCodexStatusProbe(
    input.terminalControl, input.agentVersion,
    { runtime, ...(input.allowWorking ? { allowWorkingCodexStatus: true } : {}) }
  );
  const adapter = createCodexTerminalAgentAdapter();
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const frame = await input.bridge.captureCodexStatusFrame(input.terminalControl, runtime, submission);
    const observed = adapter.observeNativeInspection?.({
      operation: { kind: "status" }, expectedAgentVersion: input.agentVersion,
      screen: stripTerminalEscapeSequences(frame.screen),
      previousScreenFingerprint: submission.preEnterScreenDigest
    });
    // LocalDaemon processes the /status history cell before its next Draw.
    // A cleared styled Composer plus complete card proves this closed command
    // finished; fullscreen clipping cannot preserve a monotonic card count.
    if (frame.emptyComposer && createHash("sha256").update(frame.screen).digest("hex") !== submission.observationBaselineDigest &&
        observed?.status === "observed" && observed.nativeThreadId &&
        observed.result?.fields.some((field) => field.name === "Server" && field.value === "Local background server")) {
      const codexHome = codexPaginatedHome(input.codexHome);
      const serverVersion = await (input.resolveBackendVersion ?? resolveCodexBackendVersion)({
        codexHome, agentVersion: input.agentVersion
      });
      if (!isAuditedCodexPaginatedServerPair(input.agentVersion, serverVersion)) {
        throw new Error("Codex TUI and shared app-server versions are not an audited pair");
      }
      const after = incarnation(input.pid);
      if (after.processUuid !== before.processUuid || after.processBirth !== before.processBirth) {
        throw new Error("Codex process changed during foreground thread inspection");
      }
      return {
        codexHome,
        threadId: observed.nativeThreadId, agentVersion: input.agentVersion,
        serverVersion,
        processUuid: after.processUuid, processBirth: after.processBirth,
        pid: input.pid, observedAt: (input.now?.() ?? new Date()).toISOString()
      };
    }
    await sleep(100);
  }
  throw new Error("Codex did not provide a fresh exact foreground thread in /status");
}

async function resolveCodexBackendVersion(request: {
  codexHome: string;
  agentVersion: string;
}): Promise<string> {
  const client = await connectCodexAppServerReadClient({
    codexHome: request.codexHome,
    expectedServerVersion: request.agentVersion,
    allowAuditedBackendPatch: true
  });
  try {
    return client.metadata.serverVersion;
  } finally {
    client.close();
  }
}

export function assertCodexPaginatedProcess(binding: CodexPaginatedThreadBinding): void {
  const current = codexProcessIncarnationForPid(binding.pid);
  if (current.processUuid !== binding.processUuid || current.processBirth !== binding.processBirth) {
    throw new Error("Codex paginated thread's physical process incarnation changed");
  }
}

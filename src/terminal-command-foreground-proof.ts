import fs from "node:fs";

import type { Executor } from "./protocol.js";
import type {
  TerminalAgentAdapterRegistry,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import type { TerminalBridgeStatus } from "./terminal-agent-bridge.js";
import type { CodexForegroundIdentificationProof } from
  "./native-thread-lifecycle-cli-adapter.js";
import { nonBlankString } from "./value-guards.js";

export interface CodexForegroundProofPorts {
  createRegistry(options: Record<string, unknown>):
    TerminalAgentAdapterRegistry;
  nowMs(): number;
  processIncarnationForPid(pid: number): {
    processUuid: string;
    processBirth: string;
    evidence: "process_birth";
  };
}

export interface CodexForegroundProofAssertion {
  options: Record<string, unknown>;
  executor: Executor;
  terminalControl: TerminalControlRef;
  terminalAgentPid: number;
  status: TerminalBridgeStatus;
}

export interface CodexForegroundProofAuthority {
  clear(options: object): void;
  current(options: object): CodexForegroundIdentificationProof | undefined;
  remember(options: object, proof: CodexForegroundIdentificationProof): void;
  assertCurrent(input: CodexForegroundProofAssertion): void;
}

/**
 * Own the in-process, object-identity-bound /status proof used by atomic
 * identify-and-send. The proof is never parsed from CLI arguments or persisted
 * as Session authority.
 */
export function createCodexForegroundProofAuthority(
  ports: CodexForegroundProofPorts
): CodexForegroundProofAuthority {
  const proofs = new WeakMap<object, CodexForegroundIdentificationProof>();
  return Object.freeze({
    clear(options: object): void {
      proofs.delete(options);
    },
    current(options: object): CodexForegroundIdentificationProof | undefined {
      return proofs.get(options);
    },
    remember(
      options: object,
      proof: CodexForegroundIdentificationProof
    ): void {
      proofs.set(options, proof);
    },
    assertCurrent(input: CodexForegroundProofAssertion): void {
      if (input.options.identifyForeground !== true) return;
      if (input.executor.kind !== "codex") {
        throw new Error(
          "atomic foreground identification currently supports only Codex terminals"
        );
      }
      const proof = proofs.get(input.options);
      if (!proof) {
        throw new Error(
          "atomic foreground identification proof is unavailable; no task input was sent"
        );
      }
      const expiresAtMs = Date.parse(proof.expiresAt);
      if (!Number.isFinite(expiresAtMs) || ports.nowMs() >= expiresAtMs) {
        throw new Error(
          "atomic foreground identification proof expired before task dispatch; no task input was sent"
        );
      }
      const processIncarnation = ports.processIncarnationForPid(
        input.terminalAgentPid
      );
      if (
        proof.pid !== input.terminalAgentPid ||
        proof.processUuid !== processIncarnation.processUuid ||
        proof.processBirth !== processIncarnation.processBirth
      ) {
        throw new Error(
          "Codex process incarnation changed after foreground identification; no task input was sent"
        );
      }
      const cwd = nonBlankString(input.terminalControl.currentPath);
      let realCwd: string | undefined;
      try {
        realCwd = cwd ? fs.realpathSync(cwd) : undefined;
      } catch {
        realCwd = undefined;
      }
      if (!realCwd || realCwd !== proof.realCwd) {
        throw new Error(
          "Codex terminal cwd changed after foreground identification; no task input was sent"
        );
      }
      if (
        !nonBlankString(input.status.screen.digest) ||
        input.status.screen.digest !== proof.postProbeScreenDigest
      ) {
        throw new Error(
          "Codex screen generation changed after foreground identification; no task input was sent"
        );
      }
      const observation = ports.createRegistry(input.options)
        .require("codex")
        .observeNativeInspection?.({
          operation: { kind: "status" },
          screen: input.status.screen.excerpt ?? "",
          expectedNativeThreadId: proof.nativeThreadId,
          expectedAgentVersion: proof.agentVersion,
          expectedCwd: proof.realCwd
        });
      if (
        observation?.status !== "observed" ||
        observation.nativeThreadId !== proof.nativeThreadId ||
        observation.evidenceFingerprint !== proof.evidenceFingerprint
      ) {
        throw new Error(
          "Codex /status identity changed after foreground identification; no task input was sent"
        );
      }
    }
  });
}

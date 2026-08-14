import path from "node:path";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey
} from "./terminal-control-ref.js";
import {
  capabilityGatedRepositoryPairOperation,
  type CanonicalMutationResources,
  type CanonicalMutationScopes
} from "./mutation-transaction.js";

export type NativeThreadTransitionResourceBinding = Readonly<{
  freshTerminal: TerminalControlRef;
  capturedStoreDir: string;
}>;

/**
 * Bind one lifecycle operation to the active terminal+writer transaction.
 * The operation receives the post-lock terminal route and canonical Store only
 * after authentic scopes and the captured resource identities are revalidated.
 */
export function nativeThreadTransitionResourceBoundOperation<
  Args extends unknown[],
  Result
>(
  binding: NativeThreadTransitionResourceBinding,
  operation: (
    freshTerminal: TerminalControlRef,
    canonicalStoreDir: string,
    ...args: Args
  ) => Result
): (
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  ...args: Args
) => Result {
  const gated = capabilityGatedRepositoryPairOperation(
    ["terminal", "storeWriter"] as const,
    ["terminal", "storeWriter"] as const,
    (
      activeTerminal: TerminalControlRef,
      activeStoreDir: string,
      resources: CanonicalMutationResources,
      ...args: Args
    ): Result => {
      if (
        typeof activeStoreDir !== "string" ||
        typeof binding.capturedStoreDir !== "string"
      ) {
        throw new Error(
          "native thread lifecycle Store changed outside the active writer capability"
        );
      }
      const canonicalStoreDir = path.resolve(activeStoreDir);
      let terminalCapabilityMatches = false;
      try {
        const activePid = Number(
          terminalEndpointFromControlRef(activeTerminal).processAnchorPid
        );
        const freshPid = Number(
          terminalEndpointFromControlRef(
            binding.freshTerminal
          ).processAnchorPid
        );
        terminalCapabilityMatches =
          Number.isSafeInteger(activePid) && activePid > 1 &&
          Number.isSafeInteger(freshPid) && freshPid > 1 &&
          sameTerminalControlIncarnation(
            activeTerminal,
            binding.freshTerminal
          ) &&
          resources.terminal.key ===
            terminalRuntimeResourceKey(activeTerminal) &&
          resources.terminal.key ===
            terminalRuntimeResourceKey(binding.freshTerminal);
      } catch {
        terminalCapabilityMatches = false;
      }
      if (!terminalCapabilityMatches) {
        throw new Error(
          "native thread lifecycle terminal changed outside the active capability"
        );
      }
      if (
        activeStoreDir !== canonicalStoreDir ||
        resources.storeWriter.key !== canonicalStoreDir ||
        path.resolve(binding.capturedStoreDir) !== canonicalStoreDir
      ) {
        throw new Error(
          "native thread lifecycle Store changed outside the active writer capability"
        );
      }
      return operation(binding.freshTerminal, canonicalStoreDir, ...args);
    }
  );
  return (scopes, resources, ...args) =>
    gated(scopes, resources, resources, ...args);
}

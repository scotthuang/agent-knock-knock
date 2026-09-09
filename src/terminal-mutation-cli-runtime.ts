import path from "node:path";
import type { FileLockAcquisitionOptions } from
  "./file-lock-cli-adapter.js";
import {
  canonicalMutationResource,
  withCanonicalStateMutationLock,
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  type CanonicalStateMutationResources,
  type CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  terminalDispatchStateLockPath,
  terminalDispatchStateMutationResource,
  terminalDispatchStateResourceForStore
} from "./terminal-dispatch-capability.js";

export interface TerminalMutationCliRuntimePorts {
  acquireFileLock(
    lockPath: string,
    options?: FileLockAcquisitionOptions
  ): () => void;
  acquireTerminalBridgeSendLock(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  terminalBridgeRuntimeKey(terminalControl: TerminalControlRef): string;
  withStoreWriterLeaseAsync<Result>(
    storeDir: string,
    operation: () => Promise<Result>,
    options?: Readonly<{ timeoutMs?: number }>
  ): Promise<Result>;
}

export type TerminalWriterMutationLockOptions =
  FileLockAcquisitionOptions & Readonly<{
    terminalTimeoutMs?: number;
    storeWriterTimeoutMs?: number;
    afterTerminalAcquired?: () => void | Promise<void>;
  }>;

export function createTerminalMutationCliRuntime(
  ports: TerminalMutationCliRuntimePorts
) {
  function terminalWriterMutationLocks(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options: TerminalWriterMutationLockOptions = {}
  ) {
    const canonicalStoreDir = path.resolve(storeDir);
    return {
      resources: {
        terminal: canonicalMutationResource(
          ports.terminalBridgeRuntimeKey(terminalControl),
          terminalControl
        ),
        storeWriter: canonicalMutationResource(
          canonicalStoreDir,
          canonicalStoreDir
        )
      },
      acquireTerminal: () => ports.acquireTerminalBridgeSendLock(
        canonicalStoreDir,
        terminalControl,
        {
          timeoutMs:
            options.terminalTimeoutMs ?? options.timeoutMs ?? 30_000,
          retryMs: options.retryMs
        }
      ),
      ...(options.afterTerminalAcquired
        ? { afterTerminalAcquired: options.afterTerminalAcquired }
        : {}),
      withStoreWriter: <Result>(operation: () => Promise<Result>) =>
        ports.withStoreWriterLeaseAsync(canonicalStoreDir, operation, {
          timeoutMs: options.storeWriterTimeoutMs ?? options.timeoutMs
        })
    };
  }

  function terminalWriterStateMutationLocks(
    storeDir: string,
    terminalControl: TerminalControlRef,
    statePath: string,
    logPath: string
  ) {
    const locks = terminalWriterMutationLocks(storeDir, terminalControl);
    const stateResource = terminalDispatchStateResourceForStore(
      storeDir,
      statePath,
      logPath
    );
    return {
      ...locks,
      resources: { ...locks.resources, state: stateResource },
      acquireState: () => ports.acquireFileLock(
        terminalDispatchStateLockPath(stateResource)
      )
    };
  }

  function withTerminalDispatchStateScope<Result>(
    scopes: CanonicalMutationScopes,
    resources: CanonicalMutationResources,
    statePath: string,
    logPath: string,
    operation: (
      scopes: CanonicalStateMutationScopes,
      resources: CanonicalStateMutationResources
    ) => Promise<Result>,
    options: FileLockAcquisitionOptions = {}
  ): Promise<Result> {
    const stateResource = terminalDispatchStateMutationResource(
      scopes,
      resources,
      statePath,
      logPath
    );
    return withCanonicalStateMutationLock(
      scopes,
      resources,
      {
        resource: stateResource,
        acquire: () => ports.acquireFileLock(
          terminalDispatchStateLockPath(stateResource),
          options
        )
      },
      operation
    );
  }

  return Object.freeze({
    terminalWriterMutationLocks,
    terminalWriterStateMutationLocks,
    withTerminalDispatchStateScope
  });
}

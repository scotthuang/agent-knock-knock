import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expandHome } from "./cli-command-runtime.js";
import {
  cliEnv,
  cliNow,
  cliNowMs,
  cliPid,
  cliSleepSync
} from "./cli-runtime-context.js";
import {
  atomicReplacePrivateJsonFile,
  fsyncDirectory
} from "./durable-json-file.js";
import {
  createFileLockCliAdapter,
  type FileLockAcquisitionOptions
} from "./file-lock-cli-adapter.js";
import { defaultStoreDir, ensureDir } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey
} from "./terminal-control-ref.js";
import {
  constructTerminalDispatchLedgerDocument,
  decodeTerminalDispatchLedgerDocument,
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export interface TerminalDispatchResolveRequest {
  conversation: Readonly<{ conversation_id: string }>;
  expectedMessageId?: string;
  reason: string;
}

export interface TerminalDispatchRepositoryCliAdapter {
  acquire(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  runtimeDir(): string;
  runtimeKey(terminalControl: TerminalControlRef): string;
  load(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined;
  save(
    terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument
  ): void;
  restore(input: {
    terminalControl: TerminalControlRef;
    previousLedger?: TerminalDispatchLedgerDocument;
    reason: string;
  }): void;
  resolve(
    terminalControl: TerminalControlRef,
    request: TerminalDispatchResolveRequest
  ): boolean;
  reconcileIncarnation(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined;
  matchesControl(
    ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options?: {
      requireCurrentRoute?: boolean;
      requireProcessAnchor?: boolean;
    }
  ): boolean;
  processAnchor(
    ledger: TerminalDispatchLedgerDocument
  ): number | undefined;
}

/**
 * Own the raw filesystem, lock-path, and byte-level persistence boundary for
 * ordinary terminal dispatch ledgers. Product recovery policy stays outside
 * this adapter.
 */
export function createTerminalDispatchRepositoryCliAdapter():
  TerminalDispatchRepositoryCliAdapter {
  const fileLock = createFileLockCliAdapter({
    now: cliNow,
    nowMs: cliNowMs,
    pid: cliPid,
    sleepSync: cliSleepSync
  });

  function runtimeDir(): string {
    const configured = nonBlankString(cliEnv().AKK_RUNTIME_DIR);
    return configured
      ? path.resolve(expandHome(configured))
      : path.join(path.dirname(defaultStoreDir()), "runtime-v2");
  }

  function runtimeKey(terminalControl: TerminalControlRef): string {
    return terminalRuntimeResourceKey(terminalControl);
  }

  function legacyRuntimeKey(terminalControl: TerminalControlRef): string {
    return terminalRuntimeResourceKey(terminalControl, { legacy: true });
  }

  function runtimeLockDir(): string {
    return path.join(runtimeDir(), "terminal-locks");
  }

  function sendLockPath(terminalControl: TerminalControlRef): string {
    const lockDir = runtimeLockDir();
    ensureDir(lockDir);
    return path.join(
      lockDir,
      `terminal-bridge-send-${runtimeKey(terminalControl)}.lock`
    );
  }

  function legacySendLockPath(terminalControl: TerminalControlRef): string {
    const lockDir = runtimeLockDir();
    ensureDir(lockDir);
    return path.join(
      lockDir,
      `terminal-bridge-send-${legacyRuntimeKey(terminalControl)}.lock`
    );
  }

  function acquire(
    _storeDir: string,
    terminalControl: TerminalControlRef,
    options: FileLockAcquisitionOptions = {}
  ): () => void {
    const lockPaths = [...new Set([
      sendLockPath(terminalControl),
      legacySendLockPath(terminalControl)
    ])].sort();
    const releases: Array<() => void> = [];
    try {
      for (const lockPath of lockPaths) {
        releases.push(fileLock.acquire(lockPath, options));
      }
    } catch (error) {
      for (const release of releases.reverse()) {
        release();
      }
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of [...releases].reverse()) {
        release();
      }
    };
  }

  function ledgerPath(
    terminalControl: TerminalControlRef,
    options: { legacy?: boolean } = {}
  ): string {
    const ledgerDir = path.join(runtimeDir(), "terminal-dispatch");
    const key = options.legacy
      ? legacyRuntimeKey(terminalControl)
      : runtimeKey(terminalControl);
    return path.join(ledgerDir, `terminal-dispatch-${key}.json`);
  }

  function ledgerPaths(terminalControl: TerminalControlRef): string[] {
    return [...new Set([
      ledgerPath(terminalControl),
      ledgerPath(terminalControl, { legacy: true })
    ])];
  }

  function pathExistsNoFollow(candidate: string): boolean {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  function load(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined {
    const existingPaths = ledgerPaths(terminalControl).filter(
      pathExistsNoFollow
    );
    if (existingPaths.length === 0) return undefined;
    if (existingPaths.length > 1) {
      throw new Error(
        "terminal dispatch ledger has conflicting canonical and legacy owners: " +
          existingPaths.join(", ")
      );
    }
    const filePath = existingPaths[0];
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `terminal dispatch ledger is not a regular file: ${filePath}`
      );
    }
    return decodeTerminalDispatchLedgerDocument(
      fs.readFileSync(filePath, "utf8"),
      {
        ledgerPath: filePath,
        terminalControl,
        legacyTerminalKey: legacyRuntimeKey(terminalControl),
        canonicalTerminalKey: runtimeKey(terminalControl)
      }
    );
  }

  function save(
    terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument
  ): void {
    const previousLedger = load(terminalControl);
    const existingPaths = ledgerPaths(terminalControl).filter(
      pathExistsNoFollow
    );
    let filePath = existingPaths[0] ?? ledgerPath(terminalControl);
    const canonicalPath = ledgerPath(terminalControl);
    const legacyPath = ledgerPath(terminalControl, { legacy: true });
    ensureDir(path.dirname(canonicalPath));
    if (
      hasCanonicalTerminalEndpoint(terminalControl) &&
      filePath === legacyPath &&
      legacyPath !== canonicalPath
    ) {
      if (pathExistsNoFollow(canonicalPath)) {
        throw new Error(
          "terminal dispatch ledger has conflicting canonical and legacy owners: " +
            `${canonicalPath}, ${legacyPath}`
        );
      }
      fs.renameSync(legacyPath, canonicalPath);
      fsyncDirectory(path.dirname(canonicalPath));
      filePath = canonicalPath;
    }
    const preserveLegacyFormat = !hasCanonicalTerminalEndpoint(terminalControl);
    ensureDir(path.dirname(filePath));
    if (pathExistsNoFollow(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `terminal dispatch ledger is not a regular file: ${filePath}`
        );
      }
    }
    const useCanonicalFormat =
      hasCanonicalTerminalEndpoint(terminalControl) && !preserveLegacyFormat;
    const nextLedger = constructTerminalDispatchLedgerDocument({
      previousLedger,
      incomingLedger: ledger,
      version: useCanonicalFormat ? 2 : 1,
      terminalKey: preserveLegacyFormat
        ? legacyRuntimeKey(terminalControl)
        : runtimeKey(terminalControl),
      terminalControl: {
        kind: terminalControl.kind,
        target: terminalControl.target,
        socket_path: terminalControl.socketPath ?? null,
        pane_pid: terminalControl.panePid ?? null,
        current_path: terminalControl.currentPath ?? null,
        ...(terminalControl.kind === "herdr"
          ? {
              session: terminalControl.session,
              session_dir: terminalControl.sessionDir ?? null,
              workspace_id: terminalControl.workspaceId,
              tab_id: terminalControl.tabId,
              pane_id: terminalControl.paneId,
              terminal_id: terminalControl.terminalId
            }
          : {})
      },
      ...(useCanonicalFormat
        ? { terminalEndpoint: terminalControlEvidence(terminalControl) }
        : {})
    });
    const temporaryPath = `${filePath}.${cliPid()}.${randomUUID()}.tmp`;
    atomicReplacePrivateJsonFile(filePath, nextLedger, {
      temporaryPath,
      cleanupTemporary: () => fs.rmSync(temporaryPath, { force: true })
    });
  }

  function restore({
    terminalControl,
    previousLedger,
    reason
  }: {
    terminalControl: TerminalControlRef;
    previousLedger?: TerminalDispatchLedgerDocument;
    reason: string;
  }): void {
    save(terminalControl, previousLedger ?? {
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason
    });
  }

  function resolve(
    terminalControl: TerminalControlRef,
    request: TerminalDispatchResolveRequest
  ): boolean {
    const ledger = load(terminalControl);
    if (
      !ledger ||
      nonBlankString(ledger.conversation_id) !==
        request.conversation.conversation_id ||
      (
        request.expectedMessageId !== undefined &&
        nonBlankString(ledger.message_id) !== request.expectedMessageId
      )
    ) {
      return false;
    }
    save(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason: request.reason
    });
    return true;
  }

  function matchesControl(
    ledger: TerminalDispatchLedgerDocument | undefined,
    terminalControl: TerminalControlRef,
    options: {
      requireCurrentRoute?: boolean;
      requireProcessAnchor?: boolean;
    } = {}
  ): boolean {
    if (!ledger) return false;
    const evidence = ledger.terminal_endpoint !== undefined
      ? ledger.terminal_endpoint
      : ledger.terminal_control;
    return terminalControlEvidenceMatches(evidence, terminalControl, options);
  }

  function processAnchor(
    ledger: TerminalDispatchLedgerDocument
  ): number | undefined {
    const evidence = isRecord(ledger.terminal_endpoint)
      ? ledger.terminal_endpoint
      : isRecord(ledger.terminal_control)
        ? ledger.terminal_control
        : undefined;
    const panePid = Number(
      evidence?.process_anchor_pid ?? evidence?.pane_pid ?? evidence?.panePid
    );
    return Number.isSafeInteger(panePid) && panePid > 0 ? panePid : undefined;
  }

  function reconcileIncarnation(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined {
    if (!ledger || ledger.status === "resolved") return ledger;
    if (terminalDispatchLedgerLooksLifecycle(ledger)) return ledger;
    if (
      !matchesControl(ledger, terminalControl, {
        requireProcessAnchor: false
      }) ||
      matchesControl(ledger, terminalControl)
    ) {
      return ledger;
    }
    const previousAnchor = processAnchor(ledger);
    const currentAnchor = terminalEndpointFromControlRef(
      terminalControl
    ).processAnchorPid;
    save(terminalControl, {
      ...ledger,
      status: "resolved",
      resolved_at: cliNow().toISOString(),
      reason:
        "terminal process incarnation changed from anchor " +
        `${previousAnchor} to ${currentAnchor ?? "unknown"}`
    });
    return load(terminalControl);
  }

  return Object.freeze({
    acquire,
    runtimeDir,
    runtimeKey,
    load,
    save,
    restore,
    resolve,
    reconcileIncarnation,
    matchesControl,
    processAnchor
  });
}

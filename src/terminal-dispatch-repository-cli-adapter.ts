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
  type FileLockCliAdapter,
  type FileLockAcquisitionOptions
} from "./file-lock-cli-adapter.js";
import { defaultStoreDir, ensureDir } from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey,
  tmuxTerminalRouteKey
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

function terminalDispatchLedgerMatchesControl(
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

function terminalDispatchLedgerProcessAnchor(
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

function serializedTerminalControl(
  terminalControl: TerminalControlRef
): TerminalDispatchLedgerDocument {
  return {
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
  };
}

/**
 * Recover the only v1 document that can legitimately exist at a canonical
 * path: the durable image left after the legacy-path rename and before its v2
 * rewrite. The canonical filename supplies stable resource identity, while
 * the self-key, provider endpoint, and exact process anchor prove that the v1
 * bytes still own the current tmux incarnation. No legacy-path document is
 * eligible for this route-insensitive recovery.
 */
function normalizeInterruptedCanonicalV1(
  ledger: TerminalDispatchLedgerDocument,
  terminalControl: TerminalControlRef
): TerminalDispatchLedgerDocument | undefined {
  if (
    ledger.version !== 1 ||
    terminalControl.kind !== "tmux" ||
    !hasCanonicalTerminalEndpoint(terminalControl)
  ) {
    return undefined;
  }
  const storedControl = isRecord(ledger.terminal_control)
    ? ledger.terminal_control
    : undefined;
  const storedTarget = nonBlankString(storedControl?.target);
  const storedSocketValue = storedControl?.socket_path;
  const storedSocket = storedSocketValue === null
    ? undefined
    : nonBlankString(storedSocketValue);
  const storedAnchor = storedControl?.pane_pid;
  const currentEndpoint = terminalEndpointFromControlRef(terminalControl);
  const currentAnchor = currentEndpoint.processAnchorPid;
  if (
    storedControl?.kind !== "tmux" ||
    !storedTarget ||
    !(storedSocketValue === null || storedSocket !== undefined) ||
    storedSocket !== terminalControl.socketPath ||
    typeof storedAnchor !== "number" ||
    !Number.isSafeInteger(storedAnchor) ||
    storedAnchor <= 0 ||
    !Number.isSafeInteger(currentAnchor) ||
    currentAnchor === undefined ||
    currentAnchor <= 0 ||
    storedAnchor !== currentAnchor
  ) {
    return undefined;
  }
  const storedRouteControl: TerminalControlRef = {
    kind: "tmux",
    target: storedTarget,
    socketPath: storedSocket,
    session: storedTarget.split(":", 1)[0] ?? storedTarget,
    window: 0,
    pane: 0,
    panePid: storedAnchor,
    capabilities: []
  };
  if (
    nonBlankString(ledger.terminal_key) !==
      terminalRuntimeResourceKey(storedRouteControl, { legacy: true })
  ) {
    return undefined;
  }
  const historicalEndpoint = {
    ...terminalControlEvidence(terminalControl),
    route_key: tmuxTerminalRouteKey(
      currentEndpoint.identity.endpointKey,
      storedTarget,
      storedSocket
    ),
    target: storedTarget,
    socket_path: storedSocket ?? null,
    pane_pid: storedAnchor,
    current_path: storedControl.current_path ?? null
  };
  return constructTerminalDispatchLedgerDocument({
    previousLedger: ledger,
    incomingLedger: ledger,
    version: 2,
    terminalKey: terminalRuntimeResourceKey(terminalControl),
    // Keep the route that actually accepted the input for one read-only
    // recovery projection. The next save advances only the top-level owner to
    // the current route while its historical receipt remains attributable to
    // this exact old route.
    terminalControl: { ...storedControl },
    terminalEndpoint: historicalEndpoint
  });
}

function decodeLocatedTerminalDispatchLedger(
  source: string,
  options: {
    filePath: string;
    terminalControl: TerminalControlRef;
    legacyTerminalKey: string;
    canonicalTerminalKey: string;
    allowInterruptedCanonicalV1: boolean;
  }
): TerminalDispatchLedgerDocument {
  let ledger: TerminalDispatchLedgerDocument;
  try {
    ledger = decodeTerminalDispatchLedgerDocument(source, {
      ledgerPath: options.filePath,
      terminalControl: options.terminalControl,
      legacyTerminalKey: options.legacyTerminalKey,
      canonicalTerminalKey: options.canonicalTerminalKey
    });
  } catch (error) {
    if (!options.allowInterruptedCanonicalV1) throw error;
    const parsed: unknown = JSON.parse(source);
    if (!isRecord(parsed)) throw error;
    const normalized = normalizeInterruptedCanonicalV1(
      parsed,
      options.terminalControl
    );
    if (!normalized) throw error;
    return normalized;
  }
  if (
    ledger.version !== 1 ||
    !options.allowInterruptedCanonicalV1
  ) {
    return ledger;
  }
  const normalized = normalizeInterruptedCanonicalV1(
    ledger,
    options.terminalControl
  );
  if (!normalized) {
    throw new Error(
      `terminal dispatch ledger is invalid: ${options.filePath}`
    );
  }
  return normalized;
}

/**
 * Own the raw filesystem, lock-path, and byte-level persistence boundary for
 * ordinary terminal dispatch ledgers. Product recovery policy stays outside
 * this adapter.
 */
export function createTerminalDispatchRepositoryCliAdapter(
  dependencies: Readonly<{ fileLock?: FileLockCliAdapter }> = {}
):
  TerminalDispatchRepositoryCliAdapter {
  const fileLock = dependencies.fileLock ?? createFileLockCliAdapter({
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
        try {
          release();
        } catch {
          // Preserve the acquisition failure. In particular, a LOCK_TIMEOUT
          // must never be downgraded into the user-priority no-lock path by a
          // secondary cleanup failure.
        }
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

  function pathExistsNoFollow(candidate: string): boolean {
    try {
      fs.lstatSync(candidate);
      return true;
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  interface LocatedLedger {
    filePath: string;
    location: "canonical" | "legacy";
    ledger: TerminalDispatchLedgerDocument;
    source: string;
  }

  type LedgerOwnerClassification =
    | "current_owner"
    | "stale_history"
    | "ambiguous_conflict";

  type DualLedgerClassification =
    | {
        classification: "current_owner";
        owner: LocatedLedger;
        staleCanonical?: LocatedLedger;
      }
    | { classification: "stale_history" }
    | { classification: "ambiguous_conflict" };

  interface LedgerSelection {
    selected?: LocatedLedger;
    staleCanonical?: LocatedLedger;
  }

  function readLedger(
    terminalControl: TerminalControlRef,
    filePath: string,
    location: LocatedLedger["location"]
  ): LocatedLedger {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(
        `terminal dispatch ledger is not a regular file: ${filePath}`
      );
    }
    const source = fs.readFileSync(filePath, "utf8");
    return {
      filePath,
      location,
      ledger: decodeLocatedTerminalDispatchLedger(source, {
        filePath,
        terminalControl,
        legacyTerminalKey: legacyRuntimeKey(terminalControl),
        canonicalTerminalKey: runtimeKey(terminalControl),
        allowInterruptedCanonicalV1:
          location === "canonical" &&
          filePath === ledgerPath(terminalControl) &&
          hasCanonicalTerminalEndpoint(terminalControl)
      }),
      source
    };
  }

  function anchorRelation(
    ledger: TerminalDispatchLedgerDocument,
    terminalControl: TerminalControlRef
  ): "same" | "different" | "unknown" {
    const ledgerAnchor = terminalDispatchLedgerProcessAnchor(ledger);
    const currentAnchor = terminalEndpointFromControlRef(
      terminalControl
    ).processAnchorPid;
    if (ledgerAnchor === undefined || currentAnchor === undefined) {
      return "unknown";
    }
    return ledgerAnchor === currentAnchor ? "same" : "different";
  }

  function canonicalLedgerMatchesCurrentIncarnation(
    ledger: TerminalDispatchLedgerDocument,
    terminalControl: TerminalControlRef
  ): boolean {
    return ledger.version === 2 &&
      anchorRelation(ledger, terminalControl) === "same" &&
      terminalControlEvidenceMatches(
        ledger.terminal_endpoint,
        terminalControl,
        { requireProcessAnchor: true }
      );
  }

  function classifyOwner(
    located: LocatedLedger,
    terminalControl: TerminalControlRef
  ): LedgerOwnerClassification {
    if (
      (located.location === "canonical" && located.ledger.version !== 2) ||
      (located.location === "legacy" && located.ledger.version !== 1)
    ) {
      return "ambiguous_conflict";
    }
    const relation = anchorRelation(located.ledger, terminalControl);
    if (relation === "different") return "stale_history";
    if (relation === "unknown") return "ambiguous_conflict";
    if (
      located.location === "canonical" &&
      !canonicalLedgerMatchesCurrentIncarnation(
        located.ledger,
        terminalControl
      )
    ) {
      return "ambiguous_conflict";
    }
    return "current_owner";
  }

  function classifyDualLedgers(
    canonical: LocatedLedger,
    legacy: LocatedLedger,
    terminalControl: TerminalControlRef
  ): DualLedgerClassification {
    const canonicalAnchor = terminalDispatchLedgerProcessAnchor(
      canonical.ledger
    );
    const legacyAnchor = terminalDispatchLedgerProcessAnchor(legacy.ledger);
    if (
      canonicalAnchor === undefined ||
      legacyAnchor === undefined ||
      canonicalAnchor === legacyAnchor
    ) {
      return { classification: "ambiguous_conflict" };
    }
    const canonicalClassification = classifyOwner(canonical, terminalControl);
    const legacyClassification = classifyOwner(legacy, terminalControl);
    if (
      canonicalClassification === "current_owner" &&
      legacyClassification === "stale_history"
    ) {
      return { classification: "current_owner", owner: canonical };
    }
    if (
      canonicalClassification === "stale_history" &&
      legacyClassification === "current_owner"
    ) {
      return {
        classification: "current_owner",
        owner: legacy,
        staleCanonical: canonical
      };
    }
    if (
      canonicalClassification === "stale_history" &&
      legacyClassification === "stale_history"
    ) {
      return { classification: "stale_history" };
    }
    return { classification: "ambiguous_conflict" };
  }

  function conflictingOwnersError(paths: readonly string[]): Error {
    return new Error(
      "terminal dispatch ledger has conflicting canonical and legacy owners: " +
        paths.join(", ")
    );
  }

  function selectLedger(
    terminalControl: TerminalControlRef
  ): LedgerSelection {
    const canonicalPath = ledgerPath(terminalControl);
    const legacyPath = ledgerPath(terminalControl, { legacy: true });
    if (canonicalPath === legacyPath) {
      return {
        selected: pathExistsNoFollow(canonicalPath)
          ? readLedger(terminalControl, canonicalPath, "canonical")
          : undefined
      };
    }
    const canonicalExists = pathExistsNoFollow(canonicalPath);
    const legacyExists = pathExistsNoFollow(legacyPath);
    if (!canonicalExists && !legacyExists) return {};

    const canonical = canonicalExists
      ? readLedger(terminalControl, canonicalPath, "canonical")
      : undefined;
    const legacy = legacyExists
      ? readLedger(terminalControl, legacyPath, "legacy")
      : undefined;
    if (canonical && legacy) {
      const classification = classifyDualLedgers(
        canonical,
        legacy,
        terminalControl
      );
      if (classification.classification === "current_owner") {
        return {
          selected: classification.owner,
          staleCanonical: classification.staleCanonical
        };
      }
      if (classification.classification === "stale_history") return {};
      throw conflictingOwnersError([canonicalPath, legacyPath]);
    }
    if (canonical) return { selected: canonical };
    if (
      legacy &&
      hasCanonicalTerminalEndpoint(terminalControl)
    ) {
      const relation = anchorRelation(legacy.ledger, terminalControl);
      if (relation === "different") {
        // The selector has been reused by a different terminal process. Keep
        // the old artifact as history, but it is not an owner of the current
        // stable endpoint and must never be promoted into its canonical path.
        return {};
      }
      if (relation === "unknown") {
        throw new Error(
          "terminal dispatch legacy owner has no exact process anchor: " +
            legacyPath
        );
      }
    }
    return { selected: legacy };
  }

  function load(
    terminalControl: TerminalControlRef
  ): TerminalDispatchLedgerDocument | undefined {
    return selectLedger(terminalControl).selected?.ledger;
  }

  function save(
    terminalControl: TerminalControlRef,
    ledger: TerminalDispatchLedgerDocument
  ): void {
    const selection = selectLedger(terminalControl);
    const selected = selection.selected;
    const previousLedger = selected?.ledger;
    let filePath = selected?.filePath ?? ledgerPath(terminalControl);
    const canonicalPath = ledgerPath(terminalControl);
    const legacyPath = ledgerPath(terminalControl, { legacy: true });
    const preserveLegacyFormat = !hasCanonicalTerminalEndpoint(terminalControl);
    const useCanonicalFormat =
      hasCanonicalTerminalEndpoint(terminalControl) && !preserveLegacyFormat;
    const nextLedger = constructTerminalDispatchLedgerDocument({
      previousLedger,
      incomingLedger: ledger,
      version: useCanonicalFormat ? 2 : 1,
      terminalKey: preserveLegacyFormat
        ? legacyRuntimeKey(terminalControl)
        : runtimeKey(terminalControl),
      terminalControl: serializedTerminalControl(terminalControl),
      ...(useCanonicalFormat
        ? { terminalEndpoint: terminalControlEvidence(terminalControl) }
        : {})
    });
    ensureDir(path.dirname(canonicalPath));
    if (
      hasCanonicalTerminalEndpoint(terminalControl) &&
      selected?.location === "legacy" &&
      filePath === legacyPath &&
      legacyPath !== canonicalPath
    ) {
      if (pathExistsNoFollow(canonicalPath)) {
        const staleCanonical = selection.staleCanonical;
        const currentCanonical = readLedger(
          terminalControl,
          canonicalPath,
          "canonical"
        );
        if (
          !staleCanonical ||
          currentCanonical.source !== staleCanonical.source
        ) {
          throw conflictingOwnersError([canonicalPath, legacyPath]);
        }
      }
      const currentLegacy = readLedger(
        terminalControl,
        legacyPath,
        "legacy"
      );
      if (currentLegacy.source !== selected.source) {
        throw conflictingOwnersError([canonicalPath, legacyPath]);
      }
      fs.renameSync(legacyPath, canonicalPath);
      fsyncDirectory(path.dirname(canonicalPath));
      filePath = canonicalPath;
    }
    ensureDir(path.dirname(filePath));
    if (pathExistsNoFollow(filePath)) {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(
          `terminal dispatch ledger is not a regular file: ${filePath}`
        );
      }
    }
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

  function reconcileIncarnation(
    terminalControl: TerminalControlRef,
    ledger?: TerminalDispatchLedgerDocument
  ): TerminalDispatchLedgerDocument | undefined {
    if (!ledger || ledger.status === "resolved") return ledger;
    if (terminalDispatchLedgerLooksLifecycle(ledger)) return ledger;
    if (
      !terminalDispatchLedgerMatchesControl(ledger, terminalControl, {
        requireProcessAnchor: false
      }) ||
      terminalDispatchLedgerMatchesControl(ledger, terminalControl)
    ) {
      return ledger;
    }
    const previousAnchor = terminalDispatchLedgerProcessAnchor(ledger);
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
    matchesControl: terminalDispatchLedgerMatchesControl,
    processAnchor: terminalDispatchLedgerProcessAnchor
  });
}

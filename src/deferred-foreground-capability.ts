import path from "node:path";

import type { DeferredForegroundTransfer } from
  "./deferred-foreground-transfer.js";
import {
  listDeferredForegroundTransfers,
  loadDeferredForegroundTransfer,
  saveDeferredForegroundTransfer
} from "./deferred-foreground-transfer.js";
import type { ManagedSessionState } from "./managed-session.js";
import type {
  CanonicalMutationResources,
  CanonicalMutationScopes,
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import {
  capabilityGatedRepositoryOperation,
  capabilityGatedRepositoryPairOperation
} from "./mutation-transaction.js";
import {
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import type {
  DeferredForegroundApplicationScope,
  DeferredForegroundBindingBoundary
} from "./deferred-foreground-boundary.js";
import {
  sameTerminalControlIncarnation,
  terminalControlEvidenceMatches,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey
} from
  "./terminal-control-ref.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";

type TransferSave = (
  transfer: DeferredForegroundTransfer,
  expectedRevision: number | null
) => DeferredForegroundTransfer;

type SessionSave = (
  session: ManagedSessionState,
  expectedRevision: number | null
) => ManagedSessionState;

const scopedTransferLoad = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (storeDir: string, transferId: string) =>
    loadDeferredForegroundTransfer(storeDir, transferId)
);

const scopedTransferList = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (storeDir: string) => listDeferredForegroundTransfers(storeDir)
);

const scopedTransferSave = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (
    storeDir: string,
    transfer: DeferredForegroundTransfer,
    expectedRevision: number | null
  ) => saveDeferredForegroundTransfer(
    storeDir,
    transfer,
    { expectedRevision }
  )
);

const scopedSessionLoad = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (storeDir: string, sessionId: string) =>
    loadManagedSession(storeDir, sessionId)
);

const scopedSessionTryLoad = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (storeDir: string, sessionId: string) =>
    tryLoadManagedSession(storeDir, sessionId)
);

const scopedSessionSave = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (
    storeDir: string,
    session: ManagedSessionState,
    expectedRevision: number | null
  ) => saveManagedSession(storeDir, session, { expectedRevision })
);

interface BoundDeferredRoute {
  terminalControl: TerminalControlRef;
  terminalKey: string;
  storeDir: string;
  statePath?: string;
  logPath?: string;
}

const bindTerminalWriterRoute = capabilityGatedRepositoryPairOperation(
  ["terminal", "storeWriter"] as const,
  ["terminal", "storeWriter"] as const,
  (
    terminalControl: TerminalControlRef,
    storeDir: string,
    terminalKey: string,
    storeKey: string
  ): BoundDeferredRoute => {
    if (
      typeof storeDir !== "string" || storeDir.trim().length === 0 ||
      typeof storeKey !== "string" || storeKey.trim().length === 0 ||
      !path.isAbsolute(storeDir)
    ) {
      throw new Error(
        "deferred foreground terminal/writer capability is not canonical"
      );
    }
    const canonicalStoreDir = path.resolve(storeDir);
    if (
      !validTerminalCapability(terminalKey, terminalControl) ||
      storeDir !== canonicalStoreDir ||
      storeKey !== canonicalStoreDir
    ) {
      throw new Error(
        "deferred foreground terminal/writer capability is not canonical"
      );
    }
    return Object.freeze({
      terminalControl,
      terminalKey,
      storeDir: canonicalStoreDir
    });
  }
);

const assertTerminalWriterRouteActive = capabilityGatedRepositoryPairOperation(
  ["terminal", "storeWriter"] as const,
  ["terminal", "storeWriter"] as const,
  () => undefined
);

interface DeferredForegroundStateResource {
  statePath: string;
  logPath: string;
}

const bindDeferredForegroundState = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter", "state"] as const,
  "state",
  (state: DeferredForegroundStateResource) => state
);

function bindTerminalStateRoute(
  scopes: CanonicalStateMutationScopes,
  resources: CanonicalStateMutationResources
): BoundDeferredRoute {
  const writer = bindTerminalWriterRoute(
    scopes,
    resources,
    resources.terminal.key,
    resources.storeWriter.key
  );
  const state = bindDeferredForegroundState(scopes, resources);
  if (
    !state || typeof state.statePath !== "string" ||
    typeof state.logPath !== "string"
  ) {
    throw new Error("deferred foreground state capability is invalid");
  }
  const statePath = path.resolve(state.statePath);
  const conversationDir = path.dirname(statePath);
  const logPath = path.resolve(state.logPath);
  if (
    state.statePath !== statePath ||
    path.basename(statePath) !== "state.json" ||
    path.dirname(conversationDir) !==
      path.join(writer.storeDir, "conversations")
  ) {
    throw new Error(
      "deferred foreground state does not belong to the active Store"
    );
  }
  if (
    state.logPath !== logPath ||
    logPath !== path.join(conversationDir, "events.ndjson")
  ) {
    throw new Error(
      "deferred foreground event log does not match its Turn state"
    );
  }
  if (
    resources.state.key !== statePath ||
    resources.state.value !== state
  ) {
    throw new Error(
      "deferred foreground state resource key and value do not match"
    );
  }
  return Object.freeze({ ...writer, statePath, logPath });
}

function validTerminalCapability(
  key: string,
  terminalControl: TerminalControlRef
): boolean {
  try {
    const pid = Number(
      terminalEndpointFromControlRef(terminalControl).processAnchorPid
    );
    return Number.isSafeInteger(pid) && pid > 1 &&
      sameTerminalControlIncarnation(terminalControl, terminalControl) &&
      key === terminalRuntimeResourceKey(terminalControl);
  } catch {
    return false;
  }
}

/**
 * An invocation-scoped terminal -> writer -> Turn-state capability.
 *
 * The service sees methods only: Store paths, terminal controls, lock handles,
 * scopes, and resources remain closed over by this adapter. Every repository
 * call repeats the live capability check, so retaining this object after the
 * transaction callback fails closed before I/O.
 */
class BoundDeferredForegroundApplicationScope implements
  DeferredForegroundApplicationScope {
  readonly #route: BoundDeferredRoute;
  readonly #assertActive: () => void;
  readonly #loadTransfer: (transferId: string) => DeferredForegroundTransfer;
  readonly #listTransfers: () => DeferredForegroundTransfer[];
  readonly #saveTransfer: TransferSave;
  readonly #loadSession: (sessionId: string) => ManagedSessionState;
  readonly #tryLoadSession: (
    sessionId: string
  ) => ManagedSessionState | undefined;
  readonly #saveSession: SessionSave;

  constructor(options: {
    route: BoundDeferredRoute;
    assertActive: () => void;
    loadTransfer: (transferId: string) => DeferredForegroundTransfer;
    listTransfers: () => DeferredForegroundTransfer[];
    saveTransfer: TransferSave;
    loadSession: (sessionId: string) => ManagedSessionState;
    tryLoadSession: (sessionId: string) => ManagedSessionState | undefined;
    saveSession: SessionSave;
  }) {
    this.#route = options.route;
    this.#assertActive = options.assertActive;
    this.#loadTransfer = options.loadTransfer;
    this.#listTransfers = options.listTransfers;
    this.#saveTransfer = options.saveTransfer;
    this.#loadSession = options.loadSession;
    this.#tryLoadSession = options.tryLoadSession;
    this.#saveSession = options.saveSession;
  }

  loadTransfer(transferId: string): DeferredForegroundTransfer {
    this.#assertActive();
    return this.#loadTransfer(transferId);
  }

  listTransfers(): DeferredForegroundTransfer[] {
    this.#assertActive();
    return this.#listTransfers();
  }

  saveTransfer(
    transfer: DeferredForegroundTransfer,
    expectedRevision: number | null
  ): DeferredForegroundTransfer {
    this.#assertActive();
    return this.#saveTransfer(transfer, expectedRevision);
  }

  loadSession(sessionId: string): ManagedSessionState {
    this.#assertActive();
    return this.#loadSession(sessionId);
  }

  tryLoadSession(sessionId: string): ManagedSessionState | undefined {
    this.#assertActive();
    return this.#tryLoadSession(sessionId);
  }

  saveSession(
    session: ManagedSessionState,
    expectedRevision: number | null
  ): ManagedSessionState {
    this.#assertActive();
    return this.#saveSession(session, expectedRevision);
  }

  assertBoundary(boundary: DeferredForegroundBindingBoundary): void {
    this.#assertActive();
    if (
      this.#route.terminalKey !== boundary.terminal.resourceKey ||
      !terminalControlEvidenceMatches(
        boundary.terminal.endpoint,
        this.#route.terminalControl
      )
    ) {
      throw new Error(
        "deferred foreground operation escaped its exact terminal capability"
      );
    }
  }

  transferBelongsToTurn(transfer: DeferredForegroundTransfer): boolean {
    this.#assertActive();
    return transfer.state_path === undefined || Boolean(
      this.#route.statePath &&
      path.resolve(transfer.state_path) === path.resolve(this.#route.statePath)
    );
  }

  transferMatchesTerminal(transfer: DeferredForegroundTransfer): boolean {
    this.#assertActive();
    return terminalControlEvidenceMatches(
      transfer.terminal_endpoint,
      this.#route.terminalControl
    );
  }

  terminalMatches(
    transfer: DeferredForegroundTransfer,
    boundary: DeferredForegroundBindingBoundary
  ): boolean {
    this.#assertActive();
    return transfer.process_pid === boundary.terminal.pid &&
      transfer.terminal_id === boundary.terminal.conversationId &&
      terminalControlEvidenceMatches(
        transfer.terminal_endpoint,
        this.#route.terminalControl
      );
  }

  withTurnStatePath(
    transfer: DeferredForegroundTransfer
  ): DeferredForegroundTransfer {
    this.#assertActive();
    if (!this.#route.statePath) {
      throw new Error(
        "deferred foreground Turn state requires an active state capability"
      );
    }
    return { ...transfer, state_path: this.#route.statePath };
  }

  sameInvocation(other: DeferredForegroundApplicationScope): boolean {
    this.#assertActive();
    if (!(other instanceof BoundDeferredForegroundApplicationScope)) {
      return false;
    }
    other.#assertActive();
    return this.#route.terminalKey === other.#route.terminalKey &&
      this.#route.storeDir === other.#route.storeDir &&
      this.#route.statePath === other.#route.statePath &&
      this.#route.logPath === other.#route.logPath &&
      sameTerminalControlIncarnation(
        this.#route.terminalControl,
        other.#route.terminalControl
      );
  }
}

export function bindDeferredForegroundApplicationScope(
  scopes: CanonicalStateMutationScopes,
  resources: CanonicalStateMutationResources
): DeferredForegroundApplicationScope {
  const route = bindTerminalStateRoute(scopes, resources);
  return new BoundDeferredForegroundApplicationScope({
    route,
    assertActive: () => assertTerminalWriterRouteActive(scopes, resources),
    loadTransfer: (transferId) => scopedTransferLoad(
      scopes,
      resources,
      transferId
    ),
    listTransfers: () => scopedTransferList(scopes, resources),
    saveTransfer: (transfer, expectedRevision) => scopedTransferSave(
      scopes,
      resources,
      transfer,
      expectedRevision
    ),
    loadSession: (sessionId) => scopedSessionLoad(
      scopes,
      resources,
      sessionId
    ),
    tryLoadSession: (sessionId) => scopedSessionTryLoad(
      scopes,
      resources,
      sessionId
    ),
    saveSession: (session, expectedRevision) => scopedSessionSave(
      scopes,
      resources,
      session,
      expectedRevision
    )
  });
}

export function bindDeferredForegroundWriterScope(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources
): DeferredForegroundApplicationScope {
  const route = bindTerminalWriterRoute(
    scopes,
    resources,
    resources.terminal.key,
    resources.storeWriter.key
  );
  return new BoundDeferredForegroundApplicationScope({
    route,
    assertActive: () => assertTerminalWriterRouteActive(scopes, resources),
    loadTransfer: (transferId) => scopedTransferLoad(
      scopes,
      resources,
      transferId
    ),
    listTransfers: () => scopedTransferList(scopes, resources),
    saveTransfer: (transfer, expectedRevision) => scopedTransferSave(
      scopes,
      resources,
      transfer,
      expectedRevision
    ),
    loadSession: (sessionId) => scopedSessionLoad(
      scopes,
      resources,
      sessionId
    ),
    tryLoadSession: (sessionId) => scopedSessionTryLoad(
      scopes,
      resources,
      sessionId
    ),
    saveSession: (session, expectedRevision) => scopedSessionSave(
      scopes,
      resources,
      session,
      expectedRevision
    )
  });
}

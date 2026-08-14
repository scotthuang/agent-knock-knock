import path from "node:path";

import type { Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  sameTerminalControlIncarnation,
  terminalEndpointFromControlRef,
  terminalRuntimeResourceKey
} from "./terminal-control-ref.js";
import type {
  CanonicalMutationResource,
  CanonicalMutationResources,
  CanonicalMutationScopes,
  CanonicalStateMutationResources,
  CanonicalStateMutationScopes
} from "./mutation-transaction.js";
import {
  canonicalMutationResource,
  capabilityGatedRepositoryOperation
} from
  "./mutation-transaction.js";
import type {
  TerminalDispatchApplicationPorts,
  TerminalDispatchAuditEvent
} from
  "./terminal-dispatch-application.js";
import type { TerminalDispatchLedgerDocument } from
  "./terminal-dispatch-ledger-codec.js";

export interface TerminalDispatchStateResource {
  statePath: string;
  logPath: string;
}

export interface BoundTerminalDispatchRoute {
  terminalControl: TerminalControlRef;
  terminalKey: string;
  storeDir: string;
  statePath: string;
  logPath: string;
}

export interface ExpectedTerminalDispatchRoute {
  terminalControl: TerminalControlRef;
  terminalKey: string;
  storeDir: string;
  statePath: string;
  logPath: string;
}

type ScopedOperation<Args extends readonly unknown[], Result> = (
  scopes: CanonicalStateMutationScopes,
  resources: CanonicalStateMutationResources,
  ...args: Args
) => Result;

export interface TerminalDispatchCapabilityRepositories {
  state: {
    save: ScopedOperation<[conversation: Conversation], void>;
  };
  ledger: {
    save: ScopedOperation<[
      ledger: TerminalDispatchLedgerDocument,
      phase?: "ordinary" | "final"
    ], void>;
    restore: ScopedOperation<[
      reason: string,
      terminalInputNotStartedAt?: string
    ], void>;
  };
  audit: {
    append: ScopedOperation<[event: TerminalDispatchAuditEvent], void>;
    appendPreparedMessage: ScopedOperation<[], void>;
  };
  rollbackBeforeInput: ScopedOperation<[], boolean>;
}

export interface TerminalDispatchLocalApplicationPorts {
  synchronizeStageProgress:
    TerminalDispatchApplicationPorts["synchronizeStageProgress"];
  audit: Pick<
    TerminalDispatchApplicationPorts["audit"],
    "log" | "recordBookkeepingFailure" | "recordPersistenceFailure"
  >;
}

const bindTerminal = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter", "state"] as const,
  "terminal",
  (terminalControl: TerminalControlRef) => terminalControl
);
const bindStore = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter", "state"] as const,
  "storeWriter",
  (storeDir: string) => storeDir
);
const bindTerminalWriterStore = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter"] as const,
  "storeWriter",
  (storeDir: string) => storeDir
);
const bindState = capabilityGatedRepositoryOperation(
  ["terminal", "storeWriter", "state"] as const,
  "state",
  (resource: TerminalDispatchStateResource) => resource
);

export function bindTerminalDispatchRoute(
  scopes: CanonicalStateMutationScopes,
  resources: CanonicalStateMutationResources
): BoundTerminalDispatchRoute {
  const terminalControl = bindTerminal(scopes, resources);
  const storeDir = bindStore(scopes, resources);
  const state = bindState(scopes, resources);
  if (
    typeof resources.terminal.key !== "string" ||
    resources.terminal.key.trim() === "" ||
    !terminalIncarnationMatches(terminalControl, terminalControl) ||
    !terminalResourceKeyMatches(resources.terminal.key, terminalControl)
  ) {
    throw new Error("terminal dispatch terminal resource is invalid");
  }
  if (typeof storeDir !== "string") {
    throw new Error("terminal dispatch Store resource is invalid");
  }
  const canonicalStoreDir = path.resolve(storeDir);
  if (
    storeDir !== canonicalStoreDir ||
    resources.storeWriter.key !== canonicalStoreDir
  ) {
    throw new Error(
      "terminal dispatch Store resource key and value do not match"
    );
  }
  if (
    typeof state?.statePath !== "string" ||
    typeof state?.logPath !== "string"
  ) {
    throw new Error("terminal dispatch state resource is invalid");
  }
  const canonicalState = terminalDispatchStateResourceForStore(
    canonicalStoreDir,
    state.statePath,
    state.logPath
  );
  if (
    resources.state.key !== canonicalState.key ||
    state.statePath !== canonicalState.value.statePath ||
    state.logPath !== canonicalState.value.logPath
  ) {
    throw new Error(
      "terminal dispatch state resource key and value do not match"
    );
  }
  return Object.freeze({
    terminalControl,
    terminalKey: resources.terminal.key,
    storeDir: canonicalStoreDir,
    statePath: canonicalState.value.statePath,
    logPath: canonicalState.value.logPath
  });
}

export function assertTerminalDispatchRouteMatches(
  route: BoundTerminalDispatchRoute,
  expected: ExpectedTerminalDispatchRoute
): void {
  const expectedState = terminalDispatchStateResourceForStore(
    expected.storeDir,
    expected.statePath,
    expected.logPath
  ).value;
  if (
    route.terminalKey !== expected.terminalKey ||
    !terminalIncarnationMatches(route.terminalControl, expected.terminalControl) ||
    route.storeDir !== path.resolve(expected.storeDir) ||
    route.statePath !== expectedState.statePath ||
    route.logPath !== expectedState.logPath
  ) {
    throw new Error(
      "terminal dispatch operation escaped its exact mutation route"
    );
  }
}

export function withExactTerminalDispatchRoute<Result>(
  route: BoundTerminalDispatchRoute,
  expected: ExpectedTerminalDispatchRoute,
  operation: (route: BoundTerminalDispatchRoute) => Result
): Result {
  assertTerminalDispatchRouteMatches(route, expected);
  return operation(route);
}

function terminalIncarnationMatches(
  active: TerminalControlRef,
  expected: TerminalControlRef
): boolean {
  try {
    const activePid = Number(
      terminalEndpointFromControlRef(active).processAnchorPid
    );
    const expectedPid = Number(
      terminalEndpointFromControlRef(expected).processAnchorPid
    );
    return Number.isSafeInteger(activePid) && activePid > 1 &&
      Number.isSafeInteger(expectedPid) && expectedPid > 1 &&
      sameTerminalControlIncarnation(active, expected);
  } catch {
    return false;
  }
}

function terminalResourceKeyMatches(
  key: string,
  terminalControl: TerminalControlRef
): boolean {
  try {
    return key === terminalRuntimeResourceKey(terminalControl);
  } catch {
    return false;
  }
}

export function terminalDispatchStateMutationResource(
  scopes: CanonicalMutationScopes,
  resources: CanonicalMutationResources,
  statePath: string,
  logPath: string
): CanonicalMutationResource<TerminalDispatchStateResource> {
  const storeDir = bindTerminalWriterStore(scopes, resources);
  if (typeof storeDir !== "string") {
    throw new Error("terminal dispatch Store resource is invalid");
  }
  const canonicalStoreDir = path.resolve(storeDir);
  if (
    storeDir !== canonicalStoreDir ||
    resources.storeWriter.key !== canonicalStoreDir
  ) {
    throw new Error("terminal dispatch Store resource is not canonical");
  }
  return terminalDispatchStateResourceForStore(
    canonicalStoreDir, statePath, logPath
  );
}

export function terminalDispatchStateResourceForStore(
  storeDir: string,
  statePath: string,
  logPath: string
): CanonicalMutationResource<TerminalDispatchStateResource> {
  const canonicalStoreDir = path.resolve(storeDir);
  const canonicalStatePath = path.resolve(statePath);
  const conversationDir = path.dirname(canonicalStatePath);
  if (
    path.basename(canonicalStatePath) !== "state.json" ||
    path.dirname(conversationDir) !==
      path.join(canonicalStoreDir, "conversations")
  ) {
    throw new Error(
      "terminal dispatch state does not belong to the active Store"
    );
  }
  const canonicalLogPath = path.resolve(logPath);
  if (canonicalLogPath !== path.join(conversationDir, "events.ndjson")) {
    throw new Error(
      "terminal dispatch event log does not match its conversation state"
    );
  }
  const route = Object.freeze({
    statePath: canonicalStatePath,
    logPath: canonicalLogPath
  });
  return canonicalMutationResource(canonicalStatePath, route);
}

export function terminalDispatchStateLockPath(
  resource: CanonicalMutationResource<TerminalDispatchStateResource>
): string {
  return `${resource.value.statePath}.lock`;
}

export function bindTerminalDispatchCapabilities({
  scopes,
  resources,
  repositories,
  local
}: {
  scopes: CanonicalStateMutationScopes;
  resources: CanonicalStateMutationResources;
  repositories: TerminalDispatchCapabilityRepositories;
  local: TerminalDispatchLocalApplicationPorts;
}): {
  applicationPorts: TerminalDispatchApplicationPorts;
} {
  bindTerminalDispatchRoute(scopes, resources);
  return {
    applicationPorts: {
      synchronizeStageProgress: local.synchronizeStageProgress,
      state: {
        save: (conversation) => repositories.state.save(
          scopes,
          resources,
          conversation
        )
      },
      ledger: {
        save: (ledger, phase) => repositories.ledger.save(
          scopes,
          resources,
          ledger,
          phase
        ),
        restore: (reason, at) => repositories.ledger.restore(
          scopes,
          resources,
          reason,
          at
        )
      },
      audit: {
        append: (event) => repositories.audit.append(
          scopes,
          resources,
          event
        ),
        appendPreparedMessage: () => repositories.audit.appendPreparedMessage(
          scopes,
          resources
        ),
        ...local.audit
      },
      rollbackBeforeInput: () => repositories.rollbackBeforeInput(
        scopes,
        resources
      )
    }
  };
}

// CLI composition for delegate discovery and exact idempotent replay routing.
import { createHash } from "node:crypto";

import {
  executorDefinitionForKind,
  type ExecutorKind,
  resolveExecutor
} from "./executors.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  TerminalCommandCliFacade,
  TerminalCommandCliOptions
} from "./terminal-command-cli-adapter.js";
import type {
  TerminalListCliFacade,
  TerminalListCliOptions
} from "./terminal-list-cli-adapter.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import {
  TerminalDelegateSendBindingUncertainError,
  type TerminalDelegateSendBinding,
  type TerminalDelegateSendBindingRepository,
  type TerminalDelegateSendRequestBoundary
} from "./terminal-delegate-send-binding.js";
/*
 * This adapter deliberately has no Store/Turn/Session port. Omitted-target
 * Send resolves only current physical terminal authority.
 */
import { isRecord, nonBlankString as stringValue } from
  "./value-guards.js";

export interface TerminalDelegateCliOptions
  extends TerminalCommandCliOptions, TerminalListCliOptions {
  request?: string;
}

type DelegateTerminalCandidate = Awaited<ReturnType<
  TerminalListCliFacade["buildTerminalListGroup"]
>>["terminalControlled"][number];

interface DelegateRuntimePorts {
  canonicalWorkspace(value: unknown): string;
  required<Value>(value: Value | undefined, message: string): Value;
  terminalRuntimeKey(terminalControl: TerminalControlRef): string;
}

export interface TerminalDelegateCliDependencies {
  runtime: DelegateRuntimePorts;
  terminalList: Pick<
    TerminalListCliFacade,
    "buildTerminalListGroup" | "observeExactTerminal"
  >;
  sendBinding: TerminalDelegateSendBindingRepository;
  terminalCommand: Pick<TerminalCommandCliFacade, "runSend">;
}

export interface TerminalDelegateCliFacade {
  runDelegate(options: TerminalDelegateCliOptions): Promise<void>;
}

interface DelegateRouteRequest {
  options: TerminalDelegateCliOptions;
  request: string;
  workspace?: string;
  requestedAgent?: ExecutorKind;
}

interface DelegateUserExplicitSendCandidate {
  terminal: DelegateTerminalCandidate;
  expectedTerminalToken: string;
  expectedManagedTerminalToken?: string;
  routingWarning?: string;
}

interface DelegatePhysicalSendRoute {
  terminalId: string;
  workspace: string;
  terminalRuntimeKey: string;
  expectedTerminalToken: string;
  expectedManagedTerminalToken?: string;
  routingWarning?: string;
}

function assertSingleDelegateCandidate(
  candidates: DelegateUserExplicitSendCandidate[],
  scopedCount: number,
  workspace: string | undefined,
  requestedAgent: ExecutorKind | undefined
): DelegateUserExplicitSendCandidate {
  if (candidates.length === 0) {
    const observed = scopedCount > 0
      ? ` Found ${scopedCount} matching pane(s), but none has a safe mutable composer.`
      : "";
    const requestedExecutor = requestedAgent
      ? executorDefinitionForKind(requestedAgent)
      : undefined;
    const workspaceDetail = workspace ? ` in ${workspace}` : "";
    throw new Error(
      `No send-ready ${requestedExecutor?.displayName ?? "Codex or Claude Code"} pane is available${workspaceDetail}.${observed} ` +
      `Start ${requestedAgent ?? "codex or claude"} inside tmux or Herdr${workspaceDetail}, wait for a stable Codex composer or an exact empty Claude composer with no approval prompt, then retry.`
    );
  }
  if (candidates.length > 1) {
    const rendered = candidates.map(({ terminal: candidate }) => {
      const identity =
        `${candidate.agent}, ${candidate.terminal_control?.target ?? candidate.id}`;
      return workspace
        ? `${candidate.short_ref} (${identity})`
        : `${candidate.short_ref} (${identity}, ${candidate.workspace ?? "workspace unknown"})`;
    }).join(", ");
    const scope = requestedAgent
      ? executorDefinitionForKind(requestedAgent).displayName
      : "coding-agent";
    const ambiguity = workspace
      ? `match ${workspace}`
      : "are available across workspaces";
    throw new Error(
      `Multiple send-ready ${scope} panes ${ambiguity}: ${rendered}. ` +
      "Use /akk codex: <task>, /akk claude: <task>, or /akk @short-ref: <message> to choose one explicitly."
    );
  }
  return candidates[0];
}

function delegateUserExplicitSendCandidate(
  terminal: DelegateTerminalCandidate
): DelegateUserExplicitSendCandidate | undefined {
  const action = isRecord(terminal._terminal_user_explicit_send_action)
    ? terminal._terminal_user_explicit_send_action
    : isRecord(terminal.available_actions) &&
        isRecord(terminal.available_actions.send)
      ? terminal.available_actions.send
      : undefined;
  const argumentsValue = isRecord(action?.arguments)
    ? action.arguments
    : undefined;
  const terminalId = stringValue(terminal.id);
  const expectedTerminalToken = stringValue(
    argumentsValue?.expected_terminal_token
  );
  if (
    action?.scope !== "terminal_user_explicit" ||
    !terminalId ||
    stringValue(
      argumentsValue?.selector ?? argumentsValue?.terminal_id
    ) !== terminalId ||
    !expectedTerminalToken
  ) {
    return undefined;
  }
  return {
    terminal,
    expectedTerminalToken,
    expectedManagedTerminalToken: stringValue(
      argumentsValue?.expected_managed_terminal_token
    )
  };
}

function samePhysicalDelegateAuthority(
  candidate: DelegateUserExplicitSendCandidate,
  terminalId: string,
  expectedTerminalToken: string
): boolean {
  return stringValue(candidate.terminal.id) === terminalId &&
    candidate.expectedTerminalToken === expectedTerminalToken;
}

async function discoverDelegatePhysicalRoute(
  dependencies: TerminalDelegateCliDependencies,
  input: {
    options: TerminalDelegateCliOptions;
    workspace?: string;
    requestedAgent?: ExecutorKind;
  }
): Promise<DelegatePhysicalSendRoute> {
  const { options, workspace, requestedAgent } = input;
  const scan = await dependencies.terminalList.buildTerminalListGroup({
    options: { ...options, workspace, noApprovalScan: false },
    agentFilter: requestedAgent,
    statusFilter: undefined
  });
  if (scan.summary.error) {
    throw new Error(`terminal discovery failed: ${scan.summary.error}`);
  }
  const scopedCandidates = workspace === undefined
    ? scan.terminalControlled
    : scan.terminalControlled.filter((candidate) => {
        try {
          return dependencies.runtime.canonicalWorkspace(candidate.workspace) ===
            workspace;
        } catch {
          return false;
        }
      });
  const eligible = scopedCandidates.flatMap((candidate) => {
    const authority = delegateUserExplicitSendCandidate(candidate);
    return authority ? [authority] : [];
  });
  const selected = assertSingleDelegateCandidate(
    eligible,
    scopedCandidates.length,
    workspace,
    requestedAgent
  );
  const selectedTerminalId = dependencies.runtime.required(
    stringValue(selected.terminal.id),
    "selected terminal id is unavailable"
  );
  const terminalControl = isRecord(selected.terminal.terminal_control)
    ? selected.terminal.terminal_control as unknown as TerminalControlRef
    : undefined;
  if (!terminalControl) {
    throw new Error("selected terminal physical control is unavailable");
  }
  let expectedManagedTerminalToken =
    selected.expectedManagedTerminalToken;
  try {
    const observed = await dependencies.terminalList.observeExactTerminal({
      options: { ...options, workspace, noApprovalScan: false },
      terminalId: selectedTerminalId
    });
    const projectedAuthority = observed.state === "available"
      ? delegateUserExplicitSendCandidate(observed.terminal)
      : undefined;
    if (
      projectedAuthority &&
      samePhysicalDelegateAuthority(
        projectedAuthority,
        selectedTerminalId,
        selected.expectedTerminalToken
      )
    ) {
      expectedManagedTerminalToken =
        projectedAuthority.expectedManagedTerminalToken;
    }
  } catch {
    // Managed fast-path discovery is optional. The raw physical action was
    // already observed from this exact scan and execution revalidates it.
  }
  return {
    terminalId: selectedTerminalId,
    workspace: dependencies.runtime.canonicalWorkspace(
      selected.terminal.workspace
    ),
    terminalRuntimeKey: dependencies.runtime.terminalRuntimeKey(
      terminalControl
    ),
    expectedTerminalToken: selected.expectedTerminalToken,
    ...(expectedManagedTerminalToken
      ? { expectedManagedTerminalToken }
      : {})
  };
}

function delegateSendRequestBoundary(
  input: DelegateRouteRequest & { messageId: string }
): TerminalDelegateSendRequestBoundary {
  return {
    messageId: input.messageId,
    requestHash: createHash("sha256")
      .update(terminalSubmissionPayload(input.request))
      .digest("hex"),
    ...(input.workspace === undefined
      ? {}
      : { requestedWorkspace: input.workspace }),
    ...(input.requestedAgent === undefined
      ? {}
      : { requestedAgent: input.requestedAgent }),
    ...(stringValue(input.options.openclawSession) === undefined
      ? {}
      : { openclawSession: stringValue(input.options.openclawSession) })
  };
}

async function routeForDelegateBinding(
  dependencies: TerminalDelegateCliDependencies,
  options: TerminalDelegateCliOptions,
  binding: TerminalDelegateSendBinding
): Promise<DelegatePhysicalSendRoute> {
  let expectedManagedTerminalToken: string | undefined;
  try {
    const observed = await dependencies.terminalList.observeExactTerminal({
      options: {
        ...options,
        workspace: binding.workspace,
        noApprovalScan: false
      },
      terminalId: binding.terminalId
    });
    const projectedAuthority = observed.state === "available"
      ? delegateUserExplicitSendCandidate(observed.terminal)
      : undefined;
    if (
      projectedAuthority &&
      samePhysicalDelegateAuthority(
        projectedAuthority,
        binding.terminalId,
        binding.physicalToken
      )
    ) {
      expectedManagedTerminalToken =
        projectedAuthority.expectedManagedTerminalToken;
    }
  } catch {
    // The immutable physical binding remains authoritative. runSend performs
    // the fresh process, approval, and empty-composer checks before any input.
  }
  return {
    terminalId: binding.terminalId,
    workspace: binding.workspace,
    terminalRuntimeKey: binding.terminalRuntimeKey,
    expectedTerminalToken: binding.physicalToken,
    ...(expectedManagedTerminalToken
      ? { expectedManagedTerminalToken }
      : {})
  };
}

async function resolveDelegateSendRoute(
  dependencies: TerminalDelegateCliDependencies,
  input: DelegateRouteRequest
): Promise<DelegatePhysicalSendRoute> {
  const messageId = stringValue(input.options.messageId);
  if (!messageId) {
    return discoverDelegatePhysicalRoute(dependencies, input);
  }
  const boundary = delegateSendRequestBoundary({
    ...input,
    messageId
  });
  let releaseBindingLock: (() => void) | undefined;
  let discoveredRoute: DelegatePhysicalSendRoute | undefined;
  let resolvedRoute: DelegatePhysicalSendRoute | undefined;
  try {
    const existingBinding = dependencies.sendBinding.load(boundary);
    if (existingBinding) {
      return routeForDelegateBinding(
        dependencies,
        input.options,
        existingBinding
      );
    }
    releaseBindingLock = dependencies.sendBinding.acquire(messageId);
    let concurrentBinding = dependencies.sendBinding.load(boundary);
    if (!concurrentBinding) {
      discoveredRoute = await discoverDelegatePhysicalRoute(
        dependencies,
        input
      );
      concurrentBinding = dependencies.sendBinding.bind(boundary, {
        terminalId: discoveredRoute.terminalId,
        workspace: discoveredRoute.workspace,
        terminalRuntimeKey: discoveredRoute.terminalRuntimeKey,
        physicalToken: discoveredRoute.expectedTerminalToken
      }).binding;
    }
    const binding = dependencies.runtime.required(
      concurrentBinding,
      "terminal delegate send binding is unavailable"
    );
    if (
      discoveredRoute &&
      discoveredRoute.terminalId === binding.terminalId &&
      discoveredRoute.expectedTerminalToken === binding.physicalToken
    ) {
      resolvedRoute = discoveredRoute;
    } else {
      resolvedRoute = await routeForDelegateBinding(
        dependencies,
        input.options,
        binding
      );
    }
  } catch (error) {
    if (
      !(error instanceof TerminalDelegateSendBindingUncertainError) ||
      error.possibleExistingBinding
    ) {
      throw error;
    }
    const route = discoveredRoute ?? await discoverDelegatePhysicalRoute(
      dependencies,
      input
    );
    resolvedRoute = {
      ...route,
      routingWarning:
        `durable omitted-target routing was unavailable: ${error.message}`
    };
  } finally {
    try {
      releaseBindingLock?.();
    } catch (error) {
      if (resolvedRoute) {
        const warning = `durable omitted-target routing lock cleanup failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        resolvedRoute = {
          ...resolvedRoute,
          routingWarning: resolvedRoute.routingWarning
            ? `${resolvedRoute.routingWarning}; ${warning}`
            : warning
        };
      }
      // A failed unlock cannot veto a route already selected before input.
    }
  }
  return dependencies.runtime.required(
    resolvedRoute,
    "terminal delegate physical Send route is unavailable"
  );
}

async function sendDelegatePhysicalRoute(
  dependencies: TerminalDelegateCliDependencies,
  options: TerminalDelegateCliOptions,
  request: string,
  route: DelegatePhysicalSendRoute
): Promise<void> {
  await dependencies.terminalCommand.runSend({
    ...options,
    conversation: route.terminalId,
    message: request,
    workspace: route.workspace,
    background: true,
    expectedTerminalToken: route.expectedTerminalToken,
    ...(route.routingWarning
      ? { terminalUserSendRoutingWarning: route.routingWarning }
      : {}),
    ...(route.expectedManagedTerminalToken
      ? {
          expectedManagedTerminalToken: route.expectedManagedTerminalToken
        }
      : {})
  });
}

function createRunDelegate(dependencies: TerminalDelegateCliDependencies) {
  return async (options: TerminalDelegateCliOptions): Promise<void> => {
    const request = dependencies.runtime.required(
      options.request,
      "--request is required"
    );
    const workspace = options.workspace === undefined
      ? undefined
      : dependencies.runtime.canonicalWorkspace(options.workspace);
    const requestedAgent = options.agent === undefined
      ? undefined
      : resolveExecutor({ kind: options.agent }).kind;
    const resolved = await resolveDelegateSendRoute(dependencies, {
      options,
      request,
      workspace,
      requestedAgent
    });
    await sendDelegatePhysicalRoute(
      dependencies,
      options,
      request,
      resolved
    );
  };
}

export function createTerminalDelegateCliFacade(
  dependencies: TerminalDelegateCliDependencies
): TerminalDelegateCliFacade {
  return Object.freeze({ runDelegate: createRunDelegate(dependencies) });
}

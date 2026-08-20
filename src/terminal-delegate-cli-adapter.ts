// CLI composition for delegate discovery and exact idempotent replay routing.
import { createHash } from "node:crypto";
import path from "node:path";

import {
  executorDefinitionForKind,
  type ExecutorKind,
  resolveExecutor
} from "./executors.js";
import type { ManagedSessionState } from "./managed-session.js";
import { executorForConversation, type Conversation } from "./protocol.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import type {
  TerminalCommandCliFacade,
  TerminalCommandCliOptions
} from "./terminal-command-cli-adapter.js";
import type {
  TerminalListCliFacade,
  TerminalListCliOptions
} from "./terminal-list-cli-adapter.js";
import { isCompleteNativeRollout, terminalControlsShareIncarnation } from
  "./terminal-authority-policy.js";
import { terminalBridgeRequestFingerprint, terminalBridgeSubmissionReceipts }
  from "./terminal-dispatch-receipt.js";
import { terminalSubmissionPayload } from "./terminal-dispatch-execution.js";
import { terminalControlFromTakeover } from "./terminal-runtime-cli-adapter.js";
import type { TranscriptEvent } from "./transcript.js";
import { isRecord, nonBlankString as stringValue, type UnknownRecord } from
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
  storeDir(options: TerminalDelegateCliOptions): string;
}

interface DelegateRepositoryPorts {
  listConversations(storeDir: string): Conversation[];
  readEvents(logPath: string): TranscriptEvent[];
  storeDirForConversation(conversation: Conversation): string | undefined;
}

interface DelegateAuthorityPorts {
  assertSafeAbortedTerminalRetryBinding(request: {
    owner: Conversation;
    receipt: UnknownRecord;
    storeDir: string;
    terminalControl: TerminalControlRef;
    messageId: string;
  }): ManagedSessionState | undefined;
}

export interface TerminalDelegateCliDependencies {
  runtime: DelegateRuntimePorts;
  repository: DelegateRepositoryPorts;
  authority: DelegateAuthorityPorts;
  terminalList: Pick<
    TerminalListCliFacade,
    "buildTerminalListGroup" | "terminalDispatchOwnership"
  >;
  terminalCommand: Pick<TerminalCommandCliFacade, "runSend">;
}

export interface TerminalDelegateCliFacade {
  runDelegate(options: TerminalDelegateCliOptions): Promise<void>;
}

type StableDelegateTerminalRoute =
  | { kind: "terminal"; conversationId: string; workspace: string }
  | { kind: "session"; sessionId: string; workspace: string };

interface RoutedDelegateReceipt {
  owner: Conversation;
  receipt: UnknownRecord;
  conversationId: string;
  workspace: string;
  terminalControl: TerminalControlRef;
}

interface StableRouteRequest {
  options: TerminalDelegateCliOptions;
  request: string;
  workspace?: string;
  requestedAgent?: ExecutorKind;
}

function delegateEventMessage(
  dependencies: TerminalDelegateCliDependencies,
  owner: Conversation,
  messageId: string
): UnknownRecord | undefined {
  const eventLogPath = stringValue(owner.event_log_path);
  if (!eventLogPath) {
    return undefined;
  }
  let matches: UnknownRecord[];
  try {
    matches = dependencies.repository.readEvents(eventLogPath)
      .filter((event) =>
        isRecord(event.message) && event.message.id === messageId
      )
      .map((event) => event.message as UnknownRecord);
  } catch {
    matches = [];
  }
  if (matches.length > 1) {
    throw new Error(`terminal idempotency key ${messageId} has duplicate durable messages`);
  }
  return matches[0];
}

function routedDelegateReceipt(
  dependencies: TerminalDelegateCliDependencies,
  boundary: StableRouteRequest & {
    storeDir: string;
    requestHash?: string;
    bodyHash: string;
    requestedOpenClawSession?: string;
    messageId: string;
  },
  owner: Conversation,
  receipt: UnknownRecord
): RoutedDelegateReceipt {
  const ownerStoreDir = dependencies.repository.storeDirForConversation(owner);
  const takeover = isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  const terminalControl = terminalControlFromTakeover(takeover);
  const conversationId = stringValue(takeover?.native_session_id);
  const eventMessage = delegateEventMessage(dependencies, owner, boundary.messageId);
  const messageType = stringValue(receipt.message_type) ??
    (isRecord(eventMessage) ? stringValue(eventMessage.type) : undefined);
  const storedBodyHash = stringValue(receipt.message_body_hash) ??
    (isRecord(eventMessage) && typeof eventMessage.body === "string"
      ? createHash("sha256").update(eventMessage.body).digest("hex")
      : undefined);
  const ownerWorkspace = dependencies.runtime.canonicalWorkspace(owner.workspace);
  if (
    !ownerStoreDir ||
    path.resolve(ownerStoreDir) !== boundary.storeDir ||
    (stringValue(receipt.store_dir) !== undefined &&
      path.resolve(String(receipt.store_dir)) !== boundary.storeDir) ||
    !terminalControl ||
    !conversationId ||
    stringValue(receipt.request_hash) !== boundary.requestHash ||
    messageType !== "task" ||
    storedBodyHash !== boundary.bodyHash ||
    (boundary.requestedOpenClawSession &&
      (stringValue(receipt.openclaw_session) ?? owner.openclaw_session) !==
        boundary.requestedOpenClawSession) ||
    (boundary.requestedAgent &&
      executorForConversation(owner).kind !== boundary.requestedAgent) ||
    (boundary.workspace && ownerWorkspace !== boundary.workspace)
  ) {
    throw new Error(
      `terminal idempotency key ${boundary.messageId} does not match its ` +
      "original delegate request boundary; no terminal input was sent"
    );
  }
  return { owner, receipt, conversationId, workspace: ownerWorkspace,
    terminalControl };
}

function selectedStableDelegateRoute(
  dependencies: TerminalDelegateCliDependencies,
  routed: RoutedDelegateReceipt[],
  storeDir: string,
  messageId: string
): StableDelegateTerminalRoute | undefined {
  const authoritative = routed.filter(({ receipt }) =>
    !(receipt.status === "aborted" && receipt.safe_to_retry === true)
  );
  if (authoritative.length > 1) {
    throw new Error(
      `terminal idempotency key ${messageId} has multiple durable delegate receipts`);
  }
  const firstRoute = routed[0];
  if (
    !firstRoute ||
    routed.some((entry) =>
      entry.conversationId !== firstRoute.conversationId ||
      !terminalControlsShareIncarnation(
        entry.terminalControl,
        firstRoute.terminalControl
      )
    )
  ) {
    throw new Error(
      `terminal idempotency key ${messageId} has conflicting terminal routes`);
  }
  const selected = authoritative[0] ?? routed.at(-1);
  if (!selected) {
    return undefined;
  }
  if (
    selected.receipt.status === "aborted" &&
    selected.receipt.safe_to_retry === true
  ) {
    const ownerControl = terminalControlFromTakeover(
      isRecord(selected.owner.native_session_takeover)
        ? selected.owner.native_session_takeover
        : undefined
    );
    if (!ownerControl) {
      throw new Error(
        `terminal idempotency key ${messageId} has no durable terminal route`);
    }
    const retrySession =
      dependencies.authority.assertSafeAbortedTerminalRetryBinding({
        owner: selected.owner,
        receipt: selected.receipt,
        storeDir,
        terminalControl: ownerControl,
        messageId
      });
    if (!retrySession) {
      throw new Error(
        `terminal idempotency key ${messageId} has no restored retry Session`);
    }
    if (
      retrySession.agent === "codex" &&
      isCompleteNativeRollout(retrySession.binding?.native_process.rollout)
    ) {
      // An unchanged safe-aborted binding still does not prove the Codex TUI
      // foreground. Keep the terminal route so runSend captures fresh
      // candidate authority and uses the v3 transfer instead of strict Session.
      return { kind: "terminal", conversationId: selected.conversationId,
        workspace: selected.workspace };
    }
    return { kind: "session", sessionId: retrySession.session_id,
      workspace: selected.workspace };
  }
  return { kind: "terminal", conversationId: selected.conversationId,
    workspace: selected.workspace };
}

function stableDelegateTerminalRoute(
  dependencies: TerminalDelegateCliDependencies,
  boundary: StableRouteRequest
): StableDelegateTerminalRoute | undefined {
  const messageId = stringValue(boundary.options.messageId);
  if (!messageId) {
    return undefined;
  }
  const storeDir = path.resolve(dependencies.runtime.storeDir(boundary.options));
  const requestHash = terminalBridgeRequestFingerprint(
    terminalSubmissionPayload(boundary.request)
  );
  const bodyHash = createHash("sha256").update(boundary.request).digest("hex");
  const requestedOpenClawSession =
    stringValue(boundary.options.openclawSession);
  const matches = dependencies.repository.listConversations(storeDir)
    .flatMap((owner) => terminalBridgeSubmissionReceipts(owner)
      .filter((receipt) => stringValue(receipt.message_id) === messageId)
      .map((receipt) => ({ owner, receipt })));
  if (matches.length === 0) {
    return undefined;
  }
  const routed = matches.map(({ owner, receipt }) => routedDelegateReceipt(
    dependencies, { ...boundary, storeDir, requestHash, bodyHash,
      requestedOpenClawSession, messageId }, owner, receipt));
  return selectedStableDelegateRoute(dependencies, routed, storeDir, messageId);
}

function assertSingleDelegateCandidate(
  candidates: DelegateTerminalCandidate[],
  scopedCount: number,
  workspace: string | undefined,
  requestedAgent: ExecutorKind | undefined
): DelegateTerminalCandidate {
  if (candidates.length === 0) {
    const observed = scopedCount > 0
      ? ` Found ${scopedCount} matching pane(s), but none is idle.`
      : "";
    const requestedExecutor = requestedAgent
      ? executorDefinitionForKind(requestedAgent)
      : undefined;
    const workspaceDetail = workspace ? ` in ${workspace}` : "";
    throw new Error(
      `No idle ${requestedExecutor?.displayName ?? "Codex or Claude Code"} pane is available${workspaceDetail}.${observed} ` +
      `Start ${requestedAgent ?? "codex or claude"} inside tmux or Herdr${workspaceDetail}, wait until it is idle, then retry.`
    );
  }
  if (candidates.length > 1) {
    const rendered = candidates.map((candidate) => {
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
      `Multiple idle ${scope} panes ${ambiguity}: ${rendered}. ` +
      "Use /akk codex: <task>, /akk claude: <task>, or /akk @short-ref: <message> to choose one explicitly."
    );
  }
  return candidates[0];
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
    const stableRoute = stableDelegateTerminalRoute(dependencies, {
      options,
      request,
      workspace,
      requestedAgent
    });
    if (stableRoute) {
      await dependencies.terminalCommand.runSend(stableRoute.kind === "session"
        ? {
            ...options,
            session: stableRoute.sessionId,
            conversation: undefined,
            message: request,
            workspace: stableRoute.workspace,
            background: true
          }
        : {
            ...options,
            conversation: stableRoute.conversationId,
            session: undefined,
            message: request,
            workspace: stableRoute.workspace,
            background: true
          });
      return;
    }
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
    const eligible = scopedCandidates.filter((candidate) => {
      if (candidate.activity_state !== "idle") {
        return false;
      }
      const terminalControl = isRecord(candidate.terminal_control)
        ? candidate.terminal_control as unknown as TerminalControlRef
        : undefined;
      return !terminalControl ||
        dependencies.terminalList.terminalDispatchOwnership(terminalControl)
          .state === "none";
    });
    const selected = assertSingleDelegateCandidate(
      eligible,
      scopedCandidates.length,
      workspace,
      requestedAgent
    );
    const selectedWorkspace =
      dependencies.runtime.canonicalWorkspace(selected.workspace);
    await dependencies.terminalCommand.runSend({
      ...options,
      conversation: selected.id,
      message: request,
      workspace: selectedWorkspace,
      background: true
    });
  };
}

export function createTerminalDelegateCliFacade(
  dependencies: TerminalDelegateCliDependencies
): TerminalDelegateCliFacade {
  return Object.freeze({ runDelegate: createRunDelegate(dependencies) });
}

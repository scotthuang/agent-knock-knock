import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { supersedeUnacceptedCallbackDeliveries } from
  "./callback-outbox-policy.js";
import {
  isSessionSendBlockingStatus,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  appendExplicitUserCloseEvent,
  defaultStoreDir,
  ensureDir,
  listConversations,
  loadState,
  pathsForConversation,
  saveExplicitUserCloseState,
  withStoreWriterLeaseAsync
} from "./store.js";
import {
  managedSessionBindingToken,
  managedSessionRevision,
  unmanagedTerminalBindingToken,
  type ManagedSessionState
} from "./managed-session.js";
import {
  listManagedSessions,
  saveManagedSession
} from "./session-store.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  TerminalInputNotStartedError,
  type TerminalAgentBridge
} from "./terminal-agent-bridge.js";
import {
  terminalControlAliasMatches,
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import {
  terminalDispatchLedgerLooksLifecycle,
  type TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";
import { assertSafeUserExplicitTerminalSend } from
  "./terminal-command-send-preflight.js";
import type { TerminalControlSendResult } from
  "./terminal-command-dispatch-transport.js";
import { cleanupDeferredForegroundUserClose } from
  "./deferred-foreground-user-close.js";
import { terminalSubmissionPayload } from
  "./terminal-dispatch-execution.js";
import {
  createTerminalUserSendIntentRepository,
  TerminalUserSendIntentBoundaryConflictError,
  TerminalUserSendIntentUncertainError,
  type TerminalUserSendDeliveryMode,
  type TerminalUserSendIntentBoundary
} from "./terminal-user-send-intent.js";
import type {
  PreparedUserExplicitFallbackWatch,
  UserExplicitFallbackWatchReceipt
} from "./terminal-watch-cli-adapter.js";
import { terminalUserExplicitFallbackWatchId } from
  "./terminal-watch-store.js";
import { terminalSendResultContract } from
  "./terminal-dispatch-presenter.js";
import { expandHome } from "./cli-command-runtime.js";
import {
  type TerminalCommandCliOptions,
  type TerminalCommandPortView,
  type TerminalCommandTarget
} from "./terminal-command-cli-ports.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export type TerminalHumanExplicitSendCliPorts = TerminalCommandPortView<
  | "acquireFileLock"
  | "acquireTerminalBridgeSendLock"
  | "assertExpectedHandoffTokenUsesExactTerminalSelector"
  | "attachUserExplicitFallbackWatch"
  | "createTerminalAgentBridge"
  | "loadTerminalBridgeDispatchLedger"
  | "loadTerminalDispatchLedgerOwner"
  | "prepareUserExplicitFallbackWatch"
  | "processIncarnationForPid"
  | "required"
  | "resolveTerminalBridgeDispatchLedger"
  | "storeDirFromOptions"
  | "terminalBridgeRuntimeKey"
  | "terminalControlFromTakeover"
  | "terminalDispatchRecordMatchesControl"
  | "terminalRuntimeForLiveIdentity"
  | "textSummary"
  | "userExplicitFallbackWatchReceipt"
>;

export interface TerminalHumanExplicitSendRuntime {
  env(): NodeJS.ProcessEnv;
  now(): Date;
  log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>
  ): void;
  printJson(value: unknown): void;
  durableTerminalInputDispatched(conversation: Conversation): boolean;
}

export interface TerminalHumanExplicitManagedAttempt {
  terminalControlSendInvoked: boolean;
  result?: TerminalControlSendResult;
}

export interface TerminalHumanExplicitSendDependencies {
  ports: TerminalHumanExplicitSendCliPorts;
  runtime: TerminalHumanExplicitSendRuntime;
  managedSendAttempt(
    options: Record<string, any>,
    messageBody: string,
    terminal: TerminalCommandTarget,
    deferZeroInputFailurePresentation: boolean,
    attempt: TerminalHumanExplicitManagedAttempt
  ): Promise<TerminalControlSendResult>;
}

const humanExplicitSendContext =
  new AsyncLocalStorage<TerminalHumanExplicitSendDependencies>();

function humanExplicitSendRuntime(): TerminalHumanExplicitSendDependencies {
  const runtime = humanExplicitSendContext.getStore();
  if (!runtime) {
    throw new Error("Terminal human-explicit Send runtime is unavailable");
  }
  return runtime;
}

type HumanExplicitSendFunctionPortName = {
  [Name in keyof TerminalHumanExplicitSendCliPorts]:
    TerminalHumanExplicitSendCliPorts[Name] extends
      (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalHumanExplicitSendCliPorts];

function rawPort<Name extends HumanExplicitSendFunctionPortName>(
  name: Name
): TerminalHumanExplicitSendCliPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = humanExplicitSendRuntime().ports[name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalHumanExplicitSendCliPorts[Name];
}

const acquireFileLock = rawPort("acquireFileLock");
const acquireTerminalBridgeSendLock = rawPort("acquireTerminalBridgeSendLock");
const assertExpectedHandoffTokenUsesExactTerminalSelector =
  rawPort("assertExpectedHandoffTokenUsesExactTerminalSelector");
const attachUserExplicitFallbackWatch =
  rawPort("attachUserExplicitFallbackWatch");
const createTerminalAgentBridge = rawPort("createTerminalAgentBridge");
const loadTerminalBridgeDispatchLedger =
  rawPort("loadTerminalBridgeDispatchLedger");
const loadTerminalDispatchLedgerOwner =
  rawPort("loadTerminalDispatchLedgerOwner");
const prepareUserExplicitFallbackWatch =
  rawPort("prepareUserExplicitFallbackWatch");
const processIncarnationForPid = rawPort("processIncarnationForPid");
const required = rawPort("required");
const resolveTerminalBridgeDispatchLedger =
  rawPort("resolveTerminalBridgeDispatchLedger");
const storeDirFromOptions = rawPort("storeDirFromOptions");
const terminalBridgeRuntimeKey = rawPort("terminalBridgeRuntimeKey");
const terminalControlFromTakeover = rawPort("terminalControlFromTakeover");
const terminalDispatchRecordMatchesControl =
  rawPort("terminalDispatchRecordMatchesControl");
const terminalRuntimeForLiveIdentity =
  rawPort("terminalRuntimeForLiveIdentity");
const textSummary = rawPort("textSummary");
const userExplicitFallbackWatchReceipt =
  rawPort("userExplicitFallbackWatchReceipt");

const cliEnv = () => humanExplicitSendRuntime().runtime.env();
const cliNow = () => humanExplicitSendRuntime().runtime.now();
const runtimeLog = (
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown>
) => humanExplicitSendRuntime().runtime.log(level, event, fields);
const printJson = (value: unknown) =>
  humanExplicitSendRuntime().runtime.printJson(value);
const durableTerminalInputDispatched = (conversation: Conversation) =>
  humanExplicitSendRuntime().runtime
    .durableTerminalInputDispatched(conversation);
const managedSendAttempt = (
  options: Record<string, any>,
  messageBody: string,
  terminal: TerminalCommandTarget,
  deferZeroInputFailurePresentation: boolean,
  attempt: TerminalHumanExplicitManagedAttempt
) => humanExplicitSendRuntime().managedSendAttempt(
  options,
  messageBody,
  terminal,
  deferZeroInputFailurePresentation,
  attempt
);

function explicitTerminalSendToken(
  terminal: TerminalCommandTarget
): string {
  const processIncarnation = processIncarnationForPid(terminal.pid);
  return unmanagedTerminalBindingToken({
    terminalId: terminal.conversationId,
    terminalControl: terminal.terminalControl,
    agent: terminal.agent,
    pid: terminal.pid,
    workspace: terminal.terminalControl.currentPath ?? "",
    processUuid: processIncarnation.processUuid,
    processBirth: processIncarnation.processBirth
  });
}

function explicitSendTurnReference(candidate: Conversation): string {
  try {
    return turnIdForConversation(candidate);
  } catch {
    return stringValue(candidate.conversation_id) ?? "unknown";
  }
}

function hasFreshExplicitTerminalSendToken(
  options: Record<string, any>,
  terminal: TerminalCommandTarget
): boolean {
  const supplied = stringValue(options.expectedTerminalToken);
  return Boolean(supplied && supplied === explicitTerminalSendToken(terminal));
}

function assertFreshUserExplicitTerminalSendToken(
  options: Record<string, any>,
  terminal: TerminalCommandTarget
): void {
  const expected = stringValue(options.expectedUserExplicitTerminalToken);
  if (expected && expected !== explicitTerminalSendToken(terminal)) {
    throw new Error(
      "the explicit terminal send token is stale; refresh AKK list"
    );
  }
}

async function assertFreshUserExplicitTerminalSendTargetWhileLocked(
  options: Record<string, any>,
  terminal: TerminalCommandTarget
): Promise<void> {
  if (!stringValue(options.expectedUserExplicitTerminalToken)) return;
  const resolved = await createTerminalAgentBridge(options)
    .resolveConversationId(terminal.conversationId);
  if (
    !resolved ||
    resolved.agent !== terminal.agent ||
    resolved.pid !== terminal.pid ||
    !terminalControlsShareIncarnation(
      resolved.terminalControl,
      terminal.terminalControl
    )
  ) {
    throw new Error(
      "the explicitly selected terminal is no longer the same live process"
    );
  }
  assertFreshUserExplicitTerminalSendToken(options, resolved);
}

function releaseTerminalDispatchForExplicitSend(input: {
  terminal: TerminalCommandTarget;
  conversations: readonly Conversation[];
}): {
  checked: boolean;
  lifecycleLedger?: TerminalDispatchLedgerDocument;
  warnings: string[];
} {
  let ledger: TerminalDispatchLedgerDocument | undefined;
  try {
    ledger = loadTerminalBridgeDispatchLedger(
      input.terminal.terminalControl
    );
  } catch (error) {
    return {
      checked: false,
      warnings: [
        `terminal dispatch ownership could not be checked before Session ` +
        `release: ${error instanceof Error ? error.message : String(error)}`
      ]
    };
  }
  if (!ledger || ledger.status === "resolved") {
    return { checked: true, warnings: [] };
  }
  if (terminalDispatchLedgerLooksLifecycle(ledger)) {
    return { checked: true, lifecycleLedger: ledger, warnings: [] };
  }
  if (!terminalDispatchRecordMatchesControl(
    ledger,
    input.terminal.terminalControl
  )) {
    return { checked: true, warnings: [] };
  }
  const conversationId = stringValue(ledger.conversation_id);
  const expectedMessageId = stringValue(ledger.message_id);
  if (!conversationId || !expectedMessageId) {
    return {
      checked: true,
      warnings: [
        "orphaned terminal dispatch was kept because its exact conversation " +
        "or message generation could not be verified"
      ]
    };
  }
  if (input.conversations.some((conversation) =>
    conversation.conversation_id === conversationId
  )) {
    return { checked: true, warnings: [] };
  }
  try {
    if (loadTerminalDispatchLedgerOwner(ledger)) {
      return { checked: true, warnings: [] };
    }
  } catch (error) {
    return {
      checked: true,
      warnings: [
        `orphaned terminal dispatch owner could not be checked: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    };
  }
  try {
    const resolved = resolveTerminalBridgeDispatchLedger(
      input.terminal.terminalControl,
      {
        conversation: { conversation_id: conversationId },
        expectedMessageId,
        reason: "orphaned management superseded by explicit user Send"
      }
    );
    return resolved
      ? { checked: true, warnings: [] }
      : {
          checked: true,
          warnings: [
            "orphaned terminal dispatch changed before explicit Send cleanup"
          ]
        };
  } catch (error) {
    return {
      checked: true,
      warnings: [
        `orphaned terminal dispatch could not be released: ${
          error instanceof Error ? error.message : String(error)
        }`
      ]
    };
  }
}

async function bestEffortReleaseTerminalManagementForExplicitSend(input: {
  storeDir: string;
  terminal: TerminalCommandTarget;
}): Promise<string[]> {
  try {
    return await withStoreWriterLeaseAsync(
      input.storeDir,
      async () => releaseTerminalManagementForExplicitSendUnderWriter(input),
      { timeoutMs: 0 }
    );
  } catch (error) {
    return [
      `AKK management writer was unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }
}

function releaseTerminalManagementForExplicitSendUnderWriter(input: {
  storeDir: string;
  terminal: TerminalCommandTarget;
}): string[] {
  const warnings: string[] = [];
  let conversations: Conversation[];
  try {
    conversations = listConversations(input.storeDir);
  } catch (error) {
    return [
      `managed Turn inventory could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    ];
  }
  for (const candidate of conversations) {
    const reference = explicitSendTurnReference(candidate);
    try {
      if (!isSessionSendBlockingStatus(candidate.status)) continue;
      const takeover = isRecord(candidate.native_session_takeover)
        ? candidate.native_session_takeover
        : undefined;
      const control = terminalControlFromTakeover(takeover);
      if (
        !control ||
        !terminalControlsShareIncarnation(
          control,
          input.terminal.terminalControl
        )
      ) {
        continue;
      }
      const paths = pathsForConversation(
        candidate.conversation_id,
        input.storeDir
      );
      const releaseStateLock = acquireFileLock(
        `${paths.statePath}.lock`,
        { timeoutMs: 0 }
      );
      try {
        const current = loadState(paths.statePath);
        if (!isSessionSendBlockingStatus(current.status)) continue;
        const currentTakeover = isRecord(current.native_session_takeover)
          ? current.native_session_takeover
          : undefined;
        const currentControl = terminalControlFromTakeover(currentTakeover);
        if (
          !currentControl ||
          !terminalControlsShareIncarnation(
            currentControl,
            input.terminal.terminalControl
          )
        ) {
          continue;
        }
        const now = cliNow().toISOString();
        const closed: Conversation = {
          ...supersedeUnacceptedCallbackDeliveries(current, {
            at: now,
            reason: "superseded_by_user_explicit_send"
          }),
          status: "closed",
          closed_at: now,
          close_reason: "superseded by explicit user Send",
          disposition: "user_abandoned_management",
          callback_expected: false,
          updated_at: now
        };
        delete closed.idle_since;
        saveExplicitUserCloseState(paths.statePath, closed);
        try {
          const transferCleanup = cleanupDeferredForegroundUserClose({
            storeDir: input.storeDir,
            conversation: closed,
            at: now
          });
          warnings.push(...transferCleanup.warnings.map((warning) =>
            `Turn ${explicitSendTurnReference(current)} deferred cleanup: ${warning}`
          ));
        } catch (error) {
          warnings.push(
            `Turn ${explicitSendTurnReference(current)} deferred cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        try {
          const expectedMessageId = stringValue(
            currentTakeover?.terminal_bridge_message_id
          );
          const dispatchResolved = resolveTerminalBridgeDispatchLedger(
            currentControl,
            {
              conversation: closed,
              expectedMessageId,
              reason: "management superseded by explicit user Send"
            }
          );
          if (expectedMessageId && !dispatchResolved) {
            warnings.push(
              `Turn ${explicitSendTurnReference(current)} dispatch cleanup ` +
              "did not match its expected ledger"
            );
          }
        } catch (error) {
          warnings.push(
            `Turn ${explicitSendTurnReference(current)} dispatch cleanup failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        try {
          const terminalInputSent = durableTerminalInputDispatched(current);
          appendExplicitUserCloseEvent(paths.logPath, {
            ts: now,
            conversation_id: current.conversation_id,
            event: "conversation_closed",
            status: "closed",
            reason: closed.close_reason as string,
            disposition: "user_abandoned_management",
            terminal_input_sent: terminalInputSent,
            terminal_input_dispatched: terminalInputSent,
            coding_agent_stopped: false,
            tmux_pane_closed: false
          });
        } catch (error) {
          warnings.push(
            `Turn ${explicitSendTurnReference(current)} close event failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      } finally {
        releaseStateLock();
      }
    } catch (error) {
      warnings.push(
        `Turn ${reference} could not release AKK ` +
        `management: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  let currentConversations: Conversation[];
  try {
    currentConversations = listConversations(input.storeDir);
  } catch (error) {
    warnings.push(
      `managed Turn inventory could not be rechecked before Session release: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return warnings;
  }
  const blockingSessionIds = new Set(
    currentConversations
      .filter((turn) => isSessionSendBlockingStatus(turn.status))
      .map((turn) => sessionIdForConversation(turn))
  );
  const dispatchRelease = releaseTerminalDispatchForExplicitSend({
    terminal: input.terminal,
    conversations: currentConversations
  });
  warnings.push(...dispatchRelease.warnings);
  if (!dispatchRelease.checked) {
    return warnings;
  }
  let sessions: ManagedSessionState[];
  try {
    sessions = listManagedSessions(input.storeDir);
  } catch (error) {
    warnings.push(
      `managed Session inventory could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return warnings;
  }
  const lifecycleLedger = dispatchRelease.lifecycleLedger;
  for (const session of sessions) {
    try {
      const binding = session.binding;
      if (
        !["bound", "quarantined", "transitioning"].includes(
          session.status
        ) ||
        session.agent !== input.terminal.agent ||
        !binding ||
        binding.native_process.pid !== input.terminal.pid ||
        !terminalControlAliasMatches(
          binding.terminal_id,
          binding.terminal_control,
          input.terminal.conversationId,
          input.terminal.terminalControl
        ) ||
        blockingSessionIds.has(session.session_id)
      ) {
        continue;
      }
      const lifecycleSourceSessionId = stringValue(
        lifecycleLedger?.source_session_id
      );
      const lifecycleTargetSessionId = stringValue(
        lifecycleLedger?.target_session_id
      );
      const lifecycleTransitionId = stringValue(
        lifecycleLedger?.transition_id
      );
      const lifecycleNamesSession = Boolean(
        lifecycleLedger &&
        (
          lifecycleSourceSessionId === session.session_id ||
          lifecycleTargetSessionId === session.session_id
        )
      );
      if (lifecycleNamesSession) {
        const transitionRelationship = session.last_transition_id
          ? lifecycleTransitionId === session.last_transition_id
            ? `transition ${session.last_transition_id}`
            : `a lifecycle transition that drifted from Session marker ` +
              session.last_transition_id
          : `lifecycle transition ${lifecycleTransitionId ?? "with unknown id"}`;
        warnings.push(
          `Session ${session.session_id} kept AKK management because ` +
          `unresolved ${transitionRelationship} still names it; explicit ` +
          "Send does not prove that transition's native outcome"
        );
        continue;
      }
      const detachedAt = cliNow().toISOString();
      saveManagedSession(input.storeDir, {
        ...session,
        status: "detached",
        detached_at: detachedAt,
        quarantine_reason: undefined,
        updated_at: detachedAt
      }, { expectedRevision: managedSessionRevision(session) });
    } catch (error) {
      warnings.push(
        `Session ${session.session_id} could not release AKK management: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return warnings;
}

function explicitTerminalSendIntentRuntimeDir(): string {
  const configured = stringValue(cliEnv().AKK_RUNTIME_DIR);
  return configured
    ? path.resolve(required(expandHome(configured), "AKK runtime directory"))
    : path.join(path.dirname(defaultStoreDir()), "runtime-v2");
}

function terminalUserSendIntentContext(
  options: Record<string, any>,
  messageBody: string,
  terminal: TerminalCommandTarget
): {
  messageId: string;
  payload: string;
  boundary: TerminalUserSendIntentBoundary;
  repository: ReturnType<typeof createTerminalUserSendIntentRepository>;
} {
  const messageId = required(
    stringValue(options.messageId),
    "explicit terminal Send message id is unavailable"
  );
  const payload = terminalSubmissionPayload(String(messageBody));
  return {
    messageId,
    payload,
    boundary: {
      terminalRuntimeKey: terminalBridgeRuntimeKey(terminal.terminalControl),
      physicalToken: explicitTerminalSendToken(terminal),
      messageId,
      requestHash: createHash("sha256").update(payload).digest("hex")
    },
    repository: createTerminalUserSendIntentRepository({
      runtimeDir: explicitTerminalSendIntentRuntimeDir()
    })
  };
}

type TerminalUserSendIntentContext = ReturnType<
  typeof terminalUserSendIntentContext
>;

interface TerminalUserSendIntentLease {
  intent: TerminalUserSendIntentContext;
  durable: boolean;
  warnings: string[];
}

class TerminalUserSendReplayForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalUserSendReplayForbiddenError";
  }
}

type TerminalUserSendIntentReservation =
  | { outcome: "proceed"; lease: TerminalUserSendIntentLease }
  | { outcome: "replayed" };

function userExplicitEmergencyTerminalLockPath(
  terminal: TerminalCommandTarget
): string {
  const userScope = createHash("sha256")
    .update(path.dirname(defaultStoreDir()))
    .digest("hex")
    .slice(0, 16);
  const terminalKey = createHash("sha256")
    .update(terminalBridgeRuntimeKey(terminal.terminalControl))
    .digest("hex");
  const directory = path.join(
    os.tmpdir(),
    `agent-knock-knock-user-send-${userScope}`
  );
  ensureDir(directory);
  return path.join(directory, `terminal-${terminalKey}.lock`);
}

function acquireUserExplicitTerminalSendLock(
  options: Record<string, any>,
  terminal: TerminalCommandTarget,
  warnings: string[]
): () => void {
  let release: (() => void) | undefined;
  try {
    release = acquireTerminalBridgeSendLock(
      storeDirFromOptions(options),
      terminal.terminalControl,
      { timeoutMs: 30_000 }
    );
  } catch (error) {
    if (isRecord(error) && error.code === "LOCK_TIMEOUT") throw error;
    warnings.push(
      `primary terminal serialization was unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    try {
      release = acquireFileLock(
        userExplicitEmergencyTerminalLockPath(terminal),
        { timeoutMs: 30_000 }
      );
    } catch (fallbackError) {
      if (
        isRecord(fallbackError) &&
        fallbackError.code === "LOCK_TIMEOUT"
      ) {
        throw fallbackError;
      }
      warnings.push(
        `emergency terminal serialization was unavailable; proceeding ` +
        `with exact pre-input revalidation: ${
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError)
        }`
      );
      return () => {};
    }
  }
  return () => {
    try {
      release?.();
    } catch (error) {
      const warning = `terminal serialization cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      warnings.push(warning);
      runtimeLog("warn", "terminal_user_explicit_send_lock_release_failed", {
        terminal_id: terminal.conversationId,
        warning
      });
    }
  };
}

function printReplayedUserExplicitSend(
  options: TerminalCommandCliOptions,
  terminal: TerminalCommandTarget,
  intent: TerminalUserSendIntentContext,
  deliveryMode: TerminalUserSendDeliveryMode
): void {
  if (deliveryMode === "managed") {
    printJson({
      delivered: true,
      replayed: true,
      status: "submission_pending_acceptance",
      submission_outcome: "pending_acceptance",
      delivery_receipt: "enter_dispatched",
      do_not_retry: true,
      ...terminalSendResultContract({
        terminalInputDispatched: true,
        agentAcceptance: "unproven",
        managementMode: "managed",
        observationMode: "none",
        callbackAvailable: false
      }),
      terminal_id: terminal.conversationId,
      message_id: intent.messageId,
      scope: "terminal_user_explicit"
    });
    return;
  }
  const watchId = terminalUserExplicitFallbackWatchId({
    messageId: intent.messageId,
    physicalToken: intent.boundary.physicalToken,
    requestHash: intent.boundary.requestHash
  });
  const callbackReceipt = userExplicitFallbackWatchReceipt({
    options,
    watchId
  });
  const callbackAvailable = callbackReceipt?.callback_expected === true;
  printJson({
    delivered: true,
    delivered_unmanaged: true,
    delivery_receipt: "enter_dispatched",
    ...(callbackReceipt ?? { callback_expected: false }),
    ...terminalSendResultContract({
      terminalInputDispatched: true,
      agentAcceptance: "unproven",
      managementMode: "unmanaged",
      observationMode: callbackAvailable ? "terminal_watch" : "none",
      callbackAvailable,
      interactionNotificationAvailable: callbackAvailable
    }),
    replayed: true,
    terminal_id: terminal.conversationId,
    message_id: intent.messageId,
    scope: "terminal_user_explicit"
  });
}

function reserveUserExplicitSendIntent(
  options: Record<string, any>,
  messageBody: string,
  terminal: TerminalCommandTarget
): TerminalUserSendIntentReservation {
  const intent = terminalUserSendIntentContext(
    options,
    messageBody,
    terminal
  );
  const routingWarning = stringValue(options.terminalUserSendRoutingWarning);
  const warnings: string[] = routingWarning ? [routingWarning] : [];
  let reservation: ReturnType<typeof intent.repository.reserve>;
  try {
    reservation = intent.repository.reserve(intent.boundary);
  } catch (error) {
    if (
      error instanceof TerminalUserSendIntentBoundaryConflictError ||
      error instanceof TerminalUserSendIntentUncertainError
    ) {
      throw error;
    }
    // Runtime receipts strengthen same-id retry safety; their own damage is
    // never authority to suppress a fresh physical user Send.
    warnings.push(
      `durable user-Send intent unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      outcome: "proceed",
      lease: { intent, durable: false, warnings }
    };
  }
  // Presentation is outside the durability catch. A completed same-ID intent
  // remains a replay even when stdout fails (for example EPIPE); it must never
  // degrade into a fresh physical Send.
  if (reservation.outcome === "replay") {
    printReplayedUserExplicitSend(
      options,
      terminal,
      intent,
      required(
        reservation.intent.delivery_mode,
        "completed explicit Send delivery mode is unavailable"
      )
    );
    return { outcome: "replayed" };
  }
  if (reservation.outcome === "uncertain") {
    throw new TerminalUserSendReplayForbiddenError(
      `explicit terminal Send ${intent.messageId} already reached ` +
      `${reservation.stage}; automatic replay is forbidden`
    );
  }
  return {
    outcome: "proceed",
    lease: { intent, durable: true, warnings }
  };
}

function cancelProvenZeroInputUserExplicitSendIntent(
  lease: TerminalUserSendIntentLease,
  terminal: TerminalCommandTarget,
  reason: unknown
): void {
  if (!lease.durable) return;
  try {
    lease.intent.repository.cancelProvenZeroInput(lease.intent.boundary);
    lease.durable = false;
  } catch (error) {
    const warning =
      `durable zero-input user-Send reservation cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    lease.warnings.push(warning);
    runtimeLog("warn", "terminal_user_explicit_send_intent_cancel_failed", {
      terminal_id: terminal.conversationId,
      message_id: lease.intent.messageId,
      zero_input_reason: reason instanceof Error
        ? reason.message
        : String(reason),
      error: warning
    });
  }
}

function completeUserExplicitSendIntentWhileLocked(
  lease: TerminalUserSendIntentLease,
  deliveryMode: TerminalUserSendDeliveryMode
): void {
  if (!lease.durable) return;
  try {
    lease.intent.repository.complete(lease.intent.boundary, deliveryMode);
  } catch (error) {
    lease.durable = false;
    lease.warnings.push(
      `durable user-Send completion receipt failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function completeManagedUserExplicitSendIntent(
  options: Record<string, any>,
  terminal: TerminalCommandTarget,
  lease: TerminalUserSendIntentLease
): void {
  let releaseTerminalLock: (() => void) | undefined;
  if (lease.durable) {
    try {
      releaseTerminalLock = acquireTerminalBridgeSendLock(
        storeDirFromOptions(options),
        terminal.terminalControl,
        { timeoutMs: 0 }
      );
      completeUserExplicitSendIntentWhileLocked(lease, "managed");
    } catch (error) {
      lease.durable = false;
      lease.warnings.push(
        `durable managed Send completion receipt failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      try {
        releaseTerminalLock?.();
      } catch (error) {
        lease.warnings.push(
          `managed terminal serialization cleanup failed after Send: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  if (lease.warnings.length > 0) {
    runtimeLog("warn", "terminal_user_explicit_send_intent_warning", {
      terminal_id: terminal.conversationId,
      message_id: lease.intent.messageId,
      warnings: lease.warnings
    });
  }
}

async function runUserExplicitTerminalFallback(
  options: Record<string, any>,
  terminal: TerminalCommandTarget,
  managedFailure: unknown,
  intentLease: TerminalUserSendIntentLease
): Promise<void> {
  const storeDir = storeDirFromOptions(options);
  let releaseTerminalLock: () => void;
  let terminalLockReleased = false;
  try {
    releaseTerminalLock = acquireUserExplicitTerminalSendLock(
      options,
      terminal,
      intentLease.warnings
    );
  } catch (error) {
    // Both the failed managed path and this failed lock acquisition precede
    // fallback input. Release the same-id receipt so the user can retry.
    cancelProvenZeroInputUserExplicitSendIntent(
      intentLease,
      terminal,
      error
    );
    runtimeLog("warn", "terminal_user_explicit_send_zero_input", {
      terminal_id: terminal.conversationId,
      message_id: intentLease.intent.messageId,
      error: error instanceof Error ? error.message : String(error),
      retry_safe: true,
      intent_warnings: intentLease.warnings
    });
    throw error;
  }
  const releaseTerminalLockOnce = () => {
    if (terminalLockReleased) return;
    terminalLockReleased = true;
    releaseTerminalLock();
  };
  try {
    let bridge: TerminalAgentBridge;
    let fresh: TerminalCommandTarget;
    let runtime: TerminalRuntimeIdentity;
    const { payload, messageId } = intentLease.intent;
    const intentWarnings = intentLease.warnings;
    try {
      bridge = createTerminalAgentBridge(options);
      const resolved = await bridge.resolveConversationId(
        terminal.conversationId
      );
      if (
        !resolved ||
        resolved.agent !== terminal.agent ||
        resolved.pid !== terminal.pid ||
        !terminalControlsShareIncarnation(
          resolved.terminalControl,
          terminal.terminalControl
        )
      ) {
        throw new Error(
          "the explicitly selected terminal is no longer the same live process"
        );
      }
      fresh = resolved;
      if (!hasFreshExplicitTerminalSendToken(options, fresh)) {
        throw new Error(
          "the explicit terminal send token is stale; refresh AKK list"
        );
      }
      runtime = terminalRuntimeForLiveIdentity({
        terminal: fresh,
        physicalOnly: true
      });
      const status = await bridge.status(
        fresh.agent,
        fresh.terminalControl,
        { runtime, scrollbackLines: Number(options.scrollbackLines ?? 120) }
      );
      assertSafeUserExplicitTerminalSend(status);
    } catch (error) {
      cancelProvenZeroInputUserExplicitSendIntent(
        intentLease,
        terminal,
        error
      );
      runtimeLog("warn", "terminal_user_explicit_send_zero_input", {
        terminal_id: terminal.conversationId,
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
        retry_safe: true,
        intent_warnings: intentWarnings
      });
      throw error;
    }
    let preparedCallbackWatch: PreparedUserExplicitFallbackWatch | undefined;
    const callbackWarnings: string[] = [];
    try {
      preparedCallbackWatch = await prepareUserExplicitFallbackWatch({
        options,
        terminal: fresh,
        requestHash: intentLease.intent.boundary.requestHash,
        messageId,
        physicalToken: intentLease.intent.boundary.physicalToken
      });
    } catch (error) {
      const warning = `automatic callback Watch preparation failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
      callbackWarnings.push(warning);
      runtimeLog(
        "warn",
        "terminal_user_explicit_fallback_watch_prepare_failed",
        {
          terminal_id: fresh.conversationId,
          message_id: messageId,
          warning
        }
      );
    }
    let composerDisposition: "replaced_current_composer" =
      "replaced_current_composer";
    try {
      const revalidatePhysicalMutation = async (
        terminalControl: TerminalControlRef
      ) => {
        const currentStatus = await bridge.status(
          fresh.agent,
          terminalControl,
          {
            runtime,
            scrollbackLines: Number(options.scrollbackLines ?? 120)
          }
        );
        assertSafeUserExplicitTerminalSend(currentStatus);
      };
      const result = await bridge.sendUserExplicit(
        fresh.agent,
        fresh.terminalControl,
        payload,
        {
          runtime,
          beforeMutationReservation: ({ terminalControl }) =>
            revalidatePhysicalMutation(terminalControl),
          onComposerClearDispatched: () => {
            runtimeLog("info", "terminal_user_explicit_composer_cleared", {
              terminal_id: fresh.conversationId,
              terminal_target: fresh.terminalControl.target,
              message_id: messageId
            });
          }
        }
      );
      composerDisposition = result.disposition;
      completeUserExplicitSendIntentWhileLocked(intentLease, "unmanaged");
      releaseTerminalLockOnce();
    } catch (error) {
      // The user-explicit bridge normalizes only failures before its first
      // physical mutation to this type. A draft-clear, text-delivery, or Enter
      // attempt is uncertain and must retain the same-id intent.
      const zeroInput = error instanceof TerminalInputNotStartedError;
      if (zeroInput) {
        cancelProvenZeroInputUserExplicitSendIntent(
          intentLease,
          fresh,
          error
        );
      }
      runtimeLog(
        zeroInput ? "warn" : "error",
        zeroInput
          ? "terminal_user_explicit_send_zero_input"
          : "terminal_user_explicit_send_uncertain",
        {
        terminal_id: fresh.conversationId,
        terminal_target: fresh.terminalControl.target,
        message_id: messageId,
        error: error instanceof Error ? error.message : String(error),
        ...(zeroInput
          ? { retry_safe: true }
          : { do_not_retry: true }),
        intent_warnings: intentWarnings
        }
      );
      if (zeroInput) throw error;
      const errorRecord = isRecord(error) ? error : {};
      const reason = textSummary(
        error instanceof Error ? error.message : String(error)
      );
      printJson({
        delivered: false,
        status: "submission_uncertain",
        submission_outcome: "uncertain",
        delivery_receipt: "terminal_input_uncertain",
        terminal_id: fresh.conversationId,
        message_id: messageId,
        scope: "terminal_user_explicit",
        ...terminalSendResultContract({
          terminalInputDispatched: true,
          agentAcceptance: "unproven",
          managementMode: "unmanaged",
          observationMode: "none",
          callbackAvailable: false
        }),
        safe_to_retry: false,
        do_not_retry: true,
        mutation_started: true,
        error_code: stringValue(errorRecord.code),
        stage: stringValue(errorRecord.stage) ?? "terminal_input_uncertain",
        reason,
        note:
          "AKK may have changed the selected terminal while replacing its Composer, but did not prove request submission. Do not retry automatically; inspect the exact shared pane first.",
        next_action:
          "inspect the exact shared pane and explicitly resolve the uncertain Send before issuing another request"
      });
      return;
    }
    let callbackReceipt: UserExplicitFallbackWatchReceipt | undefined;
    if (preparedCallbackWatch) {
      try {
        callbackReceipt = await attachUserExplicitFallbackWatch({
          options,
          prepared: preparedCallbackWatch
        });
      } catch (error) {
        const warning = `automatic callback Watch attachment failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        callbackWarnings.push(warning);
        runtimeLog(
          "warn",
          "terminal_user_explicit_fallback_watch_attach_failed",
          {
            terminal_id: fresh.conversationId,
            message_id: messageId,
            watch_id: preparedCallbackWatch.watchId,
            warning,
            delivered: true
          }
        );
      }
    }
    let cleanupWarnings: string[];
    try {
      cleanupWarnings = await bestEffortReleaseTerminalManagementForExplicitSend({
        storeDir,
        terminal: fresh
      });
    } catch (error) {
      cleanupWarnings = [
        `AKK management release was unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      ];
    }
    const fallbackReason = managedFailure instanceof Error
      ? managedFailure.message
      : String(managedFailure);
    runtimeLog("warn", "terminal_user_explicit_send_fallback", {
      terminal_id: fresh.conversationId,
      terminal_target: fresh.terminalControl.target,
      message_id: messageId,
      managed_failure: fallbackReason,
      composer_disposition: composerDisposition,
      delivered_unmanaged: true
    });
    const callbackAvailable = callbackReceipt?.callback_expected === true;
    printJson({
      delivered: true,
      delivered_unmanaged: true,
      delivery_receipt: "enter_dispatched",
      cleanup_warnings: cleanupWarnings,
      intent_warnings: intentWarnings,
      callback_warnings: callbackWarnings,
      ...(callbackReceipt ?? { callback_expected: false }),
      terminal_id: fresh.conversationId,
      message_id: messageId,
      scope: "terminal_user_explicit",
      ...terminalSendResultContract({
        terminalInputDispatched: true,
        agentAcceptance: "unproven",
        managementMode: "unmanaged",
        observationMode: callbackAvailable ? "terminal_watch" : "none",
        callbackAvailable,
        interactionNotificationAvailable: callbackAvailable
      }),
      composer_disposition: composerDisposition,
      composer_cleared_before_send: true,
      // Deprecated compatibility alias. The v22 policy always dispatches
      // C-u, so older readers may conservatively treat the prior draft as
      // replaced without controlling the new behavior.
      replaced_existing_draft: true,
      previous_management_release_attempted: true,
      warning: textSummary(
        `AKK delivered the user's message after managed-state preparation ` +
        `failed (${fallbackReason}). ` +
        (callbackReceipt
          ? `Terminal Watch ${callbackReceipt.watch_id} now provides the ` +
            `completion callback; no managed Turn was claimed.`
          : "No callback Watch could be attached.")
      ),
      next_action: callbackReceipt
        ? `wait for Terminal Watch ${callbackReceipt.watch_id} callback; ` +
          "watch-status remains available for recovery"
        : "refresh AKK list; the live coding agent continues independently of AKK callback state"
    });
  } finally {
    releaseTerminalLockOnce();
  }
}

async function runRawTerminalSend(
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget
): Promise<void> {
  const identifyForeground = options.identifyForeground === true;
  const suppliedExpectedTerminalToken = stringValue(
    options.expectedTerminalToken
  );
  if (identifyForeground && terminalConversation.agent !== "codex") {
    throw new Error(
      "atomic foreground identification currently supports only Codex terminals"
    );
  }
  if (identifyForeground && !suppliedExpectedTerminalToken) {
    throw new Error(
      "atomic foreground identification requires --expected-terminal-token"
    );
  }
  const userExplicitAuthorityRequested = Boolean(
    suppliedExpectedTerminalToken && options.managedOnly !== true
  );
  const freshExplicitAuthority = userExplicitAuthorityRequested
    ? hasFreshExplicitTerminalSendToken(options, terminalConversation)
    : false;
  if (
    userExplicitAuthorityRequested &&
    !freshExplicitAuthority
  ) {
    throw new Error(
      "the explicit terminal send token is stale; refresh AKK list"
    );
  }
  if (!freshExplicitAuthority) {
    await runManagedRawTerminalSend(
      options,
      messageBody,
      terminalConversation
    );
    return;
  }
  assertExpectedHandoffTokenUsesExactTerminalSelector({
    options,
    terminal: terminalConversation
  });
  const explicitOptions: Record<string, any> = {
    ...options,
    messageId: stringValue(options.messageId) ?? `user-send-${randomUUID()}`
  };
  const reservation = reserveUserExplicitSendIntent(
    explicitOptions,
    messageBody,
    terminalConversation
  );
  if (reservation.outcome === "replayed") return;
  const intentLease = reservation.lease;
  const managedResult = await runManagedRawTerminalSend(
    {
      ...explicitOptions,
      expectedUserExplicitTerminalToken: suppliedExpectedTerminalToken,
      expectedTerminalToken: stringValue(
        explicitOptions.expectedManagedTerminalToken
      ),
      expectedManagedTerminalToken: undefined
    },
    messageBody,
    terminalConversation,
    true
  );
  if (managedResult.outcome !== "zero_input") {
    if (
      managedResult.outcome === "replayed" ||
      managedResult.enterDispatched
    ) {
      completeManagedUserExplicitSendIntent(
        explicitOptions,
        terminalConversation,
        intentLease
      );
    }
    return;
  }
  if (identifyForeground) {
    // The explicit atomic contract never falls back to unmanaged delivery:
    // doing so would discard the very identity/respond capability the caller
    // asked this operation to establish. The task payload is proven unsent,
    // so release its same-id reservation for an explicit later retry.
    cancelProvenZeroInputUserExplicitSendIntent(
      intentLease,
      terminalConversation,
      managedResult.failure
    );
    throw managedResult.failure;
  }
  return runUserExplicitTerminalFallback(
    explicitOptions,
    terminalConversation,
    managedResult.failure,
    intentLease
  );
}

async function runManagedRawTerminalSend(
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget,
  deferZeroInputFailurePresentation = false
): Promise<TerminalControlSendResult> {
  const attempt = {
    terminalControlSendInvoked: false,
    result: undefined as TerminalControlSendResult | undefined
  };
  try {
    return await managedSendAttempt(
      options,
      messageBody,
      terminalConversation,
      deferZeroInputFailurePresentation,
      attempt
    );
  } catch (error) {
    if (!deferZeroInputFailurePresentation) throw error;
    if (attempt.result) return attempt.result;
    if (!attempt.terminalControlSendInvoked) {
      return { outcome: "zero_input", failure: error };
    }
    throw new Error(
      "managed terminal Send may already have started input; refusing an " +
      `automatic unmanaged fallback: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }
}

export async function runHumanExplicitTerminalSend(
  dependencies: TerminalHumanExplicitSendDependencies,
  options: Record<string, any>,
  messageBody: string,
  terminal: TerminalCommandTarget
): Promise<void> {
  return humanExplicitSendContext.run(
    dependencies,
    () => runRawTerminalSend(options, messageBody, terminal)
  );
}

export { assertFreshUserExplicitTerminalSendTargetWhileLocked };
export { assertFreshUserExplicitTerminalSendToken };

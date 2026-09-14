import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";

import {
  callbackDeliveryAttemptOutcome,
  supersedeUnacceptedCallbackDeliveries
} from "./callback-outbox-policy.js";
import {
  captureCodexCandidateSetRolloutAcceptanceAnchor,
  type CodexCandidateSetRolloutAcceptanceAnchor
} from "./terminal-submission-acceptance.js";
import { fingerprint } from "./terminal-submission-facts.js";
import { listDeferredForegroundTransfers } from
  "./deferred-foreground-transfer.js";
import { isFinalDeferredForegroundTransferStatus } from
  "./deferred-foreground-transfer-policy.js";
import {
  humanExplicitCallbackDebtDisposition,
  humanExplicitCallbackDebtManagedTokenMatches,
  humanExplicitCallbackDebtRetirementDisposition
} from "./deferred-foreground-authority-cli-adapter.js";
import type { CodexOpenRootRolloutInventory } from
  "./agent-session-provider.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import {
  appendEvent,
  ensureDir,
  ensureStoreWritable,
  listConversations,
  loadState,
  pathsForConversation,
  saveState
} from "./store.js";
import {
  createManagedSessionId,
  managedSessionBindingToken,
  managedSessionRevision,
  type ManagedSessionState
} from "./managed-session.js";
import {
  listManagedSessions,
  listNativeThreadTransitions,
  loadManagedSession,
  saveManagedSession,
  tryLoadManagedSession
} from "./session-store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  rolloutFileIdentityMatches,
  type TerminalNativeIdentity as NativeAgentSessionIdentity
} from "./terminal-binding-authority.js";
import {
  codexCompanionsPresentInOpenRootInventory,
  exactBoundCodexSendSource,
  isCompleteNativeRollout,
  nativeIdentityMatchesCodexPreMaterialization,
  terminalControlAliasMatches,
  type CodexAllowedCompanionSet
} from "./terminal-authority-policy.js";
import { decideTerminalSendAuthority } from
  "./terminal-action-projection.js";
import {
  type CanonicalMutationResources,
  type CanonicalMutationScopes,
  withCanonicalMutationLocks
} from "./mutation-transaction.js";
import {
  assertTerminalDispatchRouteMatches,
  withExactTerminalDispatchRoute
} from "./terminal-dispatch-capability.js";
import type { TerminalControlSendResult } from
  "./terminal-command-dispatch-transport.js";
import type {
  CodexDetachedCandidateSessionClaimSet,
  DeferredCodexForegroundBindingBoundary,
  TerminalControlSendRequest,
  VerifiedEmptyCodexHandoffBoundary
} from "./terminal-dispatch-composition.js";
import {
  bindDeferredForegroundApplicationScope,
  bindDeferredForegroundWriterScope
} from "./deferred-foreground-capability.js";
import { deferredForegroundBoundaryProjection } from
  "./deferred-foreground-preparation-cli-adapter.js";
import {
  assertFreshUserExplicitTerminalSendTargetWhileLocked,
  assertFreshUserExplicitTerminalSendToken
} from "./terminal-human-explicit-send-cli-adapter.js";
import type { NativeAgentSessionIdentityObservation } from
  "./terminal-dispatch-execution.js";
import type { CodexForegroundProofAuthority } from
  "./terminal-command-foreground-proof.js";
import type { TerminalWriterMutationLockOptions } from
  "./terminal-mutation-cli-runtime.js";
import {
  type TerminalCommandCliOptions,
  type TerminalCommandPortView,
  type TerminalCommandTarget
} from "./terminal-command-cli-ports.js";
import {
  isRecord,
  nonBlankString as stringValue
} from "./value-guards.js";

export type TerminalManagedSendCliPorts = TerminalCommandPortView<
  | "assertExpectedHandoffTokenUsesExactTerminalSelector"
  | "assertManagedSessionCanStartTurn"
  | "assertNativeThreadHasExclusiveOwnership"
  | "bindingMatchesLiveTerminal"
  | "codexAllowedCompanionSetForManagedSession"
  | "codexPreMaterializationIdentityForManagedSession"
  | "createBoundManagedSession"
  | "createManagedTerminalTurn"
  | "createTerminalAgentBridge"
  | "deferredForegroundApplication"
  | "identifyCodexForegroundWhileLocked"
  | "inspectCodexOpenRootRolloutInventory"
  | "isDiscoverableTmuxConversation"
  | "logicalIdentityForManagedSession"
  | "managedTurnsForSession"
  | "materializeCurrentManagedSession"
  | "maybeAdoptObservedExternalThread"
  | "maybeDetachVerifiedEmptyCodexSource"
  | "mutationDispatchLedger"
  | "observeCurrentNativeAgentSessionIdentity"
  | "prepareDeferredCodexForegroundBinding"
  | "reattachManagedSessionForNativeIdentity"
  | "refineManagedSessionNativeIdentity"
  | "required"
  | "resolveCurrentNativeAgentSessionIdentity"
  | "soleBoundManagedSessionClaimForTerminal"
  | "storeDirFromOptions"
  | "terminalBridgeRuntimeKey"
  | "terminalControlFromTakeover"
  | "terminalList"
  | "terminalWriterMutationLocks"
  | "verifyCodexPendingManagedSendStatus"
  | "withTerminalDispatchStateScope"
>;

interface ManagedReplayRequest {
  options: Record<string, any>;
  terminalControl: TerminalControlRef;
  requestText: string;
  expectedStoreDir: string;
  expectedSessionId?: string;
  expectedTurnId?: string;
  expectedMessageType: "task" | "answer";
  expectedStatePath?: string;
  userExplicitTerminalId?: string;
}

export interface TerminalManagedSendDependencies {
  ports: TerminalManagedSendCliPorts;
  foregroundIdentificationAuthority: CodexForegroundProofAuthority;
  replayExactActiveTerminalSubmission(input: ManagedReplayRequest): boolean;
  runTerminalControlSend(
    request: TerminalControlSendRequest
  ): Promise<TerminalControlSendResult>;
  runtime: {
    now(): Date;
  };
}

const managedSendContext =
  new AsyncLocalStorage<TerminalManagedSendDependencies>();

function managedSendRuntime(): TerminalManagedSendDependencies {
  const runtime = managedSendContext.getStore();
  if (!runtime) {
    throw new Error("Terminal managed Send runtime is unavailable");
  }
  return runtime;
}

type ManagedSendFunctionPortName = {
  [Name in keyof TerminalManagedSendCliPorts]:
    TerminalManagedSendCliPorts[Name] extends
      (...arguments_: never[]) => unknown
      ? Name
      : never;
}[keyof TerminalManagedSendCliPorts];

function rawPort<Name extends ManagedSendFunctionPortName>(
  name: Name
): TerminalManagedSendCliPorts[Name] {
  return ((...arguments_: unknown[]) => {
    const operation = managedSendRuntime().ports[name];
    return (operation as (...values: unknown[]) => unknown)(...arguments_);
  }) as TerminalManagedSendCliPorts[Name];
}

const assertExpectedHandoffTokenUsesExactTerminalSelector =
  rawPort("assertExpectedHandoffTokenUsesExactTerminalSelector");
const assertManagedSessionCanStartTurn =
  rawPort("assertManagedSessionCanStartTurn");
const assertNativeThreadHasExclusiveOwnership =
  rawPort("assertNativeThreadHasExclusiveOwnership");
const bindingMatchesLiveTerminal = rawPort("bindingMatchesLiveTerminal");
const codexAllowedCompanionSetForManagedSession =
  rawPort("codexAllowedCompanionSetForManagedSession");
const codexPreMaterializationIdentityForManagedSession =
  rawPort("codexPreMaterializationIdentityForManagedSession");
const createBoundManagedSession = rawPort("createBoundManagedSession");
const createManagedTerminalTurn = rawPort("createManagedTerminalTurn");
const createTerminalAgentBridge = rawPort("createTerminalAgentBridge");
const deferredForegroundApplication = rawPort("deferredForegroundApplication");
const identifyCodexForegroundWhileLocked =
  rawPort("identifyCodexForegroundWhileLocked");
const inspectCodexOpenRootRolloutInventory =
  rawPort("inspectCodexOpenRootRolloutInventory");
const isDiscoverableTmuxConversation =
  rawPort("isDiscoverableTmuxConversation");
const logicalIdentityForManagedSession =
  rawPort("logicalIdentityForManagedSession");
const managedTurnsForSession = rawPort("managedTurnsForSession");
const materializeCurrentManagedSession =
  rawPort("materializeCurrentManagedSession");
const maybeAdoptObservedExternalThread =
  rawPort("maybeAdoptObservedExternalThread");
const maybeDetachVerifiedEmptyCodexSource =
  rawPort("maybeDetachVerifiedEmptyCodexSource");
const observeCurrentNativeAgentSessionIdentity =
  rawPort("observeCurrentNativeAgentSessionIdentity");
const prepareDeferredCodexForegroundBinding =
  rawPort("prepareDeferredCodexForegroundBinding");
const reattachManagedSessionForNativeIdentity =
  rawPort("reattachManagedSessionForNativeIdentity");
const refineManagedSessionNativeIdentity =
  rawPort("refineManagedSessionNativeIdentity");
const required = rawPort("required");
const resolveCurrentNativeAgentSessionIdentity =
  rawPort("resolveCurrentNativeAgentSessionIdentity");
const soleBoundManagedSessionClaimForTerminal =
  rawPort("soleBoundManagedSessionClaimForTerminal");
const storeDirFromOptions = rawPort("storeDirFromOptions");
const terminalBridgeRuntimeKey = rawPort("terminalBridgeRuntimeKey");
const terminalControlFromTakeover = rawPort("terminalControlFromTakeover");
const terminalWriterMutationLocks = rawPort("terminalWriterMutationLocks");
const verifyCodexPendingManagedSendStatus =
  rawPort("verifyCodexPendingManagedSendStatus");
const withTerminalDispatchStateScope =
  rawPort("withTerminalDispatchStateScope");

const mutationDispatchLedger = new Proxy({}, {
  get: (_target, property) =>
    managedSendRuntime().ports.mutationDispatchLedger[
      property as keyof TerminalManagedSendCliPorts["mutationDispatchLedger"]
    ]
}) as TerminalManagedSendCliPorts["mutationDispatchLedger"];

const terminalListCliFacade = new Proxy({}, {
  get: (_target, property) =>
    managedSendRuntime().ports.terminalList[
      property as keyof TerminalManagedSendCliPorts["terminalList"]
    ]
}) as TerminalManagedSendCliPorts["terminalList"];

const foregroundIdentificationAuthority = new Proxy({}, {
  get: (_target, property) =>
    managedSendRuntime().foregroundIdentificationAuthority[
      property as keyof CodexForegroundProofAuthority
    ]
}) as CodexForegroundProofAuthority;

const cliNow = () => managedSendRuntime().runtime.now();
const replayExactActiveTerminalSubmission = (input: ManagedReplayRequest) =>
  managedSendRuntime().replayExactActiveTerminalSubmission(input);
const runTerminalControlSend = (request: TerminalControlSendRequest) =>
  managedSendRuntime().runTerminalControlSend(request);

const USER_EXPLICIT_MANAGED_LOCK_GRACE_MS = 1_000;

interface RawTerminalInitialAuthority {
  claimedSession?: ManagedSessionState;
  suppliedExpectedTerminalToken?: string;
  implicitCodexCandidateAuthority: boolean;
  knownCodexCompanions: CodexAllowedCompanionSet;
}

function captureDetachedCodexCandidateSessionClaims(input: {
  storeDir: string;
  terminal: TerminalCommandTarget;
  inventory: CodexOpenRootRolloutInventory;
  anchor: CodexCandidateSetRolloutAcceptanceAnchor;
}): CodexDetachedCandidateSessionClaimSet | undefined {
  const { inventory, terminal } = input;
  const candidates = new Map(inventory.roots.map((root) => [
    root.sessionId.toLowerCase(),
    root
  ]));
  const claims = listManagedSessions(input.storeDir).flatMap((session) => {
    const binding = session.binding;
    const nativeThreadId = binding?.native_thread_id?.toLowerCase();
    const candidate = nativeThreadId ? candidates.get(nativeThreadId) : undefined;
    if (
      session.status !== "detached" || session.agent !== "codex" ||
      !binding || !nativeThreadId || !candidate ||
      !isCompleteNativeRollout(binding.native_process.rollout) ||
      path.resolve(session.workspace) !==
        path.resolve(terminal.terminalControl.currentPath ?? "") ||
      binding.native_process.pid !== inventory.pid ||
      binding.native_process.process_uuid !== inventory.processUuid ||
      binding.native_process.process_birth !== inventory.processBirth ||
      candidate.processUuid !== inventory.processUuid ||
      candidate.processBirth !== inventory.processBirth ||
      !terminalControlAliasMatches(
        binding.terminal_id,
        binding.terminal_control,
        terminal.conversationId,
        terminal.terminalControl
      ) ||
      !rolloutFileIdentityMatches(
        binding.native_process.rollout,
        candidate.rollout
      )
    ) {
      return [];
    }
    return [{
      session_id: session.session_id,
      session_revision: managedSessionRevision(session),
      session_binding_token: managedSessionBindingToken(session),
      binding_id: binding.binding_id,
      binding_generation: binding.generation,
      native_thread_id: nativeThreadId,
      process_uuid: inventory.processUuid,
      process_birth: inventory.processBirth,
      source_rollout: { ...binding.native_process.rollout },
      candidate_rollout: { ...candidate.rollout }
    }];
  }).sort((left, right) =>
    left.native_thread_id.localeCompare(right.native_thread_id) ||
    left.session_id.localeCompare(right.session_id)
  );
  if (claims.length === 0) return undefined;
  const base = {
    schema: "agent-knock-knock/codex-detached-candidate-session-claims" as const,
    version: 1 as const,
    anchor_fingerprint: input.anchor.anchor_fingerprint,
    claims
  };
  return { ...base, claims_fingerprint: fingerprint(base) };
}

function rawTerminalInitialAuthority({
  options,
  terminal,
  storeDir
}: {
  options: Record<string, any>;
  terminal: TerminalCommandTarget;
  storeDir: string;
}): RawTerminalInitialAuthority {
  const claimedSession = soleBoundManagedSessionClaimForTerminal(
    storeDir,
    terminal
  );
  const suppliedExpectedTerminalToken = stringValue(
    options.expectedTerminalToken
  );
  const implicitCodexCandidateAuthority = Boolean(
    terminal.agent === "codex" &&
    suppliedExpectedTerminalToken === undefined &&
    claimedSession?.status === "bound" &&
    isCompleteNativeRollout(
      claimedSession.binding?.native_process.rollout
    )
  );
  const knownCodexCompanions = claimedSession
    ? codexAllowedCompanionSetForManagedSession({
        storeDir,
        session: claimedSession
      })
    : { additional: [] };
  return {
    claimedSession,
    suppliedExpectedTerminalToken,
    implicitCodexCandidateAuthority,
    knownCodexCompanions
  };
}

function assertRawTerminalCandidateAuthority({
  terminal,
  nativeIdentityObservation,
  deferredCodexCandidateInventory,
  implicitCodexCandidateAuthority
}: {
  terminal: TerminalCommandTarget;
  nativeIdentityObservation: NativeAgentSessionIdentityObservation;
  deferredCodexCandidateInventory?: CodexOpenRootRolloutInventory;
  implicitCodexCandidateAuthority: boolean;
}): void {
  if (
    implicitCodexCandidateAuthority &&
    !deferredCodexCandidateInventory
  ) {
    throw new Error(
      "rollout-backed Codex terminal send requires a fresh complete " +
      "nonempty open-root inventory; refresh AKK list before sending"
    );
  }
  if (
    nativeIdentityObservation.status === "unavailable" &&
    !deferredCodexCandidateInventory
  ) {
    throw new Error(
      `native ${terminal.agent} identity observation is ` +
      `unavailable: ${nativeIdentityObservation.reason}`
    );
  }
}

const USER_EXPLICIT_CALLBACK_SUPERSEDE_REASON =
  "superseded_by_user_explicit_send";

function sessionHasUnresolvedForegroundMutation(
  storeDir: string,
  sessionId: string
): boolean {
  try {
    if (listNativeThreadTransitions(storeDir).some((transition) =>
      (transition.source_session_id === sessionId ||
        transition.target_session_id === sessionId) &&
      !["committed", "aborted"].includes(transition.status)
    )) {
      return true;
    }
    return listDeferredForegroundTransfers(storeDir).some((transfer) =>
      (transfer.source_session_id === sessionId ||
        transfer.target_session_id === sessionId) &&
      !isFinalDeferredForegroundTransferStatus(transfer.status)
    );
  } catch {
    // Corrupt or unreadable lifecycle evidence must never be bypassed.
    return true;
  }
}

async function supersedeExactHumanExplicitCallbackDebt(input: {
  options: Record<string, any>;
  terminal: TerminalCommandTarget;
  session?: ManagedSessionState;
  candidateInventory?: CodexOpenRootRolloutInventory;
  storeDir: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
}): Promise<boolean> {
  const {
    options, terminal, session, candidateInventory, storeDir, scopes, resources
  } = input;
  const expectedManagedToken = stringValue(options.expectedTerminalToken);
  const binding = session?.binding;
  if (
    terminal.agent !== "codex" ||
    stringValue(options.expectedUserExplicitTerminalToken) === undefined ||
    !session ||
    session.status !== "bound" ||
    !binding ||
    !humanExplicitCallbackDebtManagedTokenMatches(
      expectedManagedToken,
      session
    ) ||
    !candidateInventory ||
    !exactBoundCodexSendSource({
      kind: "candidate",
      sourceSession: session,
      context: {
        terminalId: terminal.conversationId,
        terminalControl: terminal.terminalControl,
        pid: terminal.pid,
        workspace: terminal.terminalControl.currentPath,
        liveProcessUuid: candidateInventory.processUuid,
        liveProcessBirth: candidateInventory.processBirth
      },
      inventory: candidateInventory,
      sourceRolloutAuthority: "present"
    }) ||
    sessionHasUnresolvedForegroundMutation(storeDir, session.session_id)
  ) {
    return false;
  }
  const bindingTurns = managedTurnsForSession(storeDir, session.session_id)
    .filter((turn) =>
      turn.terminal_binding_id === binding.binding_id &&
      turn.terminal_binding_generation === binding.generation
    );
  const dispositions = bindingTurns.map((turn) => ({
    turn,
    disposition: humanExplicitCallbackDebtRetirementDisposition(turn, session)
  }));
  const candidates = dispositions
    .filter(({ disposition }) => disposition === "supersedable")
    .map(({ turn }) => turn);
  if (
    candidates.length === 0 ||
    dispositions.some(({ disposition }) => disposition === undefined)
  ) {
    return false;
  }
  let superseded = 0;
  for (const candidate of candidates) {
    const paths = pathsForConversation(candidate.conversation_id, storeDir);
    const expectedDelivery = JSON.stringify(candidate.callback_delivery);
    await withTerminalDispatchStateScope(
      scopes,
      resources,
      paths.statePath,
      paths.logPath,
      async () => {
        const current = loadState(paths.statePath);
        if (
          JSON.stringify(current.callback_delivery) !== expectedDelivery ||
          humanExplicitCallbackDebtDisposition(current, session) !==
            "supersedable"
        ) {
          return;
        }
        const at = cliNow().toISOString();
        const next = supersedeUnacceptedCallbackDeliveries(current, {
          at,
          reason: USER_EXPLICIT_CALLBACK_SUPERSEDE_REASON
        });
        if (next.callback_delivery === current.callback_delivery) return;
        saveState(paths.statePath, next);
        appendEvent(paths.logPath, {
          ts: at,
          conversation_id: current.conversation_id,
          event: "callback_delivery_superseded_by_user_explicit_send",
          status: current.status,
          reason: USER_EXPLICIT_CALLBACK_SUPERSEDE_REASON,
          prior_callback_status: isRecord(current.callback_delivery)
            ? current.callback_delivery.status
            : undefined,
          prior_callback_attempt_disposition:
            callbackDeliveryAttemptOutcome(current.callback_delivery)
              ?.disposition,
          // An uncertain transport may already have reached the controller.
          // This records that the human-priority Send retired only future
          // callback retries; it never asserts that delivery did not occur.
          human_override_of_uncertain_callback:
            callbackDeliveryAttemptOutcome(current.callback_delivery)
              ?.disposition === "uncertain",
          terminal_input_sent: false,
          terminal_input_dispatched: false
        });
        superseded += 1;
      }
    );
  }
  return superseded === candidates.length;
}

function rawTerminalObservedIdentityForPreparation(input: {
  atomicForegroundIdentification: boolean;
  sourceLessCandidateInventory?: CodexOpenRootRolloutInventory;
  observation: NativeAgentSessionIdentityObservation;
}): NativeAgentSessionIdentity | undefined {
  if (
    input.atomicForegroundIdentification ||
    input.sourceLessCandidateInventory !== undefined ||
    input.observation.status !== "resolved"
  ) {
    return undefined;
  }
  return input.observation.identity;
}

async function maybePrepareVerifiedEmptyCodexHandoff(input: {
  options: TerminalCommandCliOptions;
  terminal: TerminalCommandTarget;
  sourceSession?: ManagedSessionState;
  observation: NativeAgentSessionIdentityObservation;
  implicitCandidateAuthority: boolean;
  atomicForegroundIdentification: boolean;
}): Promise<{
  detached: ManagedSessionState;
  boundary: VerifiedEmptyCodexHandoffBoundary;
} | undefined> {
  if (
    input.implicitCandidateAuthority ||
    input.atomicForegroundIdentification
  ) {
    return undefined;
  }
  return maybeDetachVerifiedEmptyCodexSource({
    options: input.options,
    terminal: input.terminal,
    sourceSession: input.sourceSession,
    observation: input.observation
  });
}

function assertAtomicForegroundCandidateInventory(input: {
  enabled: boolean;
  claimedSession?: ManagedSessionState;
  inventory?: CodexOpenRootRolloutInventory;
}): void {
  if (!input.enabled || input.claimedSession === undefined) return;
  if (input.inventory && input.inventory.roots.length > 0) return;
  throw new Error(
    "atomic foreground identification requires a fresh nonempty " +
    "candidate-set acceptance boundary; no task input was sent"
  );
}

function assertAtomicForegroundAcceptanceBoundary(input: {
  enabled: boolean;
  deferred?: DeferredCodexForegroundBindingBoundary;
  postSend?: CodexCandidateSetRolloutAcceptanceAnchor;
}): void {
  if (!input.enabled) return;
  if (input.deferred?.candidateAcceptanceAnchor || input.postSend) return;
  throw new Error(
    "atomic foreground identification could not establish an exact " +
    "task-acceptance boundary; no task input was sent"
  );
}

async function prepareRawTerminalDispatchAuthority(input: {
  options: Record<string, any>;
  messageBody: string;
  terminal: TerminalCommandTarget;
  storeDir: string;
  scopes: CanonicalMutationScopes;
  resources: CanonicalMutationResources;
}) {
  const {
    options, messageBody, terminal, storeDir, scopes, resources
  } = input;
  const atomicForegroundIdentification = options.identifyForeground === true;
  const initialAuthority = rawTerminalInitialAuthority({
    options,
    terminal,
    storeDir
  });
  let { claimedSession, knownCodexCompanions } = initialAuthority;
  const {
    suppliedExpectedTerminalToken,
    implicitCodexCandidateAuthority
  } = initialAuthority;
  const userExplicitTerminalToken = stringValue(
    options.expectedUserExplicitTerminalToken
  );
  const nativeIdentityObservation =
    await observeCurrentNativeAgentSessionIdentity({
      options,
      agent: terminal.agent,
      pid: terminal.pid,
      cwd: terminal.terminalControl.currentPath,
      preferredSessionId: knownCodexCompanions.primary
        ? claimedSession?.binding?.native_thread_id
        : undefined,
      allowedCompanionIdentity: knownCodexCompanions.primary,
      allowedAdditionalIdentities: knownCodexCompanions.additional
    });
  let deferredCodexCandidateInventory:
    | CodexOpenRootRolloutInventory
    | undefined;
  if (
    terminal.agent === "codex" &&
    (
      userExplicitTerminalToken ||
      suppliedExpectedTerminalToken ||
      implicitCodexCandidateAuthority
    )
  ) {
    try {
      const inventory = await inspectCodexOpenRootRolloutInventory({
        options,
        pid: terminal.pid,
        cwd: terminal.terminalControl.currentPath
      });
      // An empty set is meaningful only for a source-less human Send: it is
      // the frozen proof that the first accepting rollout must appear after
      // Enter. Preserve the older bound/deferred behavior otherwise.
      if (
        inventory.roots.length > 0 ||
        (userExplicitTerminalToken !== undefined && claimedSession === undefined)
      ) {
        deferredCodexCandidateInventory = inventory;
      }
    } catch (error) {
      if (
        (
          userExplicitTerminalToken !== undefined &&
          claimedSession === undefined
        ) ||
        implicitCodexCandidateAuthority ||
        nativeIdentityObservation.status === "unavailable"
      ) {
        throw new Error(
          `native Codex foreground attribution requires a fresh complete ` +
          `open-root inventory: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }
  assertRawTerminalCandidateAuthority({
    terminal,
    nativeIdentityObservation,
    deferredCodexCandidateInventory,
    implicitCodexCandidateAuthority
  });
  const sourceLessCodexCandidateInventory =
    terminal.agent === "codex" &&
      userExplicitTerminalToken !== undefined &&
      claimedSession === undefined
      ? deferredCodexCandidateInventory
      : undefined;
  let currentNativeIdentity = rawTerminalObservedIdentityForPreparation({
    atomicForegroundIdentification,
    sourceLessCandidateInventory: sourceLessCodexCandidateInventory,
    observation: nativeIdentityObservation
  });
  // A fresh nonempty inventory is the stronger physical authority for an
  // implicit candidate send. Do not let an earlier verified-absent
  // observation divert this path into the token-only empty handoff.
  const verifiedEmptyHandoff = await maybePrepareVerifiedEmptyCodexHandoff({
    options,
    terminal,
    sourceSession: claimedSession,
    observation: nativeIdentityObservation,
    implicitCandidateAuthority: implicitCodexCandidateAuthority,
    atomicForegroundIdentification
  });
  if (verifiedEmptyHandoff) {
    // The old rollout is conclusively closed. Never carry it forward as a
    // pre-materialization companion for the new virgin Session.
    claimedSession = undefined;
    knownCodexCompanions = { additional: [] };
    currentNativeIdentity = undefined;
  }
  const physicalNativeIdentityBeforeHandoff = currentNativeIdentity;
  // The status card emitted by identify_foreground is diagnostic evidence,
  // never handoff authority. Let the existing candidate-set/deferred path
  // bind only the rollout that later accepts the exact task request.
  let handoff = atomicForegroundIdentification
    ? { identity: undefined, adopted: false as const }
    : await maybeAdoptObservedExternalThread({
        options,
        terminal,
        // A no-token raw send to an already managed rollout-backed Codex pane
        // is an internal follow-current delegation, not a sole-root
        // continuation.
        sourceSession: implicitCodexCandidateAuthority
          ? undefined
          : claimedSession,
        resolvedIdentity: sourceLessCodexCandidateInventory
          ? undefined
          : currentNativeIdentity,
        storeDir
      });
  currentNativeIdentity =
    handoff.adopted && terminal.agent === "codex" &&
      !handoff.session?.binding?.native_process.rollout
      ? physicalNativeIdentityBeforeHandoff
      : handoff.identity;
  if (!handoff.adopted) {
    await supersedeExactHumanExplicitCallbackDebt({
      options,
      terminal,
      session: claimedSession,
      candidateInventory: deferredCodexCandidateInventory,
      storeDir,
      scopes,
      resources
    });
  }
  assertAtomicForegroundCandidateInventory({
    enabled: atomicForegroundIdentification,
    claimedSession,
    inventory: deferredCodexCandidateInventory
  });
  const deferredCodexForegroundBinding = !handoff.adopted
    ? await prepareDeferredCodexForegroundBinding({
        options,
        scope: bindDeferredForegroundWriterScope(scopes, resources),
        terminal,
        sourceSession: claimedSession,
        observation: nativeIdentityObservation,
        candidateInventory: deferredCodexCandidateInventory,
        requestText: String(messageBody),
        allowImplicitFreshAuthority: implicitCodexCandidateAuthority
      })
    : undefined;
  const postSendCodexCandidateAnchor =
    terminal.agent === "codex" &&
      userExplicitTerminalToken !== undefined &&
      sourceLessCodexCandidateInventory !== undefined &&
      verifiedEmptyHandoff === undefined &&
      !handoff.adopted &&
      deferredCodexForegroundBinding === undefined &&
      claimedSession === undefined
      ? captureCodexCandidateSetRolloutAcceptanceAnchor({
          inventory: sourceLessCodexCandidateInventory,
          now: cliNow()
        })
      : undefined;
  const postSendCodexDetachedSessionClaims = postSendCodexCandidateAnchor &&
      sourceLessCodexCandidateInventory
    ? captureDetachedCodexCandidateSessionClaims({
        storeDir,
        terminal,
        inventory: sourceLessCodexCandidateInventory,
        anchor: postSendCodexCandidateAnchor
      })
    : undefined;
  assertAtomicForegroundAcceptanceBoundary({
    enabled: atomicForegroundIdentification,
    deferred: deferredCodexForegroundBinding,
    postSend: postSendCodexCandidateAnchor
  });
  const freshSendAuthority = decideTerminalSendAuthority({
    ownership: "conflict",
    verifiedEmpty: Boolean(verifiedEmptyHandoff),
    externalHandoff: handoff.adopted,
    deferred: Boolean(deferredCodexForegroundBinding)
  });
  if (
    freshSendAuthority.mode === "deferred" &&
    deferredCodexForegroundBinding
  ) {
    claimedSession = undefined;
    knownCodexCompanions = { additional: [] };
    currentNativeIdentity = undefined;
    handoff = { identity: undefined, adopted: false };
  } else if (
    (
      userExplicitTerminalToken ||
      suppliedExpectedTerminalToken ||
      implicitCodexCandidateAuthority
    ) &&
    !postSendCodexCandidateAnchor &&
    freshSendAuthority.mode === "conflict"
  ) {
    throw new Error(
      "managed continuation authority is unavailable for the current " +
      "terminal context" +
      (userExplicitTerminalToken
        ? "; the physical terminal authority remains valid"
        : "; refresh AKK list before retrying managed delivery")
    );
  }
  return {
    nativeIdentityObservation,
    knownCodexCompanions,
    currentNativeIdentity,
    verifiedEmptyHandoff,
    handoff,
    deferredCodexForegroundBinding,
    postSendCodexCandidateAnchor,
    postSendCodexDetachedSessionClaims
  };
}

async function runManagedRawTerminalSendAttemptInContext(
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget,
  deferZeroInputFailurePresentation: boolean,
  attempt: {
    terminalControlSendInvoked: boolean;
    result?: TerminalControlSendResult;
  }
): Promise<TerminalControlSendResult> {
  // A token copied from list is authority for exactly the advertised full
  // terminal selector. Reject aliases and implicit/no-selector resolution
  // before taking locks or touching Store state.
  assertExpectedHandoffTokenUsesExactTerminalSelector({
    options,
    terminal: terminalConversation
  });
  if (!options.background) {
    throw new Error(
      "raw terminal sends require --background so AKK can persist and monitor the submission safely"
    );
  }
  const rawStoreDir = storeDirFromOptions(options);
  let controlSendResult: TerminalControlSendResult | undefined;
  const atomicForegroundIdentification = options.identifyForeground === true;
  foregroundIdentificationAuthority.clear(options);
  const userExplicitLockOptions: TerminalWriterMutationLockOptions | undefined =
    deferZeroInputFailurePresentation
      ? {
          terminalTimeoutMs: 0,
          storeWriterTimeoutMs: USER_EXPLICIT_MANAGED_LOCK_GRACE_MS
        }
      : undefined;
  const lockOptions: TerminalWriterMutationLockOptions | undefined =
    atomicForegroundIdentification
      ? {
          ...userExplicitLockOptions,
          afterTerminalAcquired: async () => {
            const expectedTerminalToken = required(
              stringValue(options.expectedUserExplicitTerminalToken),
              "atomic foreground identification requires fresh physical terminal authority"
            );
            const proof = await identifyCodexForegroundWhileLocked({
              options,
              terminal: terminalConversation,
              expectedTerminalToken
            });
            if (
              proof.terminalId !== terminalConversation.conversationId ||
              proof.pid !== terminalConversation.pid
            ) {
              throw new Error(
                "foreground identification returned evidence for a different terminal"
              );
            }
            foregroundIdentificationAuthority.remember(options, proof);
          }
        }
      : userExplicitLockOptions;
  await withCanonicalMutationLocks(terminalWriterMutationLocks(
    rawStoreDir,
    terminalConversation.terminalControl,
    lockOptions
  ), async (scopes, resources) => {
    await assertFreshUserExplicitTerminalSendTargetWhileLocked(
      options,
      terminalConversation
    );
    await mutationDispatchLedger.beforeMutation(
      scopes, resources, options, terminalConversation
    );
    // Upgrade legacy Stores before resolving their Session authority. The
    // protocol migration, rather than mutable Turn recency, is the only code
    // allowed to materialize Session records from existing Turns.
    ensureStoreWritable(rawStoreDir);
    if (replayExactActiveTerminalSubmission({
      options,
      terminalControl: terminalConversation.terminalControl,
      requestText: String(messageBody),
      expectedStoreDir: rawStoreDir,
      expectedMessageType: "task",
      ...(stringValue(options.expectedUserExplicitTerminalToken)
        ? { userExplicitTerminalId: terminalConversation.conversationId }
        : {})
    })) {
      controlSendResult = { outcome: "replayed" };
      attempt.result = controlSendResult;
      return;
    }
    terminalListCliFacade.assertTerminalIncarnationCanStartTurn(
      rawStoreDir,
      terminalConversation.terminalControl
    );
    const {
      nativeIdentityObservation,
      knownCodexCompanions,
      currentNativeIdentity,
      verifiedEmptyHandoff,
      handoff,
      deferredCodexForegroundBinding,
      postSendCodexCandidateAnchor,
      postSendCodexDetachedSessionClaims
    } = await prepareRawTerminalDispatchAuthority({
      options,
      messageBody,
      terminal: terminalConversation,
      storeDir: rawStoreDir,
      scopes,
      resources
    });
    let managedSession = deferredCodexForegroundBinding
      ? undefined
      : handoff.session ??
        materializeCurrentManagedSession({
          options,
          terminal: terminalConversation,
          identity: currentNativeIdentity
        });
    if (!managedSession && currentNativeIdentity) {
      managedSession = await reattachManagedSessionForNativeIdentity({
        options,
        terminal: terminalConversation,
        identity: currentNativeIdentity,
        storeDir: rawStoreDir
      });
    }
    let pendingRawAttachSessionCreate: ManagedSessionState | undefined;
    if (!managedSession) {
      if (currentNativeIdentity) {
        await assertNativeThreadHasExclusiveOwnership({
          options,
          agent: terminalConversation.agent,
          currentPid: terminalConversation.pid,
          nativeThreadId: currentNativeIdentity.sessionId,
          storeDir: rawStoreDir,
          terminalControl: terminalConversation.terminalControl
        });
      }
      managedSession = createBoundManagedSession({
        sessionId:
          deferredCodexForegroundBinding?.targetSessionId ??
          createManagedSessionId(),
        terminal: terminalConversation,
        identity: currentNativeIdentity,
        lineage: deferredCodexForegroundBinding
          ? {
              created_by: "attach",
              previous_session_id:
                deferredCodexForegroundBinding.sourceSessionId,
              transition_id: deferredCodexForegroundBinding.transferId
            }
          : { created_by: "attach" }
      });
      if (
        terminalConversation.agent === "codex" &&
        !currentNativeIdentity
      ) {
        if (deferredCodexForegroundBinding) {
          managedSession = {
            ...managedSession,
            // Both endpoints stay fenced from older writers until the
            // dedicated transfer reaches its resolved receipt.
            status: "transitioning",
            last_transition_id: deferredCodexForegroundBinding.transferId
          };
        }
        pendingRawAttachSessionCreate = managedSession;
      } else {
        managedSession = saveManagedSession(
          rawStoreDir,
          managedSession,
          { expectedRevision: null }
        );
      }
    }
    const logicalNativeIdentity = logicalIdentityForManagedSession({
      storeDir: rawStoreDir,
      session: managedSession,
      observedIdentity: currentNativeIdentity
    });
    const allowedPreMaterializationIdentity =
      codexPreMaterializationIdentityForManagedSession({
        storeDir: rawStoreDir,
        session: managedSession,
        observedIdentity: currentNativeIdentity
      }) ?? (
        currentNativeIdentity === undefined ||
        nativeIdentityMatchesCodexPreMaterialization(
          currentNativeIdentity,
          knownCodexCompanions.primary
        )
          ? knownCodexCompanions.primary
          : undefined
      );
    const allowedAdditionalIdentities =
      allowedPreMaterializationIdentity
        ? knownCodexCompanions.additional
        : [];
    const materializedNativeIdentity =
      currentNativeIdentity?.sessionId === logicalNativeIdentity?.sessionId
        ? currentNativeIdentity
        : undefined;
    if (options.identifyForeground !== true && !(
      handoff.adopted &&
      terminalConversation.agent === "codex" &&
      !managedSession.binding?.native_process.rollout
    )) {
      await verifyCodexPendingManagedSendStatus({
        options,
        terminal: terminalConversation,
        session: managedSession,
        logicalIdentity: logicalNativeIdentity,
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
    }
    const managedNativeThreadId =
      logicalNativeIdentity?.sessionId ??
      managedSession.binding?.native_thread_id;
    if (managedNativeThreadId) {
      await assertNativeThreadHasExclusiveOwnership({
        options,
        agent: terminalConversation.agent,
        currentPid: terminalConversation.pid,
        nativeThreadId: managedNativeThreadId,
        storeDir: rawStoreDir,
        terminalControl: terminalConversation.terminalControl,
        excludedManagedSessionId: managedSession.session_id
      });
    }
    managedSession = refineManagedSessionNativeIdentity({
      storeDir: rawStoreDir,
      session: managedSession,
      terminalControl: terminalConversation.terminalControl,
      identity: logicalNativeIdentity
    });
    const sessionTurns = managedTurnsForSession(
      rawStoreDir,
      managedSession.session_id
    );
    const reusableTurn = sessionTurns[0];
    assertManagedSessionCanStartTurn(
      sessionTurns
    );
    const managed = createManagedTerminalTurn({
      options,
      conversationId: terminalConversation.conversationId,
      agent: terminalConversation.agent,
      pid: terminalConversation.pid,
      messageBody,
      terminalControl: terminalConversation.terminalControl,
      previousTurn: reusableTurn,
      managedSession,
      nativeAgentIdentity: materializedNativeIdentity,
      deferredForegroundTransferId:
        deferredCodexForegroundBinding?.transferId
    });
    ensureStoreWritable(managed.conversation.store_dir);
    ensureDir(path.dirname(managed.statePath));
    await withTerminalDispatchStateScope(
      scopes,
      resources,
      managed.statePath,
      managed.logPath,
      async (dispatchScopes, dispatchResources) => {
      attempt.terminalControlSendInvoked = true;
      controlSendResult = await runTerminalControlSend({
        transaction: {
          scopes: dispatchScopes,
          resources: dispatchResources
        },
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        executor: managed.executor,
        message: managed.message,
        recordMessageAfterSend: true,
        recordRawAttachmentAfterSend: reusableTurn === undefined,
        deferZeroInputFailurePresentation,
        onTerminalPreflightVerified: async (route) => {
              assertFreshUserExplicitTerminalSendToken(options, {
                ...terminalConversation,
                terminalControl: route.terminalControl
              });
              if (!pendingRawAttachSessionCreate) return;
              const exactRoute = withExactTerminalDispatchRoute(route, {
                terminalControl: terminalConversation.terminalControl,
                terminalKey: terminalBridgeRuntimeKey(
                  terminalConversation.terminalControl
                ),
                storeDir: rawStoreDir,
                statePath: managed.statePath,
                logPath: managed.logPath
              }, (boundRoute) => boundRoute);
              let createdSession: ManagedSessionState;
              if (deferredCodexForegroundBinding) {
                const deferredScope =
                  bindDeferredForegroundApplicationScope(
                    dispatchScopes,
                    dispatchResources
                );
                const reserved =
                  await deferredForegroundApplication(
                    options,
                    deferredCodexForegroundBinding.terminal
                  ).reserve({
                    scope: deferredScope,
                    boundary: deferredForegroundBoundaryProjection(
                      deferredCodexForegroundBinding
                    ),
                    targetSession:
                      pendingRawAttachSessionCreate as ManagedSessionState,
                    messageId: managed.message.id,
                    turnId: turnIdForConversation(managed.conversation)
                  });
                createdSession = reserved.createdSession;
                managedSession = createdSession;
                pendingRawAttachSessionCreate = undefined;
                return (rollbackRoute) => {
                  assertTerminalDispatchRouteMatches(
                    rollbackRoute,
                    exactRoute
                  );
                  reserved.rollback(deferredScope);
                };
              }
              createdSession = saveManagedSession(exactRoute.storeDir,
                pendingRawAttachSessionCreate as ManagedSessionState, {
                  expectedRevision: null
                });
              managedSession = createdSession;
              pendingRawAttachSessionCreate = undefined;
              return (rollbackRoute) => {
                assertTerminalDispatchRouteMatches(rollbackRoute, route);
                const current = loadManagedSession(
                  rollbackRoute.storeDir,
                  createdSession.session_id
                );
                if (
                  current.status !== "bound" ||
                  current.revision !== createdSession.revision ||
                  managedSessionBindingToken(current) !==
                    managedSessionBindingToken(createdSession)
                ) {
                  throw new Error(
                    `new raw-attach Session ${createdSession.session_id} changed before pre-transport rollback`
                  );
                }
                const detachedAt = cliNow().toISOString();
                managedSession = saveManagedSession(rollbackRoute.storeDir, {
                  ...current,
                  status: "detached",
                  detached_at: detachedAt,
                  updated_at: detachedAt
                }, {
                  expectedRevision: current.revision as number
                });
              };
            },
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities,
        observedHandoff:
          handoff.adopted && handoff.transition
            ? {
                terminal: terminalConversation,
                transition: handoff.transition
              }
            : undefined,
        verifiedEmptyCodexHandoff: verifiedEmptyHandoff?.boundary,
        postSendCodexCandidateAnchor,
        postSendCodexDetachedSessionClaims,
        deferredCodexForegroundBinding
      });
      attempt.result = controlSendResult;
      },
      deferZeroInputFailurePresentation
        ? { timeoutMs: USER_EXPLICIT_MANAGED_LOCK_GRACE_MS }
        : undefined
    );
  });
  if (!controlSendResult) {
    throw new Error("managed terminal Send completed without an outcome");
  }
  attempt.result = controlSendResult;
  return controlSendResult;
}

async function runManagedSessionSendInContext(
  options: Record<string, any>,
  messageBody: string
): Promise<void> {
  if (stringValue(options.expectedTerminalToken)) {
    throw new Error(
      "--expected-terminal-token cannot be used with a managed Session; " +
      "use the exact full terminal selector advertised by AKK list"
    );
  }

  const sessionId = required(
    stringValue(options.session ?? options.conversation ?? options.conversationId),
    "--session is required for an ordinary managed send"
  );
  const storeDir = storeDirFromOptions(options);
  // Read only enough legacy/Session authority to identify the physical
  // terminal. Store migration is deliberately deferred until the terminal
  // lock has reconciled any lifecycle fence.
  let initialSession = tryLoadManagedSession(storeDir, sessionId);
  let initialTurns = managedTurnsForSession(storeDir, sessionId);
  if (!initialSession) {
    const exactTurn = listConversations(storeDir)
      .filter(isDiscoverableTmuxConversation)
      .find((turn) =>
        turnIdForConversation(turn) === sessionId ||
        turn.conversation_id === sessionId
      );
    if (exactTurn && sessionIdForConversation(exactTurn) !== sessionId) {
      throw new Error(
        `turn ${sessionId} is an execution identity, not an ordinary send target; ` +
        `send to session ${sessionIdForConversation(exactTurn)} instead`
      );
    }
    if (initialTurns.length === 0) {
      throw new Error(`managed session ${sessionId} was not found`);
    }
  }
  const legacyBindingTurn = initialTurns[0];
  const legacyTakeover = legacyBindingTurn && isRecord(
    legacyBindingTurn.native_session_takeover
  )
    ? legacyBindingTurn.native_session_takeover
    : undefined;
  const rawTerminalId = initialSession?.binding?.terminal_id ??
    stringValue(legacyTakeover?.native_session_id);
  if (!rawTerminalId) {
    throw new Error(
      `managed Session ${sessionId} has no authoritative terminal binding`
    );
  }
  const storedTerminalControl = initialSession?.binding?.terminal_control ??
    terminalControlFromTakeover(legacyTakeover);
  const storedAgent = initialSession?.agent ??
    (legacyBindingTurn
      ? executorForConversation(legacyBindingTurn).kind
      : undefined);
  const storedPid = initialSession?.binding?.native_process.pid ??
    Number(legacyTakeover?.terminal_agent_pid);
  const terminalBridge = createTerminalAgentBridge(options);
  const resolvedTerminal = storedTerminalControl && storedAgent &&
    Number.isSafeInteger(storedPid) && storedPid > 1
    ? await terminalBridge.resolveStoredTerminal(
        storedAgent,
        storedPid,
        storedTerminalControl,
        { pid: storedPid }
      )
    : await terminalBridge.resolveConversationId(rawTerminalId);
  if (!resolvedTerminal) {
    throw new Error(
      `session ${sessionId} is not attached to a live terminal`
    );
  }
  await withCanonicalMutationLocks(terminalWriterMutationLocks(
    storeDir, resolvedTerminal.terminalControl
  ), async (scopes, resources) => {
    const lockedStrictSession = tryLoadManagedSession(storeDir, sessionId);
    if (
      lockedStrictSession?.agent === "codex" &&
      lockedStrictSession.session_id === sessionId &&
      lockedStrictSession.status === "bound" &&
      isCompleteNativeRollout(
        lockedStrictSession.binding?.native_process.rollout
      )
    ) {
      throw new Error(
        `Codex rollout-backed managed Session ${sessionId} cannot use a ` +
        "strict session_id send because an open rollout does not prove the " +
        "current TUI foreground thread. Refresh AKK list and use its exact " +
        "selector plus expected_terminal_token. No Turn was created and no " +
        "terminal input was sent."
      );
    }
    await mutationDispatchLedger.beforeMutation(
      scopes, resources, options, resolvedTerminal
    );
    // A protocol-1/2 Store materializes authoritative Session records as one
    // atomic migration. Once protocol 3 is active, a missing Session is corrupt
    // state and must not be reconstructed from whichever Turn looks newest.
    ensureStoreWritable(storeDir);
    if (replayExactActiveTerminalSubmission({
      options,
      terminalControl: resolvedTerminal.terminalControl,
      requestText: String(messageBody),
      expectedStoreDir: storeDir,
      expectedSessionId: sessionId,
      expectedMessageType: "task"
    })) {
      return;
    }
    terminalListCliFacade.assertTerminalIncarnationCanStartTurn(
      storeDir,
      resolvedTerminal.terminalControl
    );
    let currentSession = tryLoadManagedSession(storeDir, sessionId);
    let knownCodexCompanions: CodexAllowedCompanionSet = currentSession
      ? codexAllowedCompanionSetForManagedSession({
          storeDir,
          session: currentSession
        })
      : { additional: [] };
    if (
      currentSession?.agent === "codex" &&
      knownCodexCompanions.primary
    ) {
      try {
        const inventory = await inspectCodexOpenRootRolloutInventory({
          options,
          pid: resolvedTerminal.pid,
          cwd: resolvedTerminal.terminalControl.currentPath
        });
        knownCodexCompanions = codexCompanionsPresentInOpenRootInventory(
          knownCodexCompanions,
          inventory
        );
      } catch {
        // Inventory proof is an optimization only. Preserve the existing
        // closed /status fence when exact open-root membership is unavailable.
      }
    }
    const lockedNativeIdentity =
      await resolveCurrentNativeAgentSessionIdentity({
        options,
        agent: resolvedTerminal.agent,
        pid: resolvedTerminal.pid,
        cwd: resolvedTerminal.terminalControl.currentPath,
        preferredSessionId: knownCodexCompanions.primary
          ? currentSession?.binding?.native_thread_id
          : undefined,
        allowedCompanionIdentity: knownCodexCompanions.primary,
        allowedAdditionalIdentities: knownCodexCompanions.additional
      });
    if (!currentSession) {
      currentSession = materializeCurrentManagedSession({
        options,
        terminal: resolvedTerminal,
        identity: lockedNativeIdentity
      });
    }
    if (
      !currentSession ||
      currentSession.session_id !== sessionId ||
      currentSession.status !== "bound" ||
      !currentSession.binding
    ) {
      throw new Error(
        `managed Session ${sessionId} is no longer bound; refresh list and retry`
      );
    }
    const currentTurns = managedTurnsForSession(storeDir, sessionId);
    assertManagedSessionCanStartTurn(currentTurns);
    if (!bindingMatchesLiveTerminal(
      currentSession,
      resolvedTerminal,
      lockedNativeIdentity,
      storeDir
    )) {
      throw new Error(
        "managed session identity changed while waiting to send; refresh list and retry"
      );
    }
    const logicalLockedNativeIdentity = logicalIdentityForManagedSession({
      storeDir,
      session: currentSession,
      observedIdentity: lockedNativeIdentity
    });
    const allowedPreMaterializationIdentity =
      codexPreMaterializationIdentityForManagedSession({
        storeDir,
        session: currentSession,
        observedIdentity: lockedNativeIdentity
      }) ?? knownCodexCompanions.primary;
    const allowedAdditionalIdentities = knownCodexCompanions.additional;
    const materializedLockedNativeIdentity =
      lockedNativeIdentity?.sessionId === logicalLockedNativeIdentity?.sessionId
        ? lockedNativeIdentity
        : undefined;
    await verifyCodexPendingManagedSendStatus({
      options,
      terminal: resolvedTerminal,
      session: currentSession,
      logicalIdentity: logicalLockedNativeIdentity,
      allowedPreMaterializationIdentity,
      allowedAdditionalIdentities
    });
    const managedNativeThreadId =
      logicalLockedNativeIdentity?.sessionId ??
      currentSession.binding.native_thread_id;
    if (managedNativeThreadId) {
      await assertNativeThreadHasExclusiveOwnership({
        options,
        agent: resolvedTerminal.agent,
        currentPid: resolvedTerminal.pid,
        nativeThreadId: managedNativeThreadId,
        storeDir,
        terminalControl: resolvedTerminal.terminalControl,
        excludedManagedSessionId: currentSession.session_id
      });
    }
    currentSession = refineManagedSessionNativeIdentity({
      storeDir,
      session: currentSession,
      terminalControl: resolvedTerminal.terminalControl,
      identity: logicalLockedNativeIdentity
    });
    const managed = createManagedTerminalTurn({
      options,
      conversationId: resolvedTerminal.conversationId,
      agent: resolvedTerminal.agent,
      pid: resolvedTerminal.pid,
      messageBody,
      terminalControl: resolvedTerminal.terminalControl,
      previousTurn: currentTurns[0],
      managedSession: currentSession,
      nativeAgentIdentity: materializedLockedNativeIdentity
    });
    ensureStoreWritable(managed.conversation.store_dir);
    ensureDir(path.dirname(managed.statePath));
    await withTerminalDispatchStateScope(
      scopes,
      resources,
      managed.statePath,
      managed.logPath,
      async (dispatchScopes, dispatchResources) => {
      await runTerminalControlSend({
        transaction: {
          scopes: dispatchScopes,
          resources: dispatchResources
        },
        options,
        conversation: managed.conversation,
        nextConversation: managed.nextConversation,
        executor: managed.executor,
        message: managed.message,
        recordMessageAfterSend: true,
        allowedPreMaterializationIdentity,
        allowedAdditionalIdentities
      });
      }
    );
  });
}

export interface TerminalManagedRawSendAttempt {
  terminalControlSendInvoked: boolean;
  result?: TerminalControlSendResult;
}

export async function runManagedRawTerminalSendAttempt(
  dependencies: TerminalManagedSendDependencies,
  options: Record<string, any>,
  messageBody: string,
  terminalConversation: TerminalCommandTarget,
  deferZeroInputFailurePresentation: boolean,
  attempt: TerminalManagedRawSendAttempt
): Promise<TerminalControlSendResult> {
  return managedSendContext.run(
    dependencies,
    () => runManagedRawTerminalSendAttemptInContext(
      options,
      messageBody,
      terminalConversation,
      deferZeroInputFailurePresentation,
      attempt
    )
  );
}

export async function runManagedSessionSend(
  dependencies: TerminalManagedSendDependencies,
  options: Record<string, any>,
  messageBody: string
): Promise<void> {
  return managedSendContext.run(
    dependencies,
    () => runManagedSessionSendInContext(options, messageBody)
  );
}

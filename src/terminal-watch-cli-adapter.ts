import {
  automaticSendWatchReceipt,
  createAutomaticActivityWatchAnchor,
  isAutomaticSendWatch,
  unsafeFallbackWatchPreparation,
  type UserExplicitFallbackWatchReceipt
} from "./terminal-watch-send-activity.js";
import { isCodexPaginatedReadCandidate } from "./codex-lifecycle-compatibility.js";
import { publicTerminalWatch } from "./terminal-watch-presentation.js";
import { callbackRouteFingerprint } from "./callback-route-authority.js";
import {
  createTerminalWatchOpenClawCallbackRoute,
  parseCallbackRoute,
  type CallbackRouteV1
} from "./callback-transport.js";
import { hostProfileCallbackRouteMatchesRuntime } from "./host-profile-callback-transport.js";
import { terminalControlEvidence } from "./terminal-control-ref.js";
import {
  createTerminalWatchCallbackCliAdapter,
  resolveTerminalWatchOpenClawCallback,
  resolveTerminalWatchOpenClawCallbackContext,
  type TerminalWatchCallbackEvent
} from "./terminal-watch-callback-cli-adapter.js";
import { createTerminalWatchService, type TerminalWatchService } from "./terminal-watch-service.js";
import {
  assertTerminalWatchManualInteractionSummary,
  createTerminalActivityWatchAnchor,
  createTerminalWatchStore,
  isUserExplicitFallbackWatch,
  terminalWatchNotificationOnlyRoute,
  terminalUserExplicitFallbackWatchId,
  type TerminalWatch,
  type TerminalWatchAnchor
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  UserExplicitFallbackWatchTarget,
  PreparedUserExplicitFallbackWatch,
  ExactTerminalWatchObservation,
  TerminalWatchCliDependencies,
  TerminalWatchCliFacade
} from "./terminal-watch-cli-contract.js";
import { createTerminalWatchInteractionResponder } from "./terminal-watch-response-cli-adapter.js";
import {
  watchAnchorVersionWarnings,
  captureCodexFallbackWatchAnchor,
  captureClaudeFallbackWatchAnchor,
  capturePaginatedWatchAnchorWithLock,
  captureTerminalWatchAnchor
} from "./terminal-watch-anchor-capture.js";
import {
  assertSameUserExplicitFallbackTerminal,
  assertPreparedFallbackTerminal,
  exactTerminalForWatch,
  bestEffortBindingTokenForWatch,
  terminalActivityState,
  sameManualWatchTarget,
  safeDiagnostic,
  terminalControlForWatch,
  terminalWatchIdentity,
  terminalAgent,
  terminalWorkspace,
  requiredWatchId,
  requiredString,
  positiveInteger,
  positiveMinutes
} from "./terminal-watch-terminal-identity.js";
import { observeTerminalWatch } from "./terminal-watch-observation-adapter.js";
import { approvalFingerprint } from "./terminal-watch-observation-evidence.js";

const DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES = 720;

export function createTerminalWatchCliAdapter(
  dependencies: TerminalWatchCliDependencies
): TerminalWatchCliFacade {
  const callback = dependencies.callback ??
    createTerminalWatchCallbackCliAdapter();

  function serviceFor(
    options: TerminalWatchCliOptions
  ): TerminalWatchService {
    const explicitRoute = Object.hasOwn(options, "callbackRoute")
      ? parseCallbackRoute(options.callbackRoute)
      : undefined;
    const repository = createTerminalWatchStore(
      dependencies.storeDirFromOptions(options),
      { acquire: dependencies.acquireFileLock }
    );
    return createTerminalWatchService({
      repository,
      now: dependencies.now,
      randomUUID: dependencies.randomUUID,
      observe: (watch) => observeTerminalWatch(watch, options, dependencies),
      resolveCallback: explicitRoute
        ? (watch) => ({
            route: watch.interaction_policy === "notify_only"
              ? terminalWatchNotificationOnlyRoute(explicitRoute)
              : options.callbackRouteControllerScope === "route_bound_v1"
              ? routeBoundWatchCallbackRoute(explicitRoute, watch)
              : explicitRoute
          })
        : resolveTerminalWatchOpenClawCallback,
      resolveCallbackContext: explicitRoute
        ? () => undefined
        : resolveTerminalWatchOpenClawCallbackContext,
      canDeliverCallback: createWatchCallbackDeliveryEligibility(
        options,
        explicitRoute
      ),
      deliver: (input) => {
        if (callback.deliverTransport) {
          return callback.deliverTransport(input);
        }
        const metadata = isRecord(input.envelope.event.metadata)
          ? input.envelope.event.metadata
          : {};
        const agent = metadata.agent;
        if (agent !== "codex" && agent !== "claude") {
          return {
            disposition: "permanent_failure",
            error_code: "terminal_watch_callback_agent_invalid"
          };
        }
        const manualInteraction = metadata.manual_interaction;
        if (manualInteraction !== undefined) {
          try {
            assertTerminalWatchManualInteractionSummary(manualInteraction);
          } catch {
            return {
              disposition: "permanent_failure",
              error_code: "terminal_watch_callback_interaction_invalid"
            };
          }
        }
        callback.deliver({
          watchId: input.envelope.source.kind === "terminal_watch"
            ? input.envelope.source.watch_id
            : "",
          idempotencyKey: input.envelope.idempotency_key,
          event: input.envelope.event.type as TerminalWatchCallbackEvent,
          agent,
          terminalId: input.envelope.source.kind === "terminal_watch"
            ? input.envelope.source.terminal_id
            : "",
          openclawSession: input.route.controller_session_id,
          openclawBin: typeof input.context?.legacyOptions?.openclawBin ===
              "string"
            ? input.context.legacyOptions.openclawBin
            : undefined,
          origin: metadata.watch_origin === "user_selected_terminal" ||
              metadata.watch_origin === "terminal_activity_fallback" ||
              metadata.watch_origin === "terminal_user_explicit_fallback"
            ? metadata.watch_origin
            : undefined,
          detail: typeof metadata.reason_code === "string"
            ? metadata.reason_code
            : undefined,
          manualInteraction,
          completionText: typeof metadata.completion_text === "string"
            ? metadata.completion_text
            : undefined
        });
        return {
          disposition: "accepted",
          accepted_at: dependencies.now().toISOString(),
          acceptance_id: input.envelope.delivery_id
        };
      }
    });
  }

  async function prepareUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    terminal: UserExplicitFallbackWatchTarget;
    requestHash: string;
    requestText?: string;
    messageId: string;
    physicalToken: string;
  }): Promise<PreparedUserExplicitFallbackWatch | undefined> {
    let callbackRoute = callbackRouteForUserExplicitFallback(input.options);
    if (!callbackRoute) return undefined;
    await bestEffortStabilizePriorFallbackWatch(
      input.options,
      input.terminal.conversationId,
      input.requestHash
    );
    const observed = await exactTerminalForWatch(
      input.terminal.conversationId,
      input.options,
      dependencies
    );
    const rawTerminal = observed.rawTerminal;
    assertSameUserExplicitFallbackTerminal(input.terminal, rawTerminal);
    const warnings: string[] = [];
    let anchor: PreparedUserExplicitFallbackWatch["anchor"];
    try {
      const agentVersion = requiredString(
        rawTerminal.agent_version,
        "running coding-agent version"
      );
      anchor = input.terminal.agent === "codex"
        ? await captureCodexFallbackWatchAnchor(input, rawTerminal, agentVersion, dependencies)
        : captureClaudeFallbackWatchAnchor(input, rawTerminal, agentVersion, dependencies);
    } catch (error) {
      // A failed/uncertain native-input transaction is not an observation
      // failure. Never turn it into permission to dispatch the user's task.
      if (unsafeFallbackWatchPreparation(error)) throw error;
      const current = await exactTerminalForWatch(
        input.terminal.conversationId, input.options, dependencies
      );
      assertSameUserExplicitFallbackTerminal(input.terminal, current.rawTerminal);
      anchor = createAutomaticActivityWatchAnchor({
        capturedAt: dependencies.now(), terminalId: input.terminal.conversationId,
        pid: input.terminal.pid, requestHash: input.requestHash,
        before: rawTerminal, current: current.rawTerminal,
        previousWorkspace: terminalWorkspace(rawTerminal),
        currentWorkspace: terminalWorkspace(current.rawTerminal),
        control: terminalControlForWatch(current.rawTerminal)
      });
      callbackRoute = terminalWatchNotificationOnlyRoute(callbackRoute);
      warnings.push(
        `exact_task_anchor_unavailable: ${safeDiagnostic(error)}`,
        "terminal_activity_fallback: observing post-Send terminal/process activity; stable idle is not exact task completion"
      );
    }
    return {
      watchId: terminalUserExplicitFallbackWatchId({
        messageId: input.messageId,
        physicalToken: input.physicalToken,
        requestHash: input.requestHash
      }),
      terminalId: input.terminal.conversationId,
      agent: input.terminal.agent,
      pid: input.terminal.pid,
      terminalEndpoint: terminalControlEvidence(
        input.terminal.terminalControl
      ),
      terminalIdentity: terminalWatchIdentity(
        rawTerminal,
        input.physicalToken
      ),
      physicalToken: input.physicalToken,
      requestHash: input.requestHash,
      callbackRoute,
      openclawSession: callbackRoute.controller_session_id,
      openclawBin: stringValue(input.options.openclawBin) ?? "openclaw",
      ...(warnings.length > 0 ? { warnings } : {}),
      timeoutMs: positiveMinutes(
        input.options.hardTimeoutMinutes ??
          input.options.agentHardTimeoutMinutes,
        DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES
      ) * 60_000,
      anchor
    };
  }

  async function attachUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    prepared: PreparedUserExplicitFallbackWatch;
  }): Promise<UserExplicitFallbackWatchReceipt> {
    let observed: ExactTerminalWatchObservation | undefined;
    try {
      observed = await dependencies.observeExactTerminal({
        options: input.options,
        terminalId: input.prepared.terminalId
      });
    } catch {
      // Observation itself is best effort after the user's physical Send.
      // Persist the exact pre-Send identity: native evidence may recover a
      // result; activity Watches must wait for a matching live observation.
    }
    if (observed?.state === "available") {
      assertPreparedFallbackTerminal(input.prepared, observed.rawTerminal);
    }
    // An absent or temporarily unavailable terminal after Enter is not a
    // callback veto. Exact anchors may recover an on-disk completion;
    // activity anchors preserve their process fence and can only report loss
    // or resume observation, never infer completion from disappearance.
    const service = serviceFor(input.options);
    let watch: TerminalWatch;
    try {
      watch = service.create({
        watch_id: input.prepared.watchId,
        agent: input.prepared.agent,
        terminal: input.prepared.terminalIdentity,
        anchor: input.prepared.anchor,
        warnings: input.prepared.warnings,
        callback_route: input.prepared.callbackRoute,
        openclaw_session: input.prepared.openclawSession,
        openclaw_bin: input.prepared.openclawBin,
        timeout_ms: input.prepared.timeoutMs
      });
    } catch (error) {
      const existing = service.list().find((candidate) =>
        candidate.watch_id === input.prepared.watchId
      );
      if (
        !existing ||
        !isAutomaticSendWatch(existing) ||
        existing.anchor.anchor_fingerprint !==
          input.prepared.anchor.anchor_fingerprint
      ) {
        throw error;
      }
      watch = existing;
    }
    return automaticSendWatchReceipt(watch);
  }

  async function bestEffortStabilizePriorFallbackWatch(
    options: TerminalWatchCliOptions,
    terminalId: string,
    requestHash: string
  ): Promise<void> {
    try {
      const service = serviceFor(options);
      const prior = service.list().filter((watch) =>
        watch.status === "active" &&
        isUserExplicitFallbackWatch(watch) &&
        watch.terminal.terminal_id === terminalId &&
        watch.anchor.request_hash === requestHash
      );
      for (const watch of prior) {
        try {
          await service.reconcile(watch.watch_id);
        } catch {
          // A prior callback must never delay or veto the new user Send.
        }
      }
    } catch {
      // Store or observer failure is callback-only degradation. The caller
      // still captures the new pre-Send anchor and physical Send proceeds.
    }
  }

  function userExplicitFallbackWatchReceipt(input: {
    options: TerminalWatchCliOptions;
    watchId: string;
  }): UserExplicitFallbackWatchReceipt | undefined {
    try {
      const watch = serviceFor(input.options).get(input.watchId);
      if (!isAutomaticSendWatch(watch) || !watch.callback_route) {
        return undefined;
      }
      return automaticSendWatchReceipt(watch);
    } catch {
      return undefined;
    }
  }

  async function runWatch(options: TerminalWatchCliOptions): Promise<void> {
    const terminalId = requiredString(options.terminal, "--terminal");
    const callbackRoute = Object.hasOwn(options, "callbackRoute")
      ? parseCallbackRoute(options.callbackRoute)
      : undefined;
    const openclawSession = callbackRoute?.controller_session_id ??
      requiredString(options.openclawSession, "--openclaw-session");
    const observed = await exactTerminalForWatch(
      terminalId,
      options,
      dependencies
    );
    const rawTerminal = observed.rawTerminal;
    const projectedTerminal = observed.terminal;
    // Endpoint evidence is the only indispensable observation authority. A
    // manual Watch is read-only and therefore does not acquire terminal input
    // authority or depend on managed-Turn ownership.
    const terminalControl = terminalControlForWatch(rawTerminal);
    const agent = terminalAgent(rawTerminal);
    const warnings: string[] = [];
    let anchor: TerminalWatchAnchor | undefined;
    try {
      anchor = agent === "codex" && isCodexPaginatedReadCandidate(rawTerminal.agent_version)
        ? await capturePaginatedWatchAnchorWithLock(rawTerminal, options, dependencies)
        : captureTerminalWatchAnchor(
        agent,
        rawTerminal,
        options,
        dependencies
      );
    } catch (error) {
      warnings.push(
        `exact_task_anchor_unavailable: ${safeDiagnostic(error)}`
      );
    }
    if (anchor) {
      warnings.push(...watchAnchorVersionWarnings(anchor, rawTerminal));
    } else {
      if (!terminalControl.capabilities.includes("screen_status")) {
        throw new Error(
          "the exact terminal has neither a durable task anchor nor a " +
          "read-only screen-status observation path; no effective Watch " +
          "can be created"
        );
      }
      if (warnings.length === 0) {
        warnings.push(
          "exact_task_anchor_unavailable: no unique supported task anchor was present"
        );
      }
      const initialActivityState = terminalActivityState(projectedTerminal);
      anchor = createTerminalActivityWatchAnchor({
        capturedAt: dependencies.now(),
        terminalId,
        pid: positiveInteger(rawTerminal.pid, "terminal PID"),
        initialActivityState,
        nativeProcessUuid: stringValue(rawTerminal.native_agent_process_uuid),
        nativeProcessBirth: stringValue(rawTerminal.native_agent_process_birth),
        agentVersion: stringValue(rawTerminal.agent_version)
      });
      warnings.push(
        "terminal_activity_fallback: observing the exact terminal/process activity epoch instead of claiming exact task completion"
      );
      if (initialActivityState === "idle" || initialActivityState === "unknown") {
        warnings.push(
          "terminal_activity_armed_for_next_activity: no active epoch is visible yet; Watch will wait to observe working or approval activity before stable idle can settle"
        );
      }
    }
    const binding = bestEffortBindingTokenForWatch(rawTerminal);
    if (binding.warning) warnings.push(binding.warning);
    const terminalIdentity = terminalWatchIdentity(rawTerminal, binding.token);
    const repository = createTerminalWatchStore(
      dependencies.storeDirFromOptions(options),
      { acquire: dependencies.acquireFileLock }
    );
    let existingCandidates: TerminalWatch[] = [];
    let discoveryWarnings: string[] = [];
    try {
      const scan = repository.scanForReconciliation();
      existingCandidates = scan.watches;
      if (scan.errors.length > 0) {
        discoveryWarnings = [
          `terminal_watch_store_entries_skipped: ignored ${scan.errors.length} ` +
          "invalid sibling Watch record(s) during idempotent discovery"
        ];
      }
    } catch (error) {
      discoveryWarnings = [
        `terminal_watch_store_discovery_unavailable: ${safeDiagnostic(error)}; ` +
        "attempting the user-requested read-only Watch anyway"
      ];
    }
    warnings.push(...discoveryWarnings);
    const watchService = serviceFor(options);
    const openclawBin = stringValue(options.openclawBin) ?? "openclaw";
    const existing = existingCandidates.find((candidate) =>
      sameManualWatchTarget(candidate, agent, terminalIdentity, anchor) &&
      sameManualWatchCallbackAuthority(
        candidate,
        callbackRoute,
        openclawSession,
        openclawBin
      )
    );
    const watch = existing ?? watchService.create({
      agent,
      terminal: terminalIdentity,
      anchor,
      warnings,
      ...(callbackRoute === undefined
        ? {}
        : { callback_route: callbackRoute }),
      openclaw_session: openclawSession,
      openclaw_bin: openclawBin,
      timeout_ms: positiveMinutes(
        options.hardTimeoutMinutes,
        DEFAULT_TERMINAL_WATCH_HARD_TIMEOUT_MINUTES
      ) * 60_000,
      approval_fingerprint: approvalFingerprint(projectedTerminal),
      approval_reason_code: approvalFingerprint(projectedTerminal)
        ? "terminal_waiting_for_approval"
        : undefined
    });
    dependencies.printJson({
      watch: publicTerminalWatch(watch, existing ? discoveryWarnings : [])
    });
  }

  async function runUnwatch(options: TerminalWatchCliOptions): Promise<void> {
    const service = serviceFor(options);
    const watch = service.cancel(requiredWatchId(options.watch));
    dependencies.printJson({ watch: publicTerminalWatch(watch) });
  }

  const runWatchStatus = createTerminalWatchStatusRunner(dependencies, serviceFor);
  const runRespondInteraction =
    createTerminalWatchInteractionResponder(dependencies, serviceFor);
  async function runReconcileWatches(
    options: TerminalWatchCliOptions
  ): Promise<void> {
    dependencies.printJson(await serviceFor(options).reconcileAll());
  }

  function listPublicWatches(
    storeDir: string,
    options: { includeAll?: boolean } = {}
  ): Array<Record<string, unknown>> {
    const service = serviceFor({ storeDir });
    return publicTerminalWatches(service.list(), options);
  }

  function scanPublicWatchesForExactObservation(
    storeDir: string,
    options: { includeAll?: boolean } = {}
  ): {
    watches: Array<Record<string, unknown>>;
    activeOverlayTrusted: boolean;
  } {
    const repository = createTerminalWatchStore(storeDir, {
      acquire: dependencies.acquireFileLock
    });
    const scan = repository.scanForReconciliation();
    return {
      watches: publicTerminalWatches(scan.watches, options),
      activeOverlayTrusted: scan.errors.length === 0
    };
  }

  function publicTerminalWatches(
    watches: readonly TerminalWatch[],
    options: { includeAll?: boolean }
  ): Array<Record<string, unknown>> {
    return watches
      .filter((watch) => options.includeAll || watch.status === "active")
      .map((watch) => publicTerminalWatch(watch));
  }

  return Object.freeze({
    prepareUserExplicitFallbackWatch,
    attachUserExplicitFallbackWatch,
    userExplicitFallbackWatchReceipt,
    runWatch,
    runUnwatch,
    runWatchStatus,
    runRespondInteraction,
    runReconcileWatches,
    listPublicWatches,
    scanPublicWatchesForExactObservation
  });
}

function createWatchCallbackDeliveryEligibility(
  options: TerminalWatchCliOptions,
  explicitRoute: CallbackRouteV1 | undefined
): (watch: TerminalWatch, persistedRoute: CallbackRouteV1 | undefined) => boolean {
  return (watch, persistedRoute) => {
    const route = persistedRoute ??
      resolveTerminalWatchOpenClawCallback(watch).route;
    return explicitRoute
      ? hostProfileCallbackRouteMatchesRuntime(route, {
          callbackRoute: explicitRoute,
          controllerScope: options.callbackRouteControllerScope ?? "startup_v1"
        })
      : route.transport === "openclaw_gateway_v1";
  };
}

function createTerminalWatchStatusRunner(
  dependencies: TerminalWatchCliDependencies,
  serviceFor: (options: TerminalWatchCliOptions) => TerminalWatchService
): (options: TerminalWatchCliOptions) => Promise<void> {
  return async (options) => {
    const service = serviceFor(options);
    const watchId = requiredWatchId(options.watch);
    const interactionAccess = watchStatusInteractionAccess(
      service.get(watchId),
      options
    );
    const watch = await service.reconcile(watchId);
    dependencies.printJson({
      watch: publicTerminalWatch(watch, [], interactionAccess)
    });
  };
}

/**
 * A shared native-Host lifecycle owns no single controller session. Bind its
 * trusted Profile template to the exact session captured when this Watch was
 * created; the callback router will still verify Profile identity/revision.
 */
function routeBoundWatchCallbackRoute(
  template: CallbackRouteV1,
  watch: Pick<TerminalWatch, "openclaw_session">
): CallbackRouteV1 {
  return Object.freeze({
    ...parseCallbackRoute(template),
    controller_session_id: watch.openclaw_session
  });
}

function callbackRouteForUserExplicitFallback(
  options: TerminalWatchCliOptions
): CallbackRouteV1 | undefined {
  if (Object.hasOwn(options, "callbackRoute")) {
    return parseCallbackRoute(options.callbackRoute);
  }
  // gatewayMethod describes the managed Send callback protocol. Its presence
  // proves this invocation came from a legacy OpenClaw controller, but a
  // Terminal Watch callback has its own fixed chat.send transport contract.
  if (!stringValue(options.gatewayMethod)) return undefined;
  // Terminal Watch state intentionally persists neither Gateway URLs nor
  // secrets. A caller that needs either must provide an explicit Host route;
  // user Send still proceeds when this best-effort callback cannot attach.
  if (stringValue(options.gatewayUrl) || stringValue(options.token)) {
    return undefined;
  }
  const controllerSessionId = stringValue(options.gatewaySession) ??
    stringValue(options.openclawSession);
  if (!controllerSessionId) return undefined;
  return createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId,
    openclawBin: options.openclawBin,
    respond: true
  });
}

function sameManualWatchCallbackAuthority(
  watch: TerminalWatch,
  callbackRoute: CallbackRouteV1 | undefined,
  openclawSession: string,
  openclawBin: string
): boolean {
  if (watch.openclaw_session !== openclawSession) return false;
  if (callbackRoute === undefined) {
    return watch.callback_route === undefined &&
      watch.openclaw_bin === openclawBin;
  }
  return watch.callback_route !== undefined &&
    callbackRouteFingerprint(watch.callback_route) ===
      callbackRouteFingerprint(callbackRoute);
}

function watchStatusInteractionAccess(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions
): boolean {
  if (!Object.hasOwn(options, "openclawSession")) return false;
  const requested = stringValue(options.openclawSession);
  if (!requested || requested !== watch.openclaw_session) {
    throw new Error(
      `terminal Watch ${watch.watch_id} belongs to a different controller session; executable interaction details were not disclosed`
    );
  }
  return true;
}

export type { TerminalWatchCliOptions, UserExplicitFallbackWatchTarget, PreparedUserExplicitFallbackWatch, TerminalWatchCliDependencies, TerminalWatchCliFacade } from "./terminal-watch-cli-contract.js";

export type { UserExplicitFallbackWatchReceipt } from "./terminal-watch-send-activity.js";

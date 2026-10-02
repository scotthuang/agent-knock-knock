/** Watch interaction response transaction; retains terminal, Store, and Watch lock order. */
import { respondCodexPaginatedAsyncQuestion } from "./codex-paginated-async-response.js";
import {
  publicTerminalWatch,
  terminalWatchCapturedAgentVersion
} from "./terminal-watch-presentation.js";
import { refreshPaginatedResponseForeground } from "./codex-paginated-watch.js";
import { respondCodexPaginatedBlockingQuestion } from "./codex-paginated-questionnaire-runtime.js";
import {
  TerminalInteractionDispatchReservedError,
  TerminalInteractionInputNotStartedError,
  type TerminalInteractionAuthorizationContext,
  type TerminalInteractionAuthorizationDecision,
  type TerminalInteractionResponseExecution
} from "./terminal-agent-bridge.js";
import {
  hashTerminalInteractionResponse,
  reduceTerminalInteractionAggregate
} from "./terminal-interaction-core.js";
import { validateTerminalInteractionSubjectResponse } from "./terminal-interaction-protocol.js";
import {
  executeTerminalInteractionResponseTransaction
} from "./terminal-interaction-response-transaction.js";
import { terminalInteractionRuntimeForWatch } from "./terminal-watch-interaction-runtime.js";
import {
  consumeWatchInteractionResponse,
  settleWatchInteractionResponseFailure,
  type WatchInteractionResponseReservation
} from "./terminal-watch-interaction-response-store.js";
import type { TerminalWatchService } from "./terminal-watch-service.js";
import { createTerminalWatchStore, terminalWatchRevision } from "./terminal-watch-store.js";
import type {
  TerminalWatchCliOptions,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";
import {
  exactTerminalForWatch,
  terminalControlForWatch,
  terminalMatchesWatch,
  requiredWatchId,
  requiredString,
  requiredSha256,
  requiredTimestamp,
  parseWatchInteractionResponse,
  assertWatchControllerSession,
  requiredExecutableWatchInteraction,
  sha256
} from "./terminal-watch-terminal-identity.js";
import { terminalWatchResponseDecision } from "./terminal-watch-response-authority.js";

export function createTerminalWatchInteractionResponder(
  dependencies: TerminalWatchCliDependencies,
  serviceFor: (options: TerminalWatchCliOptions) => TerminalWatchService
): (options: TerminalWatchCliOptions) => Promise<void> {
  return async function runRespondInteraction(
    options: TerminalWatchCliOptions
  ): Promise<void> {
    const watchId = requiredWatchId(options.watch);
    const interactionId = requiredString(
      options.interaction,
      "--interaction is required"
    );
    const expectedFingerprint = requiredSha256(
      options.expectedInteractionFingerprint,
      "interaction prompt fingerprint"
    );
    const expectedExpiresAt = requiredTimestamp(
      options.expectedInteractionExpiresAt,
      "--expected-interaction-expires-at"
    );
    const responseValue = parseWatchInteractionResponse(options.responseJson);
    const storeDir = dependencies.storeDirFromOptions(options);
    const repository = createTerminalWatchStore(storeDir, {
      acquire: dependencies.acquireFileLock
    });
    const service = serviceFor(options);
    const displayed = await service.reconcile(watchId);
    assertWatchControllerSession(displayed, options.openclawSession);
    const displayedInteraction = requiredExecutableWatchInteraction(
      displayed,
      interactionId,
      expectedFingerprint
    );
    const response = validateTerminalInteractionSubjectResponse(
      responseValue,
      displayedInteraction.projection,
      { now: dependencies.now(), allowExpiredForLiveRecapture: true }
    );
    if (
      response.subject.kind !== "terminal_watch" ||
      response.subject.watch_id !== watchId
    ) {
      throw new Error("--response-json subject watch_id does not match --watch");
    }
    const exact = await exactTerminalForWatch(
      displayed.terminal.terminal_id,
      options,
      dependencies
    );
    if (!terminalMatchesWatch(exact.rawTerminal, displayed)) {
      throw new Error(
        "terminal Watch identity changed before interaction response; refresh status"
      );
    }
    const terminalControl = terminalControlForWatch(exact.rawTerminal);
    const releaseTerminal = dependencies.acquireTerminalLock(
      storeDir,
      terminalControl
    );
    try {
      const withWriterLease = dependencies.withStoreWriterLeaseAsync ??
        (async <Result>(
          _storeDir: string,
          operation: () => Promise<Result>
        ): Promise<Result> => operation());
      await withWriterLease(storeDir, async () => {
        let current = repository.load(watchId);
        assertWatchControllerSession(current, options.openclawSession);
        const executableInteraction = requiredExecutableWatchInteraction(
          current,
          interactionId,
          expectedFingerprint
        );
        const decision = terminalWatchResponseDecision(
          current,
          exact.rawTerminal,
          executableInteraction.projection.surface_id,
          executableInteraction.projection.prompt_fingerprint,
          options,
          dependencies
        );
        if (!decision.executable || decision.suppress) {
          throw new Error(
            "a higher-priority terminal interaction responder owns this live questionnaire; refresh status"
          );
        }
        const version = terminalWatchCapturedAgentVersion(current) ??
          requiredString(
            exact.rawTerminal.agent_version,
            "running coding-agent version"
          );
        const runtime = terminalInteractionRuntimeForWatch({
          watch: current,
          rawTerminal: exact.rawTerminal,
          checkpoint: current.observation_checkpoint,
          version,
          terminalTarget: terminalControl.target,
          responseAuthority: "executable"
        });
        const bridge = dependencies.createBridge?.(options);
        if (!bridge) {
          throw new Error("terminal interaction bridge is unavailable");
        }
        if (runtime.codexPaginatedThread && executableInteraction.projection.kind === "async_question") {
          await refreshPaginatedResponseForeground(bridge, terminalControl, runtime, dependencies.now);
        }
        const attemptId = dependencies.randomUUID();
        const responseHash = hashTerminalInteractionResponse(response);
        const reservation = { attemptId, responseHash };
        const result = await executeTerminalInteractionResponseTransaction<
          TerminalInteractionAuthorizationContext,
          TerminalInteractionAuthorizationDecision,
          WatchInteractionResponseReservation,
          TerminalInteractionResponseExecution
        >({
          reservationFailureFence: "confirmed",
          dispatch: (hooks) => "schema" in current.observation_checkpoint &&
              current.observation_checkpoint.schema === "agent-knock-knock/codex-paginated-task-checkpoint" &&
              executableInteraction.projection.kind === "questionnaire"
            ? respondCodexPaginatedBlockingQuestion({
                watch: current, checkpoint: current.observation_checkpoint, terminalControl,
                response, expectedFingerprint, now: dependencies.now,
                authorize: hooks.authorize, beforeDispatch: hooks.beforeDispatch,
                persistDraft: (draft) => {
                  current = repository.withWriterLease((scope) => scope.withWatchLock(watchId, () => {
                    const latest = scope.load(watchId);
                    const checkpoint = latest.observation_checkpoint;
                    if (!("schema" in checkpoint) || checkpoint.schema !== "agent-knock-knock/codex-paginated-task-checkpoint") {
                      throw new Error("Codex blocking question checkpoint changed");
                    }
                    const nextCheckpoint = { ...checkpoint };
                    if (draft) nextCheckpoint.blocking_question_draft = draft;
                    else delete nextCheckpoint.blocking_question_draft;
                    return scope.save({ ...latest,
                      observation_checkpoint: nextCheckpoint,
                      updated_at: dependencies.now().toISOString()
                    }, { expectedRevision: terminalWatchRevision(latest) });
                  }));
                }
              })
            : runtime.codexPaginatedThread && executableInteraction.projection.kind === "async_question"
              ? respondCodexPaginatedAsyncQuestion({
                  bridge, terminalControl, terminalEvidence: current.terminal.terminal_endpoint,
                  runtime, response, now: dependencies.now,
                  options: { agentVersion: version, expectedFingerprint, expectedExpiresAt,
                    scrollbackLines: Number(options.scrollbackLines ?? 120), runtime,
                    authorize: hooks.authorize, beforeDispatch: hooks.beforeDispatch }
                })
            : bridge.respondInteraction(
            current.agent,
            terminalControl,
            response,
            {
              agentVersion: version,
              expectedFingerprint,
              expectedExpiresAt,
              scrollbackLines: Number(options.scrollbackLines ?? 120),
              runtime,
              authorize: hooks.authorize,
              beforeDispatch: hooks.beforeDispatch
            }
          ),
          authorize: ({ projection, fingerprint }) => {
            const latest = repository.load(watchId);
            const interaction = requiredExecutableWatchInteraction(
              latest,
              interactionId,
              expectedFingerprint
            );
            const latestDecision = terminalWatchResponseDecision(
              latest,
              exact.rawTerminal,
              interaction.projection.surface_id,
              interaction.projection.prompt_fingerprint,
              options,
              dependencies
            );
            return projection.interaction_id === interactionId &&
                fingerprint === expectedFingerprint &&
                interaction.projection.subject.kind === "terminal_watch" &&
                projection.version === 2 &&
                projection.subject.kind === "terminal_watch" &&
                projection.subject.watch_id === watchId &&
                latestDecision.executable && !latestDecision.suppress
              ? { approved: true }
              : {
                  approved: false,
                  reason:
                    "terminal Watch interaction authority changed before response"
                };
          },
          createReservation: () => reservation,
          reserve: ({ projection, fingerprint }, receipt, confirm) => {
            current = repository.withWriterLease((scope) =>
              scope.withWatchLock(watchId, () => {
                const latest = scope.load(watchId);
                const interaction = requiredExecutableWatchInteraction(
                  latest,
                  interactionId,
                  expectedFingerprint
                );
                if (
                  projection.interaction_id !== interactionId ||
                  fingerprint !== expectedFingerprint ||
                  interaction.aggregate.state !== "pending"
                ) {
                  throw new Error(
                    "terminal Watch interaction authority changed before dispatch"
                  );
                }
                const dispatchDecision = terminalWatchResponseDecision(
                  latest,
                  exact.rawTerminal,
                  interaction.projection.surface_id,
                  interaction.projection.prompt_fingerprint,
                  options,
                  dependencies
                );
                if (!dispatchDecision.executable || dispatchDecision.suppress) {
                  throw new TerminalInteractionInputNotStartedError(
                    "terminal Watch interaction ownership changed before dispatch"
                  );
                }
                const reservedAt = dependencies.now().toISOString();
                const aggregate = reduceTerminalInteractionAggregate(
                  interaction.aggregate,
                  {
                    type: "reserve",
                    attempt_id: receipt.attemptId,
                    response_hash: receipt.responseHash,
                    at: reservedAt
                  }
                );
                const saved = scope.save({
                  ...latest,
                  current_interaction: {
                    projection: interaction.projection,
                    aggregate
                  },
                  updated_at: reservedAt
                }, { expectedRevision: terminalWatchRevision(latest) });
                // Match the predecessor's commit boundary: a later lock
                // release failure must still settle this durable receipt.
                confirm();
                return saved;
              }));
          },
          release: (receipt) => {
            current = settleWatchInteractionResponseFailure(
              repository,
              {
                watchId,
                interactionId,
                reservation: receipt,
                state: "release",
                now: dependencies.now
              }
            );
          },
          releaseFailure: (_receipt, _error, releaseError) => releaseError,
          markUncertain: (receipt) => {
            current = settleWatchInteractionResponseFailure(
              repository,
              {
                watchId,
                interactionId,
                reservation: receipt,
                state: "response_uncertain",
                now: dependencies.now
              }
            );
          },
          consume: (receipt) => {
            current = consumeWatchInteractionResponse(
              repository,
              {
                watchId,
                interactionId,
                reservation: receipt,
                now: dependencies.now,
                notificationFingerprint: sha256
              }
            );
          },
          responded: (execution) => execution.responded,
          isInputNotStarted: (error) =>
            error instanceof TerminalInteractionInputNotStartedError,
          duplicateReservationError: () => new Error(
            "terminal Watch interaction response was already reserved"
          ),
          inputNotStartedError: (error) => error,
          missingReservationError: () =>
            new TerminalInteractionDispatchReservedError(
              "reservation_uncertain",
              "terminal Watch response was dispatched without a durable reservation"
            )
        });
        const execution = result.execution;
        if (result.state === "blocked") {
          dependencies.printJson({
            watch: publicTerminalWatch(current, [], true),
            interaction_id: interactionId,
            responded: false,
            blocked: execution.blocked,
            reason: execution.reason
          });
          return;
        }
        dependencies.printJson({
          watch: publicTerminalWatch(current, [], true),
          interaction_id: interactionId,
          responded: true,
          blocked: false,
          question_id: execution.questionId,
          response_kind: execution.responseKind,
          outcome: execution.outcome
        });
      });
    } finally {
      releaseTerminal();
    }
  }
}

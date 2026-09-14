import { reduceTerminalInteractionAggregate } from
  "./terminal-interaction-core.js";
import {
  terminalWatchRevision,
  type TerminalWatch,
  type TerminalWatchStore
} from "./terminal-watch-store.js";

export interface WatchInteractionResponseReservation {
  readonly attemptId: string;
  readonly responseHash: string;
}

export function settleWatchInteractionResponseFailure(
  repository: TerminalWatchStore,
  input: {
    watchId: string;
    interactionId: string;
    reservation: WatchInteractionResponseReservation;
    state: "release" | "response_uncertain";
    now(): Date;
  }
): TerminalWatch {
  return repository.withWriterLease((scope) =>
    scope.withWatchLock(input.watchId, () => {
      const latest = scope.load(input.watchId);
      const interaction = latest.current_interaction;
      if (
        !interaction ||
        interaction.projection.interaction_id !== input.interactionId ||
        interaction.aggregate.state !== "reserved" ||
        interaction.aggregate.reservation?.attempt_id !==
          input.reservation.attemptId
      ) {
        throw new Error(
          "terminal Watch interaction reservation changed while settling failure"
        );
      }
      const at = input.now().toISOString();
      const aggregate = reduceTerminalInteractionAggregate(
        interaction.aggregate,
        input.state === "release"
          ? { type: "release" }
          : {
              type: "response_uncertain",
              at,
              reason_code: "terminal_dispatch_uncertain"
            }
      );
      const projection = input.state === "release"
        ? interaction.projection
        : {
            ...interaction.projection,
            state: "response_uncertain" as const,
            capabilities: {
              ...interaction.projection.capabilities,
              respond: false
            }
          };
      return scope.save({
        ...latest,
        current_interaction: { projection, aggregate },
        updated_at: at
      }, { expectedRevision: terminalWatchRevision(latest) });
    }));
}

export function consumeWatchInteractionResponse(
  repository: TerminalWatchStore,
  input: {
    watchId: string;
    interactionId: string;
    reservation: WatchInteractionResponseReservation;
    now(): Date;
    notificationFingerprint(value: unknown): string;
  }
): TerminalWatch {
  return repository.withWriterLease((scope) =>
    scope.withWatchLock(input.watchId, () => {
      const latest = scope.load(input.watchId);
      const interaction = latest.current_interaction;
      if (
        !interaction ||
        interaction.projection.interaction_id !== input.interactionId ||
        interaction.aggregate.state !== "reserved" ||
        interaction.aggregate.reservation?.attempt_id !==
          input.reservation.attemptId
      ) {
        throw new Error(
          "terminal Watch interaction reservation changed after dispatch"
        );
      }
      const answeredAt = input.now().toISOString();
      const aggregate = reduceTerminalInteractionAggregate(
        interaction.aggregate,
        {
          type: "consume",
          at: answeredAt,
          reason_code: "terminal_response_dispatched"
        }
      );
      const evidenceFingerprint = input.notificationFingerprint({
        schema: "agent-knock-knock/terminal-watch-interaction-event",
        version: 1,
        watch_id: input.watchId,
        interaction_id: input.interactionId,
        surface_id: interaction.projection.surface_id
      });
      return scope.save({
        ...latest,
        current_interaction: {
          projection: interaction.projection,
          aggregate
        },
        updated_at: answeredAt,
        last_activity_at: answeredAt,
        notification_outbox: latest.notification_outbox.map((notification) =>
          notification.kind === "interaction_required" &&
          notification.evidence_fingerprint === evidenceFingerprint &&
          (notification.status === "pending" ||
            notification.status === "failed")
            ? {
                ...notification,
                status: "superseded" as const,
                superseded_at: answeredAt,
                next_attempt_at: undefined,
                failed_at: undefined,
                last_error_code: undefined
              }
            : notification
        )
      }, { expectedRevision: terminalWatchRevision(latest) });
    }));
}

import {
  createOpenClawCallbackTransport,
  type CallbackProcessDeliveryObservation,
  type OpenClawCallbackTransport
} from "./openclaw-callback-transport.js";
import {
  classifyCallbackProcessFailure,
  type DeliverCallbackInput
} from "./callback-outbox-policy.js";
import {
  parseCallbackRoute,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";
import type { Conversation } from "./protocol.js";
import { redactString } from "./runtime-log.js";
import { appendEvent } from "./store.js";
import { nonBlankString } from "./value-guards.js";

type ResolvedCallbackTransportDelivery = Omit<
  CallbackTransportDeliverInput,
  "reportCheckpoint"
>;

export interface OpenClawManagedCallbackCliAdapterPorts {
  now(): Date;
  environment(): NodeJS.ProcessEnv;
  redactConversation(conversation: Conversation): unknown;
  textSummary(value: unknown): unknown;
  log(
    level: "info" | "warn" | "error",
    event: string,
    fields: Record<string, unknown>
  ): void;
}

export interface OpenClawManagedCallbackCliAdapter {
  transport: OpenClawCallbackTransport;
  resolve(input: DeliverCallbackInput): ResolvedCallbackTransportDelivery;
}

/**
 * Compose the legacy OpenClaw process adapter behind the host-neutral callback
 * transport port. The CLI root supplies runtime capabilities but owns no
 * delivery parsing, logging, or route-resolution policy.
 */
export function createOpenClawManagedCallbackCliAdapter(
  ports: OpenClawManagedCallbackCliAdapterPorts
): OpenClawManagedCallbackCliAdapter {
  const transport = createOpenClawCallbackTransport({
    now: ports.now,
    environment: ports.environment,
    redactConversation: ports.redactConversation,
    recordCallbackProcessDelivery
  });

  return Object.freeze({ transport, resolve });

  function recordCallbackProcessDelivery(
    observation: CallbackProcessDeliveryObservation
  ): void {
    const { logPath, conversation, message, event, runtimeEvent, delivery } =
      observation;
    const detail = observation.detail ?? {};
    appendEvent(logPath, {
      ts: ports.now().toISOString(),
      conversation_id: conversation.conversation_id,
      event,
      from: message.from,
      to: "openclaw",
      round: message.round,
      ...detail,
      status: delivery.status,
      stdout: redactString(delivery.stdout),
      stderr: redactString(delivery.stderr)
    });
    ports.log("info", runtimeEvent, {
      conversation_id: conversation.conversation_id,
      ...detail,
      status: delivery.status,
      failure_kind: classifyCallbackProcessFailure(delivery),
      stdout: ports.textSummary(delivery.stdout),
      stderr: ports.textSummary(delivery.stderr)
    });
  }

  function resolve(
    input: DeliverCallbackInput
  ): ResolvedCallbackTransportDelivery {
    const route = parseCallbackRoute(
      input.route ?? input.options.callbackRoute
    );
    if (!input.envelope) {
      throw new Error("managed callback envelope is required for delivery");
    }
    const attemptNumber = Number(input.attempt?.number);
    const attemptId = nonBlankString(input.attempt?.id);
    if (
      !Number.isSafeInteger(attemptNumber) ||
      attemptNumber < 1 ||
      !attemptId
    ) {
      throw new Error("managed callback attempt identity is invalid");
    }
    return {
      route,
      envelope: input.envelope,
      attempt: { number: attemptNumber, id: attemptId },
      context: {
        statePath: input.statePath,
        logPath: input.logPath,
        conversation: input.conversation,
        message: input.message,
        legacyOptions: {
          gatewayMethod: input.options.gatewayMethod,
          gatewaySession: input.options.gatewaySession,
          openclawSession: input.options.openclawSession,
          openclawBin: input.options.openclawBin,
          gatewayUrl: input.options.gatewayUrl,
          token: input.options.token
        }
      }
    };
  }
}

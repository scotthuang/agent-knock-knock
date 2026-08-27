import type {
  CallbackSpawnSync,
  CallbackWakeAcknowledgement
} from "./openclaw-callback-transport.js";
import {
  createLegacyOpenClawCallbackRoute,
  type CallbackAttemptOutcome,
  type CallbackRouteV1,
  type CallbackTransport,
  type CallbackTransportContextV1,
  type CallbackTransportDeliverInput
} from "./callback-transport.js";
import {
  createOpenClawCallbackTransport,
  parseChatSendAcknowledgement
} from "./openclaw-callback-transport.js";
import {
  terminalWatchCallbackMessage,
  type TerminalWatchCallbackEvent as TerminalWatchCallbackEventType,
  type TerminalWatchCallbackMessageInput,
  type TerminalWatchCallbackResolution
} from "./terminal-watch-service.js";
import type { TerminalWatch } from "./terminal-watch-store.js";

export type TerminalWatchCallbackEvent = TerminalWatchCallbackEventType;

export interface TerminalWatchCallbackInput {
  watchId: string;
  idempotencyKey: string;
  event: TerminalWatchCallbackEvent;
  agent: "codex" | "claude";
  terminalId: string;
  openclawSession?: string;
  openclawBin?: string;
  origin?: TerminalWatchCallbackMessageInput["origin"];
  detail?: string;
  completionText?: string;
}

export type TerminalWatchTransportDeliveryInput =
  CallbackTransportDeliverInput;

export interface TerminalWatchCallbackCliAdapter {
  deliver(input: TerminalWatchCallbackInput): void;
  deliverTransport?(
    input: TerminalWatchTransportDeliveryInput
  ): CallbackAttemptOutcome;
}

export function resolveTerminalWatchOpenClawCallback(
  watch: Pick<TerminalWatch, "openclaw_session" | "openclaw_bin">
): TerminalWatchCallbackResolution {
  return {
    route: {
      ...createLegacyOpenClawCallbackRoute({
        controllerSessionId: watch.openclaw_session,
        gatewayMethod: "chat.send",
        openclawBin: watch.openclaw_bin
      }),
      capabilities: { wake: true, respond: false }
    },
    context: resolveTerminalWatchOpenClawCallbackContext(watch)
  };
}

export function resolveTerminalWatchOpenClawCallbackContext(
  watch: Pick<TerminalWatch, "openclaw_session" | "openclaw_bin">,
  _route?: CallbackRouteV1
): CallbackTransportContextV1 {
  return {
    legacyOptions: {
      gatewayMethod: "chat.send",
      gatewaySession: watch.openclaw_session,
      openclawBin: watch.openclaw_bin
    }
  };
}

export function createTerminalWatchCallbackCliAdapter(
  options: {
    environment?: () => NodeJS.ProcessEnv;
    now?: () => Date;
    spawnSync?: CallbackSpawnSync;
    transport?: CallbackTransport;
  } = {}
): TerminalWatchCallbackCliAdapter {
  const now = options.now ?? (() => new Date());
  const openClawTransport = createOpenClawCallbackTransport({
    now,
    environment: options.environment ?? (() => process.env),
    redactConversation: () => ({}),
    recordCallbackProcessDelivery: () => {},
    ...(options.spawnSync ? { spawnSync: options.spawnSync } : {})
  });
  const deliveryTransport = options.transport ?? openClawTransport;

  return Object.freeze({
    deliver(input) {
      const attempt = attemptOpenClawCallback({
        openclawBin: input.openclawBin,
        sessionKey: requiredString(
          input.openclawSession,
          "Terminal Watch OpenClaw session"
        ),
        message: terminalWatchCallbackMessage(input),
        idempotencyKey: input.idempotencyKey
      });
      if (attempt.disposition !== "accepted") {
        throw new Error(attempt.errorMessage);
      }
    },
    deliverTransport(input): CallbackAttemptOutcome {
      return deliveryTransport.deliver(input);
    }
  });

  function attemptOpenClawCallback(input: {
    openclawBin?: string;
    sessionKey: string;
    message: string;
    idempotencyKey: string;
  }): OpenClawCallbackAttempt {
    const delivery = openClawTransport.deliverChatSend({
      openclawBin: input.openclawBin,
      params: {
        sessionKey: input.sessionKey,
        message: input.message,
        idempotencyKey: input.idempotencyKey,
        deliver: true
      }
    });
    if (delivery.status !== 0) {
      return {
        disposition: "retryable_failure",
        errorMessage: delivery.stderr || delivery.stdout ||
          `Terminal Watch callback failed with status ${delivery.status}`
      };
    }
    let acknowledgement: CallbackWakeAcknowledgement;
    try {
      acknowledgement = parseChatSendAcknowledgement(
        delivery.stdout,
        input.idempotencyKey
      );
    } catch (error) {
      return {
        disposition: "uncertain",
        errorMessage: error instanceof Error ? error.message : String(error)
      };
    }
    if (
      acknowledgement.status === "error" ||
      acknowledgement.status === "timeout"
    ) {
      return {
        disposition: "retryable_failure",
        errorMessage:
          `Terminal Watch chat.send was not accepted: ${acknowledgement.status}`
      };
    }
    return { disposition: "accepted", acknowledgement };
  }
}

type OpenClawCallbackAttempt =
  | {
      disposition: "accepted";
      acknowledgement: CallbackWakeAcknowledgement;
    }
  | {
      disposition: "retryable_failure" | "uncertain";
      errorMessage: string;
    };

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

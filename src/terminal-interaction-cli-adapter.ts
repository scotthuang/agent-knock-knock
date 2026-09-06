import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  executorForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import type {
  TerminalControlRef,
  TerminalRuntimeIdentity
} from "./terminal-agent-adapter.js";
import {
  TerminalInteractionDispatchReservedError,
  type TerminalAgentBridge,
  type TerminalInteractionResponseExecution
} from "./terminal-agent-bridge.js";
import type { TerminalInteractionResponse } from
  "./terminal-interaction-protocol.js";
import { isRecord, nonBlankString } from "./value-guards.js";

type InteractionCliOptions = Record<string, unknown>;

interface LoadedInteractionTurn {
  readonly conversation: Conversation;
  readonly statePath: string;
  readonly logPath: string;
}

export interface TerminalInteractionCliDependencies {
  selection: {
    loadConversation(options: InteractionCliOptions): LoadedInteractionTurn;
    terminalControlFromTakeover(value: unknown): TerminalControlRef | undefined;
  };
  authority: {
    runtimeIdentity(
      conversation: Conversation,
      terminalControl: TerminalControlRef
    ): TerminalRuntimeIdentity;
    assertTurnBindingCurrent(conversation: Conversation, operation: string): void;
    assertManagedTerminalDispatchOwner(input: {
      storeDir: string;
      conversation: Readonly<{ conversation_id: string }>;
      terminalControl: TerminalControlRef;
      action: string;
    }): void;
    sameTerminalIncarnation(
      left: TerminalControlRef,
      right: TerminalControlRef
    ): boolean;
  };
  terminal: {
    createBridge(options: InteractionCliOptions): TerminalAgentBridge;
  };
  repository: {
    loadState(statePath: string): Conversation;
    saveState(statePath: string, conversation: Conversation): void;
    appendEvent(logPath: string, event: Record<string, unknown>): void;
    storeDirForConversationDir(conversationDir: string): string;
    withLockedTurn<Result>(input: {
      storeDir: string;
      terminalControl: TerminalControlRef;
      statePath: string;
      logPath: string;
      operation(): Promise<Result>;
    }): Promise<Result>;
  };
  monitor: {
    ensureAfterResponse(input: {
      conversation: Conversation;
      statePath: string;
      logPath: string;
      terminalControl: TerminalControlRef;
      options: InteractionCliOptions;
      reason: string;
    }): { monitorPid?: number };
  };
  runtime: {
    now(): Date;
    printJson(value: Record<string, unknown>): void;
    log(
      level: "info" | "warn" | "error",
      event: string,
      fields: Record<string, unknown>
    ): void;
  };
}

export interface TerminalInteractionCliFacade {
  runRespondInteraction(options: InteractionCliOptions): Promise<void>;
}

export function createTerminalInteractionCliAdapter(
  dependencies: TerminalInteractionCliDependencies
): TerminalInteractionCliFacade {
  return Object.freeze({
    runRespondInteraction: (options) =>
      runRespondInteraction(dependencies, options)
  });
}

async function runRespondInteraction(
  dependencies: TerminalInteractionCliDependencies,
  options: InteractionCliOptions
): Promise<void> {
  const turnSelector = requiredString(
    options.turn ?? options.conversation ?? options.conversationId,
    "--turn is required"
  );
  const interactionId = requiredString(
    options.interaction,
    "--interaction is required"
  );
  const expectedFingerprint = requiredFingerprint(
    options.expectedInteractionFingerprint
  );
  const expectedExpiresAt = requiredFutureTimestamp(
    options.expectedInteractionExpiresAt,
    dependencies.runtime.now()
  );
  const response = parseInteractionResponse(options.responseJson);
  if (response.turn_id !== turnSelector) {
    throw new Error("--response-json turn_id does not match --turn");
  }
  if (response.interaction_id !== interactionId) {
    throw new Error(
      "--response-json interaction_id does not match --interaction"
    );
  }

  const loaded = dependencies.selection.loadConversation({
    ...options,
    turn: turnSelector,
    conversation: turnSelector
  });
  assertControllerSession(loaded.conversation, options.openclawSession);
  const initialTakeover = takeoverFor(loaded.conversation);
  const storedControl = dependencies.selection.terminalControlFromTakeover(
    initialTakeover
  );
  const pid = positivePid(initialTakeover?.terminal_agent_pid);
  if (!storedControl || pid === undefined) {
    throw new Error(
      `turn ${turnIdForConversation(loaded.conversation)} is not attached to an exact live terminal`
    );
  }
  const agent = executorForConversation(loaded.conversation).kind;
  const bridge = dependencies.terminal.createBridge(options);
  const initiallyResolved = await bridge.resolveStoredTerminal(
    agent,
    pid,
    storedControl,
    dependencies.authority.runtimeIdentity(loaded.conversation, storedControl)
  );
  const storeDir = dependencies.repository.storeDirForConversationDir(
    path.dirname(loaded.statePath)
  );

  await dependencies.repository.withLockedTurn({
    storeDir,
    terminalControl: initiallyResolved.terminalControl,
    statePath: loaded.statePath,
    logPath: loaded.logPath,
    operation: async () => {
      let current = dependencies.repository.loadState(loaded.statePath);
      assertControllerSession(current, options.openclawSession);
      dependencies.authority.assertTurnBindingCurrent(
        current,
        "respond to terminal interaction"
      );
      if (turnIdForConversation(current) !== turnSelector) {
        throw new Error(
          "Turn identity changed while waiting for terminal control; refresh status"
        );
      }
      if (
        current.status !== "waiting_for_agent" &&
        current.status !== "waiting_for_openclaw"
      ) {
        throw new Error(
          `cannot respond to terminal interaction for ${turnSelector}; ` +
          `turn is ${current.status}`
        );
      }
      const currentTakeover = takeoverFor(current);
      const currentControl = dependencies.selection.terminalControlFromTakeover(
        currentTakeover
      );
      if (
        !currentControl ||
        !dependencies.authority.sameTerminalIncarnation(
          currentControl,
          initiallyResolved.terminalControl
        ) ||
        currentTakeover?.terminal_bridge_message_id !==
          initialTakeover?.terminal_bridge_message_id
      ) {
        throw new Error(
          "terminal interaction binding changed while waiting for control; refresh status"
        );
      }
      dependencies.authority.assertManagedTerminalDispatchOwner({
        storeDir,
        conversation: current,
        terminalControl: currentControl,
        action: "respond-interaction"
      });
      const previousDispatch = isRecord(
        currentTakeover?.terminal_bridge_interaction_dispatch
      )
        ? currentTakeover.terminal_bridge_interaction_dispatch
        : undefined;
      if (
        previousDispatch?.state === "reserved" ||
        previousDispatch?.state === "uncertain"
      ) {
        throw new Error(
          "a previous terminal interaction response has an uncertain outcome; inspect the terminal manually"
        );
      }
      if (
        nonBlankString(
          currentTakeover?.terminal_bridge_last_interaction_fingerprint
        ) === expectedFingerprint
      ) {
        throw new Error(
          "terminal interaction fingerprint was already consumed; refresh status"
        );
      }

      const runtime = dependencies.authority.runtimeIdentity(
        current,
        currentControl
      );
      if (!runtime.agentVersion) {
        throw new Error(
          `cannot prove the running ${agent} version for terminal interaction`
        );
      }
      const responseSha256 = createHash("sha256")
        .update(JSON.stringify(response), "utf8")
        .digest("hex");
      let reserved = false;
      let execution: TerminalInteractionResponseExecution;
      try {
        execution = await bridge.respondInteraction(
          agent,
          currentControl,
          response,
          {
            agentVersion: runtime.agentVersion,
            expectedFingerprint,
            expectedExpiresAt,
            scrollbackLines: Number(options.scrollbackLines ?? 120),
            runtime,
            authorize: ({ projection, fingerprint, terminalControl }) => {
              const latest = dependencies.repository.loadState(loaded.statePath);
              const latestTakeover = takeoverFor(latest);
              const latestControl =
                dependencies.selection.terminalControlFromTakeover(
                  latestTakeover
                );
              if (
                turnIdForConversation(latest) !== turnSelector ||
                !latestControl ||
                !dependencies.authority.sameTerminalIncarnation(
                  latestControl,
                  terminalControl
                ) ||
                projection.interaction_id !== interactionId ||
                fingerprint !== expectedFingerprint ||
                latestTakeover?.terminal_bridge_message_id !==
                  currentTakeover?.terminal_bridge_message_id
              ) {
                return {
                  approved: false,
                  reason:
                    "terminal interaction authority changed before response"
                };
              }
              return { approved: true };
            },
            beforeDispatch: ({ projection, fingerprint, terminalControl }) => {
              if (reserved) {
                throw new Error(
                  "terminal interaction response dispatch was already reserved"
                );
              }
              const latest = dependencies.repository.loadState(loaded.statePath);
              current = latest;
              // Entering this hook consumes the caller's one-shot authority.
              // Any exception from here is conservatively persisted as
              // uncertain even when the provider has not yet received input.
              reserved = true;
              const latestTakeover = takeoverFor(latest);
              const latestControl =
                dependencies.selection.terminalControlFromTakeover(
                  latestTakeover
                );
              if (
                turnIdForConversation(latest) !== turnSelector ||
                !latestControl ||
                !dependencies.authority.sameTerminalIncarnation(
                  latestControl,
                  terminalControl
                ) ||
                projection.interaction_id !== interactionId ||
                fingerprint !== expectedFingerprint ||
                Date.parse(expectedExpiresAt) <=
                  dependencies.runtime.now().getTime()
              ) {
                throw new Error(
                  "terminal interaction authority changed before dispatch; refresh status"
                );
              }
              dependencies.authority.assertManagedTerminalDispatchOwner({
                storeDir,
                conversation: latest,
                terminalControl: latestControl,
                action: "respond-interaction"
              });
              const reservedAt = dependencies.runtime.now().toISOString();
              current = {
                ...latest,
                native_session_takeover: {
                  ...latestTakeover,
                  terminal_bridge_interaction_dispatch: {
                    state: "reserved",
                    attempt_id: randomUUID(),
                    interaction_id: interactionId,
                    interaction_prompt_fingerprint: fingerprint,
                    response_sha256: responseSha256,
                    terminal_target: terminalControl.target,
                    terminal_bridge_message_id:
                      latestTakeover?.terminal_bridge_message_id,
                    reserved_at: reservedAt
                  }
                },
                updated_at: reservedAt
              };
              dependencies.repository.saveState(loaded.statePath, current);
            }
          }
        );
      } catch (error) {
        if (reserved) {
          markInteractionResponseUncertain(dependencies, {
            loaded,
            conversation: current,
            interactionId,
            expectedFingerprint,
            responseSha256,
            error
          });
        }
        throw error;
      }

      if (!execution.responded) {
        dependencies.runtime.printJson({
          conversation: current,
          interaction_id: interactionId,
          responded: false,
          blocked: execution.blocked,
          reason: execution.reason,
          terminal_control: currentControl
        });
        return;
      }
      if (!reserved) {
        throw new TerminalInteractionDispatchReservedError(
          "reservation_uncertain",
          "terminal interaction response was dispatched without a durable reservation"
        );
      }
      const answeredAt = dependencies.runtime.now().toISOString();
      const latestTakeover = takeoverFor(current);
      const nextTakeover: Record<string, unknown> = {
        ...latestTakeover,
        terminal_bridge_last_interaction_id: interactionId,
        terminal_bridge_last_interaction_fingerprint: expectedFingerprint,
        terminal_bridge_last_interaction_response_sha256: responseSha256,
        terminal_bridge_last_interaction_at: answeredAt,
        terminal_bridge_last_activity_at: answeredAt,
        terminal_bridge_last_activity_reason:
          "interactive response dispatched"
      };
      delete nextTakeover.terminal_bridge_interaction_dispatch;
      const nextConversation: Conversation = {
        ...current,
        status: "waiting_for_agent",
        native_session_takeover: nextTakeover,
        updated_at: answeredAt
      };
      dependencies.repository.saveState(loaded.statePath, nextConversation);
      dependencies.repository.appendEvent(loaded.logPath, {
        ts: answeredAt,
        conversation_id: nextConversation.conversation_id,
        event: "terminal_interaction_response_send",
        interaction_id: interactionId,
        question_id: execution.questionId,
        response_kind: execution.responseKind,
        outcome: execution.outcome,
        response_sha256: responseSha256,
        interaction_prompt_fingerprint: expectedFingerprint,
        terminal_control: currentControl
      });
      dependencies.runtime.log("info", "terminal_interaction_response_send", {
        conversation_id: nextConversation.conversation_id,
        interaction_id: interactionId,
        question_id: execution.questionId,
        response_kind: execution.responseKind,
        outcome: execution.outcome,
        response_sha256: responseSha256,
        terminal_target: currentControl.target
      });
      const monitor = dependencies.monitor.ensureAfterResponse({
        conversation: nextConversation,
        statePath: loaded.statePath,
        logPath: loaded.logPath,
        terminalControl: currentControl,
        options,
        reason: "interaction_response"
      });
      dependencies.runtime.printJson({
        conversation: nextConversation,
        interaction_id: interactionId,
        responded: true,
        blocked: false,
        question_id: execution.questionId,
        response_kind: execution.responseKind,
        outcome: execution.outcome,
        terminal_control: currentControl,
        monitor_pid: monitor.monitorPid ?? null
      });
    }
  });
}

function markInteractionResponseUncertain(
  dependencies: TerminalInteractionCliDependencies,
  input: {
    loaded: LoadedInteractionTurn;
    conversation: Conversation;
    interactionId: string;
    expectedFingerprint: string;
    responseSha256: string;
    error: unknown;
  }
): void {
  const at = dependencies.runtime.now().toISOString();
  const takeover = takeoverFor(input.conversation);
  const dispatch = isRecord(takeover?.terminal_bridge_interaction_dispatch)
    ? takeover.terminal_bridge_interaction_dispatch
    : {
        interaction_id: input.interactionId,
        interaction_prompt_fingerprint: input.expectedFingerprint,
        response_sha256: input.responseSha256,
        attempt_id: randomUUID(),
        reserved_at: at
      };
  const stalled: Conversation = {
    ...input.conversation,
    status: "stalled",
    native_session_takeover: {
      ...takeover,
      terminal_bridge_interaction_dispatch: {
        ...dispatch,
        state: "uncertain",
        uncertain_at: at,
        reason: "reserved terminal interaction response did not complete"
      },
      terminal_bridge_last_activity_at: at,
      terminal_bridge_last_activity_reason:
        "interactive response outcome uncertain"
    },
    updated_at: at
  };
  dependencies.repository.saveState(input.loaded.statePath, stalled);
  dependencies.repository.appendEvent(input.loaded.logPath, {
    ts: at,
    conversation_id: stalled.conversation_id,
    event: "terminal_interaction_response_uncertain",
    interaction_id: input.interactionId,
    interaction_prompt_fingerprint: input.expectedFingerprint,
    response_sha256: input.responseSha256,
    reason: "reserved terminal interaction response did not complete"
  });
  dependencies.runtime.log("warn", "terminal_interaction_response_uncertain", {
    conversation_id: stalled.conversation_id,
    interaction_id: input.interactionId,
    response_sha256: input.responseSha256,
    error_name: input.error instanceof Error ? input.error.name : "Error"
  });
}

function takeoverFor(
  conversation: Conversation
): Record<string, unknown> | undefined {
  return isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
}

function assertControllerSession(
  conversation: Conversation,
  requestedValue: unknown
): void {
  const requested = nonBlankString(requestedValue);
  if (!requested) return;
  const stored = nonBlankString(conversation.gateway_session) ??
    nonBlankString(conversation.openclaw_session);
  if (stored !== requested) {
    throw new Error(
      `turn ${turnIdForConversation(conversation)} belongs to a different ` +
      "controller session; no terminal input was sent"
    );
  }
}

function requiredString(value: unknown, message: string): string {
  const parsed = nonBlankString(value);
  if (!parsed) throw new Error(message);
  return parsed;
}

function requiredFingerprint(value: unknown): string {
  const parsed = requiredString(
    value,
    "--expected-interaction-fingerprint is required"
  );
  if (!/^[0-9a-f]{64}$/u.test(parsed)) {
    throw new Error(
      "--expected-interaction-fingerprint must be a SHA-256 digest"
    );
  }
  return parsed;
}

function requiredFutureTimestamp(value: unknown, now: Date): string {
  const parsed = requiredString(
    value,
    "--expected-interaction-expires-at is required"
  );
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || milliseconds <= now.getTime()) {
    throw new Error(
      "--expected-interaction-expires-at must be an unexpired timestamp"
    );
  }
  return parsed;
}

function parseInteractionResponse(value: unknown): TerminalInteractionResponse {
  const serialized = requiredString(value, "--response-json is required");
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (error) {
    throw new Error(
      `--response-json is invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isRecord(parsed)) {
    throw new Error("--response-json must contain one response object");
  }
  return parsed as unknown as TerminalInteractionResponse;
}

function positivePid(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 1 ? parsed : undefined;
}

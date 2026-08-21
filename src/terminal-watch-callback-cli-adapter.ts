import type { CallbackSpawnSync } from "./openclaw-callback-transport.js";
import { createOpenClawCallbackTransport } from
  "./openclaw-callback-transport.js";
import { isRecord, nonBlankString } from "./value-guards.js";

export type TerminalWatchCallbackEvent =
  | "approval_required"
  | "completed"
  | "failed"
  | "timed_out"
  | "invalidated"
  | "cancelled";

export interface TerminalWatchCallbackInput {
  watchId: string;
  notificationId: string;
  idempotencyKey: string;
  event: TerminalWatchCallbackEvent;
  agent: "codex" | "claude";
  terminalId: string;
  openclawSession: string;
  openclawBin?: string;
  detail?: string;
  completionText?: string;
}

export interface TerminalWatchCallbackAcknowledgement {
  runId: string;
  status: "started" | "in_flight" | "ok" | "error" | "timeout";
}

export interface TerminalWatchCallbackCliAdapter {
  deliver(input: TerminalWatchCallbackInput):
    TerminalWatchCallbackAcknowledgement;
}

export function createTerminalWatchCallbackCliAdapter(
  options: {
    environment?: () => NodeJS.ProcessEnv;
    spawnSync?: CallbackSpawnSync;
  } = {}
): TerminalWatchCallbackCliAdapter {
  const transport = createOpenClawCallbackTransport({
    now: () => new Date(),
    environment: options.environment ?? (() => process.env),
    redactConversation: () => ({}),
    recordCallbackProcessDelivery: () => {},
    ...(options.spawnSync ? { spawnSync: options.spawnSync } : {})
  });

  return Object.freeze({
    deliver(input) {
      const delivery = transport.deliverChatSend({
        openclawBin: input.openclawBin,
        params: {
          sessionKey: input.openclawSession,
          message: terminalWatchCallbackMessage(input),
          idempotencyKey: input.idempotencyKey,
          deliver: true
        }
      });
      if (delivery.status !== 0) {
        throw new Error(
          delivery.stderr || delivery.stdout ||
          `Terminal Watch callback failed with status ${delivery.status}`
        );
      }
      const acknowledgement = parseAcknowledgement(
        delivery.stdout,
        input.idempotencyKey
      );
      if (
        acknowledgement.status === "error" ||
        acknowledgement.status === "timeout"
      ) {
        throw new Error(
          `Terminal Watch chat.send was not accepted: ${acknowledgement.status}`
        );
      }
      return acknowledgement;
    }
  });
}

function terminalWatchCallbackMessage(
  input: TerminalWatchCallbackInput
): string {
  const eventInstruction = input.event === "approval_required"
    ? "Tell the user that the observed TUI task is waiting for approval and ask the human to inspect and decide in the named live TUI. Do not call any AKK approval tool or action, do not send approval keys, and do not use autoApprove."
    : input.event === "completed"
      ? "Tell the user that the human-started TUI task completed and summarize only the bounded completion text below."
      : "Tell the user that Terminal Watch stopped without a verified successful completion and explain the exact reason below.";
  return [
    "Continue this OpenClaw conversation from the Agent Knock Knock Terminal Watch event below.",
    "This is an observation of a task started by the human directly in Codex or Claude Code. It is not an AKK Turn and AKK did not send terminal input.",
    eventInstruction,
    "Do not poll files, processes, terminal panes, stdout, or stderr. Use only this structured event.",
    "",
    `[AKK Terminal Watch: ${input.event}]`,
    `Watch: ${input.watchId}`,
    `Terminal: ${input.terminalId}`,
    `Agent: ${input.agent}`,
    ...(input.detail ? [`Detail: ${input.detail}`] : []),
    ...(input.completionText
      ? ["", "Bounded completion text:", input.completionText]
      : [])
  ].join("\n");
}

function parseAcknowledgement(
  text: string,
  expectedRunId: string
): TerminalWatchCallbackAcknowledgement {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Terminal Watch chat.send returned malformed JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("Terminal Watch chat.send returned malformed JSON");
  }
  const runId = nonBlankString(parsed.runId);
  const status = nonBlankString(parsed.status);
  if (runId !== expectedRunId) {
    throw new Error(
      "Terminal Watch chat.send acknowledgement does not match its idempotency key"
    );
  }
  if (
    !status ||
    !["started", "in_flight", "ok", "error", "timeout"].includes(status)
  ) {
    throw new Error(
      `Terminal Watch chat.send returned unexpected status ${JSON.stringify(
        status ?? null
      )}`
    );
  }
  return {
    runId,
    status: status as TerminalWatchCallbackAcknowledgement["status"]
  };
}

// Pure legacy rollout record parsing, validation and completion scanning.
import {
  codexThreadUsesLegacyRollout,
} from "./codex-session-provider.js";
import {
  exactNativeThreadId,
  validTimestamp,
} from "./terminal-submission-facts.js";
import {
  createHash,
} from "node:crypto";

const CODEX_COMPLETION_MAX_TEXT_LENGTH = 4000;

export const CODEX_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export interface CodexJsonlRecordAtOffset {
  value: Record<string, any>;
  offsetBytes: number;
}

export function parseCodexJsonlRecords(
  buffer: Buffer,
  label: string
): CodexJsonlRecordAtOffset[] {
  if (buffer.length > 0 && buffer[buffer.length - 1] !== 0x0a) {
    throw new Error(`Codex ${label} ends with an incomplete JSONL record`);
  }
  const records: CodexJsonlRecordAtOffset[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) {
      break;
    }
    const recordOffset = offset;
    let lineBuffer = buffer.subarray(offset, newline);
    if (lineBuffer.at(-1) === 0x0d) {
      lineBuffer = lineBuffer.subarray(0, lineBuffer.length - 1);
    }
    offset = newline + 1;
    const line = lineBuffer.toString("utf8");
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Codex ${label} contains invalid JSONL`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`Codex ${label} contains a non-object JSONL record`);
    }
    records.push({ value: parsed, offsetBytes: recordOffset });
  }
  return records;
}

export function assertExistingCodexRolloutHeader(
  buffer: Buffer,
  nativeThreadId: string
): string {
  const first = parseCodexJsonlRecords(buffer, "active-task rollout")[0]?.value;
  const payload = first?.type === "session_meta" && isRecord(first.payload)
    ? first.payload
    : undefined;
  if (
    !payload ||
    exactNativeThreadId(payload.id) !== nativeThreadId ||
    payload.originator !== "codex-tui" ||
    payload.source !== "cli"
  ) {
    throw new Error("Codex active-task rollout header does not identify the exact CLI thread");
  }
  if (!codexThreadUsesLegacyRollout(payload)) {
    throw new Error("Codex rollout does not use legacy history");
  }
  const codexVersion = optionalString(payload.cli_version);
  if (!codexVersion || !CODEX_VERSION_PATTERN.test(codexVersion)) {
    throw new Error("Codex active-task rollout header has no exact CLI version");
  }
  return codexVersion;
}

/**
 * Persisted anchors must check the history contract without widening their
 * existing thread/version requirements. Older legacy headers can be minimal.
 */
export function assertCodexRolloutLegacyHistory(buffer: Buffer): void {
  const first = parseCodexJsonlRecords(buffer, "rollout header")[0]?.value;
  const payload = first?.type === "session_meta" && isRecord(first.payload)
    ? first.payload
    : undefined;
  if (payload && !codexThreadUsesLegacyRollout(payload)) {
    throw new Error("Codex rollout does not use legacy history");
  }
}

export function positiveByteLimit(
  value: number | undefined,
  fallback: number,
  label: string
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} byte limit is invalid`);
  }
  return result;
}

export function safeByteOffset(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

type ExactCodexTaskCompleteScan =
  | {
      status: "completed";
      text: string;
      timestamp?: string;
      scannedRecords: number;
      observedTaskCompleteRecords: number;
      observedTurnAbortedRecords: number;
    }
  | {
      status: "aborted";
      reason?: string;
      timestamp?: string;
      scannedRecords: number;
      observedTaskCompleteRecords: number;
      observedTurnAbortedRecords: number;
    }
  | {
      status: "pending";
      scannedRecords: number;
      observedTaskCompleteRecords: number;
      observedTurnAbortedRecords: number;
    }
  | {
      status: "failure";
      code:
        | "invalid_rollout_jsonl"
        | "duplicate_exact_completion"
        | "duplicate_exact_abort"
        | "conflicting_exact_settlement"
        | "later_turn_started"
        | "invalid_exact_completion"
        | "invalid_exact_abort";
      detail: string;
      scannedRecords: number;
      observedTaskCompleteRecords: number;
      observedTurnAbortedRecords: number;
    };

export function scanExactCodexTaskComplete(
  text: string,
  acceptanceId: string
): ExactCodexTaskCompleteScan {
  let scannedRecords = 0;
  let observedTaskCompleteRecords = 0;
  let observedTurnAbortedRecords = 0;
  let exactTaskStartedIndex: number | undefined;
  let laterTaskStartedIndex: number | undefined;
  const exactMatches: Array<{
    value: Record<string, any>;
    index: number;
  }> = [];
  const exactAborts: Array<{
    value: Record<string, any>;
    index: number;
  }> = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return {
        status: "failure",
        code: "invalid_rollout_jsonl",
        detail: `Codex bound completion suffix contains invalid JSONL at record ${scannedRecords + 1}`,
        scannedRecords,
        observedTaskCompleteRecords,
        observedTurnAbortedRecords
      };
    }
    const recordIndex = scannedRecords;
    scannedRecords += 1;
    if (
      isRecord(value) &&
      value.type === "event_msg" &&
      isRecord(value.payload) &&
      value.payload.type === "task_started"
    ) {
      const turnId = optionalString(value.payload.turn_id)?.toLowerCase();
      if (turnId === acceptanceId) {
        exactTaskStartedIndex ??= recordIndex;
      } else if (
        exactTaskStartedIndex !== undefined &&
        laterTaskStartedIndex === undefined
      ) {
        laterTaskStartedIndex = recordIndex;
      }
      continue;
    }
    if (
      isRecord(value) &&
      value.type === "event_msg" &&
      isRecord(value.payload) &&
      value.payload.type === "turn_aborted"
    ) {
      observedTurnAbortedRecords += 1;
      const turnId = optionalString(value.payload.turn_id)?.toLowerCase();
      if (turnId === acceptanceId) {
        exactAborts.push({ value, index: recordIndex });
      }
      continue;
    }
    if (
      !isRecord(value) ||
      value.type !== "event_msg" ||
      !isRecord(value.payload) ||
      value.payload.type !== "task_complete"
    ) {
      continue;
    }
    observedTaskCompleteRecords += 1;
    const turnId = optionalString(value.payload.turn_id)?.toLowerCase();
    if (turnId === acceptanceId) {
      exactMatches.push({ value, index: recordIndex });
    }
  }

  if (exactMatches.length > 1) {
    return {
      status: "failure",
      code: "duplicate_exact_completion",
      detail: "the exact accepted Codex turn has duplicate task_complete records",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }
  if (exactAborts.length > 1) {
    return {
      status: "failure",
      code: "duplicate_exact_abort",
      detail: "the exact accepted Codex turn has duplicate turn_aborted records",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }
  if (exactMatches.length > 0 && exactAborts.length > 0) {
    return {
      status: "failure",
      code: "conflicting_exact_settlement",
      detail:
        "the exact accepted Codex turn has conflicting completion and abort records",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }

  const exactSettlementIndex = exactMatches[0]?.index ?? exactAborts[0]?.index;
  if (
    laterTaskStartedIndex !== undefined &&
    (exactSettlementIndex === undefined ||
      laterTaskStartedIndex < exactSettlementIndex)
  ) {
    return {
      status: "failure",
      code: "later_turn_started",
      detail:
        "a later Codex native turn started before the exact accepted turn settled",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }

  if (exactAborts.length === 1) {
    const match = exactAborts[0].value;
    if (match.timestamp !== undefined && !validTimestamp(match.timestamp)) {
      return {
        status: "failure",
        code: "invalid_exact_abort",
        detail: "the exact Codex turn_aborted record has an invalid timestamp",
        scannedRecords,
        observedTaskCompleteRecords,
        observedTurnAbortedRecords
      };
    }
    const payload = match.payload as Record<string, any>;
    return {
      status: "aborted",
      reason: optionalString(payload.reason),
      ...(match.timestamp !== undefined
        ? { timestamp: String(match.timestamp) }
        : {}),
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }

  if (exactMatches.length === 0) {
    return {
      status: "pending",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }

  const match = exactMatches[0].value;
  const payload = match.payload as Record<string, any>;
  const textValue = optionalString(payload.last_agent_message);
  if (!textValue) {
    return {
      status: "failure",
      code: "invalid_exact_completion",
      detail: "the exact Codex task_complete record has no final agent message",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }
  if (match.timestamp !== undefined && !validTimestamp(match.timestamp)) {
    return {
      status: "failure",
      code: "invalid_exact_completion",
      detail: "the exact Codex task_complete record has an invalid timestamp",
      scannedRecords,
      observedTaskCompleteRecords,
      observedTurnAbortedRecords
    };
  }
  return {
    status: "completed",
    text: textValue,
    ...(match.timestamp !== undefined
      ? { timestamp: String(match.timestamp) }
      : {}),
    scannedRecords,
    observedTaskCompleteRecords,
    observedTurnAbortedRecords
  };
}

export function truncateCompletionText(value: string): string {
  return value.length <= CODEX_COMPLETION_MAX_TEXT_LENGTH
    ? value
    : `${value.slice(0, CODEX_COMPLETION_MAX_TEXT_LENGTH - 1)}…`;
}

export function exactCodexUserResponseText(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) {
    return undefined;
  }
  const item = content[0];
  return isRecord(item) && item.type === "input_text" &&
    typeof item.text === "string"
    ? item.text
    : undefined;
}

export function isRetryableProviderIoError(error: unknown): boolean {
  if (!isRecord(error) || typeof error.code !== "string") {
    return false;
  }
  return new Set([
    "EACCES", "EAGAIN", "EBUSY", "EIO", "EMFILE", "ENFILE", "ENOENT",
    "EPERM", "ESTALE", "ETIMEDOUT"
  ]).has(error.code);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function fingerprintText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

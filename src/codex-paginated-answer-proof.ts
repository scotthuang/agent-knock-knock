import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const MAX_HEADER_BYTES = 256 * 1024;
const MAX_SUFFIX_BYTES = 8 * 1024 * 1024;

export class CodexPaginatedAnswerProofInvalidatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexPaginatedAnswerProofInvalidatedError";
  }
}

export interface CodexPaginatedAnswerProofAnchor {
  path: string;
  device: number;
  inode: number;
  offsetBytes: number;
  headerHash: string;
  lastOrdinal: number;
  threadId: string;
  turnId: string;
  itemId: string;
}

/** Freeze a canonical writer boundary before sending an answer, never searching old history. */
export function captureCodexPaginatedAnswerProof(input: {
  codexHome: string;
  rolloutPath: string;
  threadId: string;
  turnId: string;
  itemId: string;
}): CodexPaginatedAnswerProofAnchor {
  const rolloutPath = allowedRolloutPath(input.codexHome, input.rolloutPath);
  const fd = fs.openSync(rolloutPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateFile(stat);
    const header = readHeader(fd, stat.size, input.threadId);
    const tailOrdinal = readTailTurnBoundary(fd, stat.size, input.turnId);
    const current = fs.lstatSync(rolloutPath);
    if (current.dev !== stat.dev || current.ino !== stat.ino || fs.fstatSync(fd).size < stat.size) {
      throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof writer changed or truncated before capture");
    }
    return {
      path: rolloutPath, device: stat.dev, inode: stat.ino, offsetBytes: stat.size,
      headerHash: createHash("sha256").update(header).digest("hex"),
      lastOrdinal: tailOrdinal, threadId: input.threadId,
      turnId: input.turnId, itemId: input.itemId
    };
  } finally { fs.closeSync(fd); }
}

export function readCodexPaginatedAnswerProof(
  anchor: CodexPaginatedAnswerProofAnchor,
  answers: Record<string, { answers: string[] }>
): "pending" | "matched" | "different" {
  const fd = fs.openSync(anchor.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    assertPrivateFile(stat);
    if (stat.dev !== anchor.device || stat.ino !== anchor.inode || stat.size < anchor.offsetBytes) {
      throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof writer changed or truncated");
    }
    const header = readHeader(fd, stat.size, anchor.threadId);
    if (createHash("sha256").update(header).digest("hex") !== anchor.headerHash) {
      throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof metadata changed");
    }
    const length = stat.size - anchor.offsetBytes;
    if (length > MAX_SUFFIX_BYTES) throw new Error("Codex answer proof exceeded its bounded suffix");
    if (length === 0) return "pending";
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, anchor.offsetBytes) !== length) throw new Error("Codex answer proof suffix changed while reading");
    return scanAnswerSuffix(bytes, anchor, answers);
  } finally { fs.closeSync(fd); }
}

function scanAnswerSuffix(bytes: Buffer, anchor: CodexPaginatedAnswerProofAnchor,
  answers: Record<string, { answers: string[] }>): "pending" | "matched" | "different" {
  const end = bytes.lastIndexOf(0x0a);
  if (end < 0) return "pending";
  let currentTurn: string | undefined = anchor.turnId;
  let lastOrdinal = anchor.lastOrdinal;
  for (const text of bytes.subarray(0, end).toString("utf8").split("\n")) {
    const record = object(JSON.parse(text));
    const nextOrdinal = ordinal(record);
    if (nextOrdinal !== lastOrdinal + 1) throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof ordinal sequence changed");
    lastOrdinal = nextOrdinal;
    const payload = object(record.payload);
    if (record.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(String(payload.type))) {
      currentTurn = undefined;
    }
    if ((record.type === "event_msg" && ["task_started", "turn_started"].includes(String(payload.type))) || record.type === "turn_context") {
      if (typeof payload.turn_id !== "string") throw new Error("Codex answer proof turn identity is unavailable");
      currentTurn = payload.turn_id;
    }
    if (record.type === "response_item" && payload.type === "function_call_output" && payload.call_id === anchor.itemId) {
      if (currentTurn !== anchor.turnId) throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer output belongs to a different turn");
      const output = typeof payload.output === "string" ? payload.output : textOutput(payload.output);
      const response = object(JSON.parse(output));
      if (Object.keys(response).length !== 1 || !Object.hasOwn(response, "answers")) throw new Error("Codex answer output omitted its exact answers");
      return canonicalAnswers(response.answers) === canonicalAnswers(answers) ? "matched" : "different";
    }
  }
  return "pending";
}

function allowedRolloutPath(codexHome: string, value: string): string {
  if (!path.isAbsolute(codexHome) || !path.isAbsolute(value) || !value.endsWith(".jsonl")) throw new Error("Codex answer proof needs a native JSONL path");
  const root = fs.realpathSync(codexHome);
  const resolved = fs.realpathSync(value);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !["sessions", "archived_sessions"].includes(relative.split(path.sep)[0])) {
    throw new Error("Codex answer proof path is outside native session storage");
  }
  if (fs.lstatSync(value).isSymbolicLink()) throw new Error("Codex answer proof writer is a symlink");
  return resolved;
}

function readHeader(fd: number, size: number, threadId: string): Buffer {
  const bytes = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
  if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw new Error("Codex answer proof header changed while reading");
  const end = bytes.indexOf(0x0a);
  if (end < 0) throw new Error("Codex answer proof metadata is incomplete");
  const header = bytes.subarray(0, end);
  const record = object(JSON.parse(header.toString("utf8")));
  const payload = object(record.payload);
  if (record.type !== "session_meta" || payload.id !== threadId || payload.history_mode !== "paginated") {
    throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof metadata is not the selected paginated thread");
  }
  ordinal(record);
  return header;
}

function readTailTurnBoundary(fd: number, size: number, turnId: string): number {
  const length = Math.min(size, MAX_SUFFIX_BYTES);
  const bytes = Buffer.alloc(length);
  if (length === 0 || fs.readSync(fd, bytes, 0, length, size - length) !== length || bytes[length - 1] !== 0x0a) {
    throw new Error("Codex answer proof boundary is incomplete");
  }
  const start = length < size ? bytes.indexOf(0x0a) + 1 : 0;
  if (start === 0 && length < size) throw new Error("Codex answer proof final record exceeded its bound");
  const records = bytes.subarray(start, length - 1).toString("utf8").split("\n");
  let lastOrdinal: number | undefined;
  let expectedOrdinal: number | undefined;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = object(JSON.parse(records[index]!));
    const nextOrdinal = ordinal(record);
    if (expectedOrdinal !== undefined && nextOrdinal !== expectedOrdinal) throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof boundary ordinal sequence changed");
    lastOrdinal ??= nextOrdinal;
    expectedOrdinal = nextOrdinal - 1;
    const payload = object(record.payload);
    if (record.type === "event_msg" && ["task_complete", "turn_complete", "turn_aborted"].includes(String(payload.type))) {
      throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof selected turn is no longer active");
    }
    if (record.type === "turn_context" ||
        (record.type === "event_msg" && ["task_started", "turn_started"].includes(String(payload.type)))) {
      if (payload.turn_id !== turnId) throw new CodexPaginatedAnswerProofInvalidatedError("Codex answer proof current turn changed");
      return lastOrdinal;
    }
  }
  throw new Error("Codex answer proof current turn is outside its bounded tail");
}

function canonicalAnswers(value: unknown): string {
  const answers = object(value);
  return JSON.stringify(Object.keys(answers).sort().map((id) => {
    const response = object(answers[id]);
    if (Object.keys(response).length !== 1 || !Array.isArray(response.answers) || response.answers.some((answer) => typeof answer !== "string")) {
      throw new Error("Codex answer proof contains an invalid answer map");
    }
    return [id, response.answers];
  }));
}
function textOutput(value: unknown): string {
  if (!Array.isArray(value) || value.length !== 1) throw new Error("Codex answer proof output is not one text value");
  const content = object(value[0]);
  if (content.type !== "input_text" || typeof content.text !== "string") throw new Error("Codex answer proof output is not text");
  return content.text;
}
function ordinal(value: Record<string, unknown>): number {
  if (!Number.isSafeInteger(value.ordinal) || Number(value.ordinal) < 0) throw new Error("Codex answer proof ordinal is invalid");
  return value.ordinal as number;
}
function assertPrivateFile(stat: fs.Stats): void {
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || (stat.mode & 0o022) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new Error("Codex answer proof writer is not a private regular file");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex answer proof record is invalid");
  return value as Record<string, unknown>;
}

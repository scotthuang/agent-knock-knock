import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import { redactString } from "./runtime-log.js";
import type {
  TerminalCompletionEvidence,
  TerminalDurableCompletionRequest
} from "./terminal-agent-adapter.js";

const CLAUDE_TRANSCRIPT_ANCHOR_VERSION = 1;
const CLAUDE_TRANSCRIPT_MAX_TURN_BYTES = 64 * 1024 * 1024;
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SUPPORTED_CLAUDE_TRANSCRIPT_VERSION = "2.1.198";
const NO_FOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number"
  ? fs.constants.O_NOFOLLOW
  : 0;

export interface ClaudeTranscriptAnchor {
  schema_version: 1;
  session_id: string;
  cwd: string;
  pid: number;
  agent_started_at_ms: number;
  captured_at: string;
  relative_path: string;
  offset_bytes: number;
  file_existed: boolean;
  device?: string;
  inode?: string;
}

export interface CaptureClaudeTranscriptAnchorOptions {
  sessionId?: string;
  cwd?: string;
  pid?: number;
  claudeHome?: string;
  agentRows: readonly ClaudeAgentRow[];
  now?: Date;
}

export interface DetectClaudeTranscriptCompletionOptions {
  claudeHome?: string;
  agentRows: readonly ClaudeAgentRow[];
  maxTurnBytes?: number;
}

interface TranscriptRecord {
  [key: string]: unknown;
}

interface OpenTranscript {
  fd: number;
  stat: fs.Stats;
  relativePath: string;
}

export function defaultClaudeHome(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(os.homedir(), ".claude");
}

/**
 * Records the immutable file boundary immediately before AKK submits a turn.
 * No transcript contents are retained in conversation state.
 */
export function captureClaudeTranscriptAnchor(
  options: CaptureClaudeTranscriptAnchorOptions
): ClaudeTranscriptAnchor | undefined {
  const sessionId = nonEmptyString(options.sessionId);
  const cwd = nonEmptyString(options.cwd);
  const pid = positiveInteger(options.pid);
  if (!sessionId || !cwd || pid === undefined || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
    return undefined;
  }

  const agent = exactInteractiveAgent(options.agentRows, pid);
  const agentStartedAtMs = positiveInteger(agent?.startedAt);
  if (
    !agent ||
    agentStartedAtMs === undefined ||
    agent.sessionId !== sessionId ||
    normalizePath(agent.cwd) !== normalizePath(cwd) ||
    agent.status !== "idle"
  ) {
    return undefined;
  }

  const claudeHome = path.resolve(options.claudeHome ?? defaultClaudeHome());
  const projectsRoot = projectsRootPath(claudeHome);
  if (!isRealDirectory(projectsRoot)) {
    if (
      lstatOrUndefined(projectsRoot) !== undefined ||
      !isRealDirectory(claudeHome)
    ) {
      return undefined;
    }
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: expectedTranscriptRelativePath(sessionId, cwd),
      offset_bytes: 0,
      file_existed: false
    };
  }

  const located = locateTranscript(projectsRoot, sessionId);
  const relativePath = located?.relativePath ?? expectedTranscriptRelativePath(sessionId, cwd);
  if (!located) {
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: relativePath,
      offset_bytes: 0,
      file_existed: false
    };
  }

  try {
    if (located.stat.size > 0 && !fileEndsWithNewline(located.fd, located.stat.size)) {
      throw new Error("Claude transcript did not end at a complete JSONL record before send");
    }
    return {
      schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
      session_id: sessionId,
      cwd: path.resolve(cwd),
      pid,
      agent_started_at_ms: agentStartedAtMs,
      captured_at: (options.now ?? new Date()).toISOString(),
      relative_path: located.relativePath,
      offset_bytes: located.stat.size,
      file_existed: true,
      device: String(located.stat.dev),
      inode: String(located.stat.ino)
    };
  } finally {
    fs.closeSync(located.fd);
  }
}

/**
 * Detects one completed Claude Code turn from the append-only local transcript.
 * The detector intentionally fails closed on identity, schema, rotation, prompt,
 * background-work, and chain ambiguity.
 */
export function detectClaudeTranscriptCompletion(
  request: TerminalDurableCompletionRequest,
  options: DetectClaudeTranscriptCompletionOptions
): TerminalCompletionEvidence | undefined {
  const anchor = transcriptAnchorFromContext(request.context);
  if (!anchor) {
    return undefined;
  }

  const sessionId = nonEmptyString(request.sessionId);
  const cwd = nonEmptyString(request.cwd);
  const expectedRequestHash = nonEmptyString(request.requestHash);
  const requestTextHash = requestFingerprint(request.requestText);
  const expectedPromptText = exactPromptText(request.requestText);
  const startedAtMs = validTimestampMs(request.startedAt);
  const capturedAtMs = validTimestampMs(anchor.captured_at);
  if (
    !sessionId ||
    !cwd ||
    !expectedRequestHash ||
    !requestTextHash ||
    !expectedPromptText ||
    expectedRequestHash !== requestTextHash ||
    startedAtMs === undefined ||
    capturedAtMs === undefined
  ) {
    return undefined;
  }
  if (
    anchor.schema_version !== CLAUDE_TRANSCRIPT_ANCHOR_VERSION ||
    anchor.session_id !== sessionId ||
    normalizePath(anchor.cwd) !== normalizePath(cwd) ||
    !CLAUDE_SESSION_ID_PATTERN.test(sessionId)
  ) {
    throw new Error("Claude transcript anchor does not match the managed terminal turn");
  }

  const runtimePid = runtimePidFromContext(request.context);
  if (runtimePid === undefined || runtimePid !== anchor.pid) {
    throw new Error("Claude transcript anchor PID does not match the active terminal runtime");
  }
  const agent = exactInteractiveAgent(options.agentRows, anchor.pid);
  if (!agent) {
    throw new Error("the exact Claude process is absent from the local agent registry");
  }
  if (
    agent.startedAt !== anchor.agent_started_at_ms ||
    agent.sessionId !== sessionId ||
    normalizePath(agent.cwd) !== normalizePath(cwd)
  ) {
    throw new Error("the Claude process session identity changed after the managed send");
  }
  if (agent.status !== "idle") {
    return undefined;
  }

  const projectsRoot = projectsRootPath(
    path.resolve(options.claudeHome ?? defaultClaudeHome())
  );
  if (!isRealDirectory(projectsRoot)) {
    return undefined;
  }
  const opened = openAnchoredTranscript(projectsRoot, anchor);
  if (!opened) {
    return undefined;
  }

  try {
    if (
      anchor.file_existed &&
      (String(opened.stat.dev) !== anchor.device || String(opened.stat.ino) !== anchor.inode)
    ) {
      throw new Error("Claude transcript was replaced or rotated after the managed send");
    }
    if (opened.stat.size < anchor.offset_bytes) {
      throw new Error("Claude transcript was truncated after the managed send");
    }

    const bytesToRead = opened.stat.size - anchor.offset_bytes;
    if (bytesToRead === 0) {
      return undefined;
    }
    const maxTurnBytes = positiveInteger(options.maxTurnBytes) ??
      CLAUDE_TRANSCRIPT_MAX_TURN_BYTES;
    if (bytesToRead > maxTurnBytes) {
      throw new Error("Claude transcript turn exceeded the bounded local read limit");
    }

    const records = readCompleteJsonlRecords(
      opened.fd,
      anchor.offset_bytes,
      bytesToRead
    );
    const stableStat = fs.fstatSync(opened.fd);
    if (
      stableStat.dev !== opened.stat.dev ||
      stableStat.ino !== opened.stat.ino ||
      stableStat.size !== opened.stat.size ||
      stableStat.mtimeMs !== opened.stat.mtimeMs
    ) {
      return undefined;
    }
    if (records.length === 0) {
      return undefined;
    }
    return completionFromRecords({
      records,
      sessionId,
      cwd,
      expectedRequestHash,
      expectedPromptText,
      fileIdentity: `${opened.stat.dev}:${opened.stat.ino}`
    });
  } finally {
    fs.closeSync(opened.fd);
  }
}

function completionFromRecords({
  records,
  sessionId,
  cwd,
  expectedRequestHash,
  expectedPromptText,
  fileIdentity
}: {
  records: readonly TranscriptRecord[];
  sessionId: string;
  cwd: string;
  expectedRequestHash: string;
  expectedPromptText: string;
  fileIdentity: string;
}): TerminalCompletionEvidence | undefined {
  const promptCandidates = records.filter((record) => {
    const promptText = userPromptText(record);
    return record.type === "user" &&
      isRecord(record.message) &&
      record.message.role === "user" &&
      record.isSidechain !== true &&
      nonEmptyString(record.agentId) === undefined &&
      record.sessionId === sessionId &&
      normalizePath(record.cwd) === normalizePath(cwd) &&
      validTimestampMs(record.timestamp) !== undefined &&
      promptText !== undefined &&
      exactPromptText(promptText) === expectedPromptText &&
      requestFingerprint(promptText) === expectedRequestHash;
  });
  if (promptCandidates.length === 0) {
    return undefined;
  }
  if (promptCandidates.length !== 1) {
    throw new Error("multiple Claude transcript prompts matched the managed request");
  }

  const prompt = promptCandidates[0];
  const promptUuid = uuidValue(prompt.uuid);
  if (!promptUuid) {
    throw new Error("matched Claude transcript prompt has no stable UUID");
  }
  assertSupportedRecord(prompt, sessionId, cwd);

  const promptIndex = records.indexOf(prompt);
  const nextHumanPromptIndex = records.findIndex((record, index) =>
    index > promptIndex &&
    record.type === "user" &&
    isRecord(record.message) &&
    record.message.role === "user" &&
    record.isSidechain !== true &&
    nonEmptyString(record.agentId) === undefined &&
    userPromptText(record) !== undefined
  );
  const turnRecords = records.slice(
    promptIndex,
    nextHumanPromptIndex < 0 ? records.length : nextHumanPromptIndex
  );
  const recordsByUuid = new Map<string, TranscriptRecord>();
  for (const record of turnRecords) {
    const uuid = uuidValue(record.uuid);
    if (!uuid) {
      continue;
    }
    if (recordsByUuid.has(uuid)) {
      throw new Error("Claude transcript contains a duplicate record UUID");
    }
    recordsByUuid.set(uuid, record);
  }
  assertParentsPrecedeChildren(turnRecords, recordsByUuid);
  const descendants = turnRecords.filter((record) =>
    uuidValue(record.uuid) !== undefined &&
    descendantChain(recordsByUuid, promptUuid, record) !== undefined
  );
  if (descendants.length !== recordsByUuid.size) {
    throw new Error("Claude transcript turn contains an unlinked UUID branch");
  }
  for (const record of descendants) {
    assertSupportedRecord(record, sessionId);
  }
  if (descendants.some((record) =>
    record.isSidechain === true ||
    nonEmptyString(record.agentId) !== undefined ||
    hasUnresolvedBackgroundWork(record)
  )) {
    return undefined;
  }
  if (hasUnresolvedToolUse(descendants)) {
    return undefined;
  }
  if (descendants.some(hasBlockingStopSummary)) {
    return undefined;
  }

  const durations = descendantRecords(
    turnRecords,
    recordsByUuid,
    promptUuid,
    (record) => record.type === "system" && record.subtype === "turn_duration"
  );
  if (durations.length > 1) {
    throw new Error("Claude transcript turn contains multiple turn_duration records");
  }
  const duration = durations[0];
  if (!duration) {
    const failures = descendantRecords(
      turnRecords,
      recordsByUuid,
      promptUuid,
      (record) =>
        record.type === "assistant" &&
        record.isApiErrorMessage === true &&
        nonEmptyString(record.error) !== undefined
    );
    const failure = failures.at(-1);
    const lastDescendant = [...turnRecords].reverse().find((record) =>
      uuidValue(record.uuid) !== undefined &&
      descendantChain(recordsByUuid, promptUuid, record) !== undefined
    );
    if (!failure || failure !== lastDescendant) {
      return undefined;
    }

    assertSupportedRecord(failure, sessionId);
    assertSameClaudeVersion(prompt, failure);
    const error = safeErrorCode(failure.error);
    const assistantText = assistantTextForMessage(
      turnRecords,
      recordsByUuid,
      promptUuid,
      failure
    );
    return {
      source: "durable",
      outcome: "failure",
      text: boundedRedactedText(
        assistantText || `Claude Code stopped with ${error}.`
      ),
      timestamp: nonEmptyString(failure.timestamp),
      id: uuidValue(failure.uuid),
      confidence: "high",
      metadata: {
        match: "claude_transcript_api_error",
        session_id: sessionId,
        prompt_uuid: promptUuid,
        error,
        transcript_schema: "claude_code_jsonl_v2",
        transcript_file_id: transcriptFileId(sessionId, fileIdentity)
      }
    };
  }
  assertSupportedRecord(duration, sessionId);
  if (validTimestampMs(duration.timestamp) === undefined) {
    throw new Error("Claude turn_duration has no valid timestamp");
  }

  const chain = descendantChain(recordsByUuid, promptUuid, duration);
  if (!chain) {
    return undefined;
  }
  const finalAssistant = [...chain].reverse().find((record) =>
    record.type === "assistant" &&
    isRecord(record.message) &&
    record.message.role === "assistant" &&
    record.message.stop_reason === "end_turn"
  );
  if (!finalAssistant) {
    throw new Error("Claude turn_duration was not linked to an end_turn assistant record");
  }
  assertSupportedRecord(finalAssistant, sessionId);
  assertSameClaudeVersion(prompt, finalAssistant, duration);

  const finalMessage = isRecord(finalAssistant.message)
    ? finalAssistant.message
    : undefined;
  const messageId = uuidValue(finalMessage?.id);
  if (!messageId) {
    throw new Error("Claude final assistant message has no stable UUID");
  }
  const assistantText = assistantTextForMessage(
    turnRecords,
    recordsByUuid,
    promptUuid,
    finalAssistant
  );
  if (!assistantText) {
    return undefined;
  }
  const promptId = nonEmptyString(prompt.promptId);
  return {
    source: "durable",
    outcome: "success",
    text: boundedRedactedText(assistantText),
    timestamp: nonEmptyString(duration.timestamp),
    id: uuidValue(duration.uuid),
    confidence: "high",
    metadata: {
      match: "claude_transcript_turn_duration",
      session_id: sessionId,
      prompt_uuid: promptUuid,
      ...(promptId ? { prompt_id: promptId } : {}),
      assistant_message_id: messageId,
      claude_version: nonEmptyString(finalAssistant.version),
      transcript_schema: "claude_code_jsonl_v2",
      transcript_file_id: transcriptFileId(sessionId, fileIdentity)
    }
  };
}

function transcriptAnchorFromContext(context: unknown): ClaudeTranscriptAnchor | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  const nativeTakeover = isRecord(context.nativeTakeover)
    ? context.nativeTakeover
    : undefined;
  const value = nativeTakeover?.claude_transcript_anchor ?? context.claudeTranscriptAnchor;
  if (!isRecord(value)) {
    return undefined;
  }
  const schemaVersion = Number(value.schema_version);
  const sessionId = nonEmptyString(value.session_id);
  const cwd = nonEmptyString(value.cwd);
  const pid = positiveInteger(value.pid);
  const agentStartedAtMs = positiveInteger(value.agent_started_at_ms);
  const capturedAt = nonEmptyString(value.captured_at);
  const relativePath = nonEmptyString(value.relative_path);
  const offsetBytes = nonNegativeInteger(value.offset_bytes);
  if (
    schemaVersion !== CLAUDE_TRANSCRIPT_ANCHOR_VERSION ||
    !sessionId ||
    !cwd ||
    pid === undefined ||
    agentStartedAtMs === undefined ||
    !capturedAt ||
    !relativePath ||
    offsetBytes === undefined ||
    typeof value.file_existed !== "boolean"
  ) {
    return undefined;
  }
  return {
    schema_version: CLAUDE_TRANSCRIPT_ANCHOR_VERSION,
    session_id: sessionId,
    cwd,
    pid,
    agent_started_at_ms: agentStartedAtMs,
    captured_at: capturedAt,
    relative_path: relativePath,
    offset_bytes: offsetBytes,
    file_existed: value.file_existed,
    ...(nonEmptyString(value.device) ? { device: nonEmptyString(value.device) } : {}),
    ...(nonEmptyString(value.inode) ? { inode: nonEmptyString(value.inode) } : {})
  };
}

function openAnchoredTranscript(
  projectsRoot: string,
  anchor: ClaudeTranscriptAnchor
): OpenTranscript | undefined {
  if (path.basename(anchor.relative_path) !== `${anchor.session_id}.jsonl`) {
    throw new Error("Claude transcript anchor filename does not match its session");
  }
  const candidates = locateTranscriptCandidates(projectsRoot, anchor.session_id);
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      fs.closeSync(candidate.fd);
    }
    throw new Error("multiple local Claude transcripts matched the active session");
  }
  const candidate = candidates[0];
  if (candidate) {
    if (anchor.file_existed && candidate.relativePath !== anchor.relative_path) {
      fs.closeSync(candidate.fd);
      throw new Error("Claude transcript moved after the managed send");
    }
    return candidate;
  }
  if (anchor.file_existed) {
    throw new Error("Claude transcript disappeared after the managed send");
  }
  return undefined;
}

function locateTranscript(
  projectsRoot: string,
  sessionId: string
): OpenTranscript | undefined {
  const candidates = locateTranscriptCandidates(projectsRoot, sessionId);
  if (candidates.length > 1) {
    for (const candidate of candidates) {
      fs.closeSync(candidate.fd);
    }
    throw new Error("multiple local Claude transcripts matched the active session");
  }
  return candidates[0];
}

function locateTranscriptCandidates(
  projectsRoot: string,
  sessionId: string
): OpenTranscript[] {
  const candidates: OpenTranscript[] = [];
  for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = path.join(entry.name, `${sessionId}.jsonl`);
    const candidate = openRelativeTranscript(projectsRoot, relativePath);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function openRelativeTranscript(
  projectsRoot: string,
  relativePath: string
): OpenTranscript | undefined {
  const segments = relativePath.split(/[\\/]/u);
  if (
    segments.length !== 2 ||
    !segments[0] ||
    segments[0] === "." ||
    segments[0] === ".." ||
    !CLAUDE_SESSION_ID_PATTERN.test(path.basename(segments[1], ".jsonl")) ||
    segments[1] !== `${path.basename(segments[1], ".jsonl")}.jsonl`
  ) {
    throw new Error("Claude transcript anchor contains an invalid relative path");
  }
  const projectDirectory = path.join(projectsRoot, segments[0]);
  const directoryStat = lstatOrUndefined(projectDirectory);
  if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return undefined;
  }
  const transcriptPath = path.join(projectDirectory, segments[1]);
  const fileStat = lstatOrUndefined(transcriptPath);
  if (!fileStat) {
    return undefined;
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error("Claude transcript must be a non-symlink regular file");
  }

  const fd = fs.openSync(
    transcriptPath,
    fs.constants.O_RDONLY | NO_FOLLOW_FLAG
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error("Claude transcript must be a regular file");
    }
    assertPrivateTranscriptFile(stat);
    return {
      fd,
      stat,
      relativePath: path.join(segments[0], segments[1])
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function readCompleteJsonlRecords(
  fd: number,
  offset: number,
  length: number
): TranscriptRecord[] {
  const buffer = Buffer.allocUnsafe(length);
  let readTotal = 0;
  while (readTotal < length) {
    const bytesRead = fs.readSync(
      fd,
      buffer,
      readTotal,
      length - readTotal,
      offset + readTotal
    );
    if (bytesRead === 0) {
      break;
    }
    readTotal += bytesRead;
  }
  if (readTotal !== length) {
    throw new Error("Claude transcript changed while it was being read");
  }
  if (buffer.length === 0 || buffer[buffer.length - 1] !== 0x0a) {
    return [];
  }

  const text = buffer.subarray(0, buffer.length - 1).toString("utf8");
  const records: TranscriptRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error("Claude transcript contains an invalid complete JSONL record");
    }
    if (!isRecord(parsed)) {
      throw new Error("Claude transcript contains a non-object JSONL record");
    }
    records.push(parsed);
  }
  return records;
}

function descendantRecords(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  ancestorUuid: string,
  predicate: (record: TranscriptRecord) => boolean
): TranscriptRecord[] {
  return records.filter((record) =>
    predicate(record) &&
    descendantChain(recordsByUuid, ancestorUuid, record) !== undefined
  );
}

function assertParentsPrecedeChildren(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>
): void {
  const indexes = new Map<TranscriptRecord, number>(
    records.map((record, index) => [record, index])
  );
  for (const record of records) {
    const parentUuid = uuidValue(record.parentUuid);
    const parent = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
    if (parent && (indexes.get(parent) ?? Number.POSITIVE_INFINITY) >=
      (indexes.get(record) ?? Number.NEGATIVE_INFINITY)) {
      throw new Error("Claude transcript parent UUID does not precede its child record");
    }
  }
}

function descendantChain(
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  ancestorUuid: string,
  descendant: TranscriptRecord
): TranscriptRecord[] | undefined {
  const reversed: TranscriptRecord[] = [];
  let current: TranscriptRecord | undefined = descendant;
  const visited = new Set<string>();
  while (current) {
    const currentUuid = uuidValue(current.uuid);
    if (!currentUuid || visited.has(currentUuid)) {
      return undefined;
    }
    visited.add(currentUuid);
    reversed.push(current);
    if (currentUuid === ancestorUuid) {
      return reversed.reverse();
    }
    const parentUuid = uuidValue(current.parentUuid);
    current = parentUuid ? recordsByUuid.get(parentUuid) : undefined;
  }
  return undefined;
}

function assistantTextForMessage(
  records: readonly TranscriptRecord[],
  recordsByUuid: ReadonlyMap<string, TranscriptRecord>,
  promptUuid: string,
  finalAssistant: TranscriptRecord
): string | undefined {
  const message = isRecord(finalAssistant.message) ? finalAssistant.message : undefined;
  const messageId = nonEmptyString(message?.id);
  if (!messageId) {
    return textFromAssistantRecord(finalAssistant);
  }
  const parts = records.flatMap((record): string[] => {
    const candidateMessage = isRecord(record.message) ? record.message : undefined;
    if (
      record.type !== "assistant" ||
      candidateMessage?.role !== "assistant" ||
      candidateMessage.id !== messageId ||
      descendantChain(recordsByUuid, promptUuid, record) === undefined
    ) {
      return [];
    }
    const text = textFromAssistantRecord(record);
    return text ? [text] : [];
  });
  const joined = parts.join("\n").trim();
  return joined || undefined;
}

function textFromAssistantRecord(record: TranscriptRecord): string | undefined {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  if (typeof content === "string") {
    return content.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content.flatMap((block): string[] =>
    isRecord(block) && block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : []
  ).join("\n").trim();
  return text || undefined;
}

function userPromptText(record: TranscriptRecord): string | undefined {
  const message = isRecord(record.message) ? record.message : undefined;
  const content = message?.content;
  return typeof content === "string" ? content : undefined;
}

function hasUnresolvedBackgroundWork(record: TranscriptRecord): boolean {
  if (
    record.type === "assistant" &&
    isRecord(record.message) &&
    Array.isArray(record.message.content)
  ) {
    for (const block of record.message.content) {
      if (!isRecord(block) || block.type !== "tool_use") {
        continue;
      }
      const toolName = nonEmptyString(block.name)?.toLowerCase();
      if (
        toolName?.startsWith("cron") ||
        toolName === "agent" ||
        toolName === "sendmessage" ||
        structuredBoolean(block.input, ["run_in_background", "runInBackground"]) === true
      ) {
        return true;
      }
    }
  }
  const toolUseResult = isRecord(record.toolUseResult)
    ? record.toolUseResult
    : undefined;
  const backgroundStatus = nonEmptyString(toolUseResult?.status);
  return nonEmptyString(toolUseResult?.backgroundTaskId) !== undefined ||
    structuredBoolean(toolUseResult, ["isAsync"]) === true ||
    (
      backgroundStatus !== undefined &&
      ["async_launched", "remote_launched", "teammate_spawned"].includes(backgroundStatus)
    ) ||
    structuredBoolean(toolUseResult, [
    "run_in_background",
    "runInBackground",
    "is_background",
    "isBackground",
    "backgroundedByUser",
    "assistantAutoBackgrounded"
  ]) === true;
}

function hasUnresolvedToolUse(records: readonly TranscriptRecord[]): boolean {
  const toolUses = new Map<string, { count: number; ownerUuid?: string }>();
  const toolResults = new Map<string, {
    count: number;
    parentUuid?: string;
    sourceAssistantUuid?: string;
  }>();
  let malformed = false;
  for (const record of records) {
    const message = isRecord(record.message) ? record.message : undefined;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (!isRecord(block)) {
        continue;
      }
      if (block.type === "tool_use") {
        const id = nonEmptyString(block.id);
        if (id) {
          const existing = toolUses.get(id);
          toolUses.set(id, {
            count: (existing?.count ?? 0) + 1,
            ownerUuid: uuidValue(record.uuid)
          });
        } else {
          malformed = true;
        }
      }
      if (block.type === "tool_result") {
        const id = nonEmptyString(block.tool_use_id);
        if (id) {
          const existing = toolResults.get(id);
          toolResults.set(id, {
            count: (existing?.count ?? 0) + 1,
            parentUuid: uuidValue(record.parentUuid),
            sourceAssistantUuid: uuidValue(record.sourceToolAssistantUUID)
          });
        } else {
          malformed = true;
        }
      }
    }
  }
  return malformed ||
    [...toolUses].some(([id, toolUse]) => {
      const result = toolResults.get(id);
      return toolUse.count !== 1 ||
        result?.count !== 1 ||
        !toolUse.ownerUuid ||
        result.parentUuid !== toolUse.ownerUuid ||
        result.sourceAssistantUuid !== toolUse.ownerUuid;
    }) ||
    [...toolResults].some(([id, result]) =>
      result.count !== 1 || toolUses.get(id)?.count !== 1
    );
}

function hasBlockingStopSummary(record: TranscriptRecord): boolean {
  return record.type === "system" &&
    record.subtype === "stop_hook_summary" &&
    (
      record.preventedContinuation === true ||
      (Array.isArray(record.hookErrors) && record.hookErrors.length > 0)
    );
}

function structuredBoolean(value: unknown, keys: readonly string[]): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of keys) {
    if (typeof value[key] === "boolean") {
      return value[key] as boolean;
    }
  }
  return undefined;
}

function assertSupportedRecord(
  record: TranscriptRecord,
  sessionId: string,
  cwd?: string
): void {
  if (
    record.sessionId !== sessionId ||
    nonEmptyString(record.cwd) === undefined ||
    (cwd !== undefined && normalizePath(record.cwd) !== normalizePath(cwd)) ||
    record.isSidechain !== false ||
    record.entrypoint !== "cli" ||
    record.version !== SUPPORTED_CLAUDE_TRANSCRIPT_VERSION
  ) {
    throw new Error("Claude transcript completion record uses an unsupported schema or identity");
  }
}

function assertSameClaudeVersion(...records: readonly TranscriptRecord[]): void {
  const versions = new Set(records.map((record) => nonEmptyString(record.version)));
  if (versions.size !== 1 || versions.has(undefined)) {
    throw new Error("Claude transcript turn changed schema versions while it was running");
  }
}

function exactInteractiveAgent(
  rows: readonly ClaudeAgentRow[],
  pid: number
): ClaudeAgentRow | undefined {
  const matches = rows.filter((row) =>
    row.pid === pid && (row.kind === undefined || row.kind === "interactive")
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function runtimePidFromContext(context: unknown): number | undefined {
  if (!isRecord(context)) {
    return undefined;
  }
  return positiveInteger(context.pid);
}

function expectedTranscriptRelativePath(sessionId: string, cwd: string): string {
  return path.join(
    cwd.replace(/[^A-Za-z0-9]/gu, "-"),
    `${sessionId}.jsonl`
  );
}

function projectsRootPath(claudeHome: string): string {
  return path.join(claudeHome, "projects");
}

function fileEndsWithNewline(fd: number, size: number): boolean {
  const buffer = Buffer.allocUnsafe(1);
  return fs.readSync(fd, buffer, 0, 1, size - 1) === 1 && buffer[0] === 0x0a;
}

function isRealDirectory(value: string): boolean {
  const stat = lstatOrUndefined(value);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}

function lstatOrUndefined(value: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(value);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function assertPrivateTranscriptFile(stat: fs.Stats): void {
  if (process.platform === "win32") {
    return;
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && stat.uid !== getuid.call(process)) {
    throw new Error("Claude transcript is not owned by the current user");
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error("Claude transcript permissions are broader than owner-only");
  }
}

function safeErrorCode(value: unknown): string {
  const error = nonEmptyString(value);
  return error && /^[A-Za-z0-9_.:-]{1,80}$/u.test(error)
    ? error
    : "claude_api_error";
}

function requestFingerprint(value: unknown): string | undefined {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text ? createHash("sha256").update(text).digest("hex") : undefined;
}

function exactPromptText(value: unknown): string | undefined {
  const text = String(value ?? "")
    .replace(/\r\n/gu, "\n")
    .replace(/[\r\n]+$/u, "");
  return text.length > 0 ? text : undefined;
}

function transcriptFileId(sessionId: string, fileIdentity: string): string {
  return createHash("sha256")
    .update(`${sessionId}\0${fileIdentity}`)
    .digest("hex")
    .slice(0, 24);
}

function boundedRedactedText(value: string): string {
  return redactString(value).trim().slice(0, 4000);
}

function normalizePath(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text ? path.resolve(text) : undefined;
}

function validTimestampMs(value: unknown): number | undefined {
  const timestamp = nonEmptyString(value);
  if (!timestamp) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function uuidValue(value: unknown): string | undefined {
  const text = nonEmptyString(value);
  return text && CLAUDE_SESSION_ID_PATTERN.test(text) ? text : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

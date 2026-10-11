import fs, { type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { constants } from "node:fs";
import path from "node:path";
import { backendPublicProgress, backendPublicProgressReadError,
  type BackendProgressItem, type BackendPublicProgress } from "./backend-public-progress.js";
import { isClaudeNativeUuid, validateClaudeNativeIdentity,
  type ClaudeNativeCatalogEntry, type ClaudeNativeIdentity } from "./claude-native-identity.js";
import { isRecord } from "./value-guards.js";

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 40_000;
const MAX_INPUTS = 50;
type RecordValue = Record<string, unknown>;
export interface ClaudeNativeTranscriptSource { relativePath: string; device: string; inode: string }
export interface ClaudeNativeToolObservation { toolUseId: string; name: string; status: "pending" | "completed" | "failed" }
export interface ClaudeNativeInputObservation {
  inputUuid: string;
  messageId?: string;
  verifiedPeerPid?: number;
  kind: "root_user" | "absorbed_mid_turn";
  origin: "peer" | "human" | "unknown";
  acceptedAt: string | null;
  state: "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
  responseText: string;
  responseTruncated: boolean;
  completedAt: string | null;
  completionRecordUuid?: string;
  pendingTools: ClaudeNativeToolObservation[];
  toolResults: ClaudeNativeToolObservation[];
  reason?: string;
}
export interface ClaudeNativePublicProgress extends BackendPublicProgress {
  native_input_id: string | null;
  task_anchor_kind: "native_input_uuid";
}
export interface ClaudeNativeSnapshot {
  identity: ClaudeNativeIdentity;
  readAt: string;
  source?: ClaudeNativeTranscriptSource;
  latestInputUuid: string | null;
  inputs: ClaudeNativeInputObservation[];
  selectedInput?: ClaudeNativeInputObservation;
  progress: ClaudeNativePublicProgress;
  readError?: "missing_transcript" | "read_failed" | "missing_exact_input" | "identity_mismatch" | "incomplete_chain";
}
export interface ClaudeNativeObservationOptions {
  exactInputUuid?: string;
  messageId?: string;
  expectedPeerPid?: number;
  now?: Date;
  /** Persist after acceptance; a replaced/moved transcript cannot inherit the old Watch. */
  source?: ClaudeNativeTranscriptSource;
  /** The caller verifies process liveness. A saved entry is usable after exit, never a new process. */
  processAlive?: boolean;
}

/** Read-only, bounded projection of one exact session. No cwd-based session inference. */
export async function readClaudeNativeSnapshot(entry: ClaudeNativeCatalogEntry,
  options: ClaudeNativeObservationOptions = {}): Promise<ClaudeNativeSnapshot> {
  const identity = validateClaudeNativeIdentity(entry);
  const readAt = (options.now ?? new Date()).toISOString();
  const base: ClaudeNativeSnapshot = { identity, readAt, latestInputUuid: null, inputs: [],
    progress: progressFor(null, [], readAt) };
  if (!validOptions(options)) return failed(base, "identity_mismatch");
  let loaded: Awaited<ReturnType<typeof loadRecords>>;
  try { loaded = await loadRecords(entry, options.source); }
  catch { return failed(base, "read_failed"); }
  if (!loaded) return failed(base, "missing_transcript");
  base.source = loaded.source;
  const { records, roots, conflicts, byParent } = transcriptGraph(loaded.records, entry.sessionId);
  if (!roots.length && records.length && !records.some(record => sessionOf(record) === entry.sessionId)) return failed(base, "identity_mismatch");
  const last = roots.at(-1);
  base.latestInputUuid = last ? inputId(last) : null;
  const selected = options.exactInputUuid
    ? roots.find(record => inputId(record) === options.exactInputUuid) : last;
  if (options.exactInputUuid && !selected) return failed(base, "missing_exact_input");
  if (selected && !exactInputMatches(selected, roots, conflicts, options)) return failed(base, "identity_mismatch");
  const chosen = roots.slice(-MAX_INPUTS);
  if (selected && !chosen.includes(selected)) chosen.unshift(selected);
  for (const root of chosen) {
    const chain = causalChain(root, byParent, conflicts, entry.sessionId);
    const projected = observeInput(root, chain, entry, options.processAlive !== false, readAt, inputId(root) === base.latestInputUuid);
    base.inputs.push(projected.observation);
    if (root === selected) { base.selectedInput = projected.observation; base.progress = projected.progress; }
  }
  return base;
}

function validOptions(options: ClaudeNativeObservationOptions): boolean {
  if (options.exactInputUuid !== undefined && !isClaudeNativeUuid(options.exactInputUuid)) return false;
  if (options.messageId !== undefined && !isClaudeNativeUuid(options.messageId)) return false;
  return options.expectedPeerPid === undefined || Number.isSafeInteger(options.expectedPeerPid) && options.expectedPeerPid > 0;
}
function sessionOf(record: RecordValue) { return record.sessionId ?? record.session_id; }
function transcriptGraph(loaded: RecordValue[], sessionId: string) {
  // Prove the selected graph, allowing identical historical replays after resume.
  const byUuid = new Map<string, RecordValue>(), conflicts = new Set<string>();
  for (const record of loaded) {
    if (!isClaudeNativeUuid(record.uuid)) continue;
    const prior = byUuid.get(record.uuid);
    if (prior && JSON.stringify(prior) !== JSON.stringify(record)) conflicts.add(record.uuid);
    if (!prior) byUuid.set(record.uuid, record);
  }
  const records = [...byUuid.values()];
  const roots = records.filter(record => isInput(record) && sessionOf(record) === sessionId && record.isSidechain !== true);
  const byParent = new Map<string, RecordValue[]>();
  for (const record of records) {
    if (!isClaudeNativeUuid(record.parentUuid)) continue;
    const children = byParent.get(record.parentUuid) ?? [];
    children.push(record); byParent.set(record.parentUuid, children);
  }
  return { records, roots, conflicts, byParent };
}
function exactInputMatches(selected: RecordValue, roots: RecordValue[], conflicts: Set<string>, options: ClaudeNativeObservationOptions): boolean {
  if (conflicts.has(String(selected.uuid)) || roots.filter(root => inputId(root) === inputId(selected)).length !== 1) return false;
  const origin = originOf(selected);
  if (options.messageId !== undefined && (origin?.kind !== "peer" || origin.msg_id !== options.messageId)) return false;
  return options.expectedPeerPid === undefined || origin?.verifiedPeerPid === options.expectedPeerPid;
}

function failed(base: ClaudeNativeSnapshot, reason: NonNullable<ClaudeNativeSnapshot["readError"]>): ClaudeNativeSnapshot {
  return { ...base, readError: reason, progress: { ...backendPublicProgressReadError(null, base.readAt,
    reason === "identity_mismatch" ? "identity_mismatch" : "read_failed"), native_input_id: null,
    task_anchor_kind: "native_input_uuid" } };
}
function originOf(record: RecordValue): RecordValue | undefined {
  const value = isRecord(record.attachment) ? record.attachment.origin : record.origin;
  return isRecord(value) ? value : undefined;
}
function inputId(record: RecordValue): string {
  return isRecord(record.attachment) ? String(record.attachment.source_uuid) : String(record.uuid);
}
function content(record: RecordValue): RecordValue[] {
  const message = isRecord(record.message) ? record.message : undefined;
  return Array.isArray(message?.content) ? message.content.filter(isRecord) : [];
}
function interrupted(record: RecordValue): boolean {
  return record.type === "user" && content(record).some(block => block.type === "text"
    && (block.text === "[Request interrupted by user]" || block.text === "[Request interrupted by user for tool use]"));
}
function isInput(record: RecordValue): boolean {
  if (!isClaudeNativeUuid(record.uuid)) return false;
  if (record.type === "attachment" && isRecord(record.attachment)) return record.attachment.type === "queued_command"
    && isClaudeNativeUuid(record.attachment.source_uuid);
  if (record.type !== "user" || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true
    || (record.isMeta === true && originOf(record)?.kind !== "peer")
    || interrupted(record) || content(record).some(block => block.type === "tool_result")) return false;
  const message = isRecord(record.message) ? record.message : undefined;
  return message?.role === "user" && (typeof message.content === "string" || content(record).some(block => block.type === "text"));
}
function causalChain(root: RecordValue, byParent: Map<string, RecordValue[]>, conflicts: Set<string>, sessionId: string): RecordValue[] | undefined {
  if (conflicts.has(String(root.uuid))) return undefined;
  const chain = [root]; const seen = new Set([String(root.uuid)]);
  while (true) {
    const children = (byParent.get(String(chain.at(-1)!.uuid)) ?? [])
      .filter(record => !(isInput(record) && record.type === "user"))
      .filter(record => !(record.type === "system" && record.subtype === "informational" && !byParent.has(String(record.uuid))));
    if (!children.length) return chain;
    if (children.length !== 1 || !isClaudeNativeUuid(children[0].uuid) || seen.has(children[0].uuid)) return undefined;
    const next = children[0];
    if (conflicts.has(String(next.uuid)) || (next.sessionId ?? next.session_id) !== sessionId || next.isSidechain === true) return undefined;
    seen.add(String(next.uuid)); chain.push(next);
    // A durable end marker belongs to this task even when later inputs are descendants.
    if (next.type === "system" && next.subtype === "turn_duration") return chain;
  }
}
function nativeTime(record: RecordValue): string | null {
  if (typeof record.timestamp !== "string") return null;
  const ms = Date.parse(record.timestamp); return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function hasBackgroundWork(record: RecordValue): boolean {
  if ([record.pendingBackgroundAgentCount, record.pendingWorkflowCount].some(value => value !== undefined && value !== 0)) return true;
  const result = isRecord(record.toolUseResult) ? record.toolUseResult : {};
  if (typeof result.backgroundTaskId === "string" || result.isAsync === true
    || ["async_launched", "remote_launched", "teammate_spawned"].includes(String(result.status))) return true;
  const background = (value: RecordValue) => ["run_in_background", "runInBackground", "is_background", "isBackground",
    "backgroundedByUser", "assistantAutoBackgrounded"].some(key => value[key] === true);
  return background(result) || content(record).some(block => block.type === "tool_use" && isRecord(block.input) && background(block.input));
}
function toolType(name: string): string {
  if (name === "Bash") return "commandExecution";
  if (name === "Write" || name === "Edit" || name === "NotebookEdit") return "fileChange";
  if (name === "WebSearch" || name === "WebFetch") return "webSearch";
  return "dynamicToolCall";
}
function toolActionKind(name: string): BackendProgressItem["actionKind"] {
  if (name === "Read") return "file_read";
  if (name === "Glob" || name === "Grep") return "file_search";
  if (name === "AskUserQuestion") return "user_question";
  return undefined;
}
function toolName(value: unknown): string {
  // Tool names are identifiers, never commands, file paths, arguments or output.
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,120}$/u.test(value) ? value : "unknown";
}

function initialInputObservation(root: RecordValue): ClaudeNativeInputObservation {
  const origin = originOf(root);
  return { inputUuid: inputId(root),
    ...(typeof origin?.msg_id === "string" ? { messageId: origin.msg_id } : {}),
    ...(Number.isSafeInteger(origin?.verifiedPeerPid) ? { verifiedPeerPid: origin!.verifiedPeerPid as number } : {}),
    kind: root.type === "attachment" ? "absorbed_mid_turn" : "root_user",
    origin: origin?.kind === "peer" ? "peer" : origin ? "unknown" : "human",
    acceptedAt: nativeTime(root), state: "unknown", responseText: "", responseTruncated: false,
    completedAt: null, pendingTools: [], toolResults: [] };
}
function observeInput(root: RecordValue, chain: RecordValue[] | undefined, entry: ClaudeNativeCatalogEntry,
  alive: boolean, readAt: string, isLatest: boolean): { observation: ClaudeNativeInputObservation; progress: ClaudeNativePublicProgress } {
  const result = initialInputObservation(root);
  if (!chain) return { observation: { ...result, reason: "ambiguous_parent_chain" }, progress: progressFor(result.inputUuid, [], readAt, false) };
  const analysis = analyzeChain(chain);
  result.pendingTools = [...analysis.tools.values()].filter(tool => tool.observation.status === "pending").map(tool => tool.observation);
  result.toolResults = [...analysis.tools.values()].filter(tool => tool.observation.status !== "pending").map(tool => tool.observation);
  settleObservation(result, analysis, entry, alive, isLatest);
  return observationOutput(result, analysis, readAt);
}
function analyzeChain(chain: RecordValue[]) {
  const items: BackendProgressItem[] = [], tools = new Map<string, ObservedTool>();
  let lastMessageId: string | undefined, lastPublicMessageId: string | undefined, finalMessageId: string | undefined;
  let stopRecord: RecordValue | undefined, errorRecord: RecordValue | undefined, duration: RecordValue | undefined;
  let unsafe = false, unknownStopReason = false;
  for (const record of chain.slice(1)) {
    if (record.subtype === "stop_hook_summary" || record.type === "progress" || hasBackgroundWork(record)) unsafe = true;
    if (interrupted(record)) stopRecord = record;
    if (record.type === "system" && record.subtype === "turn_duration") duration = record;
    const assistant = addAssistantItems(record, tools, items);
    lastMessageId = assistant.messageId ?? lastMessageId;
    lastPublicMessageId = assistant.publicMessageId ?? lastPublicMessageId;
    finalMessageId = assistant.finalMessageId ?? finalMessageId;
    if (assistant.error) errorRecord = record;
    unsafe ||= assistant.unsafe;
    unknownStopReason ||= assistant.unknownStopReason;
    unsafe = settleToolResults(record, tools) || unsafe;
  }
  if (unknownStopReason && !stopRecord && !errorRecord) unsafe = true;
  return { items, tools, lastMessageId, lastPublicMessageId, finalMessageId, stopRecord, errorRecord, duration, unsafe };
}
type ChainAnalysis = ReturnType<typeof analyzeChain>;
function completionRecord(result: ClaudeNativeInputObservation, analysis: ChainAnalysis): RecordValue | undefined {
  if (result.pendingTools.length) return undefined;
  if (analysis.stopRecord || analysis.errorRecord) return analysis.stopRecord ?? analysis.errorRecord;
  const { duration, finalMessageId, lastMessageId, lastPublicMessageId } = analysis;
  return duration && finalMessageId && finalMessageId === lastMessageId && finalMessageId === lastPublicMessageId ? duration : undefined;
}
function settleObservation(result: ClaudeNativeInputObservation, analysis: ChainAnalysis, entry: ClaudeNativeCatalogEntry, alive: boolean, isLatest: boolean) {
  const finished = completionRecord(result, analysis);
  if (result.kind === "absorbed_mid_turn") result.reason = "input_absorbed_into_existing_task";
  else if (analysis.unsafe) result.reason = "unsupported_or_incomplete_task_chain";
  else if (finished && nativeTime(finished)) {
    result.state = analysis.stopRecord ? "interrupted" : analysis.errorRecord ? "failed" : "completed";
    result.completedAt = nativeTime(finished); result.completionRecordUuid = String(finished.uuid);
  } else if (!alive) result.reason = "process_exited_without_proven_task_completion";
  else if (!isLatest) result.reason = "newer_input_exists_without_proven_completion";
  else if (entry.status === "working" || entry.status === "waiting") result.state = "inProgress";
  else result.reason = "awaiting_durable_completion";
}
function observationOutput(result: ClaudeNativeInputObservation, analysis: ChainAnalysis, readAt: string) {
  const { items, lastPublicMessageId, unsafe } = analysis;
  const hasFinal = result.state === "completed" || result.state === "failed";
  const finalItems = items.filter(item => item.type === "agentMessage" && item.delivery === lastPublicMessageId);
  if (hasFinal) {
    const combined = finalItems.length ? [{ ...finalItems.at(-1)!, text: finalItems.map(item => item.text).join("\n") }] : [];
    const response = progressFor(result.inputUuid, combined, readAt);
    result.responseText = response.text; result.responseTruncated = response.truncated;
  }
  // Claude text is public without phases; exclude a proven final from progress.
  const progressItems = hasFinal ? items.filter(item => item.type !== "agentMessage" || item.delivery !== lastPublicMessageId) : items;
  return { observation: result, progress: progressFor(result.inputUuid, progressItems, readAt, !unsafe) };
}
interface ObservedTool { observation: ClaudeNativeToolObservation; item: BackendProgressItem; owner: string }
function addAssistantItems(record: RecordValue, tools: Map<string, ObservedTool>, items: BackendProgressItem[]) {
  const result = { unsafe: false, unknownStopReason: false, error: false,
    messageId: undefined as string | undefined, publicMessageId: undefined as string | undefined,
    finalMessageId: undefined as string | undefined };
  if (record.type !== "assistant") return result;
  const message = isRecord(record.message) ? record.message : undefined;
  result.unsafe = message?.role !== "assistant";
  result.messageId = typeof message?.id === "string" ? message.id : undefined;
  result.error = record.isApiErrorMessage === true;
  if (message?.stop_reason === "end_turn") result.finalMessageId = result.messageId;
  else result.unknownStopReason = !result.error && message?.stop_reason != null && message.stop_reason !== "tool_use";
  const startedAtMs = nativeTime(record) ? Date.parse(nativeTime(record)!) : null;
  for (const block of content(record)) {
    if (block.type === "text" && typeof block.text === "string" && block.text.trim()) {
      if (!result.messageId) { result.unsafe = true; continue; }
      result.publicMessageId = result.messageId;
      items.push({ id: String(record.uuid), type: "agentMessage", phase: "commentary", text: block.text,
        startedAtMs, delivery: result.messageId });
    } else if (block.type === "tool_use" && typeof block.id === "string") {
      if (tools.has(block.id)) { result.unsafe = true; continue; }
      const name = toolName(block.name);
      const item: BackendProgressItem = { id: block.id, type: toolType(name), actionKind: toolActionKind(name), status: "inProgress", startedAtMs };
      tools.set(block.id, { observation: { toolUseId: block.id, name, status: "pending" }, item, owner: String(record.uuid) });
      items.push(item);
    }
  }
  return result;
}
function settleToolResults(record: RecordValue, tools: Map<string, ObservedTool>): boolean {
  let unsafe = false;
  for (const block of content(record)) {
    if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const tool = tools.get(block.tool_use_id);
    if (!tool || tool.observation.status !== "pending" || record.parentUuid !== tool.owner) { unsafe = true; continue; }
    tool.observation.status = block.is_error === true ? "failed" : "completed";
    tool.item.status = tool.observation.status;
    tool.item.completedAtMs = nativeTime(record) ? Date.parse(nativeTime(record)!) : null;
  }
  return unsafe;
}

function progressFor(id: string | null, items: BackendProgressItem[], readAt: string, complete = true): ClaudeNativePublicProgress {
  const progress = backendPublicProgress({ nativeTurnId: id, readAt,
    turn: id ? { id, itemsComplete: complete, items } : undefined });
  // Claude's UUID identifies an input, not a Codex-style native task/turn.
  return { ...progress, native_turn_id: null, native_input_id: id, task_anchor_kind: "native_input_uuid" };
}

async function loadRecords(entry: ClaudeNativeCatalogEntry, source?: ClaudeNativeTranscriptSource): Promise<{
  source: ClaudeNativeTranscriptSource; records: RecordValue[] } | undefined> {
  const location = await locateTranscript(entry, source);
  if (!location) return undefined;
  const { filename, relativePath } = location;
  if (await fs.realpath(filename) !== filename) throw new Error("Transcript symlink rejected");
  const before = await fs.lstat(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    const identity = { relativePath, device: String(stat.dev), inode: String(stat.ino) };
    assertTranscriptFile(stat, before, source);
    const records = await readRecordWindow(handle, stat.size);
    const after = await handle.stat(), current = await fs.lstat(filename);
    if (after.size < stat.size || current.dev !== stat.dev || current.ino !== stat.ino || await fs.realpath(filename) !== filename) throw new Error("Transcript changed identity");
    return { source: identity, records };
  } finally { await handle.close(); }
}
async function locateTranscript(entry: ClaudeNativeCatalogEntry, source?: ClaudeNativeTranscriptSource) {
  const projects = path.join(await fs.realpath(entry.configDir), "projects");
  const root = await lstatOptional(projects);
  if (!root) return undefined;
  if (!root.isDirectory() || root.isSymbolicLink() || await fs.realpath(projects) !== projects) throw new Error("Unsafe transcript directory");
  const entries = await fs.readdir(projects, { withFileTypes: true });
  if (entries.length > 10_000) throw new Error("Transcript catalog limit exceeded");
  const matches: string[] = [];
  for (const directory of entries) {
    if (!directory.isDirectory() || directory.isSymbolicLink()) continue;
    const relative = path.join(directory.name, `${entry.sessionId}.jsonl`);
    if (await lstatOptional(path.join(projects, relative))) matches.push(relative);
  }
  if (!matches.length) return undefined;
  if (matches.length !== 1 || (source && matches[0] !== source.relativePath)) throw new Error("Ambiguous or moved transcript");
  return { relativePath: matches[0], filename: path.join(projects, matches[0]) };
}
async function lstatOptional(filename: string) {
  return fs.lstat(filename).catch(error => error.code === "ENOENT" ? undefined : Promise.reject(error));
}
function assertTranscriptFile(stat: Stats, before: Stats, source?: ClaudeNativeTranscriptSource) {
  if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) throw new Error("Unsafe/replaced transcript");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid() || stat.mode & 0o022) throw new Error("Unsafe transcript owner or mode");
  if (source && (source.device !== String(stat.dev) || source.inode !== String(stat.ino))) throw new Error("Transcript anchor changed");
}
async function readRecordWindow(handle: FileHandle, size: number): Promise<RecordValue[]> {
  const offset = Math.max(0, size - MAX_BYTES), buffer = Buffer.alloc(size - offset);
  const read = await handle.read(buffer, 0, buffer.length, offset);
  if (read.bytesRead !== buffer.length) throw new Error("Transcript changed while reading");
  let start = 0;
  if (offset > 0) {
    const prefix = Buffer.alloc(1); await handle.read(prefix, 0, 1, offset - 1);
    if (prefix[0] !== 10) start = buffer.indexOf(10) + 1;
    if (!start && prefix[0] !== 10) throw new Error("Transcript record exceeds read limit");
  }
  const records: RecordValue[] = [], end = buffer.lastIndexOf(10) + 1;
  for (const line of buffer.subarray(start, end).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const value: unknown = JSON.parse(line);
    if (!isRecord(value) || records.length >= MAX_RECORDS) throw new Error("Invalid/oversized transcript");
    records.push(value);
  }
  return records;
}

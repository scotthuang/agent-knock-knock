import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  parseCodexAppServerMetadata,
  CodexAppServerReadError,
  type CodexAppServerReadTransport,
  type CodexAppServerThreadItem
} from "./codex-app-server-read-client.js";
import { connectCodexUnixWebSocket } from "./codex-app-server-transport.js";
import { codexProcessIncarnationForPid } from "./codex-process-incarnation.js";
import { readCodexPaginatedTaskSnapshot } from "./codex-paginated-observation.js";
import {
  codexPaginatedAsyncQuestionEvidence,
  type CodexPaginatedTaskSnapshot
} from "./codex-paginated-task.js";
import type { CodexPaginatedThreadBinding } from "./codex-paginated-thread-facts.js";
import type { CodexAsyncQuestionDurableQuestion } from "./codex-async-question-adapter.js";

export interface CodexPaginatedAsyncAnswerInput {
  binding: CodexPaginatedThreadBinding;
  nativeTurnId: string;
  itemId: string;
  questionIndex: number;
  expectedQuestion: CodexAsyncQuestionDurableQuestion;
  answer: string;
  timeoutMs?: number;
  /** Reserve the durable interaction exactly once, after preflight and before native input. */
  beforeDispatch?: () => Promise<void>;
}

export interface CodexPaginatedAsyncAnswerResult {
  status: "confirmed" | "response_uncertain";
  clientUserMessageId: string;
  nativeTurnId: string;
  nativeQuestionId: string;
  reason?: string;
}

export interface CodexPaginatedAsyncAnswerPorts {
  readSnapshot?: typeof readCodexPaginatedTaskSnapshot;
  transportFactory?: (options: { socketPath: string; timeoutMs: number }) => Promise<CodexAppServerReadTransport>;
  incarnation?: typeof codexProcessIncarnationForPid;
  randomId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

/** One exact native async answer. This API cannot create, resume, or start a task. */
export async function deliverCodexPaginatedAsyncAnswer(
  request: CodexPaginatedAsyncAnswerInput,
  ports: CodexPaginatedAsyncAnswerPorts = {}
): Promise<CodexPaginatedAsyncAnswerResult> {
  validateInput(request);
  const input = {
    ...request, binding: { ...request.binding },
    answer: request.answer.replace(/\r\n?/gu, "\n").trim(),
    expectedQuestion: { ...request.expectedQuestion,
      ...(request.expectedQuestion.options === undefined ? {} : { options: [...request.expectedQuestion.options] }) }
  };
  assertProcess(input.binding, ports);
  const timeoutMs = input.timeoutMs ?? 5_000;
  const socketPath = path.join(input.binding.codexHome, "app-server-control", "app-server-control.sock");
  const transport = await (ports.transportFactory ?? connectCodexUnixWebSocket)({ socketPath, timeoutMs });
  const writer = new AsyncAnswerWriter(transport, timeoutMs);
  try {
    const initialized = await writer.initialize();
    parseCodexAppServerMetadata(initialized, {
      codexHome: input.binding.codexHome, expectedServerVersion: "0.158.0"
    }, socketPath);
    transport.send(JSON.stringify({ method: "initialized" }));
    const snapshot = await readSnapshot(input, ports);
    const question = preflightQuestion(input, snapshot);
    assertProcess(input.binding, ports);
    const clientUserMessageId = (ports.randomId ?? randomUUID)();
    identifier(clientUserMessageId);
    const nativeQuestionId = JSON.stringify(["request_user_input_async", input.itemId, input.questionIndex]);
    if (Buffer.byteLength(nativeQuestionId) > 512) throw new Error("Native async question identity exceeds its reply envelope");
    const text = nativeReply(nativeQuestionId, question.title, input.answer);
    // No mutation precedes this callback. Once reserved, every uncertain outcome is fenced.
    await input.beforeDispatch?.();
    const result = { clientUserMessageId, nativeTurnId: input.nativeTurnId, nativeQuestionId };
    try {
      const steered = object(await writer.answer({
        threadId: input.binding.threadId, expectedTurnId: input.nativeTurnId,
        clientUserMessageId, input: [{ type: "text", text, textElements: [] }]
      }));
      if (steered.turnId !== input.nativeTurnId) return {
        ...result, status: "response_uncertain", reason: "native_async_answer_turn_changed"
      };
    } catch {
      return { ...result, status: "response_uncertain", reason: "native_async_answer_delivery_uncertain" };
    }
    try { return await confirmAnswer(input, ports, result, text, timeoutMs); }
    catch { return { ...result, status: "response_uncertain", reason: "native_async_answer_evidence_unavailable" }; }
  } finally {
    try { writer.close(); } catch { /* Closing the private connection cannot change durable answer evidence. */ }
  }
}

async function readSnapshot(input: CodexPaginatedAsyncAnswerInput, ports: CodexPaginatedAsyncAnswerPorts) {
  return (ports.readSnapshot ?? readCodexPaginatedTaskSnapshot)({
    codexHome: input.binding.codexHome, serverVersion: "0.158.0",
    threadId: input.binding.threadId, boundaryTurnId: input.nativeTurnId
  });
}

function preflightQuestion(input: CodexPaginatedAsyncAnswerInput,
  snapshot: CodexPaginatedTaskSnapshot): { title: string } {
  assertSnapshot(input, snapshot);
  const turn = snapshot.turns[0];
  if (snapshot.thread.status.type !== "active" || !turn ||
      turn.id !== input.nativeTurnId || turn.status !== "inProgress") {
    throw new Error("The exact native async question turn is no longer active");
  }
  const item = turn.items.find((value) => value.id === input.itemId);
  const raw = item?.questions?.[input.questionIndex];
  const evidence = codexPaginatedAsyncQuestionEvidence(turn).find((value) => value.itemId === input.itemId);
  const expected = evidence?.questions[input.questionIndex];
  const nativeId = JSON.stringify(["request_user_input_async", input.itemId, input.questionIndex]);
  if (!raw || !expected || snapshot.turns.some((candidate) =>
    candidate.items.some((value) => hasAnswer(value, nativeId, input.itemId)))) {
    throw new Error("The exact native async question is no longer pending");
  }
  if (expected.title !== input.expectedQuestion.title ||
      JSON.stringify(expected.options ?? []) !== JSON.stringify(input.expectedQuestion.options ?? [])) {
    throw new Error("The exact native async question payload changed");
  }
  return { title: raw.title };
}

async function confirmAnswer(input: CodexPaginatedAsyncAnswerInput, ports: CodexPaginatedAsyncAnswerPorts,
  result: Omit<CodexPaginatedAsyncAnswerResult, "status" | "reason">,
  text: string, timeoutMs: number): Promise<CodexPaginatedAsyncAnswerResult> {
  const now = ports.now ?? Date.now;
  const sleep = ports.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;
  do {
    try {
      assertProcess(input.binding, ports);
      const snapshot = await readSnapshot(input, ports);
      assertSnapshot(input, snapshot);
      const turn = snapshot.turns.find((value) => value.id === input.nativeTurnId)!;
      const matching = turn.items.filter((value) => value.type === "userMessage" && value.clientId === result.clientUserMessageId);
      if (matching.length > 1) throw new Error("Native async answer identity repeated");
      if (matching.length === 1) {
        const exact = matching[0]!;
        if (singleText(exact) !== text || !answeredIds(exact).includes(result.nativeQuestionId)) {
          throw new Error("Native async answer payload changed");
        }
        const competing = turn.items.some((value) => value !== exact && hasAnswer(value, result.nativeQuestionId, input.itemId));
        return competing
          ? { ...result, status: "response_uncertain", reason: "native_async_answer_has_competing_reply" }
          : { ...result, status: "confirmed" };
      }
      if (turn.status !== "inProgress") return {
        ...result, status: "response_uncertain", reason: "native_async_turn_finished_without_answer_receipt"
      };
    } catch {
      return { ...result, status: "response_uncertain", reason: "native_async_answer_evidence_unavailable" };
    }
    await sleep(100);
  } while (now() < deadline);
  return { ...result, status: "response_uncertain", reason: "native_async_answer_receipt_pending" };
}

function assertSnapshot(input: CodexPaginatedAsyncAnswerInput, snapshot: CodexPaginatedTaskSnapshot): void {
  if (snapshot.serverVersion !== "0.158.0" || path.resolve(snapshot.codexHome) !== path.resolve(input.binding.codexHome) ||
      snapshot.thread.id !== input.binding.threadId || snapshot.thread.historyMode !== "paginated" ||
      snapshot.thread.originator !== "codex-tui" || !snapshot.completeToBoundary ||
      snapshot.turns.length > 128 || !snapshot.turns.some((value) => value.id === input.nativeTurnId) ||
      new Set(snapshot.turns.map((value) => value.id)).size !== snapshot.turns.length ||
      snapshot.turns.some((turn) => turn.itemsView !== "full" || turn.items.length > 1024 ||
        new Set(turn.items.map((value) => value.id)).size !== turn.items.length)) {
    throw new Error("Native async answer history is not exact and complete");
  }
}

function nativeReply(questionId: string, title: string, answer: string): string {
  let question = "";
  let bytes = 0;
  for (const character of title) {
    bytes += Buffer.byteLength(character);
    if (bytes > 512) break;
    question += character;
  }
  return `<send_user_message_question_reply>\n${JSON.stringify([{
    answer, question: question.replace(/[\r\n]/gu, " "), questionItemId: questionId
  }])}\n</send_user_message_question_reply>`;
}

function answeredIds(item: CodexAppServerThreadItem): string[] {
  let text = singleText(item)?.trim();
  if (!text) return [];
  if (text.startsWith("# Context from my IDE setup:\n")) {
    const index = text.lastIndexOf("\n## My request for Codex:\n");
    if (index < 0) return [];
    text = text.slice(index + "\n## My request for Codex:\n".length).trim();
  }
  const match = /^<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>$/u.exec(text);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    const replies = Array.isArray(parsed) ? parsed : [parsed];
    if (replies.length === 0 || replies.length > 16) return [];
    return replies.map((reply) => {
      const value = object(reply);
      if (typeof value.answer !== "string" || typeof value.question !== "string" || typeof value.questionItemId !== "string") throw new Error("Invalid async answer");
      let id: unknown;
      try { id = JSON.parse(value.questionItemId); } catch { id = undefined; }
      if (Array.isArray(id)) {
        if (id.length !== 3 || id[0] !== "request_user_input_async" ||
            typeof id[1] !== "string" || !Number.isSafeInteger(id[2]) || Number(id[2]) < 0) throw new Error("Invalid async answer identity");
        return JSON.stringify(id);
      }
      // Native .158 also resolves legacy desktop replies identifying the whole source item.
      return identifier(value.questionItemId);
    });
  } catch { return []; }
}

function hasAnswer(item: CodexAppServerThreadItem, questionId: string, itemId: string): boolean {
  const ids = answeredIds(item);
  return ids.includes(questionId) || ids.includes(itemId);
}

function singleText(item: CodexAppServerThreadItem): string | undefined {
  if (item.type !== "userMessage" || !Array.isArray(item.content)) return undefined;
  const content = item.content.filter((value) => value.type !== "skill" && value.type !== "mention");
  return content.length === 1 && content[0]?.type === "text" && typeof content[0].text === "string"
    ? content[0].text : undefined;
}

function validateInput(input: CodexPaginatedAsyncAnswerInput): void {
  identifier(input.binding.threadId);
  identifier(input.nativeTurnId);
  identifier(input.itemId);
  if (input.binding.serverVersion !== "0.158.0" || !path.isAbsolute(input.binding.codexHome) ||
      !Number.isSafeInteger(input.binding.pid) || input.binding.pid <= 1 ||
      !Number.isSafeInteger(input.questionIndex) || input.questionIndex < 0 || input.questionIndex >= 16 ||
      !Number.isSafeInteger(input.timeoutMs ?? 5000) || (input.timeoutMs ?? 5000) < 1 || (input.timeoutMs ?? 5000) > 30_000 ||
      typeof input.answer !== "string" || input.answer.trim().length === 0 || input.answer.length > 4096 ||
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(input.answer) ||
      !input.expectedQuestion || typeof input.expectedQuestion.title !== "string" ||
      input.expectedQuestion.title.length > 4096 || (input.expectedQuestion.options !== undefined &&
        (!Array.isArray(input.expectedQuestion.options) || input.expectedQuestion.options.length > 32 ||
          input.expectedQuestion.options.some((value) => typeof value !== "string" || value.length > 512)))) {
    throw new Error("Native async answer input is invalid");
  }
}

function assertProcess(binding: CodexPaginatedThreadBinding, ports: CodexPaginatedAsyncAnswerPorts): void {
  const current = (ports.incarnation ?? codexProcessIncarnationForPid)(binding.pid);
  if (current.processUuid !== binding.processUuid || current.processBirth !== binding.processBirth) {
    throw new Error("Native async question process incarnation changed");
  }
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Native async answer identity is invalid");
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Native async answer protocol object is invalid");
  return value as Record<string, unknown>;
}

type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

/** Private wire writer: initialize and one canonical turn/steer only. */
class AsyncAnswerWriter {
  private readonly requests = new Map<string, PendingRpc>();
  private readonly listeners: (() => void)[];
  private nextId = 1;
  private answered = false;
  private closed = false;
  constructor(private readonly transport: CodexAppServerReadTransport, private readonly timeoutMs: number) {
    this.listeners = [transport.onMessage((text) => this.receive(text)),
      transport.onDisconnect((error) => this.finish(error))];
  }
  initialize(): Promise<unknown> {
    return this.request("initialize", { clientInfo: {
      name: "agent-knock-knock-async-answer", title: "AKK exact async answer", version: "1"
    }, capabilities: { experimentalApi: true } });
  }
  answer(params: unknown): Promise<unknown> {
    if (this.answered) return Promise.reject(new Error("Native async answer cannot be retried"));
    this.answered = true;
    return this.request("turn/steer", params);
  }
  close(): void { this.finish(new Error("Native async answer connection closed")); this.transport.close(); }
  private request(method: "initialize" | "turn/steer", params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Native async answer connection closed"));
    const id = `akk-async-answer-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new CodexAppServerReadError("timeout", "Native async answer operation timed out"));
      }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      try { this.transport.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.requests.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  private receive(text: string): void {
    try {
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error("Native async answer message exceeded its bound");
      const message = object(JSON.parse(text));
      if (message.method !== undefined || typeof message.id !== "string") return;
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new Error("Native async answer was rejected"));
      else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new Error("Native async answer response omitted its result"));
    } catch (error) { this.finish(error instanceof Error ? error : new Error("Native async answer protocol failed")); this.transport.close(); }
  }
  private finish(error: Error): void {
    this.closed = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    this.listeners.forEach((listener) => listener());
  }
}

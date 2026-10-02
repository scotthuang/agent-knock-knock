import path from "node:path";
import { isAuditedCodexPaginatedServerPair } from "./codex-lifecycle-compatibility.js";
import {
  CodexAppServerReadError,
  parseCodexAppServerMetadata,
  type CodexAppServerMetadata,
  type CodexAppServerReadTransport
} from "./codex-app-server-read-client.js";
import { connectCodexUnixWebSocket } from "./codex-app-server-transport.js";
import type { CodexPaginatedThreadBinding } from "./codex-paginated-thread-facts.js";
import {
  captureCodexPaginatedAnswerProof,
  readCodexPaginatedAnswerProof,
  CodexPaginatedAnswerProofInvalidatedError,
  type CodexPaginatedAnswerProofAnchor
} from "./codex-paginated-answer-proof.js";

export interface CodexAppServerInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[] | null;
}
export interface CodexAppServerPendingQuestion {
  requestId: string | number;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: CodexAppServerInputQuestion[];
  isBlocking: boolean;
}
export type CodexAppServerQuestionAnswers = Record<string, { answers: string[] }>;
export interface CodexAppServerAnswerResult {
  status: "confirmed" | "response_uncertain";
  requestId: string | number;
  itemId: string;
  reason?: string;
}
export interface CodexAppServerInteractionOptions {
  binding: CodexPaginatedThreadBinding;
  nativeTurnId: string;
  timeoutMs?: number;
  transportFactory?: (options: { socketPath: string; timeoutMs: number }) => Promise<CodexAppServerReadTransport>;
  sleep?: (milliseconds: number) => Promise<void>;
  captureAnswerProof?: typeof captureCodexPaginatedAnswerProof;
  readAnswerProof?: typeof readCodexPaginatedAnswerProof;
}
type PendingRpc = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type AllowedMethod = "initialize" | "thread/read" | "thread/turns/list" | "thread/resume" | "thread/unsubscribe";

/** Scoped question handling. This client cannot start, steer, stop, or configure turns. */
export class CodexAppServerInteractionClient {
  readonly metadata: CodexAppServerMetadata;
  private readonly requests = new Map<string, PendingRpc>();
  private readonly questions = new Map<string | number, CodexAppServerPendingQuestion>();
  private readonly sentAnswers = new Set<string | number>();
  private readonly resolvedRequests = new Set<string | number>();
  private readonly unsubscribe: (() => void)[];
  private nextId = 1;
  private closed = false;
  private attached = false;
  private rolloutPath?: string;

  private constructor(
    private readonly transport: CodexAppServerReadTransport,
    private readonly options: CodexAppServerInteractionOptions,
    private readonly timeoutMs: number,
    metadata: CodexAppServerMetadata
  ) {
    this.metadata = metadata;
    this.unsubscribe = [
      transport.onMessage((text) => this.receive(text)),
      transport.onDisconnect((error) => this.finish(error))
    ];
  }

  static async connect(options: CodexAppServerInteractionOptions): Promise<CodexAppServerInteractionClient> {
    if (!isAuditedCodexPaginatedServerPair(options.binding.agentVersion,
        options.binding.serverVersion) || !path.isAbsolute(options.binding.codexHome)) {
      throw new Error("Native Codex question binding is unsupported");
    }
    identifier(options.binding.threadId);
    identifier(options.nativeTurnId);
    const timeoutMs = options.timeoutMs ?? 5_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      throw new Error("Codex question timeout is invalid");
    }
    const socketPath = path.join(options.binding.codexHome, "app-server-control", "app-server-control.sock");
    const transport = await (options.transportFactory ?? connectCodexUnixWebSocket)({ socketPath, timeoutMs });
    const metadata = { socketPath, codexHome: "", serverVersion: "", platformFamily: "", platformOs: "" };
    const client = new CodexAppServerInteractionClient(transport, options, timeoutMs, metadata);
    try {
      // Resume updates future client identity. Preserve the native TUI identity so hooks,
      // plugin prompts and MCP policy retain their existing Codex terminal behavior.
      const initialized = await client.request("initialize", {
        clientInfo: { name: "codex-tui", title: "AKK native question bridge", version: options.binding.agentVersion },
        capabilities: { experimentalApi: true }
      });
      Object.assign(metadata, parseCodexAppServerMetadata(initialized, {
        codexHome: options.binding.codexHome, expectedServerVersion: options.binding.serverVersion
      }, socketPath));
      transport.send(JSON.stringify({ method: "initialized" }));
      await client.verifyActiveQuestionTurn();
      const resumed = object(await client.request("thread/resume", {
        threadId: options.binding.threadId, excludeTurns: true
      }));
      client.assertNativeThread(resumed.thread, true);
      client.attached = true;
      // Serialized metadata read is a barrier after resume's pending-request replay.
      await client.verifyActiveQuestionTurn();
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  listPendingQuestions(): readonly CodexAppServerPendingQuestion[] {
    return [...this.questions.values()].filter((question) => !this.sentAnswers.has(question.requestId))
      .map((question) => structuredClone(question));
  }

  async answer(requestId: string | number, answers: CodexAppServerQuestionAnswers): Promise<CodexAppServerAnswerResult> {
    if (this.sentAnswers.has(requestId)) {
      throw new Error("Codex question response was already sent; it cannot be retried");
    }
    const question = this.questions.get(requestId);
    if (!question || this.closed) throw new Error("The exact Codex question is no longer pending");
    const exactAnswers = structuredClone(answers);
    validateAnswers(question, exactAnswers);
    await this.verifyActiveQuestionTurn();
    if (this.sentAnswers.has(requestId)) {
      throw new Error("Codex question response was already sent; it cannot be retried");
    }
    if (
      this.questions.get(requestId) !== question ||
      this.resolvedRequests.has(requestId)
    ) {
      throw new Error("The exact Codex question was resolved before answering");
    }
    let proof: CodexPaginatedAnswerProofAnchor | undefined;
    try {
      if (this.rolloutPath) proof = (this.options.captureAnswerProof ?? captureCodexPaginatedAnswerProof)({
        codexHome: this.metadata.codexHome, rolloutPath: this.rolloutPath,
        threadId: question.threadId, turnId: question.turnId, itemId: question.itemId
      });
    } catch (error) {
      if (error instanceof CodexPaginatedAnswerProofInvalidatedError) throw error;
      // Inaccessible proof can only yield uncertain delivery after a single response write.
    }
    this.sentAnswers.add(requestId);
    try {
      // This is the only response write. Mark it sent before transport delivery is attempted.
      this.transport.send(JSON.stringify({ id: requestId, result: { answers: exactAnswers } }));
    } catch {
      return { status: "response_uncertain", requestId, itemId: question.itemId, reason: "question_response_delivery_uncertain" };
    }
    return this.confirmAnswer(question, exactAnswers, proof);
  }

  async close(): Promise<void> {
    try {
      if (this.attached && !this.closed) {
        await this.request("thread/unsubscribe", { threadId: this.options.binding.threadId });
      }
    } catch { /* Disconnect still removes only this client's subscription. */ }
    this.finish(new Error("Codex question connection closed"));
    this.transport.close();
  }

  private async verifyActiveQuestionTurn(): Promise<void> {
    const read = object(await this.request("thread/read", { threadId: this.options.binding.threadId, includeTurns: false }));
    this.assertNativeThread(read.thread, true);
    const page = object(await this.request("thread/turns/list", {
      threadId: this.options.binding.threadId, limit: 2, sortDirection: "desc", itemsView: "notLoaded"
    }));
    if (!Array.isArray(page.data) || page.data.length === 0) {
      throw new Error("Codex question's current turn is unavailable");
    }
    const latest = object(page.data[0]);
    if (latest.id !== this.options.nativeTurnId || latest.status !== "inProgress" ||
        page.data.slice(1).some((turn) => object(turn).status === "inProgress")) throw new Error("Codex question's exact active turn changed");
  }

  private assertNativeThread(value: unknown, requireWaiting: boolean): void {
    const thread = object(value);
    const status = object(thread.status);
    if (
      thread.id !== this.options.binding.threadId ||
      thread.historyMode !== "paginated" ||
      thread.originator !== "codex-tui"
    ) {
      throw new Error("Codex question's native thread identity changed");
    }
    if (
      status.type !== "active" ||
      (requireWaiting &&
      (!Array.isArray(status.activeFlags) ||
      !status.activeFlags.includes("waitingOnUserInput")))
    ) {
      throw new Error("Codex question's thread is not loaded and waiting on user input");
    }
    this.rolloutPath = typeof thread.path === "string" ? thread.path : undefined;
  }

  private async confirmAnswer(question: CodexAppServerPendingQuestion, answers: CodexAppServerQuestionAnswers,
    proof: CodexPaginatedAnswerProofAnchor | undefined): Promise<CodexAppServerAnswerResult> {
    const result = { requestId: question.requestId, itemId: question.itemId };
    if (!proof) {
      return { ...result, status: "response_uncertain", reason: "canonical_question_answer_evidence_unavailable" };
    }
    const sleep = this.options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + this.timeoutMs;
    do {
      try {
        const observed = (this.options.readAnswerProof ?? readCodexPaginatedAnswerProof)(proof, answers);
        if (observed === "matched") return { ...result, status: "confirmed" };
        if (observed === "different") {
          return { ...result, status: "response_uncertain", reason: "another_question_answer_won" };
        }
      } catch { return { ...result, status: "response_uncertain", reason: "canonical_question_answer_evidence_changed" }; }
      if (this.closed) break;
      await sleep(100);
    } while (Date.now() < deadline);
    return { ...result, status: "response_uncertain", reason: "canonical_question_answer_evidence_pending" };
  }

  private request(method: AllowedMethod, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Codex question connection is closed"));
    if (this.requests.size >= 16) {
      return Promise.reject(new Error("Too many scoped Codex question operations"));
    }
    const id = `akk-question-${this.nextId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new CodexAppServerReadError("timeout", `Codex question ${method} timed out`));
      }, this.timeoutMs);
      this.requests.set(id, { resolve, reject, timer });
      try { this.transport.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.requests.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  private receive(text: string): void {
    try {
      if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
        throw new Error("Codex question message exceeded its bound");
      }
      const message = object(JSON.parse(text));
      if (message.method === "item/tool/requestUserInput") { this.captureQuestion(message); return; }
      if (message.method === "serverRequest/resolved") {
        const params = object(message.params);
        if (params.threadId === this.options.binding.threadId && validRequestId(params.requestId)) {
          this.questions.delete(params.requestId);
          this.resolvedRequests.add(params.requestId);
          if (this.resolvedRequests.size > 128) {
            throw new Error("Too many Codex question resolution notifications");
          }
        }
        return;
      }
      if (message.method !== undefined || typeof message.id !== "string") return;
      const pending = this.requests.get(message.id);
      if (!pending) return;
      this.requests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) {
        const error = object(message.error);
        pending.reject(new CodexAppServerReadError("rpc_error", "Scoped Codex question operation was rejected", typeof error.code === "number" ? error.code : undefined));
      } else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
      else pending.reject(new Error("Codex question operation omitted its result"));
    } catch (error) { this.finish(error instanceof Error ? error : new Error("Invalid Codex question message")); this.transport.close(); }
  }

  private captureQuestion(message: Record<string, unknown>): void {
    const params = object(message.params);
    if (
      params.threadId !== this.options.binding.threadId ||
      params.turnId !== this.options.nativeTurnId
    ) {
      return;
    }
    if (!validRequestId(message.id) || this.resolvedRequests.has(message.id)) return;
    if (this.questions.size >= 16 && !this.questions.has(message.id)) {
      throw new Error("Too many pending Codex questions");
    }
    identifier(params.itemId);
    if (
      !Array.isArray(params.questions) ||
      params.questions.length === 0 ||
      params.questions.length > 16
    ) {
      throw new Error("Codex question batch is invalid");
    }
    const questions = params.questions.map(parseQuestion);
    if (new Set(questions.map((question) => question.id)).size !== questions.length) {
      throw new Error("Codex question IDs are duplicated");
    }
    if (params.isBlocking !== undefined && typeof params.isBlocking !== "boolean") {
      throw new Error("Codex question blocking flag is invalid");
    }
    const question = {
      requestId: message.id, threadId: params.threadId as string, turnId: params.turnId as string,
      itemId: params.itemId as string, questions, isBlocking: params.isBlocking === undefined ? true : params.isBlocking
    };
    const previous = this.questions.get(message.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(question)) {
      throw new Error("Codex pending question changed under the same request ID");
    }
    if (!previous) this.questions.set(message.id, question);
  }

  private finish(error: Error): void {
    this.closed = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.requests.clear();
    this.questions.clear();
    this.unsubscribe.forEach((unsubscribe) => unsubscribe());
  }
}

export const connectCodexAppServerInteractionClient = CodexAppServerInteractionClient.connect;

function parseQuestion(value: unknown): CodexAppServerInputQuestion {
  const question = object(value);
  identifier(question.id);
  for (const field of ["header", "question"]) if (
    typeof question[field] !== "string" ||
    (question[field] as string).length > 64 * 1024
  ) {
    throw new Error("Codex native question text is invalid");
  }
  for (const field of ["isOther", "isSecret"]) if (question[field] !== undefined && typeof question[field] !== "boolean") {
    throw new Error("Codex native question flag is invalid");
  }
  const options = question.options == null ? null : question.options;
  if (options !== null && (!Array.isArray(options) || options.length > 32)) {
    throw new Error("Codex question options exceeded their bound");
  }
  return {
    id: question.id as string, header: question.header as string, question: question.question as string,
    isOther: question.isOther === true, isSecret: question.isSecret === true,
    options: options === null ? null : (options as unknown[]).map((value) => {
      const option = object(value);
      if (
        typeof option.label !== "string" ||
        typeof option.description !== "string" ||
        option.label.length > 512 ||
        option.description.length > 64 * 1024
      ) {
        throw new Error("Codex question option is invalid");
      }
      return { label: option.label, description: option.description };
    })
  };
}
function validateAnswers(question: CodexAppServerPendingQuestion, value: CodexAppServerQuestionAnswers): void {
  const answers = object(value);
  const ids = question.questions.map((question) => question.id).sort();
  if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(ids)) {
    throw new Error("Codex response must answer the exact full question batch");
  }
  for (const id of ids) {
    const answer = object(answers[id]);
    if (Object.keys(answer).length !== 1 || !Array.isArray(answer.answers) || answer.answers.length === 0 || answer.answers.length > 32 ||
        answer.answers.some((value) => typeof value !== "string" || value.length === 0 || value.length > 64 * 1024)) throw new Error("Codex question answer is invalid");
  }
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error("Codex question identity is invalid");
  }
  return value;
}
function validRequestId(value: unknown): value is string | number {
  return typeof value === "string" ? value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value) : Number.isSafeInteger(value) && Number(value) >= 0;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid Codex question protocol object");
  }
  return value as Record<string, unknown>;
}

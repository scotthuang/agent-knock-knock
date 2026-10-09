import type { CodexAppServerReadTransport } from "./codex-app-server-transport.js";
import type { CodexAppServerMetadata, CodexAppServerThread, CodexAppServerThreadItem } from "./codex-app-server-read-client.js";

export interface CodexNativeIdentity { codexHome: string; threadId: string }
export type CodexNativeThread = CodexAppServerThread;
export interface CodexNativeTurn {
  id: string;
  status: "inProgress" | "completed" | "failed" | "interrupted";
  items: CodexAppServerThreadItem[];
  itemsComplete: boolean;
  error?: string;
}
export interface NativeQuestion {
  id: string;
  title: string;
  options: string[];
  isOther?: boolean;
  isSecret?: boolean;
}
/** Request IDs belong to a single connection. Persist id, threadId, turnId and itemId instead. */
export interface NativeInteraction {
  id: string;
  kind: "command_approval" | "file_approval" | "blocking_question" | "async_question";
  threadId: string;
  turnId: string;
  itemId: string;
  method: string;
  requestId?: number | string;
  approvalId?: string;
  nativeApprovalKind?: string;
  networkApprovalContext?: { host: string; protocol: string };
  questions: NativeQuestion[];
  command?: string;
  reason?: string;
  cwd?: string;
  availableDecisions?: string[];
  changes?: { path: string; kind?: string; diff?: string; diffTruncated?: boolean }[];
}
export interface CodexNativeSnapshot {
  threadId: string;
  thread: CodexNativeThread;
  loaded: boolean;
  latestTurnId: string | null;
  turns: CodexNativeTurn[];
  selectedTurn?: CodexNativeTurn;
  pendingInteractions: NativeInteraction[];
  canSend: boolean;
}
export type CodexNativePermissionPreset = "read-only" | "default" | "full-access";
export interface CodexNativePermissions {
  preset: CodexNativePermissionPreset | "custom";
  profileId: string | null;
  approvalPolicy: unknown;
  approvalsReviewer: string;
  sandbox: Record<string, unknown>;
}
export type NativeInteractionResponse = { decision: "accept" | "decline" | "cancel" }
  | { answers: Record<string, string[]> };
export interface CodexNativeClientOptions {
  codexHome: string;
  timeoutMs?: number;
  transportFactory?: (options: { socketPath: string; timeoutMs: number }) => Promise<CodexAppServerReadTransport>;
}
export type CodexNativeDispatchState = "not_sent" | "unknown" | "accepted";
export class CodexNativeError extends Error {
  constructor(public readonly code: "invalid_response" | "invalid_argument" | "timeout" | "closed" | "rpc_error"
    | "thread_not_loaded" | "thread_not_idle" | "unsupported_thread" | "stale_interaction"
    | "unsupported_capability" | "pagination_limit" | "duplicate_submission" | "unmaterialized_thread",
  message: string, public readonly dispatchState: CodexNativeDispatchState = "not_sent",
  public readonly rpcCode?: number, public readonly acceptedTurnId?: string) {
    super(message); this.name = "CodexNativeError";
  }
}
export interface CodexNativeReceipt { turnId: string; clientUserMessageId: string }
export type CodexNativeMetadata = CodexAppServerMetadata;

/** AKK projections of local, version-gated Desktop private IPC. Never expose raw snapshots. */
export interface DesktopThreadIdentity { codexHome: string; hostId: string; threadId: string }
export interface DesktopCompatibility { version: string; build: string }
export interface DesktopTurnItem {
  id: string;
  type: string;
  text?: string;
  clientId?: string | null;
  content?: { type: string; text?: string }[];
  phase?: string | null;
  status?: string;
  serverUserMessageId?: string | null;
  serverClientUserMessageId?: string | null;
  clientUserMessageId?: string | null;
  targetTurnId?: string | null;
  input?: { type: string; text?: string }[];
  delivery?: string | null;
  questions?: { title: string; options?: string[] }[] | null;
  requestId?: string | number;
  turnId?: string;
  completed?: boolean;
  answers?: Record<string, string[]>;
  command?: string;
  cwd?: string;
  exitCode?: number | null;
  aggregatedOutput?: string | null;
  changes?: DesktopFileChange[];
}
export interface DesktopQuestion { id: string; title: string; options: string[]; isOther?: boolean; isSecret?: boolean }
export interface DesktopFileChange { path: string; kind?: string; diff?: string; diffTruncated?: boolean }
export interface DesktopAsyncInteraction {
  id: string;
  kind: "async_question";
  threadId: string;
  turnId: string;
  itemId: string;
  method: "request_user_input_async";
  questions: [{ id: string; title: string; options: string[]; isOther: true }];
}
export interface DesktopRequestInteraction {
  id: string;
  kind: "command_approval" | "file_approval" | "blocking_question";
  threadId: string;
  turnId: string;
  itemId: string;
  method: string;
  requestId: string | number;
  questions: DesktopQuestion[];
  command?: string;
  reason?: string;
  cwd?: string;
  availableDecisions?: string[];
  approvalId?: string;
  nativeApprovalKind?: string;
  networkApprovalContext?: { host: string; protocol: string };
  changes?: DesktopFileChange[];
}
export type DesktopInteraction = DesktopAsyncInteraction | DesktopRequestInteraction;
export type DesktopRequestResponse = { decision: "accept" | "decline" | "cancel" } | { answers: Record<string, string[]> };
export interface DesktopCollaborationMode {
  mode: string;
  settings: { model: string; reasoning_effort: string | null; developer_instructions: string | null };
}
export interface DesktopCurrentPermissions {
  activePermissionProfile?: { id: string; extends?: string | null } | null;
  approvalPolicy?: string | Record<string, unknown>;
  approvalsReviewer?: string;
  sandboxPolicy?: Record<string, unknown>;
  runtimeWorkspaceRoots?: string[];
}
export interface DesktopThreadSettings extends DesktopCurrentPermissions {
  model?: string;
  effort?: string | null;
  collaborationMode?: DesktopCollaborationMode;
  permissions?: string;
}
export interface DesktopModelSettings {
  model: string | null;
  reasoningEffort: string | null;
  resumeState?: string;
  mode?: string | null;
  modelProvider?: string | null;
}
export interface DesktopSettingsUpdate {
  model?: string;
  effort?: string | null;
  collaborationMode?: DesktopCollaborationMode;
  permissions?: ":read-only" | ":workspace" | ":danger-full-access";
  approvalPolicy?: "on-request" | "never";
  approvalsReviewer?: "user";
}
export type DesktopTurnStatus = "inProgress" | "completed" | "failed" | "interrupted" | "unknown";
export interface DesktopTurn {
  turnId: string;
  status: DesktopTurnStatus;
  items: DesktopTurnItem[];
  /** False for summary/paginated/reconnecting item projections. */
  itemsComplete: boolean;
  error?: string;
}
export interface DesktopPendingRequest {
  kind: "approval" | "user_input" | "unknown";
  requestId?: string | number;
  method?: string;
  turnId?: string;
}
export interface DesktopSnapshot {
  threadId: string;
  ownerClientId: string;
  revision: number;
  title?: string;
  cwd?: string;
  mode?: string;
  originator?: string;
  resumeState?: string;
  runtimeStatus: "idle" | "active" | "notLoaded" | "systemError" | "unknown";
  pendingRequests: DesktopPendingRequest[];
  pendingRequestCount: number;
  /** Non-blocking questions live in turn items, not native pending requests. */
  asyncQuestions?: DesktopAsyncInteraction[];
  pendingInteractions?: DesktopInteraction[];
  threadSettings?: DesktopThreadSettings;
  currentPermissions?: DesktopCurrentPermissions;
  latestModel?: string;
  latestReasoningEffort?: string | null;
  latestCollaborationMode?: DesktopCollaborationMode;
  unconfirmedSubmissionCount: number;
  tailKnown: boolean;
  latestTurnId: string | null;
  turns: DesktopTurn[];
  canSend: boolean;
  idleBlockedReason?: string;
}
export interface DesktopOwner { ownerClientId: string; supportsUntrustedAppInput: boolean }
export interface DesktopObserveTarget { threadId: string; ownerClientId: string }
export interface DesktopSendTurnOptions extends DesktopObserveTarget {
  expectedRevision: number;
  expectedLatestTurnId: string | null;
  prompt: string;
  /** Persist with intent before dispatch. This is not a server deduplication key. */
  clientUserMessageId: string;
  beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}
export interface DesktopTurnReceipt {
  turnId: string;
  clientUserMessageId: string;
  revision: number;
  /** Verify exact user-message ownership after receipt; Desktop has no atomic idle precondition. */
  atomicIdlePrecondition: false;
}
export interface DesktopAsyncAnswerOptions extends DesktopObserveTarget {
  expectedRevision: number;
  expectedTurnId: string;
  interactionId: string;
  answer: string;
  clientUserMessageId: string;
  beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}
export interface DesktopAsyncAnswerReceipt {
  turnId: string;
  clientUserMessageId: string;
  revision: number;
  /** The follower derives the active turn; native echo must confirm exact acceptance. */
  atomicTurnPrecondition: false;
}
export interface DesktopRequestOptions extends DesktopObserveTarget {
  expectedRevision: number;
  expectedTurnId: string;
  interactionId: string;
  operationId: string;
  response: DesktopRequestResponse;
  beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}
export interface DesktopRequestReceipt {
  turnId: string; interactionId: string; requestId: string | number; revision: number; acknowledged: true;
}
export interface DesktopSettingsOptions extends DesktopObserveTarget {
  operationId: string; settings: DesktopSettingsUpdate; beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}
export interface DesktopSettingsReceipt { applied: true; snapshot: DesktopSnapshot; modelSettings: DesktopModelSettings }
export interface DesktopInterruptOptions extends DesktopObserveTarget {
  operationId: string; expectedTurnId: string; beforeDispatch?: (snapshot: DesktopSnapshot) => Promise<void>;
}
export interface DesktopInterruptReceipt { interruptedTurnId: string; snapshot: DesktopSnapshot }
export type DesktopDispatchState = "not_sent" | "unknown" | "accepted";
export type DesktopIpcErrorCode = "invalid_response" | "incompatible_desktop" | "timeout" | "closed"
  | "rpc_error" | "no_live_owner" | "owner_changed" | "snapshot_changed" | "thread_not_idle" | "duplicate_submission"
  | "unexpected_existing_turn" | "invalid_argument" | "unsafe_socket" | "stale_interaction";
export class DesktopIpcError extends Error {
  constructor(public readonly code: DesktopIpcErrorCode, message: string,
    public readonly dispatchState: DesktopDispatchState = "not_sent", public readonly acceptedTurnId?: string) {
    super(message); this.name = "DesktopIpcError";
  }
}
export interface DesktopIpcTransport {
  send(message: Record<string, unknown>): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onDisconnect(listener: (error: Error) => void): () => void;
  close(): void;
}
export interface DesktopIpcClientOptions {
  socketPath: string;
  compatibility: DesktopCompatibility;
  /** Backend discovery takes up to 10 seconds; client deadline must be >= 12 seconds. */
  timeoutMs?: number;
  transportFactory?: (options: { socketPath: string; timeoutMs: number }) => Promise<DesktopIpcTransport>;
}
export interface DesktopTransportPort {
  observe(identity: DesktopThreadIdentity): Promise<DesktopSnapshot>;
  start(identity: DesktopThreadIdentity, options: DesktopSendTurnOptions): Promise<DesktopTurnReceipt>;
  answerAsync?(identity: DesktopThreadIdentity, options: DesktopAsyncAnswerOptions): Promise<DesktopAsyncAnswerReceipt>;
  respondRequest?(identity: DesktopThreadIdentity, options: DesktopRequestOptions): Promise<DesktopRequestReceipt>;
}

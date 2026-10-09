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
  requestId?: string;
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
export type DesktopDispatchState = "not_sent" | "unknown" | "accepted";
export type DesktopIpcErrorCode = "invalid_response" | "incompatible_desktop" | "timeout" | "closed"
  | "rpc_error" | "owner_changed" | "snapshot_changed" | "thread_not_idle" | "duplicate_submission"
  | "unexpected_existing_turn" | "invalid_argument" | "unsafe_socket";
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
}

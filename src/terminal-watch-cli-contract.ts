/** Invocation contracts shared by Watch command adapters. */
import type { UserExplicitFallbackWatchReceipt } from "./terminal-watch-send-activity.js";
import { readCodexPaginatedTaskSnapshot } from "./codex-paginated-observation.js";
import type { CodexPaginatedTaskAnchor } from "./codex-paginated-task.js";
import { capturePaginatedWatchAnchor as capturePaginatedAnchor } from "./codex-paginated-watch.js";
import type { CallbackRouteV1 } from "./callback-transport.js";
import type { ClaudeAgentRow } from "./claude-terminal-agent-adapter.js";
import type { ExecutorKind } from "./executors.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { Conversation } from "./protocol.js";
import type { TerminalDispatchOwnership } from "./terminal-action-projection.js";
import type { TerminalControlEvidence, TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalWatchCallbackCliAdapter } from "./terminal-watch-callback-cli-adapter.js";
import type {
  TerminalWatchTerminalIdentity,
  TerminalActivityWatchAnchor,
  UserExplicitFallbackWatchAnchor
} from "./terminal-watch-store.js";

export interface TerminalWatchCliOptions {
  callbackRoute?: CallbackRouteV1;
  /** Private Host-adapter authority describing how a route template is bound. */
  callbackRouteControllerScope?: "startup_v1" | "route_bound_v1";
  claudeHome?: string;
  hardTimeoutMinutes?: number | string;
  openclawBin?: string;
  openclawSession?: string;
  storeDir?: string;
  terminal?: string;
  watch?: string;
  [option: string]: unknown;
}

export interface UserExplicitFallbackWatchTarget {
  conversationId: string;
  agent: ExecutorKind;
  pid: number;
  terminalControl: TerminalControlRef;
}

export interface PreparedUserExplicitFallbackWatch {
  watchId: string;
  terminalId: string;
  agent: ExecutorKind;
  pid: number;
  terminalEndpoint: TerminalControlEvidence;
  terminalIdentity: TerminalWatchTerminalIdentity;
  physicalToken: string;
  requestHash: string;
  callbackRoute: CallbackRouteV1;
  openclawSession: string;
  openclawBin: string;
  timeoutMs: number;
  anchor: UserExplicitFallbackWatchAnchor | CodexPaginatedTaskAnchor | TerminalActivityWatchAnchor;
  warnings?: string[];
}

export type ExactTerminalWatchObservation =
  | {
      state: "available";
      rawTerminal: Record<string, unknown>;
      terminal: Record<string, unknown>;
      summary: Record<string, unknown>;
    }
  | {
      state: "absent";
      reason?: string;
      summary: Record<string, unknown>;
    }
  | {
      state: "unavailable";
      reason?: string;
      summary: Record<string, unknown>;
    };

export interface TerminalWatchCliDependencies {
  capturePaginatedAnchor?: typeof capturePaginatedAnchor;
  readPaginatedSnapshot?: typeof readCodexPaginatedTaskSnapshot;
  acquireFileLock(lockPath: string): () => void;
  acquireTerminalLock(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): () => void;
  createBridge?(options: TerminalWatchCliOptions): TerminalAgentBridge;
  withStoreWriterLeaseAsync?<Result>(
    storeDir: string,
    operation: () => Promise<Result>
  ): Promise<Result>;
  observeExactTerminal(request: {
    options: TerminalWatchCliOptions;
    terminalId: string;
  }): Promise<ExactTerminalWatchObservation>;
  loadClaudeAgentRows(
    options: TerminalWatchCliOptions,
    observation?: { required?: boolean }
  ): readonly ClaudeAgentRow[];
  now(): Date;
  randomUUID(): string;
  storeDirFromOptions(options: TerminalWatchCliOptions): string;
  terminalDispatchOwnership(
    terminalControl: TerminalControlRef
  ): TerminalDispatchOwnership<Conversation, Record<string, unknown>>;
  terminalIncarnationBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): Conversation[];
  printJson(value: unknown): void;
  callback?: TerminalWatchCallbackCliAdapter;
}

export interface TerminalWatchCliFacade {
  prepareUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    terminal: UserExplicitFallbackWatchTarget;
    requestHash: string;
    requestText?: string;
    messageId: string;
    physicalToken: string;
  }): Promise<PreparedUserExplicitFallbackWatch | undefined>;
  attachUserExplicitFallbackWatch(input: {
    options: TerminalWatchCliOptions;
    prepared: PreparedUserExplicitFallbackWatch;
  }): Promise<UserExplicitFallbackWatchReceipt>;
  userExplicitFallbackWatchReceipt(input: {
    options: TerminalWatchCliOptions;
    watchId: string;
  }): UserExplicitFallbackWatchReceipt | undefined;
  runWatch(options: TerminalWatchCliOptions): Promise<void>;
  runUnwatch(options: TerminalWatchCliOptions): Promise<void>;
  runWatchStatus(options: TerminalWatchCliOptions): Promise<void>;
  runRespondInteraction(options: TerminalWatchCliOptions): Promise<void>;
  runReconcileWatches(options: TerminalWatchCliOptions): Promise<void>;
  listPublicWatches(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): Array<Record<string, unknown>>;
  scanPublicWatchesForExactObservation(
    storeDir: string,
    options?: { includeAll?: boolean }
  ): {
    watches: Array<Record<string, unknown>>;
    activeOverlayTrusted: boolean;
  };
}

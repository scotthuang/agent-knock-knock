import type {
  TerminalNativeControlCliOptions
} from "./terminal-native-control-cli-contract.js";

import type {
  ExecutorKind
} from "./executors.js";
import type {
  FileLockAcquisitionOptions
} from "./file-lock-cli-adapter.js";
import {
  type ManagedSessionState
} from "./managed-session.js";
import {
  type LifecycleTerminalObservation
} from "./native-thread-lifecycle-query-service.js";

import {
  type Conversation
} from "./protocol.js";

import type {
  TerminalControlRef,
  TerminalRuntimeIdentity,
  TerminalThreadLifecycleCapabilities
} from "./terminal-agent-adapter.js";
import {
  type ResolvedTerminalConversation
} from "./terminal-agent-bridge.js";
import {
  type CodexAllowedCompanionSet
} from "./terminal-authority-policy.js";
import type {
  TerminalNativeIdentity
} from "./terminal-binding-authority.js";
import type {
  TerminalDispatchLedgerDocument
} from "./terminal-dispatch-ledger-codec.js";

import type {
  TerminalRuntimeCliAdapter
} from "./terminal-runtime-cli-adapter.js";

export type NativeLifecycleCliOptions = TerminalNativeControlCliOptions;

export interface NativeLifecycleSnapshot {
  readonly identity?: TerminalNativeIdentity;
  readonly runtimeIdentity?: TerminalNativeIdentity;
  readonly codexCompanions: CodexAllowedCompanionSet;
  readonly session?: ManagedSessionState;
  readonly version?: string;
  readonly capabilities: TerminalThreadLifecycleCapabilities;
  readonly bindingToken: string;
  readonly bindingTokens: readonly string[];
}

export interface NativeLifecycleIdentityPorts {
  resolveCurrent(input: {
    options: NativeLifecycleCliOptions;
    agent: ExecutorKind;
    pid: number;
    cwd?: string;
    preferredSessionId?: string;
    allowedCompanionIdentity?: CodexAllowedCompanionSet["primary"];
    allowedAdditionalIdentities?: readonly NonNullable<
      CodexAllowedCompanionSet["primary"]
    >[];
  }): Promise<TerminalNativeIdentity | undefined>;
  managedContext(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
  }): {
    preferredSessionId?: string;
    companions: CodexAllowedCompanionSet;
  };
  boundSession(input: {
    storeDir: string;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState | undefined;
  materializeSession(input: {
    options: NativeLifecycleCliOptions;
    terminal: ResolvedTerminalConversation;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState | undefined;
  refineSession(input: {
    storeDir: string;
    session: ManagedSessionState;
    terminalControl: TerminalControlRef;
    identity?: TerminalNativeIdentity;
  }): ManagedSessionState;
  logicalIdentity(input: {
    storeDir: string;
    session: ManagedSessionState;
    observedIdentity?: TerminalNativeIdentity;
  }): TerminalNativeIdentity | undefined;
  companionSet(input: {
    storeDir: string;
    session: ManagedSessionState;
  }): CodexAllowedCompanionSet;
  processIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
  /**
   * Provider-independent operating-system process identity used only for
   * explicit physical-terminal authority. Keep it separate from Codex native
   * lifecycle identity so the producer and consumer of a physical token cannot
   * silently choose different UUID namespaces.
   */
  physicalProcessIncarnation(pid: number): {
    processUuid: string;
    processBirth: string;
  };
  runtimeForLiveIdentity(input: {
    terminal: LifecycleTerminalObservation;
    identity?: TerminalNativeIdentity;
    expectedEmptyNativeSession?: boolean;
    physicalOnly?: boolean;
  }): TerminalRuntimeIdentity;
  ownerIsInactive(input: {
    session: ManagedSessionState;
    terminal: LifecycleTerminalObservation;
    identity?: TerminalNativeIdentity;
  }): boolean;
  assertCodexComposerReady(input: {
    options: NativeLifecycleCliOptions;
    terminalControl: TerminalControlRef;
  }): Promise<void>;
}

export interface NativeLifecycleStatePorts {
  storeDir(options: NativeLifecycleCliOptions): string;
  inspectStore(storeDir: string): { writable: boolean };
  runtimeDir(): string;
  acquireTerminal(
    storeDir: string,
    terminalControl: TerminalControlRef,
    options?: FileLockAcquisitionOptions
  ): () => void;
  loadLedger(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
  managedTurns(storeDir: string, sessionId: string): readonly Conversation[];
  terminalBlockingTurns(
    storeDir: string,
    terminalControl: TerminalControlRef
  ): readonly Conversation[];
  hasUnresolvedTransition(
    storeDir: string,
    session: ManagedSessionState
  ): boolean;
  dispatchOwnership(terminalControl: TerminalControlRef): { state: string };
  assertNativeThreadStoreAuthority(input: {
    terminalControl: TerminalControlRef;
    nativeThreadId: string;
    storeDir: string;
  }): void;
  orphanedForRecovery(terminalControl: TerminalControlRef):
    TerminalDispatchLedgerDocument | undefined;
}

export interface CreateNativeThreadLifecycleCliAdapterInput {
  runtime: {
    forOptions(options: NativeLifecycleCliOptions): TerminalRuntimeCliAdapter;
    sleep(milliseconds: number): Promise<void>;
  };
  identity: NativeLifecycleIdentityPorts;
  state: NativeLifecycleStatePorts;
  output: {
    cwd(): string;
    print(value: unknown): void;
  };
}

export interface NativeThreadOwnershipRequest {
  options: NativeLifecycleCliOptions;
  agent: ExecutorKind;
  currentPid: number;
  nativeThreadId: string;
  storeDir: string;
  terminalControl: TerminalControlRef;
  excludedManagedSessionId?: string;
  allowedManagedSessionIds?: string[];
}

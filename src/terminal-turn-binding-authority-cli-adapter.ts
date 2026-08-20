import path from "node:path";

import type { ManagedSessionState } from "./managed-session.js";
import {
  executorForConversation,
  sessionIdForConversation,
  turnIdForConversation,
  type Conversation
} from "./protocol.js";
import { loadManagedSession } from "./session-store.js";
import {
  ensureStoreWritable,
  STORE_SESSION_AUTHORITY_PROTOCOL
} from "./store.js";
import type { TerminalControlRef } from "./terminal-agent-adapter.js";
import {
  terminalControlAliasMatches,
  terminalControlsShareIncarnation
} from "./terminal-authority-policy.js";
import { migratedTerminalBindingMatches } from
  "./terminal-dispatch-execution.js";
import { terminalControlFromTakeover } from
  "./terminal-runtime-cli-adapter.js";
import {
  isRecord,
  nonBlankString as stringValue,
  type UnknownRecord
} from "./value-guards.js";

export interface TerminalTurnBindingAuthorityCliDependencies {
  storeDirForConversation(conversation: Conversation): string | undefined;
}

export interface TerminalTurnBindingSuperseded {
  code: "AKK_TURN_BINDING_SUPERSEDED";
  message: string;
}

export interface TerminalTurnBindingAuthorityCliAdapter {
  assertCurrent(conversation: Conversation, operation: string): void;
  superseded(error: unknown): TerminalTurnBindingSuperseded | undefined;
}

class TurnBindingSupersededError extends Error {
  readonly code = "AKK_TURN_BINDING_SUPERSEDED" as const;

  constructor(message: string) {
    super(message);
    this.name = "TurnBindingSupersededError";
  }
}

/** Own the Store-backed current-Turn binding fence used by CLI mutations. */
export function createTerminalTurnBindingAuthorityCliAdapter(
  dependencies: TerminalTurnBindingAuthorityCliDependencies
): TerminalTurnBindingAuthorityCliAdapter {
  return Object.freeze({
    assertCurrent(conversation, operation) {
      assertTurnBindingCurrent(dependencies, conversation, operation);
    },
    superseded(error) {
      return error instanceof TurnBindingSupersededError
        ? { code: error.code, message: error.message }
        : undefined;
    }
  });
}

function assertTurnBindingCurrent(
  dependencies: TerminalTurnBindingAuthorityCliDependencies,
  conversation: Conversation,
  operation: string
): void {
  const storeDir = dependencies.storeDirForConversation(conversation);
  if (!storeDir) return;
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  // Delegated, non-terminal Turns predate first-class Session authority.
  if (!isRecord(takeover?.terminal_control)) return;
  const terminalControl = terminalControlFromTakeover(takeover);
  if (!terminalControl) {
    throw new Error(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: its ` +
      "terminal binding is malformed"
    );
  }
  // The writable-Store upgrade must precede the authoritative Session read.
  const manifest = ensureStoreWritable(storeDir);
  if (manifest.writer_protocol < STORE_SESSION_AUTHORITY_PROTOCOL) {
    throw new Error(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: ` +
      "its Store has no protocol-3 Session authority"
    );
  }
  const session = loadManagedSession(
    storeDir,
    sessionIdForConversation(conversation)
  );
  const bindingId = stringValue(conversation.terminal_binding_id);
  const bindingGeneration = Number(conversation.terminal_binding_generation);
  const turnNativeThreadId = stringValue(conversation.native_thread_id) ??
    stringValue(takeover.terminal_agent_session_id);
  const exactModernBinding = Boolean(
    bindingId && Number.isSafeInteger(bindingGeneration) &&
    session.status === "bound" && session.binding?.binding_id === bindingId &&
    session.binding.generation === bindingGeneration &&
    session.binding.native_thread_id === turnNativeThreadId
  );
  const compatibleMigratedBinding = Boolean(
    !bindingId && !Number.isSafeInteger(bindingGeneration) &&
    session.lineage.created_by === "migration" && !session.last_transition_id &&
    migratedTerminalTurnMatchesSessionBinding({
      conversation, takeover, terminalControl, session, turnNativeThreadId
    })
  );
  if (!exactModernBinding && !compatibleMigratedBinding) {
    throw new TurnBindingSupersededError(
      `cannot ${operation} Turn ${turnIdForConversation(conversation)}: its ` +
      "Session binding generation is no longer current"
    );
  }
}

function migratedTerminalTurnMatchesSessionBinding({
  conversation,
  takeover,
  terminalControl,
  session,
  turnNativeThreadId
}: {
  conversation: Conversation;
  takeover: UnknownRecord;
  terminalControl: TerminalControlRef;
  session: ManagedSessionState;
  turnNativeThreadId?: string;
}): boolean {
  const binding = session.binding;
  const terminalId = stringValue(takeover.native_session_id);
  return migratedTerminalBindingMatches({
    session,
    agent: executorForConversation(conversation).kind,
    workspaceMatches:
      path.resolve(session.workspace) === path.resolve(conversation.workspace),
    terminalId,
    terminalAliasMatches: Boolean(binding && terminalId &&
      terminalControlAliasMatches(
        terminalId,
        terminalControl,
        binding.terminal_id,
        binding.terminal_control
      )),
    terminalIncarnationMatches: Boolean(binding &&
      terminalControlsShareIncarnation(
        binding.terminal_control,
        terminalControl
      )),
    pid: Number(takeover.terminal_agent_pid),
    nativeThreadId: turnNativeThreadId,
    processUuid: stringValue(takeover.terminal_agent_process_uuid),
    processBirth: stringValue(takeover.terminal_agent_process_birth),
    rollout: isRecord(takeover.terminal_agent_rollout)
      ? takeover.terminal_agent_rollout
      : undefined
  });
}

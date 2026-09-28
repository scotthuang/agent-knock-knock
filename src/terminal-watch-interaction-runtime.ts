import type { CodexPaginatedTaskAnchor } from "./codex-paginated-task.js";
import type { CodexOpenRootRolloutInventory } from "./agent-session-provider.js";
import type { TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import { rolloutFileIdentityMatches } from "./terminal-binding-authority.js";
import {
  isTerminalActivityWatch,
  type TerminalWatch,
  type TerminalWatchObservationCheckpoint
} from "./terminal-watch-record.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";

export function terminalInteractionRuntimeForWatch(input: {
  watch: TerminalWatch;
  rawTerminal: Record<string, unknown>;
  checkpoint: TerminalWatchObservationCheckpoint;
  version: string;
  responseAuthority: "executable" | "notify_only";
  terminalTarget: string;
}): TerminalRuntimeIdentity {
  const { watch, rawTerminal, checkpoint } = input;
  let nativeSessionId = stringValue(rawTerminal.native_agent_session_id);
  let nativeProcessUuid = stringValue(rawTerminal.native_agent_process_uuid);
  let nativeProcessBirth = stringValue(rawTerminal.native_agent_process_birth);
  let nativeTaskId: string | undefined;
  let codexPaginatedThread: TerminalRuntimeIdentity["codexPaginatedThread"];
  let nativeRollout = isRecord(rawTerminal.native_agent_rollout)
    ? rawTerminal.native_agent_rollout as unknown as NonNullable<
        TerminalRuntimeIdentity["nativeRollout"]
      >
    : undefined;
  if (watch.anchor.schema === "agent-knock-knock/codex-paginated-task-anchor") {
    ({ nativeSessionId, nativeProcessUuid, nativeProcessBirth, nativeTaskId,
      codexPaginatedThread } = paginatedWatchIdentity(watch.anchor, checkpoint));
    nativeRollout = undefined;
  } else if (
    watch.anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    nativeTaskId = watch.anchor.turn_id;
    nativeSessionId = watch.anchor.native_thread_id;
    nativeProcessUuid = watch.anchor.process_uuid;
    nativeProcessBirth = watch.anchor.process_birth;
    nativeRollout = watch.anchor.rollout;
  } else if (
    watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor" &&
    "schema" in checkpoint &&
    checkpoint.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" &&
    checkpoint.accepted_identity
  ) {
    nativeTaskId = checkpoint.acceptance_evidence?.acceptanceId;
    nativeSessionId = checkpoint.accepted_identity.native_thread_id;
    nativeProcessUuid = checkpoint.accepted_identity.process_uuid;
    nativeProcessBirth = checkpoint.accepted_identity.process_birth;
    nativeRollout = checkpoint.accepted_identity.rollout;
  } else if (
    watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    nativeSessionId = watch.anchor.session_id;
  } else if (
    watch.anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    nativeSessionId = watch.anchor.transcript_anchor.session_id;
  }
  const inventory = isRecord(rawTerminal._codex_open_root_rollout_inventory)
    ? rawTerminal._codex_open_root_rollout_inventory as unknown as
      CodexOpenRootRolloutInventory
    : undefined;
  const allowedAdditionalNativeIdentities =
    inventory && nativeRollout
      ? inventory.roots.filter((root) =>
          !rolloutFileIdentityMatches(root.rollout, nativeRollout))
        .map((root) => ({
          sessionId: root.sessionId,
          processUuid: root.processUuid,
          processBirth: root.processBirth,
          rollout: root.rollout
        }))
      : [];
  return {
    pid: positiveInteger(rawTerminal.pid, "terminal agent PID"),
    agentVersion: input.version,
    interactionSubject: {
      kind: "terminal_watch",
      watch_id: watch.watch_id,
      anchor_fingerprint: watch.anchor.anchor_fingerprint
    },
    interactionResponseAuthority: input.responseAuthority,
    nativeTaskId,
    codexPaginatedThread,
    nativeSessionId,
    nativeProcessUuid,
    nativeProcessBirth,
    nativeRollout,
    requireNativeProcessUuid: watch.agent === "claude" &&
      !isTerminalActivityWatch(watch),
    requireNativeRolloutIdentity: watch.agent === "codex" &&
      !isTerminalActivityWatch(watch) && !codexPaginatedThread,
    allowedAdditionalNativeIdentities,
    ...nativeProcessStartFields(rawTerminal),
    cwd: watch.terminal.workspace,
    conversationId: watch.terminal.terminal_id,
    terminalTarget: input.terminalTarget
  };
}
function paginatedWatchIdentity(
  anchor: CodexPaginatedTaskAnchor, checkpoint: TerminalWatchObservationCheckpoint
): Pick<TerminalRuntimeIdentity, "nativeSessionId" | "nativeProcessUuid" | "nativeProcessBirth" | "nativeTaskId" | "codexPaginatedThread"> {
  const nativeTaskId = "schema" in checkpoint && checkpoint.schema === "agent-knock-knock/codex-paginated-task-checkpoint"
    ? checkpoint.acceptance_evidence?.acceptanceId ?? anchor.turn_id : anchor.turn_id;
  return {
    nativeSessionId: anchor.native_thread_id, nativeProcessUuid: anchor.process_uuid,
    nativeProcessBirth: anchor.process_birth, nativeTaskId,
    codexPaginatedThread: {
      codexHome: anchor.codex_home, threadId: anchor.native_thread_id,
      serverVersion: anchor.codex_version, processUuid: anchor.process_uuid,
      processBirth: anchor.process_birth, pid: anchor.pid, observedAt: anchor.captured_at
    }
  };
}

function nativeProcessStartFields(rawTerminal: Record<string, unknown>): Pick<TerminalRuntimeIdentity, "nativeProcessStartedAt"> {
  const startedAt = Number(rawTerminal.native_agent_process_started_at);
  return Number.isSafeInteger(startedAt) && startedAt > 0 ? { nativeProcessStartedAt: startedAt } : {};
}

function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

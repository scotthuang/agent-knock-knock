import { captureCodexPaginatedThreadBinding } from "./codex-paginated-thread-binding.js";
import { captureCodexPaginatedTaskAnchor, readCodexPaginatedTaskSnapshot } from "./codex-paginated-observation.js";
import { observeCodexPaginatedTask, type CodexPaginatedTaskSnapshot, type CodexPaginatedTaskObservation, type CodexPaginatedTaskAnchor, type CodexPaginatedTaskCheckpoint } from "./codex-paginated-task.js";
import type { TerminalAgentBridge } from "./terminal-agent-bridge.js";
import type { TerminalRuntimeIdentity } from "./terminal-agent-adapter.js";
import type { TerminalControlRef } from "./terminal-control-ref.js";
import type { TerminalWatch } from "./terminal-watch-record.js";
import { isRecord, nonBlankString } from "./value-guards.js";
import { terminalWatchObservationFence, type TerminalWatchObservation } from "./terminal-watch-service.js";
import type { CodexAsyncQuestionDurableEvidence } from "./codex-async-question-adapter.js";
import { createHash } from "node:crypto";
import { isAuditedCodexPaginatedServerPair } from "./codex-lifecycle-compatibility.js";

export { isPaginatedSendWatch } from "./terminal-watch-record.js";

export function paginatedWatchProcessMatches(terminal: Record<string, unknown>, anchor: CodexPaginatedTaskAnchor): boolean {
  return Number(terminal.pid) === anchor.pid &&
    terminal.native_agent_process_uuid === anchor.process_uuid &&
    terminal.native_agent_process_birth === anchor.process_birth &&
    terminal.agent_version === anchor.codex_version;
}

/** The caller holds the terminal input lease during this closed status probe. */
export async function capturePaginatedWatchAnchor(input: {
  terminal: Record<string, unknown>;
  bridge: TerminalAgentBridge;
  codexHome?: string;
  requestHash?: string;
  now: () => Date;
}): Promise<CodexPaginatedTaskAnchor | undefined> {
  const { terminal } = input;
  const pid = Number(terminal.pid);
  if (!Number.isSafeInteger(pid) || pid < 2 || !isRecord(terminal.terminal_control)) {
    throw new Error("Codex paginated Watch needs an exact live terminal process");
  }
  const binding = await captureCodexPaginatedThreadBinding({
    bridge: input.bridge,
    terminalControl: terminal.terminal_control as unknown as TerminalControlRef,
    pid, agentVersion: nonBlankString(terminal.agent_version) ?? "",
    codexHome: input.codexHome, allowWorking: input.requestHash === undefined, now: input.now
  });
  if (terminal.native_agent_process_uuid !== binding.processUuid ||
      terminal.native_agent_process_birth !== binding.processBirth) {
    throw new Error("Codex physical process changed before paginated history capture");
  }
  return captureCodexPaginatedTaskAnchor({ binding, requestHash: input.requestHash, now: input.now() });
}

export async function observePaginatedWatch(input: {
  watch: TerminalWatch;
  observedAt: string;
  terminalMatches: boolean;
  terminalAvailable: boolean;
  questionnaire: (checkpoint: CodexPaginatedTaskCheckpoint,
    questions: readonly CodexAsyncQuestionDurableEvidence[],
    allowResponses: boolean) => TerminalWatchObservation | undefined;
  blockingQuestionnaire?: (checkpoint: CodexPaginatedTaskCheckpoint) => Promise<TerminalWatchObservation | undefined>;
  readSnapshot?: typeof readCodexPaginatedTaskSnapshot;
}): Promise<TerminalWatchObservation> {
  const { watch } = input;
  const anchor = watch.anchor;
  if (anchor.schema !== "agent-knock-knock/codex-paginated-task-anchor") throw new Error("Expected paginated Watch anchor");
  const checkpoint = watch.observation_checkpoint;
  if (!("schema" in checkpoint) || checkpoint.schema !== "agent-knock-knock/codex-paginated-task-checkpoint") {
    throw new Error("Codex paginated Watch checkpoint is missing");
  }
  const base = { ...terminalWatchObservationFence(watch), observed_at: input.observedAt };
  let snapshot;
  try {
    snapshot = await (input.readSnapshot ?? readCodexPaginatedTaskSnapshot)({
      codexHome: anchor.codex_home, threadId: anchor.native_thread_id,
      serverVersion: anchor.backend_version ?? anchor.codex_version,
      boundaryTurnId: checkpoint.acceptance_evidence?.acceptanceId ?? anchor.turn_id ?? anchor.baseline_latest_turn_id
    });
  } catch {
    return { ...base, kind: "unavailable", reason_code: "codex_paginated_history_unavailable" };
  }
  const result = observeCodexPaginatedTask({ anchor, checkpoint, snapshot });
  if (result.status !== "pending" && result.status !== "accepted") {
    return paginatedTaskTerminalObservation(anchor, result, base);
  }
  if (input.terminalAvailable && !input.terminalMatches) {
    return { ...base, kind: "invalidated", reason_code: "codex_paginated_terminal_identity_changed",
      evidence_fingerprint: digest({ anchor: anchor.anchor_fingerprint, reason: "physical_identity_changed" }) };
  }
  // Read compatibility never grants write compatibility. A previously actionable
  // Watch must not keep answer authority after its shared backend changes.
  const allowResponses = snapshot.serverVersion === (anchor.backend_version ?? anchor.codex_version) &&
    isAuditedCodexPaginatedServerPair(anchor.codex_version, snapshot.serverVersion);
  const prior = watch.current_interaction;
  if (!allowResponses && prior?.aggregate.state === "pending" &&
      prior.projection.response_authority === "executable") {
    // Revoke the stored offer before considering another surface. Its old
    // prompt is not fresh evidence for a replacement manual notification.
    return { ...base, kind: input.terminalAvailable ? "pending" : "unavailable",
      observation_checkpoint: result.checkpoint, last_activity_at: input.observedAt,
      interaction_write_capability_lost: {
        interaction_id: prior.projection.interaction_id,
        prompt_fingerprint: prior.projection.prompt_fingerprint
      } };
  }
  if (input.terminalMatches && allowResponses && paginatedTaskNeedsBlockingAnswer(snapshot) && input.blockingQuestionnaire) {
    const blocking = await input.blockingQuestionnaire(result.checkpoint);
    if (blocking) return blocking;
  }
  const interaction = input.terminalMatches ? input.questionnaire(result.checkpoint, result.questions, allowResponses) : undefined;
  return interaction ?? { ...base, kind: input.terminalAvailable ? "pending" : "unavailable",
    observation_checkpoint: result.checkpoint, last_activity_at: input.observedAt };
}

function paginatedTaskTerminalObservation(
  anchor: CodexPaginatedTaskAnchor,
  result: Exclude<CodexPaginatedTaskObservation, { status: "pending" | "accepted" }>,
  base: ReturnType<typeof terminalWatchObservationFence> & { observed_at: string }
): TerminalWatchObservation {
  if (result.status === "uncertain" || result.status === "invalidated") {
    return { ...base, kind: "invalidated", reason_code: "codex_paginated_task_identity_changed",
      evidence_fingerprint: digest({ anchor: anchor.anchor_fingerprint, reason: result.reason }) };
  }
  if (result.status === "unavailable") return { ...base, kind: "unavailable", reason_code: "codex_paginated_history_incomplete" };
  return { ...base, kind: result.completion.outcome === "failure" ? "failed" : "completed",
      observation_checkpoint: result.checkpoint,
      evidence_fingerprint: digest({ anchor: anchor.anchor_fingerprint, completion: result.completion }),
      reason_code: "codex_paginated_task_completed", completion_id: result.completion.id,
      completion_timestamp: result.completion.timestamp, completion_text: result.completion.text.slice(0, 4000) };
}

function paginatedTaskNeedsBlockingAnswer(snapshot: CodexPaginatedTaskSnapshot): boolean {
  return snapshot.thread.status.type === "active" && snapshot.thread.status.activeFlags.includes("waitingOnUserInput");
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Reversible navigation happens before the one-shot answer reservation. */
export async function refreshPaginatedResponseForeground(
  bridge: TerminalAgentBridge, control: TerminalControlRef,
  runtime: TerminalRuntimeIdentity, now: () => Date
): Promise<void> {
  const bound = runtime.codexPaginatedThread;
  if (!bound) throw new Error("Codex response has no paginated thread binding");
  const navigation = await bridge.collapseCodexAsyncQuestionForStatus(control, runtime);
  const current = await captureCodexPaginatedThreadBinding({
    bridge, terminalControl: navigation.terminalControl, pid: bound.pid,
    agentVersion: bound.agentVersion, codexHome: bound.codexHome, allowWorking: true, now
  });
  if (current.threadId !== bound.threadId || current.serverVersion !== bound.serverVersion ||
      current.processUuid !== bound.processUuid || current.processBirth !== bound.processBirth) {
    throw new Error("Codex foreground thread changed before the exact question response");
  }
  runtime.codexPaginatedThread = current;
  if (navigation.restore) {
    await bridge.restoreCodexAsyncQuestionAfterStatus(navigation.terminalControl, runtime, navigation.restore);
  }
}

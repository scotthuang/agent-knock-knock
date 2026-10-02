/** Exact terminal identity and validated Watch command inputs. */
import { assertAutomaticActivityWatchIdentity } from "./terminal-watch-send-activity.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexPaginatedTaskAnchor } from "./codex-paginated-task.js";
import { paginatedWatchProcessMatches } from "./codex-paginated-watch.js";
import type { ExecutorKind } from "./executors.js";
import { rolloutFileIdentityMatches } from "./terminal-binding-authority.js";
import type { CodexRolloutAcceptanceIdentity } from "./terminal-submission-acceptance.js";
import {
  type TerminalControlRef,
  sameTerminalControlEvidenceIncarnation,
  terminalControlEvidence
} from "./terminal-control-ref.js";
import {
  isTerminalActivityWatch,
  isUserExplicitFallbackWatch,
  type TerminalWatch,
  type TerminalWatchAnchor,
  type TerminalWatchCurrentInteraction,
  type TerminalWatchTerminalIdentity,
  type TerminalActivityState
} from "./terminal-watch-store.js";
import { isRecord, nonBlankString as stringValue } from "./value-guards.js";
import type {
  TerminalWatchCliOptions,
  UserExplicitFallbackWatchTarget,
  PreparedUserExplicitFallbackWatch,
  ExactTerminalWatchObservation,
  TerminalWatchCliDependencies
} from "./terminal-watch-cli-contract.js";

export function assertSameUserExplicitFallbackTerminal(
  expected: UserExplicitFallbackWatchTarget,
  observed: Record<string, unknown>
): void {
  if (
    requiredString(observed.id, "terminal id") !== expected.conversationId ||
    terminalAgent(observed) !== expected.agent ||
    positiveInteger(observed.pid, "terminal PID") !== expected.pid ||
    !isRecord(observed.terminal_control) ||
    !sameTerminalControlEvidenceIncarnation(
      expected.terminalControl,
      observed.terminal_control as unknown as TerminalControlRef
    )
  ) {
    throw new Error(
      "terminal changed before the user-explicit fallback Watch anchor was captured"
    );
  }
}

export function assertPreparedFallbackTerminal(
  prepared: PreparedUserExplicitFallbackWatch,
  observed: Record<string, unknown>
): void {
  if (
    requiredString(observed.id, "terminal id") !== prepared.terminalId ||
    terminalAgent(observed) !== prepared.agent ||
    positiveInteger(observed.pid, "terminal PID") !== prepared.pid ||
    !isRecord(observed.terminal_control) ||
    !sameTerminalControlEvidenceIncarnation(
      prepared.terminalEndpoint,
      observed.terminal_control as unknown as TerminalControlRef
    )
  ) {
    throw new Error(
      "terminal changed before the user-explicit fallback Watch was attached"
    );
  }
  if (isTerminalActivityWatch(prepared)) {
    assertAutomaticActivityWatchIdentity(prepared.anchor, observed,
      terminalWorkspace(observed), prepared.terminalIdentity.workspace);
  }
}

export async function exactTerminalForWatch(
  terminalId: string,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<Extract<ExactTerminalWatchObservation, { state: "available" }>> {
  const observation = await dependencies.observeExactTerminal({
    options,
    terminalId
  });
  if (observation.state === "unavailable") {
    throw new Error(
      "authoritative observation of the exact terminal is temporarily " +
      "unavailable; retry after refreshing AKK list"
    );
  }
  if (observation.state === "absent") {
    throw new Error(`expected exact terminal ${terminalId}; observed none`);
  }
  return observation;
}

function bindingTokenForWatch(
  terminal: Record<string, unknown>
): string {
  return requiredSha256(
    terminal.lifecycle_binding_token,
    "current terminal binding token"
  );
}

export function bestEffortBindingTokenForWatch(
  terminal: Record<string, unknown>
): { token: string; warning?: string } {
  try {
    return { token: bindingTokenForWatch(terminal) };
  } catch {
    const terminalControl = terminalControlForWatch(terminal);
    return {
      token: sha256({
        schema: "agent-knock-knock/terminal-watch-observation-binding",
        version: 1,
        terminal_id: requiredString(terminal.id, "terminal id"),
        agent: terminalAgent(terminal),
        pid: positiveInteger(terminal.pid, "terminal PID"),
        endpoint: terminalControlEvidence(terminalControl),
        process_uuid: stringValue(terminal.native_agent_process_uuid) ?? null,
        process_birth: stringValue(terminal.native_agent_process_birth) ?? null
      }),
      warning:
        "lifecycle_binding_token_unavailable: Watch used read-only terminal/process observation identity"
    };
  }
}

export function terminalActivityState(
  terminal: Record<string, unknown>
): TerminalActivityState {
  const state = stringValue(terminal.activity_state);
  return state === "awaiting_approval" || state === "working" ||
      state === "idle"
    ? state
    : "unknown";
}

export function sameManualWatchTarget(
  watch: TerminalWatch,
  agent: ExecutorKind,
  terminal: TerminalWatchTerminalIdentity,
  anchor: TerminalWatchAnchor
): boolean {
  return watch.status === "active" &&
    watch.agent === agent &&
    watch.terminal.terminal_id === terminal.terminal_id &&
    watch.terminal.workspace === terminal.workspace &&
    sameTerminalControlEvidenceIncarnation(
      watch.terminal.terminal_endpoint,
      terminal.terminal_endpoint
    ) &&
    sameManualWatchAnchorTarget(watch.anchor, anchor);
}

function sameManualWatchAnchorTarget(
  left: TerminalWatchAnchor,
  right: TerminalWatchAnchor
): boolean {
  if (left.schema !== right.schema) return false;
  if (left.schema === "agent-knock-knock/codex-paginated-task-anchor" && right.schema === left.schema) {
    return samePaginatedWatchTask(left, right);
  }
  if (
    left.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor" &&
    right.schema === left.schema
  ) {
    return left.turn_id === right.turn_id &&
      left.process_uuid === right.process_uuid &&
      left.process_birth === right.process_birth &&
      left.rollout.device === right.rollout.device &&
      left.rollout.inode === right.rollout.inode;
  }
  if (
    left.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor" &&
    right.schema === left.schema
  ) {
    return sameClaudeWatchTask(left, right);
  }
  if (
    left.schema === "agent-knock-knock/terminal-activity-watch-anchor" &&
    right.schema === left.schema
  ) {
    return left.origin === right.origin &&
      left.request_hash === right.request_hash &&
      left.pid === right.pid &&
      optionalIdentityCompatible(
        left.native_process_uuid,
        right.native_process_uuid
      ) &&
      optionalIdentityCompatible(
        left.native_process_birth,
        right.native_process_birth
      );
  }
  return left.anchor_fingerprint === right.anchor_fingerprint;
}

function sameClaudeWatchTask(
  left: Extract<TerminalWatchAnchor, { schema: "agent-knock-knock/claude-human-started-active-task-anchor" }>,
  right: typeof left
): boolean {
    return left.prompt_uuid === right.prompt_uuid &&
      left.pid === right.pid &&
      left.agent_started_at_ms === right.agent_started_at_ms &&
      left.device === right.device &&
      left.inode === right.inode;
}

function samePaginatedWatchTask(left: CodexPaginatedTaskAnchor, right: CodexPaginatedTaskAnchor): boolean {
    return left.native_thread_id === right.native_thread_id && left.turn_id === right.turn_id &&
      left.process_uuid === right.process_uuid && left.process_birth === right.process_birth &&
      left.origin === right.origin && left.codex_home === right.codex_home;
}

function optionalIdentityCompatible(
  left: string | undefined,
  right: string | undefined
): boolean {
  return left === undefined || right === undefined || left === right;
}

export function safeDiagnostic(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\0]+/gu, " ").trim().slice(0, 500) ||
    "unknown provider observation error";
}

export function terminalControlForWatch(
  terminal: Record<string, unknown>
): TerminalControlRef {
  if (!isRecord(terminal.terminal_control)) {
    throw new Error("the exact terminal has no terminal control authority");
  }
  return terminal.terminal_control as unknown as TerminalControlRef;
}

export function terminalWatchCandidateMatchesLiveContext(
  watch: TerminalWatch,
  terminal: Record<string, unknown>
): boolean {
  if (!terminalMatchesWatch(terminal, watch)) return false;
  if (watch.anchor.schema === "agent-knock-knock/codex-paginated-task-anchor") {
    return paginatedWatchProcessMatches(terminal, watch.anchor);
  }
  const sessionId = stringValue(terminal.native_agent_session_id);
  if (
    watch.anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    return sessionId?.toLowerCase() === watch.anchor.native_thread_id &&
      rolloutFileIdentityMatches(
        terminal.native_agent_rollout,
        watch.anchor.rollout
      );
  }
  if (
    watch.anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    const checkpoint = watch.observation_checkpoint;
    return "schema" in checkpoint &&
      checkpoint.schema ===
        "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" &&
      checkpoint.accepted_identity !== undefined &&
      sessionId?.toLowerCase() === checkpoint.accepted_identity.native_thread_id &&
      rolloutFileIdentityMatches(
        terminal.native_agent_rollout,
        checkpoint.accepted_identity.rollout
      );
  }
  if (
    watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    return sessionId === watch.anchor.session_id;
  }
  if (
    watch.anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    return sessionId === watch.anchor.transcript_anchor.session_id;
  }
  return false;
}

export async function currentTerminalForWatch(
  watch: TerminalWatch,
  options: TerminalWatchCliOptions,
  dependencies: TerminalWatchCliDependencies
): Promise<ExactTerminalWatchObservation> {
  return dependencies.observeExactTerminal({
    options,
    terminalId: watch.terminal.terminal_id
  });
}

export function terminalMatchesWatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch
): boolean {
  try {
    return terminalAgent(terminal) === watch.agent &&
      requiredString(terminal.id, "terminal id") ===
        watch.terminal.terminal_id &&
      terminalWorkspace(terminal) === watch.terminal.workspace &&
      isRecord(terminal.terminal_control) &&
      sameTerminalControlEvidenceIncarnation(
        terminal.terminal_control as unknown as TerminalControlRef,
        watch.terminal.terminal_endpoint
      );
  } catch {
    return false;
  }
}

export type TerminalActivityWatchIdentityMatch =
  | "match"
  | "mismatch"
  | "unavailable";

export function terminalActivityWatchIdentityMatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch
): TerminalActivityWatchIdentityMatch {
  try {
    if (
      !isTerminalActivityWatch(watch) ||
      terminalAgent(terminal) !== watch.agent ||
      requiredString(terminal.id, "terminal id") !==
        watch.terminal.terminal_id ||
      terminalWorkspace(terminal) !== watch.terminal.workspace ||
      positiveInteger(terminal.pid, "terminal PID") !== watch.anchor.pid
    ) {
      return "mismatch";
    }
    if (!isRecord(terminal.terminal_control)) {
      return "unavailable";
    }
    if (!sameTerminalControlEvidenceIncarnation(
      terminal.terminal_control as unknown as TerminalControlRef,
      watch.terminal.terminal_endpoint
    )) {
      return "mismatch";
    }
    const processUuid = stringValue(terminal.native_agent_process_uuid);
    const processBirth = stringValue(terminal.native_agent_process_birth);
    if (
      (watch.anchor.native_process_uuid !== undefined && !processUuid) ||
      (watch.anchor.native_process_birth !== undefined && !processBirth)
    ) {
      return "unavailable";
    }
    return (
      watch.anchor.native_process_uuid !== undefined &&
      processUuid !== watch.anchor.native_process_uuid
    ) || (
      watch.anchor.native_process_birth !== undefined &&
      processBirth !== watch.anchor.native_process_birth
    )
      ? "mismatch"
      : "match";
  } catch {
    return "unavailable";
  }
}

export function terminalMatchesUserExplicitFallbackWatch(
  terminal: Record<string, unknown>,
  watch: TerminalWatch
): boolean {
  try {
    if (
      !isUserExplicitFallbackWatch(watch) ||
      terminalAgent(terminal) !== watch.agent ||
      requiredString(terminal.id, "terminal id") !==
        watch.terminal.terminal_id ||
      terminalWorkspace(terminal) !== watch.terminal.workspace ||
      !isRecord(terminal.terminal_control) ||
      !sameTerminalControlEvidenceIncarnation(
        terminal.terminal_control as unknown as TerminalControlRef,
        watch.terminal.terminal_endpoint
      )
    ) {
      return false;
    }
    if (
      watch.anchor.schema ===
        "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
    ) {
      return requiredString(
        terminal.native_agent_process_uuid,
        "Codex process UUID"
      ) === watch.anchor.acceptance_anchor.process_uuid &&
        requiredString(
          terminal.native_agent_process_birth,
          "Codex process birth"
        ) === watch.anchor.acceptance_anchor.process_birth;
    }
    return watch.anchor.schema ===
        "agent-knock-knock/claude-user-explicit-fallback-watch-anchor" &&
      positiveInteger(terminal.pid, "Claude PID") ===
        watch.anchor.transcript_anchor.pid;
  } catch {
    return false;
  }
}

export function terminalWatchIdentity(
  terminal: Record<string, unknown>,
  bindingToken: string
): TerminalWatchTerminalIdentity {
  const terminalControl = terminal.terminal_control as TerminalControlRef;
  return {
    terminal_id: requiredString(terminal.id, "terminal id"),
    terminal_endpoint: terminalControlEvidence(terminalControl),
    workspace: terminalWorkspace(terminal),
    binding_token: bindingToken
  };
}

export function codexIdentity(
  terminal: Record<string, unknown>
): CodexRolloutAcceptanceIdentity {
  if (!isRecord(terminal.native_agent_rollout)) {
    throw new Error("Codex terminal has no exact rollout identity");
  }
  return {
    sessionId: requiredString(
      terminal.native_agent_session_id,
      "Codex native thread id"
    ),
    processUuid: requiredString(
      terminal.native_agent_process_uuid,
      "Codex process UUID"
    ),
    processBirth: requiredString(
      terminal.native_agent_process_birth,
      "Codex process birth"
    ),
    rollout: {
      fd: requiredString(terminal.native_agent_rollout.fd, "Codex rollout fd"),
      device: requiredString(
        terminal.native_agent_rollout.device,
        "Codex rollout device"
      ),
      inode: requiredString(
        terminal.native_agent_rollout.inode,
        "Codex rollout inode"
      ),
      path: requiredString(
        terminal.native_agent_rollout.path,
        "Codex rollout path"
      )
    }
  };
}

export function codexIdentityForWatch(
  watch: TerminalWatch
): CodexRolloutAcceptanceIdentity {
  if (
    watch.agent !== "codex" ||
    watch.anchor.schema !==
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    throw new Error("terminal Watch has no Codex identity");
  }
  return {
    sessionId: watch.anchor.native_thread_id,
    processUuid: watch.anchor.process_uuid,
    processBirth: watch.anchor.process_birth,
    rollout: watch.anchor.rollout
  };
}

export function terminalAgent(terminal: Record<string, unknown>): ExecutorKind {
  const agent = stringValue(terminal.agent);
  if (agent !== "codex" && agent !== "claude") {
    throw new Error("terminal Watch supports only Codex or Claude Code");
  }
  return agent;
}

export function terminalWorkspace(terminal: Record<string, unknown>): string {
  const workspace = requiredString(
    terminal.workspace ?? terminal.cwd,
    "terminal workspace"
  );
  if (!path.isAbsolute(workspace)) {
    throw new Error("terminal workspace must be absolute");
  }
  return path.resolve(workspace);
}

export function requiredWatchId(value: unknown): string {
  const watchId = requiredString(value, "--watch");
  if (!/^terminal-watch-[A-Za-z0-9._:-]+$/u.test(watchId)) {
    throw new Error("--watch must be an exact Terminal Watch id");
  }
  return watchId;
}

export function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result || result.includes("\0")) {
    throw new Error(`${label} is required`);
  }
  return result;
}

export function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new Error(
      `${label} must be exactly 64 lowercase ASCII hexadecimal characters`
    );
  }
  return result;
}

export function requiredTimestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
  return result;
}

export function parseWatchInteractionResponse(value: unknown): unknown {
  const serialized = requiredString(value, "--response-json");
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed)) {
      throw new Error("response must be an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `--response-json is invalid: ${safeDiagnostic(error)}`
    );
  }
}

export function assertWatchControllerSession(
  watch: TerminalWatch,
  requestedValue: unknown
): void {
  const requested = stringValue(requestedValue);
  if (!requested || requested !== watch.openclaw_session) {
    throw new Error(
      `terminal Watch ${watch.watch_id} belongs to a different controller session; no terminal input was sent`
    );
  }
}

export function requiredExecutableWatchInteraction(
  watch: TerminalWatch,
  interactionId: string,
  expectedFingerprint: string
): TerminalWatchCurrentInteraction {
  if (watch.status !== "active") {
    throw new Error(`terminal Watch ${watch.watch_id} is ${watch.status}`);
  }
  const interaction = watch.current_interaction;
  if (
    watch.interaction_policy !== "respond_when_exact" ||
    !interaction ||
    interaction.aggregate.state !== "pending" ||
    interaction.projection.interaction_id !== interactionId ||
    interaction.projection.prompt_fingerprint !== expectedFingerprint ||
    interaction.projection.response_authority !== "executable" ||
    !interaction.projection.capabilities.respond
  ) {
    throw new Error(
      "terminal Watch has no matching executable interaction offer; refresh status"
    );
  }
  return interaction;
}

export function positiveInteger(value: unknown, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

export function positiveMinutes(value: unknown, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(result) || result <= 0) {
    throw new Error("--hard-timeout-minutes must be a positive number");
  }
  return result;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

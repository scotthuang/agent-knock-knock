import { createHash } from "node:crypto";
import path from "node:path";
import {
  isExactNativeThreadId, managedSessionBindingToken,
  unmanagedTerminalBindingToken,
  type ManagedSessionState, type ManagedTerminalBinding
} from "./managed-session.js";
import {
  sessionIdForConversation, turnIdForConversation, type Conversation
} from "./protocol.js";
import { terminalActionFingerprint } from "./native-thread-resume-snapshot-policy.js";
import type { TerminalDispatchLedgerDocument } from "./terminal-dispatch-ledger-codec.js";
import {
  hasCanonicalTerminalEndpoint, sameTerminalControlIncarnation,
  terminalEndpointFromControlRef, type TerminalControlRef
} from "./terminal-control-ref.js";
import { isRecord, nonBlankString as nonEmptyString } from "./value-guards.js";
export interface TerminalScopedCodexApprovalPromptSnapshot {
  fingerprint: string; keys: string[]; requestId: string | null; digest: string;
}
export type TerminalScopedCodexApprovalAuthorityKind =
  "current_dispatch_owner" | "managed_session_no_dispatch_owner";
export interface TerminalScopedCodexApprovalBoundary {
  authority: { kind: TerminalScopedCodexApprovalAuthorityKind };
  approval: TerminalScopedCodexApprovalPromptSnapshot; token: string;
}
interface NativeRollout { fd: string; device: string; inode: string; path: string }
interface TerminalNativeIdentity {
  sessionId: string; processUuid: string; processBirth: string; rollout?: NativeRollout;
}
interface ApprovalAuthorityChecks {
  relatedBoundSessionIds(): readonly string[]; blockingTurnIds(): readonly string[];
  hasNativeTransition(): boolean; hasDeferredRecovery(): boolean;
  ledgerMatchesTerminal(): boolean;
}
interface ApprovalRequestBase {
  storeDir: string; terminal: unknown; session: ManagedSessionState;
  approval?: TerminalScopedCodexApprovalPromptSnapshot;
}
export type TerminalScopedCodexApprovalAuthorityRequest =
  | (ApprovalRequestBase & {
      kind: "current_dispatch_owner";
      owner: Conversation;
      ledger: TerminalDispatchLedgerDocument;
      checks: ApprovalAuthorityChecks & {
        assertDispatchOwner(): void;
        ownerMatchesNativeIdentity(
          identity: TerminalNativeIdentity | undefined
        ): boolean;
      };
    })
  | (ApprovalRequestBase & {
      kind: "managed_session_no_dispatch_owner";
      ledger?: TerminalDispatchLedgerDocument;
      checks: ApprovalAuthorityChecks & {
        dispatchOwnershipIsNone(): boolean;
        hasOrphanedDispatch(): boolean;
      };
    });
interface TerminalSnapshot {
  id: string; rawId: unknown; agent?: string; pid: number; workspace?: string;
  terminalControl?: TerminalControlRef; nativeSessionId?: string;
  statusCardSessionId?: string; processUuid?: string; processBirth?: string;
  rollout?: NativeRollout;
  observationStatus?: "resolved" | "verified_absent" | "unavailable";
}
type ExactTerminalSnapshot = TerminalSnapshot & {
  agent: "codex"; workspace: string; terminalControl: TerminalControlRef;
  processUuid: string; processBirth: string; observationStatus: "resolved" | "verified_absent" | "unavailable";
};
export function terminalScopedCodexApprovalPromptSnapshot(approvalState: unknown): TerminalScopedCodexApprovalPromptSnapshot | undefined {
  if (!isRecord(approvalState) || approvalState.approvable !== true) return;
  const fingerprint = nonEmptyString(approvalState.fingerprint);
  const fallbackKey = nonEmptyString(approvalState.key);
  const rawKeys = Array.isArray(approvalState.keys) ? approvalState.keys : fallbackKey ? [fallbackKey] : [];
  const keys = rawKeys.filter((value): value is string =>
    typeof value === "string" && value.length > 0);
  if (!fingerprint || !/^[0-9a-f]{64}$/u.test(fingerprint) ||
      keys.length === 0 || keys.length !== rawKeys.length ||
      nonEmptyString(approvalState.decision_mode) !== "keys") return;
  const requestId = nonEmptyString(approvalState.request_id) ?? null;
  return {
    fingerprint, keys, requestId,
    digest: terminalActionFingerprint({
      version: 1,
      kind: "terminal_scoped_codex_approval_prompt",
      fingerprint, keys,
      request_id: requestId
    })
  };
}
/** One fresh decision; lazy checks retain fail-closed I/O/error precedence. */
export function decideTerminalScopedCodexApprovalAuthority(request: TerminalScopedCodexApprovalAuthorityRequest): TerminalScopedCodexApprovalBoundary {
  const terminal = terminalSnapshot(request.terminal);
  if (!isExactTerminalSnapshot(terminal) || !request.approval) {
    throw new Error(request.kind === "current_dispatch_owner"
      ? "terminal-scoped Codex approval requires an exact terminal and process incarnation"
      : "terminal-scoped Codex approval requires an exact terminal, process, and prompt incarnation");
  }
  return request.kind === "current_dispatch_owner"
    ? decideCurrentOwner(request, terminal, request.approval)
    : decideNoOwner(request, terminal, request.approval);
}
function decideCurrentOwner(
  request: Extract<TerminalScopedCodexApprovalAuthorityRequest, { kind: "current_dispatch_owner" }>,
  terminal: ExactTerminalSnapshot,
  approval: TerminalScopedCodexApprovalPromptSnapshot
): TerminalScopedCodexApprovalBoundary {
  const { session, owner, ledger, checks } = request;
  const binding = exactSessionBinding(session, terminal);
  if (
    !binding ||
    sessionIdForConversation(owner) !== session.session_id ||
    !["waiting_for_agent", "waiting_for_openclaw"].includes(owner.status)
  ) {
    throw new Error("terminal-scoped Codex approval has no single current managed owner");
  }
  assertSoleSession(checks.relatedBoundSessionIds(), session.session_id);
  const blockingTurnIds = checks.blockingTurnIds();
  if (
    blockingTurnIds.length !== 1 ||
    blockingTurnIds[0] !== turnIdForConversation(owner)
  ) {
    throw new Error("terminal-scoped Codex approval has collateral unresolved Turn state");
  }
  assertNoRecovery(checks.hasNativeTransition() || checks.hasDeferredRecovery());
  checks.assertDispatchOwner();
  if (
    !checks.ledgerMatchesTerminal() ||
    !["submitted", "agent_accepted"].includes(String(ledger.status))
  ) {
    throw new Error(`terminal-scoped Codex approval cannot use ${String(ledger.status)} dispatch ownership`);
  }
  assertNativeIdentity(terminal, binding);
  const identity = terminal.nativeSessionId
    ? {
        sessionId: terminal.nativeSessionId, processUuid: terminal.processUuid,
        processBirth: terminal.processBirth, rollout: terminal.rollout
      }
    : undefined;
  if (checks.ownerMatchesNativeIdentity(identity)) {
    throw new Error("the Codex managed identity is exact; use the managed Turn approval action");
  }
  return boundaryFor(request, terminal, approval);
}
function decideNoOwner(
  request: Extract<TerminalScopedCodexApprovalAuthorityRequest, { kind: "managed_session_no_dispatch_owner" }>,
  terminal: ExactTerminalSnapshot,
  approval: TerminalScopedCodexApprovalPromptSnapshot
): TerminalScopedCodexApprovalBoundary {
  const { session, ledger, checks } = request;
  const binding = exactSessionBinding(session, terminal);
  if (!binding || !isExactNativeThreadId(binding.native_thread_id)) {
    throw new Error("terminal-scoped Codex approval has no single exact managed Session");
  }
  assertSoleSession(checks.relatedBoundSessionIds(), session.session_id);
  if (!checks.dispatchOwnershipIsNone()) {
    throw new Error("terminal-scoped Codex approval acquired a current or conflicted dispatch owner");
  }
  if (
    ledger &&
    (ledger.status !== "resolved" || !checks.ledgerMatchesTerminal())
  ) {
    throw new Error(`terminal-scoped Codex approval cannot use ${String(ledger.status)} dispatch ownership`);
  }
  if (checks.blockingTurnIds().length > 0) {
    throw new Error("terminal-scoped Codex approval has unresolved managed Turn state");
  }
  assertNoRecovery(
    checks.hasNativeTransition() ||
    checks.hasOrphanedDispatch() ||
    checks.hasDeferredRecovery()
  );
  assertNativeIdentity(terminal, binding);
  return boundaryFor(request, terminal, approval);
}
function exactSessionBinding(session: ManagedSessionState, terminal: ExactTerminalSnapshot): ManagedTerminalBinding | undefined {
  const binding = session.binding;
  return (
    session.status === "bound" &&
    session.agent === "codex" &&
    binding &&
    binding.native_process.pid === terminal.pid &&
    binding.native_process.process_uuid === terminal.processUuid &&
    binding.native_process.process_birth === terminal.processBirth &&
    terminalControlAliasMatches(
      binding.terminal_id, binding.terminal_control,
      terminal.rawId, terminal.terminalControl
    ) &&
    path.resolve(session.workspace) === path.resolve(terminal.workspace)
  ) ? binding : undefined;
}
function assertSoleSession(sessionIds: readonly string[], expectedSessionId: string): void {
  if (sessionIds.length !== 1 || sessionIds[0] !== expectedSessionId) {
    throw new Error("terminal-scoped Codex approval has ambiguous managed Session ownership");
  }
}
function assertNoRecovery(blocked: boolean): void {
  if (blocked) {
    throw new Error("terminal-scoped Codex approval is blocked by managed recovery state");
  }
}
function assertNativeIdentity(terminal: ExactTerminalSnapshot, binding: ManagedTerminalBinding): void {
  for (const knownSessionId of [
    terminal.nativeSessionId,
    terminal.statusCardSessionId
  ]) {
    if (
      knownSessionId &&
      knownSessionId.toLowerCase() !==
        String(binding.native_thread_id ?? "").toLowerCase()
    ) {
      throw new Error("terminal-scoped Codex approval observed a different native thread");
    }
  }
  if (
    terminal.nativeSessionId &&
    (
      terminal.processUuid !== binding.native_process.process_uuid ||
      terminal.processBirth !== binding.native_process.process_birth ||
      (
        binding.native_process.rollout &&
        !exactNativeRolloutMatches(
          binding.native_process.rollout,
          terminal.rollout
        )
      )
    )
  ) {
    throw new Error("terminal-scoped Codex approval observed a changed native rollout incarnation");
  }
}
function boundaryFor(
  request: TerminalScopedCodexApprovalAuthorityRequest,
  terminal: ExactTerminalSnapshot,
  approval: TerminalScopedCodexApprovalPromptSnapshot
): TerminalScopedCodexApprovalBoundary {
  return {
    authority: { kind: request.kind },
    approval,
    token: approvalToken(request, terminal, approval)
  };
}
function approvalToken(
  request: TerminalScopedCodexApprovalAuthorityRequest,
  terminal: ExactTerminalSnapshot,
  approval: TerminalScopedCodexApprovalPromptSnapshot
): string {
  const terminalToken = unmanagedTerminalBindingToken({
    terminalId: terminal.id,
    terminalControl: terminal.terminalControl,
    agent: "codex",
    pid: terminal.pid,
    workspace: terminal.workspace,
    processUuid: terminal.processUuid,
    processBirth: terminal.processBirth
  });
  const owner = request.kind === "current_dispatch_owner"
    ? request.owner
    : undefined;
  const takeover = owner && isRecord(owner.native_session_takeover)
    ? owner.native_session_takeover
    : undefined;
  return createHash("sha256").update(JSON.stringify({
    version: 2,
    kind: "terminal_scoped_codex_manual_approval",
    store_dir: path.resolve(request.storeDir),
    terminal_token: terminalToken,
    observation: terminalObservation(terminal),
    authority: request.kind,
    owner_session_id: request.session.session_id,
    owner_session_revision: managedSessionRevision(request.session),
    owner_binding_token: managedSessionBindingToken(request.session),
    owner_turn_id: owner ? turnIdForConversation(owner) : null,
    owner_turn_status: owner?.status ?? null,
    owner_turn_updated_at: owner?.updated_at ?? null,
    owner_message_id:
      nonEmptyString(takeover?.terminal_bridge_message_id) ?? null,
    dispatch_snapshot: request.ledger
      ? {
          status: nonEmptyString(request.ledger.status),
          fingerprint: terminalActionFingerprint(request.ledger)
        }
      : { status: "none", fingerprint: null },
    approval_snapshot_digest: approval.digest,
    approval_fingerprint: approval.fingerprint,
    approval_keys: approval.keys,
    approval_request_id: approval.requestId
  })).digest("hex");
}
function terminalSnapshot(value: unknown): TerminalSnapshot {
  const terminal = isRecord(value) ? value : {};
  const terminalControl = isRecord(terminal.terminal_control)
    ? terminal.terminal_control as unknown as TerminalControlRef
    : undefined;
  const observation = isRecord(terminal.native_agent_identity_observation)
    ? terminal.native_agent_identity_observation
    : undefined;
  const observationValue = nonEmptyString(observation?.status);
  const observationStatus =
    observationValue === "resolved" ||
    observationValue === "verified_absent" ||
    observationValue === "unavailable"
      ? observationValue
      : undefined;
  return {
    id: String(terminal.id),
    rawId: terminal.id,
    agent: nonEmptyString(terminal.agent),
    pid: Number(terminal.pid),
    workspace: nonEmptyString(terminal.workspace ?? terminal.cwd),
    terminalControl,
    nativeSessionId: nonEmptyString(terminal.native_agent_session_id),
    statusCardSessionId:
      nonEmptyString(terminal.native_agent_status_card_session_id),
    processUuid: nonEmptyString(terminal.native_agent_process_uuid),
    processBirth: nonEmptyString(terminal.native_agent_process_birth),
    rollout: nativeRollout(terminal.native_agent_rollout),
    observationStatus
  };
}
function isExactTerminalSnapshot(
  value: TerminalSnapshot
): value is ExactTerminalSnapshot {
  return value.agent === "codex" &&
    Boolean(value.terminalControl) &&
    hasCanonicalTerminalEndpoint(value.terminalControl as TerminalControlRef) &&
    Number.isSafeInteger(value.pid) && value.pid > 1 &&
    Boolean(value.workspace) &&
    Boolean(value.processUuid) &&
    Boolean(value.processBirth) &&
    Boolean(value.observationStatus);
}
function terminalObservation(
  terminal: ExactTerminalSnapshot
): Record<string, unknown> {
  if (terminal.observationStatus !== "resolved") {
    return { status: terminal.observationStatus };
  }
  return {
    status: terminal.observationStatus,
    session_id: terminal.nativeSessionId ?? null,
    process_uuid: terminal.processUuid ?? null,
    process_birth: terminal.processBirth ?? null,
    rollout: terminal.rollout
      ? {
          fd: terminal.rollout.fd,
          device: terminal.rollout.device,
          inode: terminal.rollout.inode,
          path: terminal.rollout.path
        }
      : null
  };
}
function terminalControlAliasMatches(
  storedTerminalId: unknown,
  storedControl: TerminalControlRef,
  currentTerminalId: unknown,
  currentControl: TerminalControlRef
): boolean {
  if (!terminalControlsShareIncarnation(storedControl, currentControl)) {
    return false;
  }
  return (
    hasCanonicalTerminalEndpoint(storedControl) &&
    hasCanonicalTerminalEndpoint(currentControl)
  ) || nonEmptyString(storedTerminalId) === nonEmptyString(currentTerminalId);
}
function terminalControlsShareIncarnation(
  left: TerminalControlRef,
  right: TerminalControlRef
): boolean {
  try {
    const leftPid = Number(terminalEndpointFromControlRef(left).processAnchorPid);
    const rightPid = Number(terminalEndpointFromControlRef(right).processAnchorPid);
    return Number.isSafeInteger(leftPid) && leftPid > 1 &&
      Number.isSafeInteger(rightPid) && rightPid > 1 &&
      sameTerminalControlIncarnation(left, right);
  } catch {
    return false;
  }
}
function exactNativeRolloutMatches(
  left: NativeRollout,
  right: NativeRollout | undefined
): boolean {
  return Boolean(
    right &&
    left.fd === right.fd &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.path === right.path
  );
}
function nativeRollout(value: unknown): NativeRollout | undefined {
  if (!isRecord(value)) return;
  const fd = nonEmptyString(value.fd);
  const device = nonEmptyString(value.device);
  const inode = nonEmptyString(value.inode);
  const rolloutPath = nonEmptyString(value.path);
  return fd && device && inode && rolloutPath
    ? { fd, device, inode, path: rolloutPath }
    : undefined;
}
function managedSessionRevision(session: ManagedSessionState): number {
  const revision = Number(session.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`managed Session ${session.session_id} has no valid Store revision`);
  }
  return revision;
}

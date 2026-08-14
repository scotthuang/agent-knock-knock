import { createHash, randomUUID } from "node:crypto";
import { executorForConversation, type Conversation } from "./protocol.js";
import type { ExecutorKind } from "./executors.js";
import type {
  TerminalControlCapability,
  TerminalControlRef
} from "./terminal-agent-adapter.js";
import {
  associateTerminalEndpointEvidence,
  hasCanonicalTerminalEndpoint,
  terminalControlEvidence,
  terminalEndpointIdentityFromEvidence,
  terminalEndpointIdentityKey,
  terminalRouteKeyFromEvidence,
  sameTerminalControlIncarnation,
  type TerminalControlEvidence
} from "./terminal-control-ref.js";

export const MANAGED_SESSION_SCHEMA = "agent-knock-knock/session" as const;
export const MANAGED_SESSION_VERSION = 1 as const;
export const NATIVE_THREAD_TRANSITION_SCHEMA =
  "agent-knock-knock/native-thread-transition" as const;
export const NATIVE_THREAD_TRANSITION_VERSION = 1 as const;

export type ManagedSessionStatus =
  | "bound"
  | "detached"
  | "transitioning"
  | "quarantined";

export interface NativeProcessIdentity {
  pid: number;
  process_uuid?: string;
  process_birth?: string;
  rollout?: {
    fd: string;
    device: string;
    inode: string;
    path: string;
  };
  evidence: string;
}

export interface ManagedTerminalBinding {
  binding_id: string;
  generation: number;
  terminal_id: string;
  terminal_control: TerminalControlRef;
  /** Additive provider-neutral identity evidence for newer writers. */
  terminal_endpoint?: TerminalControlEvidence;
  native_thread_id?: string;
  native_process: NativeProcessIdentity;
  bound_at: string;
  last_verified_at: string;
}

export interface ManagedSessionLineage {
  created_by:
    | "attach"
    | "new_thread"
    | "resume_thread"
    | "human_observed"
    | "migration";
  previous_session_id?: string;
  resumed_from_native_thread_id?: string;
  transition_id?: string;
}

export interface ManagedSessionState {
  schema: typeof MANAGED_SESSION_SCHEMA;
  version: typeof MANAGED_SESSION_VERSION;
  session_id: string;
  /**
   * Monotonic Store revision. Writers may omit it when creating a value, but
   * every persisted and loaded protocol-3 Session has one.
   */
  revision?: number;
  agent: ExecutorKind;
  workspace: string;
  status: ManagedSessionStatus;
  binding?: ManagedTerminalBinding;
  lineage: ManagedSessionLineage;
  created_at: string;
  updated_at: string;
  detached_at?: string;
  quarantine_reason?: string;
  last_transition_id?: string;
}

export type NativeThreadTransitionStatus =
  | "prepared"
  | "dispatching"
  | "submitted"
  | "uncertain"
  | "verified"
  | "committed"
  | "aborted";

export interface NativeThreadTransition {
  schema: typeof NATIVE_THREAD_TRANSITION_SCHEMA;
  version: typeof NATIVE_THREAD_TRANSITION_VERSION;
  transition_id: string;
  /** Monotonic Store revision used for transition state CAS. */
  revision?: number;
  operation: "new_thread" | "resume_thread" | "adopt_external_thread";
  /** An observed handoff is authority evidence, never a terminal command. */
  origin?: "human_observed";
  /** Explicitly fences recovery from ever replaying input for an observation. */
  terminal_input_sent?: boolean;
  status: NativeThreadTransitionStatus;
  terminal_id: string;
  agent: ExecutorKind;
  workspace: string;
  source_session_id?: string;
  source_expected_revision?: number;
  source_previous_last_transition_id?: string;
  target_session_id: string;
  /** `null` means the target Session must not exist at prepare time. */
  target_expected_revision: number | null;
  target_native_thread_id?: string;
  /** Immutable candidate rollout identity revalidated before a Codex resume. */
  target_candidate_file_identity?: {
    path: string;
    device: string;
    inode: string;
  };
  before_native_thread_id: string;
  before_process_uuid: string;
  before_process_started_at?: number;
  before_process_birth?: string;
  before_process_rollout?: NativeProcessIdentity["rollout"];
  before_binding?: ManagedTerminalBinding;
  after_binding?: ManagedTerminalBinding;
  adapter_version: string;
  command_fingerprint: string;
  dispatcher_pid: number;
  prepared_at: string;
  dispatching_at?: string;
  submitted_at?: string;
  verified_at?: string;
  committed_at?: string;
  aborted_at?: string;
  uncertain_at?: string;
  reconciled_outcome?: "before" | "after";
  reconciled_at?: string;
  error?: string;
  do_not_retry?: boolean;
}

export interface NativeThreadCandidate {
  native_thread_id: string;
  /** Opaque base64url-encoded TerminalThreadLifecycleCandidateToken. */
  candidate_token?: string;
  agent: ExecutorKind;
  workspace: string;
  title?: string;
  preview?: string;
  updated_at?: string;
  updated_at_ms?: number;
  archived?: boolean;
  active_elsewhere?: boolean;
  managed_session_id?: string;
  resumable: boolean;
  unavailable_reason?: string;
}

export function createManagedSessionId(now = new Date()): string {
  return `session-${formatTimestamp(now)}-${randomUUID().slice(0, 8)}`;
}

export function createTerminalBindingId(): string {
  return `binding-${randomUUID()}`;
}

export function createNativeThreadTransitionId(): string {
  return `transition-${randomUUID()}`;
}

export function managedSessionStorageKey(sessionId: string): string {
  assertManagedSessionId(sessionId);
  return createHash("sha256").update(sessionId).digest("hex");
}

export function managedSessionBindingToken(
  state: Pick<ManagedSessionState, "session_id" | "status" | "binding">
): string {
  if (state.binding?.terminal_endpoint) {
    const identity = terminalEndpointIdentityFromEvidence(
      state.binding.terminal_endpoint
    );
    if (!identity) {
      throw new Error("managed terminal binding endpoint identity is invalid");
    }
    return createHash("sha256")
      .update(JSON.stringify({
        version: 2,
        session_id: state.session_id,
        status: state.status,
        binding_id: state.binding.binding_id,
        binding_generation: state.binding.generation,
        terminal_id: state.binding.terminal_id,
        terminal_identity: terminalEndpointIdentityKey(identity),
        terminal_process_anchor_pid:
          state.binding.terminal_endpoint.process_anchor_pid,
        agent_pid: state.binding.native_process.pid,
        process_uuid: state.binding.native_process.process_uuid ?? null,
        process_birth: state.binding.native_process.process_birth ?? null,
        rollout: state.binding.native_process.rollout ?? null,
        native_thread_id: state.binding.native_thread_id ?? null
      }))
      .digest("hex");
  }
  return legacyManagedSessionBindingToken(state);
}

export function managedSessionRevision(state: ManagedSessionState): number {
  const revision = Number(state.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(
      `managed Session ${state.session_id} has no valid Store revision`
    );
  }
  return revision;
}

export function nativeThreadTransitionRevision(
  transition: NativeThreadTransition
): number {
  const revision = Number(transition.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(
      `native thread transition ${transition.transition_id} has no valid Store revision`
    );
  }
  return revision;
}

export function legacyManagedSessionBindingToken(
  state: Pick<ManagedSessionState, "session_id" | "status" | "binding">
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      session_id: state.session_id,
      status: state.status,
      binding_id: state.binding?.binding_id ?? null,
      binding_generation: state.binding?.generation ?? null,
      terminal_id: state.binding?.terminal_id ?? null,
      terminal_target: state.binding?.terminal_control.target ?? null,
      socket_path: state.binding?.terminal_control.socketPath ?? null,
      pane_pid: state.binding?.terminal_control.panePid ?? null,
      agent_pid: state.binding?.native_process.pid ?? null,
      process_uuid: state.binding?.native_process.process_uuid ?? null,
      process_birth: state.binding?.native_process.process_birth ?? null,
      rollout: state.binding?.native_process.rollout ?? null,
      native_thread_id: state.binding?.native_thread_id ?? null
    }))
    .digest("hex");
}

export function unmanagedTerminalBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  agent: ExecutorKind;
  pid: number;
  workspace: string;
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: NativeProcessIdentity["rollout"];
}): string {
  if (hasCanonicalTerminalEndpoint(value.terminalControl)) {
    const evidence = terminalControlEvidence(value.terminalControl);
    return createHash("sha256")
      .update(JSON.stringify({
        version: 2,
        state: "unmanaged",
        terminal_id: value.terminalId,
        terminal_identity: terminalEndpointIdentityKey(
          terminalEndpointIdentityFromEvidence(evidence)!
        ),
        terminal_process_anchor_pid: evidence.process_anchor_pid,
        agent: value.agent,
        agent_pid: value.pid,
        workspace: value.workspace,
        native_thread_id: value.nativeThreadId ?? null,
        process_uuid: value.processUuid ?? null,
        process_birth: value.processBirth ?? null,
        rollout: value.rollout ?? null
      }))
      .digest("hex");
  }
  return legacyUnmanagedTerminalBindingToken(value);
}

export type HumanObservedHandoffTargetSnapshot =
  | { state: "absent" }
  | {
      state: "detached";
      session_id: string;
      revision: number;
      status: "detached";
      binding_token: string;
    };

/**
 * Snapshot authority for one advertised human-handoff send.
 *
 * The terminal token fences the provider endpoint, process incarnation, and
 * observed after-thread identity.  Source and target snapshots are included
 * separately because neither a Session revision nor a newly appeared/removed
 * historical target is represented by that terminal-only token.
 */
export function humanObservedHandoffBindingToken(value: {
  terminal_token: string;
  source_session_id: string;
  source_revision: number;
  source_binding_token: string;
  target: HumanObservedHandoffTargetSnapshot;
}): string {
  assertNonEmptyString(value.terminal_token, "handoff terminal token");
  assertManagedSessionId(value.source_session_id);
  if (!isPositiveSafeInteger(value.source_revision)) {
    throw new Error("handoff source revision must be a positive integer");
  }
  assertNonEmptyString(
    value.source_binding_token,
    "handoff source binding token"
  );
  if (value.target.state === "detached") {
    assertManagedSessionId(value.target.session_id);
    if (!isPositiveSafeInteger(value.target.revision)) {
      throw new Error("handoff target revision must be a positive integer");
    }
    if (value.target.status !== "detached") {
      throw new Error("handoff target snapshot must remain detached");
    }
    assertNonEmptyString(
      value.target.binding_token,
      "handoff target binding token"
    );
  } else if (value.target.state !== "absent") {
    throw new Error("handoff target snapshot state is invalid");
  }
  return createHash("sha256")
    .update(JSON.stringify({
      version: 1,
      kind: "human_observed_handoff",
      terminal_token: value.terminal_token,
      source: {
        session_id: value.source_session_id,
        revision: value.source_revision,
        binding_token: value.source_binding_token
      },
      target: value.target
    }))
    .digest("hex");
}

export function legacyUnmanagedTerminalBindingToken(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  agent: ExecutorKind;
  pid: number;
  workspace: string;
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: NativeProcessIdentity["rollout"];
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      state: "unmanaged",
      terminal_id: value.terminalId,
      terminal_target: value.terminalControl.target,
      socket_path: value.terminalControl.socketPath ?? null,
      pane_pid: value.terminalControl.panePid,
      agent: value.agent,
      agent_pid: value.pid,
      workspace: value.workspace,
      native_thread_id: value.nativeThreadId ?? null,
      process_uuid: value.processUuid ?? null,
      process_birth: value.processBirth ?? null,
      rollout: value.rollout ?? null
    }))
    .digest("hex");
}

export function terminalBindingFrom(value: {
  terminalId: string;
  terminalControl: TerminalControlRef;
  pid: number;
  nativeThreadId?: string;
  processUuid?: string;
  processBirth?: string;
  rollout?: NativeProcessIdentity["rollout"];
  evidence: string;
  generation: number;
  now?: Date;
}): ManagedTerminalBinding {
  const now = (value.now ?? new Date()).toISOString();
  const binding: ManagedTerminalBinding = {
    binding_id: createTerminalBindingId(),
    generation: value.generation,
    terminal_id: value.terminalId,
    terminal_control: value.terminalControl,
    ...(hasCanonicalTerminalEndpoint(value.terminalControl)
      ? { terminal_endpoint: terminalControlEvidence(value.terminalControl) }
      : {}),
    native_thread_id: value.nativeThreadId,
    native_process: {
      pid: value.pid,
      process_uuid: value.processUuid,
      process_birth: value.processBirth,
      rollout: value.rollout,
      evidence: value.evidence
    },
    bound_at: now,
    last_verified_at: now
  };
  assertManagedTerminalBinding(binding, "terminal binding");
  return binding;
}

export function nativeThreadCommandFingerprint(command: string): string {
  return createHash("sha256").update(command).digest("hex");
}

export function isExactNativeThreadId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

export function assertManagedSessionId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0")
  ) {
    throw new Error("session id must be a non-empty string without NUL bytes");
  }
}

export function assertManagedSessionState(
  value: unknown,
  expectedSessionId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is ManagedSessionState {
  if (!isRecord(value)) {
    throw new Error("managed session state must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "session_id",
    "revision",
    "agent",
    "workspace",
    "status",
    "binding",
    "lineage",
    "created_at",
    "updated_at",
    "detached_at",
    "quarantine_reason",
    "last_transition_id"
  ], "managed session state");
  if (
    value.schema !== MANAGED_SESSION_SCHEMA ||
    value.version !== MANAGED_SESSION_VERSION
  ) {
    throw new Error("managed session state has an unsupported schema or version");
  }
  assertManagedSessionId(value.session_id);
  if (expectedSessionId !== undefined && value.session_id !== expectedSessionId) {
    throw new Error(
      `managed session id ${value.session_id} does not match ${expectedSessionId}`
    );
  }
  if (
    value.revision === undefined
      ? !options.allowMissingRevision
      : !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error("managed session revision must be a positive safe integer");
  }
  assertExecutorKind(value.agent, "managed session agent");
  assertNonEmptyString(value.workspace, "managed session workspace");
  if (!MANAGED_SESSION_STATUSES.has(value.status as ManagedSessionStatus)) {
    throw new Error("managed session status is invalid");
  }
  assertManagedSessionLineage(value.lineage);
  assertTimestamp(value.created_at, "managed session created_at");
  assertTimestamp(value.updated_at, "managed session updated_at");
  assertOptionalTimestamp(value.detached_at, "managed session detached_at");
  assertOptionalNonEmptyString(
    value.quarantine_reason,
    "managed session quarantine_reason"
  );
  assertOptionalNonEmptyString(
    value.last_transition_id,
    "managed session last_transition_id"
  );
  if (value.binding !== undefined) {
    assertManagedTerminalBinding(value.binding, "managed session binding");
  }
  if (value.status === "bound" && value.binding === undefined) {
    throw new Error("a bound managed session requires a terminal binding");
  }
  if (value.status === "transitioning" && value.binding === undefined) {
    throw new Error("a transitioning managed session requires a terminal binding");
  }
  if (value.status === "quarantined" && value.quarantine_reason === undefined) {
    throw new Error("a quarantined managed session requires quarantine_reason");
  }
}

export function assertNativeThreadTransition(
  value: unknown,
  expectedTransitionId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is NativeThreadTransition {
  if (!isRecord(value)) {
    throw new Error("native thread transition state must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "transition_id",
    "revision",
    "operation",
    "origin",
    "terminal_input_sent",
    "status",
    "terminal_id",
    "agent",
    "workspace",
    "source_session_id",
    "source_expected_revision",
    "source_previous_last_transition_id",
    "target_session_id",
    "target_expected_revision",
    "target_native_thread_id",
    "target_candidate_file_identity",
    "before_native_thread_id",
    "before_process_uuid",
    "before_process_started_at",
    "before_process_birth",
    "before_process_rollout",
    "before_binding",
    "after_binding",
    "adapter_version",
    "command_fingerprint",
    "dispatcher_pid",
    "prepared_at",
    "dispatching_at",
    "submitted_at",
    "verified_at",
    "committed_at",
    "aborted_at",
    "uncertain_at",
    "reconciled_outcome",
    "reconciled_at",
    "error",
    "do_not_retry"
  ], "native thread transition state");
  if (
    value.schema !== NATIVE_THREAD_TRANSITION_SCHEMA ||
    value.version !== NATIVE_THREAD_TRANSITION_VERSION
  ) {
    throw new Error("native thread transition has an unsupported schema or version");
  }
  assertStorageRecordId(value.transition_id, "transition id");
  if (
    expectedTransitionId !== undefined &&
    value.transition_id !== expectedTransitionId
  ) {
    throw new Error(
      `transition id ${value.transition_id} does not match ${expectedTransitionId}`
    );
  }
  if (
    value.revision === undefined
      ? !options.allowMissingRevision
      : !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error("native thread transition revision must be a positive safe integer");
  }
  if (!NATIVE_THREAD_OPERATIONS.has(
    value.operation as NativeThreadTransition["operation"]
  )) {
    throw new Error("native thread transition operation is invalid");
  }
  const observedHandoff = value.operation === "adopt_external_thread";
  if (
    observedHandoff
      ? value.origin !== "human_observed" || value.terminal_input_sent !== false
      : value.origin !== undefined || value.terminal_input_sent !== undefined
  ) {
    throw new Error(
      observedHandoff
        ? "adopt_external_thread requires human_observed origin and terminal_input_sent=false"
        : "native command transitions cannot carry human-observed input evidence"
    );
  }
  if (!NATIVE_THREAD_TRANSITION_STATUSES.has(
    value.status as NativeThreadTransitionStatus
  )) {
    throw new Error("native thread transition status is invalid");
  }
  if (
    observedHandoff &&
    (
      ["dispatching", "submitted"].includes(String(value.status)) ||
      value.dispatching_at !== undefined ||
      value.submitted_at !== undefined
    )
  ) {
    throw new Error(
      "adopt_external_thread cannot carry terminal-dispatch state"
    );
  }
  assertNonEmptyString(value.terminal_id, "native thread transition terminal_id");
  assertExecutorKind(value.agent, "native thread transition agent");
  assertNonEmptyString(value.workspace, "native thread transition workspace");
  if (value.source_session_id !== undefined) {
    assertManagedSessionId(value.source_session_id);
  }
  if (
    value.source_expected_revision !== undefined &&
    !isPositiveSafeInteger(value.source_expected_revision)
  ) {
    throw new Error(
      "native thread transition source_expected_revision must be a positive safe integer"
    );
  }
  if (
    (value.source_session_id === undefined) !==
      (value.source_expected_revision === undefined)
  ) {
    throw new Error(
      "native thread transition source identity and expected revision must appear together"
    );
  }
  assertOptionalNonEmptyString(
    value.source_previous_last_transition_id,
    "native thread transition source_previous_last_transition_id"
  );
  if (
    value.source_previous_last_transition_id !== undefined &&
    value.source_session_id === undefined
  ) {
    throw new Error(
      "native thread transition source_previous_last_transition_id requires a source Session"
    );
  }
  assertManagedSessionId(value.target_session_id);
  if (
    value.target_expected_revision !== null &&
    !isPositiveSafeInteger(value.target_expected_revision)
  ) {
    throw new Error(
      "native thread transition target_expected_revision must be null or a positive safe integer"
    );
  }
  if (value.target_native_thread_id !== undefined) {
    assertExactNativeThreadId(
      value.target_native_thread_id,
      "native thread transition target_native_thread_id"
    );
  }
  if (value.target_candidate_file_identity !== undefined) {
    if (!isRecord(value.target_candidate_file_identity)) {
      throw new Error(
        "native thread transition target_candidate_file_identity must be an object"
      );
    }
    assertOnlyKeys(value.target_candidate_file_identity, [
      "path",
      "device",
      "inode"
    ], "native thread transition target_candidate_file_identity");
    assertNonEmptyString(
      value.target_candidate_file_identity.path,
      "native thread transition target candidate path"
    );
    assertNonEmptyString(
      value.target_candidate_file_identity.device,
      "native thread transition target candidate device"
    );
    assertNonEmptyString(
      value.target_candidate_file_identity.inode,
      "native thread transition target candidate inode"
    );
    if (
      value.agent !== "codex" ||
      value.operation !== "resume_thread"
    ) {
      throw new Error(
        "only a Codex resume transition can carry target candidate file identity"
      );
    }
  }
  assertExactNativeThreadId(
    value.before_native_thread_id,
    "native thread transition before_native_thread_id"
  );
  assertNonEmptyString(
    value.before_process_uuid,
    "native thread transition before_process_uuid"
  );
  if (
    value.before_process_started_at !== undefined &&
    !isPositiveSafeInteger(value.before_process_started_at)
  ) {
    throw new Error(
      "native thread transition before_process_started_at must be a positive safe integer"
    );
  }
  assertOptionalNonEmptyString(
    value.before_process_birth,
    "native thread transition before_process_birth"
  );
  if (value.before_process_rollout !== undefined) {
    assertRollout(
      value.before_process_rollout,
      "native thread transition before_process_rollout"
    );
  }
  if (value.agent === "codex" && value.before_process_birth === undefined) {
    throw new Error("Codex transition requires before_process_birth");
  }
  if (
    value.agent === "claude" &&
    value.before_process_started_at === undefined
  ) {
    throw new Error("Claude transition requires before_process_started_at");
  }
  if (
    ["resume_thread", "adopt_external_thread"].includes(
      String(value.operation)
    ) &&
    value.target_native_thread_id === undefined
  ) {
    throw new Error(`${String(value.operation)} requires target_native_thread_id`);
  }
  if (
    value.operation === "new_thread" &&
    value.target_native_thread_id !== undefined
  ) {
    throw new Error("new_thread cannot carry target_native_thread_id");
  }
  if (
    value.source_session_id !== undefined &&
    value.source_session_id === value.target_session_id
  ) {
    throw new Error("native thread transition source and target Sessions must differ");
  }
  if (value.before_binding !== undefined) {
    assertManagedTerminalBinding(value.before_binding, "before_binding");
  }
  if (value.after_binding !== undefined) {
    assertManagedTerminalBinding(value.after_binding, "after_binding");
  }
  assertNativeThreadTransitionBindingConsistency(
    value as unknown as NativeThreadTransition
  );
  assertNonEmptyString(value.adapter_version, "native thread transition adapter_version");
  if (
    typeof value.command_fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.command_fingerprint)
  ) {
    throw new Error("native thread transition command_fingerprint must be SHA-256 hex");
  }
  if (!isPositiveSafeInteger(value.dispatcher_pid)) {
    throw new Error("native thread transition dispatcher_pid must be positive");
  }
  assertTimestamp(value.prepared_at, "native thread transition prepared_at");
  for (const field of [
    "dispatching_at",
    "submitted_at",
    "verified_at",
    "committed_at",
    "aborted_at",
    "uncertain_at"
  ] as const) {
    assertOptionalTimestamp(value[field], `native thread transition ${field}`);
  }
  assertOptionalNonEmptyString(value.error, "native thread transition error");
  if (
    value.reconciled_outcome !== undefined &&
    !["before", "after"].includes(String(value.reconciled_outcome))
  ) {
    throw new Error("native thread transition reconciled_outcome is invalid");
  }
  assertOptionalTimestamp(
    value.reconciled_at,
    "native thread transition reconciled_at"
  );
  if (
    (value.reconciled_outcome === undefined) !==
      (value.reconciled_at === undefined)
  ) {
    throw new Error(
      "native thread transition reconciliation outcome and timestamp must appear together"
    );
  }
  if (value.do_not_retry !== undefined && typeof value.do_not_retry !== "boolean") {
    throw new Error("native thread transition do_not_retry must be boolean");
  }
  if (
    ["dispatching", "submitted", "uncertain", "verified", "committed"].includes(
      String(value.status)
    ) &&
    !observedHandoff &&
    value.dispatching_at === undefined
  ) {
    throw new Error(`${value.status} transition requires dispatching_at`);
  }
  if (
    ["submitted", "verified", "committed"].includes(
      String(value.status)
    ) &&
    !observedHandoff &&
    value.submitted_at === undefined
  ) {
    throw new Error(`${value.status} transition requires submitted_at`);
  }
  if (
    ["verified", "committed"].includes(String(value.status)) &&
    (value.verified_at === undefined || value.after_binding === undefined)
  ) {
    throw new Error(`${value.status} transition requires verified_at and after_binding`);
  }
  if (value.status === "committed" && value.committed_at === undefined) {
    throw new Error("committed transition requires committed_at");
  }
  if (value.status === "aborted" && value.aborted_at === undefined) {
    throw new Error("aborted transition requires aborted_at");
  }
  if (value.status === "uncertain" && value.uncertain_at === undefined) {
    throw new Error("uncertain transition requires uncertain_at");
  }
}

function assertNativeThreadTransitionBindingConsistency(
  transition: NativeThreadTransition
): void {
  if (
    (transition.reconciled_outcome === "before" &&
      transition.status !== "aborted") ||
    (transition.reconciled_outcome === "after" &&
      !["verified", "committed"].includes(transition.status))
  ) {
    throw new Error(
      "native thread transition reconciliation outcome disagrees with status"
    );
  }
  const before = transition.before_binding;
  if (before) {
    if (
      (
        before.terminal_id !== transition.terminal_id &&
        !hasCanonicalTerminalEndpoint(before.terminal_control)
      ) ||
      before.native_thread_id?.toLowerCase() !==
        transition.before_native_thread_id.toLowerCase() ||
      before.native_process.process_uuid !== transition.before_process_uuid ||
      before.native_process.process_birth !== transition.before_process_birth ||
      JSON.stringify(before.native_process.rollout ?? null) !==
        JSON.stringify(transition.before_process_rollout ?? null)
    ) {
      throw new Error(
        "native thread transition before_binding disagrees with prepare identity"
      );
    }
  }

  const after = transition.after_binding;
  if (!after) {
    return;
  }
  if (!["verified", "committed"].includes(transition.status)) {
    throw new Error(
      "native thread transition cannot carry after_binding before verification"
    );
  }
  if (
    (
      after.terminal_id !== transition.terminal_id &&
      !hasCanonicalTerminalEndpoint(after.terminal_control)
    ) ||
    !after.native_thread_id ||
    after.native_process.process_uuid !== transition.before_process_uuid ||
    after.native_process.process_birth !== transition.before_process_birth
  ) {
    throw new Error(
      "native thread transition after_binding disagrees with terminal or process identity"
    );
  }
  if (
    before &&
    (
      !sameTerminalControlIncarnation(
        after.terminal_control,
        before.terminal_control
      ) ||
      after.native_process.pid !== before.native_process.pid
    )
  ) {
    throw new Error(
      "native thread transition changed terminal control or process PID"
    );
  }
  const afterNativeThreadId = after.native_thread_id.toLowerCase();
  if (
    ["resume_thread", "adopt_external_thread"].includes(
      transition.operation
    )
      ? afterNativeThreadId !== transition.target_native_thread_id?.toLowerCase()
      : afterNativeThreadId === transition.before_native_thread_id.toLowerCase()
  ) {
    throw new Error(
      "native thread transition after_binding does not satisfy its operation"
    );
  }
}

/**
 * Materialize protocol-3 Session records from predecessor Turn records. The
 * derivation never picks a Turn by mutable recency. A binding is accepted only
 * from one unambiguous binding generation; otherwise the Session is
 * quarantined and cannot become a routing authority.
 */
export function managedSessionStatesFromConversations(
  conversations: readonly Conversation[]
): ManagedSessionState[] {
  const groups = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    const sessionId = requiredConversationSessionId(conversation);
    const group = groups.get(sessionId) ?? [];
    group.push(conversation);
    groups.set(sessionId, group);
  }
  const states = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionId, turns]) => migratedSessionState(sessionId, turns));
  const owners = new Map<string, string[]>();
  for (const state of states) {
    const nativeThreadId = state.binding?.native_thread_id?.toLowerCase();
    if (!nativeThreadId) {
      continue;
    }
    const key = `${state.agent}\0${nativeThreadId}`;
    const sessionIds = owners.get(key) ?? [];
    sessionIds.push(state.session_id);
    owners.set(key, sessionIds);
  }
  const conflicts = new Map<string, string[]>();
  for (const sessionIds of owners.values()) {
    if (sessionIds.length < 2) {
      continue;
    }
    const sorted = [...sessionIds].sort();
    for (const sessionId of sorted) {
      conflicts.set(
        sessionId,
        sorted.filter((candidate) => candidate !== sessionId)
      );
    }
  }
  return states.map((state) => {
    const duplicateOwners = conflicts.get(state.session_id);
    if (!duplicateOwners) {
      return state;
    }
    const duplicateReason =
      "migrated native thread is referenced by multiple managed Sessions: " +
      duplicateOwners.join(", ");
    return {
      ...state,
      status: "quarantined",
      quarantine_reason: state.quarantine_reason
        ? `${state.quarantine_reason}; ${duplicateReason}`
        : duplicateReason
    };
  });
}

function migratedSessionState(
  sessionId: string,
  turns: readonly Conversation[]
): ManagedSessionState {
  const agents = new Set(turns.map((turn) => executorForConversation(turn).kind));
  const workspaces = new Set(turns.map((turn) => turn.workspace));
  if (agents.size !== 1 || workspaces.size !== 1) {
    throw new Error(
      `cannot migrate Session ${sessionId}: its Turns disagree on agent or workspace`
    );
  }
  const agent = [...agents][0];
  const workspace = [...workspaces][0];
  assertExecutorKind(agent, "migrated Session agent");
  assertNonEmptyString(workspace, "migrated Session workspace");
  const createdAt = minimumTimestamp(
    turns.map((turn) => turn.created_at),
    `Session ${sessionId} created_at`
  );
  const updatedAt = maximumTimestamp(
    turns.map((turn) => turn.updated_at),
    `Session ${sessionId} updated_at`
  );
  const candidates = turns
    .map((turn) => migratedBindingCandidate(turn, agent))
    .filter((candidate): candidate is MigratedBindingCandidate => Boolean(candidate));
  const selection = selectMigratedBinding(sessionId, candidates);
  const common = {
    schema: MANAGED_SESSION_SCHEMA,
    version: MANAGED_SESSION_VERSION,
    session_id: sessionId,
    revision: 1,
    agent,
    workspace,
    lineage: { created_by: "migration" as const },
    created_at: createdAt,
    updated_at: updatedAt
  };
  if (selection.kind === "none") {
    return { ...common, status: "detached" };
  }
  if (selection.kind === "ambiguous") {
    return {
      ...common,
      status: "quarantined",
      quarantine_reason: selection.reason
    };
  }
  const strong = hasStrongIncarnationEvidence(agent, selection.binding);
  if (!strong) {
    return {
      ...common,
      status: "quarantined",
      binding: selection.binding,
      quarantine_reason:
        "migrated Turn binding lacks exact native process-incarnation evidence"
    };
  }
  return { ...common, status: "bound", binding: selection.binding };
}

interface MigratedBindingCandidate {
  binding: ManagedTerminalBinding;
  identityFingerprint: string;
  explicitBindingId: boolean;
}

function migratedBindingCandidate(
  conversation: Conversation,
  agent: ExecutorKind
): MigratedBindingCandidate | undefined {
  const takeover = isRecord(conversation.native_session_takeover)
    ? conversation.native_session_takeover
    : undefined;
  if (!takeover || !isRecord(takeover.terminal_control)) {
    return undefined;
  }
  const terminalControl = takeover.terminal_control;
  try {
    assertTerminalControlRef(terminalControl, "migrated terminal_control");
  } catch {
    return undefined;
  }
  const terminalEndpoint = isRecord(takeover.terminal_endpoint)
    ? takeover.terminal_endpoint as TerminalControlEvidence
    : undefined;
  if (terminalEndpoint) {
    try {
      associateTerminalEndpointEvidence(terminalControl, terminalEndpoint);
    } catch {
      return undefined;
    }
  }
  const terminalId = optionalNonEmptyString(takeover.native_session_id);
  const pid = positiveInteger(takeover.terminal_agent_pid);
  if (!terminalId || pid === undefined) {
    return undefined;
  }
  const topBindingId = optionalNonEmptyString(conversation.terminal_binding_id);
  const nestedBindingId = optionalNonEmptyString(takeover.terminal_binding_id);
  if (topBindingId && nestedBindingId && topBindingId !== nestedBindingId) {
    return undefined;
  }
  const topGeneration = positiveInteger(conversation.terminal_binding_generation);
  const nestedGeneration = positiveInteger(takeover.terminal_binding_generation);
  if (
    topGeneration !== undefined &&
    nestedGeneration !== undefined &&
    topGeneration !== nestedGeneration
  ) {
    return undefined;
  }
  const nativeIds = [
    optionalNonEmptyString(conversation.native_thread_id),
    optionalNonEmptyString(takeover.terminal_agent_expected_session_id),
    optionalNonEmptyString(takeover.terminal_agent_session_id)
  ].filter((value): value is string => Boolean(value));
  const exactNativeIds = [...new Set(nativeIds.filter(isExactNativeThreadId))];
  if (exactNativeIds.length > 1) {
    return undefined;
  }
  const nativeThreadId = exactNativeIds[0];
  const rollout = migratedRollout(takeover.terminal_agent_rollout);
  const processUuid = optionalNonEmptyString(
    takeover.terminal_agent_process_uuid
  );
  const processBirth = optionalNonEmptyString(
    takeover.terminal_agent_process_birth
  );
  const evidence = optionalNonEmptyString(
    takeover.terminal_agent_identity_evidence
  ) ?? "store_protocol_migration";
  const generation = topGeneration ?? nestedGeneration ?? 1;
  const identity = {
    agent,
    terminal_id: terminalId,
    terminal_control: terminalControl,
    ...(terminalEndpoint ? { terminal_endpoint: terminalEndpoint } : {}),
    native_thread_id: nativeThreadId ?? null,
    pid,
    process_uuid: processUuid ?? null,
    process_birth: processBirth ?? null,
    rollout: rollout ?? null
  };
  const identityFingerprint = stableHash(identity);
  const bindingId = topBindingId ?? nestedBindingId ??
    `binding-migration-${identityFingerprint.slice(0, 32)}`;
  const observedAt = validTimestamp(conversation.created_at) ??
    validTimestamp(conversation.updated_at);
  if (!observedAt) {
    return undefined;
  }
  const binding: ManagedTerminalBinding = {
    binding_id: bindingId,
    generation,
    terminal_id: terminalId,
    terminal_control: terminalControl,
    ...(terminalEndpoint ? { terminal_endpoint: terminalEndpoint } : {}),
    native_thread_id: nativeThreadId,
    native_process: {
      pid,
      process_uuid: processUuid,
      process_birth: processBirth,
      rollout,
      evidence
    },
    bound_at: observedAt,
    last_verified_at: validTimestamp(conversation.updated_at) ?? observedAt
  };
  assertManagedTerminalBinding(binding, "migrated terminal binding");
  return {
    binding,
    identityFingerprint,
    explicitBindingId: Boolean(topBindingId ?? nestedBindingId)
  };
}

function selectMigratedBinding(
  sessionId: string,
  candidates: readonly MigratedBindingCandidate[]
):
  | { kind: "none" }
  | { kind: "ambiguous"; reason: string }
  | { kind: "selected"; binding: ManagedTerminalBinding } {
  if (candidates.length === 0) {
    return { kind: "none" };
  }
  const maxGeneration = Math.max(...candidates.map(({ binding }) => binding.generation));
  const latestGeneration = candidates.filter(
    ({ binding }) => binding.generation === maxGeneration
  );
  const fingerprints = new Set(
    latestGeneration.map(({ identityFingerprint }) => identityFingerprint)
  );
  const explicitIds = new Set(
    latestGeneration
      .filter(({ explicitBindingId }) => explicitBindingId)
      .map(({ binding }) => binding.binding_id)
  );
  if (fingerprints.size !== 1 || explicitIds.size > 1) {
    return {
      kind: "ambiguous",
      reason:
        `migrated Turns for Session ${sessionId} contain conflicting binding generation ${maxGeneration}`
    };
  }
  const selected = latestGeneration[0].binding;
  const explicitId = explicitIds.values().next().value as string | undefined;
  const boundAt = minimumTimestamp(
    latestGeneration.map(({ binding }) => binding.bound_at),
    `Session ${sessionId} binding bound_at`
  );
  const lastVerifiedAt = maximumTimestamp(
    latestGeneration.map(({ binding }) => binding.last_verified_at),
    `Session ${sessionId} binding last_verified_at`
  );
  return {
    kind: "selected",
    binding: {
      ...selected,
      binding_id: explicitId ?? selected.binding_id,
      bound_at: boundAt,
      last_verified_at: lastVerifiedAt
    }
  };
}

function hasStrongIncarnationEvidence(
  agent: ExecutorKind,
  binding: ManagedTerminalBinding
): boolean {
  if (!binding.native_thread_id) {
    return false;
  }
  return agent === "claude"
    ? Boolean(binding.native_process.process_uuid)
    : Boolean(
        binding.native_process.process_birth && binding.native_process.rollout
      );
}

function requiredConversationSessionId(conversation: Conversation): string {
  const value = conversation.session_id ?? conversation.conversation_id;
  assertManagedSessionId(value);
  return value;
}

function assertManagedSessionLineage(value: unknown): void {
  if (!isRecord(value)) {
    throw new Error("managed session lineage must be an object");
  }
  assertOnlyKeys(value, [
    "created_by",
    "previous_session_id",
    "resumed_from_native_thread_id",
    "transition_id"
  ], "managed session lineage");
  if (!MANAGED_SESSION_LINEAGE_KINDS.has(
    value.created_by as ManagedSessionLineage["created_by"]
  )) {
    throw new Error("managed session lineage created_by is invalid");
  }
  if (value.previous_session_id !== undefined) {
    assertManagedSessionId(value.previous_session_id);
  }
  if (value.resumed_from_native_thread_id !== undefined) {
    assertExactNativeThreadId(
      value.resumed_from_native_thread_id,
      "managed session lineage resumed_from_native_thread_id"
    );
  }
  assertOptionalNonEmptyString(value.transition_id, "managed session lineage transition_id");
}

function assertManagedTerminalBinding(
  value: unknown,
  label: string
): asserts value is ManagedTerminalBinding {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertOnlyKeys(value, [
    "binding_id",
    "generation",
    "terminal_id",
    "terminal_control",
    "terminal_endpoint",
    "native_thread_id",
    "native_process",
    "bound_at",
    "last_verified_at"
  ], label);
  assertNonEmptyString(value.binding_id, `${label} binding_id`);
  if (!isPositiveSafeInteger(value.generation)) {
    throw new Error(`${label} generation must be a positive safe integer`);
  }
  assertNonEmptyString(value.terminal_id, `${label} terminal_id`);
  assertTerminalControlRef(value.terminal_control, `${label} terminal_control`);
  if (value.terminal_endpoint !== undefined) {
    assertTerminalEndpointEvidence(
      value.terminal_endpoint,
      `${label} terminal_endpoint`
    );
    associateTerminalEndpointEvidence(
      value.terminal_control as TerminalControlRef,
      value.terminal_endpoint
    );
  }
  if (value.native_thread_id !== undefined) {
    // Persist the exact opaque id reported by the adapter. Current Codex and
    // Claude lifecycle selectors are UUIDs, but a Session binding must not
    // truncate or reinterpret a future/native version-specific identity.
    assertNonEmptyString(value.native_thread_id, `${label} native_thread_id`);
  }
  assertNativeProcessIdentity(value.native_process, `${label} native_process`);
  assertTimestamp(value.bound_at, `${label} bound_at`);
  assertTimestamp(value.last_verified_at, `${label} last_verified_at`);
}

function assertTerminalEndpointEvidence(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "kind",
    "endpoint_key",
    "resource_key",
    "route_key",
    "process_anchor_pid",
    "target",
    "socket_path",
    "pane_pid",
    "server_socket_path",
    "pane_id",
    "session_name",
    "session_dir",
    "workspace_id",
    "tab_id",
    "terminal_id",
    "current_path"
  ], label);
  if (
    value.schema !== "agent-knock-knock/terminal-endpoint" ||
    value.version !== 1
  ) {
    throw new Error(`${label} has an unsupported identity evidence version`);
  }
  if (!terminalEndpointIdentityFromEvidence(value)) {
    throw new Error(`${label} has invalid or inconsistent identity evidence`);
  }
  if (!terminalRouteKeyFromEvidence(value)) {
    throw new Error(`${label} has inconsistent route evidence`);
  }
}

function assertNativeProcessIdentity(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertOnlyKeys(value, [
    "pid",
    "process_uuid",
    "process_birth",
    "rollout",
    "evidence"
  ], label);
  if (!isPositiveSafeInteger(value.pid)) {
    throw new Error(`${label} pid must be a positive safe integer`);
  }
  assertOptionalNonEmptyString(value.process_uuid, `${label} process_uuid`);
  assertOptionalNonEmptyString(value.process_birth, `${label} process_birth`);
  if (value.rollout !== undefined) {
    assertRollout(value.rollout, `${label} rollout`);
  }
  assertNonEmptyString(value.evidence, `${label} evidence`);
}

function assertRollout(value: unknown, label: string): void {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertOnlyKeys(value, ["fd", "device", "inode", "path"], label);
  for (const field of ["fd", "device", "inode", "path"] as const) {
    assertNonEmptyString(value[field], `${label} ${field}`);
  }
}

function assertTerminalControlRef(
  value: unknown,
  label: string
): asserts value is TerminalControlRef {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  const commonKeys = [
    "kind",
    "target",
    "socketPath",
    "session",
    "panePid",
    "currentCommand",
    "currentPath",
    "capabilities"
  ];
  if (value.kind === "tmux") {
    assertOnlyKeys(value, [...commonKeys, "window", "pane"], label);
  } else if (value.kind === "herdr") {
    assertOnlyKeys(value, [
      ...commonKeys,
      "sessionDir",
      "workspaceId",
      "tabId",
      "paneId",
      "terminalId"
    ], label);
  } else {
    throw new Error(`${label} kind must be tmux or herdr`);
  }
  assertNonEmptyString(value.target, `${label} target`);
  assertNonEmptyString(value.session, `${label} session`);
  if (value.kind === "tmux") {
    assertOptionalNonEmptyString(value.socketPath, `${label} socketPath`);
    if (!isNonNegativeSafeInteger(value.window)) {
      throw new Error(`${label} window must be a non-negative safe integer`);
    }
    if (!isNonNegativeSafeInteger(value.pane)) {
      throw new Error(`${label} pane must be a non-negative safe integer`);
    }
  } else {
    assertNonEmptyString(value.socketPath, `${label} socketPath`);
    assertOptionalNonEmptyString(value.sessionDir, `${label} sessionDir`);
    assertNonEmptyString(value.workspaceId, `${label} workspaceId`);
    assertNonEmptyString(value.tabId, `${label} tabId`);
    assertNonEmptyString(value.paneId, `${label} paneId`);
    assertNonEmptyString(value.terminalId, `${label} terminalId`);
  }
  if (!isPositiveSafeInteger(value.panePid)) {
    throw new Error(`${label} panePid must be a positive safe integer`);
  }
  assertOptionalNonEmptyString(value.currentCommand, `${label} currentCommand`);
  assertOptionalNonEmptyString(value.currentPath, `${label} currentPath`);
  if (
    !Array.isArray(value.capabilities) ||
    value.capabilities.some((capability) =>
      typeof capability !== "string" ||
      !TERMINAL_CONTROL_CAPABILITIES.has(capability as TerminalControlCapability)
    ) ||
    new Set(value.capabilities).size !== value.capabilities.length
  ) {
    throw new Error(`${label} capabilities are invalid`);
  }
}

function migratedRollout(value: unknown): NativeProcessIdentity["rollout"] | undefined {
  try {
    assertRollout(value, "migrated rollout");
    return value as unknown as NativeProcessIdentity["rollout"];
  } catch {
    return undefined;
  }
}

function assertStorageRecordId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    /[/\\]/u.test(value)
  ) {
    throw new Error(`${label} is not safe for storage: ${String(value)}`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown !== undefined) {
    throw new Error(`${label} contains unsupported field ${unknown}`);
  }
}

function assertExecutorKind(value: unknown, label: string): asserts value is ExecutorKind {
  if (value !== "codex" && value !== "claude") {
    throw new Error(`${label} is invalid`);
  }
}

function assertExactNativeThreadId(value: unknown, label: string): void {
  if (!isExactNativeThreadId(value)) {
    throw new Error(`${label} must be an exact native thread UUID`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, label);
  }
}

function optionalNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && !value.includes("\0")
    ? value
    : undefined;
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (validTimestamp(value) === undefined) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) {
    assertTimestamp(value, label);
  }
}

function validTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value))
    ? value
    : undefined;
}

function minimumTimestamp(values: readonly unknown[], label: string): string {
  const valid = values.map(validTimestamp);
  if (valid.some((value) => value === undefined)) {
    throw new Error(`${label} must be valid for every Turn`);
  }
  return (valid as string[]).sort((left, right) =>
    Date.parse(left) - Date.parse(right) || left.localeCompare(right)
  )[0];
}

function maximumTimestamp(values: readonly unknown[], label: string): string {
  const valid = values.map(validTimestamp);
  if (valid.some((value) => value === undefined)) {
    throw new Error(`${label} must be valid for every Turn`);
  }
  return (valid as string[]).sort((left, right) =>
    Date.parse(right) - Date.parse(left) || right.localeCompare(left)
  )[0];
}

function positiveInteger(value: unknown): number | undefined {
  return isPositiveSafeInteger(value) ? value : undefined;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function stableHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MANAGED_SESSION_STATUSES = new Set<ManagedSessionStatus>([
  "bound",
  "detached",
  "transitioning",
  "quarantined"
]);
const MANAGED_SESSION_LINEAGE_KINDS = new Set<ManagedSessionLineage["created_by"]>([
  "attach",
  "new_thread",
  "resume_thread",
  "human_observed",
  "migration"
]);
const NATIVE_THREAD_OPERATIONS = new Set<NativeThreadTransition["operation"]>([
  "new_thread",
  "resume_thread",
  "adopt_external_thread"
]);
const NATIVE_THREAD_TRANSITION_STATUSES = new Set<NativeThreadTransitionStatus>([
  "prepared",
  "dispatching",
  "submitted",
  "uncertain",
  "verified",
  "committed",
  "aborted"
]);
const TERMINAL_CONTROL_CAPABILITIES = new Set<TerminalControlCapability>([
  "screen_status",
  "send_keys",
  "terminal_approval",
  "screen_completion",
  "durable_completion",
  "terminal_cancel"
]);

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

import fs from "node:fs";
import path from "node:path";
import {
  assertRealDirectory,
  atomicSaveJsonFile,
  isNodeError,
  readJsonFileNoFollow
} from "./durable-json-file.js";
import {
  assertManagedSessionId,
  assertManagedSessionState,
  assertNativeThreadTransition,
  managedSessionStorageKey,
  type ManagedSessionState,
  type ManagedTerminalBinding,
  type NativeThreadTransition,
  type NativeThreadTransitionStatus
} from "./managed-session.js";
import {
  assertStoreReadable,
  ensureDir,
  STORE_SESSION_AUTHORITY_PROTOCOL,
  withStoreWriterLease
} from "./store.js";

const SESSIONS_DIRECTORY = "sessions";
const TRANSITIONS_DIRECTORY = "transitions";
const SESSION_STATE_FILE = "state.json";

export interface ManagedSessionPaths {
  directory: string;
  statePath: string;
}

export interface NativeThreadTransitionPaths {
  directory: string;
  statePath: string;
}

export interface ManagedSessionSaveOptions {
  /** `null` means create-only; a number is the exact revision to replace. */
  expectedRevision: number | null;
}

export interface NativeThreadTransitionSaveOptions {
  /** `null` means create-only; a number is the exact revision to replace. */
  expectedRevision: number | null;
}

export class ManagedSessionConflictError extends Error {
  readonly code = "AKK_MANAGED_SESSION_CONFLICT";
  readonly sessionId: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    sessionId: string,
    expectedRevision: number | null,
    actualRevision: number | null,
    detail?: string
  ) {
    super(
      `managed Session ${sessionId} changed concurrently` +
      ` (expected revision ${String(expectedRevision)}, actual ${String(actualRevision)})` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "ManagedSessionConflictError";
    this.sessionId = sessionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class ManagedSessionStateMissingError extends Error {
  readonly code = "AKK_MANAGED_SESSION_STATE_MISSING";
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `Store protocol 3+ requires authoritative state for managed Session ${sessionId}; ` +
      "refusing to infer a binding from Turn recency"
    );
    this.name = "ManagedSessionStateMissingError";
    this.sessionId = sessionId;
  }
}

export class ManagedSessionNativeThreadConflictError extends Error {
  readonly code = "AKK_MANAGED_SESSION_NATIVE_THREAD_CONFLICT";
  readonly sessionId: string;
  readonly nativeThreadId: string;
  readonly conflictingSessionIds: readonly string[];

  constructor(
    sessionId: string,
    nativeThreadId: string,
    conflictingSessionIds: readonly string[]
  ) {
    const conflicts = [...conflictingSessionIds].sort();
    super(
      `managed Session ${sessionId} cannot claim native thread ${nativeThreadId}; ` +
      `it is already recorded by ${conflicts.join(", ")}`
    );
    this.name = "ManagedSessionNativeThreadConflictError";
    this.sessionId = sessionId;
    this.nativeThreadId = nativeThreadId;
    this.conflictingSessionIds = conflicts;
  }
}

export class NativeThreadTransitionConflictError extends Error {
  readonly code = "AKK_NATIVE_THREAD_TRANSITION_CONFLICT";
  readonly transitionId: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    transitionId: string,
    expectedRevision: number | null,
    actualRevision: number | null,
    detail?: string
  ) {
    super(
      `native thread transition ${transitionId} changed concurrently` +
      ` (expected revision ${String(expectedRevision)}, actual ${String(actualRevision)})` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "NativeThreadTransitionConflictError";
    this.transitionId = transitionId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function managedSessionsDir(storeDir: string): string {
  return path.join(storeDir, SESSIONS_DIRECTORY);
}

export function nativeThreadTransitionsDir(storeDir: string): string {
  return path.join(storeDir, TRANSITIONS_DIRECTORY);
}

export function pathsForManagedSession(
  sessionId: string,
  storeDir: string
): ManagedSessionPaths {
  assertManagedSessionId(sessionId);
  const directory = path.join(
    managedSessionsDir(storeDir),
    managedSessionStorageKey(sessionId)
  );
  assertContained(directory, managedSessionsDir(storeDir), "session directory");
  return { directory, statePath: path.join(directory, SESSION_STATE_FILE) };
}

export function pathsForNativeThreadTransition(
  transitionId: string,
  storeDir: string
): NativeThreadTransitionPaths {
  validateRecordId(transitionId, "transition id");
  const directory = path.join(nativeThreadTransitionsDir(storeDir), transitionId);
  assertContained(
    directory,
    nativeThreadTransitionsDir(storeDir),
    "transition directory"
  );
  return { directory, statePath: path.join(directory, SESSION_STATE_FILE) };
}

/**
 * Create or compare-and-swap an authoritative Session record. Callers must use
 * the returned value (and its incremented revision) for a later update.
 */
export function saveManagedSession(
  storeDir: string,
  state: ManagedSessionState,
  options: ManagedSessionSaveOptions
): ManagedSessionState {
  assertManagedSessionState(state, undefined, { allowMissingRevision: true });
  assertExpectedRevision(options?.expectedRevision);
  const paths = pathsForManagedSession(state.session_id, storeDir);
  return withStoreWriterLease(storeDir, () => {
    const current = tryReadManagedSessionState(paths, state.session_id);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== options.expectedRevision) {
      throw new ManagedSessionConflictError(
        state.session_id,
        options.expectedRevision,
        actualRevision
      );
    }
    if (
      state.revision !== undefined &&
      state.revision !== (options.expectedRevision ?? 1)
    ) {
      throw new ManagedSessionConflictError(
        state.session_id,
        options.expectedRevision,
        actualRevision,
        `candidate carries revision ${state.revision}`
      );
    }
    if (current) {
      assertImmutableSessionFields(current, state);
      assertSafeBindingReplacement(current, state);
    }
    assertUniqueManagedNativeThreadBinding(storeDir, state);
    const revision = current ? requiredRevision(current) + 1 : 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error(`managed Session ${state.session_id} revision overflow`);
    }
    const next: ManagedSessionState = { ...state, revision };
    assertManagedSessionState(next, state.session_id);
    atomicSaveJson(paths.statePath, next);
    return next;
  });
}

function assertUniqueManagedNativeThreadBinding(
  storeDir: string,
  candidate: ManagedSessionState
): void {
  const nativeThreadId = candidate.binding?.native_thread_id?.toLowerCase();
  if (!nativeThreadId) {
    return;
  }
  const conflicts = listManagedSessions(storeDir)
    .filter((state) =>
      state.session_id !== candidate.session_id &&
      state.agent === candidate.agent &&
      state.binding?.native_thread_id?.toLowerCase() === nativeThreadId
    )
    .map((state) => state.session_id);
  if (conflicts.length > 0) {
    throw new ManagedSessionNativeThreadConflictError(
      candidate.session_id,
      nativeThreadId,
      conflicts
    );
  }
}

export function loadManagedSession(
  storeDir: string,
  sessionId: string
): ManagedSessionState {
  const compatibility = assertStoreReadable(storeDir);
  const paths = pathsForManagedSession(sessionId, storeDir);
  try {
    const state = readJsonFile(paths.statePath, "managed session state");
    assertManagedSessionState(state, sessionId);
    return state;
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") &&
      Number(compatibility.writer_protocol) >= STORE_SESSION_AUTHORITY_PROTOCOL
    ) {
      throw new ManagedSessionStateMissingError(sessionId);
    }
    throw error;
  }
}

export function tryLoadManagedSession(
  storeDir: string,
  sessionId: string
): ManagedSessionState | undefined {
  try {
    return loadManagedSession(storeDir, sessionId);
  } catch (error) {
    if (
      isNodeError(error, "ENOENT") ||
      error instanceof ManagedSessionStateMissingError
    ) {
      return undefined;
    }
    throw error;
  }
}

export function listManagedSessions(storeDir: string): ManagedSessionState[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }
  const compatibility = assertStoreReadable(storeDir);
  const root = managedSessionsDir(storeDir);
  if (!fs.existsSync(root)) {
    if (
      Number(compatibility.writer_protocol) >= STORE_SESSION_AUTHORITY_PROTOCOL
    ) {
      throw new Error(
        `Store protocol ${String(compatibility.writer_protocol)} requires a ` +
        `managed sessions directory: ${root}`
      );
    }
    return [];
  }
  assertRealDirectory(root, "managed sessions directory");
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (
        entry.isSymbolicLink() ||
        !entry.isDirectory() ||
        !/^[0-9a-f]{64}$/u.test(entry.name)
      ) {
        throw new Error(
          `managed sessions directory contains an invalid entry: ${path.join(root, entry.name)}`
        );
      }
      const statePath = path.join(root, entry.name, SESSION_STATE_FILE);
      const state = readJsonFile(statePath, "managed session state");
      assertManagedSessionState(state);
      if (entry.name !== managedSessionStorageKey(state.session_id)) {
        throw new Error(
          `managed session storage key does not match ${state.session_id}`
        );
      }
      return state;
    })
    .sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at) ||
      left.session_id.localeCompare(right.session_id)
    );
}

export function saveNativeThreadTransition(
  storeDir: string,
  transition: NativeThreadTransition,
  options: NativeThreadTransitionSaveOptions
): NativeThreadTransition {
  assertNativeThreadTransition(transition, undefined, {
    allowMissingRevision: true
  });
  assertExpectedRevision(options?.expectedRevision);
  const paths = pathsForNativeThreadTransition(
    transition.transition_id,
    storeDir
  );
  return withStoreWriterLease(storeDir, () => {
    const current = tryReadNativeThreadTransitionState(
      paths,
      transition.transition_id
    );
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== options.expectedRevision) {
      throw new NativeThreadTransitionConflictError(
        transition.transition_id,
        options.expectedRevision,
        actualRevision
      );
    }
    if (
      transition.revision !== undefined &&
      transition.revision !== (options.expectedRevision ?? 1)
    ) {
      throw new NativeThreadTransitionConflictError(
        transition.transition_id,
        options.expectedRevision,
        actualRevision,
        `candidate carries revision ${transition.revision}`
      );
    }
    if (current) {
      assertImmutableTransitionFields(current, transition);
      assertTransitionStatusAdvance(current, transition);
    }
    const revision = current
      ? requiredTransitionRevision(current) + 1
      : 1;
    if (!Number.isSafeInteger(revision)) {
      throw new Error(
        `native thread transition ${transition.transition_id} revision overflow`
      );
    }
    const next: NativeThreadTransition = { ...transition, revision };
    assertNativeThreadTransition(next, transition.transition_id);
    atomicSaveJson(paths.statePath, next);
    return next;
  });
}

export function loadNativeThreadTransition(
  storeDir: string,
  transitionId: string
): NativeThreadTransition {
  assertStoreReadable(storeDir);
  const paths = pathsForNativeThreadTransition(transitionId, storeDir);
  const transition = readJsonFile(
    paths.statePath,
    "native thread transition state"
  );
  assertNativeThreadTransition(transition, transitionId);
  return transition;
}

export function listNativeThreadTransitions(
  storeDir: string
): NativeThreadTransition[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }
  assertStoreReadable(storeDir);
  const root = nativeThreadTransitionsDir(storeDir);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertRealDirectory(root, "native thread transitions directory");
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          `native thread transitions directory contains an invalid entry: ` +
          path.join(root, entry.name)
        );
      }
      const statePath = path.join(root, entry.name, SESSION_STATE_FILE);
      const transition = readJsonFile(
        statePath,
        "native thread transition state"
      );
      assertNativeThreadTransition(transition, entry.name);
      return transition;
    })
    .sort((left, right) =>
      right.prepared_at.localeCompare(left.prepared_at) ||
      left.transition_id.localeCompare(right.transition_id)
    );
}

function tryReadManagedSessionState(
  paths: ManagedSessionPaths,
  sessionId: string
): ManagedSessionState | undefined {
  try {
    const state = readJsonFile(paths.statePath, "managed session state");
    assertManagedSessionState(state, sessionId);
    return state;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function tryReadNativeThreadTransitionState(
  paths: NativeThreadTransitionPaths,
  transitionId: string
): NativeThreadTransition | undefined {
  try {
    const transition = readJsonFile(
      paths.statePath,
      "native thread transition state"
    );
    assertNativeThreadTransition(transition, transitionId);
    return transition;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

function assertImmutableSessionFields(
  current: ManagedSessionState,
  candidate: ManagedSessionState
): void {
  const immutablePairs: Array<[string, unknown, unknown]> = [
    ["agent", current.agent, candidate.agent],
    ["workspace", current.workspace, candidate.workspace],
    ["created_at", current.created_at, candidate.created_at],
    ["lineage", current.lineage, candidate.lineage]
  ];
  const changed = immutablePairs.find(([, left, right]) =>
    JSON.stringify(left) !== JSON.stringify(right)
  );
  if (changed) {
    throw new Error(
      `managed Session ${current.session_id} cannot change immutable ${changed[0]}`
    );
  }
}

function assertSafeBindingReplacement(
  current: ManagedSessionState,
  candidate: ManagedSessionState
): void {
  const before = current.binding;
  const after = candidate.binding;
  if (!before && !after) {
    return;
  }
  if (!before && after) {
    if (after.generation !== 1) {
      throw new Error(
        `first binding for managed Session ${current.session_id} must use generation 1`
      );
    }
    return;
  }
  if (before && !after) {
    throw new Error(
      `managed Session ${current.session_id} cannot discard its binding evidence`
    );
  }
  if (!before || !after) {
    return;
  }
  if (
    before.binding_id === after.binding_id &&
    before.generation === after.generation
  ) {
    assertBindingIdentityRefinement(before, after, current.session_id);
    return;
  }
  if (
    after.binding_id === before.binding_id ||
    after.generation !== before.generation + 1
  ) {
    throw new Error(
      `managed Session ${current.session_id} binding replacement must use a new id and generation ${before.generation + 1}`
    );
  }
}

function assertImmutableTransitionFields(
  current: NativeThreadTransition,
  candidate: NativeThreadTransition
): void {
  const immutablePairs: Array<[string, unknown, unknown]> = [
    ["operation", current.operation, candidate.operation],
    ["origin", current.origin, candidate.origin],
    ["terminal_input_sent", current.terminal_input_sent, candidate.terminal_input_sent],
    ["terminal_id", current.terminal_id, candidate.terminal_id],
    ["agent", current.agent, candidate.agent],
    ["workspace", current.workspace, candidate.workspace],
    ["source_session_id", current.source_session_id, candidate.source_session_id],
    ["source_expected_revision", current.source_expected_revision, candidate.source_expected_revision],
    ["source_previous_last_transition_id", current.source_previous_last_transition_id, candidate.source_previous_last_transition_id],
    ["target_session_id", current.target_session_id, candidate.target_session_id],
    ["target_expected_revision", current.target_expected_revision, candidate.target_expected_revision],
    ["target_native_thread_id", current.target_native_thread_id, candidate.target_native_thread_id],
    ["target_candidate_file_identity", current.target_candidate_file_identity, candidate.target_candidate_file_identity],
    ["before_native_thread_id", current.before_native_thread_id, candidate.before_native_thread_id],
    ["before_process_uuid", current.before_process_uuid, candidate.before_process_uuid],
    ["before_process_started_at", current.before_process_started_at, candidate.before_process_started_at],
    ["before_process_birth", current.before_process_birth, candidate.before_process_birth],
    ["before_process_rollout", current.before_process_rollout, candidate.before_process_rollout],
    ["before_binding", current.before_binding, candidate.before_binding],
    ["adapter_version", current.adapter_version, candidate.adapter_version],
    ["command_fingerprint", current.command_fingerprint, candidate.command_fingerprint],
    ["dispatcher_pid", current.dispatcher_pid, candidate.dispatcher_pid],
    ["prepared_at", current.prepared_at, candidate.prepared_at]
  ];
  if (current.after_binding !== undefined) {
    immutablePairs.push([
      "after_binding",
      current.after_binding,
      candidate.after_binding
    ]);
  }
  if (current.reconciled_outcome !== undefined) {
    immutablePairs.push(
      [
        "reconciled_outcome",
        current.reconciled_outcome,
        candidate.reconciled_outcome
      ],
      ["reconciled_at", current.reconciled_at, candidate.reconciled_at]
    );
  }
  const changed = immutablePairs.find(([, left, right]) =>
    JSON.stringify(left) !== JSON.stringify(right)
  );
  if (changed) {
    throw new Error(
      `native thread transition ${current.transition_id} cannot change immutable ${changed[0]}`
    );
  }
}

function assertTransitionStatusAdvance(
  current: NativeThreadTransition,
  candidate: NativeThreadTransition
): void {
  const allowed: Record<NativeThreadTransitionStatus, readonly NativeThreadTransitionStatus[]> = {
    prepared: current.operation === "adopt_external_thread"
      ? ["verified", "uncertain", "aborted"]
      : ["dispatching", "aborted"],
    dispatching: ["submitted", "uncertain", "aborted"],
    submitted: ["verified", "uncertain", "aborted"],
    verified: ["committed"],
    uncertain: ["verified", "aborted"],
    committed: [],
    aborted: []
  };
  if (!allowed[current.status].includes(candidate.status)) {
    throw new Error(
      `native thread transition cannot move from ${current.status} to ${candidate.status}`
    );
  }
}

function assertBindingIdentityRefinement(
  before: ManagedTerminalBinding,
  after: ManagedTerminalBinding,
  sessionId: string
): void {
  const fixedBefore = {
    binding_id: before.binding_id,
    generation: before.generation,
    terminal_id: before.terminal_id,
    terminal_control: before.terminal_control,
    pid: before.native_process.pid,
    bound_at: before.bound_at
  };
  const fixedAfter = {
    binding_id: after.binding_id,
    generation: after.generation,
    terminal_id: after.terminal_id,
    terminal_control: after.terminal_control,
    pid: after.native_process.pid,
    bound_at: after.bound_at
  };
  if (JSON.stringify(fixedBefore) !== JSON.stringify(fixedAfter)) {
    throw new Error(
      `managed Session ${sessionId} cannot mutate an existing binding identity`
    );
  }
  if (
    before.terminal_endpoint !== undefined &&
    JSON.stringify(before.terminal_endpoint) !==
      JSON.stringify(after.terminal_endpoint)
  ) {
    throw new Error(
      `managed Session ${sessionId} cannot replace verified binding terminal_endpoint`
    );
  }
  for (const [label, oldValue, newValue] of [
    ["native_thread_id", before.native_thread_id, after.native_thread_id],
    ["process_uuid", before.native_process.process_uuid, after.native_process.process_uuid],
    ["process_birth", before.native_process.process_birth, after.native_process.process_birth],
    ["rollout", before.native_process.rollout, after.native_process.rollout]
  ] as const) {
    if (
      oldValue !== undefined &&
      JSON.stringify(oldValue) !== JSON.stringify(newValue)
    ) {
      throw new Error(
        `managed Session ${sessionId} cannot replace verified binding ${label}`
      );
    }
  }
}

function requiredRevision(state: ManagedSessionState): number {
  if (!Number.isSafeInteger(state.revision) || Number(state.revision) < 1) {
    throw new Error(`managed Session ${state.session_id} has no valid revision`);
  }
  return Number(state.revision);
}

function requiredTransitionRevision(state: NativeThreadTransition): number {
  if (!Number.isSafeInteger(state.revision) || Number(state.revision) < 1) {
    throw new Error(
      `native thread transition ${state.transition_id} has no valid revision`
    );
  }
  return Number(state.revision);
}

function assertExpectedRevision(value: unknown): asserts value is number | null {
  if (
    value !== null &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  ) {
    throw new Error("expectedRevision must be null or a positive safe integer");
  }
}

function atomicSaveJson(filePath: string, value: unknown): void {
  atomicSaveJsonFile(filePath, value, {
    rootLabel: "record root",
    directoryLabel: "record directory",
    fileLabel: "record state file",
    ensureDirectory: ensureDir,
    fsyncNewRootParent: true,
    fsyncNewDirectoryParent: true
  });
}

function readJsonFile(filePath: string, label: string): unknown {
  return readJsonFileNoFollow(filePath, label);
}

function validateRecordId(value: string, label: string): void {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} is not safe for storage: ${value}`);
  }
}

function assertContained(
  candidate: string,
  parent: string,
  label: string
): void {
  const resolvedParent = path.resolve(parent);
  const resolvedCandidate = path.resolve(candidate);
  if (
    resolvedCandidate === resolvedParent ||
    !resolvedCandidate.startsWith(`${resolvedParent}${path.sep}`)
  ) {
    throw new Error(`${label} escapes its Store root: ${candidate}`);
  }
}

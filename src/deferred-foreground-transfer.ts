import { randomUUID } from "node:crypto";
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
  isExactNativeThreadId,
  managedSessionBindingToken,
  type ManagedTerminalBinding
} from "./managed-session.js";
import {
  terminalEndpointIdentityFromEvidence,
  type TerminalControlEvidence
} from "./terminal-control-ref.js";
import {
  assertStoreReadable,
  ensureDir,
  STORE_DEFERRED_FOREGROUND_TRANSFERS_DIRECTORY,
  withStoreWriterLease
} from "./store.js";

export const DEFERRED_FOREGROUND_TRANSFER_SCHEMA =
  "agent-knock-knock/deferred-foreground-transfer" as const;
export const DEFERRED_FOREGROUND_TRANSFER_VERSION = 2 as const;
export const DEFERRED_FOREGROUND_TRANSFER_LEGACY_VERSION = 1 as const;

const TRANSFER_STATE_FILE = "state.json";

export type DeferredForegroundTransferStatus =
  | "prepared"
  | "source_reserved"
  | "target_prepared"
  | "dispatch_started"
  | "committed"
  | "resolved"
  | "aborted"
  | "abort_resolved"
  | "uncertain";

export type DeferredForegroundTransferInputStage =
  | "none"
  | "dispatch_started"
  | "text_injected"
  | "enter_dispatched"
  | "agent_accepted";

export type DeferredForegroundTransferSourceKind =
  | "status_card_only"
  | "candidate_rollout_quiescent";

export type DeferredForegroundTransferSourceRolloutAuthority =
  | "present"
  | "explicitly_abandoned_predecessor";

export interface DeferredForegroundTransferSourceTurnAuthority {
  turn_id: string;
  status: "idle" | "failed" | "closed" | "cancelled";
  updated_at: string;
  binding_id: string;
  binding_generation: number;
  native_thread_id: string;
  turn_fingerprint: string;
}

/**
 * Durable authority for replacing one quiescent Codex Session with a fresh
 * provisional Session around an ordinary task submission. Version 1 records
 * cover status-card-only sources; version 2 also freezes exact historical Turn
 * authority for rollout-backed sources.
 *
 * This record deliberately lives outside native lifecycle transitions.  It
 * never authorizes a slash command or terminal-input replay; the ordinary
 * terminal dispatch ledger remains the sole transport receipt authority.
 */
export interface DeferredForegroundTransfer {
  schema: typeof DEFERRED_FOREGROUND_TRANSFER_SCHEMA;
  version:
    | typeof DEFERRED_FOREGROUND_TRANSFER_LEGACY_VERSION
    | typeof DEFERRED_FOREGROUND_TRANSFER_VERSION;
  transfer_id: string;
  revision?: number;
  status: DeferredForegroundTransferStatus;
  input_stage: DeferredForegroundTransferInputStage;
  terminal_id: string;
  terminal_endpoint: TerminalControlEvidence;
  process_pid: number;
  process_uuid: string;
  process_birth: string;
  workspace: string;
  source_session_id: string;
  source_expected_revision: number;
  source_binding_token: string;
  source_previous_last_transition_id?: string;
  source_before_binding: ManagedTerminalBinding;
  source_kind?: DeferredForegroundTransferSourceKind;
  source_turn_history?: DeferredForegroundTransferSourceTurnAuthority[];
  source_rollout_authority?: DeferredForegroundTransferSourceRolloutAuthority;
  source_abandonment_fingerprint?: string;
  target_session_id: string;
  target_expected_revision: null;
  previous_dispatch_status: "none" | "resolved";
  previous_dispatch_fingerprint: string;
  target_prepared_revision?: number;
  target_prepared_status?: "transitioning";
  target_prepared_last_transition_id?: string;
  target_prepared_binding_token?: string;
  target_before_binding?: ManagedTerminalBinding;
  request_hash: string;
  dispatcher_pid: number;
  prepared_at: string;
  source_reserved_at?: string;
  target_prepared_at?: string;
  dispatch_started_at?: string;
  text_injected_at?: string;
  enter_dispatched_at?: string;
  agent_accepted_at?: string;
  message_id?: string;
  turn_id?: string;
  state_path?: string;
  target_native_thread_id?: string;
  target_accepted_revision?: number;
  target_accepted_status?: "transitioning";
  target_accepted_binding_token?: string;
  target_accepted_binding?: ManagedTerminalBinding;
  source_pre_retirement_revision?: number;
  source_pre_retirement_status?: "transitioning";
  source_pre_retirement_binding_token?: string;
  source_pre_retirement_binding?: ManagedTerminalBinding;
  source_retirement?:
    | "binding_retained"
    | "binding_scrubbed_same_native_thread";
  committed_at?: string;
  target_after_revision?: number;
  target_after_status?: "bound";
  target_after_binding_token?: string;
  source_after_revision?: number;
  source_after_binding?: ManagedTerminalBinding;
  source_after_binding_token?: string;
  source_after_status?: "detached";
  resolved_at?: string;
  aborted_at?: string;
  terminal_input_not_started_at?: string;
  abort_cleanup_completed_at?: string;
  abort_source_after_revision?: number;
  abort_source_after_status?: "bound";
  abort_source_after_binding_token?: string;
  abort_source_after_binding?: ManagedTerminalBinding;
  abort_target_after_status?: "absent" | "detached";
  abort_target_after_revision?: number;
  abort_target_after_binding_token?: string;
  abort_target_after_binding?: ManagedTerminalBinding;
  uncertain_at?: string;
  recovered_at?: string;
  error?: string;
  do_not_retry?: boolean;
}

export interface DeferredForegroundTransferSaveOptions {
  /** `null` means create-only; a number is the exact revision to replace. */
  expectedRevision: number | null;
}

export class DeferredForegroundTransferConflictError extends Error {
  readonly code = "AKK_DEFERRED_FOREGROUND_TRANSFER_CONFLICT";
  readonly transferId: string;
  readonly expectedRevision: number | null;
  readonly actualRevision: number | null;

  constructor(
    transferId: string,
    expectedRevision: number | null,
    actualRevision: number | null,
    detail?: string
  ) {
    super(
      `deferred foreground transfer ${transferId} changed concurrently` +
      ` (expected revision ${String(expectedRevision)}, actual ` +
      `${String(actualRevision)})` +
      (detail ? `: ${detail}` : "")
    );
    this.name = "DeferredForegroundTransferConflictError";
    this.transferId = transferId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export function createDeferredForegroundTransferId(): string {
  return `deferred-transfer-${randomUUID()}`;
}

export function deferredForegroundTransfersDir(storeDir: string): string {
  return path.join(storeDir, STORE_DEFERRED_FOREGROUND_TRANSFERS_DIRECTORY);
}

export function pathsForDeferredForegroundTransfer(
  transferId: string,
  storeDir: string
): { directory: string; statePath: string } {
  assertRecordId(transferId, "deferred foreground transfer id");
  const root = deferredForegroundTransfersDir(storeDir);
  const directory = path.join(root, transferId);
  assertContained(directory, root, "deferred foreground transfer directory");
  return { directory, statePath: path.join(directory, TRANSFER_STATE_FILE) };
}

export function assertDeferredForegroundTransfer(
  value: unknown,
  expectedTransferId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is DeferredForegroundTransfer {
  if (!isRecord(value)) {
    throw new Error("deferred foreground transfer must be an object");
  }
  assertOnlyKeys(value, [
    "schema",
    "version",
    "transfer_id",
    "revision",
    "status",
    "input_stage",
    "terminal_id",
    "terminal_endpoint",
    "process_pid",
    "process_uuid",
    "process_birth",
    "workspace",
    "source_session_id",
    "source_expected_revision",
    "source_binding_token",
    "source_previous_last_transition_id",
    "source_before_binding",
    "source_kind",
    "source_turn_history",
    "source_rollout_authority",
    "source_abandonment_fingerprint",
    "target_session_id",
    "target_expected_revision",
    "previous_dispatch_status",
    "previous_dispatch_fingerprint",
    "target_prepared_revision",
    "target_prepared_status",
    "target_prepared_last_transition_id",
    "target_prepared_binding_token",
    "target_before_binding",
    "request_hash",
    "dispatcher_pid",
    "prepared_at",
    "source_reserved_at",
    "target_prepared_at",
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "agent_accepted_at",
    "message_id",
    "turn_id",
    "state_path",
    "target_native_thread_id",
    "target_accepted_revision",
    "target_accepted_status",
    "target_accepted_binding_token",
    "target_accepted_binding",
    "source_pre_retirement_revision",
    "source_pre_retirement_status",
    "source_pre_retirement_binding_token",
    "source_pre_retirement_binding",
    "source_retirement",
    "committed_at",
    "target_after_revision",
    "target_after_status",
    "target_after_binding_token",
    "source_after_revision",
    "source_after_binding",
    "source_after_binding_token",
    "source_after_status",
    "resolved_at",
    "aborted_at",
    "terminal_input_not_started_at",
    "abort_cleanup_completed_at",
    "abort_source_after_revision",
    "abort_source_after_status",
    "abort_source_after_binding_token",
    "abort_source_after_binding",
    "abort_target_after_status",
    "abort_target_after_revision",
    "abort_target_after_binding_token",
    "abort_target_after_binding",
    "uncertain_at",
    "recovered_at",
    "error",
    "do_not_retry"
  ], "deferred foreground transfer");
  if (
    value.schema !== DEFERRED_FOREGROUND_TRANSFER_SCHEMA ||
    ![
      DEFERRED_FOREGROUND_TRANSFER_LEGACY_VERSION,
      DEFERRED_FOREGROUND_TRANSFER_VERSION
    ].includes(value.version as 1 | 2)
  ) {
    throw new Error(
      "deferred foreground transfer has an unsupported schema or version"
    );
  }
  assertRecordId(value.transfer_id, "deferred foreground transfer id");
  if (
    expectedTransferId !== undefined &&
    value.transfer_id !== expectedTransferId
  ) {
    throw new Error(
      `deferred foreground transfer id ${String(value.transfer_id)} does not ` +
      `match ${expectedTransferId}`
    );
  }
  if (
    value.revision === undefined
      ? !options.allowMissingRevision
      : !isPositiveSafeInteger(value.revision)
  ) {
    throw new Error(
      "deferred foreground transfer revision must be a positive safe integer"
    );
  }
  if (!TRANSFER_STATUSES.has(value.status as DeferredForegroundTransferStatus)) {
    throw new Error("deferred foreground transfer status is invalid");
  }
  if (!INPUT_STAGES.has(
    value.input_stage as DeferredForegroundTransferInputStage
  )) {
    throw new Error("deferred foreground transfer input_stage is invalid");
  }
  assertNonEmptyString(value.terminal_id, "deferred transfer terminal_id");
  if (!terminalEndpointIdentityFromEvidence(value.terminal_endpoint)) {
    throw new Error("deferred transfer terminal_endpoint is invalid");
  }
  if (!isPositiveSafeInteger(value.process_pid)) {
    throw new Error("deferred transfer process_pid must be positive");
  }
  assertNonEmptyString(value.process_uuid, "deferred transfer process_uuid");
  assertNonEmptyString(value.process_birth, "deferred transfer process_birth");
  assertAbsolutePath(value.workspace, "deferred transfer workspace");
  assertManagedSessionId(value.source_session_id);
  if (!isPositiveSafeInteger(value.source_expected_revision)) {
    throw new Error("deferred transfer source_expected_revision must be positive");
  }
  assertSha256(value.source_binding_token, "deferred transfer source binding token");
  assertOptionalNonEmptyString(
    value.source_previous_last_transition_id,
    "deferred transfer source previous transition"
  );
  assertBinding(value.source_before_binding, "deferred transfer source binding");
  const sourceKind = value.version === DEFERRED_FOREGROUND_TRANSFER_LEGACY_VERSION
    ? "status_card_only"
    : value.source_kind;
  if (
    value.version === DEFERRED_FOREGROUND_TRANSFER_LEGACY_VERSION
      ? value.source_kind !== undefined || value.source_turn_history !== undefined
      : !["status_card_only", "candidate_rollout_quiescent"].includes(
          String(sourceKind)
        )
  ) {
    throw new Error("deferred transfer source kind is invalid");
  }
  const sourceTurnHistory = value.source_turn_history;
  if (sourceKind === "candidate_rollout_quiescent") {
    if (
      !Array.isArray(sourceTurnHistory) ||
      sourceTurnHistory.length > 128
    ) {
      throw new Error(
        "candidate-rollout deferred source requires exact Turn history authority"
      );
    }
    const seenTurnIds = new Set<string>();
    for (const turn of sourceTurnHistory) {
      if (
        !isRecord(turn) ||
        Object.keys(turn).sort().join(",") !== [
          "binding_generation",
          "binding_id",
          "native_thread_id",
          "status",
          "turn_fingerprint",
          "turn_id",
          "updated_at"
        ].join(",") ||
        !isSafeRecordId(turn.turn_id) ||
        !["idle", "failed", "closed", "cancelled"].includes(
          String(turn.status)
        ) ||
        !isValidTimestamp(turn.updated_at) ||
        !isSafeRecordId(turn.binding_id) ||
        !isPositiveSafeInteger(turn.binding_generation) ||
        !isExactNativeThreadId(turn.native_thread_id) ||
        turn.binding_id !== value.source_before_binding.binding_id ||
        turn.binding_generation !== value.source_before_binding.generation ||
        turn.native_thread_id !== value.source_before_binding.native_thread_id ||
        typeof turn.turn_fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(turn.turn_fingerprint) ||
        seenTurnIds.has(String(turn.turn_id))
      ) {
        throw new Error(
          "candidate-rollout deferred source Turn history is invalid"
        );
      }
      seenTurnIds.add(String(turn.turn_id));
    }
  } else if (sourceTurnHistory !== undefined) {
    throw new Error(
      "status-card deferred source cannot carry Turn history authority"
    );
  }
  const sourceRolloutAuthority = sourceKind === "candidate_rollout_quiescent"
    ? value.source_rollout_authority ?? "present"
    : undefined;
  if (
    sourceKind !== "candidate_rollout_quiescent"
      ? value.source_rollout_authority !== undefined ||
        value.source_abandonment_fingerprint !== undefined
      : ![
          "present",
          "explicitly_abandoned_predecessor"
        ].includes(String(sourceRolloutAuthority))
  ) {
    throw new Error("deferred transfer source rollout authority is invalid");
  }
  if (sourceRolloutAuthority === "explicitly_abandoned_predecessor") {
    if (
      !Array.isArray(sourceTurnHistory) ||
      sourceTurnHistory.length === 0 ||
      !sourceTurnHistory.some((turn) => turn.status === "closed") ||
      value.previous_dispatch_status !== "resolved" ||
      typeof value.source_abandonment_fingerprint !== "string" ||
      !/^[0-9a-f]{64}$/u.test(value.source_abandonment_fingerprint)
    ) {
      throw new Error(
        "explicitly abandoned predecessor requires exact resolved abandonment authority"
      );
    }
  } else if (value.source_abandonment_fingerprint !== undefined) {
    throw new Error(
      "present deferred source rollout cannot carry abandonment authority"
    );
  }
  const statusCardSource = sourceKind === "status_card_only";
  const candidateRolloutSource =
    sourceKind === "candidate_rollout_quiescent";
  if (
    value.source_before_binding.native_process.pid !== value.process_pid ||
    value.source_before_binding.native_process.process_uuid !==
      value.process_uuid ||
    value.source_before_binding.native_process.process_birth !==
      value.process_birth ||
    value.source_before_binding.terminal_id !== value.terminal_id ||
    JSON.stringify(value.source_before_binding.terminal_endpoint) !==
      JSON.stringify(value.terminal_endpoint) ||
    !isExactNativeThreadId(value.source_before_binding.native_thread_id) ||
    (
      statusCardSource &&
      (
        value.source_before_binding.native_process.rollout !== undefined ||
        !value.source_before_binding.native_process.evidence.includes(
          "codex_status_card"
        )
      )
    ) ||
    (
      candidateRolloutSource &&
      value.source_before_binding.native_process.rollout === undefined
    ) ||
    (statusCardSource &&
      value.source_previous_last_transition_id !== undefined) ||
    managedSessionBindingToken({
      session_id: value.source_session_id,
      status: "bound",
      binding: value.source_before_binding
    }) !== value.source_binding_token
  ) {
    throw new Error(
      "deferred transfer source binding disagrees with terminal/process authority"
    );
  }
  assertManagedSessionId(value.target_session_id);
  if (value.target_session_id === value.source_session_id) {
    throw new Error("deferred transfer source and target Sessions must differ");
  }
  if (value.target_expected_revision !== null) {
    throw new Error("deferred transfer target_expected_revision must be null");
  }
  if (!(["none", "resolved"] as const).includes(
    value.previous_dispatch_status
  )) {
    throw new Error(
      "deferred transfer previous_dispatch_status must be none or resolved"
    );
  }
  assertSha256(
    value.previous_dispatch_fingerprint,
    "deferred transfer previous dispatch fingerprint"
  );
  if (
    value.target_prepared_revision !== undefined &&
    !isPositiveSafeInteger(value.target_prepared_revision)
  ) {
    throw new Error("deferred transfer target_prepared_revision must be positive");
  }
  if (
    value.target_prepared_status !== undefined &&
    value.target_prepared_status !== "transitioning"
  ) {
    throw new Error(
      "deferred transfer target_prepared_status must be transitioning"
    );
  }
  assertOptionalNonEmptyString(
    value.target_prepared_last_transition_id,
    "deferred transfer target prepared last transition"
  );
  if (value.target_prepared_binding_token !== undefined) {
    assertSha256(
      value.target_prepared_binding_token,
      "deferred transfer target prepared binding token"
    );
  }
  if (value.target_before_binding !== undefined) {
    assertBinding(value.target_before_binding, "deferred transfer target before binding");
    if (
      value.target_before_binding.native_thread_id !== undefined ||
      value.target_before_binding.native_process.rollout !== undefined ||
      value.target_before_binding.native_process.pid !== value.process_pid ||
      value.target_before_binding.native_process.process_uuid !==
        value.process_uuid ||
      value.target_before_binding.native_process.process_birth !==
        value.process_birth ||
      value.target_before_binding.terminal_id !== value.terminal_id ||
      JSON.stringify(value.target_before_binding.terminal_endpoint) !==
        JSON.stringify(value.terminal_endpoint) ||
      managedSessionBindingToken({
        session_id: value.target_session_id,
        status: "transitioning",
        binding: value.target_before_binding
      }) !== value.target_prepared_binding_token
    ) {
      throw new Error(
        "deferred transfer provisional target binding is not exact zero-UUID authority"
      );
    }
  }
  if (
    value.target_prepared_last_transition_id !== undefined &&
    value.target_prepared_last_transition_id !== value.transfer_id
  ) {
    throw new Error(
      "deferred transfer provisional target must be fenced by its transfer id"
    );
  }
  assertSha256(value.request_hash, "deferred transfer request_hash");
  if (!isPositiveSafeInteger(value.dispatcher_pid)) {
    throw new Error("deferred transfer dispatcher_pid must be positive");
  }
  assertTimestamp(value.prepared_at, "deferred transfer prepared_at");
  for (const field of [
    "source_reserved_at",
    "target_prepared_at",
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "agent_accepted_at",
    "committed_at",
    "resolved_at",
    "aborted_at",
    "terminal_input_not_started_at",
    "abort_cleanup_completed_at",
    "uncertain_at",
    "recovered_at"
  ] as const) {
    assertOptionalTimestamp(value[field], `deferred transfer ${field}`);
  }
  assertOptionalNonEmptyString(value.message_id, "deferred transfer message_id");
  assertOptionalNonEmptyString(value.turn_id, "deferred transfer turn_id");
  if (value.state_path !== undefined) {
    assertAbsolutePath(value.state_path, "deferred transfer state_path");
  }
  assertOptionalNonEmptyString(value.error, "deferred transfer error");
  if (value.do_not_retry !== undefined && typeof value.do_not_retry !== "boolean") {
    throw new Error("deferred transfer do_not_retry must be boolean");
  }

  const requiresTargetPrepared = [
    "target_prepared",
    "dispatch_started",
    "committed",
    "resolved",
    "uncertain"
  ].includes(String(value.status));
  const targetPreparedFields = [
    value.target_prepared_at,
    value.target_prepared_revision,
    value.target_prepared_status,
    value.target_prepared_last_transition_id,
    value.target_prepared_binding_token,
    value.target_before_binding,
    value.message_id,
    value.turn_id,
    value.state_path
  ];
  const hasAnyTargetPreparedField = targetPreparedFields.some(
    (field) => field !== undefined
  );
  const hasAllTargetPreparedFields = targetPreparedFields.every(
    (field) => field !== undefined
  );
  if (
    hasAnyTargetPreparedField !== hasAllTargetPreparedFields ||
    (requiresTargetPrepared && !hasAllTargetPreparedFields)
  ) {
    throw new Error(
      `${String(value.status)} deferred transfer requires its target/Turn identity`
    );
  }
  if (hasAllTargetPreparedFields) {
    if (
      !value.source_reserved_at ||
      value.target_prepared_revision !== 1 ||
      value.target_prepared_status !== "transitioning" ||
      value.target_prepared_last_transition_id !== value.transfer_id
    ) {
      throw new Error(
        "deferred transfer provisional target requires exact create-only fence evidence"
      );
    }
  }
  if (
    [
      "source_reserved",
      "target_prepared",
      "dispatch_started",
      "committed",
      "resolved",
      "uncertain"
    ]
      .includes(String(value.status)) &&
    !value.source_reserved_at
  ) {
    throw new Error(
      `${String(value.status)} deferred transfer requires source_reserved_at`
    );
  }
  if (
    value.status === "prepared" &&
    (value.source_reserved_at !== undefined || hasAnyTargetPreparedField)
  ) {
    throw new Error("prepared deferred transfer cannot carry reservation evidence");
  }
  if (value.status === "source_reserved" && hasAnyTargetPreparedField) {
    throw new Error(
      "source_reserved deferred transfer cannot carry target evidence"
    );
  }
  if (
    ["dispatch_started", "committed", "resolved", "uncertain"].includes(
      String(value.status)
    ) &&
    (!value.dispatch_started_at || value.input_stage === "none")
  ) {
    throw new Error(
      `${String(value.status)} deferred transfer requires dispatch-start evidence`
    );
  }
  assertInputStageEvidence(value as unknown as DeferredForegroundTransfer);
  if (
    [
      "prepared",
      "source_reserved",
      "target_prepared"
    ].includes(
      String(value.status)
    ) &&
    value.input_stage !== "none"
  ) {
    throw new Error(
      `${String(value.status)} deferred transfer cannot carry input evidence`
    );
  }
  const provedTerminalInputNotStarted =
    ["aborted", "abort_resolved"].includes(String(value.status)) &&
    value.input_stage === "dispatch_started" &&
    value.terminal_input_not_started_at !== undefined;
  if (
    ["aborted", "abort_resolved"].includes(String(value.status)) &&
    value.input_stage !== "none" &&
    !provedTerminalInputNotStarted
  ) {
    throw new Error(
      `${String(value.status)} deferred transfer requires exact no-input proof`
    );
  }
  assertTimestampOrder(value as unknown as DeferredForegroundTransfer);

  const committed = ["committed", "resolved"].includes(String(value.status));
  const committedFields = [
    value.target_native_thread_id,
    value.target_accepted_revision,
    value.target_accepted_status,
    value.target_accepted_binding_token,
    value.target_accepted_binding,
    value.source_pre_retirement_revision,
    value.source_pre_retirement_status,
    value.source_pre_retirement_binding_token,
    value.source_pre_retirement_binding,
    value.source_retirement,
    value.committed_at
  ];
  const hasAnyCommittedField = committedFields.some(
    (field) => field !== undefined
  );
  const hasAllCommittedFields = committedFields.every(
    (field) => field !== undefined
  );
  if (
    committed
      ? !hasAllCommittedFields ||
        value.input_stage !== "agent_accepted" ||
        !value.agent_accepted_at
      : hasAnyCommittedField
  ) {
    throw new Error(
      "deferred transfer target identity is allowed only on a fully accepted commit"
    );
  }
  if (committed) {
    if (
      !isPositiveSafeInteger(value.target_accepted_revision) ||
      value.target_accepted_revision !==
        Number(value.target_prepared_revision) + 1 ||
      value.target_accepted_status !== "transitioning" ||
      !isPositiveSafeInteger(value.source_pre_retirement_revision) ||
      value.source_pre_retirement_revision !==
        value.source_expected_revision + (
          value.source_retirement === "binding_scrubbed_same_native_thread"
            ? 2
            : 1
        ) ||
      value.source_pre_retirement_status !== "transitioning" ||
      !isExactNativeThreadId(value.target_native_thread_id)
    ) {
      throw new Error(
        "deferred transfer commit lacks exact transitioning Session evidence"
      );
    }
    assertSha256(
      value.target_accepted_binding_token,
      "deferred transfer target accepted binding token"
    );
    assertSha256(
      value.source_pre_retirement_binding_token,
      "deferred transfer source pre-retirement binding token"
    );
    assertBinding(
      value.target_accepted_binding,
      "deferred transfer target accepted binding"
    );
    assertBinding(
      value.source_pre_retirement_binding,
      "deferred transfer source pre-retirement binding"
    );
    if (
      value.target_accepted_binding.native_thread_id !==
        value.target_native_thread_id ||
      value.target_accepted_binding.terminal_id !== value.terminal_id ||
      value.target_accepted_binding.native_process.pid !== value.process_pid ||
      value.target_accepted_binding.native_process.process_uuid !==
        value.process_uuid ||
      value.target_accepted_binding.native_process.process_birth !==
        value.process_birth ||
      JSON.stringify(value.target_accepted_binding.terminal_endpoint) !==
        JSON.stringify(value.terminal_endpoint) ||
      !bindingIsMonotonicTargetRefinement(
        value.target_before_binding as ManagedTerminalBinding,
        value.target_accepted_binding
      ) ||
      managedSessionBindingToken({
        session_id: value.target_session_id,
        status: "transitioning",
        binding: value.target_accepted_binding
      }) !== value.target_accepted_binding_token ||
      (
        value.target_native_thread_id ===
          value.source_before_binding.native_thread_id
          ? value.source_retirement !==
              "binding_scrubbed_same_native_thread" ||
            !bindingIsScrubbedSourceReplacement(
              value.source_before_binding,
              value.source_pre_retirement_binding
            )
          : value.source_retirement !== "binding_retained"
            || JSON.stringify(value.source_pre_retirement_binding) !==
              JSON.stringify(value.source_before_binding)
      ) ||
      managedSessionBindingToken({
        session_id: value.source_session_id,
        status: "transitioning",
        binding: value.source_pre_retirement_binding
      }) !== value.source_pre_retirement_binding_token
    ) {
      throw new Error(
        "deferred transfer binding disagrees with committed authority"
      );
    }
  }
  const resolvedFields = [
    value.target_after_revision,
    value.target_after_status,
    value.target_after_binding_token,
    value.source_after_revision,
    value.source_after_binding,
    value.source_after_binding_token,
    value.source_after_status,
    value.resolved_at
  ];
  const hasAnyResolvedField = resolvedFields.some(
    (field) => field !== undefined
  );
  const hasAllResolvedFields = resolvedFields.every(
    (field) => field !== undefined
  );
  if (
    value.status === "resolved"
      ? !hasAllResolvedFields
      : hasAnyResolvedField
  ) {
    throw new Error(
      "resolved deferred transfer requires exact final Session evidence"
    );
  }
  if (value.status === "resolved") {
    if (
      !isPositiveSafeInteger(value.target_after_revision) ||
      value.target_after_revision !==
        Number(value.target_accepted_revision) + 1 ||
      value.target_after_status !== "bound" ||
      !isPositiveSafeInteger(value.source_after_revision) ||
      value.source_after_revision !==
        Number(value.source_pre_retirement_revision) + 1 ||
      value.source_after_status !== "detached" ||
      JSON.stringify(value.source_after_binding) !==
        JSON.stringify(value.source_pre_retirement_binding)
    ) {
      throw new Error(
        "resolved deferred transfer revision/status evidence is invalid"
      );
    }
    assertBinding(
      value.source_after_binding,
      "deferred transfer retired source binding"
    );
    assertSha256(
      value.target_after_binding_token,
      "deferred transfer target final binding token"
    );
    assertSha256(
      value.source_after_binding_token,
      "deferred transfer retired source binding token"
    );
    if (
      managedSessionBindingToken({
        session_id: value.target_session_id,
        status: "bound",
        binding: value.target_accepted_binding
      }) !== value.target_after_binding_token ||
      managedSessionBindingToken({
        session_id: value.source_session_id,
        status: "detached",
        binding: value.source_after_binding
      }) !== value.source_after_binding_token
    ) {
      throw new Error(
        "resolved deferred transfer final binding tokens are inconsistent"
      );
    }
  }
  if (
    ["aborted", "abort_resolved"].includes(String(value.status))
      ? !value.aborted_at || !(
          value.input_stage === "none" || provedTerminalInputNotStarted
        )
      : value.aborted_at !== undefined
  ) {
    throw new Error(
      "only a proven zero-input deferred transfer can carry an aborted receipt"
    );
  }
  if (
    value.terminal_input_not_started_at !== undefined
      ? !provedTerminalInputNotStarted ||
        value.text_injected_at !== undefined ||
        value.enter_dispatched_at !== undefined ||
        value.agent_accepted_at !== undefined
      : value.input_stage === "dispatch_started" &&
        ["aborted", "abort_resolved"].includes(String(value.status))
  ) {
    throw new Error(
      "terminal-input-not-started proof must fence only a dispatch intent"
    );
  }
  const abortCleanupSourceFields = [
    value.abort_cleanup_completed_at,
    value.abort_source_after_revision,
    value.abort_source_after_status,
    value.abort_source_after_binding_token,
    value.abort_source_after_binding,
    value.abort_target_after_status
  ];
  const abortCleanupTargetFields = [
    value.abort_target_after_revision,
    value.abort_target_after_binding_token,
    value.abort_target_after_binding
  ];
  const hasAnyAbortCleanupField = [
    ...abortCleanupSourceFields,
    ...abortCleanupTargetFields
  ].some((field) => field !== undefined);
  if (value.status === "abort_resolved") {
    if (abortCleanupSourceFields.some((field) => field === undefined)) {
      throw new Error(
        "resolved deferred abort requires exact source cleanup evidence"
      );
    }
    const allowedSourceRevisions = value.source_reserved_at
      ? [value.source_expected_revision + 2]
      : [
          value.source_expected_revision,
          // The source reservation is the first Store mutation. A crash after
          // that Session CAS but before source_reserved_at is published leaves
          // the prepared transfer able to prove the exact +2 restore receipt.
          value.source_expected_revision + 2
        ];
    if (
      !isPositiveSafeInteger(value.abort_source_after_revision) ||
      !allowedSourceRevisions.includes(value.abort_source_after_revision) ||
      value.abort_source_after_status !== "bound" ||
      JSON.stringify(value.abort_source_after_binding) !==
        JSON.stringify(value.source_before_binding)
    ) {
      throw new Error(
        "resolved deferred abort source cleanup evidence is invalid"
      );
    }
    assertSha256(
      value.abort_source_after_binding_token,
      "resolved deferred abort source binding token"
    );
    assertBinding(
      value.abort_source_after_binding,
      "resolved deferred abort source binding"
    );
    if (
      managedSessionBindingToken({
        session_id: value.source_session_id,
        status: "bound",
        binding: value.abort_source_after_binding
      }) !== value.abort_source_after_binding_token
    ) {
      throw new Error(
        "resolved deferred abort source binding token is inconsistent"
      );
    }
    if (value.abort_target_after_status === "absent") {
      if (abortCleanupTargetFields.some((field) => field !== undefined)) {
        throw new Error(
          "absent deferred abort target cannot carry Session cleanup evidence"
        );
      }
    } else if (value.abort_target_after_status === "detached") {
      if (
        abortCleanupTargetFields.some((field) => field === undefined) ||
        !value.target_before_binding ||
        !isPositiveSafeInteger(value.abort_target_after_revision) ||
        value.abort_target_after_revision !==
          Number(value.target_prepared_revision) + 1 ||
        JSON.stringify(value.abort_target_after_binding) !==
          JSON.stringify(value.target_before_binding)
      ) {
        throw new Error(
          "resolved deferred abort target cleanup evidence is invalid"
        );
      }
      assertSha256(
        value.abort_target_after_binding_token,
        "resolved deferred abort target binding token"
      );
      assertBinding(
        value.abort_target_after_binding,
        "resolved deferred abort target binding"
      );
      if (
        managedSessionBindingToken({
          session_id: value.target_session_id,
          status: "detached",
          binding: value.abort_target_after_binding
        }) !== value.abort_target_after_binding_token
      ) {
        throw new Error(
          "resolved deferred abort target binding token is inconsistent"
        );
      }
    }
  } else if (hasAnyAbortCleanupField) {
    throw new Error(
      "abort cleanup evidence is allowed only on an abort_resolved receipt"
    );
  }
  if (
    value.status === "uncertain"
      ? !value.uncertain_at || value.do_not_retry !== true ||
        value.input_stage === "none"
      : ["committed", "resolved"].includes(String(value.status)) &&
          value.uncertain_at !== undefined
        ? !value.recovered_at || value.do_not_retry !== true
        : value.uncertain_at !== undefined ||
          value.recovered_at !== undefined ||
          value.do_not_retry !== undefined
  ) {
    throw new Error(
      "uncertain deferred transfer requires possible input and do_not_retry=true"
    );
  }
  if (
    value.error !== undefined &&
    ![
      "aborted",
      "abort_resolved",
      "uncertain",
      ...(value.recovered_at ? ["committed", "resolved"] : [])
    ].includes(String(value.status))
  ) {
    throw new Error(
      "deferred transfer error is allowed only on failure/recovery receipts"
    );
  }
}

export function saveDeferredForegroundTransfer(
  storeDir: string,
  value: DeferredForegroundTransfer,
  options: DeferredForegroundTransferSaveOptions
): DeferredForegroundTransfer {
  assertDeferredForegroundTransfer(value, undefined, {
    allowMissingRevision: true
  });
  assertExpectedRevision(options?.expectedRevision);
  const paths = pathsForDeferredForegroundTransfer(value.transfer_id, storeDir);
  return withStoreWriterLease(storeDir, () => {
    const current = tryLoadDeferredForegroundTransfer(
      storeDir,
      value.transfer_id
    );
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== options.expectedRevision) {
      throw new DeferredForegroundTransferConflictError(
        value.transfer_id,
        options.expectedRevision,
        actualRevision
      );
    }
    if (
      value.revision !== undefined &&
      value.revision !== (options.expectedRevision ?? 1)
    ) {
      throw new DeferredForegroundTransferConflictError(
        value.transfer_id,
        options.expectedRevision,
        actualRevision,
        `candidate carries revision ${value.revision}`
      );
    }
    if (current) {
      assertTransferAdvance(current, value);
    } else if (value.status !== "prepared" || value.input_stage !== "none") {
      throw new Error(
        "a deferred foreground transfer must be created as zero-input prepared"
      );
    }
    const next: DeferredForegroundTransfer = {
      ...value,
      revision: (actualRevision ?? 0) + 1
    };
    assertDeferredForegroundTransfer(next);
    atomicSaveJson(paths.statePath, next);
    return next;
  });
}

export function loadDeferredForegroundTransfer(
  storeDir: string,
  transferId: string
): DeferredForegroundTransfer {
  assertStoreReadable(storeDir);
  const paths = pathsForDeferredForegroundTransfer(transferId, storeDir);
  const parsed = readJsonFile(paths.statePath, "deferred foreground transfer");
  assertDeferredForegroundTransfer(parsed, transferId);
  return parsed;
}

export function tryLoadDeferredForegroundTransfer(
  storeDir: string,
  transferId: string
): DeferredForegroundTransfer | undefined {
  try {
    return loadDeferredForegroundTransfer(storeDir, transferId);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function listDeferredForegroundTransfers(
  storeDir: string
): DeferredForegroundTransfer[] {
  if (!fs.existsSync(storeDir)) {
    return [];
  }
  assertStoreReadable(storeDir);
  const root = deferredForegroundTransfersDir(storeDir);
  if (!fs.existsSync(root)) {
    return [];
  }
  assertRealDirectory(root, "deferred foreground transfer root");
  return fs.readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        throw new Error(
          "deferred foreground transfer root may contain only real record " +
          `directories: ${entry.name}`
        );
      }
      return loadDeferredForegroundTransfer(storeDir, entry.name);
    })
    .sort((left, right) => left.transfer_id.localeCompare(right.transfer_id));
}

function assertTransferAdvance(
  current: DeferredForegroundTransfer,
  candidate: DeferredForegroundTransfer
): void {
  const immutable = [
    "schema",
    "version",
    "transfer_id",
    "terminal_id",
    "terminal_endpoint",
    "process_pid",
    "process_uuid",
    "process_birth",
    "workspace",
    "source_session_id",
    "source_expected_revision",
    "source_binding_token",
    "source_previous_last_transition_id",
    "source_before_binding",
    "source_kind",
    "source_turn_history",
    "source_rollout_authority",
    "source_abandonment_fingerprint",
    "target_session_id",
    "target_expected_revision",
    "previous_dispatch_status",
    "previous_dispatch_fingerprint",
    "request_hash",
    "dispatcher_pid",
    "prepared_at"
  ] as const;
  const changed = immutable.find((field) =>
    JSON.stringify(current[field]) !== JSON.stringify(candidate[field])
  );
  if (changed) {
    throw new Error(
      `deferred foreground transfer ${current.transfer_id} cannot change ` +
      `immutable ${changed}`
    );
  }
  const allowed: Record<
    DeferredForegroundTransferStatus,
    readonly DeferredForegroundTransferStatus[]
  > = {
    prepared: ["source_reserved", "aborted"],
    source_reserved: ["target_prepared", "aborted"],
    target_prepared: ["dispatch_started", "uncertain", "aborted"],
    dispatch_started: [
      "dispatch_started",
      "committed",
      "uncertain",
      "aborted"
    ],
    committed: ["resolved"],
    resolved: [],
    aborted: ["abort_resolved"],
    abort_resolved: [],
    uncertain: ["committed"]
  };
  if (!allowed[current.status].includes(candidate.status)) {
    throw new Error(
      `deferred foreground transfer cannot move from ${current.status} to ` +
      candidate.status
    );
  }
  if (
    INPUT_STAGE_RANK[candidate.input_stage] <
      INPUT_STAGE_RANK[current.input_stage]
  ) {
    throw new Error("deferred foreground transfer input proof cannot regress");
  }
  for (const field of [
    "target_prepared_revision",
    "target_prepared_status",
    "target_prepared_last_transition_id",
    "target_prepared_binding_token",
    "target_before_binding",
    "message_id",
    "turn_id",
    "state_path"
  ] as const) {
    if (
      current[field] !== undefined &&
      JSON.stringify(current[field]) !== JSON.stringify(candidate[field])
    ) {
      throw new Error(
        `deferred foreground transfer ${current.transfer_id} cannot change ${field}`
      );
    }
  }
  for (const field of [
    "source_reserved_at",
    "target_prepared_at",
    "dispatch_started_at",
    "text_injected_at",
    "enter_dispatched_at",
    "agent_accepted_at",
    "target_native_thread_id",
    "target_accepted_revision",
    "target_accepted_status",
    "target_accepted_binding_token",
    "target_accepted_binding",
    "source_pre_retirement_revision",
    "source_pre_retirement_status",
    "source_pre_retirement_binding_token",
    "source_pre_retirement_binding",
    "source_retirement",
    "committed_at",
    "target_after_revision",
    "target_after_status",
    "target_after_binding_token",
    "source_after_revision",
    "source_after_binding",
    "source_after_binding_token",
    "source_after_status",
    "resolved_at",
    "aborted_at",
    "terminal_input_not_started_at",
    "abort_cleanup_completed_at",
    "abort_source_after_revision",
    "abort_source_after_status",
    "abort_source_after_binding_token",
    "abort_source_after_binding",
    "abort_target_after_status",
    "abort_target_after_revision",
    "abort_target_after_binding_token",
    "abort_target_after_binding",
    "uncertain_at",
    "recovered_at",
    "error",
    "do_not_retry"
  ] as const) {
    if (
      current[field] !== undefined &&
      JSON.stringify(current[field]) !== JSON.stringify(candidate[field])
    ) {
      throw new Error(
        `deferred foreground transfer ${current.transfer_id} cannot change ${field}`
      );
    }
  }
  if (
    candidate.status === "aborted" &&
    current.input_stage !== "none" &&
    !(
      current.input_stage === "dispatch_started" &&
      candidate.input_stage === "dispatch_started" &&
      candidate.terminal_input_not_started_at !== undefined
    )
  ) {
    throw new Error("deferred foreground transfer cannot abort after input may start");
  }
}

function bindingIsMonotonicTargetRefinement(
  before: ManagedTerminalBinding,
  after: ManagedTerminalBinding
): boolean {
  return before.binding_id === after.binding_id &&
    before.generation === after.generation &&
    before.terminal_id === after.terminal_id &&
    JSON.stringify(before.terminal_control) ===
      JSON.stringify(after.terminal_control) &&
    JSON.stringify(before.terminal_endpoint) ===
      JSON.stringify(after.terminal_endpoint) &&
    before.native_process.pid === after.native_process.pid &&
    before.native_process.process_uuid === after.native_process.process_uuid &&
    before.native_process.process_birth === after.native_process.process_birth &&
    before.bound_at === after.bound_at &&
    before.native_thread_id === undefined &&
    before.native_process.rollout === undefined &&
    isExactNativeThreadId(after.native_thread_id) &&
    after.native_process.rollout !== undefined;
}

function bindingIsScrubbedSourceReplacement(
  before: ManagedTerminalBinding,
  after: ManagedTerminalBinding
): boolean {
  return before.binding_id !== after.binding_id &&
    after.generation === before.generation + 1 &&
    before.terminal_id === after.terminal_id &&
    JSON.stringify(before.terminal_control) ===
      JSON.stringify(after.terminal_control) &&
    JSON.stringify(before.terminal_endpoint) ===
      JSON.stringify(after.terminal_endpoint) &&
    before.native_process.pid === after.native_process.pid &&
    before.native_process.process_uuid === after.native_process.process_uuid &&
    before.native_process.process_birth === after.native_process.process_birth &&
    after.native_thread_id === undefined &&
    after.native_process.rollout === undefined;
}

function assertInputStageEvidence(value: DeferredForegroundTransfer): void {
  const stage = INPUT_STAGE_RANK[value.input_stage];
  for (const [field, minimum] of [
    ["dispatch_started_at", 1],
    ["text_injected_at", 2],
    ["enter_dispatched_at", 3],
    ["agent_accepted_at", 4]
  ] as const) {
    if ((value[field] !== undefined) !== (stage >= minimum)) {
      throw new Error(
        `deferred transfer ${value.input_stage} has inconsistent ${field}`
      );
    }
  }
}

function assertTimestampOrder(value: DeferredForegroundTransfer): void {
  const inputTimeline = [
    value.prepared_at,
    value.source_reserved_at,
    value.target_prepared_at,
    value.dispatch_started_at,
    value.text_injected_at,
    value.enter_dispatched_at,
    value.agent_accepted_at
  ].filter((candidate): candidate is string => candidate !== undefined);
  assertMonotonicTimestamps(inputTimeline);
  const latestInputEvidence = inputTimeline[inputTimeline.length - 1];
  if (value.aborted_at) {
    assertTimestampNotBefore(value.aborted_at, latestInputEvidence);
  }
  if (value.terminal_input_not_started_at) {
    assertTimestampNotBefore(
      value.terminal_input_not_started_at,
      value.dispatch_started_at
    );
    assertTimestampNotBefore(
      value.aborted_at,
      value.terminal_input_not_started_at
    );
  }
  if (value.abort_cleanup_completed_at) {
    assertTimestampNotBefore(
      value.abort_cleanup_completed_at,
      value.aborted_at
    );
  }
  if (value.uncertain_at) {
    // Recovery may prove acceptance after uncertainty was recorded, so the
    // uncertainty timestamp is ordered after the evidence known at its own
    // stage, not unconditionally after a later agent_accepted_at.
    const latestPossibleDispatch = value.enter_dispatched_at ??
      value.text_injected_at ?? value.dispatch_started_at ??
      value.target_prepared_at ?? value.source_reserved_at ?? value.prepared_at;
    assertTimestampNotBefore(value.uncertain_at, latestPossibleDispatch);
    if (value.status === "uncertain" && value.input_stage === "agent_accepted") {
      assertTimestampNotBefore(value.uncertain_at, value.agent_accepted_at);
    }
  }
  if (value.committed_at) {
    assertTimestampNotBefore(value.committed_at, value.agent_accepted_at);
    assertTimestampNotBefore(value.committed_at, value.uncertain_at);
  }
  if (value.recovered_at) {
    assertTimestampNotBefore(value.recovered_at, value.uncertain_at);
    assertTimestampNotBefore(value.recovered_at, value.committed_at);
  }
  if (value.resolved_at) {
    assertTimestampNotBefore(value.resolved_at, value.committed_at);
    assertTimestampNotBefore(value.resolved_at, value.recovered_at);
  }
}

function assertMonotonicTimestamps(values: readonly string[]): void {
  for (let index = 1; index < values.length; index += 1) {
    assertTimestampNotBefore(values[index], values[index - 1]);
  }
}

function assertTimestampNotBefore(
  candidate: string | undefined,
  boundary: string | undefined
): void {
  if (
    candidate !== undefined &&
    boundary !== undefined &&
    Date.parse(candidate) < Date.parse(boundary)
  ) {
    throw new Error("deferred foreground transfer timestamps must be monotonic");
  }
}

function assertBinding(value: unknown, label: string): void {
  const now = new Date().toISOString();
  assertManagedSessionState({
    schema: "agent-knock-knock/session",
    version: 1,
    session_id: "session-deferred-binding-validation",
    revision: 1,
    agent: "codex",
    workspace: "/deferred-binding-validation",
    status: "bound",
    binding: value,
    lineage: { created_by: "attach" },
    created_at: now,
    updated_at: now
  });
}

function atomicSaveJson(filePath: string, value: unknown): void {
  atomicSaveJsonFile(filePath, value, {
    rootLabel: "deferred foreground transfer root",
    directoryLabel: "deferred foreground transfer directory",
    fileLabel: "deferred foreground transfer state",
    ensureDirectory: ensureDir
  });
}

function readJsonFile(filePath: string, label: string): unknown {
  return readJsonFileNoFollow(filePath, label);
}

function assertExpectedRevision(value: unknown): asserts value is number | null {
  if (value !== null && !isPositiveSafeInteger(value)) {
    throw new Error("expectedRevision must be null or a positive safe integer");
  }
}

function assertRecordId(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("\0") ||
    path.posix.basename(value) !== value ||
    path.win32.basename(value) !== value ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${label} is not safe for storage: ${String(value)}`);
  }
}

function isSafeRecordId(value: unknown): value is string {
  try {
    assertRecordId(value, "record id");
    return true;
  } catch {
    return false;
  }
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertContained(candidate: string, root: string, label: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes its Store root`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string
): void {
  const known = new Set(allowed);
  const unsupported = Object.keys(value).find((key) => !known.has(key));
  if (unsupported !== undefined) {
    throw new Error(`${label} contains unsupported field ${unsupported}`);
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalNonEmptyString(value: unknown, label: string): void {
  if (value !== undefined) {
    assertNonEmptyString(value, label);
  }
}

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (!path.isAbsolute(value)) {
    throw new Error(`${label} must be absolute`);
  }
}

function assertSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be SHA-256 hex`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string): void {
  if (value !== undefined) {
    assertTimestamp(value, label);
  }
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const TRANSFER_STATUSES = new Set<DeferredForegroundTransferStatus>([
  "prepared",
  "source_reserved",
  "target_prepared",
  "dispatch_started",
  "committed",
  "resolved",
  "aborted",
  "abort_resolved",
  "uncertain"
]);

const INPUT_STAGES = new Set<DeferredForegroundTransferInputStage>([
  "none",
  "dispatch_started",
  "text_injected",
  "enter_dispatched",
  "agent_accepted"
]);

const INPUT_STAGE_RANK: Record<DeferredForegroundTransferInputStage, number> = {
  none: 0,
  dispatch_started: 1,
  text_injected: 2,
  enter_dispatched: 3,
  agent_accepted: 4
};

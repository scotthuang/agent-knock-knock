import {
  createLegacyOpenClawCallbackRoute,
  createTerminalWatchOpenClawCallbackRoute,
  parseCallbackRoute
} from "./callback-transport.js";
import path from "node:path";
import { canonicalJson } from "./canonical-json.js";
import type { ExecutorKind } from "./executors.js";
import {
  claudeTranscriptAnchorFingerprint,
  validateClaudeHumanStartedActiveTaskCheckpoint,
  validateClaudeHumanStartedActiveTaskAnchor
} from "./claude-local-transcript-provider.js";
import {
  validateCodexHumanStartedActiveTaskAnchor
} from "./terminal-submission-acceptance.js";
import {
  exactNativeThreadId,
  normalizedRolloutIdentity,
  validateCodexRolloutAcceptanceAnchor,
  validateTerminalSubmissionAcceptanceEvidence
} from "./terminal-submission-facts.js";
import {
  terminalEndpointIdentityFromEvidence,
  terminalRouteKeyFromEvidence
} from "./terminal-control-ref.js";
import {
  sameTerminalInteractionSubject,
  validateTerminalInteractionSubjectProjection,
  type TerminalInteractionSubjectProjection
} from "./terminal-interaction-protocol.js";
import {
  aggregateMatchesProjection,
  reduceTerminalInteractionAggregate,
  validateTerminalInteractionAggregate,
  type TerminalInteractionAggregate
} from "./terminal-interaction-core.js";
import {
  ABSOLUTE_PATH,
  ARRAY_VALUE,
  IGNORE_VALUE,
  NON_NEGATIVE_INTEGER,
  NULLABLE_ENDPOINT_STRING,
  POSITIVE_INTEGER,
  TERMINAL_WATCH_INTERACTION_POLICIES,
  TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTION_DESCRIPTION_CHARACTERS,
  TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTION_LABEL_CHARACTERS,
  TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTIONS,
  TERMINAL_WATCH_MANUAL_INTERACTION_MAX_PROMPT_CHARACTERS,
  TERMINAL_WATCH_MANUAL_INTERACTION_MAX_STEPS,
  TERMINAL_WATCH_MANUAL_INTERACTION_RESPONSE_KINDS,
  TERMINAL_WATCH_NOTIFICATION_KINDS,
  TERMINAL_WATCH_NOTIFICATION_STATUSES,
  TERMINAL_WATCH_SCHEMA,
  TERMINAL_WATCH_STATUSES,
  TERMINAL_WATCH_TERMINAL_STATUSES,
  TERMINAL_WATCH_VERSION,
  WARNING_LIST,
  assertAnchorFingerprint,
  assertCompletionText,
  assertNonEmptyString,
  assertRecordId,
  assertReasonCode,
  assertSha256,
  assertStrictRecord,
  assertTimestamp,
  exactUuid,
  initialTerminalWatchInteractionPolicy,
  initialTerminalWatchObservationCheckpoint,
  isTerminalActivityWatch,
  isTerminalWatchOutcomeNotification,
  isUserExplicitFallbackWatch,
  literalGuard,
  nullableGuard,
  oneOfGuard,
  optionalGuard,
  parseTerminalWatchNotificationCallbackSnapshot,
  terminalWatchCallbackEnvelope,
  terminalWatchNotificationId,
  terminalWatchNotificationIdempotencyKey,
  terminalWatchNotificationOnlyRoute,
  upgradePredecessorCallbackPresentations,
  validatedClaudeTranscriptAnchor,
  type ClaudeUserExplicitFallbackWatchAnchor,
  type CodexUserExplicitFallbackWatchAnchor,
  type CodexUserExplicitFallbackWatchObservationCheckpoint,
  type ClaudeUserExplicitFallbackWatchObservationCheckpoint,
  type FieldGuard,
  type StrictShape,
  type TerminalActivityWatchAnchor,
  type TerminalActivityWatchObservationCheckpoint,
  type TerminalWatchAnchor,
  type TerminalWatch,
  type TerminalWatchCurrentInteraction,
  type TerminalWatchManualInteractionResponseKind,
  type TerminalWatchManualInteractionSummary,
  type TerminalWatchNotification,
  type TerminalWatchNotificationStatus,
  type TerminalWatchObservationCheckpoint,
  type TerminalWatchSettlement,
  type TerminalWatchStatus,
  type TerminalWatchTerminalIdentity,
  type TerminalWatchTerminalStatus
} from "./terminal-watch-record.js";
import { isRecord } from "./value-guards.js";

const WATCH_FIELDS = {
  schema: literalGuard(TERMINAL_WATCH_SCHEMA),
  version: literalGuard(TERMINAL_WATCH_VERSION),
  watch_id: assertRecordId,
  revision: optionalGuard(POSITIVE_INTEGER),
  agent: oneOfGuard(["codex", "claude"]),
  terminal: assertTerminalIdentity,
  anchor: IGNORE_VALUE,
  observation_checkpoint: IGNORE_VALUE,
  interaction_policy: oneOfGuard(TERMINAL_WATCH_INTERACTION_POLICIES),
  current_interaction: optionalGuard(IGNORE_VALUE),
  warnings: optionalGuard(WARNING_LIST),
  callback_route: optionalGuard(IGNORE_VALUE),
  openclaw_session: assertNonEmptyString,
  openclaw_bin: assertNonEmptyString,
  created_at: assertTimestamp,
  deadline_at: assertTimestamp,
  updated_at: assertTimestamp,
  status: oneOfGuard(TERMINAL_WATCH_STATUSES),
  last_activity_at: assertTimestamp,
  settlement: IGNORE_VALUE,
  notification_outbox: ARRAY_VALUE
} satisfies StrictShape;

const TERMINAL_IDENTITY_FIELDS = {
  terminal_id: assertNonEmptyString,
  terminal_endpoint: assertTerminalEndpoint,
  workspace: ABSOLUTE_PATH,
  binding_token: assertSha256
} satisfies StrictShape;

const TERMINAL_ENDPOINT_FIELDS = {
  schema: literalGuard("agent-knock-knock/terminal-endpoint"),
  version: literalGuard(1),
  kind: IGNORE_VALUE,
  endpoint_key: IGNORE_VALUE,
  resource_key: IGNORE_VALUE,
  route_key: IGNORE_VALUE,
  process_anchor_pid: POSITIVE_INTEGER,
  target: NULLABLE_ENDPOINT_STRING,
  socket_path: NULLABLE_ENDPOINT_STRING,
  pane_pid: optionalGuard(nullableGuard(POSITIVE_INTEGER)),
  server_socket_path: NULLABLE_ENDPOINT_STRING,
  pane_id: NULLABLE_ENDPOINT_STRING,
  session_name: NULLABLE_ENDPOINT_STRING,
  session_dir: NULLABLE_ENDPOINT_STRING,
  workspace_id: NULLABLE_ENDPOINT_STRING,
  tab_id: NULLABLE_ENDPOINT_STRING,
  terminal_id: NULLABLE_ENDPOINT_STRING,
  current_path: NULLABLE_ENDPOINT_STRING
} satisfies StrictShape;

const SETTLEMENT_FIELDS = {
  kind: oneOfGuard(TERMINAL_WATCH_TERMINAL_STATUSES),
  evidence_fingerprint: assertSha256,
  observed_at: assertTimestamp,
  reason_code: optionalGuard(assertReasonCode),
  completion_text: optionalGuard(assertCompletionText),
  completion_id: optionalGuard(assertNonEmptyString),
  completion_timestamp: optionalGuard(assertTimestamp)
} satisfies StrictShape;

const NOTIFICATION_RECEIPT_FIELDS = {
  last_attempt_at: optionalGuard(assertTimestamp),
  attempt_id: optionalGuard(assertNonEmptyString),
  attempt_lease_expires_at: optionalGuard(assertTimestamp),
  failed_at: optionalGuard(assertTimestamp),
  next_attempt_at: optionalGuard(assertTimestamp),
  last_error_code: optionalGuard(assertReasonCode),
  delivered_at: optionalGuard(assertTimestamp),
  superseded_at: optionalGuard(assertTimestamp)
} satisfies StrictShape;

const NOTIFICATION_FIELDS = {
  notification_id: assertNonEmptyString,
  idempotency_key: assertNonEmptyString,
  kind: oneOfGuard(TERMINAL_WATCH_NOTIFICATION_KINDS),
  evidence_fingerprint: assertSha256,
  reason_code: optionalGuard(assertReasonCode),
  manual_interaction: optionalGuard(IGNORE_VALUE),
  callback_route: IGNORE_VALUE,
  callback_envelope: IGNORE_VALUE,
  status: oneOfGuard(TERMINAL_WATCH_NOTIFICATION_STATUSES),
  attempts: NON_NEGATIVE_INTEGER,
  created_at: assertTimestamp,
  ...NOTIFICATION_RECEIPT_FIELDS
} satisfies StrictShape;

type NotificationReceiptField = keyof typeof NOTIFICATION_RECEIPT_FIELDS;
const NOTIFICATION_SHAPES = {
  pending: [0, []],
  delivering: [1, [
    "last_attempt_at",
    "attempt_id",
    "attempt_lease_expires_at"
  ]],
  failed: [1, [
    "last_attempt_at",
    "failed_at",
    "next_attempt_at",
    "last_error_code"
  ]],
  delivered: [1, ["last_attempt_at", "delivered_at"]],
  superseded: [0, ["superseded_at"]]
} as const satisfies Record<
  TerminalWatchNotificationStatus,
  readonly [number, readonly NotificationReceiptField[]]
>;

export function assertTerminalWatch(
  value: unknown,
  expectedWatchId?: string,
  options: { allowMissingRevision?: boolean } = {}
): asserts value is TerminalWatch {
  assertTerminalWatchRecord(value, expectedWatchId, options);
}

function assertTerminalWatchRecord(
  value: unknown,
  expectedWatchId: string | undefined,
  options: {
    allowMissingRevision?: boolean;
    allowPredecessorCallbackPresentation?: boolean;
  }
): asserts value is TerminalWatch {
  assertStrictRecord(value, "terminal Watch", WATCH_FIELDS);
  if (expectedWatchId !== undefined && value.watch_id !== expectedWatchId) {
    throw new Error(
      `terminal Watch id ${String(value.watch_id)} does not match ${expectedWatchId}`
    );
  }
  if (value.revision === undefined && !options.allowMissingRevision) {
    throw new Error("terminal Watch revision must be a positive safe integer");
  }
  const watch = value as unknown as TerminalWatch;
  assertTerminalWatchAnchor(
    watch.anchor,
    watch.agent,
    watch.terminal
  );
  assertTerminalWatchObservationCheckpoint(
    watch.observation_checkpoint,
    watch.anchor
  );
  if (
    isTerminalActivityWatch(watch) &&
    watch.interaction_policy !== "notify_only"
  ) {
    throw new Error(
      "a terminal activity Watch must remain interaction notify-only"
    );
  }
  assertTerminalWatchCurrentInteraction(watch.current_interaction, watch);
  const checkpoint = watch.observation_checkpoint;
  if (
    isTerminalActivityWatch(watch) &&
    "schema" in checkpoint &&
    checkpoint.schema ===
      "agent-knock-knock/terminal-activity-watch-checkpoint" &&
    watch.status === "active" &&
    checkpoint.consecutive_idle_observations > 1
  ) {
    throw new Error(
      "an active terminal activity Watch cannot already carry stable-idle settlement evidence"
    );
  }
  if (watch.callback_route !== undefined) {
    const route = parseCallbackRoute(watch.callback_route);
    if (route.controller_session_id !== watch.openclaw_session) {
      throw new Error(
        "terminal Watch callback route does not match its controller session"
      );
    }
  }
  const minimumCheckpointOffset = watch.anchor.schema ===
      "agent-knock-knock/terminal-activity-watch-anchor"
    ? 0
    : watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
      ? watch.anchor.turn_start_offset_bytes
      : watch.anchor.schema ===
          "agent-knock-knock/codex-human-started-active-task-anchor"
        ? watch.anchor.observed_end_offset_bytes
        : watch.anchor.schema ===
            "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
          ? watch.anchor.transcript_anchor.offset_bytes
          : watch.anchor.acceptance_anchor.offset_bytes;
  if (
    watch.observation_checkpoint.safe_resume_offset_bytes <
      minimumCheckpointOffset
  ) {
    throw new Error(
      "terminal Watch observation checkpoint cannot predate its task anchor"
    );
  }
  if (
    Date.parse(watch.deadline_at) <= Date.parse(watch.created_at) ||
    Date.parse(watch.updated_at) < Date.parse(watch.created_at) ||
    Date.parse(watch.last_activity_at) > Date.parse(watch.updated_at)
  ) {
    throw new Error("terminal Watch timestamps are not monotonic");
  }
  const processStartedAt = watch.anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
      ? watch.anchor.agent_started_at_ms
      : watch.anchor.schema ===
          "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
        ? watch.anchor.transcript_anchor.agent_started_at_ms
        : undefined;
  if (
    Date.parse(watch.anchor.captured_at) > Date.parse(watch.created_at) ||
    (
      processStartedAt !== undefined &&
      processStartedAt > Date.parse(watch.created_at)
    )
  ) {
    throw new Error("terminal Watch cannot predate its exact observation anchor");
  }
  assertSettlement(watch.settlement, watch.status);
  if (
    watch.settlement &&
    (
      Date.parse(watch.settlement.observed_at) > Date.parse(watch.updated_at) ||
      (
        watch.settlement.completion_timestamp !== undefined &&
        Date.parse(watch.settlement.completion_timestamp) >
          Date.parse(watch.updated_at)
      )
    )
  ) {
    throw new Error("terminal Watch settlement cannot be newer than its state");
  }
  assertNotificationOutbox(
    watch,
    options.allowPredecessorCallbackPresentation === true
  );
}


export function decodeTerminalWatch(
  value: unknown,
  expectedWatchId: string
): TerminalWatch {
  const sourceVersion = isRecord(value) ? value.version : undefined;
  const normalized = normalizeLegacyTerminalWatch(value);
  const predecessorPresentation = sourceVersion === 1 || sourceVersion === 2;
  assertTerminalWatchRecord(normalized, expectedWatchId, {
    allowPredecessorCallbackPresentation: predecessorPresentation
  });
  const presentationUpgraded = predecessorPresentation
    ? upgradePredecessorCallbackPresentations(normalized)
    : normalized;
  assertTerminalWatch(presentationUpgraded, expectedWatchId);
  const repaired = sourceVersion === 2 ||
      sourceVersion === TERMINAL_WATCH_VERSION
    ? repairMisroutedUserExplicitFallbackCallback(presentationUpgraded)
    : presentationUpgraded;
  assertTerminalWatch(repaired, expectedWatchId);
  return repaired;
}

const MISROUTED_FALLBACK_CALLBACK_ERROR =
  "callback_permanent_openclaw_callback_profile_changed";
const REPAIRED_FALLBACK_CALLBACK_ERROR =
  "callback_route_repaired_after_openclaw_profile_mismatch";
const REPAIRED_FALLBACK_CALLBACK_WARNING =
  "legacy_openclaw_fallback_callback_route_repaired";

/**
 * v0.12.19-v0.12.22 accidentally snapshotted the managed Send Gateway
 * method for user-explicit fallback Watches. That profile is rejected before
 * callback I/O, so this exact shape is safe to redirect and retry with the
 * original idempotency key. Every ambiguous or side-effect-capable state is
 * left untouched.
 */
function repairMisroutedUserExplicitFallbackCallback(
  watch: TerminalWatch
): TerminalWatch {
  if (!isUserExplicitFallbackWatch(watch) || !watch.callback_route) {
    return watch;
  }
  const misrouted = createLegacyOpenClawCallbackRoute({
    controllerSessionId: watch.openclaw_session,
    gatewayMethod: "agent-knock-knock.callback",
    openclawBin: watch.openclaw_bin
  });
  if (canonicalJson(watch.callback_route) !== canonicalJson(misrouted)) {
    return watch;
  }
  for (const notification of watch.notification_outbox) {
    const hasSnapshot = notification.callback_route !== undefined;
    if (
      notification.status === "delivered" ||
      notification.status === "delivering" ||
      (
        notification.status === "failed" &&
        (
          !hasSnapshot ||
          notification.last_error_code !== MISROUTED_FALLBACK_CALLBACK_ERROR
        )
      ) ||
      (
        notification.status === "pending" &&
        hasSnapshot
      )
    ) {
      return watch;
    }
    if (
      notification.callback_route !== undefined &&
      canonicalJson(notification.callback_route) !== canonicalJson(misrouted)
    ) {
      return watch;
    }
  }

  const route = createTerminalWatchOpenClawCallbackRoute({
    controllerSessionId: watch.openclaw_session,
    openclawBin: watch.openclaw_bin
  });
  const repairedWatch: TerminalWatch = {
    ...watch,
    warnings: [...new Set([
      ...(watch.warnings ?? []),
      REPAIRED_FALLBACK_CALLBACK_WARNING
    ])],
    callback_route: route,
    notification_outbox: []
  };
  repairedWatch.notification_outbox = watch.notification_outbox.map(
    (notification) => {
      const repaired = notification.status === "failed"
        ? {
            ...notification,
            last_error_code: REPAIRED_FALLBACK_CALLBACK_ERROR
          }
        : { ...notification };
      if (notification.callback_route === undefined) return repaired;
      return {
        ...repaired,
        callback_route: route,
        callback_envelope: terminalWatchCallbackEnvelope(
          repairedWatch,
          repaired,
          route
        )
      };
    }
  );
  return repairedWatch;
}

function normalizeLegacyTerminalWatch(value: unknown): unknown {
  if (
    !isRecord(value) ||
    value.schema !== TERMINAL_WATCH_SCHEMA ||
    (
      value.version !== 1 &&
      value.version !== 2 &&
      value.version !== TERMINAL_WATCH_VERSION
    ) ||
    !isRecord(value.anchor)
  ) {
    return value;
  }
  // Response authority is never inferred while reading a predecessor record.
  // Only a newly-created v3 Watch may opt in explicitly.
  const versionNormalized = value.version === TERMINAL_WATCH_VERSION
    ? value
    : legacyTerminalWatchV3(value);
  if (value.observation_checkpoint !== undefined) {
    return versionNormalized;
  }
  const anchor = value.anchor;
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    const validated = validateClaudeHumanStartedActiveTaskAnchor(anchor);
    return {
      ...versionNormalized,
      observation_checkpoint: initialTerminalWatchObservationCheckpoint(
        validated
      )
    };
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    const validated = validateCodexHumanStartedActiveTaskAnchor(anchor);
    return {
      ...versionNormalized,
      observation_checkpoint:
        initialTerminalWatchObservationCheckpoint(validated)
    };
  }
  return versionNormalized;
}

function legacyTerminalWatchV3(
  value: Record<string, unknown>
): Record<string, unknown> {
  // Pre-v3 schemas did not define either field. Discard, rather than trust,
  // hand-added response authority or interaction state while migrating.
  const {
    interaction_policy: _legacyInteractionPolicy,
    current_interaction: _legacyCurrentInteraction,
    ...legacy
  } = value;
  return {
    ...legacy,
    version: TERMINAL_WATCH_VERSION,
    interaction_policy: "notify_only"
  };
}

export function assertTerminalWatchObservationCheckpoint(
  value: unknown,
  anchor: TerminalWatchAnchor
): asserts value is TerminalWatchObservationCheckpoint {
  if (
    anchor.schema === "agent-knock-knock/terminal-activity-watch-anchor"
  ) {
    assertStrictRecord(value, "terminal activity Watch checkpoint", {
      schema: literalGuard(
        "agent-knock-knock/terminal-activity-watch-checkpoint"
      ),
      version: literalGuard(1),
      safe_resume_offset_bytes: literalGuard(0),
      has_seen_activity: (candidate, label) => {
        if (typeof candidate !== "boolean") {
          throw new Error(`${label} must be boolean`);
        }
      },
      consecutive_idle_observations: NON_NEGATIVE_INTEGER,
      last_activity_state: oneOfGuard([
        "awaiting_approval", "working", "idle", "unknown"
      ])
    });
    const checkpoint = value as unknown as
      TerminalActivityWatchObservationCheckpoint;
    if (
      checkpoint.consecutive_idle_observations > 0 &&
      (
        !checkpoint.has_seen_activity ||
        checkpoint.last_activity_state !== "idle"
      )
    ) {
      throw new Error(
        "terminal activity Watch idle observations require prior activity and an idle state"
      );
    }
    if (
      checkpoint.last_activity_state !== "idle" &&
      checkpoint.consecutive_idle_observations !== 0
    ) {
      throw new Error(
        "terminal activity Watch non-idle checkpoint cannot retain idle observations"
      );
    }
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    validateClaudeHumanStartedActiveTaskCheckpoint(value, anchor);
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    assertCodexUserExplicitFallbackWatchCheckpoint(value, anchor);
    return;
  }
  if (
    anchor.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    assertClaudeUserExplicitFallbackWatchCheckpoint(value, anchor);
    return;
  }
  assertStrictRecord(value, "terminal Watch observation checkpoint", {
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER
  });
}

function assertCodexUserExplicitFallbackWatchCheckpoint(
  value: unknown,
  anchor: CodexUserExplicitFallbackWatchAnchor
): asserts value is CodexUserExplicitFallbackWatchObservationCheckpoint {
  assertStrictRecord(value, "Codex fallback Watch checkpoint", {
    schema: literalGuard(
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ),
    version: literalGuard(1),
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER,
    acceptance_evidence: optionalGuard(IGNORE_VALUE),
    accepted_identity: optionalGuard(IGNORE_VALUE)
  });
  const acceptanceValue = value.acceptance_evidence;
  const identityValue = value.accepted_identity;
  if ((acceptanceValue === undefined) !== (identityValue === undefined)) {
    throw new Error(
      "Codex fallback Watch checkpoint acceptance identity is incomplete"
    );
  }
  if (acceptanceValue === undefined || identityValue === undefined) {
    return;
  }
  assertStrictRecord(
    identityValue,
    "Codex fallback Watch accepted identity",
    {
      native_thread_id: assertNonEmptyString,
      process_uuid: assertNonEmptyString,
      process_birth: assertNonEmptyString,
      rollout: IGNORE_VALUE
    }
  );
  const nativeThreadId = exactNativeThreadId(
    identityValue.native_thread_id
  );
  if (!isRecord(identityValue.rollout)) {
    throw new Error("Codex fallback Watch accepted rollout is invalid");
  }
  const rollout = normalizedRolloutIdentity(identityValue.rollout);
  if (
    identityValue.native_thread_id !== nativeThreadId ||
    JSON.stringify(identityValue.rollout) !== JSON.stringify(rollout) ||
    !path.isAbsolute(rollout.path) ||
    identityValue.process_uuid !== anchor.acceptance_anchor.process_uuid ||
    identityValue.process_birth !== anchor.acceptance_anchor.process_birth
  ) {
    throw new Error(
      "Codex fallback Watch accepted identity does not match its anchor"
    );
  }
  const acceptance = validateTerminalSubmissionAcceptanceEvidence(
    acceptanceValue,
    {
      source: "codex_rollout",
      nativeThreadId,
      requestHash: anchor.request_hash
    }
  );
  if (
    acceptance.anchorFingerprint !==
      anchor.acceptance_anchor.anchor_fingerprint
  ) {
    throw new Error(
      "Codex fallback Watch acceptance evidence does not match its anchor"
    );
  }
  const observedEndOffset = acceptance.metadata?.observed_end_offset_bytes;
  if (
    typeof observedEndOffset !== "number" ||
    !Number.isSafeInteger(observedEndOffset) ||
    observedEndOffset <= anchor.acceptance_anchor.offset_bytes ||
    Number(value.safe_resume_offset_bytes) < observedEndOffset
  ) {
    throw new Error(
      "Codex fallback Watch acceptance checkpoint offset is invalid"
    );
  }
}

function assertClaudeUserExplicitFallbackWatchCheckpoint(
  value: unknown,
  anchor: ClaudeUserExplicitFallbackWatchAnchor
): asserts value is ClaudeUserExplicitFallbackWatchObservationCheckpoint {
  assertStrictRecord(value, "Claude fallback Watch checkpoint", {
    schema: literalGuard(
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint"
    ),
    version: literalGuard(1),
    safe_resume_offset_bytes: NON_NEGATIVE_INTEGER,
    acceptance_evidence: optionalGuard(IGNORE_VALUE),
    accepted_prompt_uuid: optionalGuard(IGNORE_VALUE)
  });
  const acceptanceValue = value.acceptance_evidence;
  const promptUuidValue = value.accepted_prompt_uuid;
  if ((acceptanceValue === undefined) !== (promptUuidValue === undefined)) {
    throw new Error(
      "Claude fallback Watch checkpoint acceptance identity is incomplete"
    );
  }
  if (acceptanceValue === undefined || promptUuidValue === undefined) {
    return;
  }
  const acceptedPromptUuid = exactUuid(
    promptUuidValue,
    "Claude fallback accepted prompt UUID"
  );
  const acceptance = validateTerminalSubmissionAcceptanceEvidence(
    acceptanceValue,
    {
      source: "claude_transcript",
      nativeThreadId: anchor.transcript_anchor.session_id,
      requestHash: anchor.request_hash
    }
  );
  const metadata = acceptance.metadata;
  const observedEndOffset = metadata?.observed_end_offset_bytes;
  if (
    acceptance.acceptanceId !== acceptedPromptUuid ||
    metadata?.prompt_uuid !== acceptedPromptUuid ||
    metadata?.claude_version !== anchor.claude_version ||
    metadata?.anchor_offset_bytes !== anchor.transcript_anchor.offset_bytes ||
    metadata?.agent_started_at_ms !==
      anchor.transcript_anchor.agent_started_at_ms ||
    acceptance.anchorFingerprint !==
      claudeTranscriptAnchorFingerprint(anchor.transcript_anchor) ||
    typeof observedEndOffset !== "number" ||
    !Number.isSafeInteger(observedEndOffset) ||
    observedEndOffset <= anchor.transcript_anchor.offset_bytes ||
    Number(value.safe_resume_offset_bytes) < observedEndOffset
  ) {
    throw new Error(
      "Claude fallback Watch acceptance checkpoint does not match its anchor"
    );
  }
}

function assertTerminalIdentity(
  value: unknown
): asserts value is TerminalWatchTerminalIdentity {
  assertStrictRecord(
    value,
    "terminal Watch terminal identity",
    TERMINAL_IDENTITY_FIELDS
  );
}

function assertTerminalEndpoint(value: unknown): void {
  assertStrictRecord(value, "terminal Watch endpoint", TERMINAL_ENDPOINT_FIELDS);
  if (
    !terminalEndpointIdentityFromEvidence(value) ||
    !terminalRouteKeyFromEvidence(value)
  ) {
    throw new Error("terminal Watch endpoint evidence is not exact");
  }
}

function assertTerminalWatchAnchor(
  value: unknown,
  agent: ExecutorKind,
  terminal: TerminalWatchTerminalIdentity
): asserts value is TerminalWatchAnchor {
  if (!isRecord(value)) {
    throw new Error("terminal Watch anchor must be an object");
  }
  if (
    value.schema === "agent-knock-knock/terminal-activity-watch-anchor"
  ) {
    assertStrictRecord(value, "terminal activity Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/terminal-activity-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      terminal_id: assertNonEmptyString,
      pid: POSITIVE_INTEGER,
      initial_activity_state: oneOfGuard([
        "awaiting_approval", "working", "idle", "unknown"
      ]),
      native_process_uuid: optionalGuard(assertNonEmptyString),
      native_process_birth: optionalGuard(assertNonEmptyString),
      agent_version: optionalGuard(assertNonEmptyString),
      anchor_fingerprint: assertSha256
    });
    if (value.terminal_id !== terminal.terminal_id) {
      throw new Error(
        "terminal activity Watch id does not match its terminal identity"
      );
    }
    assertAnchorFingerprint(value, "terminal activity Watch anchor");
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/codex-human-started-active-task-anchor"
  ) {
    if (agent !== "codex") {
      throw new Error("Codex Watch anchor cannot belong to another agent");
    }
    validateCodexHumanStartedActiveTaskAnchor(value);
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/claude-human-started-active-task-anchor"
  ) {
    if (agent !== "claude") {
      throw new Error("Claude Watch anchor cannot belong to another agent");
    }
    const anchor = validateClaudeHumanStartedActiveTaskAnchor(value);
    if (anchor.cwd !== terminal.workspace) {
      throw new Error("Claude Watch workspace does not match its task anchor");
    }
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
  ) {
    if (agent !== "codex") {
      throw new Error("Codex fallback Watch anchor cannot belong to another agent");
    }
    assertStrictRecord(value, "Codex fallback Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/codex-user-explicit-fallback-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      request_hash: assertSha256,
      codex_version: assertNonEmptyString,
      acceptance_anchor: IGNORE_VALUE,
      anchor_fingerprint: assertSha256
    });
    const acceptance = validateCodexRolloutAcceptanceAnchor(
      value.acceptance_anchor
    );
    if (acceptance.captured_at !== value.captured_at) {
      throw new Error(
        "Codex fallback Watch capture time does not match its acceptance anchor"
      );
    }
    assertAnchorFingerprint(value, "Codex fallback Watch anchor");
    return;
  }
  if (
    value.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
  ) {
    if (agent !== "claude") {
      throw new Error(
        "Claude fallback Watch anchor cannot belong to another agent"
      );
    }
    assertStrictRecord(value, "Claude fallback Watch anchor", {
      schema: literalGuard(
        "agent-knock-knock/claude-user-explicit-fallback-watch-anchor"
      ),
      version: literalGuard(1),
      captured_at: assertTimestamp,
      request_hash: assertSha256,
      claude_version: assertNonEmptyString,
      transcript_anchor: IGNORE_VALUE,
      anchor_fingerprint: assertSha256
    });
    const transcript = validatedClaudeTranscriptAnchor(
      value.transcript_anchor
    );
    if (
      transcript.captured_at !== value.captured_at ||
      transcript.cwd !== terminal.workspace
    ) {
      throw new Error(
        "Claude fallback Watch transcript anchor does not match its Watch"
      );
    }
    assertAnchorFingerprint(value, "Claude fallback Watch anchor");
    return;
  }
  throw new Error("terminal Watch anchor schema is unsupported");
}

function assertSettlement(
  value: unknown,
  status: TerminalWatchStatus
): void {
  if (status === "active") {
    if (value !== undefined) {
      throw new Error("an active terminal Watch cannot carry a settlement");
    }
    return;
  }
  assertStrictRecord(value, "terminal Watch settlement", SETTLEMENT_FIELDS);
  if (value.kind !== status) {
    throw new Error("terminal Watch settlement kind must match its status");
  }
  if (
    !["completed", "failed"].includes(status) &&
    (
      value.completion_text !== undefined ||
      value.completion_id !== undefined ||
      value.completion_timestamp !== undefined
    )
  ) {
    throw new Error(
      "only completed or failed terminal Watches may carry completion output"
    );
  }
}

function assertNotificationOutbox(
  watch: TerminalWatch,
  allowPredecessorCallbackPresentation = false
): void {
  const seenIds = new Set<string>();
  const seenEvidence = new Set<string>();
  let previousCreatedAt = Date.parse(watch.created_at);
  for (const notification of watch.notification_outbox) {
    assertNotification(
      notification,
      watch,
      allowPredecessorCallbackPresentation
    );
    if (seenIds.has(notification.notification_id)) {
      throw new Error("terminal Watch notification ids must be unique");
    }
    const evidenceKey = `${notification.kind}:${notification.evidence_fingerprint}`;
    if (seenEvidence.has(evidenceKey)) {
      throw new Error("terminal Watch notification evidence must be unique");
    }
    const createdAt = Date.parse(notification.created_at);
    if (
      createdAt < previousCreatedAt ||
      createdAt > Date.parse(watch.updated_at)
    ) {
      throw new Error("terminal Watch notification timestamps are not monotonic");
    }
    previousCreatedAt = createdAt;
    seenIds.add(notification.notification_id);
    seenEvidence.add(evidenceKey);
  }
  if (watch.status !== "active") {
    const settlement = watch.settlement as TerminalWatchSettlement;
    const terminalNotifications = watch.notification_outbox.filter(
      (notification) => isTerminalWatchOutcomeNotification(notification.kind)
    );
    if (
      terminalNotifications.length !== 1 ||
      terminalNotifications[0].kind !== watch.status ||
      terminalNotifications[0].evidence_fingerprint !==
        settlement.evidence_fingerprint
    ) {
      throw new Error("terminal Watch settlement must have exactly one notification");
    }
  } else if (
    watch.notification_outbox.some((notification) =>
      isTerminalWatchOutcomeNotification(notification.kind)
    )
  ) {
    throw new Error("an active terminal Watch cannot have an outcome notification");
  }
}

function assertNotification(
  value: unknown,
  watch: TerminalWatch,
  allowPredecessorCallbackPresentation: boolean
): void {
  assertStrictRecord(value, "terminal Watch notification", NOTIFICATION_FIELDS);
  const notification = value as unknown as TerminalWatchNotification;
  if (notification.kind === "interaction_manual_required") {
    assertTerminalWatchManualInteractionSummary(
      notification.manual_interaction
    );
  } else if (notification.manual_interaction !== undefined) {
    throw new Error(
      "only a manual-interaction terminal Watch notification may carry an interaction summary"
    );
  }
  const expectedId = terminalWatchNotificationId(
    watch.watch_id,
    notification.kind,
    notification.evidence_fingerprint
  );
  if (
    notification.notification_id !== expectedId ||
    notification.idempotency_key !==
      terminalWatchNotificationIdempotencyKey(watch.watch_id, expectedId)
  ) {
    throw new Error("terminal Watch notification identity is not deterministic");
  }
  const [minimumAttempts, receiptFields] =
    NOTIFICATION_SHAPES[notification.status];
  assertNotificationShape(value, minimumAttempts, receiptFields);
  parseTerminalWatchNotificationCallbackSnapshot(
    watch,
    notification,
    allowPredecessorCallbackPresentation
  );
}

export function assertTerminalWatchManualInteractionSummary(
  value: unknown
): asserts value is TerminalWatchManualInteractionSummary {
  assertStrictRecord(value, "terminal Watch manual interaction", {
    kind: literalGuard("questionnaire"),
    response_kind: oneOfGuard(
      TERMINAL_WATCH_MANUAL_INTERACTION_RESPONSE_KINDS
    ),
    required: (candidate, label) => {
      if (typeof candidate !== "boolean") {
        throw new Error(`${label} must be boolean`);
      }
    },
    current_step: POSITIVE_INTEGER,
    total_steps: POSITIVE_INTEGER,
    parser_status: oneOfGuard(["actionable", "manual_required"]),
    prompt: optionalGuard((candidate, label) =>
      assertBoundedInteractionText(
        candidate,
        label,
        TERMINAL_WATCH_MANUAL_INTERACTION_MAX_PROMPT_CHARACTERS
      )),
    options: optionalGuard(ARRAY_VALUE),
    manual_reason: optionalGuard(assertReasonCode)
  });
  const summary = value as unknown as TerminalWatchManualInteractionSummary;
  if (
    summary.total_steps > TERMINAL_WATCH_MANUAL_INTERACTION_MAX_STEPS ||
    summary.current_step > summary.total_steps
  ) {
    throw new Error("terminal Watch manual interaction step is invalid");
  }
  if (summary.parser_status === "manual_required") {
    if (summary.manual_reason === undefined) {
      throw new Error(
        "a manual-only terminal Watch interaction requires a reason"
      );
    }
    if (summary.prompt !== undefined || summary.options !== undefined) {
      throw new Error(
        "a manual-only terminal Watch interaction cannot expose prompt or options"
      );
    }
  } else if (summary.manual_reason !== undefined) {
    throw new Error(
      "an actionable terminal Watch interaction cannot carry a manual reason"
    );
  } else if (summary.prompt === undefined) {
    throw new Error(
      "an actionable terminal Watch interaction requires a bounded prompt"
    );
  }
  if (summary.options !== undefined) {
    if (
      summary.options.length < 1 ||
      summary.options.length > TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTIONS ||
      (summary.response_kind !== "single_select" &&
        summary.response_kind !== "multi_select")
    ) {
      throw new Error("terminal Watch manual interaction options are invalid");
    }
    for (const option of summary.options) {
      assertStrictRecord(option, "terminal Watch manual interaction option", {
        label: (candidate, label) => assertBoundedInteractionText(
          candidate,
          label,
          TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTION_LABEL_CHARACTERS
        ),
        description: optionalGuard((candidate, label) =>
          assertBoundedInteractionText(
            candidate,
            label,
            TERMINAL_WATCH_MANUAL_INTERACTION_MAX_OPTION_DESCRIPTION_CHARACTERS
          ))
      });
    }
  }
}

export function assertTerminalWatchCurrentInteraction(
  value: unknown,
  watch: Pick<
    TerminalWatch,
    | "watch_id"
    | "agent"
    | "anchor"
    | "interaction_policy"
    | "created_at"
    | "updated_at"
    | "status"
  >
): asserts value is TerminalWatchCurrentInteraction | undefined {
  if (value === undefined) return;
  assertStrictRecord(value, "terminal Watch current interaction", {
    projection: IGNORE_VALUE,
    aggregate: IGNORE_VALUE
  });
  const projection = validateTerminalInteractionSubjectProjection(
    value.projection
  );
  const aggregate = validateTerminalInteractionAggregate(value.aggregate);
  if (
    projection.subject.kind !== "terminal_watch" ||
    projection.subject.watch_id !== watch.watch_id ||
    projection.subject.anchor_fingerprint !==
      watch.anchor.anchor_fingerprint ||
    aggregate.subject.kind !== "terminal_watch" ||
    !sameTerminalInteractionSubject(projection.subject, aggregate.subject)
  ) {
    throw new Error(
      "terminal Watch interaction subject does not match its exact Watch anchor"
    );
  }
  if (projection.agent !== watch.agent) {
    throw new Error("terminal Watch interaction agent does not match its Watch");
  }
  if (!aggregateMatchesProjection(aggregate, projection)) {
    throw new Error(
      "terminal Watch interaction aggregate does not match its public projection"
    );
  }
  if (
    watch.interaction_policy === "notify_only" &&
    (
      projection.response_authority !== "notify_only" ||
      aggregate.response_authority !== "notify_only" ||
      projection.capabilities.respond
    )
  ) {
    throw new Error(
      "a notify-only terminal Watch cannot persist response authority"
    );
  }
  for (const [timestamp, label] of [
    [projection.expires_at, "projection expiry"],
    [aggregate.created_at, "aggregate creation"],
    [aggregate.expires_at, "aggregate expiry"],
    [aggregate.reservation?.reserved_at, "reservation time"],
    [aggregate.resolution?.resolved_at, "resolution time"]
  ] as const) {
    if (timestamp !== undefined) {
      assertTimestamp(timestamp, `terminal Watch interaction ${label}`);
    }
  }
  const createdAt = Date.parse(aggregate.created_at);
  const watchCreatedAt = Date.parse(watch.created_at);
  const watchUpdatedAt = Date.parse(watch.updated_at);
  if (
    createdAt < watchCreatedAt ||
    createdAt > watchUpdatedAt ||
    Date.parse(aggregate.expires_at) <= createdAt ||
    (
      aggregate.reservation !== undefined &&
      (
        Date.parse(aggregate.reservation.reserved_at) < createdAt ||
        Date.parse(aggregate.reservation.reserved_at) > watchUpdatedAt
      )
    ) ||
    (
      aggregate.resolution !== undefined &&
      (
        Date.parse(aggregate.resolution.resolved_at) <
          Date.parse(
            aggregate.reservation?.reserved_at ?? aggregate.created_at
          ) ||
        Date.parse(aggregate.resolution.resolved_at) > watchUpdatedAt
      )
    )
  ) {
    throw new Error("terminal Watch interaction timestamps are not monotonic");
  }
  if (aggregate.resolution !== undefined) {
    assertReasonCode(
      aggregate.resolution.reason_code,
      "terminal Watch interaction resolution reason"
    );
  }
  if (aggregate.reservation !== undefined) {
    assertNonEmptyString(
      aggregate.reservation.attempt_id,
      "terminal Watch interaction reservation attempt id"
    );
  }
  if (
    watch.status !== "active" &&
    (aggregate.state === "pending" || aggregate.state === "reserved")
  ) {
    throw new Error(
      "a settled terminal Watch cannot retain an actionable interaction"
    );
  }
}

function assertBoundedInteractionText(
  value: unknown,
  label: string,
  maxCharacters: number
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxCharacters ||
    /[\u0000-\u001F\u007F-\u009F]/u.test(value)
  ) {
    throw new Error(`${label} exceeds its safe text bound`);
  }
}


function assertNotificationShape(
  value: Record<string, unknown>,
  minimumAttempts: number,
  required: readonly string[]
): void {
  if (Number(value.attempts) < minimumAttempts) {
    throw new Error(`terminal Watch ${String(value.status)} notification has no attempt`);
  }
  for (const key of required) {
    if (value[key] === undefined) {
      throw new Error(
        `terminal Watch ${String(value.status)} notification requires ${key}`
      );
    }
  }
  const allowed = new Set<string>(required);
  for (const key of Object.keys(NOTIFICATION_RECEIPT_FIELDS)) {
    if (value[key] !== undefined && !allowed.has(key)) {
      throw new Error(
        `terminal Watch ${String(value.status)} notification cannot carry ${key}`
      );
    }
  }
}

export function assertTerminalWatchAdvance(
  current: TerminalWatch,
  candidate: TerminalWatch
): void {
  for (const [label, before, after] of [
    ["schema", current.schema, candidate.schema],
    ["version", current.version, candidate.version],
    ["watch_id", current.watch_id, candidate.watch_id],
    ["agent", current.agent, candidate.agent],
    ["terminal", current.terminal, candidate.terminal],
    ["anchor", current.anchor, candidate.anchor],
    [
      "interaction_policy",
      current.interaction_policy,
      candidate.interaction_policy
    ],
    ["warnings", current.warnings, candidate.warnings],
    ["callback_route", current.callback_route, candidate.callback_route],
    ["openclaw_session", current.openclaw_session, candidate.openclaw_session],
    ["openclaw_bin", current.openclaw_bin, candidate.openclaw_bin],
    ["created_at", current.created_at, candidate.created_at],
    ["deadline_at", current.deadline_at, candidate.deadline_at]
  ] as const) {
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      throw new Error(`terminal Watch cannot change immutable ${label}`);
    }
  }
  if (
    Date.parse(candidate.updated_at) < Date.parse(current.updated_at) ||
    Date.parse(candidate.last_activity_at) < Date.parse(current.last_activity_at)
  ) {
    throw new Error("terminal Watch update cannot move time backwards");
  }
  if (
    candidate.observation_checkpoint.safe_resume_offset_bytes <
      current.observation_checkpoint.safe_resume_offset_bytes
  ) {
    throw new Error("terminal Watch observation checkpoint cannot move backwards");
  }
  assertFallbackCheckpointAdvance(
    current.observation_checkpoint,
    candidate.observation_checkpoint
  );
  assertTerminalWatchInteractionAdvance(
    current.current_interaction,
    candidate.current_interaction
  );
  if (
    current.status !== "active" &&
    candidate.status !== current.status
  ) {
    throw new Error("a settled terminal Watch cannot change outcome");
  }
  if (
    current.settlement !== undefined &&
    JSON.stringify(candidate.settlement) !== JSON.stringify(current.settlement)
  ) {
    throw new Error("terminal Watch settlement is immutable");
  }
  if (current.status !== "active") {
    if (
      candidate.last_activity_at !== current.last_activity_at ||
      JSON.stringify(candidate.observation_checkpoint) !==
        JSON.stringify(current.observation_checkpoint) ||
      canonicalJson(candidate.current_interaction) !==
        canonicalJson(current.current_interaction) ||
      candidate.notification_outbox.length !== current.notification_outbox.length
    ) {
      throw new Error(
        "a settled terminal Watch may change only notification delivery receipts"
      );
    }
  } else if (
    candidate.notification_outbox.length >
      current.notification_outbox.length + 1
  ) {
    throw new Error(
      "terminal Watch may append at most one notification per update"
    );
  }
  assertNotificationAdvance(current.notification_outbox, candidate.notification_outbox);
}

function assertTerminalWatchInteractionAdvance(
  current: TerminalWatchCurrentInteraction | undefined,
  candidate: TerminalWatchCurrentInteraction | undefined
): void {
  if (current === undefined) {
    if (candidate !== undefined && candidate.aggregate.state !== "pending") {
      throw new Error(
        "a terminal Watch interaction must be created pending"
      );
    }
    return;
  }
  if (candidate === undefined) {
    throw new Error("terminal Watch current interaction cannot be removed");
  }
  const before = current.aggregate;
  const after = candidate.aggregate;
  if (!sameTerminalInteractionSubject(before.subject, after.subject)) {
    throw new Error("terminal Watch interaction subject cannot change");
  }
  if (before.interaction_id !== after.interaction_id) {
    if (
      !["consumed", "response_uncertain", "superseded"].includes(
        before.state
      ) ||
      after.state !== "pending" ||
      before.surface_id === after.surface_id ||
      Date.parse(after.created_at) < Date.parse(
        before.resolution?.resolved_at ?? before.created_at
      )
    ) {
      throw new Error(
        "terminal Watch cannot replace an unresolved interaction"
      );
    }
    return;
  }

  const expected = expectedTerminalWatchInteractionAggregate(before, after);
  if (canonicalJson(expected) !== canonicalJson(after)) {
    throw new Error(
      `terminal Watch interaction cannot advance ${before.state} to ${after.state}`
    );
  }
  assertTerminalWatchInteractionProjectionAdvance(
    current.projection,
    candidate.projection,
    before,
    after
  );
}

function expectedTerminalWatchInteractionAggregate(
  current: TerminalInteractionAggregate,
  candidate: TerminalInteractionAggregate
): TerminalInteractionAggregate {
  if (current.state === candidate.state) {
    if (
      current.state === "pending" &&
      (
        current.expires_at !== candidate.expires_at ||
        current.response_authority !== candidate.response_authority
      )
    ) {
      return reduceTerminalInteractionAggregate(current, {
        type: "refresh",
        expires_at: candidate.expires_at,
        response_authority: candidate.response_authority
      });
    }
    return current;
  }
  if (candidate.state === "reserved" && candidate.reservation) {
    return reduceTerminalInteractionAggregate(current, {
      type: "reserve",
      attempt_id: candidate.reservation.attempt_id,
      response_hash: candidate.reservation.response_hash,
      at: candidate.reservation.reserved_at
    });
  }
  if (current.state === "reserved" && candidate.state === "pending") {
    return reduceTerminalInteractionAggregate(current, { type: "release" });
  }
  if (
    (candidate.state === "consumed" ||
      candidate.state === "response_uncertain") &&
    candidate.resolution
  ) {
    return reduceTerminalInteractionAggregate(current, {
      type: candidate.state === "consumed"
        ? "consume"
        : "response_uncertain",
      at: candidate.resolution.resolved_at,
      reason_code: candidate.resolution.reason_code
    });
  }
  if (candidate.state === "superseded" && candidate.resolution) {
    return reduceTerminalInteractionAggregate(current, {
      type: "supersede",
      at: candidate.resolution.resolved_at,
      reason_code: candidate.resolution.reason_code
    });
  }
  return current;
}

function assertTerminalWatchInteractionProjectionAdvance(
  current: TerminalInteractionSubjectProjection,
  candidate: TerminalInteractionSubjectProjection,
  before: TerminalInteractionAggregate,
  after: TerminalInteractionAggregate
): void {
  if (canonicalJson(current) === canonicalJson(candidate)) return;
  if (before.state === "pending" && after.state === "pending") {
    const expected = {
      ...current,
      state: candidate.state,
      expires_at: after.expires_at,
      response_authority: after.response_authority,
      capabilities: candidate.capabilities
    };
    if (canonicalJson(expected) === canonicalJson(candidate)) return;
  }
  if (after.state === "response_uncertain") {
    const expected = {
      ...current,
      state: "response_uncertain" as const,
      capabilities: { ...current.capabilities, respond: false }
    };
    if (canonicalJson(expected) === canonicalJson(candidate)) return;
  }
  throw new Error(
    "terminal Watch interaction public projection changed outside a safe state transition"
  );
}

function assertFallbackCheckpointAdvance(
  current: TerminalWatchObservationCheckpoint,
  candidate: TerminalWatchObservationCheckpoint
): void {
  if (!("schema" in current)) {
    return;
  }
  if (
    current.schema ===
      "agent-knock-knock/terminal-activity-watch-checkpoint"
  ) {
    if (
      !("schema" in candidate) ||
      candidate.schema !== current.schema
    ) {
      throw new Error("terminal activity Watch checkpoint schema cannot change");
    }
    if (current.has_seen_activity && !candidate.has_seen_activity) {
      throw new Error(
        "terminal activity Watch cannot forget observed activity"
      );
    }
    if (
      candidate.consecutive_idle_observations >
        current.consecutive_idle_observations + 1
    ) {
      throw new Error(
        "terminal activity Watch idle observations cannot skip supervision sweeps"
      );
    }
    return;
  }
  const fallbackSchema = current.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint" ||
    current.schema ===
      "agent-knock-knock/claude-user-explicit-fallback-watch-checkpoint";
  if (!fallbackSchema) return;
  if (
    !("schema" in candidate) ||
    candidate.schema !== current.schema
  ) {
    throw new Error("fallback Watch checkpoint schema cannot change");
  }
  if (current.acceptance_evidence === undefined) {
    return;
  }
  const currentIdentity = current.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ? current.accepted_identity
    : current.accepted_prompt_uuid;
  const candidateIdentity = candidate.schema ===
      "agent-knock-knock/codex-user-explicit-fallback-watch-checkpoint"
    ? candidate.accepted_identity
    : candidate.accepted_prompt_uuid;
  if (
    canonicalJson(candidate.acceptance_evidence) !==
      canonicalJson(current.acceptance_evidence) ||
    canonicalJson(candidateIdentity) !== canonicalJson(currentIdentity)
  ) {
    throw new Error(
      "fallback Watch accepted identity cannot change"
    );
  }
}

function assertNotificationAdvance(
  current: readonly TerminalWatchNotification[],
  candidate: readonly TerminalWatchNotification[]
): void {
  if (candidate.length < current.length) {
    throw new Error("terminal Watch notification outbox is append-only");
  }
  for (let index = 0; index < current.length; index += 1) {
    const before = current[index];
    const after = candidate[index];
    for (const key of [
      "notification_id",
      "idempotency_key",
      "kind",
      "evidence_fingerprint",
      "reason_code",
      "created_at"
    ] as const) {
      if (before[key] !== after[key]) {
        throw new Error(`terminal Watch notification cannot change immutable ${key}`);
      }
    }
    if (
      canonicalJson(before.manual_interaction) !==
        canonicalJson(after.manual_interaction)
    ) {
      throw new Error(
        "terminal Watch notification cannot change immutable manual_interaction"
      );
    }
    for (const key of ["callback_route", "callback_envelope"] as const) {
      const existed = Object.hasOwn(before, key);
      const exists = Object.hasOwn(after, key);
      if (!existed && exists) {
        const reclaimed = before.status === "delivering" &&
          after.status === "delivering" &&
          after.attempt_id !== before.attempt_id;
        const claimed = (before.status === "pending" ||
            before.status === "failed") &&
          after.status === "delivering";
        if (!claimed && !reclaimed) {
          throw new Error(
            "terminal Watch notification callback snapshot may be backfilled only while claiming delivery"
          );
        }
      }
      if (existed && (!exists || canonicalJson(before[key]) !== canonicalJson(after[key]))) {
        throw new Error(`terminal Watch notification cannot change immutable ${key}`);
      }
    }
    assertNotificationStatusAdvance(before, after);
  }
  for (const added of candidate.slice(current.length)) {
    if (added.status !== "pending" || added.attempts !== 0) {
      throw new Error("a terminal Watch notification must be appended pending");
    }
  }
}

function assertNotificationStatusAdvance(
  current: TerminalWatchNotification,
  candidate: TerminalWatchNotification
): void {
  const allowed: Record<TerminalWatchNotificationStatus, readonly TerminalWatchNotificationStatus[]> = {
    pending: ["pending", "delivering", "superseded"],
    delivering: [
      "delivering", "failed", "delivered", "superseded"
    ],
    failed: ["failed", "delivering", "superseded"],
    delivered: ["delivered"],
    superseded: ["superseded"]
  };
  if (!allowed[current.status].includes(candidate.status)) {
    throw new Error(
      `terminal Watch notification cannot advance ${current.status} to ${candidate.status}`
    );
  }
  const reclaimed = current.status === "delivering" &&
    candidate.status === "delivering" &&
    candidate.attempt_id !== current.attempt_id;
  const claimed = ["pending", "failed"].includes(current.status) &&
    candidate.status === "delivering";
  const expectedAttempts = claimed || reclaimed
    ? current.attempts + 1
    : current.attempts;
  if (candidate.attempts !== expectedAttempts) {
    throw new Error("terminal Watch notification attempt count is not monotonic");
  }
  if (
    current.status === candidate.status &&
    !reclaimed &&
    JSON.stringify(current) !== JSON.stringify(candidate)
  ) {
    throw new Error(
      "terminal Watch notification receipt cannot change without a phase advance"
    );
  }
}
